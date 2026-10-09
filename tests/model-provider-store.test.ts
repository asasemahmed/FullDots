import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { seal } from '../src/server/connector-crypto.js';
import {
  KEY_UNREADABLE_ERROR,
  LAST_ERROR_MAX,
  ModelProviderStore,
} from '../src/server/model-provider-store.js';

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function fixture(key = randomBytes(32)) {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  let clock = 1_000;
  const store = new ModelProviderStore(db, key, { now: () => clock });
  return {
    db,
    key,
    store,
    tick: (to: number) => {
      clock = to;
    },
  };
}

const KEY = 'sk-test-0123456789abcdef-WXYZ';
const row = (db: DatabaseSync, id: string) =>
  db.prepare('SELECT * FROM model_providers WHERE id=?').get(id) as Record<
    string,
    unknown
  >;

it('round-trips a sealed key and exposes only its last four characters', () => {
  const { db, store } = fixture();
  const created = store.create({
    presetId: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    key: { kind: 'stored', value: `  ${KEY}  ` },
  });
  expect(created).toMatchObject({
    presetId: 'groq',
    name: 'Groq',
    enabled: true,
    lastTestedAt: null,
    lastError: null,
    key: { kind: 'stored', set: true, last4: 'WXYZ' },
  });
  expect(store.readKey(created.id)).toBe(KEY);
  // Ciphertext at rest, and no plaintext anywhere in the record or the row.
  const stored = row(db, created.id);
  expect(String(stored.keySealed)).toMatch(/^v1\./);
  expect(JSON.stringify(stored)).not.toContain(KEY);
  expect(JSON.stringify(created)).not.toContain(KEY);
  expect(store.list().map((provider) => provider.id)).toEqual([created.id]);
  expect(store.get(created.id)).toEqual(created);
  expect(store.get('missing')).toBeUndefined();
});

it('binds the ciphertext to its provider id and to the connector key', () => {
  const { db, key, store } = fixture();
  const a = store.create({
    presetId: 'openai',
    name: 'A',
    baseUrl: 'https://api.openai.com/v1',
    key: { kind: 'stored', value: KEY },
  });
  const b = store.create({
    presetId: 'openai',
    name: 'B',
    baseUrl: 'https://api.openai.com/v1',
    key: { kind: 'stored', value: 'another-key-value-1234' },
  });
  // Moving A's ciphertext to B's row fails the AAD check.
  db.prepare('UPDATE model_providers SET keySealed=? WHERE id=?').run(
    String(row(db, a.id).keySealed),
    b.id,
  );
  expect(store.readKey(b.id)).toBeUndefined();
  expect(store.get(b.id)?.key.set).toBe(false);
  // A different connector key cannot read it either.
  const other = new ModelProviderStore(db, randomBytes(32));
  expect(other.readKey(a.id)).toBeUndefined();
  expect(new ModelProviderStore(db, key).readKey(a.id)).toBe(KEY);
});

it('reports a tampered key as not set with a readable error', () => {
  const { db, store } = fixture();
  const { id } = store.create({
    presetId: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    key: { kind: 'stored', value: KEY },
  });
  const sealed = String(row(db, id).keySealed);
  const tampered = `${sealed.slice(0, -2)}${sealed.endsWith('AA') ? 'BB' : 'AA'}`;
  db.prepare('UPDATE model_providers SET keySealed=? WHERE id=?').run(
    tampered,
    id,
  );
  const record = store.get(id)!;
  expect(store.readKey(id)).toBeUndefined();
  expect(record.key.set).toBe(false);
  expect(record.key.last4).toBeUndefined();
  expect(record.lastError).toBe(KEY_UNREADABLE_ERROR);
  // Garbage in the column is handled the same way.
  db.prepare('UPDATE model_providers SET keySealed=? WHERE id=?').run(
    'nope',
    id,
  );
  expect(store.get(id)?.key.set).toBe(false);
  // Entering the key again repairs the row.
  store.update(id, { key: { kind: 'stored', value: KEY } });
  expect(store.get(id)).toMatchObject({ key: { set: true }, lastError: null });
});

it('supports env references and keyless providers without storing a secret', () => {
  const { db, store } = fixture();
  const env = store.create({
    presetId: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    key: { kind: 'env', envName: 'MISTRAL_API_KEY' },
  });
  expect(env.key).toEqual({
    kind: 'env',
    set: false,
    envName: 'MISTRAL_API_KEY',
  });
  expect(row(db, env.id).keySealed).toBeNull();
  expect(store.readKey(env.id)).toBeUndefined();
  const none = store.create({
    presetId: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    key: { kind: 'none' },
  });
  expect(none.key).toEqual({ kind: 'none', set: false });
  expect(() =>
    store.create({
      presetId: 'custom',
      name: 'Bad',
      baseUrl: 'https://x.test/v1',
      key: { kind: 'env', envName: 'lower-case' },
    }),
  ).toThrow('Invalid environment variable name');
  expect(() =>
    store.create({
      presetId: 'custom',
      name: 'Empty',
      baseUrl: 'https://x.test/v1',
      key: { kind: 'stored', value: '   ' },
    }),
  ).toThrow();
  expect(store.list()).toHaveLength(2);
});

