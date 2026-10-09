import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import {
  modelProviderRoutes,
  TEST_INTERVAL_MS,
  type ModelProviderRoutesDeps,
} from '../src/server/model-provider-routes.js';
import { ModelProviderStore } from '../src/server/model-provider-store.js';
import {
  ModelProviderError,
  ModelProviderRegistry,
} from '../src/server/model-providers.js';
import type { ModelProviderView } from '../src/shared/model-presets.js';
import { modelPresets } from '../src/shared/model-presets.js';
import { createFakeProvider } from './fixtures/fake-provider.js';

const PLANTED = 'planted-provider-key-abcdef123456';
const ENV_KEY = 'planted-dotenv-key-0987654321zyx';
const NAMED_ENV_KEY = 'planted-named-env-key-5566778899';
const FAKE_BASE = 'https://fake.example.test/v1';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

interface Options {
  keys?: string[];
  envConfigured?: boolean;
  wrapRegistry?: (
    registry: ModelProviderRegistry,
  ) => ModelProviderRoutesDeps['registry'];
}

function setup(options: Options = {}) {
  const db = new DatabaseSync(':memory:');
  let clock = 1_000_000;
  const store = new ModelProviderStore(db, randomBytes(32), {
    now: () => clock,
  });
  const fake = createFakeProvider({ keys: options.keys ?? [PLANTED] });
  const registry = new ModelProviderRegistry(store, {
    env: {
      baseUrl: 'https://env.example.test/v1',
      apiKey: options.envConfigured === false ? undefined : ENV_KEY,
      model: 'env-model',
      voiceName: 'marin',
    },
    processEnv: { NAMED_API_KEY: NAMED_ENV_KEY },
    fetch: fake.fetch,
    now: () => clock,
  });
  const inUse = new Map<string, string[]>();
  const app = new Hono().route(
    '/api',
    modelProviderRoutes({
      registry: options.wrapRegistry?.(registry) ?? registry,
      store,
      usage: (id) => inUse.get(id) ?? [],
      now: () => clock,
    }),
  );
  cleanups.push(() => db.close());
  // Every response of this file passes through here: none may carry a key or its ciphertext.
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body:
        body === undefined
          ? method === 'GET' || method === 'DELETE'
            ? undefined
            : '{}'
          : typeof body === 'string'
            ? body
            : JSON.stringify(body),
    });
    const text = await response.text();
    for (const secret of [PLANTED, ENV_KEY, NAMED_ENV_KEY, 'keySealed'])
      expect(text).not.toContain(secret);
    return {
      status: response.status,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: (text ? JSON.parse(text) : undefined) as any,
      text,
    };
  };
  const create = async (body: Record<string, unknown> = {}) => {
    const result = await call('POST', '/model-providers', {
      presetId: 'openai',
      baseUrl: FAKE_BASE,
      key: { kind: 'stored', value: PLANTED },
      ...body,
    });
    expect(result.status).toBe(201);
    return result.body as ModelProviderView;
  };
  return {
    app,
    call,
    create,
    db,
    store,
    registry,
    fake,
    inUse,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe('GET /api/model-providers', () => {
  it('lists the .env provider, every preset and the effective default', async () => {
    const { call } = setup();
    const { status, body } = await call('GET', '/model-providers');
    expect(status).toBe(200);
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]).toMatchObject({
      id: 'env',
      builtIn: true,
      key: { kind: 'env', envName: 'OPENAI_API_KEY', set: true },
    });
    expect(body.presets.map((p: { id: string }) => p.id)).toEqual(
      modelPresets.map((p) => p.id),
    );
    expect(body.defaultModel).toEqual({
      providerId: 'env',
      model: 'env-model',
    });
  });

  it('has no providers and no default when .env has no key', async () => {
    const { call } = setup({ envConfigured: false });
    const { body } = await call('GET', '/model-providers');
    expect(body.providers).toEqual([]);
    expect(body.defaultModel).toBeNull();
  });

  it('shows a created provider with a masked key', async () => {
    const { call, create } = setup();
    const created = await create({ name: 'Mine' });
    const { body } = await call('GET', '/model-providers');
    expect(body.providers.map((p: ModelProviderView) => p.id)).toEqual([
      'env',
      created.id,
    ]);
  });
});

