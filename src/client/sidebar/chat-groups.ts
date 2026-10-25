export type ChatGroupId = 'today' | 'yesterday' | 'week' | 'month' | 'older';

interface Datable {
  createdAt: number;
  updatedAt?: number | null;
}

/** Last activity if the server knows it, otherwise when the chat was created. */
export function chatRecency(chat: Datable): number {
  return chat.updatedAt ?? chat.createdAt;
}

/** Which bucket a timestamp falls in, using the viewer's local calendar days. */
export function chatGroupFor(time: number, now = Date.now()): ChatGroupId {
  const day = (offset: number) => {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    return date.getTime();
  };
  if (time >= day(0)) return 'today';
  if (time >= day(1)) return 'yesterday';
  if (time >= day(7)) return 'week';
  if (time >= day(30)) return 'month';
  return 'older';
}

/** Newest first, by last activity. */
export function newestFirst<T extends Datable>(chats: readonly T[]): T[] {
  return [...chats].sort((a, b) => chatRecency(b) - chatRecency(a));
}

/** The short time a chat row shows: the time today, then Yesterday, a weekday, a date. */
export function chatWhen(time: number, now = Date.now()): string {
  const date = new Date(time);
  const group = chatGroupFor(time, now);
  if (group === 'today')
    return date.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  if (group === 'yesterday') return 'Yesterday';
  // A weekday only while it cannot be mistaken for today's.
  const weekAgo = new Date(now);
  weekAgo.setHours(0, 0, 0, 0);
  weekAgo.setDate(weekAgo.getDate() - 6);
  if (time >= weekAgo.getTime())
    return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.getFullYear() === new Date(now).getFullYear()
    ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

/** Case-insensitive title search; every word typed must appear in the title. */
export function filterChats<T extends { title: string }>(
  chats: T[],
  query: string,
): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return chats;
  return chats.filter((chat) => {
    const title = chat.title.toLowerCase();
    return words.every((word) => title.includes(word));
  });
}

/**
 * Chats worth listing: conversations nobody ever wrote in stay out of the way
 * (the one currently open is always kept so it does not vanish under you).
 */
export function listableChats<T extends { id: string; empty?: boolean }>(
  chats: T[],
  selectedId?: string,
): T[] {
  return chats.filter((chat) => !chat.empty || chat.id === selectedId);
}

/** The Dot's most recently active conversation that has anything in it. */
export function latestChat<
  T extends Datable & { id: string; dotId: string; empty?: boolean },
>(chats: T[], dotId: string): T | undefined {
  return chats
    .filter((chat) => chat.dotId === dotId && !chat.empty)
    .sort((a, b) => chatRecency(b) - chatRecency(a))[0];
}
