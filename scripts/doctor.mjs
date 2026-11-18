// Checks a local setup before you run FullDots and says how to fix what it finds.
//
//   npm run doctor
//
// It checks the Node.js version, the .env file, that the data folder is writable, that the default
// ports are free, and whether Docker is available (only needed for Dot computers). A failed check
// makes the command exit with 1; warnings do not. Ports are reported as warnings because they are
// also busy while FullDots itself is running.
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';

const MIN_NODE_MAJOR = 24;

const checks = [];
const record = (level, message) => checks.push({ level, message });

const major = Number(process.versions.node.split('.')[0]);
if (major >= MIN_NODE_MAJOR) record('ok', `Node.js ${process.versions.node}`);
else
  record(
    'fail',
    `Node.js ${process.versions.node} is too old. FullDots needs Node.js ${MIN_NODE_MAJOR} or newer.`,
  );

if (existsSync('.env')) record('ok', '.env found');
else
  record(
    'warn',
    '.env is missing. Create it with: cp .env.example .env (the app still starts, in setup state).',
  );

// The database lives in this folder: the server creates it, so a missing one is fine
// as long as the closest existing parent folder can be written to.
const dataDir = dirname(
  resolve(process.env.DATABASE_PATH || 'data/opendots.sqlite'),
);
let existing = dataDir;
while (!existsSync(existing) && dirname(existing) !== existing)
  existing = dirname(existing);
try {
  if (!statSync(existing).isDirectory())
    throw new Error(`${existing} is not a folder`);
  accessSync(existing, constants.W_OK);
  record(
    'ok',
    existing === dataDir
      ? `Data folder ${dataDir} is writable`
      : `Data folder ${dataDir} will be created on first start`,
  );
} catch {
  record(
    'fail',
    `Data folder ${dataDir} is not writable. Fix its permissions or set DATABASE_PATH to another location.`,
  );
}

const portFree = (port) =>
  new Promise((done) => {
    const server = createServer();
    server.once('error', (error) => done(error.code ?? 'ERROR'));
    server.listen(port, '127.0.0.1', () => server.close(() => done('free')));
  });
const ports = [
  [Number(process.env.PORT) || 4310, 'FullDots server'],
  [5173, 'npm run dev web app'],
  [4312, 'Dot computer supervisor'],
];
for (const [port, name] of ports) {
  const state = await portFree(port);
  if (state === 'free') record('ok', `Port ${port} is free (${name})`);
  else if (state === 'EADDRINUSE')
    record(
      'warn',
      `Port ${port} is in use (${name}). Stop whatever is using it, or ignore this if FullDots is already running.`,
    );
  else record('warn', `Port ${port} could not be checked (${state}).`);
}

try {
  const version = execFileSync('docker', ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
  }).trim();
  record('ok', `${version} (needed only for Dot computers)`);
} catch {
  record(
    'warn',
    'Docker was not found. It is only needed for Dot computers; everything else works without it.',
  );
}

for (const { level, message } of checks)
  console.log(`${level.padEnd(4)}  ${message}`);
const failed = checks.filter((check) => check.level === 'fail').length;
const warned = checks.filter((check) => check.level === 'warn').length;
console.log(
  failed
    ? `\n${failed} check(s) failed.`
    : warned
      ? `\nReady, with ${warned} warning(s).`
      : '\nAll checks passed.',
);
process.exit(failed ? 1 : 0);
