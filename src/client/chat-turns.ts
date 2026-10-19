// Pure helpers that turn the AG-UI message list into what the chat renders.
//
// The runtime streams a whole agent run into ONE assistant message: every text
// segment is appended to `content` and every tool call is pushed onto
// `toolCalls`, with the tool results arriving as separate `role: "tool"`
// messages. The relative order of text and tool calls inside that message is
// therefore not recoverable, so actions are shown first and the reply after
// them. Transcripts that do split a turn across several assistant messages are
// laid out chronologically instead, and their computer calls are merged into a
// single activity block.
import type { AssistantMessage, Message, ToolCall } from '@ag-ui/core';
import {
  TURN_SOURCES,
  type CallReceipt,
  type HandoffResult,
  type PendingApprovalResult,
  type TurnSource,
} from '../shared/types';
import { isLaneTool } from '../shared/lanes';
import type { FileKind } from '../shared/space-files';

export function isComputerTool(name: string): boolean {
  return name.startsWith('computer_');
}

/** Tools whose calls fold into the compact activity block: the computer and connector tools. */
export function isActivityTool(name: string): boolean {
  return isComputerTool(name) || name.startsWith('mcp__');
}

export type ApprovalToolResult = PendingApprovalResult | HandoffResult;

/** Tools whose result is a file card, so a message holding only such a call is still shown. */
export function isFileCardTool(name: string): boolean {
  return name === 'save_space_file' || name === 'copy_computer_file_to_space';
}

/** A file a Dot saved in a Space, as its tool result reports it. Never holds the file's contents. */
export interface SavedFile {
  id: string;
  spaceId: string;
  name: string;
  kind: FileKind;
  size: number;
  /** The Space's name, for the card. */
  space: string;
}

const FILE_KINDS: readonly string[] = [
  'markdown',
  'html',
  'csv',
  'text',
  'json',
  'image',
  'pdf',
  'download',
];

/** The saved file in a `save_space_file` or `copy_computer_file_to_space` result, or undefined. */
export function parseSavedFile(raw: string | undefined): SavedFile | undefined {
  if (!raw || !raw.includes('"saved"')) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return undefined;
  const { saved, file, space } = data as Record<string, unknown>;
  if (saved !== true || !file || typeof file !== 'object') return undefined;
  const { id, spaceId, name, kind, size } = file as Record<string, unknown>;
  if (
    typeof id !== 'string' ||
    typeof spaceId !== 'string' ||
    typeof name !== 'string' ||
    typeof kind !== 'string' ||
    !FILE_KINDS.includes(kind) ||
    typeof size !== 'number'
  )
    return undefined;
  return {
    id,
    spaceId,
    name,
    kind: kind as FileKind,
    size,
    space: typeof space === 'string' ? space : '',
  };
}

/** A tool result that asks the owner for something (an approval, a handoff), or undefined. */
export function parseApprovalResult(
  raw: string | undefined,
): ApprovalToolResult | undefined {
  if (!raw || !raw.includes('"status"')) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return undefined;
  const record: Record<string, unknown> = Object.fromEntries(
    Object.entries(data),
  );
  const str = (key: string) =>
    typeof record[key] === 'string' ? record[key] : '';
  if (record.status === 'pending_approval')
    return {
      status: 'pending_approval',
      approvalId: str('approvalId'),
      summary: str('summary'),
      exact: str('exact'),
      ...(record.advisory === true ? { advisory: true as const } : {}),
    };
  if (record.status === 'handoff') {
    const kinds = ['credential', 'two_factor', 'captcha', 'other'] as const;
    return {
      status: 'handoff',
      handoffId: str('handoffId'),
      kind: kinds.find((kind) => kind === record.kind) ?? 'other',
      reason: str('reason'),
    };
  }
  return undefined;
}

/**
 * The server-side reason a user message started its turn (a scheduled task, an
 * approval resume, ...), or undefined for a message the owner typed.
 */
export function turnSource(message: Message): TurnSource | undefined {
  if (message.role !== 'user') return undefined;
  const metadata: unknown = message.metadata;
  if (!metadata || typeof metadata !== 'object' || !('source' in metadata))
    return undefined;
  return TURN_SOURCES.find((known) => known === metadata.source);
}