describe('POST /api/model-providers', () => {
  it('creates a provider with a stored key and shows only the last four characters', async () => {
    const { call } = setup();
    const { status, body } = await call('POST', '/model-providers', {
      presetId: 'openai',
      key: { kind: 'stored', value: `  ${PLANTED}  ` },
    });
    expect(status).toBe(201);
    expect(body).toMatchObject({
      presetId: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      enabled: true,
      builtIn: false,
      key: { kind: 'stored', set: true, last4: PLANTED.slice(-4) },
    });
    expect(body.key.value).toBeUndefined();
    expect(Object.keys(body.key).sort()).toEqual(['kind', 'last4', 'set']);
  });

  it('creates with an env reference, which stores only the name', async () => {
    const { call, create } = setup();
    const view = await create({
      presetId: 'groq',
      baseUrl: undefined,
      key: { kind: 'env', envName: 'NAMED_API_KEY' },
    });
    expect(view.key).toEqual({
      kind: 'env',
      set: true,
      envName: 'NAMED_API_KEY',
    });
    const missing = await create({
      presetId: 'mistral',
      baseUrl: undefined,
      key: { kind: 'env', envName: 'NOT_SET_ANYWHERE' },
    });
    expect(missing.key).toMatchObject({ kind: 'env', set: false });
    const list = await call('GET', '/model-providers');
    expect(list.status).toBe(200);
  });

  it('allows a keyless local preset on loopback http and defaults the key to none', async () => {
    const { create } = setup();
    const view = await create({
      presetId: 'ollama',
      baseUrl: undefined,
      key: undefined,
    });
    expect(view).toMatchObject({
      presetId: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      key: { kind: 'none', set: false },
    });
    const explicit = await create({
      presetId: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1/',
      key: { kind: 'none' },
    });
    expect(explicit.baseUrl).toBe('http://127.0.0.1:1234/v1');
  });

  it('requires a base URL for the custom preset and accepts one', async () => {
    const { call, create } = setup();
    const missing = await call('POST', '/model-providers', {
      presetId: 'custom',
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/base URL/i);
    const view = await create({
      presetId: 'custom',
      name: 'My gateway',
      baseUrl: 'https://llm.example.test/openai/v1',
    });
    expect(view).toMatchObject({
      presetId: 'custom',
      name: 'My gateway',
      baseUrl: 'https://llm.example.test/openai/v1',
    });
    const local = await create({
      presetId: 'custom',
      name: 'Local custom',
      baseUrl: 'http://localhost:8080/v1',
      key: { kind: 'none' },
    });
    expect(local.baseUrl).toBe('http://localhost:8080/v1');
  });

  it('rejects an unknown preset', async () => {
    const { call } = setup();
    const { status, body } = await call('POST', '/model-providers', {
      presetId: 'perplexity',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/preset/i);
  });

  it('keeps provider names unique, ignoring case', async () => {
    const { call, create } = setup();
    await create({ name: 'Work' });
    for (const name of ['work', 'WORK', ' Work ', 'default (from .env)']) {
      const { status, body } = await call('POST', '/model-providers', {
        presetId: 'openai',
        name,
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/already exists/);
    }
  });

  it('accepts the Anthropic workspace id only where the preset has one', async () => {
    const { call, create, store } = setup();
    const view = await create({
      presetId: 'anthropic',
      baseUrl: undefined,
      extra: { anthropicWorkspaceId: 'wrkspc_123' },
    });
    expect(store.get(view.id)?.extra).toEqual({
      anthropicWorkspaceId: 'wrkspc_123',
    });
    const other = await call('POST', '/model-providers', {
      presetId: 'openai',
      extra: { anthropicWorkspaceId: 'wrkspc_123' },
    });
    expect(other.status).toBe(400);
    expect(other.body.error).toMatch(/anthropicWorkspaceId/);
  });

  describe('validation', () => {
    const rejects = async (body: Record<string, unknown>, message?: RegExp) => {
      const { call, store } = setup();
      const { status, body: result } = await call('POST', '/model-providers', {
        presetId: 'custom',
        baseUrl: 'https://llm.example.test/v1',
        ...body,
      });
      expect(status).toBe(400);
      expect(typeof result.error).toBe('string');
      if (message) expect(result.error).toMatch(message);
      expect(store.list()).toEqual([]);
    };

    it('rejects an ftp:// base URL', () =>
      rejects({ baseUrl: 'ftp://llm.example.test/v1' }, /https/));
    it('rejects plain http for a remote host', () =>
      rejects({ baseUrl: 'http://example.com/v1' }, /https/));
    it('rejects plain http for a hosted preset', async () => {
      const { call } = setup();
      const { status } = await call('POST', '/model-providers', {
        presetId: 'openai',
        baseUrl: 'http://example.com/v1',
      });
      expect(status).toBe(400);
    });
    it('rejects private network literals', async () => {
      await rejects({ baseUrl: 'http://10.0.0.1/v1' });
      await rejects({ baseUrl: 'https://10.0.0.1/v1' }, /private/i);
      await rejects({ baseUrl: 'https://192.168.1.20/v1' }, /private/i);
      await rejects({ baseUrl: 'https://169.254.169.254/v1' }, /private/i);
      await rejects({ baseUrl: 'https://[fd00::1]/v1' }, /private/i);
    });
    it('rejects credentials, a query string and a fragment', async () => {
      await rejects(
        { baseUrl: 'https://user:pass@llm.example.test/v1' },
        /user name or password/,
      );
      await rejects(
        { baseUrl: 'https://llm.example.test/v1?key=abc' },
        /query/,
      );
      await rejects({ baseUrl: 'https://llm.example.test/v1#frag' }, /query/);
    });
    it('rejects a base URL that is not a URL or is over 500 characters', async () => {
      await rejects({ baseUrl: 'not a url' });
      await rejects({
        baseUrl: `https://llm.example.test/${'a'.repeat(500)}`,
      });
    });
    it('rejects a bad environment variable name', async () => {
      await rejects({ key: { kind: 'env', envName: 'lower_case' } });
      await rejects({ key: { kind: 'env', envName: '1STARTS_WITH_DIGIT' } });
      await rejects({ key: { kind: 'env', envName: 'HAS SPACE' } });
      await rejects({ key: { kind: 'env', envName: `A${'B'.repeat(100)}` } });
      await rejects({ key: { kind: 'env' } });
    });
    it('rejects a key that is too short, too long or contains whitespace', async () => {
      await rejects(
        { key: { kind: 'stored', value: 'short' } },
        /8 characters/,
      );
      await rejects({ key: { kind: 'stored', value: '   short   ' } });
      await rejects({ key: { kind: 'stored', value: 'a'.repeat(4001) } });
      await rejects({ key: { kind: 'stored', value: 'abcd efgh ijkl' } });
      await rejects({ key: { kind: 'stored', value: 'abcdefgh\nijkl' } });
      await rejects({ key: { kind: 'stored' } });
    });
    it('rejects unknown fields, a bad name and an unknown key kind', async () => {
      await rejects({ surprise: true }, /surprise/);
      await rejects({ name: '' });
      await rejects({ name: 'x'.repeat(61) });
      await rejects({ key: { kind: 'carrier-pigeon' } });
      await rejects({ key: { kind: 'none', value: 'abcdefgh1234' } });
      await rejects({ extra: { other: 'x' } });
    });
    it('rejects a body that is not JSON', async () => {
      const { call } = setup();
      const { status, body } = await call('POST', '/model-providers', '{nope');
      expect(status).toBe(400);
      expect(body.error).toMatch(/Invalid request/);
    });
    it('never echoes a rejected key back', async () => {
      const { call } = setup();
      const { text } = await call('POST', '/model-providers', {
        presetId: 'custom',
        baseUrl: 'ftp://llm.example.test',
        key: { kind: 'stored', value: PLANTED },
      });
      expect(text).not.toContain(PLANTED);
    });
  });
});

describe('PATCH /api/model-providers/:id', () => {
  it('renames, disables and re-enables', async () => {
    const { call, create } = setup();
    const { id } = await create();
    const renamed = await call('PATCH', `/model-providers/${id}`, {
      name: 'Renamed',
      enabled: false,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'Renamed', enabled: false });
    const back = await call('PATCH', `/model-providers/${id}`, {
      enabled: true,
    });
    expect(back.body.enabled).toBe(true);
  });

  it('replaces the key, then clears it', async () => {
    const { call, create, store } = setup();
    const { id } = await create();
    const replaced = await call('PATCH', `/model-providers/${id}`, {
      key: { kind: 'stored', value: 'a-brand-new-key-wxyz9876' },
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body.key).toEqual({
      kind: 'stored',
      set: true,
      last4: '9876',
    });
    expect(store.readKey(id)).toBe('a-brand-new-key-wxyz9876');
    const cleared = await call('PATCH', `/model-providers/${id}`, {
      key: { kind: 'none' },
    });
    expect(cleared.body.key).toEqual({ kind: 'none', set: false });
    expect(store.readKey(id)).toBeUndefined();
    const env = await call('PATCH', `/model-providers/${id}`, {
      key: { kind: 'env', envName: 'NAMED_API_KEY' },
    });
    expect(env.body.key).toMatchObject({
      kind: 'env',
      envName: 'NAMED_API_KEY',
    });
  });

  it('changes the base URL under the same rules as create', async () => {
    const { call, create } = setup();
    const { id } = await create({ presetId: 'custom', name: 'Gateway' });
    const ok = await call('PATCH', `/model-providers/${id}`, {
      baseUrl: 'https://other.example.test/v2/',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.baseUrl).toBe('https://other.example.test/v2');
    for (const baseUrl of [
      'ftp://x.example.test',
      'http://example.com',
      'https://10.1.2.3/v1',
      'https://u:p@x.example.test',
      'https://x.example.test/?a=1',
    ]) {
      const bad = await call('PATCH', `/model-providers/${id}`, { baseUrl });
      expect(bad.status).toBe(400);
    }
    const unchanged = await call('GET', '/model-providers');
    expect(
      unchanged.body.providers.find((p: ModelProviderView) => p.id === id)
        .baseUrl,
    ).toBe('https://other.example.test/v2');
  });

  it('validates the key, name and unknown fields', async () => {
    const { call, create } = setup();
    const a = await create({ name: 'Alpha' });
    await create({ name: 'Beta' });
    const path = `/model-providers/${a.id}`;
    expect((await call('PATCH', path, { name: 'beta' })).status).toBe(400);
    expect((await call('PATCH', path, { name: 'ALPHA' })).status).toBe(200);
    expect(
      (await call('PATCH', path, { key: { kind: 'stored', value: 'tiny' } }))
        .status,
    ).toBe(400);
    expect(
      (await call('PATCH', path, { key: { kind: 'env', envName: 'bad' } }))
        .status,
    ).toBe(400);
    expect((await call('PATCH', path, { presetId: 'groq' })).status).toBe(400);
    expect((await call('PATCH', path, { enabled: 'yes' })).status).toBe(400);
    expect(
      (await call('PATCH', path, { extra: { anthropicWorkspaceId: 'w' } }))
        .status,
    ).toBe(400);
  });

  it('returns the view for an empty patch', async () => {
    const { call, create } = setup();
    const created = await create();
    const { status, body } = await call(
      'PATCH',
      `/model-providers/${created.id}`,
      {},
    );
    expect(status).toBe(200);
    expect(body).toEqual(created);
  });

  it('404s for an unknown provider and 400s for the .env one', async () => {
    const { call } = setup();
    expect(
      (await call('PATCH', '/model-providers/nope', { enabled: false })).status,
    ).toBe(404);
    const env = await call('PATCH', '/model-providers/env', {
      enabled: false,
    });
    expect(env.status).toBe(400);
    expect(env.body.error).toMatch(/\.env/);
  });
});

describe('DELETE /api/model-providers/:id', () => {
  it('deletes an unused provider with 204 and its ciphertext', async () => {
    const { call, create, db } = setup();
    const { id } = await create();
    const deleted = await call('DELETE', `/model-providers/${id}`);
    expect(deleted.status).toBe(204);
    expect(deleted.text).toBe('');
    const list = await call('GET', '/model-providers');
    expect(list.body.providers.map((p: ModelProviderView) => p.id)).toEqual([
      'env',
    ]);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM model_providers').get(),
    ).toEqual({ n: 0 });
    expect((await call('DELETE', `/model-providers/${id}`)).status).toBe(404);
  });

  it('answers 409 with the Dots (and the default model) that still use it', async () => {
    const { call, create, inUse } = setup();
    const { id } = await create({ name: 'Groq' });
    inUse.set(id, ['Scout', 'Writer', 'default model']);
    const blocked = await call('DELETE', `/model-providers/${id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.dots).toEqual(['Scout', 'Writer', 'default model']);
    expect(blocked.body.error).toContain('Scout');
    expect(blocked.body.error).toContain('Groq');
    const still = await call('GET', '/model-providers');
    expect(still.body.providers).toHaveLength(2);
    inUse.delete(id);
    expect((await call('DELETE', `/model-providers/${id}`)).status).toBe(204);
  });

  it('400s for the .env provider, even when it is in use', async () => {
    const { call, inUse } = setup();
    inUse.set('env', ['Scout']);
    const { status, body } = await call('DELETE', '/model-providers/env');
    expect(status).toBe(400);
    expect(body.error).toMatch(/\.env/);
  });
});

describe('POST /api/model-providers/:id/test', () => {
  it('lists models, writes lastTestedAt and clears lastError', async () => {
    const { call, create, fake, tick } = setup();
    const created = await create();
    expect(created.lastTestedAt).toBeNull();
    const { status, body } = await call(
      'POST',
      `/model-providers/${created.id}/test`,
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, count: 2 });
    expect(typeof body.latencyMs).toBe('number');
    expect(fake.listings()).toHaveLength(1);
    expect(fake.listings()[0].headers.authorization).toBe(`Bearer ${PLANTED}`);
    const list = await call('GET', '/model-providers');
    const view = list.body.providers.find(
      (p: ModelProviderView) => p.id === created.id,
    );
    expect(view.lastTestedAt).toBeGreaterThan(0);
    expect(view.lastError).toBeNull();
    tick(TEST_INTERVAL_MS);
  });

  it('reports a rejected key without echoing it, and records the error', async () => {
    const { call, create, fake } = setup({ keys: ['some-other-key-123456'] });
    fake.state.echoKeyInErrors = true;
    const created = await create();
    const { status, body, text } = await call(
      'POST',
      `/model-providers/${created.id}/test`,
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/401|Invalid API key/);
    expect(text).not.toContain(PLANTED);
    const list = await call('GET', '/model-providers');
    const view = list.body.providers.find(
      (p: ModelProviderView) => p.id === created.id,
    );
    expect(view.lastTestedAt).toBeGreaterThan(0);
    expect(view.lastError).toMatch(/401|Invalid API key/);
  });

  it('allows one test per provider every two seconds', async () => {
    const { call, create, tick } = setup();
    const a = await create({ name: 'A' });
    const b = await create({ name: 'B' });
    expect((await call('POST', `/model-providers/${a.id}/test`)).status).toBe(
      200,
    );
    const again = await call('POST', `/model-providers/${a.id}/test`);
    expect(again.status).toBe(429);
    expect(again.body.error).toMatch(/Wait/);
    expect((await call('POST', `/model-providers/${b.id}/test`)).status).toBe(
      200,
    );
    tick(TEST_INTERVAL_MS);
    expect((await call('POST', `/model-providers/${a.id}/test`)).status).toBe(
      200,
    );
  });

  it('404s for an unknown provider', async () => {
    const { call } = setup();
    expect((await call('POST', '/model-providers/nope/test')).status).toBe(404);
  });
});

describe('GET /api/model-providers/:id/models', () => {
  it('returns the list, serves it from cache and refetches with ?refresh=1', async () => {
    const { call, create, fake } = setup();
    const { id } = await create();
    const first = await call('GET', `/model-providers/${id}/models`);
    expect(first.status).toBe(200);
    expect(first.body.models.map((m: { id: string }) => m.id).sort()).toEqual([
      'fake-large',
      'fake-small',
    ]);
    expect(first.body.stale).toBe(false);
    expect(typeof first.body.fetchedAt).toBe('number');
    await call('GET', `/model-providers/${id}/models`);
    expect(fake.listings()).toHaveLength(1);
    fake.state.models = ['fake-small', 'fake-large', 'fake-new'];
    const refreshed = await call(
      'GET',
      `/model-providers/${id}/models?refresh=1`,
    );
    expect(refreshed.body.models).toHaveLength(3);
    expect(fake.listings()).toHaveLength(2);
  });

  it('is stale and empty when the provider is down, with no key in the body', async () => {
    const { call, create, fake } = setup();
    const { id } = await create();
    fake.state.modelsStatus = 500;
    const { status, body } = await call('GET', `/model-providers/${id}/models`);
    expect(status).toBe(200);
    expect(body.models).toEqual([]);
    expect(body.stale).toBe(true);
  });

  it('lists the .env provider too and 404s for an unknown one', async () => {
    const { call } = setup();
    expect((await call('GET', '/model-providers/env/models')).status).toBe(200);
    expect((await call('GET', '/model-providers/nope/models')).status).toBe(
      404,
    );
  });
});

describe('PUT /api/model-providers/default', () => {
  it('round-trips the default model through GET', async () => {
    const { call, create, store } = setup();
    const { id } = await create();
    const put = await call('PUT', '/model-providers/default', {
      providerId: id,
      model: 'accounts/fake/models/big-1:latest',
    });
    expect(put.status).toBe(200);
    expect(put.body.defaultModel).toEqual({
      providerId: id,
      model: 'accounts/fake/models/big-1:latest',
    });
    expect(store.getDefaultModel()).toEqual(put.body.defaultModel);
    const list = await call('GET', '/model-providers');
    expect(list.body.defaultModel).toEqual(put.body.defaultModel);
    const env = await call('PUT', '/model-providers/default', {
      providerId: 'env',
      model: 'env-model',
    });
    expect(env.status).toBe(200);
    expect(store.getDefaultModel()).toEqual({
      providerId: 'env',
      model: 'env-model',
    });
  });

  it('rejects an unknown provider, a missing or odd model id and extra fields', async () => {
    const { call, create, store } = setup();
    const { id } = await create();
    const put = (body: unknown) =>
      call('PUT', '/model-providers/default', body);
    expect((await put({ providerId: 'nope', model: 'm' })).status).toBe(400);
    expect((await put({ providerId: id })).status).toBe(400);
    expect((await put({ providerId: id, model: '' })).status).toBe(400);
    expect((await put({ providerId: id, model: 'has space' })).status).toBe(
      400,
    );
    expect((await put({ providerId: id, model: 'm'.repeat(201) })).status).toBe(
      400,
    );
    expect((await put({ providerId: id, model: 'm', extra: 1 })).status).toBe(
      400,
    );
    expect(store.getDefaultModel()).toBeUndefined();
  });

  it('is not shadowed by the :id routes', async () => {
    const { call } = setup();
    expect(
      (await call('PATCH', '/model-providers/default', { enabled: true }))
        .status,
    ).toBe(404);
  });
});

describe('error handling', () => {
  it('answers 503 with a generic message and no secret when something unexpected fails', async () => {
    const { call, create } = setup({
      wrapRegistry: (registry) => ({
        list: () => registry.list(),
        get: (id) => registry.get(id),
        checkBaseUrl: (preset, url) => registry.checkBaseUrl(preset, url),
        defaultModel: () => registry.defaultModel(),
        setDefaultModel: (value) => registry.setDefaultModel(value),
        redact: (text) => registry.redact(text),
        models: () => Promise.reject(new Error(`boom ${PLANTED}`)),
        test: () => Promise.reject(new Error(`boom ${ENV_KEY}`)),
      }),
    });
    const { id } = await create();
    const models = await call('GET', `/model-providers/${id}/models`);
    expect(models.status).toBe(503);
    expect(models.body.error).not.toContain('boom');
    const test = await call('POST', `/model-providers/${id}/test`);
    expect(test.status).toBe(503);
  });

  it('turns a registry ModelProviderError into a 400 with its message', async () => {
    const { call, create } = setup({
      wrapRegistry: (registry) => ({
        list: () => registry.list(),
        get: (id) => registry.get(id),
        checkBaseUrl: (preset, url) => registry.checkBaseUrl(preset, url),
        defaultModel: () => registry.defaultModel(),
        redact: (text) => registry.redact(text),
        models: (id, options) => registry.models(id, options),
        test: (id) => registry.test(id),
        setDefaultModel: () => {
          throw new ModelProviderError('No model was given.', 'no-model');
        },
      }),
    });
    const { id } = await create();
    const { status, body } = await call('PUT', '/model-providers/default', {
      providerId: id,
      model: 'x',
    });
    expect(status).toBe(400);
    expect(body.error).toBe('No model was given.');
  });
});
