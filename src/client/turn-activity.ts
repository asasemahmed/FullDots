// What a running turn is doing right now, read from its messages: still thinking, writing the
// reply, or using a tool. The chat header draws the Dot and words its status from it.
import type { Message } from '@ag-ui/core';
import { toolStepLabel } from '../shared/step-label';

export type TurnActivity =
  | { kind: 'thinking' }
  | { kind: 'typing' }
  | { kind: 'using-tool'; label: string };

export function turnActivity(messages: readonly Message[]): TurnActivity {
  const last = messages.at(-1);
  if (!last || last.role !== 'assistant') return { kind: 'thinking' };
  const answered = new Set(
    messages
      .filter((message) => message.role === 'tool')
      .map((message) => (message as { toolCallId?: string }).toolCallId),
  );
  const pending = last.toolCalls?.find((call) => !answered.has(call.id));
  if (pending)
    return { kind: 'using-tool', label: toolStepLabel(pending.function.name) };
  if (typeof last.content === 'string' && last.content.trim())
    return { kind: 'typing' };
  return { kind: 'thinking' };
}

/** The status line under the Dot's name while a turn runs. */
export function activityText(activity: TurnActivity): string {
  switch (activity.kind) {
    case 'thinking':
      return 'Thinking…';
    case 'typing':
      return 'Writing…';
    case 'using-tool':
      return `${activity.label}…`;
  }
}
