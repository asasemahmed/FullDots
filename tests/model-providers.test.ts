import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chat } from '@tanstack/ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { modelPresets } from '../src/shared/model-presets.js';
import { ModelProviderStore } from '../src/server/model-provider-store.js';
import {
  checkProviderBaseUrl,
  ModelProviderError,
  ModelProviderRegistry,
  parseModelList,
  providerFetch,
  type ModelProviderRegistryOptions,
} from '../src/server/model-providers.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import {
  createFakeProvider,
  type FakeProviderOptions,
} from './fixtures/fake-provider.js';

const dbs: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of dbs.splice(0)) db.close();
});

const ENV_KEY = 'sk-or-v1-envkey-1234567890';
const GROQ_KEY = 'gsk_groq-secret-key-abcdef123456';

function config(over: Partial<PlatformConfig> = {}): PlatformConfig {
  return {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: ENV_KEY,
    model: 'deepseek/deepseek-v4',
    voiceName: 'marin',
    ...over,
  };
}

function setup(
  options: {
    env?: Partial<PlatformConfig>;
    processEnv?: NodeJS.ProcessEnv;
    provider?: FakeProviderOptions;
    now?: () => number;
  } = {},
) {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  const store = new ModelProviderStore(db, randomBytes(32));
  const fake = createFakeProvider(options.provider);
  const registryOptions: ModelProviderRegistryOptions = {
    env: config(options.env),
    processEnv: options.processEnv ?? {},
    fetch: fake.fetch,
    ...(options.now ? { now: options.now } : {}),
  };
  const registry = new ModelProviderRegistry(store, registryOptions);
  const addGroq = (extra: Partial<Parameters<typeof store.create>[0]> = {}) =>
    store.create({
      presetId: 'groq',
      name: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1/',
      key: { kind: 'stored', value: GROQ_KEY },
      ...extra,
    });
  return { db, store, fake, registry, addGroq };
}

describe('virtual env provider', () => {
  it.each([
    ['https://openrouter.ai/api/v1', 'openrouter'],
    ['https://api.openai.com/v1', 'openai'],
    ['https://llm.example.test/v1', 'custom'],
    ['http://localhost:1234/v1', 'custom'],
  ])('infers the preset of %s as %s', (baseUrl, presetId) => {
    const { registry } = setup({ env: { baseUrl } });
    const [env] = registry.list();
    expect(env).toMatchObject({
      id: 'env',
      presetId,
      baseUrl,
      builtIn: true,
      enabled: true,
      key: { kind: 'env', set: true, envName: 'OPENAI_API_KEY' },
    });
    expect(JSON.stringify(registry.list())).not.toContain(ENV_KEY);
    expect(registry.get('env')).toEqual(env);
  });

  it('is hidden without an api key and lists before stored providers', () => {
    const hidden = setup({ env: { apiKey: undefined } });
    expect(hidden.registry.list()).toEqual([]);
    expect(hidden.registry.get('env')).toBeUndefined();
    const both = setup();
    both.addGroq();
    expect(both.registry.list().map((provider) => provider.name)).toEqual([
      'Default (from .env)',
      'Groq',
    ]);
  });
});

