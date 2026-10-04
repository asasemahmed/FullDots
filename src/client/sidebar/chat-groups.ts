export type ChatGroupId = 'today' | 'yesterday' | 'week' | 'month' | 'older';

export interface ChatGroup<T> {
  id: ChatGroupId;
  label: string;
  items: T[];
}

interface Datable {
  createdAt: number;
  updatedAt?: number | null;
}

const LABELS: Record<ChatGroupId, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Previous 7 days',
  month: 'Previous 30 days',
  older: 'Older',
};

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

/** Newest first, split into date groups; groups with no chats are left out. */
export function groupChats<T extends Datable>(
  chats: T[],
  now = Date.now(),
): ChatGroup<T>[] {
  const groups = new Map<ChatGroupId, T[]>();
  for (const chat of [...chats].sort(
    (a, b) => chatRecency(b) - chatRecency(a),
  )) {
    const id = chatGroupFor(chatRecency(chat), now);
    groups.set(id, [...(groups.get(id) ?? []), chat]);
  }
  return (Object.keys(LABELS) as ChatGroupId[])
    .filter((id) => groups.has(id))
    .map((id) => ({ id, label: LABELS[id], items: groups.get(id)! }));
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
