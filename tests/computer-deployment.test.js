import { expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import ts from 'typescript';
import {
  hardenSupervisorDocker,
  hardenSupervisorEnvironment,
  hardenSupervisorIndex,
} from '../deployment/computers/harden-supervisor.mjs';

const upstream = `export function environmentFor(botId, env) {
  const computerToken = env.COMPUTER_TOKEN?.trim() || undefined;
  return [\`COMPUTER_BOT_ID=\${botId}\`, \`COMPUTER_TOKEN=\${computerToken}\`];
}`;
it('gives each child its own credential without forwarding the master', async () => {
  const module = await import(
    `data:text/javascript,${encodeURIComponent(hardenSupervisorEnvironment(upstream))}`
  );
  const master = 'fixture-master-only-for-this-test';
  const first = module.environmentFor('dot-a', { COMPUTER_TOKEN: master });
  const second = module.environmentFor('dot-b', { COMPUTER_TOKEN: master });
  expect(first[1]).toBe(
    `COMPUTER_TOKEN=${createHmac('sha256', master).update('opendots-computer:dot-a').digest('hex')}`,
  );
  expect(first[1]).not.toBe(second[1]);
  expect(first.join()).not.toContain(master);
  expect(() =>
    module.environmentFor('dot-a', { COMPUTER_TOKEN: 'short' }),
  ).toThrow();
});
it('refuses missing or ambiguous upstream patch targets', () => {
  expect(() => hardenSupervisorEnvironment('changed upstream')).toThrow(
    /contract changed/,
  );
  expect(() => hardenSupervisorEnvironment(upstream + upstream)).toThrow(
    /contract changed/,
  );
});

// Verbatim copies of the pinned OpenBot supervisor files (b6932d3, MIT) the CPU
// patch changes. If the pin moves, refresh these from that commit.
const pinned = (name) =>
  readFileSync(
    new URL(`./fixtures/openbot-b6932d3/${name}.ts.txt`, import.meta.url),
    'utf8',
  );
const syntaxErrors = (source) =>
  ts.transpileModule(source, { reportDiagnostics: true }).diagnostics.length;

it('sets NanoCpus next to the memory limit in the pinned docker.ts', () => {
  const upstream = pinned('docker');
  expect(upstream).not.toContain('NanoCpus');
  const patched = hardenSupervisorDocker(upstream);
  expect(patched).toContain(
    '...(options.memoryBytes ? { Memory: options.memoryBytes } : {}),\n    ...(options.nanoCpus ? { NanoCpus: options.nanoCpus } : {}),',
  );
  expect(patched).toContain('  nanoCpus?: number;');
  expect(patched.split('NanoCpus: options.nanoCpus').length).toBe(2);
  expect(syntaxErrors(patched)).toBe(0);
  // Nothing else changed.
  const lines = patched.split('\n');
  expect(lines.length - upstream.split('\n').length).toBe(3);
});
it('reads COMPUTER_CPUS at startup and hands it to ensure in the pinned index.ts', () => {
  const upstream = pinned('index');
  const patched = hardenSupervisorIndex(upstream);
  expect(patched).toContain('computerCpus(process.env.COMPUTER_CPUS');
  expect(patched).toContain('console.error(resolvedCpus.reason);');
  expect(patched).toContain('...(nanoCpus ? { nanoCpus } : {}),');
  expect(patched.indexOf('const nanoCpus')).toBeGreaterThan(
    patched.indexOf('const memoryBytes'),
  );
  expect(syntaxErrors(patched)).toBe(0);
});
it('still patches the pinned environment.ts', () => {
  expect(hardenSupervisorEnvironment(pinned('environment'))).toContain(
    'createHmac',
  );
});
it('fails closed when an upstream line the CPU patch needs has changed', () => {
  const docker = pinned('docker');
  const index = pinned('index');
  for (const line of [
    '  memoryBytes?: number;',
    '    ...(options.memoryBytes ? { Memory: options.memoryBytes } : {}),',
  ]) {
    expect(docker).toContain(line);
    expect(() =>
      hardenSupervisorDocker(docker.replace(line, '// removed')),
    ).toThrow(/contract changed/);
  }
  for (const line of [
    'import { computerMemoryBytes } from "./computer-memory-bytes";',
    'const memoryBytes = resolvedMemory.bytes;',
    '      ...(memoryBytes ? { memoryBytes } : {}),',
  ]) {
    expect(index).toContain(line);
    expect(() =>
      hardenSupervisorIndex(index.replace(line, '// removed')),
    ).toThrow(/contract changed/);
    // A line that appears twice is as ambiguous as one that is missing.
    expect(() => hardenSupervisorIndex(index + line)).toThrow(
      /contract changed/,
    );
  }
  expect(() => hardenSupervisorDocker(docker + docker)).toThrow(
    /contract changed/,
  );
  expect(() => hardenSupervisorDocker('changed upstream')).toThrow(
    /contract changed/,
  );
  expect(() => hardenSupervisorIndex('changed upstream')).toThrow(
    /contract changed/,
  );
});
it('refuses to patch a file twice', () => {
  expect(() =>
    hardenSupervisorDocker(hardenSupervisorDocker(pinned('docker'))),
  ).toThrow(/already patched/);
  expect(() =>
    hardenSupervisorIndex(hardenSupervisorIndex(pinned('index'))),
  ).toThrow(/already patched/);
});

function supervisorFolder() {
  const folder = mkdtempSync(join(tmpdir(), 'supervisor-src-'));
  for (const name of ['environment', 'docker', 'index'])
    writeFileSync(join(folder, `${name}.ts`), pinned(name));
  copyFileSync(
    new URL('../deployment/computers/computer-cpus.ts', import.meta.url),
    join(folder, 'computer-cpus.ts'),
  );
  return folder;
}
const runPatch = (folder) =>
  execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL(
          '../deployment/computers/harden-supervisor.mjs',
          import.meta.url,
        ),
      ),
      join(folder, 'environment.ts'),
    ],
    { stdio: 'pipe' },
  );
it('patches all three files when run the way the Dockerfile runs it', () => {
  const folder = supervisorFolder();
  try {
    runPatch(folder);
    expect(readFileSync(join(folder, 'docker.ts'), 'utf8')).toContain(
      'NanoCpus: options.nanoCpus',
    );
    expect(readFileSync(join(folder, 'index.ts'), 'utf8')).toContain(
      'nanoCpus',
    );
    expect(readFileSync(join(folder, 'environment.ts'), 'utf8')).toContain(
      'createHmac',
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
it('exits non-zero and writes nothing when the upstream docker.ts changed', () => {
  const folder = supervisorFolder();
  try {
    const changed = pinned('docker').replace('  memoryBytes?: number;', '');
    writeFileSync(join(folder, 'docker.ts'), changed);
    expect(() => runPatch(folder)).toThrow();
    expect(readFileSync(join(folder, 'docker.ts'), 'utf8')).toBe(changed);
    expect(readFileSync(join(folder, 'index.ts'), 'utf8')).toBe(
      pinned('index'),
    );
    expect(readFileSync(join(folder, 'environment.ts'), 'utf8')).toBe(
      pinned('environment'),
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
it('refuses to build when computer-cpus.ts was not copied in', () => {
  const folder = supervisorFolder();
  try {
    rmSync(join(folder, 'computer-cpus.ts'));
    expect(() => runPatch(folder)).toThrow();
    expect(readFileSync(join(folder, 'docker.ts'), 'utf8')).toBe(
      pinned('docker'),
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
