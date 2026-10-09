import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import {
  modelPreset,
  type ModelInfo,
  type ModelPreset,
  type ModelPresetId,
  type ModelProviderView,
} from '../shared/model-presets.js';
import {
  guardedFetch,
  isLoopbackHost,
  isPrivateLiteral,
} from './connector-oauth.js';
import {
  ENV_PROVIDER_ID,
  LAST_ERROR_MAX,
  type DefaultModelSetting,
  type ModelProviderRecord,
  type ModelProviderStore,
} from './model-provider-store.js';
import type { PlatformConfig } from './platform-config.js';

type Fetch = typeof fetch;

/** Plaintext keys shorter than this are not worth redacting (and would mangle ordinary text). */
const MIN_SECRET_LENGTH = 8;
export const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
export const MODEL_FAILURE_TTL_MS = 60 * 1000;
export const MODEL_LIST_TIMEOUT_MS = 15_000;
export const MODEL_LIST_MAX_BYTES = 8 * 1024 * 1024;
const MODEL_LIMIT = 5000;
const BODY_EXCERPT_MAX = 2000;
const ENV_PROVIDER_NAME = 'Default (from .env)';
const ENV_KEY_NAME = 'OPENAI_API_KEY';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
/** Sent to providers that do not need a key (Ollama, LM Studio, keyless custom servers). */
export const PLACEHOLDER_KEY = 'not-needed';
/** `MODEL_PROVIDERS_ALLOW_LAN=true` lets local providers live on another machine of the owner's network. */
export const ALLOW_LAN_ENV = 'MODEL_PROVIDERS_ALLOW_LAN';

/* ------------------------------------------------------------------ */
/* Errors and resolved shape                                           */
/* ------------------------------------------------------------------ */

export class ModelProviderError extends Error {
  constructor(
    message: string,
    readonly code: 'no-provider' | 'disabled' | 'key-missing' | 'no-model',
  ) {
    super(message);
    this.name = 'ModelProviderError';
  }
}

export interface ResolvedModel {
  providerId: string;
  providerName: string;
  model: string;
  baseURL: string;
  /** The real key, or a placeholder for keyless local providers. Never log or return it. */
  apiKey: string;
  maxTokensKey: ModelPreset['maxTokensKey'];
  preset: ModelPreset;
  fetch: Fetch;
  defaultHeaders: Record<string, string>;
  /** Set when the requested provider no longer exists and the default was used instead. */
  warning?: string;
}

export interface ModelProviderRegistryOptions {
  env: PlatformConfig;
  processEnv?: NodeJS.ProcessEnv;
  /** The underlying fetch every provider request goes through (tests inject an in-process app). */
  fetch?: Fetch;
  /** Reserved: where the app is opened. */
  publicOrigin?: string;
  now?: () => number;
}

/* ------------------------------------------------------------------ */
/* URL rules                                                           */
/* ------------------------------------------------------------------ */

function bareHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/** Hosts a local provider may use on the owner's own network when MODEL_PROVIDERS_ALLOW_LAN is on. */
function lanHostAllowed(host: string): boolean {
  if (isLoopbackHost(host) || isPrivateLiteral(host)) return true;
  if (host.includes(':') || /^[\d.]+$/.test(host)) return false; // public IP literals
  return !host.includes('.') || /\.(local|lan|internal|home\.arpa)$/.test(host);
}

/**
 * Why `rawUrl` may not be a provider's base URL, or undefined when it may. Save-time rule;
 * `providerFetch` enforces the same at request time.
 */
export function checkProviderBaseUrl(
  preset: ModelPreset,
  rawUrl: string,
  options: { allowLan?: boolean } = {},
): string | undefined {
  if (rawUrl.length > 500) return 'The base URL is too long.';
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'The base URL is not a valid URL.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return 'The base URL must start with https:// (or http:// for localhost).';
  if (url.username || url.password)
    return 'The base URL must not contain a user name or password.';
  if (url.hash || url.search)
    return 'The base URL must not contain a query string or fragment.';
  const host = bareHost(url);
  if (isLoopbackHost(host)) return undefined;
  if (preset.local) {
    if (!options.allowLan)
      return `${preset.name} runs on this computer; use localhost. Set ${ALLOW_LAN_ENV}=true to allow another machine on your network.`;
    return lanHostAllowed(host)
      ? undefined
      : 'Only machines on your own network may be used for a local provider.';
  }
  if (url.protocol !== 'https:')
    return 'The base URL must use https:// (http:// is only allowed for localhost).';
  if (isPrivateLiteral(host))
    return 'The base URL must not point to a private network address.';
  return undefined;
}

