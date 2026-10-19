import type { InboxSection } from '../shared/inbox';

export type AppHashTarget =
  | { view: 'inbox'; section?: InboxSection }
  | { view: 'mission' }
  | { view: 'space'; spaceId: string; pageId?: string; fileId?: string }
  | { view: 'team'; teamId: string }
  | { view: 'thread'; dotId: string; threadId: string };

const decode = (value: string): string | undefined => {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
};

/**
 * Where a `location.hash` points: `#/inbox`, `#/approvals` (kept for notification links and
 * bookmarks: the inbox, on its Approvals section), `#/mission`,
 * `#/spaces/<id>[/pages/<id> | /files/<id>]`,
 * `#/team/<id>` or `#/dots/<dotId>/threads/<threadId>`. Anything else is `undefined` and ignored.
 */
export function parseAppHash(hash: string): AppHashTarget | undefined {
  if (hash === '#/inbox') return { view: 'inbox' };
  if (hash === '#/approvals') return { view: 'inbox', section: 'approvals' };
  if (hash === '#/mission') return { view: 'mission' };
  const space = hash.match(/^#\/spaces\/([^/]+)(?:\/(pages|files)\/([^/]+))?$/);
  if (space)
    return {
      view: 'space',
      spaceId: space[1]!,
      ...(space[2] === 'pages' ? { pageId: space[3]! } : {}),
      ...(space[2] === 'files' ? { fileId: space[3]! } : {}),
    };
  const team = hash.match(/^#\/team\/([^/]+)$/);
  if (team) {
    const teamId = decode(team[1]!);
    if (teamId) return { view: 'team', teamId };
  }
  const thread = hash.match(/^#\/dots\/([^/]+)\/threads\/([^/]+)$/);
  if (thread) {
    const dotId = decode(thread[1]!);
    const threadId = decode(thread[2]!);
    if (dotId && threadId) return { view: 'thread', dotId, threadId };
  }
  return undefined;
}