it('replaces and clears keys, deleting the ciphertext when no key is stored', () => {
  const { db, store } = fixture();
  const { id } = store.create({
    presetId: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    key: { kind: 'stored', value: KEY },
  });
  store.setStatus(id, { lastTestedAt: 5, lastError: 'old' });
  store.update(id, { key: { kind: 'stored', value: 'second-key-value-9876' } });
  expect(store.readKey(id)).toBe('second-key-value-9876');
  expect(store.get(id)).toMatchObject({
    key: { last4: '9876' },
    lastTestedAt: null,
    lastError: null,
  });
  store.update(id, { key: { kind: 'env', envName: 'OPENAI_API_KEY' } });
  expect(row(db, id)).toMatchObject({
    keyKind: 'env',
    keySealed: null,
    keyLast4: null,
    keyEnvName: 'OPENAI_API_KEY',
  });
  store.update(id, { key: { kind: 'none' } });
  expect(store.get(id)?.key).toEqual({ kind: 'none', set: false });
  expect(store.update('missing', { name: 'x' })).toBeUndefined();
});

it('updates fields, keeps updatedAt strictly increasing and checks names case-insensitively', () => {
  const { store, tick } = fixture();
  const { id, createdAt, updatedAt } = store.create({
    presetId: 'custom',
    name: 'My Server',
    baseUrl: 'https://llm.example.test/v1',
    key: { kind: 'none' },
    extra: { anthropicWorkspaceId: ' ws_1 ' },
  });
  expect(createdAt).toBe(1_000);
  expect(updatedAt).toBe(1_000);
  expect(store.get(id)?.extra).toEqual({ anthropicWorkspaceId: 'ws_1' });
  const first = store.update(id, { name: 'Renamed', enabled: false })!;
  const second = store.update(id, {
    baseUrl: 'https://other.example.test/v1',
  })!;
  expect(first).toMatchObject({ name: 'Renamed', enabled: false });
  expect(first.updatedAt).toBeGreaterThan(updatedAt);
  expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
  expect(second.baseUrl).toBe('https://other.example.test/v1');
  tick(9_000);
  expect(store.update(id, { enabled: true })?.updatedAt).toBe(9_000);
  expect(store.nameTaken('renamed')).toBe(true);
  expect(store.nameTaken('renamed', id)).toBe(false);
  expect(store.nameTaken('Other')).toBe(false);
  expect(
    store.update(id, { extra: { anthropicWorkspaceId: '' } })?.extra,
  ).toEqual({});
});

it('records test status capped at 200 characters without touching updatedAt', () => {
  const { store } = fixture();
  const created = store.create({
    presetId: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    key: { kind: 'stored', value: KEY },
  });
  store.setStatus(created.id, { lastTestedAt: 77, lastError: 'x'.repeat(500) });
  const after = store.get(created.id)!;
  expect(after.lastTestedAt).toBe(77);
  expect(after.lastError).toHaveLength(LAST_ERROR_MAX);
  expect(after.updatedAt).toBe(created.updatedAt);
  store.setStatus(created.id, { lastTestedAt: 88, lastError: null });
  expect(store.get(created.id)).toMatchObject({
    lastTestedAt: 88,
    lastError: null,
  });
});

it('stores the default model in model_settings and ignores corrupt values', () => {
  const { db, store } = fixture();
  expect(store.getDefaultModel()).toBeUndefined();
  store.setDefaultModel({ providerId: 'p1', model: 'accounts/x/models/y' });
  expect(store.getDefaultModel()).toEqual({
    providerId: 'p1',
    model: 'accounts/x/models/y',
  });
  store.setDefaultModel({ providerId: 'p2', model: 'm' });
  expect(store.getDefaultModel()).toEqual({ providerId: 'p2', model: 'm' });
  db.prepare(
    "UPDATE model_settings SET value='{bad' WHERE key='defaultModel'",
  ).run();
  expect(store.getDefaultModel()).toBeUndefined();
  db.prepare(
    `UPDATE model_settings SET value='{"providerId":"p","model":""}' WHERE key='defaultModel'`,
  ).run();
  expect(store.getDefaultModel()).toBeUndefined();
  store.setDefaultModel(undefined);
  expect(db.prepare('SELECT COUNT(*) AS n FROM model_settings').get()).toEqual({
    n: 0,
  });
});

it('deletes a provider with its ciphertext', () => {
  const { db, store } = fixture();
  const { id } = store.create({
    presetId: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    key: { kind: 'stored', value: KEY },
  });
  expect(store.delete(id)).toBe(true);
  expect(store.delete(id)).toBe(false);
  expect(store.get(id)).toBeUndefined();
  expect(store.readKey(id)).toBeUndefined();
  expect(db.prepare('SELECT COUNT(*) AS n FROM model_providers').get()).toEqual(
    {
      n: 0,
    },
  );
});

it('creates its tables on construction and reopens existing data', () => {
  const { db, key, store } = fixture();
  const { id } = store.create({
    presetId: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    key: { kind: 'stored', value: KEY },
  });
  const again = new ModelProviderStore(db, key);
  expect(again.readKey(id)).toBe(KEY);
  // A blob sealed for another id never opens under this one.
  const forged = seal(key, KEY, 'someone-else:apiKey');
  db.prepare('UPDATE model_providers SET keySealed=? WHERE id=?').run(
    forged,
    id,
  );
  expect(again.readKey(id)).toBeUndefined();
});