describe('resolve', () => {
  it('resolves the .env default exactly like today (openrouter keeps max_completion_tokens)', () => {
    const { registry } = setup();
    const resolved = registry.resolve({});
    expect(resolved).toMatchObject({
      providerId: 'env',
      model: 'deepseek/deepseek-v4',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: ENV_KEY,
      maxTokensKey: 'max_completion_tokens',
    });
    expect(resolved.preset.id).toBe('openrouter');
    expect(registry.resolveDefault().model).toBe(resolved.model);
    expect(registry.hasUsableDefault()).toBe(true);
    expect(registry.defaultLabel()).toBe('OpenRouter · deepseek/deepseek-v4');
    expect(registry.defaultModel()).toEqual({
      providerId: 'env',
      model: 'deepseek/deepseek-v4',
    });
    // A Dot's own model id wins on the default provider.
    expect(
      registry.resolve({ providerId: null, model: ' other/model ' }).model,
    ).toBe('other/model');
    expect(registry.resolve({ providerId: 'env', model: '' }).model).toBe(
      'deepseek/deepseek-v4',
    );
  });

  it('keeps max_completion_tokens for an unknown .env host', () => {
    const { registry } = setup({
      env: { baseUrl: 'https://llm.example.test/v1' },
    });
    expect(registry.resolve({}).maxTokensKey).toBe('max_completion_tokens');
  });

  it('throws the no-provider text when neither .env nor a stored default exists', () => {
    const { registry } = setup({ env: { apiKey: undefined } });
    const error = catchError(() => registry.resolve({}));
    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error).toMatchObject({
      code: 'no-provider',
      message:
        'No model is configured. Add a provider in Settings → Models or set OPENAI_API_KEY.',
    });
    expect(registry.hasUsableDefault()).toBe(false);
    expect(registry.defaultLabel()).toBeUndefined();
    expect(registry.defaultModel()).toBeNull();
  });

  it('resolves a stored provider with its key, header extras and the preset max-tokens key', () => {
    const { registry, addGroq, store } = setup();
    const groq = addGroq();
    const resolved = registry.resolve({
      providerId: groq.id,
      model: 'llama-3.3-70b-versatile',
    });
    expect(resolved).toMatchObject({
      providerId: groq.id,
      providerName: 'Groq',
      model: 'llama-3.3-70b-versatile',
      baseURL: 'https://api.groq.com/openai/v1',
      apiKey: GROQ_KEY,
      maxTokensKey: 'max_completion_tokens',
      defaultHeaders: {},
    });
    const anthropic = store.create({
      presetId: 'anthropic',
      name: 'Claude',
      baseUrl: 'https://api.anthropic.com/v1',
      key: { kind: 'stored', value: 'sk-ant-api03-abcdefghijkl' },
      extra: { anthropicWorkspaceId: 'wrkspc_01' },
    });
    expect(
      registry.resolve({ providerId: anthropic.id, model: 'claude-x' }),
    ).toMatchObject({
      maxTokensKey: 'max_tokens',
      defaultHeaders: { 'anthropic-workspace-id': 'wrkspc_01' },
    });
  });

  it('throws the disabled text', () => {
    const { registry, addGroq, store } = setup();
    const groq = addGroq();
    store.update(groq.id, { enabled: false });
    expect(
      catchError(() => registry.resolve({ providerId: groq.id, model: 'm' })),
    ).toMatchObject({
      code: 'disabled',
      message:
        'The provider “Groq” is disabled. Enable it in Settings → Models or pick another model for this Dot.',
    });
  });

  it('throws the key-missing text for unreadable, unset-env and absent keys', () => {
    const { registry, addGroq, store, db } = setup();
    const message = 'The provider “Groq” has no API key.';
    const groq = addGroq();
    db.prepare(
      "UPDATE model_providers SET keySealed='v1.bad.bad.bad' WHERE id=?",
    ).run(groq.id);
    expect(
      catchError(() => registry.resolve({ providerId: groq.id, model: 'm' })),
    ).toMatchObject({
      code: 'key-missing',
      message,
    });
    store.update(groq.id, { key: { kind: 'env', envName: 'GROQ_API_KEY' } });
    expect(
      catchError(() => registry.resolve({ providerId: groq.id, model: 'm' })),
    ).toMatchObject({
      code: 'key-missing',
    });
    store.update(groq.id, { key: { kind: 'none' } });
    expect(
      catchError(() => registry.resolve({ providerId: groq.id, model: 'm' })),
    ).toMatchObject({
      code: 'key-missing',
    });
    // A set env variable works and is read at resolve time.
    const env = setup({ processEnv: { GROQ_API_KEY: ` ${GROQ_KEY} ` } });
    const viaEnv = env.addGroq({
      key: { kind: 'env', envName: 'GROQ_API_KEY' },
    });
    expect(
      env.registry.resolve({ providerId: viaEnv.id, model: 'm' }).apiKey,
    ).toBe(GROQ_KEY);
    expect(env.registry.get(viaEnv.id)?.key).toEqual({
      kind: 'env',
      set: true,
      envName: 'GROQ_API_KEY',
    });
  });

  it('uses a placeholder key for keyless local providers', () => {
    const { registry, store } = setup();
    const ollama = store.create({
      presetId: 'ollama',
      name: 'Ollama',
      baseUrl: 'http://localhost:11434/v1',
      key: { kind: 'none' },
    });
    expect(
      registry.resolve({ providerId: ollama.id, model: 'llama3.2' }).apiKey,
    ).toBe('not-needed');
  });

  it('throws no-model when a provider has no model and no default points to it', () => {
    const { registry, addGroq } = setup();
    const groq = addGroq();
    expect(
      catchError(() => registry.resolve({ providerId: groq.id })),
    ).toMatchObject({
      code: 'no-model',
    });
    const noEnvModel = setup({ env: { model: undefined } });
    expect(catchError(() => noEnvModel.registry.resolve({}))).toMatchObject({
      code: 'no-model',
    });
  });

  it('prefers the stored default over .env, falling back to .env when its provider is gone', () => {
    const { registry, addGroq, store } = setup();
    const groq = addGroq();
    registry.setDefaultModel({ providerId: groq.id, model: ' llama-3.3 ' });
    expect(registry.resolveDefault()).toMatchObject({
      providerId: groq.id,
      model: 'llama-3.3',
    });
    expect(registry.resolve({})).toMatchObject({
      providerId: groq.id,
      model: 'llama-3.3',
    });
    // The provider's own default model applies when the Dot names the provider only.
    expect(registry.resolve({ providerId: groq.id }).model).toBe('llama-3.3');
    expect(registry.defaultLabel()).toBe('Groq · llama-3.3');
    registry.setDefaultModel({ providerId: 'env', model: 'e' });
    expect(registry.resolveDefault().providerId).toBe('env');
    expect(() =>
      registry.setDefaultModel({ providerId: 'nope', model: 'm' }),
    ).toThrow(ModelProviderError);
    expect(() =>
      registry.setDefaultModel({ providerId: groq.id, model: ' ' }),
    ).toThrow(ModelProviderError);
    registry.setDefaultModel({ providerId: groq.id, model: 'llama-3.3' });
    store.delete(groq.id);
    expect(registry.resolveDefault()).toMatchObject({
      providerId: 'env',
      model: 'deepseek/deepseek-v4',
    });
    registry.clearDefaultModel();
    expect(store.getDefaultModel()).toBeUndefined();
  });

  it('refuses a disabled default instead of silently switching providers', () => {
    const { registry, addGroq, store } = setup();
    const groq = addGroq();
    registry.setDefaultModel({ providerId: groq.id, model: 'm' });
    store.update(groq.id, { enabled: false });
    expect(catchError(() => registry.resolveDefault())).toMatchObject({
      code: 'disabled',
    });
    expect(registry.hasUsableDefault()).toBe(false);
  });

  it('falls back to the default with a warning when the named provider no longer exists', () => {
    const { registry } = setup();
    const resolved = registry.resolve({
      providerId: 'gone',
      model: 'gone/model',
    });
    expect(resolved).toMatchObject({
      providerId: 'env',
      model: 'deepseek/deepseek-v4',
    });
    expect(resolved.warning).toMatch(/no longer exists/);
    expect(registry.resolve({}).warning).toBeUndefined();
  });
});

