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

export function isComputerTool(name: string): boolean {
  return name.startsWith('computer_');
}

/** Tools whose calls fold into the compact activity block: the computer and connector tools. */
export function isActivityTool(name: string): boolean {
  return isComputerTool(name) || name.startsWith('mcp__');
}

export type ApprovalToolResult = PendingApprovalResult | HandoffResult;

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
  | { kind: 'bubble'; key: string; role: string; content: string }
  | { kind: 'event'; key: string; source: TurnSource; content: string }
  | { kind: 'activity'; key: string; calls: ToolCall[] }
  | { kind: 'tools'; key: string; message: AssistantMessage }
  | {
      kind: 'approval';
      key: string;
      toolCallId: string;
      result: ApprovalToolResult;
    }
  | { kind: 'receipt'; key: string; call: CallReceipt };

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
    if (isActivityTool(call.function.name)) {
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
  }
  const content = typeof message.content === 'string' ? message.content : '';
  if (!content.trim()) return actions;
  const bubble: TranscriptItem = {
    kind: 'bubble',
    key: `${message.id}:text`,
    role: 'assistant',
    content,
  };
  // An intermediate message's text is what the assistant said before acting.
  if (!final) return [bubble, ...actions];
  // The last message of a turn: actions first, the reply below them. Other
  // tools' own UI (for example a page review waiting for the user) stays last.
  let end = actions.length;
  while (end > 0 && actions[end - 1].kind === 'tools') end--;
  return [...actions.slice(0, end), bubble, ...actions.slice(end)];
}

/** A text message: the owner's bubble, or an event line when the server started the turn. */
function textItem(message: Message, content: string): TranscriptItem {
  const source = turnSource(message);
  return source
    ? { kind: 'event', key: `${message.id}:text`, source, content }
    : {
        kind: 'bubble',
        key: `${message.id}:text`,
        role: message.role,
        content,
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
      else items.push(item);
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
