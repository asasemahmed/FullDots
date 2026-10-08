import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { ConnectorStore } from '../src/server/connector-store.js';
import type { ConnectorConfig } from '../src/shared/types.js';

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function fixture() {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  return { db, store: new ConnectorStore(db) };
}
const github: ConnectorConfig = {
  name: 'github',
  transport: 'http',
  url: 'https://api.githubcopilot.com/mcp/',
  headers: {
    Authorization: { env: 'GITHUB_TOKEN' },
    'Notion-Version': { literal: '2022-06-28' },
  },
  callTimeoutMs: 45_000,
  presetId: 'github',
};

it('creates both tables and starts empty', () => {
  const { db, store } = fixture();
  expect(store.list()).toEqual([]);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row) => row.name);
  expect(tables).toEqual(
    expect.arrayContaining(['connectors', 'dot_connectors']),
  );
  expect(() => new ConnectorStore(db)).not.toThrow();
});

it('round-trips JSON fields and applies defaults', () => {
  const { store } = fixture();
  const created = store.create(github);
  expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(created).toMatchObject({
    name: 'github',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    command: null,
    args: [],
    cwd: null,
    headers: github.headers,
    env: {},
    callTimeoutMs: 45_000,
    enabled: true,
    presetId: 'github',
  });
  expect(created.createdAt).toBe(created.updatedAt);
  const stdio = store.create({
    name: 'files',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'server', '/tmp/dir'],
    cwd: '/tmp',
    env: { HOME_DIR: { literal: '/tmp' } },
    enabled: false,
  });
  expect(stdio).toMatchObject({
    url: null,
    command: 'npx',
    args: ['-y', 'server', '/tmp/dir'],
    cwd: '/tmp',
    env: { HOME_DIR: { literal: '/tmp' } },
    callTimeoutMs: 30_000,
    enabled: false,
    presetId: null,
  });
  expect(store.get(created.id)).toEqual(created);
  expect(store.list().map((c) => c.name)).toEqual(['github', 'files']);
  expect(store.get('missing')).toBeUndefined();
});

it('rejects a duplicate name', () => {
  const { store } = fixture();
  store.create(github);
  expect(() => store.create(github)).toThrow(
    'A connector with that name exists.',
  );
  const other = store.create({ ...github, name: 'other' });
  expect(() => store.update(other.id, { name: 'github' })).toThrow(
    'A connector with that name exists.',
  );
  expect(store.list()).toHaveLength(2);
});

it('merges a partial update and bumps updatedAt', () => {
  const { store } = fixture();
  const created = store.create(github);
  const updated = store.update(created.id, {
    enabled: false,
    callTimeoutMs: 5000,
    args: ['a'],
  });
  expect(updated).toMatchObject({
    name: 'github',
    url: github.url,
    headers: github.headers,
    enabled: false,
    callTimeoutMs: 5000,
    args: ['a'],
    createdAt: created.createdAt,
  });
  expect(updated.updatedAt).toBeGreaterThan(created.updatedAt);
  expect(store.update(created.id, { presetId: null }).presetId).toBeNull();
  expect(store.update(created.id, { name: undefined }).name).toBe('github');
  expect(() => store.update('missing', { enabled: true })).toThrow(
    'Connector not found.',
  );
});

it('sets, lists, reads and revokes grants', () => {
  const { store } = fixture();
  const a = store.create(github);
  const b = store.create({ ...github, name: 'notion' });
  expect(store.grants('dot')).toEqual([]);
  expect(store.grant('dot', a.id)).toBeUndefined();
  expect(store.setGrant('dot', b.id, '*')).toEqual({
    dotId: 'dot',
    connectorId: b.id,
    tools: '*',
    overrides: {},
  });
  const written = store.setGrant('dot', a.id, ['create_issue'], {
    create_issue: 'ask',
  });
  expect(written.tools).toEqual(['create_issue']);
  expect(store.grant('dot', a.id)).toEqual(written);
  expect(store.grants('dot').map((g) => g.connectorId)).toEqual(
    [a.id, b.id].sort(),
  );
  const replaced = store.setGrant('dot', a.id, '*');
  expect(replaced).toMatchObject({ tools: '*', overrides: {} });
  expect(store.grants('dot')).toHaveLength(2);
  expect(store.grants('other')).toEqual([]);
  expect(store.revoke('dot', a.id)).toBe(true);
  expect(store.revoke('dot', a.id)).toBe(false);
  expect(store.grant('dot', a.id)).toBeUndefined();
});

