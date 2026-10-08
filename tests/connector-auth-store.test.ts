import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import {
  ConnectorAuthStore,
  hashState,
} from '../src/server/connector-auth-store.js';
import {
  loadConnectorKey,
  open,
  seal,
} from '../src/server/connector-crypto.js';
import { ConnectorStore } from '../src/server/connector-store.js';

const dbs: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'connector-key-'));
  dirs.push(dir);
  return dir;
}
function fixture(key = randomBytes(32)) {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  const connectors = new ConnectorStore(db);
  return { db, key, connectors, auth: new ConnectorAuthStore(db, key) };
}
const TOKENS = {
  access_token: 'PLANTED-ACCESS',
  refresh_token: 'PLANTED-REFRESH',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'read write',
};

it('seals and opens a round trip with fresh IVs', () => {
  const key = randomBytes(32);
  const a = seal(key, 'secret value', 'c1:tokens');
  const b = seal(key, 'secret value', 'c1:tokens');
  expect(a).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]*$/);
  expect(a).not.toBe(b);
  expect(a).not.toContain('secret');
  expect(open(key, a, 'c1:tokens')).toBe('secret value');
  expect(open(key, seal(key, '', 'x'), 'x')).toBe('');
});

it('opens to undefined on wrong key, wrong AAD, tampering and junk', () => {
  const key = randomBytes(32);
  const sealed = seal(key, 'secret', 'c1:tokens');
  expect(open(randomBytes(32), sealed, 'c1:tokens')).toBeUndefined();
  expect(open(key, sealed, 'c2:tokens')).toBeUndefined();
  expect(open(key, sealed, 'c1:clientInfo')).toBeUndefined();
  const parts = sealed.split('.');
  parts[3] = Buffer.from('tampered!').toString('base64url');
  expect(open(key, parts.join('.'), 'c1:tokens')).toBeUndefined();
  expect(open(key, sealed.replace('v1.', 'v2.'), 'c1:tokens')).toBeUndefined();
  expect(open(key, 'not a blob', 'c1:tokens')).toBeUndefined();
  expect(open(key, '', 'c1:tokens')).toBeUndefined();
  expect(open(Buffer.alloc(5), sealed, 'c1:tokens')).toBeUndefined();
});

it('creates the key file once with wx and reuses it', () => {
  const dir = tempDir();
  const databasePath = join(dir, 'data', 'app.db');
  const first = loadConnectorKey({ env: {}, databasePath });
  const file = join(dir, 'data', 'connector.key');
  expect(first).toHaveLength(32);
  expect(existsSync(file)).toBe(true);
  if (process.platform !== 'win32')
    expect(statSync(file).mode & 0o777).toBe(0o600);
  const stored = readFileSync(file, 'utf8');
  expect(loadConnectorKey({ env: {}, databasePath }).equals(first)).toBe(true);
  expect(readFileSync(file, 'utf8')).toBe(stored);
});

it('rejects a corrupt key file instead of overwriting it', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'connector.key'), 'short');
  expect(() =>
    loadConnectorKey({ env: {}, databasePath: join(dir, 'app.db') }),
  ).toThrow(/connector\.key/);
  expect(readFileSync(join(dir, 'connector.key'), 'utf8')).toBe('short');
});

it('accepts CONNECTOR_SECRET_KEY as hex or base64 and rejects bad lengths', () => {
  const raw = randomBytes(32);
  const dir = tempDir();
  const databasePath = join(dir, 'app.db');
  for (const value of [raw.toString('hex'), raw.toString('base64')])
    expect(
      loadConnectorKey({ env: { CONNECTOR_SECRET_KEY: value }, databasePath }),
    ).toEqual(raw);
  expect(existsSync(join(dir, 'connector.key'))).toBe(false);
  for (const value of [
    'abcd',
    randomBytes(16).toString('hex'),
    randomBytes(31).toString('base64'),
    randomBytes(33).toString('base64'),
    'z'.repeat(64),
  ])
    expect(() =>
      loadConnectorKey({ env: { CONNECTOR_SECRET_KEY: value }, databasePath }),
    ).toThrow(/CONNECTOR_SECRET_KEY/);
  // a blank variable counts as unset
  expect(
    loadConnectorKey({ env: { CONNECTOR_SECRET_KEY: '  ' }, databasePath }),
  ).toHaveLength(32);
});

it('error messages never contain the configured key', () => {
  const bad = 'q'.repeat(20);
  expect.assertions(2);
  try {
    loadConnectorKey({
      env: { CONNECTOR_SECRET_KEY: bad },
      databasePath: ':memory:',
    });
  } catch (error) {
    expect((error as Error).message).not.toContain(bad);
    expect((error as Error).message).toContain('CONNECTOR_SECRET_KEY');
  }
});

