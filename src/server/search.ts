import {
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  SEARCH_TYPES,
  type SearchResult,
  type SearchResultType,
} from '../shared/search.js';
import { TURN_SOURCES } from '../shared/types.js';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt.js';
import type { SearchStore } from './search-store.js';

const SNIPPET_WIDTH = 120;
/** Matching messages returned per chat, so one long chat cannot fill the list. */
const MESSAGES_PER_CHAT = 2;

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A case-insensitive matcher for the typed text; any run of spaces matches any whitespace. */
function matcher(query: string): RegExp {
  return new RegExp(
    query.trim().split(/\s+/).map(escapeRegExp).join('\\s+'),
    'i',
  );
}

/** About 120 characters around the first match (or the start when nothing matches). */
export function makeSnippet(
  text: string,
  query: string,
  width = SNIPPET_WIDTH,
): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const match = query.trim() ? matcher(query).exec(flat) : null;
  let start = match ? Math.max(0, match.index - Math.floor(width / 3)) : 0;
  if (start + width > flat.length) start = Math.max(0, flat.length - width);
  // Do not begin or end in the middle of a surrogate pair.
  if (start > 0 && /[\udc00-\udfff]/.test(flat[start]!)) start += 1;
  let end = Math.min(flat.length, start + width);
  if (
    end > start &&
    end < flat.length &&
    /[\ud800-\udbff]/.test(flat[end - 1]!)
  )
    end -= 1;
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/**
 * The text of a stored chat message the owner could see, or undefined. Only plain text parts of
 * user and assistant messages count: tool calls and their arguments, tool results, reasoning,
 * system text, voice receipts and messages a task, approval or hand-off started are left out.
 */
export function visibleMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const { id, role, content, metadata } = message as Record<string, unknown>;
  if (typeof id !== 'string' || (role !== 'user' && role !== 'assistant'))
    return undefined;
  if (role === 'user') {
    if (id.startsWith(voiceReceiptMessagePrefix)) return undefined;
    if (metadata && typeof metadata === 'object') {
      const { source, opendotsSource } = metadata as Record<string, unknown>;
      if (opendotsSource === 'voice_receipt') return undefined;
      if (TURN_SOURCES.some((known) => known === source)) return undefined;
    }
  }
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .flatMap((part) =>
              part &&
              typeof part === 'object' &&
              (part as { type?: unknown }).type === 'text' &&
              typeof (part as { text?: unknown }).text === 'string'
                ? [(part as { text: string }).text]
                : [],
            )
            .join('\n')
        : '';
  return text.trim() || undefined;
}

/** A hit plus which ranking group it belongs to: title matches come before content matches. */
export interface SearchHit extends SearchResult {
  group: 'title' | 'content';
}

export interface ThreadActivity {
  id: string;
  updatedAt: number;
}

export interface SearchContext {
  query: string;
  limit: number;
  store: SearchStore;
  /** The owner's conversations. */
  conversations: () => { id: string; dotId: string; title: string }[];
  /** Chats that have stored history, newest first. */
  threads: () => ThreadActivity[];
  /** Conversations something else points at (a task, page or call), so they are not empty. */
  linkedThreadIds: () => Set<string>;
  messages: (threadId: string) => unknown[];
}

interface SearchSource {
  type: SearchResultType;
  run: (context: SearchContext) => SearchHit[];
}

const chatSource: SearchSource = {
  type: 'chat',
  run: (context) => {
    // A conversation nothing was ever sent in is a placeholder, not something to find.
    const activity = new Map(
      context.threads().map((thread) => [thread.id, thread.updatedAt]),
    );
    const linked = context.linkedThreadIds();
    return context.store
      .chats(context.query)
      .filter((chat) => activity.has(chat.id) || linked.has(chat.id))
      .map((chat) => ({
        group: 'title' as const,
        type: 'chat' as const,
        id: chat.id,
        title: chat.title,
        snippet: '',
        threadId: chat.id,
        dotId: chat.dotId,
        updatedAt: activity.get(chat.id) ?? 0,
      }));
  },
};

