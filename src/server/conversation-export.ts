// One conversation as a Markdown document: what the owner said, what the Dots replied and one
// line per tool call.
//
// A tool result body is never copied. The one line a call needs comes from its name alone
// (`toolStepLabel`), and the stored result bodies are the part of a conversation that can carry
// a secret. What is left here is the same stored message list the transcript renders.
import type { Message } from '@ag-ui/core';
import { TURN_SOURCES, type TurnSource } from '../shared/types.js';
import { TURN_SOURCE_LABELS, toolStepLabel } from '../shared/step-label.js';

export interface ExportConversation {
  id: string;
  title: string;
  /** Host Dot: the one an owner message with no addressee belongs to. */
  dotId: string;
  createdAt: number;
  /** Last time the stored history changed (ms), or null when nothing was ever sent. */
  updatedAt: number | null;
}

export interface ExportInput {
  conversation: ExportConversation;
  /** Every Dot of the conversation, host first: `workspace.threadMembers`. */
  members: readonly { id: string; name: string }[];
  /** Message id to the Dot that wrote it: `runner.authors`. */
  authors: Readonly<Record<string, string>>;
  /** The stored history: `runner.getThreadMessages`. */
  messages: readonly Message[];
}

export interface ExportResult {
  markdown: string;
  filename: string;
}

/** One block of the document, before it is written out. */
type Entry =
  | { kind: 'owner'; text: string }
  | { kind: 'event'; label: string; text: string }
  | { kind: 'dot'; author: string; tools: string[]; text: string[] };

/** A message's text, whether it arrived as a string or as an array of content parts. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part) =>
      part && typeof part === 'object' && 'text' in part
        ? [(part as { text: unknown }).text]
        : [],
    )
    .filter((text): text is string => typeof text === 'string')
    .join('\n');
}

/**
 * The server-side reason a user message started its turn, or undefined for one the owner typed.
 * Mirrors `turnSource` in src/client/chat-turns.ts, which reads the same metadata.
 */
function turnSourceOf(message: Message): TurnSource | undefined {
  if (message.role !== 'user') return undefined;
  const metadata: unknown = message.metadata;
  if (!metadata || typeof metadata !== 'object' || !('source' in metadata))
    return undefined;
  const source: unknown = metadata.source;
  return TURN_SOURCES.find((known) => known === source);
}

/** `2025-10-17 09:14 UTC`: readable, unambiguous and the same wherever it is opened. */
function timestamp(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'unknown';
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * A file name every platform accepts, built from the title the same way the page editor builds
 * one from a page title. Unreadable characters go, the length is capped, and a title made
 * entirely of them falls back to a fixed name.
 */
function exportFilename(title: string): string {
  const safe = title
    .replace(/[^\p{L}\p{N} -]/gu, '')
    .trim()
    .slice(0, 80);
  return `${safe || 'conversation'}.md`;
}

/** The Dot that wrote an assistant message, by name. */
function authorName(
  message: Message,
  input: ExportInput,
  host: string,
): string {
  const authorId = input.authors[message.id];
  if (!authorId) return host;
  return input.members.find((member) => member.id === authorId)?.name ?? host;
}

/**
 * A conversation as a Markdown document: a short header, then the messages in stored order.
 *
 * The owner's messages are `## You`. A turn the server started (a schedule, a trigger, an
 * approval resume) keeps its transcript label instead, so a task-driven chat does not read as
 * if the owner typed the prompt. A Dot's replies sit under one heading per run of consecutive
 * messages it wrote, with its tool calls listed first, because the order of text and tool calls
 * inside a single streamed message is not recoverable.
 */
export function exportConversationMarkdown(input: ExportInput): ExportResult {
  const { conversation, members, messages } = input;
  const host = members[0]?.name ?? 'Dot';
  const dots = members.length > 1 ? members.map((m) => m.name) : [host];

  const header = [
    `# ${conversation.title}`,
    [
      `${dots.length > 1 ? '**Dots:**' : '**Dot:**'} ${dots.join(', ')}`,
      `**Started:** ${timestamp(conversation.createdAt)}`,
      `**Last activity:** ${timestamp(conversation.updatedAt)}`,
    ].join('\n'),
  ];

  const entries: Entry[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const text = messageText(message.content).trim();
      const source = turnSourceOf(message);
      // A turn the server started keeps its transcript label: a scheduled run is not
      // something the owner typed.
      if (source)
        entries.push({
          kind: 'event',
          label: TURN_SOURCE_LABELS[source],
          text: text || '_No text._',
        });
      else if (text) entries.push({ kind: 'owner', text });
      continue;
    }
    // 'tool', 'developer' and 'system' are not copied: a call's name is the whole of what an
    // export says about it, and a result body is the one part of a conversation that can carry
    // a secret.
    if (message.role !== 'assistant') continue;
    const text =
      typeof message.content === 'string' ? message.content.trim() : '';
    const tools = (message.toolCalls ?? []).map(
      (call) => `- ${toolStepLabel(call.function.name)}`,
    );
    if (!text && !tools.length) continue;
    const author = authorName(message, input, host);
    const previous = entries.at(-1);
    // One heading per run of consecutive messages a Dot wrote: a reply that arrives as
    // several stored messages is still one section.
    if (previous?.kind === 'dot' && previous.author === author) {
      previous.tools.push(...tools);
      if (text) previous.text.push(text);
    } else
      entries.push({ kind: 'dot', author, tools, text: text ? [text] : [] });
  }

  const body = entries.map((entry) => {
    if (entry.kind === 'owner') return `## You\n\n${entry.text}`;
    if (entry.kind === 'event') return `**${entry.label}**\n\n${entry.text}`;
    const pieces = [entry.tools.join('\n'), entry.text.join('\n\n')].filter(
      Boolean,
    );
    return `## ${entry.author}\n\n${pieces.join('\n\n')}`;
  });
  return {
    markdown: `${header.join('\n\n')}\n\n---\n\n${
      body.length
        ? body.join('\n\n')
        : '_This conversation has no messages yet._'
    }\n`,
    filename: exportFilename(conversation.title),
  };
}
