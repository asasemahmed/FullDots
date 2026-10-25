import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { expect, it } from 'vitest';
import { Observable, lastValueFrom, of, toArray } from 'rxjs';
import { AbstractAgent } from '@ag-ui/client';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { BuiltInAgent } from '@copilotkit/runtime/v2';
import { SqliteAgentRunner } from '../src/server/sqlite-runner.js';

const require = createRequire(import.meta.url);

it('shares the protocol modules at the runtime, React, and model-loop boundaries', () => {
  for (const boundary of [
    '@copilotkit/runtime/v2',
    '@copilotkit/react-core/v2',
    '@tanstack/ai',
  ]) {
    const from = createRequire(import.meta.resolve(boundary));
    expect(realpathSync(from.resolve('@ag-ui/core'))).toBe(
      realpathSync(require.resolve('@ag-ui/core')),
    );
    if (boundary !== '@tanstack/ai')
      expect(realpathSync(from.resolve('@ag-ui/client'))).toBe(
        realpathSync(require.resolve('@ag-ui/client')),
      );
  }
  expect(
    new BuiltInAgent({
      type: 'tanstack',
      factory: async function* () {
        yield {
          type: EventType.RUN_FINISHED,
          threadId: 'contract-thread',
          runId: 'contract-run',
        };
      },
    }),
  ).toBeInstanceOf(AbstractAgent);
});

const input: RunAgentInput = {
  threadId: 'contract-thread',
  runId: 'contract-run',
  state: {},
  messages: [
    {
      id: 'owner-message',
      role: 'user',
      content: 'Run the contract check.',
      metadata: { opendotsSource: 'chat' },
    },
  ],
  tools: [],
  context: [],
  forwardedProps: {},
};

class ProgressAgent extends AbstractAgent {
  constructor(private fail = false) {
    super({ agentId: 'contract-dot' });
  }
  run(request: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: request.threadId,
        runId: request.runId,
        input: request,
      } as BaseEvent);
      subscriber.next({
        type: EventType.CUSTOM,
        name: 'coding_agent_progress',
        value: {
          codingSessionId: 'coding-session',
          text: 'Working',
          status: 'running',
        },
      } as BaseEvent);
      if (this.fail) {
        subscriber.next({
          type: EventType.RUN_ERROR,
          message: 'Fixture failure.',
        } as BaseEvent);
        subscriber.error(new Error('Fixture failure.'));
        return;
      }
      subscriber.next({
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: 'contract-reply',
        role: 'assistant',
        delta: 'Saved reply.',
      } as BaseEvent);
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: request.threadId,
        runId: request.runId,
      } as BaseEvent);
      subscriber.complete();
    });
  }
}

it('keeps custom progress, message metadata and text through enforcement and SQLite replay', async () => {
  const runner = new SqliteAgentRunner(':memory:');
  try {
    const agent = new ProgressAgent();
    agent.setMessages(input.messages);
    agent.threadId = input.threadId;
    const live = await lastValueFrom(
      runner.run({ threadId: input.threadId, input, agent }).pipe(toArray()),
    );
    const replay = await lastValueFrom(
      runner.connect({ threadId: input.threadId }).pipe(toArray()),
    );
    for (const events of [live, replay]) {
      expect(events).toContainEqual(
        expect.objectContaining({
          type: EventType.CUSTOM,
          name: 'coding_agent_progress',
          value: {
            codingSessionId: 'coding-session',
            text: 'Working',
            status: 'running',
          },
        }),
      );
      expect(
        events.find((event) => event.type === EventType.RUN_STARTED),
      ).toMatchObject({
        input: {
          messages: [
            expect.objectContaining({ metadata: { opendotsSource: 'chat' } }),
          ],
        },
      });
    }
    expect(runner.getThreadMessages(input.threadId)).toContainEqual(
      expect.objectContaining({ role: 'assistant', content: 'Saved reply.' }),
    );
  } finally {
    runner.close();
  }
});

it('delivers progress and RUN_ERROR before an upstream stream failure', async () => {
  const events: BaseEvent[] = [];
  const agent = new ProgressAgent(true);
  agent.setMessages(input.messages);
  agent.threadId = input.threadId;
  await expect(
    agent.runAgent(input, {
      onEvent: ({ event }) => {
        events.push(event);
      },
    }),
  ).rejects.toThrow('Fixture failure.');
  expect(events).toContainEqual(
    expect.objectContaining({ type: EventType.CUSTOM }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: EventType.RUN_ERROR,
      message: 'Fixture failure.',
    }),
  );
});

it('replaces stale local text with the replayed server snapshot', async () => {
  const first = { id: 'first', role: 'user' as const, content: 'First' };
  const second = {
    id: 'second',
    role: 'assistant' as const,
    content: 'Second',
  };
  const agent = new (class extends AbstractAgent {
    run(request: RunAgentInput): Observable<BaseEvent> {
      return of(
        {
          type: EventType.RUN_STARTED,
          threadId: request.threadId,
          runId: request.runId,
        },
        {
          type: EventType.MESSAGES_SNAPSHOT,
          messages: [{ ...first, content: 'Updated' }, second],
        },
        {
          type: EventType.RUN_FINISHED,
          threadId: request.threadId,
          runId: request.runId,
        },
      );
    }
  })();
  agent.threadId = input.threadId;
  const local = {
    id: 'local',
    role: 'user' as const,
    content: 'Local receipt',
  };
  agent.setMessages([first, local]);
  await agent.runAgent(input);
  expect(agent.messages.map((message) => message.id)).toEqual([
    'first',
    'second',
  ]);
  expect(agent.messages[0].content).toBe('Updated');
});
