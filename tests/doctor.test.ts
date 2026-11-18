import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/doctor.mjs');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'fulldots-doctor-'));
  dirs.push(dir);
  return dir;
};
// Runs the script in its own folder, so `.env` and `data/` are the ones it sees.
const doctor = (cwd: string, env: Record<string, string> = {}) => {
  const base = { ...process.env };
  delete base.DATABASE_PATH;
  delete base.PORT;
  const result = spawnSync(process.execPath, [script], {
    cwd,
    encoding: 'utf8',
    env: { ...base, ...env },
  });
  return { code: result.status, out: result.stdout };
};
const freePort = () =>
  new Promise<number>((done) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => done(port));
    });
  });

it('passes the Node.js and data folder checks and explains a missing .env', () => {
  const cwd = temp();
  const { code, out } = doctor(cwd);
  expect(out).toMatch(/^ok +Node\.js \d+/m);
  expect(out).toMatch(/^warn +\.env is missing.*cp \.env\.example \.env/m);
  expect(out).toMatch(/^ok +Data folder .* will be created on first start/m);
  expect(code).toBe(0);
});

it('reports .env and an existing data folder as ok', () => {
  const cwd = temp();
  writeFileSync(join(cwd, '.env'), 'PORT=4310\n');
  mkdirSync(join(cwd, 'data'));
  const { code, out } = doctor(cwd);
  expect(out).toMatch(/^ok +\.env found/m);
  expect(out).not.toContain('.env is missing');
  expect(out).toMatch(/^ok +Data folder .* is writable/m);
  expect(code).toBe(0);
});

it('fails when the data folder cannot be used', () => {
  const cwd = temp();
  // The parent of the database is a file, so no folder can be created there.
  writeFileSync(join(cwd, 'data'), 'not a folder');
  const { code, out } = doctor(cwd, {
    DATABASE_PATH: join(cwd, 'data', 'opendots.sqlite'),
  });
  expect(out).toMatch(/^fail +Data folder .* is not writable/m);
  expect(out).toContain('check(s) failed');
  expect(code).toBe(1);
});

it('warns, without failing, when the server port is in use', async () => {
  const cwd = temp();
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  try {
    const { code, out } = doctor(cwd, { PORT: String(port) });
    expect(out).toMatch(
      new RegExp(`^warn +Port ${port} is in use \\(FullDots server\\)`, 'm'),
    );
    expect(code).toBe(0);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

it('reports a free server port as ok', async () => {
  const cwd = temp();
  const port = await freePort();
  const { out } = doctor(cwd, { PORT: String(port) });
  expect(out).toMatch(
    new RegExp(`^ok +Port ${port} is free \\(FullDots server\\)`, 'm'),
  );
});
