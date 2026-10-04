import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastValueFrom, toArray } from 'rxjs';
import { Observable } from 'rxjs';
import { AbstractAgent, type BaseEvent, type Message } from '@ag-ui/client';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import {
  SqliteAgentRunner,
  ThreadRunningError,
} from '../src/server/sqlite-runner.js';
import { runThreadTurn } from '../src/server/headless.js';

class EchoAgent extends AbstractAgent {
  constructor(private reply = 'Hello back') {
    super({ agentId: 'dot-1' });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const messageId = `reply-${input.runId}`;
      for (const event of [
        {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        },
        { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: this.reply },
        { type: EventType.TEXT_MESSAGE_END, messageId },
        {
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        },
      ])
        subscriber.next(event as BaseEvent);
      subscriber.complete();
    });
  }
}

const dirs: string[] = [];
afterEach(() =>
  dirs
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);
function databasePath() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-runner-'));
  dirs.push(dir);
  return join(dir, 'chat.sqlite');
}
function input(
  threadId: string,
  runId: string,
  messages: Message[],
): RunAgentInput {
  return {
    threadId,
    runId,
    messages,
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  };
}

it('persists conversations across runner restarts and serves local thread endpoints', async () => {
  const path = databasePath();
  const first = new SqliteAgentRunner(path);
  const agent = new EchoAgent();
  const user: Message = { id: 'user-1', role: 'user', content: 'Hi' };
  agent.setMessages([user]);
  agent.threadId = 'thread-1';
  await lastValueFrom(
    first
      .run({
        threadId: 'thread-1',
        agent,
        input: input('thread-1', 'run-1', [user]),
      })
      .pipe(toArray()),
  );
  first.close();

  const second = new SqliteAgentRunner(path);
  expect(second.listThreads()).toMatchObject([
    { id: 'thread-1', agentId: 'dot-1' },
  ]);
  expect(
    second.getThreadMessages('thread-1').map((m) => [m.role, m.content]),
  ).toEqual([
    ['user', 'Hi'],
    ['assistant', 'Hello back'],
  ]);
  const replay = await lastValueFrom(
    second.connect({ threadId: 'thread-1' }).pipe(toArray()),
  );
  expect(replay.some((event) => event.type === EventType.RUN_STARTED)).toBe(
    true,
  );
  expect(await second.isRunning({ threadId: 'thread-1' })).toBe(false);
  second.close();
});

it('runs server-side turns with the stored history and returns the reply', async () => {
  const runner = new SqliteAgentRunner(databasePath());
  const first = await runThreadTurn(
    runner,
    new EchoAgent('One'),
    'thread-2',
    'First',
    AbortSignal.timeout(5000),
  );
  const second = await runThreadTurn(
    runner,
    new EchoAgent('Two'),
    'thread-2',
    'Second',
    AbortSignal.timeout(5000),
  );
  expect([first, second]).toEqual(['One', 'Two']);
  expect(runner.getThreadMessages('thread-2').map((m) => m.content)).toEqual([
    'First',
    'One',
    'Second',
    'Two',
  ]);
  runner.close();
});

class GatedAgent extends AbstractAgent {
  release = () => {};
  private onReady = () => {};
  ready = new Promise<void>((resolve) => (this.onReady = resolve));
  constructor() {
    super({ agentId: 'dot-1' });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const started = {
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent;
      subscriber.next(started);
      this.onReady();
      this.release = () => {
        const messageId = `reply-${input.runId}`;
        for (const event of [
          { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: 'Done' },
          { type: EventType.TEXT_MESSAGE_END, messageId },
          {
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          },
        ])
          subscriber.next(event as BaseEvent);
        subscriber.complete();
      };
    });
  }
}

it('deletes one thread and refuses while that thread is running', async () => {
  const runner = new SqliteAgentRunner(databasePath());
  for (const id of ['keep', 'drop'])
    await runThreadTurn(
      runner,
      new EchoAgent(),
      id,
      `Hello ${id}`,
      AbortSignal.timeout(5000),
    );
  const gated = new GatedAgent();
  const running = runThreadTurn(
    runner,
    gated,
    'drop',
    'Still working',
    AbortSignal.timeout(5000),
  );
  expect(await runner.isRunning({ threadId: 'drop' })).toBe(true);
  expect(() => runner.deleteThread('drop')).toThrow(ThreadRunningError);
  expect(runner.getThreadMessages('drop').length).toBeGreaterThan(0);
  await gated.ready;
  gated.release();
  await running;

  runner.deleteThread('drop');
  expect(runner.listThreads().map((thread) => thread.id)).toEqual(['keep']);
  expect(runner.getThreadMessages('drop')).toEqual([]);
  expect(runner.getThreadEvents('drop')).toEqual([]);
  expect(runner.getThreadMessages('keep').length).toBeGreaterThan(0);
  expect(() => runner.deleteThread('never-existed')).not.toThrow();
  runner.close();
});