/* ------------------------------------------------------------------ */
/* providerFetch                                                       */
/* ------------------------------------------------------------------ */

export interface ProviderFetchOptions {
  /** The underlying fetch (default: global `fetch`). */
  fetch?: Fetch;
  /** `stream`: no timeout or size cap (chat). `list`: 15 s and 8 MB (model lists). Default `stream`. */
  mode?: 'stream' | 'list';
  /** The provider came from the server's own .env: the owner chose the URL, so it is not restricted. */
  trusted?: boolean;
  /** Local providers may use non-loopback hosts on the owner's network. */
  allowLan?: boolean;
  /** Extra headers (the request's own headers win). */
  headers?: Record<string, string>;
  redact?: (text: string) => string;
}

const ABORT_NAMES = new Set(['AbortError', 'TimeoutError']);

function dropBodyFields(body: unknown, fields: string[]): unknown {
  if (typeof body !== 'string' || !fields.length) return body;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return body;
    const record = parsed as Record<string, unknown>;
    if (!fields.some((field) => field in record)) return body;
    for (const field of fields) delete record[field];
    return JSON.stringify(record);
  } catch {
    return body;
  }
}

/**
 * The single wrapper for chat and model-list traffic of one provider. Built on `guardedFetch`
 * (https or loopback http, no private literals, no redirects) plus the preset's default headers,
 * `dropFields` body rewriting, and error text with known secrets removed.
 */
export function providerFetch(
  preset: ModelPreset,
  baseUrl: string,
  options: ProviderFetchOptions = {},
): Fetch {
  const base: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const list = options.mode === 'list';
  const guard = {
    timeoutMs: list ? MODEL_LIST_TIMEOUT_MS : (false as const),
    maxBodyBytes: list ? MODEL_LIST_MAX_BYTES : (false as const),
  };
  const redact = options.redact ?? ((text: string) => text);
  const extraHeaders = { ...preset.defaultHeaders, ...options.headers };
  const dropFields = preset.dropFields ?? [];

  const send = async (target: URL, init: RequestInit): Promise<Response> => {
    const host = bareHost(target);
    const http = target.protocol === 'http:' || target.protocol === 'https:';
    let relaxed = false;
    if (options.trusted) {
      if (!http)
        throw new Error(
          `Refused request with unsupported scheme ${target.protocol}`,
        );
      relaxed = true;
    } else if (preset.local && !isLoopbackHost(host)) {
      if (!options.allowLan)
        throw new Error(
          `Refused request to ${target.origin}: ${preset.name} is limited to localhost (set ${ALLOW_LAN_ENV}=true to allow your network)`,
        );
      if (!http || !lanHostAllowed(host))
        throw new Error(`Refused request to ${target.origin}`);
      relaxed = true;
    }
    if (!relaxed) {
      return guardedFetch({ fetch: base, ...guard })(target.href, init);
    }
    // guardedFetch only accepts https/loopback, so a vetted target is presented as loopback and
    // swapped back inside the base fetch; redirects, timeout and the body cap still apply.
    const guarded = guardedFetch({
      fetch: (_input, next) => base(target.href, next),
      ...guard,
    });
    try {
      return await guarded('http://localhost/', init);
    } catch (error) {
      if (error instanceof Error)
        error.message = error.message
          .split('http://localhost')
          .join(target.origin);
      throw error;
    }
  };

  return (async (input: string | URL | Request, init?: RequestInit) => {
    try {
      let target: URL;
      let next: RequestInit = { ...init };
      if (input instanceof Request) {
        target = new URL(input.url);
        next = {
          method: input.method,
          headers: input.headers,
          ...(input.body ? { body: await input.text() } : {}),
          signal: input.signal,
          ...init,
        };
      } else {
        target = new URL(String(input));
      }
      const headers = new Headers(next.headers);
      for (const [name, value] of Object.entries(extraHeaders))
        if (!headers.has(name)) headers.set(name, value);
      next.headers = headers;
      const body = dropBodyFields(next.body, dropFields);
      if (body !== next.body) next.body = body as BodyInit;
      return await send(target, next);
    } catch (error) {
      if (!(error instanceof Error) || ABORT_NAMES.has(error.name)) throw error;
      const code = (error.cause as { code?: unknown } | undefined)?.code;
      const wrapped = new Error(
        redact(
          typeof code === 'string'
            ? `${error.message} (${code})`
            : error.message,
        ),
      );
      wrapped.name = error.name;
      throw wrapped;
    }
  }) as Fetch;
}

