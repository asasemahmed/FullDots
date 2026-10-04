/** Title a conversation gets before anything meaningful has been said in it. */
export const DEFAULT_CONVERSATION_TITLE = 'A new thought';
export const MAX_DERIVED_TITLE_LENGTH = 60;
export const MAX_CONVERSATION_TITLE_LENGTH = 120;

/**
 * Builds a short chat title from the first thing the user said: the first
 * non-empty line, whitespace collapsed, cut at a word boundary with an
 * ellipsis when it is too long. The text itself is never rewritten.
 */
export function deriveTitle(
  text: string,
  fallback = DEFAULT_CONVERSATION_TITLE,
  max = MAX_DERIVED_TITLE_LENGTH,
): string {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .find(Boolean);
  if (!line) return fallback;
  if (line.length <= max) return line;
  // Leave one character for the ellipsis.
  const room = max - 1;
  let head = line.slice(0, room);
  // Cut at the last space unless the cut already lands on a word boundary.
  if (!/\s/.test(line[room] ?? '')) {
    const space = head.lastIndexOf(' ');
    if (space >= room / 2) head = head.slice(0, space);
  }
  head = head.replace(/[\s,.;:\-–—]+$/, '');
  return `${head || line.slice(0, room)}…`;
}

/** True while a conversation still carries the placeholder title. */
export function hasDefaultTitle(title: string): boolean {
  return title.trim() === DEFAULT_CONVERSATION_TITLE;
}