const messageSource: SearchSource = {
  type: 'message',
  run: (context) => {
    const chats = new Map(
      context.conversations().map((chat) => [chat.id, chat]),
    );
    const find = matcher(context.query);
    const hits: SearchHit[] = [];
    // Threads come newest first, so the first `limit` hits are the newest ones.
    for (const thread of context.threads()) {
      const chat = chats.get(thread.id);
      if (!chat) continue;
      let found = 0;
      const messages = context.messages(thread.id);
      for (let index = messages.length - 1; index >= 0; index--) {
        const text = visibleMessageText(messages[index]);
        if (!text || !find.test(text.replace(/\s+/g, ' '))) continue;
        hits.push({
          group: 'content',
          type: 'message',
          id: String((messages[index] as { id: string }).id),
          title: chat.title,
          snippet: makeSnippet(text, context.query),
          threadId: chat.id,
          dotId: chat.dotId,
          updatedAt: thread.updatedAt,
        });
        if (++found >= MESSAGES_PER_CHAT) break;
      }
      if (hits.length >= context.limit) break;
    }
    return hits;
  },
};

const pageSource: SearchSource = {
  type: 'page',
  run: (context) =>
    context.store.pages(context.query, context.limit).map((page) => ({
      group: page.titleHit ? ('title' as const) : ('content' as const),
      type: 'page' as const,
      id: page.id,
      title: page.title,
      snippet: makeSnippet(page.content, context.query),
      spaceId: page.spaceId,
      updatedAt: page.updatedAt,
    })),
};

const dotSource: SearchSource = {
  type: 'dot',
  run: (context) =>
    context.store.dots(context.query, context.limit).map((dot) => ({
      group: dot.nameHit ? ('title' as const) : ('content' as const),
      type: 'dot' as const,
      id: dot.id,
      title: dot.name,
      snippet: makeSnippet(dot.instructions, context.query),
      dotId: dot.id,
      updatedAt: dot.createdAt,
    })),
};

const promptSource: SearchSource = {
  type: 'prompt',
  run: (context) =>
    context.store.prompts(context.query, context.limit).map((prompt) => ({
      group: prompt.titleHit ? ('title' as const) : ('content' as const),
      type: 'prompt' as const,
      id: prompt.id,
      title: prompt.title,
      snippet: makeSnippet(prompt.body, context.query),
      ...(prompt.dotId ? { dotId: prompt.dotId } : {}),
      updatedAt: prompt.updatedAt,
    })),
};

/** Named teams: a title match on the name (shown with its emoji), a content match on the description. */
const teamSource: SearchSource = {
  type: 'team',
  run: (context) =>
    context.store.teams(context.query, context.limit).map((team) => ({
      group: team.nameHit ? ('title' as const) : ('content' as const),
      type: 'team' as const,
      id: team.id,
      title: `${team.emoji} ${team.name}`,
      snippet: team.nameHit ? '' : makeSnippet(team.description, context.query),
      updatedAt: team.updatedAt,
    })),
};

const SOURCES: SearchSource[] = [
  chatSource,
  messageSource,
  pageSource,
  dotSource,
  promptSource,
  teamSource,
];

export function clampLimit(raw: unknown): number {
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(value)) return SEARCH_LIMIT_DEFAULT;
  return Math.min(SEARCH_LIMIT_MAX, Math.max(1, value));
}

/** The known types in a `types=a,b` list, or undefined when it names one that does not exist. */
export function parseTypes(
  raw: string | undefined,
): SearchResultType[] | undefined {
  const names = (raw ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (!names.length) return [...SEARCH_TYPES];
  const known = names.filter((name): name is SearchResultType =>
    SEARCH_TYPES.some((type) => type === name),
  );
  return known.length === names.length ? [...new Set(known)] : undefined;
}

/**
 * Title matches first, then content matches; newest first inside each group. A page, Dot or
 * prompt that matches in both its title and its body is listed once, as a title match. Ties keep
 * the order the sources found them in (a chat's newest message first).
 */
export function searchWorkspace(
  context: SearchContext,
  types: SearchResultType[],
): SearchResult[] {
  if (!context.query.trim()) return [];
  const hits = SOURCES.filter((source) => types.includes(source.type)).flatMap(
    (source) => source.run(context),
  );
  const rank = (hit: SearchHit) => (hit.group === 'title' ? 0 : 1);
  const order: readonly string[] = SEARCH_TYPES;
  return hits
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        b.updatedAt - a.updatedAt ||
        order.indexOf(a.type) - order.indexOf(b.type),
    )
    .slice(0, context.limit)
    .map((hit) => {
      const { group, ...result } = hit;
      void group;
      return result;
    });
}
