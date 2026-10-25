import type { Message } from '@ag-ui/core';

/** Only tool-produced local Space links are promoted into channel replies. */
export function artifactLinks(
  messages: Message[],
  ids: ReadonlySet<string>,
  origin: string,
): string[] {
  const links = new Set<string>();
  const base = new URL(origin);
  for (const message of messages) {
    if (
      message.role !== 'tool' ||
      (!ids.has(message.id) && !ids.has(message.toolCallId)) ||
      typeof message.content !== 'string'
    )
      continue;
    try {
      const parsed: unknown = JSON.parse(message.content);
      if (!parsed || typeof parsed !== 'object') continue;
      const artifact = 'file' in parsed ? parsed.file : parsed;
      if (
        !artifact ||
        typeof artifact !== 'object' ||
        !('url' in artifact) ||
        typeof artifact.url !== 'string'
      )
        continue;
      const url = new URL(artifact.url, base);
      if (
        url.origin === base.origin &&
        url.pathname === '/' &&
        !url.search &&
        /^#\/spaces\/[^/]+\/(pages|files)\/[^/]+$/.test(url.hash)
      )
        links.add(url.href);
    } catch {
      /* Ordinary tool results are not artifact links. */
    }
  }
  return [...links];
}