export type TranscriptItem =
  | {
      kind: 'bubble';
      key: string;
      messageId: string;
      role: string;
      content: string;
      /** Group chat: the Dot an owner message was addressed to (@Name). */
      to?: string;
      /** The same owner message again, addressed to the next mentioned Dot. */
      repeat?: boolean;
    }
  | {
      kind: 'event';
      key: string;
      source: TurnSource;
      content: string;
      /** What started the turn: the delegation whose result it delivers, the approval, ... */
      ref?: string;
    }
  | { kind: 'activity'; key: string; calls: ToolCall[] }
  | { kind: 'tools'; key: string; message: AssistantMessage }
  /** A turn's hand-offs to teammates (delegate_to_dot, check_delegation): the work band. */
  | { kind: 'band'; key: string; calls: ToolCall[] }
  | {
      kind: 'approval';
      key: string;
      toolCallId: string;
      result: ApprovalToolResult;
    }
  | { kind: 'receipt'; key: string; call: CallReceipt }
  /** A file a Dot saved in a Space: a card that opens the viewer. */
  | { kind: 'file'; key: string; file: SavedFile };

/** Indexes of the last assistant message of every turn (a turn ends at the next user message). */
function finalAssistantIndexes(messages: Message[]): Set<number> {
  const final = new Set<number>();
  let seenAssistant = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const role = messages[index].role;
    if (role === 'user') seenAssistant = false;
    else if (role === 'assistant') {
      if (!seenAssistant) final.add(index);
      seenAssistant = true;
    }
  }
  return final;
}

function assistantItems(
  message: AssistantMessage,
  final: boolean,
  results: ReadonlyMap<string, string>,
): TranscriptItem[] {
  const actions: TranscriptItem[] = [];
  for (const call of message.toolCalls ?? []) {
    const last = actions.at(-1);
    if (isLaneTool(call.function.name)) {
      if (last?.kind === 'band') last.calls.push(call);
      else
        actions.push({ kind: 'band', key: `band:${call.id}`, calls: [call] });
    } else if (isActivityTool(call.function.name)) {
      if (last?.kind === 'activity') last.calls.push(call);
      else
        actions.push({
          kind: 'activity',
          key: `activity:${call.id}`,
          calls: [call],
        });
    } else if (last?.kind === 'tools') {
      last.message.toolCalls?.push(call);
    } else {
      actions.push({
        kind: 'tools',
        key: `tools:${call.id}`,
        message: { ...message, toolCalls: [call] },
      });
    }
    // The owner's card goes after the action it belongs to (a folded browser
    // step still gets its own card below the activity block).
    const asked = parseApprovalResult(results.get(call.id));
    if (asked)
      actions.push({
        kind: 'approval',
        key: `approval:${call.id}`,
        toolCallId: call.id,
        result: asked,
      });
    const file = parseSavedFile(results.get(call.id));
    if (file) actions.push({ kind: 'file', key: `file:${call.id}`, file });
  }
  const content = typeof message.content === 'string' ? message.content : '';
  if (!content.trim()) return actions;
  const bubble: TranscriptItem = {
    kind: 'bubble',
    key: `${message.id}:text`,
    messageId: message.id,
    role: 'assistant',
    content,
  };
  // An intermediate message's text is what the assistant said before acting.
  if (!final) return [bubble, ...actions];
  // The last message of a turn: actions first, the reply below them. Other
  // tools' own UI (for example a page review waiting for the user) and the
  // work band of its hand-offs stay last.
  let end = actions.length;
  while (
    end > 0 &&
    (actions[end - 1].kind === 'tools' ||
      actions[end - 1].kind === 'band' ||
      actions[end - 1].kind === 'file')
  )
    end--;
  return [...actions.slice(0, end), bubble, ...actions.slice(end)];
}

/** The Dot an owner message was addressed to in a group chat (metadata `to`). */
export function addressedTo(message: Message): string | undefined {
  const metadata: unknown = message.metadata;
  return metadata &&
    typeof metadata === 'object' &&
    'to' in metadata &&
    typeof metadata.to === 'string'
    ? metadata.to
    : undefined;
}

/** The id a server-started turn carries in its metadata (`ref`), if any. */
export function turnRef(message: Message): string | undefined {
  const metadata: unknown = message.metadata;
  return metadata &&
    typeof metadata === 'object' &&
    'ref' in metadata &&
    typeof metadata.ref === 'string'
    ? metadata.ref
    : undefined;
}

