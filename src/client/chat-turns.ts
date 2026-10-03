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
import type { CallReceipt } from '../shared/types';

export function isComputerTool(name: string): boolean {
  return name.startsWith('computer_');
}

export type TranscriptItem =
  | { kind: 'bubble'; key: string; role: string; content: string }
  | { kind: 'activity'; key: string; calls: ToolCall[] }
  | { kind: 'tools'; key: string; message: AssistantMessage }
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
): TranscriptItem[] {
  const actions: TranscriptItem[] = [];
  for (const call of message.toolCalls ?? []) {
    const last = actions.at(-1);
    if (isComputerTool(call.function.name)) {
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

export function buildTranscriptItems(
  messages: Message[],
  receipts: CallReceipt[],
): TranscriptItem[] {
  const ids = new Set(messages.map((message) => message.id));
  const items: TranscriptItem[] = receipts
    .filter((call) => !call.anchorMessageId || !ids.has(call.anchorMessageId))
    .map((call) => ({ kind: 'receipt', key: `receipt:${call.id}`, call }));
  const final = finalAssistantIndexes(messages);
  messages.forEach((message, index) => {
    const incoming: TranscriptItem[] =
      message.role === 'assistant'
        ? assistantItems(message, final.has(index))
        : typeof message.content === 'string' && message.content.trim()
          ? [
              {
                kind: 'bubble',
                key: `${message.id}:text`,
                role: message.role,
                content: message.content,
              },
            ]
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
