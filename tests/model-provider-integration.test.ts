// Model providers wired the way the server wires them: a real Platform (registry over the workspace
// database), Dots that name a stored provider or none, and in-process fake providers behind `fetch`.
// No network and no real key is involved.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { chat } from '@tanstack/ai';
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import { lastValueFrom, toArray } from 'rxjs';
import { createApp } from '../src/server/app.js';
import { DotAgent } from '../src/server/dot-agent.js';
import { Platform } from '../src/server/platform.js';
import {
  setupStatus,
  type PlatformConfig,
} from '../src/server/platform-config.js';
import { research } from '../src/server/research.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  createFakeProvider,
  type FakeProvider,
} from './fixtures/fake-provider.js';

const ENV_KEY = 'env-key-0123456789abcdef';
const GROQ_KEY = 'gsk_groq-key-0123456789abcdef';
const MISTRAL_KEY = 'mistral-key-0123456789abcdef';
const ENV_URL = 'https://unused.invalid/v1';
const GROQ_URL = 'https://api.groq.com/openai/v1';
const MISTRAL_URL = 'https://api.mistral.ai/v1';

const closers: Array<{ close(): void } | (() => Promise<void>)> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const closer of closers.splice(0).reverse())
    if (typeof closer === 'function') await closer();
    else closer.close();
});

interface Rig {
  store: Store;
  workspace: WorkspaceStore;
  platform: Platform;
  config: PlatformConfig;
  fakes: { env: FakeProvider; groq: FakeProvider; mistral: FakeProvider };
  warnings: string[];
  /** Points the default Dot at a provider and model. */
  useProvider(providerId: string | null, model?: string | null): void;
  /** Runs one chat turn of the default Dot and returns its events. */
  turn(): Promise<BaseEvent[]>;
  addProvider(
    presetId: 'groq' | 'mistral',
    over?: Partial<Parameters<WorkspaceStore['modelProviders']['create']>[0]>,
  ): string;
}

function rig(options: { config?: Partial<PlatformConfig> } = {}): Rig {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const config: PlatformConfig = {
    apiKey: ENV_KEY,
    model: 'env-model',
    baseUrl: ENV_URL,
    voiceName: 'marin',
    ...options.config,
  };
  const platform = new Platform(store, workspace, config);
  closers.push(
    async () => {
      await platform.stop();
    },
    store,
    workspace,
  );
  const fakes = {
    env: createFakeProvider({ keys: [ENV_KEY] }),
    groq: createFakeProvider({ keys: [GROQ_KEY] }),
    mistral: createFakeProvider({ keys: [MISTRAL_KEY] }),
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://unused.invalid'))
      return fakes.env.fetch(input, init);
    if (url.startsWith(GROQ_URL)) return fakes.groq.fetch(input, init);
    if (url.startsWith(MISTRAL_URL)) return fakes.mistral.fetch(input, init);
    throw new Error(`Unexpected request to ${url}`);
  });
  const warnings: string[] = [];
  vi.spyOn(console, 'warn').mockImplementation((...args) => {
    warnings.push(args.join(' '));
  });
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'Providers');
  const useProvider = (
    providerId: string | null,
    model: string | null = null,
  ) =>
    void workspace.updateDot(dot.id, {
      name: dot.name,
      instructions: dot.instructions,
      researchAllowed: false,
      memoryAllowed: false,
      model,
      modelProviderId: providerId,
    });
  let runs = 0;
  const turn = () => {
    const input: RunAgentInput = {
      threadId: 'thread',
      runId: `run-${++runs}`,
      state: {},
      context: [],
      messages: [{ id: `user-${runs}`, role: 'user', content: 'Hello.' }],
      tools: [],
      forwardedProps: {},
    };
    return lastValueFrom(
      new DotAgent(store, workspace, config, dot.id, platform.services())
        .run(input)
        .pipe(toArray()),
    );
  };
  const addProvider = (
    presetId: 'groq' | 'mistral',
    over: Partial<
      Parameters<WorkspaceStore['modelProviders']['create']>[0]
    > = {},
  ) =>
    workspace.modelProviders.create({
      presetId,
      name: presetId === 'groq' ? 'Groq' : 'Mistral',
      baseUrl: presetId === 'groq' ? GROQ_URL : MISTRAL_URL,
      key: {
        kind: 'stored',
        value: presetId === 'groq' ? GROQ_KEY : MISTRAL_KEY,
      },
      ...over,
    }).id;
  return {
    store,
    workspace,
    platform,
    config,
    fakes,
    warnings,
    useProvider,
    turn,
    addProvider,
  };
}

