import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  desktopSupervisorDocker,
  desktopSupervisorIndex,
} from './desktop-supervisor.mjs';

// Each patch replaces single upstream lines and fails closed if a line is missing
// or appears more than once, so a changed upstream file stops the build instead
// of silently skipping the hardening.
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2)
    throw new Error(
      'Pinned OpenBot supervisor contract changed; review before building.',
    );
  return source.replace(before, () => after);
}

// Fail closed if the pinned upstream contract changes. Only child authentication
// changes; OpenBot retains ownership of container creation, volumes and lifecycle.
export function hardenSupervisorEnvironment(source) {
  const before =
    'const computerToken = env.COMPUTER_TOKEN?.trim() || undefined;';
  if (source.split(before).length !== 2)
    throw new Error(
      'Pinned OpenBot environment contract changed; review before building.',
    );
  return `import { createHmac } from "node:crypto";\n${source.replace(
    before,
    `const master = env.COMPUTER_TOKEN?.trim();
  if (!master || master.length < 24) throw new Error("COMPUTER_TOKEN must contain at least 24 characters.");
  const computerToken = createHmac("sha256", master).update("opendots-computer:" + botId).digest("hex");`,
  )}`;
}

// docker.ts: let the options carry a CPU limit and apply it next to the memory
// limit. NanoCpus is Docker's CPU cap in billionths of a CPU.
export function hardenSupervisorDocker(source) {
  if (source.includes('nanoCpus'))
    throw new Error('Supervisor docker.ts is already patched.');
  const withOption = replaceOnce(
    source,
    '  memoryBytes?: number;',
    '  memoryBytes?: number;\n  /** Docker CPU limit in billionths of a CPU; unset means no limit. */\n  nanoCpus?: number;',
  );
  return replaceOnce(
    withOption,
    '    ...(options.memoryBytes ? { Memory: options.memoryBytes } : {}),',
    '    ...(options.memoryBytes ? { Memory: options.memoryBytes } : {}),\n    ...(options.nanoCpus ? { NanoCpus: options.nanoCpus } : {}),',
  );
}

// index.ts: read COMPUTER_CPUS at startup, refuse a bad value the same way the
// memory setting is refused, and pass the limit to every computer it creates.
export function hardenSupervisorIndex(source) {
  if (source.includes('nanoCpus'))
    throw new Error('Supervisor index.ts is already patched.');
  const withImports = replaceOnce(
    source,
    'import { computerMemoryBytes } from "./computer-memory-bytes";',
    'import { cpus } from "node:os";\nimport { computerMemoryBytes } from "./computer-memory-bytes";\nimport { computerCpus } from "./computer-cpus";',
  );
  const withParse = replaceOnce(
    withImports,
    'const memoryBytes = resolvedMemory.bytes;',
    `const memoryBytes = resolvedMemory.bytes;
const resolvedCpus = computerCpus(process.env.COMPUTER_CPUS, cpus().length);
if (!resolvedCpus.ok) {
  console.error(resolvedCpus.reason);
  process.exit(1);
}
if (resolvedCpus.note) console.warn(resolvedCpus.note);
const nanoCpus = resolvedCpus.nanoCpus;`,
  );
  return replaceOnce(
    withParse,
    '      ...(memoryBytes ? { memoryBytes } : {}),',
    '      ...(memoryBytes ? { memoryBytes } : {}),\n      ...(nanoCpus ? { nanoCpus } : {}),',
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const path = process.argv[2];
  if (!path) throw new Error('Pass the pinned supervisor environment.ts path.');
  const sourceDir = dirname(path);
  // supervisor.Dockerfile copies this next to the upstream sources.
  await access(join(sourceDir, 'computer-cpus.ts'));
  // Read everything and patch in memory first, so a contract failure in any
  // file leaves all of them untouched.
  const environment = hardenSupervisorEnvironment(await readFile(path, 'utf8'));
  const dockerPath = join(sourceDir, 'docker.ts');
  const docker = desktopSupervisorDocker(
    hardenSupervisorDocker(await readFile(dockerPath, 'utf8')),
  );
  const indexPath = join(sourceDir, 'index.ts');
  const index = desktopSupervisorIndex(
    hardenSupervisorIndex(await readFile(indexPath, 'utf8')),
  );
  await writeFile(path, environment);
  await writeFile(dockerPath, docker);
  await writeFile(indexPath, index);
}