describe('providerFetch and adapterFor', () => {
  const body = JSON.stringify({
    model: 'm',
    tool_choice: 'auto',
    tools: [],
    messages: [],
  });

  it('drops tool_choice for Ollama and leaves other providers alone', async () => {
    const { registry, store, fake, addGroq } = setup();
    const ollama = store.create({
      presetId: 'ollama',
      name: 'Ollama',
      baseUrl: 'http://localhost:11434/v1',
      key: { kind: 'none' },
    });
    const local = registry.resolve({
      providerId: ollama.id,
      model: 'llama3.2',
    });
    await local.fetch('http://localhost:11434/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(fake.chats()[0]?.body).toEqual({
      model: 'm',
      tools: [],
      messages: [],
    });
    const groq = registry.resolve({ providerId: addGroq().id, model: 'm' });
    await groq.fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      body,
    });
    expect(fake.chats()[1]?.body).toMatchObject({ tool_choice: 'auto' });
  });

  it('sends no attribution headers to OpenRouter (FullDots identifies itself to no one)', async () => {
    const { registry, fake } = setup();
    const resolved = registry.resolve({});
    expect(resolved.defaultHeaders).not.toHaveProperty('HTTP-Referer');
    expect(resolved.defaultHeaders).not.toHaveProperty('X-Title');
    await resolved.fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      body: '{}',
    });
    await registry.models('env');
    for (const request of [fake.chats()[0]!, fake.listings()[0]!]) {
      expect(request.headers['x-title']).toBeUndefined();
      expect(request.headers['http-referer']).toBeUndefined();
    }
  });

  it('streams a chat turn through the OpenAI adapter with key, headers and max tokens', async () => {
    const { registry, fake } = setup({ provider: { keys: [ENV_KEY] } });
    const resolved = registry.resolve({});
    const adapter = registry.adapterFor(resolved, 0);
    const stream = chat({
      adapter,
      messages: [{ role: 'user', content: 'hi' }],
      modelOptions: { [resolved.maxTokensKey]: 321 },
    });
    const chunks: unknown[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(0);
    const request = fake.chats()[0]!;
    expect(request.path).toBe('/api/v1/chat/completions');
    expect(request.headers.authorization).toBe(`Bearer ${ENV_KEY}`);
    expect(request.headers['x-title']).toBeUndefined();
    expect(request.body).toMatchObject({
      model: 'deepseek/deepseek-v4',
      max_completion_tokens: 321,
      stream: true,
    });
    expect(request.body).not.toHaveProperty('max_tokens');
  });

  it('sends a placeholder bearer to a keyless Ollama through the adapter', async () => {
    const { registry, store, fake } = setup();
    const ollama = store.create({
      presetId: 'ollama',
      name: 'Ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      key: { kind: 'none' },
    });
    const resolved = registry.resolve({
      providerId: ollama.id,
      model: 'llama3.2',
    });
    const stream = chat({
      adapter: registry.adapterFor(resolved, 0),
      messages: [{ role: 'user', content: 'hi' }],
      modelOptions: { [resolved.maxTokensKey]: 50 },
    });
    for await (const chunk of stream) void chunk;
    expect(fake.chats()[0]?.headers.authorization).toBe('Bearer not-needed');
    expect(fake.chats()[0]?.body).toMatchObject({ max_tokens: 50 });
  });

  it('refuses redirects and plain-http remote hosts, and redacts keys in thrown errors', async () => {
    const { registry, addGroq } = setup();
    const groq = registry.resolve({ providerId: addGroq().id, model: 'm' });
    await expect(
      groq.fetch('http://api.groq.com/openai/v1/chat/completions', {}),
    ).rejects.toThrow(/only https is allowed/);
    const preset = modelPresets.find((entry) => entry.id === 'groq')!;
    const failing = providerFetch(preset, 'https://api.groq.com/openai/v1', {
      fetch: async () => {
        throw new Error(`boom ${GROQ_KEY}`);
      },
      redact: (text) => text.split(GROQ_KEY).join('[redacted]'),
    });
    await expect(
      failing('https://api.groq.com/openai/v1/models'),
    ).rejects.toThrow('boom [redacted]');
    const redirecting = providerFetch(
      preset,
      'https://api.groq.com/openai/v1',
      {
        fetch: async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://evil.test' },
          }),
      },
    );
    await expect(
      redirecting('https://api.groq.com/openai/v1/models'),
    ).rejects.toThrow(/redirected/);
    const aborted = providerFetch(preset, 'https://api.groq.com/openai/v1', {
      fetch: async () => {
        throw new DOMException('aborted', 'AbortError');
      },
    });
    await expect(
      aborted('https://api.groq.com/openai/v1/models'),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('local provider network rule', () => {
  const lan = {
    presetId: 'ollama' as const,
    name: 'Ollama box',
    baseUrl: 'http://192.168.1.50:11434/v1',
    key: { kind: 'none' as const },
  };

  it('is loopback-only by default and opens to the owner network with MODEL_PROVIDERS_ALLOW_LAN', async () => {
    const closed = setup();
    const blocked = closed.store.create(lan);
    const list = await closed.registry.models(blocked.id);
    expect(list).toMatchObject({ models: [], stale: true });
    expect(list.error).toMatch(/limited to localhost/);
    expect(closed.fake.requests).toHaveLength(0);
    await expect(
      closed.registry
        .resolve({ providerId: blocked.id, model: 'm' })
        .fetch(`${lan.baseUrl}/chat/completions`, {
          method: 'POST',
          body: '{}',
        }),
    ).rejects.toThrow(/limited to localhost/);

    const open = setup({ processEnv: { MODEL_PROVIDERS_ALLOW_LAN: 'true' } });
    const allowed = open.store.create(lan);
    expect(
      (await open.registry.models(allowed.id)).models.map((m) => m.id),
    ).toEqual(['fake-large', 'fake-small']);
    expect(open.fake.listings()[0]?.path).toBe('/v1/models');
    // Public hosts are still refused for a local preset.
    const publicHost = open.store.create({
      ...lan,
      name: 'Public',
      baseUrl: 'http://8.8.8.8:11434/v1',
    });
    expect((await open.registry.models(publicHost.id)).error).toMatch(
      /Refused request/,
    );
  });

  it('applies the same rule when saving', () => {
    const preset = modelPresets.find((entry) => entry.id === 'ollama')!;
    expect(
      checkProviderBaseUrl(preset, 'http://localhost:11434/v1'),
    ).toBeUndefined();
    expect(
      checkProviderBaseUrl(preset, 'http://[::1]:11434/v1'),
    ).toBeUndefined();
    expect(checkProviderBaseUrl(preset, 'http://192.168.1.5:11434/v1')).toMatch(
      /MODEL_PROVIDERS_ALLOW_LAN/,
    );
    expect(
      checkProviderBaseUrl(preset, 'http://192.168.1.5:11434/v1', {
        allowLan: true,
      }),
    ).toBeUndefined();
    expect(
      checkProviderBaseUrl(preset, 'http://8.8.8.8/v1', { allowLan: true }),
    ).toMatch(/own network/);
    const custom = modelPresets.find((entry) => entry.id === 'custom')!;
    expect(
      checkProviderBaseUrl(custom, 'https://llm.example.test/v1'),
    ).toBeUndefined();
    expect(
      checkProviderBaseUrl(custom, 'http://localhost:8000/v1'),
    ).toBeUndefined();
    expect(checkProviderBaseUrl(custom, 'http://llm.example.test/v1')).toMatch(
      /https/,
    );
    expect(checkProviderBaseUrl(custom, 'https://10.0.0.5/v1')).toMatch(
      /private/,
    );
    expect(checkProviderBaseUrl(custom, 'https://u:p@x.test/v1')).toMatch(
      /user name/,
    );
    expect(checkProviderBaseUrl(custom, 'https://x.test/v1?a=1')).toMatch(
      /query/,
    );
    expect(checkProviderBaseUrl(custom, 'ftp://x.test/v1')).toMatch(/https/);
    expect(checkProviderBaseUrl(custom, 'nonsense')).toMatch(/not a valid URL/);
    expect(
      checkProviderBaseUrl(custom, `https://x.test/${'a'.repeat(500)}`),
    ).toMatch(/too long/);
    const { registry } = setup();
    expect(
      registry.checkBaseUrl('groq', 'https://api.groq.com/openai/v1'),
    ).toBeUndefined();
    expect(registry.checkBaseUrl('groq', 'http://api.groq.com')).toMatch(
      /https/,
    );
  });

  it('does not restrict the .env provider URL, which the operator chose', async () => {
    const { registry, fake } = setup({
      env: { baseUrl: 'http://192.168.1.9:8000/v1' },
    });
    expect((await registry.models('env')).stale).toBe(false);
    expect(fake.listings()).toHaveLength(1);
  });
});

describe('models', () => {
  it('parses the OpenAI shape', async () => {
    const { registry, addGroq, fake } = setup({
      provider: { keys: [GROQ_KEY] },
    });
    const groq = addGroq();
    const result = await registry.models(groq.id);
    expect(result).toMatchObject({ stale: false });
    expect(result.models).toEqual([{ id: 'fake-large' }, { id: 'fake-small' }]);
    expect(fake.listings()[0]).toMatchObject({
      path: '/openai/v1/models',
      headers: { authorization: `Bearer ${GROQ_KEY}` },
    });
  });

  it('parses a bare array and drops non-chat entries (Together)', async () => {
    const { registry, store, fake } = setup({ provider: { shape: 'array' } });
    const together = store.create({
      presetId: 'together',
      name: 'Together',
      baseUrl: 'https://api.together.ai/v1',
      key: { kind: 'stored', value: 'together-key-1234567' },
    });
    const { models } = await registry.models(together.id);
    expect(models.map((model) => model.id)).toEqual([
      'fake-large',
      'fake-small',
    ]);
    expect(models[0]).toMatchObject({ contextLength: 8192 });
    // Mistral documents a bare array too; the openai shape accepts it.
    fake.state.modelsBody = [
      { id: 'mistral-large' },
      { id: 'mistral-embed', capabilities: { completion_chat: false } },
    ];
    const mistral = store.create({
      presetId: 'mistral',
      name: 'Mistral',
      baseUrl: 'https://api.mistral.ai/v1',
      key: { kind: 'stored', value: 'mistral-key-1234567' },
    });
    expect((await registry.models(mistral.id)).models).toEqual([
      { id: 'mistral-large' },
    ]);
  });

  it('strips the models/ prefix of Gemini ids', async () => {
    const { registry, store } = setup({ provider: { shape: 'gemini' } });
    const gemini = store.create({
      presetId: 'gemini',
      name: 'Gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      key: { kind: 'stored', value: 'AIzaSyFakeKey123456' },
    });
    const { models } = await registry.models(gemini.id);
    expect(models.map((model) => model.id)).toEqual([
      'fake-large',
      'fake-small',
    ]);
  });

  it('reads names, tool support and context length (OpenRouter)', async () => {
    const { registry } = setup({ provider: { shape: 'openrouter' } });
    const { models } = await registry.models('env');
    expect(models[0]).toEqual({
      id: 'fake-large',
      name: 'Name of fake-large',
      tools: true,
      contextLength: 32000,
    });
  });

  it('lists Anthropic models with x-api-key and the version header, not a bearer', async () => {
    const { registry, store, fake } = setup({
      provider: { shape: 'anthropic', keys: ['sk-ant-api03-abcdefghijkl'] },
    });
    const anthropic = store.create({
      presetId: 'anthropic',
      name: 'Claude',
      baseUrl: 'https://api.anthropic.com/v1',
      key: { kind: 'stored', value: 'sk-ant-api03-abcdefghijkl' },
    });
    const { models, stale } = await registry.models(anthropic.id);
    expect(stale).toBe(false);
    expect(models[0]).toEqual({ id: 'fake-large', name: 'Display fake-large' });
    const request = fake.listings()[0]!;
    expect(request.path).toBe('/v1/models');
    expect(request.search).toBe('?limit=1000');
    expect(request.headers['x-api-key']).toBe('sk-ant-api03-abcdefghijkl');
    expect(request.headers['anthropic-version']).toBe('2023-06-01');
    expect(request.headers).not.toHaveProperty('authorization');
  });

  it('parseModelList skips inactive models, accepts data or models arrays and rejects other shapes', () => {
    expect(
      parseModelList('openai', {
        data: [
          { id: 'a', active: false },
          { id: 'b', context_window: 8000 },
          { id: 'b' },
          'c',
          7,
        ],
      }),
    ).toEqual([{ id: 'b', contextLength: 8000 }, { id: 'c' }]);
    expect(
      parseModelList('gemini', {
        models: [
          {
            name: 'models/gemini-1',
            supportedGenerationMethods: ['generateContent'],
            displayName: 'Gemini One',
            inputTokenLimit: 1000,
          },
          {
            name: 'models/embed',
            supportedGenerationMethods: ['embedContent'],
          },
        ],
      }),
    ).toEqual([{ id: 'gemini-1', name: 'Gemini One', contextLength: 1000 }]);
    expect(() => parseModelList('openai', { nope: 1 })).toThrow(
      /unknown format/,
    );
    expect(() => parseModelList('openai', 'text')).toThrow(/unknown format/);
  });

  describe('cache', () => {
    it('serves from cache for ten minutes, then refetches; refresh and edits bypass it', async () => {
      let time = 1_000_000;
      const { registry, addGroq, store, fake } = setup({ now: () => time });
      const groq = addGroq();
      const first = await registry.models(groq.id);
      expect(first).toMatchObject({ fetchedAt: time, stale: false });
      time += 9 * 60_000;
      await registry.models(groq.id);
      expect(fake.listings()).toHaveLength(1);
      time += 61_000;
      const third = await registry.models(groq.id);
      expect(fake.listings()).toHaveLength(2);
      expect(third.fetchedAt).toBe(time);
      await registry.models(groq.id, { refresh: true });
      expect(fake.listings()).toHaveLength(3);
      await registry.models(groq.id);
      expect(fake.listings()).toHaveLength(3);
      store.update(groq.id, { name: 'Groq 2' });
      await registry.models(groq.id);
      expect(fake.listings()).toHaveLength(4);
      registry.invalidate(groq.id);
      await registry.models(groq.id);
      expect(fake.listings()).toHaveLength(5);
    });

    it('shares one request between concurrent callers', async () => {
      const { registry, fake } = setup();
      await Promise.all([
        registry.models('env'),
        registry.models('env'),
        registry.models('env'),
      ]);
      expect(fake.listings()).toHaveLength(1);
    });

    it('caches a failure for 60 seconds as an empty stale list and recovers afterwards', async () => {
      let time = 5_000_000;
      const { registry, fake } = setup({ now: () => time });
      fake.state.modelsStatus = 500;
      const failed = await registry.models('env');
      expect(failed).toMatchObject({ models: [], stale: true });
      expect(failed.error).toBe('HTTP 500: models unavailable');
      time += 59_000;
      await registry.models('env');
      expect(fake.listings()).toHaveLength(1);
      fake.state.modelsStatus = undefined;
      time += 2_000;
      const recovered = await registry.models('env');
      expect(fake.listings()).toHaveLength(2);
      expect(recovered).toMatchObject({ stale: false });
      expect(recovered.models).toHaveLength(2);
    });

    it('keeps the last good list as stale when a refresh fails', async () => {
      const { registry, fake } = setup();
      await registry.models('env');
      fake.state.modelsStatus = 503;
      const result = await registry.models('env', { refresh: true });
      expect(result.stale).toBe(true);
      expect(result.models).toHaveLength(2);
    });

    it('throws no-provider for an unknown id and reports a missing key without a request', async () => {
      const { registry, addGroq, fake } = setup();
      await expect(registry.models('nope')).rejects.toMatchObject({
        code: 'no-provider',
      });
      const keyless = addGroq({ key: { kind: 'none' } });
      expect(await registry.models(keyless.id)).toMatchObject({
        models: [],
        stale: true,
        error: 'The provider has no API key.',
      });
      expect(fake.requests).toHaveLength(0);
    });
  });
});

describe('test()', () => {
  it('records lastTestedAt and clears lastError on success, with a latency and count', async () => {
    let time = 10_000;
    const { registry, addGroq, store } = setup({ now: () => time });
    const groq = addGroq();
    store.setStatus(groq.id, { lastTestedAt: 1, lastError: 'old failure' });
    const result = await registry.test(groq.id);
    expect(result).toEqual({ ok: true, count: 2, latencyMs: 0 });
    expect(registry.get(groq.id)).toMatchObject({
      lastTestedAt: time,
      lastError: null,
    });
    time += 5;
    await registry.test(groq.id);
    expect(registry.get(groq.id)?.lastTestedAt).toBe(time);
  });

  it('records a redacted, capped error on failure and never logs', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const write = vi.spyOn(process.stdout, 'write');
    const { registry, addGroq, fake } = setup({
      provider: { keys: ['some-other-key-123456'] },
    });
    const groq = addGroq();
    fake.state.echoKeyInErrors = true;
    const result = await registry.test(groq.id);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('HTTP 401: Invalid API key: [redacted]');
    expect(JSON.stringify(result)).not.toContain(GROQ_KEY);
    const view = registry.get(groq.id)!;
    expect(view.lastError).toBe(result.error);
    expect(view.lastTestedAt).toEqual(expect.any(Number));
    expect(JSON.stringify(view)).not.toContain(GROQ_KEY);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    const logged = write.mock.calls.map((call) => String(call[0])).join('');
    expect(logged).not.toContain(GROQ_KEY);
    // A very long provider message is capped at 200 characters.
    const long = setup();
    const other = long.addGroq();
    long.fake.state.modelsStatus = 500;
    long.fake.state.modelsError = 'z'.repeat(500);
    const capped = await long.registry.test(other.id);
    expect(capped.error).toHaveLength(200);
    expect(long.registry.get(other.id)?.lastError).toHaveLength(200);
  });

  it('tells the owner when a local server is not running', async () => {
    const { registry, store } = setup();
    const ollama = store.create({
      presetId: 'lmstudio',
      name: 'LM Studio',
      baseUrl: 'http://localhost:1234/v1',
      key: { kind: 'none' },
    });
    const refused = new ModelProviderRegistry(store, {
      env: config(),
      processEnv: {},
      fetch: async () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ECONNREFUSED' },
        });
      },
    });
    expect(await refused.test(ollama.id)).toMatchObject({
      ok: false,
      error: 'Could not connect to localhost:1234. Is LM Studio running?',
    });
    expect(registry.get(ollama.id)?.lastError).toBe(
      'Could not connect to localhost:1234. Is LM Studio running?',
    );
  });

  it('tracks the .env provider status in memory and rejects unknown ids', async () => {
    const { registry } = setup();
    expect((await registry.test('env')).ok).toBe(true);
    expect(registry.get('env')?.lastTestedAt).toEqual(expect.any(Number));
    await expect(registry.test('nope')).rejects.toMatchObject({
      code: 'no-provider',
    });
  });

  it('reports a missing key without any request', async () => {
    const { registry, addGroq, fake } = setup();
    const groq = addGroq({ key: { kind: 'env', envName: 'UNSET_KEY_NAME' } });
    expect(await registry.test(groq.id)).toMatchObject({
      ok: false,
      error: 'The provider has no API key.',
    });
    expect(fake.requests).toHaveLength(0);
  });
});