/** A text message: the owner's bubble, or an event line when the server started the turn. */
function textItem(message: Message, content: string): TranscriptItem {
  const source = turnSource(message);
  const to = message.role === 'user' ? addressedTo(message) : undefined;
  const ref = source ? turnRef(message) : undefined;
  return source
    ? {
        kind: 'event',
        key: `${message.id}:text`,
        source,
        content,
        ...(ref ? { ref } : {}),
      }
    : {
        kind: 'bubble',
        key: `${message.id}:text`,
        messageId: message.id,
        role: message.role,
        content,
        ...(to ? { to } : {}),
      };
}

export function buildTranscriptItems(
  messages: Message[],
  receipts: CallReceipt[],
  results: ReadonlyMap<string, string> = toolResults(messages),
): TranscriptItem[] {
  const ids = new Set(messages.map((message) => message.id));
  const items: TranscriptItem[] = receipts
    .filter((call) => !call.anchorMessageId || !ids.has(call.anchorMessageId))
    .map((call) => ({ kind: 'receipt', key: `receipt:${call.id}`, call }));
  const final = finalAssistantIndexes(messages);
  messages.forEach((message, index) => {
    const incoming: TranscriptItem[] =
      message.role === 'assistant'
        ? assistantItems(message, final.has(index), results)
        : typeof message.content === 'string' && message.content.trim()
          ? [textItem(message, message.content)]
          : [];
    for (const item of incoming) {
      const last = items.at(-1);
      if (item.kind === 'activity' && last?.kind === 'activity')
        last.calls.push(...item.calls);
      else if (item.kind === 'band' && last?.kind === 'band')
        last.calls.push(...item.calls);
      else {
        // One message to several Dots is stored once per Dot; show it once.
        if (item.kind === 'bubble' && item.to) {
          const previous = items.findLast(
            (entry) => entry.kind === 'bubble' && entry.role === 'user',
          );
          if (
            previous?.kind === 'bubble' &&
            previous.to &&
            previous.to !== item.to &&
            previous.content === item.content
          )
            item.repeat = true;
        }
        items.push(item);
      }
    }
    for (const call of receipts)
      if (call.anchorMessageId === message.id)
        items.push({ kind: 'receipt', key: `receipt:${call.id}`, call });
  });
  return items;
}

/** Tool results by tool call id, from `role: "tool"` messages. */
export function toolResults(messages: Message[]): Map<string, string> {
  const results = new Map<string, string>();
  for (const message of messages)
    if (message.role === 'tool' && typeof message.content === 'string')
      results.set(message.toolCallId, message.content);
  return results;
}

/** Approval ids of every `pending_approval` tool result, in conversation order. */
export function approvalIds(results: ReadonlyMap<string, string>): string[] {
  const ids: string[] = [];
  for (const raw of results.values()) {
    const asked = parseApprovalResult(raw);
    if (asked?.status === 'pending_approval' && asked.approvalId)
      ids.push(asked.approvalId);
  }
  return ids;
}

/** Handoff ids of every `handoff` tool result, in conversation order. */
export function handoffIds(results: ReadonlyMap<string, string>): string[] {
  const ids: string[] = [];
  for (const raw of results.values()) {
    const asked = parseApprovalResult(raw);
    if (asked?.status === 'handoff' && asked.handoffId)
      ids.push(asked.handoffId);
  }
  return ids;
}

export function computerCallIds(messages: Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages)
    if (message.role === 'assistant')
      for (const call of message.toolCalls ?? [])
        if (isComputerTool(call.function.name)) ids.add(call.id);
  return ids;
}

/**
 * Decides when the computer side panel opens by itself: once per turn, the
 * first time a computer call appears that was not already in the conversation
 * when the turn began. Calls loaded with old history never trigger it.
 */
export class ComputerAutoOpen {
  private baseline: Set<string> | null = null;
  private opened = false;
  beginTurn(messages: Message[]) {
    this.baseline = computerCallIds(messages);
    this.opened = false;
  }
  endTurn() {
    this.baseline = null;
  }
  /** True exactly once per turn, when a new computer call shows up. */
  shouldOpen(messages: Message[]): boolean {
    if (!this.baseline || this.opened) return false;
    for (const id of computerCallIds(messages))
      if (!this.baseline.has(id)) {
        this.opened = true;
        return true;
      }
    return false;
  }
}