/* ------------------------------------------------------------------ */
/* Model list parsing                                                  */
/* ------------------------------------------------------------------ */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
const CHAT_TYPES = ['chat', 'language', 'code'];

function toInfo(
  item: unknown,
  shape: ModelPreset['models']['shape'],
): ModelInfo | undefined {
  if (typeof item === 'string')
    return str(item)
      ? { id: shape === 'gemini' ? item.replace(/^models\//, '') : item }
      : undefined;
  if (!isRecord(item)) return undefined;
  const rawId = str(item.id) ?? str(item.name);
  if (!rawId) return undefined;
  const id = shape === 'gemini' ? rawId.replace(/^models\//, '') : rawId;
  if (!id) return undefined;
  const capabilities = isRecord(item.capabilities) ? item.capabilities : {};
  if (item.active === false || capabilities.completion_chat === false)
    return undefined;
  if (
    shape === 'array' &&
    typeof item.type === 'string' &&
    !CHAT_TYPES.includes(item.type)
  )
    return undefined;
  if (
    shape === 'gemini' &&
    Array.isArray(item.supportedGenerationMethods) &&
    !item.supportedGenerationMethods.includes('generateContent')
  )
    return undefined;
  const label =
    str(item.display_name) ?? str(item.displayName) ?? str(item.name);
  const parameters = Array.isArray(item.supported_parameters)
    ? item.supported_parameters
    : undefined;
  const tools = parameters
    ? parameters.includes('tools')
    : typeof capabilities.function_calling === 'boolean'
      ? capabilities.function_calling
      : undefined;
  const context = [
    item.context_length,
    item.context_window,
    item.max_context_length,
    item.inputTokenLimit,
  ].find((value): value is number => typeof value === 'number' && value > 0);
  return {
    id,
    ...(label && label !== id && label !== rawId ? { name: label } : {}),
    ...(tools === undefined ? {} : { tools }),
    ...(context === undefined ? {} : { contextLength: context }),
  };
}

/** Parses an OpenAI-style, bare-array or Gemini model list. Throws when nothing list-like is found. */
export function parseModelList(
  shape: ModelPreset['models']['shape'],
  json: unknown,
): ModelInfo[] {
  const items = Array.isArray(json)
    ? json
    : isRecord(json)
      ? Array.isArray(json.data)
        ? json.data
        : json.models
      : undefined;
  if (!Array.isArray(items))
    throw new Error('The provider returned a model list in an unknown format.');
  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const item of items) {
    const info = toInfo(item, shape);
    if (!info || seen.has(info.id)) continue;
    seen.add(info.id);
    models.push(info);
    if (models.length >= MODEL_LIMIT) break;
  }
  return models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

function inferPresetId(baseUrl: string): ModelPresetId {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai'))
      return 'openrouter';
    if (host === 'api.openai.com') return 'openai';
  } catch {
    // fall through
  }
  return 'custom';
}

interface Entry {
  record: ModelProviderRecord;
  preset: ModelPreset;
  builtIn: boolean;
}

interface CacheEntry {
  at: number;
  stamp: number;
  models: ModelInfo[];
  failed: boolean;
  error?: string;
}

export interface ModelListResult {
  models: ModelInfo[];
  fetchedAt: number;
  /** The list could not be refreshed: it is the last good one, or empty. */
  stale: boolean;
  /** Redacted reason the refresh failed. */
  error?: string;
}

export interface ModelTestResult {
  ok: boolean;
  count?: number;
  latencyMs: number;
  error?: string;
}

const quote = (name: string) => `“${name}”`;

export class ModelProviderRegistry {
  private readonly processEnv: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<ModelListResult>>();
  private envStatus: { lastTestedAt: number | null; lastError: string | null } =
    {
      lastTestedAt: null,
      lastError: null,
    };

  constructor(
    private readonly store: ModelProviderStore,
    private readonly options: ModelProviderRegistryOptions,
  ) {
    this.processEnv = options.processEnv ?? process.env;
    this.now = options.now ?? Date.now;
  }

  /* --- views ------------------------------------------------------ */

  /** The built-in `.env` provider first (when OPENAI_API_KEY is set), then the stored ones. */
  list(): ModelProviderView[] {
    return this.entries().map((entry) => this.view(entry));
  }

  get(id: string): ModelProviderView | undefined {
    const entry = this.find(id);
    return entry ? this.view(entry) : undefined;
  }

  /** The base-URL rule for saving a provider of `presetId` (see `checkProviderBaseUrl`). */
  checkBaseUrl(presetId: ModelPresetId, rawUrl: string): string | undefined {
    const preset = modelPreset(presetId);
    if (!preset) return 'Unknown provider preset.';
    return checkProviderBaseUrl(preset, rawUrl, { allowLan: this.allowLan() });
  }

  /* --- default model ---------------------------------------------- */

  /** The effective default: the stored one when its provider exists, else the `.env` model. */
  defaultModel(): DefaultModelSetting | null {
    const target = this.defaultTarget();
    return target?.model
      ? { providerId: target.entry.record.id, model: target.model }
      : null;
  }

  /** Throws `no-provider` when the provider does not exist. */
  setDefaultModel(value: DefaultModelSetting): void {
    const model = value.model.trim();
    if (!this.find(value.providerId))
      throw new ModelProviderError(
        'That provider does not exist.',
        'no-provider',
      );
    if (!model) throw new ModelProviderError('No model was given.', 'no-model');
    this.store.setDefaultModel({ providerId: value.providerId, model });
  }

  /** Back to the `.env` model. */
  clearDefaultModel(): void {
    this.store.setDefaultModel(undefined);
  }

  /** `"OpenRouter · deepseek/…"` for the setup status, or undefined without a default. */
  defaultLabel(): string | undefined {
    const target = this.defaultTarget();
    if (!target?.model) return undefined;
    const { entry } = target;
    const name =
      entry.builtIn && entry.record.presetId !== 'custom'
        ? entry.preset.name
        : entry.record.name;
    return `${name} · ${target.model}`;
  }

  /* --- resolving -------------------------------------------------- */

  resolve(
    ref: { providerId?: string | null; model?: string | null } = {},
  ): ResolvedModel {
    const model = ref.model?.trim() || undefined;
    const providerId = ref.providerId?.trim() || undefined;
    if (!providerId) {
      const target = this.defaultTarget();
      if (!target) throw this.noProvider();
      return this.build(target.entry, model ?? target.model);
    }
    const entry = this.find(providerId);
    if (!entry) {
      return {
        ...this.resolveDefault(),
        warning:
          'The provider this Dot names no longer exists; it falls back to the default.',
      };
    }
    const stored = this.store.getDefaultModel();
    const fallback =
      stored?.providerId === providerId
        ? stored.model
        : entry.builtIn
          ? this.options.env.model?.trim() || undefined
          : undefined;
    return this.build(entry, model ?? fallback);
  }

  resolveDefault(): ResolvedModel {
    const target = this.defaultTarget();
    if (!target) throw this.noProvider();
    return this.build(target.entry, target.model);
  }

  hasUsableDefault(): boolean {
    try {
      this.resolveDefault();
      return true;
    } catch {
      return false;
    }
  }

  /** The chat adapter for a resolved model: one adapter for every provider. */
  adapterFor(resolved: ResolvedModel, maxRetries = 1) {
    return openaiCompatibleText(resolved.model, {
      apiKey: resolved.apiKey,
      baseURL: resolved.baseURL,
      api: 'chat-completions',
      maxRetries,
      defaultHeaders: resolved.defaultHeaders,
      fetch: resolved.fetch,
    });
  }

  /* --- model lists and tests -------------------------------------- */

  async models(
    id: string,
    options: { refresh?: boolean } = {},
  ): Promise<ModelListResult> {
    const entry = this.find(id);
    if (!entry) {
      this.cache.delete(id);
      throw new ModelProviderError(
        'That provider does not exist.',
        'no-provider',
      );
    }
    const stamp = entry.record.updatedAt;
    const cached = this.cache.get(id);
    if (cached && cached.stamp !== stamp) this.cache.delete(id);
    else if (cached && !options.refresh) {
      const ttl = cached.failed ? MODEL_FAILURE_TTL_MS : MODEL_CACHE_TTL_MS;
      if (this.now() - cached.at < ttl) return this.listResult(cached);
    }
    const running = this.inflight.get(id);
    if (running && !options.refresh) return running;
    const task = this.refreshModels(entry).finally(() => {
      if (this.inflight.get(id) === task) this.inflight.delete(id);
    });
    this.inflight.set(id, task);
    return task;
  }

  /** Lists the provider's models now (ignoring the cache) and records the outcome on the provider. */
  async test(id: string): Promise<ModelTestResult> {
    const entry = this.find(id);
    if (!entry)
      throw new ModelProviderError(
        'That provider does not exist.',
        'no-provider',
      );
    const started = this.now();
    try {
      const models = await this.fetchModels(entry);
      this.cache.set(id, {
        at: this.now(),
        stamp: entry.record.updatedAt,
        models,
        failed: false,
      });
      this.writeStatus(entry, { lastTestedAt: this.now(), lastError: null });
      return {
        ok: true,
        count: models.length,
        latencyMs: this.now() - started,
      };
    } catch (error) {
      const message = this.errorText(error, entry);
      this.writeStatus(entry, { lastTestedAt: this.now(), lastError: message });
      return { ok: false, latencyMs: this.now() - started, error: message };
    }
  }

  /** Drops cached model lists (all, or one provider's). Edits invalidate on their own. */
  invalidate(id?: string): void {
    if (id === undefined) this.cache.clear();
    else this.cache.delete(id);
  }

  /* --- secrets ---------------------------------------------------- */

  /** Every resolvable key (>= 8 chars) with its `Bearer ` variant, longest first. */
  secrets(): string[] {
    const found = new Set<string>();
    for (const entry of this.entries()) {
      const key = this.keyOf(entry);
      if (key && key.length >= MIN_SECRET_LENGTH) {
        found.add(key);
        found.add(`Bearer ${key}`);
      }
    }
    return [...found].sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    return this.secrets().reduce(
      (all, secret) => all.split(secret).join('[redacted]'),
      text,
    );
  }

  /* --- internals -------------------------------------------------- */

  private allowLan(): boolean {
    return this.processEnv[ALLOW_LAN_ENV]?.trim().toLowerCase() === 'true';
  }

  private noProvider(): ModelProviderError {
    return new ModelProviderError(
      'No model is configured. Add a provider in Settings → Models or set OPENAI_API_KEY.',
      'no-provider',
    );
  }

  private envEntry(): Entry | undefined {
    const config = this.options.env;
    if (!config.apiKey) return undefined;
    const baseUrl = config.baseUrl?.trim() || DEFAULT_BASE_URL;
    const presetId = inferPresetId(baseUrl);
    const base = modelPreset(presetId) ?? modelPreset('custom')!;
    return {
      builtIn: true,
      // Today's .env setup sends max_completion_tokens to every host; keep that for unknown ones.
      preset:
        presetId === 'custom'
          ? { ...base, maxTokensKey: 'max_completion_tokens' }
          : base,
      record: {
        id: ENV_PROVIDER_ID,
        presetId,
        name: ENV_PROVIDER_NAME,
        baseUrl,
        key: { kind: 'env', set: true, envName: ENV_KEY_NAME },
        extra: {},
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
        ...this.envStatus,
      },
    };
  }

  private entries(): Entry[] {
    const stored = this.store.list().map((record): Entry => ({
      record,
      builtIn: false,
      preset: modelPreset(record.presetId) ?? modelPreset('custom')!,
    }));
    const env = this.envEntry();
    return env ? [env, ...stored] : stored;
  }

  private find(id: string): Entry | undefined {
    if (id === ENV_PROVIDER_ID) return this.envEntry();
    const record = this.store.get(id);
    return record
      ? {
          record,
          builtIn: false,
          preset: modelPreset(record.presetId) ?? modelPreset('custom')!,
        }
      : undefined;
  }

  private defaultTarget():
    { entry: Entry; model: string | undefined } | undefined {
    const stored = this.store.getDefaultModel();
    const storedEntry = stored ? this.find(stored.providerId) : undefined;
    if (stored && storedEntry)
      return { entry: storedEntry, model: stored.model };
    const env = this.envEntry();
    return env
      ? { entry: env, model: this.options.env.model?.trim() || undefined }
      : undefined;
  }

  /** The plaintext key, or undefined when the provider has none (or it cannot be read). */
  private keyOf(entry: Entry): string | undefined {
    if (entry.builtIn) return this.options.env.apiKey || undefined;
    const { key, id } = entry.record;
    if (key.kind === 'stored') return this.store.readKey(id);
    if (key.kind === 'env' && key.envName)
      return this.processEnv[key.envName]?.trim() || undefined;
    return undefined;
  }

  private headersOf(entry: Entry): Record<string, string> {
    const headers: Record<string, string> = { ...entry.preset.defaultHeaders };
    for (const field of entry.preset.extraFields ?? []) {
      const value = entry.record.extra[field.id];
      if (value) headers[field.header] = value;
    }
    return headers;
  }

  private fetchFor(
    entry: Entry,
    mode: 'stream' | 'list',
    headers: Record<string, string>,
  ): Fetch {
    return providerFetch(entry.preset, entry.record.baseUrl, {
      mode,
      headers,
      trusted: entry.builtIn,
      allowLan: this.allowLan(),
      redact: (text) => this.redact(text),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
  }

  private build(entry: Entry, model: string | undefined): ResolvedModel {
    const { record, preset } = entry;
    if (!record.enabled)
      throw new ModelProviderError(
        `The provider ${quote(record.name)} is disabled. Enable it in Settings → Models or pick another model for this Dot.`,
        'disabled',
      );
    const key = this.keyOf(entry);
    const keyless = record.key.kind === 'none' && preset.keyOptional;
    if (!key && !keyless)
      throw new ModelProviderError(
        `The provider ${quote(record.name)} has no API key.`,
        'key-missing',
      );
    if (!model)
      throw new ModelProviderError(
        entry.builtIn
          ? 'No model is configured. Set OPENAI_MODEL or choose a default model in Settings → Models.'
          : `No model is selected for ${quote(record.name)}. Pick a model for this Dot or set a default in Settings → Models.`,
        'no-model',
      );
    const defaultHeaders = this.headersOf(entry);
    return {
      providerId: record.id,
      providerName: record.name,
      model,
      baseURL: record.baseUrl.replace(/\/+$/, ''),
      apiKey: key ?? PLACEHOLDER_KEY,
      maxTokensKey: preset.maxTokensKey,
      preset,
      fetch: this.fetchFor(entry, 'stream', defaultHeaders),
      defaultHeaders,
    };
  }

  private async fetchModels(entry: Entry): Promise<ModelInfo[]> {
    const { record, preset } = entry;
    const key = this.keyOf(entry);
    if (!key && !(record.key.kind === 'none' && preset.keyOptional))
      throw new Error('The provider has no API key.');
    const headers = new Headers({ accept: 'application/json' });
    for (const [name, value] of Object.entries(preset.models.headers ?? {}))
      headers.set(name, value);
    if (key) {
      if (preset.models.auth === 'x-api-key') headers.set('x-api-key', key);
      else headers.set('authorization', `Bearer ${key}`);
    }
    const base = record.baseUrl.replace(/\/+$/, '');
    const fetchList = this.fetchFor(entry, 'list', this.headersOf(entry));
    // Where the model list is public, a working list says nothing about the key: check it first.
    if (key && preset.keyCheckPath) {
      const check = await fetchList(`${base}${preset.keyCheckPath}`, {
        method: 'GET',
        headers,
      });
      if (!check.ok) throw new Error(await this.httpError(check));
    }
    const response = await fetchList(`${base}${preset.models.path}`, {
      method: 'GET',
      headers,
    });
    if (!response.ok) throw new Error(await this.httpError(response));
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new Error('The provider returned a response that is not JSON.');
    }
    return parseModelList(preset.models.shape, json);
  }

  private async httpError(response: Response): Promise<string> {
    let detail: string | undefined;
    try {
      const text = (await response.text()).slice(0, BODY_EXCERPT_MAX);
      try {
        const body = JSON.parse(text) as unknown;
        if (isRecord(body)) {
          const error = body.error;
          detail =
            str(error) ??
            (isRecord(error) ? str(error.message) : undefined) ??
            str(body.message);
        }
      } catch {
        detail = str(text);
      }
    } catch {
      // no body
    }
    return `HTTP ${response.status}${detail ? `: ${detail.replace(/\s+/g, ' ')}` : ''}`;
  }

  /** Error text for the owner: friendly for a stopped local server, redacted and capped always. */
  private errorText(error: unknown, entry: Entry): string {
    const raw = error instanceof Error ? error.message : String(error);
    let text = raw;
    if (error instanceof Error && ABORT_NAMES.has(error.name))
      text = `The provider did not answer within ${MODEL_LIST_TIMEOUT_MS / 1000} seconds.`;
    else if (entry.preset.local && /ECONNREFUSED|fetch failed/.test(raw))
      text = `Could not connect to ${new URL(entry.record.baseUrl).host}. Is ${entry.preset.name} running?`;
    return this.cap(this.redact(text));
  }

  private cap(text: string): string {
    return text.length > LAST_ERROR_MAX
      ? `${text.slice(0, LAST_ERROR_MAX - 1)}…`
      : text;
  }

  private async refreshModels(entry: Entry): Promise<ModelListResult> {
    const id = entry.record.id;
    const stamp = entry.record.updatedAt;
    try {
      const models = await this.fetchModels(entry);
      const cached: CacheEntry = {
        at: this.now(),
        stamp,
        models,
        failed: false,
      };
      this.cache.set(id, cached);
      return this.listResult(cached);
    } catch (error) {
      const cached: CacheEntry = {
        at: this.now(),
        stamp,
        models: this.cache.get(id)?.models ?? [],
        failed: true,
        error: this.errorText(error, entry),
      };
      this.cache.set(id, cached);
      return this.listResult(cached);
    }
  }

  private listResult(entry: CacheEntry): ModelListResult {
    return {
      models: entry.models,
      fetchedAt: entry.at,
      stale: entry.failed,
      ...(entry.error ? { error: entry.error } : {}),
    };
  }

  private writeStatus(
    entry: Entry,
    status: { lastTestedAt: number | null; lastError: string | null },
  ): void {
    if (entry.builtIn) this.envStatus = status;
    else this.store.setStatus(entry.record.id, status);
  }

  private view(entry: Entry): ModelProviderView {
    const { record } = entry;
    const set =
      record.key.kind === 'env' ? !!this.keyOf(entry) : record.key.set;
    return {
      id: record.id,
      presetId: record.presetId,
      name: record.name,
      baseUrl: record.baseUrl,
      key: { ...record.key, set },
      enabled: record.enabled,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastTestedAt: record.lastTestedAt,
      lastError: record.lastError
        ? this.cap(this.redact(record.lastError))
        : null,
      builtIn: entry.builtIn,
    };
  }
}
