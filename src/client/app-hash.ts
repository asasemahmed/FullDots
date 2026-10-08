export type AppHashTarget =
  | { view: 'approvals' }
  | { view: 'space'; spaceId: string; pageId?: string }
  | { view: 'thread'; dotId: string; threadId: string };

const decode = (value: string): string | undefined => {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
};

/**
 * Where a `location.hash` points: `#/approvals`, `#/spaces/<id>[/pages/<id>]` or
 * `#/dots/<dotId>/threads/<threadId>`. Anything else is `undefined` and ignored.
 */
export function parseAppHash(hash: string): AppHashTarget | undefined {
  if (hash === '#/approvals') return { view: 'approvals' };
  const space = hash.match(/^#\/spaces\/([^/]+)(?:\/pages\/([^/]+))?$/);
  if (space) return { view: 'space', spaceId: space[1]!, pageId: space[2] };
  const thread = hash.match(/^#\/dots\/([^/]+)\/threads\/([^/]+)$/);
  if (thread) {
    const dotId = decode(thread[1]!);
    const threadId = decode(thread[2]!);
    if (dotId && threadId) return { view: 'thread', dotId, threadId };
  }
  return undefined;
}
