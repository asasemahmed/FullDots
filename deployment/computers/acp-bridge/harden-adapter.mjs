import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function managedOnlyAdapterSettings(source) {
  const before = 'resolveSettings({ cwd: this.cwd })';
  if (source.split(before).length !== 2)
    throw new Error(
      'Pinned adapter settings loader changed; review before installing.',
    );
  return source.replace(
    before,
    'resolveSettings({ cwd: this.cwd, settingSources: [] })',
  );
}

export async function hardenAdapter(cache) {
  const path = join(
    cache,
    'node_modules/@agentclientprotocol/claude-agent-acp/dist/settings.js',
  );
  await writeFile(
    path,
    managedOnlyAdapterSettings(await readFile(path, 'utf8')),
  );
}
