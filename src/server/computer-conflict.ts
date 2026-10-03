/**
 * Why the computer answered HTTP 409. It uses one status for several different situations, and each
 * one needs a different move from the agent, so the body is read instead of guessed at.
 *
 * - `owner_control`: the owner holds the wheel or has been asked to take it. Wait; never bypass.
 * - `snapshot_required`: control was just handed back or the computer restarted; take a snapshot.
 * - `stale_ref`: the element reference or snapshot id the agent used is out of date.
 * - `other`: anything else, for example a person's input while nobody holds control.
 */
export type ComputerConflictKind =
  'owner_control' | 'snapshot_required' | 'stale_ref' | 'other';

export const conflictMessages: Record<ComputerConflictKind, string> = {
  owner_control:
    'The owner currently has control of this computer, or has been asked to take it. Do not retry and do not try to work around it. Tell the user you are waiting for them to hand control back (or ask them to release it), then continue.',
  snapshot_required:
    'The browser must be refreshed with computer_snapshot before this action, because control was handed back or the computer restarted.',
  stale_ref:
    'That element reference is out of date. Use the refs and snapshotId from the latest page or computer_snapshot.',
  other:
    'Computer service returned HTTP 409: refresh the browser with computer_snapshot before retrying. If the owner has control, wait for them to release it; do not bypass takeover.',
};

export class ComputerConflictError extends Error {
  constructor(readonly kind: ComputerConflictKind) {
    super(conflictMessages[kind]);
    this.name = 'ComputerConflictError';
  }
}

/** Reads at most `limit` bytes of a body, so an odd error response cannot be large. */
async function readSome(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString('utf8', 0, limit);
}

/** Classifies a 409 response from the computer. Only flags it sets itself are trusted. */
export async function classifyConflict(
  response: Response,
): Promise<ComputerConflictKind> {
  try {
    const body: unknown = JSON.parse(await readSome(response, 16_384));
    if (body && typeof body === 'object') {
      const flags = body as Record<string, unknown>;
      if (flags.humanHasControl === true) return 'owner_control';
      if (flags.snapshotRequired === true) return 'snapshot_required';
      if (flags.stale === true) return 'stale_ref';
    }
  } catch {
    // An unreadable body is the generic conflict.
  }
  return 'other';
}
