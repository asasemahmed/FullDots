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

/**
 * Codex's adapter marks every session folder as trusted. Codex loads a trusted project's own
 * `.codex` configuration (hooks, MCP servers, rules), and /workspace is writable by the Files API.
 * Marking it untrusted keeps project configuration out. Only the private home's configuration,
 * which the Files API cannot reach, applies. The one pinned token is replaced, and a missing or
 * repeated token fails the installation.
 */
export function untrustedProjectCodexSettings(source) {
  const before = 'trust_level: "trusted"';
  if (source.split(before).length !== 2)
    throw new Error(
      'Pinned adapter settings loader changed; review before installing.',
    );
  return source.replace(before, 'trust_level: "untrusted"');
}

const hardenings = {
  claude: [
    'node_modules/@agentclientprotocol/claude-agent-acp/dist/settings.js',
    managedOnlyAdapterSettings,
  ],
  codex: [
    'node_modules/@agentclientprotocol/codex-acp/dist/index.js',
    untrustedProjectCodexSettings,
  ],
};

export async function hardenAdapter(cache, provider = 'claude') {
  const [file, harden] = hardenings[provider];
  const path = join(cache, file);
  await writeFile(path, harden(await readFile(path, 'utf8')));
}