const errorsOf = (events: BaseEvent[]) =>
  events
    .filter((event) => event.type === EventType.RUN_ERROR)
    .map((event) => (event as BaseEvent & { message: string }).message);
const replied = (events: BaseEvent[]) =>
  events
    .filter((event) => event.type === EventType.TEXT_MESSAGE_CHUNK)
    .map((event) => (event as BaseEvent & { delta?: string }).delta ?? '')
    .join('');

describe('a Dot with a stored provider', () => {
  it('sends its own key and max_completion_tokens to a Groq-preset provider', async () => {
    const f = rig();
    f.useProvider(f.addProvider('groq'), 'llama-3.3-70b-versatile');
    const events = await f.turn();
    expect(errorsOf(events)).toEqual([]);
    expect(replied(events)).toBe('ok');
    expect(f.fakes.env.requests).toEqual([]);
    expect(f.fakes.groq.chats()).toHaveLength(1);
    const request = f.fakes.groq.chats()[0];
    expect(request.path).toBe('/openai/v1/chat/completions');
    expect(request.headers.authorization).toBe(`Bearer ${GROQ_KEY}`);
    expect(request.body).toMatchObject({
      model: 'llama-3.3-70b-versatile',
      max_completion_tokens: expect.any(Number),
      stream: true,
    });
    expect(request.body).not.toHaveProperty('max_tokens');
  });

  it('sends max_tokens to a Mistral-preset provider', async () => {
    const f = rig();
    f.useProvider(f.addProvider('mistral'), 'mistral-large-latest');
    expect(errorsOf(await f.turn())).toEqual([]);
    const request = f.fakes.mistral.chats()[0];
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.headers.authorization).toBe(`Bearer ${MISTRAL_KEY}`);
    expect(request.body).toMatchObject({
      model: 'mistral-large-latest',
      max_tokens: expect.any(Number),
    });
    expect(request.body).not.toHaveProperty('max_completion_tokens');
    expect(f.fakes.groq.requests).toEqual([]);
  });

  it('uses the stored default model when the Dot names the provider without a model', async () => {
    const f = rig();
    const id = f.addProvider('groq');
    f.workspace.modelProviders.setDefaultModel({
      providerId: id,
      model: 'default-on-groq',
    });
    f.useProvider(id, null);
    expect(errorsOf(await f.turn())).toEqual([]);
    expect(f.fakes.groq.chats()[0].body).toMatchObject({
      model: 'default-on-groq',
    });
  });
});

describe('a Dot without a provider', () => {
  it('behaves like today against the .env provider', async () => {
    const f = rig();
    f.useProvider(null, null);
    expect(errorsOf(await f.turn())).toEqual([]);
    expect(f.fakes.env.chats()).toHaveLength(1);
    const request = f.fakes.env.chats()[0];
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.headers.authorization).toBe(`Bearer ${ENV_KEY}`);
    expect(request.body).toMatchObject({
      model: 'env-model',
      max_completion_tokens: expect.any(Number),
    });
    expect(request.body).not.toHaveProperty('max_tokens');
    for (const header of [
      'http-referer',
      'x-title',
      'x-api-key',
      'anthropic-version',
    ])
      expect(request.headers[header], header).toBeUndefined();

    // The same request made the way the code did it before providers existed: same URL and the
    // very same set of headers (names), so nothing was added on the wire.
    const before = createFakeProvider({ keys: [ENV_KEY] });
    vi.mocked(globalThis.fetch).mockImplementation(((input, init) =>
      before.fetch(input, init)) as typeof fetch);
    const adapter = openaiCompatibleText('env-model', {
      apiKey: ENV_KEY,
      baseURL: ENV_URL,
      api: 'chat-completions',
      maxRetries: 1,
    });
    for await (const chunk of chat({
      adapter,
      messages: [{ role: 'user', content: 'Hello.' }],
      modelOptions: { max_completion_tokens: 1 },
    }))
      void chunk;
    const legacy = before.chats()[0];
    expect(request.path).toBe(legacy.path);
    expect(Object.keys(request.headers).sort()).toEqual(
      Object.keys(legacy.headers).sort(),
    );
  });

  it('uses the Dot model on the .env provider and falls back to OPENAI_MODEL', async () => {
    const f = rig();
    f.useProvider(null, 'per-dot-model');
    await f.turn();
    expect(f.fakes.env.chats()[0].body).toMatchObject({
      model: 'per-dot-model',
    });
    f.useProvider(null, null);
    await f.turn();
    expect(f.fakes.env.chats()[1].body).toMatchObject({ model: 'env-model' });
  });

  it('sends max_completion_tokens to an OpenAI-compatible host it does not know', async () => {
    // Not a preset host: the .env provider keeps today's behaviour.
    const f = rig();
    f.useProvider(null, null);
    await f.turn();
    expect(f.platform.models.resolve({}).maxTokensKey).toBe(
      'max_completion_tokens',
    );
  });
});