it('uses a random in-process key for :memory: databases', () => {
  const a = loadConnectorKey({ env: {}, databasePath: ':memory:' });
  const b = loadConnectorKey({ env: {}, databasePath: ':memory:' });
  expect(a).toHaveLength(32);
  expect(a.equals(b)).toBe(false);
});

it('stores client info, tokens and verifier sealed, never in plaintext', () => {
  const { db, auth } = fixture();
  auth.saveDiscovery('c1', { issuer: 'https://as.example' });
  auth.saveClientInfo('c1', { client_id: 'id', client_secret: 'PLANTED-CS' });
  auth.saveTokens('c1', TOKENS, 1_000);
  auth.beginPending('c1', 'http://r/cb', 'PLANTED-VERIFIER', 'raw-state');
  const dump = JSON.stringify(db.prepare('SELECT * FROM connector_auth').all());
  for (const secret of [
    'PLANTED-CS',
    'PLANTED-ACCESS',
    'PLANTED-REFRESH',
    'PLANTED-VERIFIER',
    'raw-state',
  ])
    expect(dump).not.toContain(secret);
  expect(dump).toContain('https://as.example');
  const record = auth.get('c1')!;
  expect(record).toMatchObject({
    discovery: { issuer: 'https://as.example' },
    clientInfo: { client_id: 'id', client_secret: 'PLANTED-CS' },
    tokens: TOKENS,
    redirectUrl: 'http://r/cb',
    pending: true,
    authorizedAt: 1_000,
    expiresAt: 1_000 + 3_600_000,
    scope: 'read write',
  });
  expect(JSON.stringify(record)).not.toContain('PLANTED-VERIFIER');
  expect(auth.hasTokens('c1')).toBe(true);
  expect(auth.get('missing')).toBeUndefined();
  expect(auth.hasTokens('missing')).toBe(false);
});

it('keeps authorizedAt across a token refresh', () => {
  const { auth } = fixture();
  auth.saveTokens('c1', TOKENS, 1_000);
  auth.saveTokens('c1', { ...TOKENS, access_token: 'next' }, 5_000);
  expect(auth.get('c1', 5_000)).toMatchObject({
    authorizedAt: 1_000,
    expiresAt: 5_000 + 3_600_000,
  });
});

it('records the redirect URL with the client registration', () => {
  const { auth } = fixture();
  auth.saveClientInfo('c1', { client_id: 'id' }, 'http://r/cb');
  expect(auth.get('c1')!.redirectUrl).toBe('http://r/cb');
  expect(auth.get('c1')!.pending).toBe(false);
});

it('stores the state only as a SHA-256 hash', () => {
  const { db, auth } = fixture();
  auth.beginPending('c1', 'http://r/cb', 'v', 'my-state');
  const row = db
    .prepare('SELECT pendingStateHash FROM connector_auth')
    .get() as { pendingStateHash: string };
  expect(row.pendingStateHash).toBe(hashState('my-state'));
  expect(row.pendingStateHash).toMatch(/^[0-9a-f]{64}$/);
});

it('pending is single use', () => {
  const { auth } = fixture();
  auth.beginPending('c1', 'http://r/cb', 'verifier-1', 'state-1');
  expect(auth.takePending(hashState('nope'))).toBeUndefined();
  expect(auth.get('c1')!.pending).toBe(true);
  expect(auth.takePending(hashState('state-1'))).toEqual({
    connectorId: 'c1',
    verifier: 'verifier-1',
  });
  expect(auth.takePending(hashState('state-1'))).toBeUndefined();
  expect(auth.get('c1')!.pending).toBe(false);
});

it('a new pending flow supersedes the old one', () => {
  const { auth } = fixture();
  auth.beginPending('c1', 'http://r/cb', 'v1', 'state-1');
  auth.beginPending('c1', 'http://r/cb', 'v2', 'state-2');
  expect(auth.takePending(hashState('state-1'))).toBeUndefined();
  expect(auth.takePending(hashState('state-2'))?.verifier).toBe('v2');
});

