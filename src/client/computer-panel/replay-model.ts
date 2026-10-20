// What the Replay tab steps through: the browser steps of a conversation, read from the chat's own
// tool calls and joined with what the server kept (a picture, the page it ended on). Either side
// alone is enough: without pictures the steps still come from the transcript, and without the
// transcript (another Dot's chat is open) the server's list stands on its own.
import type { Message } from '@ag-ui/core';
import type { ReplayStep } from '../../shared/computer-types';
import { toolResults } from '../chat-turns';
import {
  computerActionName,
  computerStepLabel,
  computerToolResult,
  describeComputerSteps,
  type ComputerStepState,
} from '../ComputerToolCard';
import { displayUrl } from './model';

/** Browser tools, in the words of their computer action. Files and the terminal are not replayed. */
const BROWSER_ACTIONS = new Set([
  'navigate',
  'search',
  'click',
  'type',
  'select',
  'key',
  'scroll',
  'snapshot',
  'read',
  'screenshot',
]);

export interface ReplayEntry {
  /** The tool call that made the step. */
  toolCallId: string;
  action: string;
  /** "Clicking in browser" … the same words as the chat's activity block. */
  label: string;
  /** What it acted on: `button “Save”`, an address, a key. */
  detail: string;
  url: string;
  title: string;
  state: ComputerStepState;
  /** Why it failed or stopped, when it did. */
  message: string;
  /** The kept picture of the screen after the step, if any. */
  frameId?: string;
  /** Which turn of the conversation, counting from 1; 0 when only the server knows the step. */
  turn: number;
  createdAt?: number;
}

export const STATE_LABELS: Record<ComputerStepState, string> = {
  running: 'In progress',
  done: 'Done',
  failed: 'Did not work',
  interrupted: 'Stopped',
};

function pageOf(raw: unknown): { url: string; title: string } {
  if (raw === undefined || raw === null) return { url: '', title: '' };
  const data = computerToolResult(raw);
  const page =
    data.page && typeof data.page === 'object'
      ? (data.page as Record<string, unknown>)
      : {};
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  return {
    url: text(page.url) || text(data.url),
    title: text(page.title) || text(data.title),
  };
}

/** The browser steps in a chat's messages, in order, numbered by the user turn they belong to. */
export function transcriptReplaySteps(
  messages: readonly Message[],
  running = false,
): ReplayEntry[] {
  const results = toolResults([...messages]);
  const calls: { id: string; name: string; arguments: string; turn: number }[] =
    [];
  let turn = 0;
  for (const message of messages) {
    if (message.role === 'user') turn++;
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      const name = call.function.name;
      if (
        name.startsWith('computer_') &&
        BROWSER_ACTIONS.has(computerActionName(name))
      )
        calls.push({
          id: call.id,
          name,
          arguments: call.function.arguments,
          turn: Math.max(turn, 1),
        });
    }
  }
  const steps = describeComputerSteps(calls, results, running);
  return calls.map((call, index) => {
    const step = steps[index];
    const page = pageOf(results.get(call.id));
    let url = page.url;
    if (!url && computerActionName(call.name) === 'navigate')
      try {
        const args = JSON.parse(call.arguments) as { url?: unknown };
        if (typeof args.url === 'string') url = args.url;
      } catch {
        // Still streaming.
      }
    return {
      toolCallId: call.id,
      action: computerActionName(call.name),
      label: step.label,
      detail: step.detail,
      url,
      title: page.title,
      state: step.state,
      message: step.message,
      turn: call.turn,
    };
  });
}

/** Joins the transcript's steps with the server's: pictures by tool call, and steps only it has. */
export function mergeReplay(
  transcript: readonly ReplayEntry[],
  server: readonly ReplayStep[],
): ReplayEntry[] {
  const kept = new Map(server.map((step) => [step.toolCallId, step]));
  const merged = transcript.map((entry) => {
    const step = kept.get(entry.toolCallId);
    if (!step) return entry;
    kept.delete(entry.toolCallId);
    return {
      ...entry,
      url: entry.url || step.url,
      title: entry.title || step.title,
      createdAt: step.createdAt,
      ...(step.hasFrame ? { frameId: step.id } : {}),
    };
  });
  const rest = [...kept.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((step): ReplayEntry => ({
      toolCallId: step.toolCallId,
      action: step.action,
      label: computerStepLabel(`computer_${step.action}`),
      detail: step.title || (step.url ? displayUrl(step.url) : ''),
      url: step.url,
      title: step.title,
      state: step.outcome === 'failed' ? 'failed' : 'done',
      message: '',
      turn: 0,
      createdAt: step.createdAt,
      ...(step.hasFrame ? { frameId: step.id } : {}),
    }));
  return [...merged, ...rest];
}

/** The turns that have steps, oldest first. */
export function replayTurns(entries: readonly ReplayEntry[]): number[] {
  return [...new Set(entries.map((entry) => entry.turn))]
    .filter((turn) => turn > 0)
    .sort((a, b) => a - b);
}

/** `turn` 0 means every step. */
export function stepsOfTurn(
  entries: readonly ReplayEntry[],
  turn: number,
): ReplayEntry[] {
  return turn ? entries.filter((entry) => entry.turn === turn) : [...entries];
}

/** The slider's spoken value: "Step 2 of 5: Clicking in browser, button “Save”". */
export function stepText(entry: ReplayEntry, index: number, total: number) {
  return `Step ${index + 1} of ${total}: ${entry.label}${entry.detail ? `, ${entry.detail}` : ''}`;
}

/** Where the slider goes for a key, or undefined for a key it does not use. */
export function nextIndex(
  key: string,
  index: number,
  total: number,
): number | undefined {
  if (!total) return undefined;
  const last = total - 1;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return Math.max(0, index - 1);
    case 'ArrowRight':
    case 'ArrowUp':
      return Math.min(last, index + 1);
    case 'PageDown':
      return Math.max(0, index - 5);
    case 'PageUp':
      return Math.min(last, index + 5);
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return undefined;
  }
}