describe('provider problems reach the chat as RUN_ERROR', () => {
  it('names a disabled provider with the registry text and never calls it', async () => {
    const f = rig();
    const id = f.addProvider('groq', { enabled: false });
    f.useProvider(id, 'llama');
    let message: string | undefined;
    try {
      f.platform.models.resolve({ providerId: id, model: 'llama' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('is disabled');
    expect(errorsOf(await f.turn())).toEqual([message]);
    expect(errorsOf(await f.turn())[0]).toBe(
      'The provider “Groq” is disabled. Enable it in Settings → Models or pick another model for this Dot.',
    );
    expect(f.fakes.groq.requests).toEqual([]);
    expect(f.fakes.env.requests).toEqual([]);
  });

  it('names a provider without a key', async () => {
    const f = rig();
    const id = f.addProvider('groq', {
      key: { kind: 'env', envName: 'FULLDOTS_TEST_UNSET_KEY' },
    });
    f.useProvider(id, 'llama');
    expect(errorsOf(await f.turn())).toEqual([
      'The provider “Groq” has no API key.',
    ]);
    expect(f.fakes.groq.requests).toEqual([]);
  });

  it('asks for a model when the provider has none to offer', async () => {
    const f = rig();
    f.useProvider(f.addProvider('groq'), null);
    expect(errorsOf(await f.turn())[0]).toBe(
      'No model is selected for “Groq”. Pick a model for this Dot or set a default in Settings → Models.',
    );
  });

  it('says no model is configured when there is neither .env nor a provider', async () => {
    const f = rig({ config: { apiKey: undefined } });
    f.useProvider(null, null);
    expect(errorsOf(await f.turn())).toEqual([
      'No model is configured. Add a provider in Settings → Models or set OPENAI_API_KEY.',
    ]);
  });

  it('falls back to the default for an unknown provider id and logs a warning once', async () => {
    const f = rig();
    f.useProvider('deleted-provider-id', 'some-model');
    expect(errorsOf(await f.turn())).toEqual([]);
    expect(f.fakes.env.chats()).toHaveLength(1);
    // The Dot's model id belonged to the missing provider, so the default's own model is used.
    expect(f.fakes.env.chats()[0].body).toMatchObject({ model: 'env-model' });
    expect(f.fakes.env.chats()[0].headers.authorization).toBe(
      `Bearer ${ENV_KEY}`,
    );
    await f.turn();
    const warnings = f.warnings.filter((line) =>
      line.includes('no longer exists'),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('falls back to the default');
    expect(warnings[0]).not.toContain(ENV_KEY);
  });

  it('redacts a key the provider echoes in its error body', async () => {
    const f = rig();
    const id = f.addProvider('groq');
    f.useProvider(id, 'llama');
    // The provider refuses the stored key and repeats it back in the error.
    const rejecting = createFakeProvider({ keys: ['someone-elses-key'] });
    rejecting.state.echoKeyInErrors = true;
    vi.mocked(globalThis.fetch).mockImplementation(((input, init) =>
      rejecting.fetch(input, init)) as typeof fetch);
    const outcome = await f.turn().then(
      (events) => ({ events, error: undefined }),
      (error: unknown) => ({ events: [] as BaseEvent[], error }),
    );
    expect(rejecting.chats()).toHaveLength(1);
    const messages = [
      ...errorsOf(outcome.events),
      ...(outcome.error instanceof Error ? [outcome.error.message] : []),
    ];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Invalid API key');
    expect(messages[0]).toContain('[redacted]');
    expect(messages[0]).not.toContain(GROQ_KEY);
  });
});

describe('setup status', () => {
  it('is ready with a .env provider and labels the default', () => {
    const f = rig();
    expect(f.platform.setup()).toMatchObject({
      model: true,
      missing: [],
      defaultModel: 'Default (from .env) · env-model',
    });
    expect(() => f.platform.requireReady()).not.toThrow();
  });

  it('is ready with only a stored default and not ready with neither', () => {
    const none = rig({ config: { apiKey: undefined, model: undefined } });
    expect(none.platform.setup()).toMatchObject({
      model: false,
      missing: ['model provider'],
    });
    expect(none.platform.setup().defaultModel).toBeUndefined();
    expect(() => none.platform.requireReady()).toThrow(
      'Setup required: model provider.',
    );

    const id = none.addProvider('groq');
    // A provider alone is not a default model.
    expect(none.platform.setup().model).toBe(false);
    none.workspace.modelProviders.setDefaultModel({
      providerId: id,
      model: 'llama-3.3-70b-versatile',
    });
    expect(none.platform.setup()).toMatchObject({
      model: true,
      missing: [],
      defaultModel: 'Groq · llama-3.3-70b-versatile',
    });
    expect(() => none.platform.requireReady()).not.toThrow();
    none.workspace.modelProviders.update(id, { enabled: false });
    expect(none.platform.setup().model).toBe(false);
  });

  it('keeps voice off until a model is usable', () => {
    const voice = { voiceKey: 'v', voiceModel: 'm', voiceName: 'marin' };
    expect(setupStatus({ baseUrl: '', ...voice }, true, 'A · b').voice).toBe(
      true,
    );
    expect(setupStatus({ baseUrl: '', ...voice }, false).voice).toBe(false);
    expect(setupStatus({ baseUrl: '', ...voice }, false).missing).toEqual([
      'model provider',
    ]);
  });
});

describe('research', () => {
  const live = (f: Rig) => ({
    mode: 'live' as const,
    baseUrl: '',
    models: f.platform.models,
    browserUrl: 'http://browser.test:4311',
    browserSecret: 'browser-secret',
  });
  async function run(f: Rig) {
    const base = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('http://browser.test'))
        return Response.json({
          title: 'Evidence',
          url: 'https://example.com',
          text: 'Verified source text',
        });
      const response = await base(input, init);
      // The fake providers stream; research reads a plain completion.
      if (url.endsWith('/chat/completions'))
        return Response.json({
          choices: [{ message: { content: 'A grounded brief.' } }],
        });
      return response;
    });
    return research(
      'Summarize https://example.com',
      [],
      live(f),
      new AbortController().signal,
      () => {},
    );
  }

  it('uses the .env provider as the default', async () => {
    const f = rig();
    const result = await run(f);
    expect(result.text).toBe('A grounded brief.');
    const request = f.fakes.env.chats()[0];
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.headers.authorization).toBe(`Bearer ${ENV_KEY}`);
    expect(request.body).toMatchObject({
      model: 'env-model',
      max_completion_tokens: 1800,
    });
    expect(request.body).not.toHaveProperty('max_tokens');
  });

  it('uses the stored default provider, its key and its max-tokens field', async () => {
    const f = rig();
    const id = f.addProvider('mistral');
    f.workspace.modelProviders.setDefaultModel({
      providerId: id,
      model: 'mistral-large-latest',
    });
    await run(f);
    expect(f.fakes.env.requests).toEqual([]);
    const request = f.fakes.mistral.chats()[0];
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.headers.authorization).toBe(`Bearer ${MISTRAL_KEY}`);
    expect(request.body).toMatchObject({
      model: 'mistral-large-latest',
      max_tokens: 1800,
    });
  });

  it('is not configured without a usable default provider', async () => {
    const f = rig({ config: { apiKey: undefined } });
    await expect(run(f)).rejects.toThrow('not configured');
  });
});