describe('secrets and redact', () => {
  it('cover stored, env-referenced and .env keys with Bearer variants, longest first', () => {
    const { registry, addGroq, store } = setup({
      processEnv: { MISTRAL_API_KEY: 'mistral-env-key-998877', SHORT: 'abc' },
    });
    addGroq();
    store.create({
      presetId: 'mistral',
      name: 'Mistral',
      baseUrl: 'https://api.mistral.ai/v1',
      key: { kind: 'env', envName: 'MISTRAL_API_KEY' },
    });
    store.create({
      presetId: 'custom',
      name: 'Short',
      baseUrl: 'https://x.test/v1',
      key: { kind: 'stored', value: 'short' },
    });
    const secrets = registry.secrets();
    expect(secrets).toEqual(
      expect.arrayContaining([
        ENV_KEY,
        `Bearer ${ENV_KEY}`,
        GROQ_KEY,
        `Bearer ${GROQ_KEY}`,
        'mistral-env-key-998877',
        'Bearer mistral-env-key-998877',
      ]),
    );
    expect(secrets).not.toContain('short');
    expect(secrets.map((secret) => secret.length)).toEqual(
      [...secrets.map((secret) => secret.length)].sort((a, b) => b - a),
    );
    const text = `a ${ENV_KEY} b Bearer ${GROQ_KEY} c mistral-env-key-998877 d short`;
    const redacted = registry.redact(text);
    expect(redacted).toBe('a [redacted] b [redacted] c [redacted] d short');
    expect(registry.redact('nothing here')).toBe('nothing here');
  });

  it('forgets a key once its provider is deleted', () => {
    const { registry, addGroq, store } = setup();
    const groq = addGroq();
    expect(registry.secrets()).toContain(GROQ_KEY);
    store.delete(groq.id);
    expect(registry.secrets()).not.toContain(GROQ_KEY);
  });
});

