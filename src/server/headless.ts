import type { AbstractAgent, Message } from '@ag-ui/client';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { randomUUID } from 'node:crypto';
import type { TurnMetadata } from '../shared/types.js';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt.js';
import type { SqliteAgentRunner } from './sqlite-runner.js';

export function currentTurnText(messages: Message[], error?: Error): string {
  if (error) throw error;
  const content = messages
    .filter((message) => message.role === 'assistant')
    .at(-1)?.content;
  if (typeof content !== 'string' || !content.trim())
    throw new Error('The current compute turn returned no assistant response.');
  return content;
}

// Runs one server-side turn (voice compute, call receipts, scheduled tasks) in
// process, through the same runner that persists browser chat turns.
export function runThreadTurn(
  runner: SqliteAgentRunner,
  agent: AbstractAgent,
  threadId: string,
  prompt: string,
  signal: AbortSignal,
  metadata?: TurnMetadata | Record<string, unknown>,
): Promise<string> {
  signal.throwIfAborted();
  const history = runner.getThreadMessages(threadId);
  const message = {
    id: `${metadata?.opendotsSource === 'voice_receipt' ? voiceReceiptMessagePrefix : ''}${randomUUID()}`,
    role: 'user',
    content: prompt,
    ...(metadata ? { metadata } : {}),
  } as Message;
  const messages = [...history, message];
  const known = new Set(messages.map((item) => item.id));
  agent.setMessages(messages);
  agent.threadId = threadId;
  const input: RunAgentInput = {
    threadId,
    runId: randomUUID(),
    messages,
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
  return new Promise<string>((resolve, reject) => {
    let runError: Error | undefined;
    const stop = () => void runner.stop({ threadId, runId: input.runId });
    signal.addEventListener('abort', stop, { once: true });
    const done = () => signal.removeEventListener('abort', stop);
    try {
      runner.run({ threadId, agent, input }).subscribe({
        next: (event) => {
          if (event.type === EventType.RUN_ERROR)
            runError = new Error(
              (event as { message?: string }).message ?? 'The turn failed.',
            );
        },
        error: (error: unknown) => {
          done();
          reject(error);
        },
        complete: () => {
          done();
          try {
            signal.throwIfAborted();
            resolve(
              currentTurnText(
                agent.messages.filter((item) => !known.has(item.id)),
                runError,
              ),
            );
          } catch (error) {
            reject(error);
          }
        },
      });
    } catch (error) {
      done();
      reject(error);
    }
  });
}