describe('Dot routes and GET /api/models', () => {
  function app(f: Rig) {
    return createApp({
      store: f.store,
      runner: new Runner(f.store, { mode: 'live', baseUrl: 'https://x.test' }),
      config: { mode: 'live', baseUrl: 'https://x.test' },
      platform: f.platform,
    });
  }
  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const dotBody = (extra: Record<string, unknown> = {}) => ({
    name: 'Scout',
    instructions: 'Be concise.',
    researchAllowed: false,
    memoryAllowed: false,
    ...extra,
  });

  it('stores, returns and clears modelProviderId, and rejects an unknown one', async () => {
    const f = rig();
    const server = app(f);
    const id = f.addProvider('groq');
    const dot = f.workspace.dots()[0];

    const unknown = await server.request(
      `/api/dots/${dot.id}`,
      json('PUT', dotBody({ modelProviderId: 'nope' })),
    );
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: 'Unknown model provider.' });

    const set = await server.request(
      `/api/dots/${dot.id}`,
      json('PUT', dotBody({ model: 'llama', modelProviderId: id })),
    );
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({
      model: 'llama',
      modelProviderId: id,
    });
    expect(f.workspace.dot(dot.id)?.modelProviderId).toBe(id);

    // Leaving the field out keeps it; null clears it.
    const kept = await server.request(
      `/api/dots/${dot.id}`,
      json('PUT', dotBody()),
    );
    expect(await kept.json()).toMatchObject({ modelProviderId: id });
    const cleared = await server.request(
      `/api/dots/${dot.id}`,
      json('PUT', dotBody({ modelProviderId: null })),
    );
    expect(await cleared.json()).toMatchObject({ modelProviderId: null });

    const created = await server.request(
      '/api/dots',
      json(
        'POST',
        dotBody({
          spaceId: f.workspace.spaces()[0].id,
          model: 'mistral-small',
          modelProviderId: f.addProvider('mistral'),
        }),
      ),
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ model: 'mistral-small' });
    const bad = await server.request(
      '/api/dots',
      json(
        'POST',
        dotBody({
          spaceId: f.workspace.spaces()[0].id,
          modelProviderId: 'nope',
        }),
      ),
    );
    expect(bad.status).toBe(400);
  });

  it('keeps { default, models } and adds providers with their lists', async () => {
    const f = rig();
    f.fakes.env.state.models = ['env-model', 'env-other'];
    f.fakes.groq.state.models = ['llama-a', 'llama-b'];
    const groq = f.addProvider('groq');
    f.addProvider('mistral', { enabled: false });
    const response = await app(f).request('/api/models');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      default: 'Default (from .env) · env-model',
      models: ['env-model', 'env-other'],
    });
    expect(body.providers.map((p: { id: string }) => p.id)).toEqual([
      'env',
      groq,
    ]);
    expect(body.providers[1]).toMatchObject({
      name: 'Groq',
      presetId: 'groq',
      models: [{ id: 'llama-a' }, { id: 'llama-b' }],
    });
    expect(JSON.stringify(body)).not.toContain(GROQ_KEY);
    expect(JSON.stringify(body)).not.toContain(ENV_KEY);
  });

  it('lists a provider that cannot be reached with no models instead of failing', async () => {
    const f = rig();
    f.fakes.groq.state.modelsStatus = 500;
    f.addProvider('groq');
    const body = await (await app(f).request('/api/models')).json();
    expect(body.providers[1].models).toEqual([]);
    expect(body.providers[0].models.length).toBeGreaterThan(0);
  });

  it('reports the model provider as the setup requirement on the workspace', async () => {
    const f = rig({ config: { apiKey: undefined } });
    const body = await (await app(f).request('/api/workspace')).json();
    expect(body.setup).toMatchObject({
      model: false,
      missing: ['model provider'],
    });
  });
});