describe('presets', () => {
  it('defines every provider with a documented endpoint', () => {
    expect(modelPresets.map((preset) => preset.id)).toEqual([
      'openai',
      'anthropic',
      'gemini',
      'openrouter',
      'groq',
      'mistral',
      'deepseek',
      'xai',
      'together',
      'fireworks',
      'cerebras',
      'ollama',
      'lmstudio',
      'custom',
    ]);
    for (const preset of modelPresets) {
      expect(preset.description.length).toBeGreaterThan(5);
      expect(preset.docsUrl).toMatch(/^https:\/\//);
      if (preset.id !== 'custom') {
        expect(preset.baseUrl).toBeTruthy();
        expect(
          checkProviderBaseUrl(preset, preset.baseUrl!, { allowLan: false }),
        ).toBeUndefined();
      }
      if (!preset.local && preset.id !== 'custom')
        expect(preset.keysUrl).toMatch(/^https:\/\//);
      expect(preset.models.path.startsWith('/')).toBe(true);
    }
    const byId = Object.fromEntries(
      modelPresets.map((preset) => [preset.id, preset]),
    );
    expect(byId.deepseek?.baseUrl).toBe('https://api.deepseek.com');
    expect(byId.ollama).toMatchObject({
      local: true,
      keyOptional: true,
      dropFields: ['tool_choice'],
    });
    expect(byId.lmstudio).toMatchObject({ local: true, keyOptional: true });
    expect(byId.anthropic?.models).toMatchObject({
      auth: 'x-api-key',
      headers: { 'anthropic-version': '2023-06-01' },
    });
    expect(byId.together?.models.shape).toBe('array');
    expect(byId.gemini?.models.shape).toBe('gemini');
    expect(
      modelPresets
        .filter((preset) => preset.maxTokensKey === 'max_completion_tokens')
        .map((preset) => preset.id),
    ).toEqual(['openai', 'openrouter', 'groq', 'cerebras']);
  });
});

function catchError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}
