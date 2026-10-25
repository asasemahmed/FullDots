// Ported from CopilotKit OpenDots (MIT).
import { createHash } from 'node:crypto';
import { Composio, type ToolRouterCreateSessionConfig } from '@composio/core';
import type { PlatformConfig } from './platform-config.js';
import type { WorkspaceStore } from './workspace.js';

let client: Composio | undefined;
let clientKey: string | undefined;

/**
 * One client per API key. Passing the key skips the SDK's fallback to
 * COMPOSIO_API_KEY and to ~/.composio, and a silent log level keeps provider
 * bodies out of the server log.
 */
function composioClient(apiKey: string) {
  if (!client || clientKey !== apiKey) {
    client = new Composio({ apiKey, logLevel: 'silent' });
    clientKey = apiKey;
  }
  return client;
}

/**
 * The session Composio keeps for one Dot. `direct_tools` lists each app action
 * on its own, so the approval card can name it. The default session would only
 * offer meta tools. `instant: false` stays off Instant billing, and the sandbox
 * stays off so Composio does not run code for the Dot.
 */
export function composioSessionConfig(
  toolkits: readonly string[],
): ToolRouterCreateSessionConfig {
  const allowed = [...new Set(toolkits)].sort();
  return {
    instant: false,
    manageConnections: true,
    sandbox: { enable: false },
    sessionPreset: 'direct_tools',
    ...(allowed.length ? { toolkits: allowed } : {}),
  };
}

export function composioPolicyHash(toolkits: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify(composioSessionConfig(toolkits)))
    .digest('hex');
}

export async function composioSession(
  config: PlatformConfig,
  workspace: WorkspaceStore,
  dotId: string,
  ownerId: string,
  signal?: AbortSignal,
) {
  if (!config.composioApiKey) throw new Error('Composio is not configured.');
  const record = workspace.composio.get(dotId);
  if (!record) throw new Error('Dot not found.');
  const policyHash = composioPolicyHash(record.toolkits);
  const composio = composioClient(config.composioApiKey);
  // 0.27 types the abort signal on the request options. A matching policy reuses
  // the session; a changed allow-list creates a new one.
  if (record.sessionId && record.policyHash === policyHash)
    return composio.sessions.use(record.sessionId, undefined, { signal });
  const session = await composio.sessions.create(
    ownerId,
    composioSessionConfig(record.toolkits),
    { signal },
  );
  workspace.composio.saveSession(dotId, session.sessionId, policyHash);
  return session;
}