it('pending expires after the TTL and an expired take consumes it', () => {
  const { auth } = fixture();
  auth.beginPending('c1', 'u', 'v', 's1', 600_000, 1_000);
  expect(auth.get('c1', 600_999)!.pending).toBe(true);
  expect(auth.get('c1', 601_000)!.pending).toBe(false);
  expect(auth.takePending(hashState('s1'), 601_000)).toBeUndefined();
  expect(auth.takePending(hashState('s1'), 1_001)).toBeUndefined();

  auth.beginPending('c1', 'u', 'v', 's2', 600_000, 1_000);
  expect(auth.takePending(hashState('s2'), 600_999)?.connectorId).toBe('c1');

  auth.beginPending('c2', 'u', 'v', 's3', 1_000, 0);
  auth.beginPending('c3', 'u', 'v', 's4', 10_000, 0);
  expect(auth.sweep(5_000)).toBe(1);
  expect(auth.takePending(hashState('s3'), 500)).toBeUndefined();
  expect(auth.takePending(hashState('s4'), 500)?.connectorId).toBe('c3');
});

it('defaults the pending TTL to ten minutes', () => {
  const { auth } = fixture();
  auth.beginPending('c1', 'u', 'v', 's', undefined, 0);
  expect(auth.get('c1', 599_999)!.pending).toBe(true);
  expect(auth.get('c1', 600_000)!.pending).toBe(false);
});

it('clear mirrors the SDK scopes', () => {
  const { auth } = fixture();
  const fill = () => {
    auth.saveDiscovery('c1', { issuer: 'i' });
    auth.saveClientInfo('c1', { client_id: 'id' }, 'http://r/cb');
    auth.saveTokens('c1', TOKENS);
    auth.beginPending('c1', 'http://r/cb', 'v', 's');
  };
  fill();
  auth.clear('c1', 'tokens');
  expect(auth.get('c1')).toMatchObject({
    tokens: undefined,
    authorizedAt: undefined,
    expiresAt: undefined,
    scope: undefined,
    clientInfo: { client_id: 'id' },
    discovery: { issuer: 'i' },
    pending: true,
  });
  expect(auth.hasTokens('c1')).toBe(false);

  fill();
  auth.clear('c1', 'verifier');
  expect(auth.get('c1')).toMatchObject({ pending: false, tokens: TOKENS });
  expect(auth.takePending(hashState('s'))).toBeUndefined();

  fill();
  auth.clear('c1', 'client');
  expect(auth.get('c1')).toMatchObject({
    clientInfo: undefined,
    redirectUrl: undefined,
    tokens: TOKENS,
    discovery: { issuer: 'i' },
  });

  fill();
  auth.clear('c1', 'discovery');
  expect(auth.get('c1')).toMatchObject({
    discovery: undefined,
    clientInfo: { client_id: 'id' },
  });

  fill();
  auth.clear('c1', 'all');
  expect(auth.get('c1')).toBeUndefined();
  expect(() => auth.clear('never-existed', 'tokens')).not.toThrow();
});

it('deleting a connector removes its auth row and only its own', () => {
  const { auth, connectors } = fixture();
  const a = connectors.create({
    name: 'a',
    transport: 'http',
    url: 'https://a/',
  });
  const b = connectors.create({
    name: 'b',
    transport: 'http',
    url: 'https://b/',
  });
  auth.saveTokens(a.id, TOKENS);
  auth.saveTokens(b.id, TOKENS);
  expect(connectors.delete(a.id)).toBe(true);
  expect(auth.get(a.id)).toBeUndefined();
  expect(auth.hasTokens(b.id)).toBe(true);
});

it('a row sealed with another key reads as no tokens', () => {
  const { db, auth } = fixture();
  auth.saveDiscovery('c1', { issuer: 'i' });
  auth.saveClientInfo('c1', { client_id: 'id' }, 'http://r/cb');
  auth.saveTokens('c1', TOKENS);
  auth.beginPending('c1', 'http://r/cb', 'v', 's');
  const other = new ConnectorAuthStore(db, randomBytes(32));
  expect(other.hasTokens('c1')).toBe(false);
  expect(other.get('c1')).toMatchObject({
    tokens: undefined,
    clientInfo: undefined,
    authorizedAt: undefined,
    expiresAt: undefined,
    scope: undefined,
    discovery: { issuer: 'i' },
  });
  expect(other.takePending(hashState('s'))).toBeUndefined();
});

it('a ciphertext copied into another connector row does not open', () => {
  const { db, auth } = fixture();
  auth.saveTokens('c1', TOKENS);
  auth.saveTokens('c2', { access_token: 'other' });
  const { tokens } = db
    .prepare("SELECT tokens FROM connector_auth WHERE connectorId='c1'")
    .get() as { tokens: string };
  db.prepare("UPDATE connector_auth SET tokens=? WHERE connectorId='c2'").run(
    tokens,
  );
  expect(auth.hasTokens('c2')).toBe(false);
  expect(auth.get('c2')!.tokens).toBeUndefined();
  expect(auth.hasTokens('c1')).toBe(true);
});