it('delete removes the connector and its grants', () => {
  const { store } = fixture();
  const a = store.create(github);
  const b = store.create({ ...github, name: 'notion' });
  store.setGrant('d1', a.id, '*');
  store.setGrant('d2', a.id, ['x']);
  store.setGrant('d1', b.id, '*');
  expect(store.delete(a.id)).toBe(true);
  expect(store.delete(a.id)).toBe(false);
  expect(store.get(a.id)).toBeUndefined();
  expect(store.grants('d1').map((g) => g.connectorId)).toEqual([b.id]);
  expect(store.grants('d2')).toEqual([]);
});

it('grantHash changes on grant, tools, overrides, revoke and enable toggle', () => {
  const { store } = fixture();
  const connector = store.create(github);
  const empty = store.grantHash('dot');
  expect(empty).toMatch(/^[0-9a-f]{64}$/);
  expect(store.grantHash('dot')).toBe(empty);

  store.setGrant('dot', connector.id, '*');
  const granted = store.grantHash('dot');
  expect(granted).not.toBe(empty);
  expect(store.grantHash('dot')).toBe(granted);
  store.setGrant('dot', connector.id, '*');
  expect(store.grantHash('dot')).toBe(granted);

  store.setGrant('dot', connector.id, ['create_issue']);
  const tools = store.grantHash('dot');
  expect(tools).not.toBe(granted);

  store.setGrant('dot', connector.id, ['create_issue'], {
    create_issue: 'deny',
  });
  const overrides = store.grantHash('dot');
  expect(overrides).not.toBe(tools);

  store.update(connector.id, { enabled: false });
  const disabled = store.grantHash('dot');
  expect(disabled).not.toBe(overrides);
  store.update(connector.id, { enabled: true });
  expect(store.grantHash('dot')).toBe(overrides);

  store.update(connector.id, { callTimeoutMs: 9000 });
  expect(store.grantHash('dot')).toBe(overrides);

  store.revoke('dot', connector.id);
  expect(store.grantHash('dot')).toBe(empty);
});

it('grantHash differs between Dots and ignores other Dots', () => {
  const { store } = fixture();
  const connector = store.create(github);
  store.setGrant('a', connector.id, '*');
  store.setGrant('b', connector.id, ['x']);
  const a = store.grantHash('a');
  expect(a).not.toBe(store.grantHash('b'));
  store.setGrant('b', connector.id, ['y']);
  expect(store.grantHash('a')).toBe(a);
});

it('adds the auth column to a database created with the old schema', () => {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  db.exec(`CREATE TABLE connectors(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, transport TEXT NOT NULL,
  url TEXT, command TEXT, args TEXT NOT NULL DEFAULT '[]', cwd TEXT, headers TEXT NOT NULL DEFAULT '{}', env TEXT NOT NULL DEFAULT '{}',
  callTimeoutMs INTEGER NOT NULL DEFAULT 30000, enabled INTEGER NOT NULL DEFAULT 1, presetId TEXT,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
  INSERT INTO connectors(id,name,transport,url,createdAt,updatedAt) VALUES ('old','legacy','http','https://x/',1,1);`);
  const store = new ConnectorStore(db);
  expect(store.get('old')?.auth).toBe('token');
  expect(() => new ConnectorStore(db)).not.toThrow();
  const columns = db
    .prepare('PRAGMA table_info(connectors)')
    .all()
    .filter((field) => field.name === 'auth');
  expect(columns).toHaveLength(1);
  expect(
    store.create({ name: 'new', transport: 'http', url: 'https://y/' }).auth,
  ).toBe('none');
});

it('stores auth, defaults it from headers, and updates it', () => {
  const { store } = fixture();
  expect(store.create(github).auth).toBe('token');
  expect(
    store.create({ name: 'plain', transport: 'http', url: 'https://p/' }).auth,
  ).toBe('none');
  const oauth = store.create({
    name: 'oauthy',
    transport: 'http',
    url: 'https://o/',
    auth: 'oauth',
  });
  expect(oauth.auth).toBe('oauth');
  expect(store.update(oauth.id, { name: 'renamed' }).auth).toBe('oauth');
  expect(store.update(oauth.id, { auth: 'none' }).auth).toBe('none');
  expect(store.get(oauth.id)?.auth).toBe('none');
});

it('creates the connector_auth table and delete removes its row', () => {
  const { db, store } = fixture();
  const created = store.create(github);
  db.prepare(
    'INSERT INTO connector_auth(connectorId,updatedAt) VALUES (?,1)',
  ).run(created.id);
  expect(store.delete(created.id)).toBe(true);
  expect(db.prepare('SELECT * FROM connector_auth').all()).toEqual([]);
});
