import type { DatabaseSync } from 'node:sqlite';
import { MAX_COMPOSIO_TOOLKITS } from '../shared/composio.js';

export interface ComposioRecord {
  allowed: boolean;
  toolkits: string[];
  sessionId: string | null;
  policyHash: string | null;
}

const SLUG = /^[a-z0-9_]{1,64}$/;

/** The JSON stored in `dots.composioToolkits`, or an empty list when it is unreadable. */
export function storedToolkits(value: unknown): string[] {
  const parsed = typeof value === 'string' ? safeJson(value) : value;
  if (!Array.isArray(parsed)) return [];
  return [
    ...new Set(
      parsed
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().toLowerCase())
        .filter((item) => SLUG.test(item)),
    ),
  ]
    .sort()
    .slice(0, MAX_COMPOSIO_TOOLKITS);
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

/** What the workspace response shows. The session id and policy hash stay on the server. */
export function composioFields(row: {
  composioAllowed?: unknown;
  composioToolkits?: unknown;
}): { composioAllowed: boolean; composioToolkits: string[] } {
  return {
    composioAllowed: !!row.composioAllowed,
    composioToolkits: storedToolkits(row.composioToolkits),
  };
}

/**
 * The Composio columns on `dots`. The table migration lives in WorkspaceStore;
 * this store only reads and writes them.
 */
export class ComposioStore {
  constructor(private db: DatabaseSync) {}

  get(dotId: string): ComposioRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT composioAllowed, composioToolkits, composioSessionId, composioPolicyHash FROM dots WHERE id=?',
      )
      .get(dotId) as
      | {
          composioAllowed: number | null;
          composioToolkits: string | null;
          composioSessionId: string | null;
          composioPolicyHash: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      allowed: !!row.composioAllowed,
      toolkits: storedToolkits(row.composioToolkits),
      sessionId: row.composioSessionId,
      policyHash: row.composioPolicyHash,
    };
  }

  savePolicy(
    dotId: string,
    policy: { allowed: boolean; toolkits: string[] },
  ): void {
    const toolkits = storedToolkits(policy.toolkits);
    this.db
      .prepare(
        'UPDATE dots SET composioAllowed=?, composioToolkits=? WHERE id=?',
      )
      .run(+policy.allowed, JSON.stringify(toolkits), dotId);
  }

  saveSession(dotId: string, sessionId: string, policyHash: string): void {
    this.db
      .prepare(
        'UPDATE dots SET composioSessionId=?, composioPolicyHash=? WHERE id=?',
      )
      .run(sessionId, policyHash, dotId);
  }
}

/** Writes the per-Dot switch and allow-list when the request includes either. */
export function applyComposioFields(
  store: ComposioStore,
  dotId: string,
  patch: { composioAllowed?: boolean; composioToolkits?: string[] },
): void {
  if (
    patch.composioAllowed === undefined &&
    patch.composioToolkits === undefined
  )
    return;
  const current = store.get(dotId);
  store.savePolicy(dotId, {
    allowed: patch.composioAllowed ?? current?.allowed ?? false,
    toolkits: patch.composioToolkits ?? current?.toolkits ?? [],
  });
}
