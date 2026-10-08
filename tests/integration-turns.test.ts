// The turn lock, durable resumes and the scheduler exclusions, wired the way the server wires them:
// a real Platform (turn registry, approvals, handoffs, resume queue) on temp-dir SQLite files, a fake
// model behind `fetch` and a fake computer. No Docker, network or model key is involved.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { createApp } from '../src/server/app.js';
import { DotAgent } from '../src/server/dot-agent.js';
import { Platform } from '../src/server/platform.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { completion } from './fixtures/model-stream.js';
import { FakeComputer, fakeTransport } from './fixtures/fake-computer.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
type Reply = (init: RequestInit | undefined) => Response | Promise<Response>;

const toolCall = (id: string, name: string, args: Record<string, unknown>) =>
  completion(
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    'tool_calls',
  );
const text = (content: string) => completion({ role: 'assistant', content });
const rm = { command: 'rm -rf build' };

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A model reply that waits for the gate, and gives up when the request is aborted. */
const afterGate =
  (gate: Promise<unknown>, reply: Reply, arrived?: () => void): Reply =>
  async (init) => {
    arrived?.();
    await Promise.race([
      gate,
      new Promise<never>((_, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('The model request was aborted.')),
        ),
      ),
    ]);
    return reply(init);
  };

interface Booted {
  store: Store;
  workspace: WorkspaceStore;
  platform: Platform;
  close(): Promise<void>;
}

const dirs: string[] = [];
const booted: Booted[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  // Close every database before deleting the directory: Windows refuses to remove open files.
  for (const instance of booted.splice(0).reverse()) await instance.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** One data directory with a fake model and a fake computer; `boot` starts a platform on its files. */
function rig(options: { config?: Partial<PlatformConfig> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fulldots-turns-'));
  dirs.push(dir);
  const path = join(dir, 'fulldots.sqlite');
  const fake = new FakeComputer();
  const config: PlatformConfig = {
    apiKey: 'fixture',
    model: 'custom-model',
    baseUrl: 'https://unused.invalid/v1',
    voiceName: 'marin',
    computerSupervisorUrl: 'http://127.0.0.1:4312',
    computerSupervisorToken: 'supervisor-secret',
    computerToken: 'master-secret',
    ...options.config,
  };
  const requests: Json[] = [];
  const queue: Reply[] = [];
  let dotId = '';
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (!String(input).startsWith('https://unused.invalid'))
      return fakeTransport(fake, dotId)(input, init);
    requests.push(JSON.parse(String(init?.body)));
    const reply = queue.shift();
    if (!reply) throw new Error('Unexpected model request.');
    return reply(init);
  });
  function boot(): Booted {
    const store = new Store(path);
    const workspace = new WorkspaceStore(path, 'owner');
    const platform = new Platform(store, workspace, config, path);
    let closed = false;
    const instance: Booted = {
      store,
      workspace,
      platform,
      async close() {
        if (closed) return;
        closed = true;
        await platform.stop();
        store.close();
        workspace.close();
      },
    };
    booted.push(instance);
    dotId = workspace.dots()[0].id;
    return instance;
  }
  const first = boot();
  const dot = first.workspace.dots()[0];
  first.workspace.computers.patch(dot.id, {
    enabled: true,
    browser: true,
    files: true,
    shell: true,
  });
  for (const id of ['t1', 't2'])
    first.workspace.bindThread(id, dot.id, `Thread ${id}`);
  const signal = () => new AbortController().signal;
  return { ...first, boot, dot, fake, config, requests, queue, signal, path };
}

const chatInput = (threadId: string, content: string): RunAgentInput => ({
  threadId,
  runId: `run-${threadId}`,
  state: {},
  context: [],
  messages: [{ id: `user-${threadId}`, role: 'user', content }],
  tools: [],
  forwardedProps: {},
});
const errorsOf = (events: BaseEvent[]) =>
  events
    .filter((event) => event.type === EventType.RUN_ERROR)
    .map((event) => (event as BaseEvent & { message: string }).message);

describe('turn lock with the real wiring', () => {
  it('rejects a second concurrent turn of one Dot before it reaches the model or the computer', async () => {
    const f = rig();
    const gate = deferred();
    f.queue.push(
      afterGate(gate.promise, () => toolCall('look', 'computer_snapshot', {})),
      () => text('First thread done.'),
    );
    const first = f.platform.turn('t1', 'Look at the page.', f.signal());
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    expect(
      f.platform.turns.running().map((turn) => [turn.threadId, turn.source]),
    ).toEqual([['t1', 'chat']]);

    const callsBefore = [...f.fake.calls];
    await expect(f.platform.turn('t2', 'Me too.', f.signal())).rejects.toThrow(
      /busy with/,
    );
    // The second turn never asked the model for anything and never touched the computer.
    expect(f.requests).toHaveLength(1);
    expect(f.fake.calls).toEqual(callsBefore);
    expect(f.platform.turns.isDotBusy(f.dot.id)).toBe(true);
    expect(
      f.platform.runner
        .getThreadMessages('t2')
        .filter((message) => message.role !== 'user'),
    ).toEqual([]);

    gate.resolve();
    expect(await first).toBe('First thread done.');
    expect(f.fake.count_of('snapshot')).toBe(1);
    expect(f.platform.turns.running()).toEqual([]);

    // The lock is gone: the other thread can run now.
    f.queue.push(() => text('Second thread done.'));
    expect(await f.platform.turn('t2', 'My turn.', f.signal())).toBe(
      'Second thread done.',
    );
    expect(f.requests).toHaveLength(3);
  });

  it('answers a chat turn with RUN_ERROR "busy with" while a task turn runs, and keeps the task running', async () => {
    const f = rig();
    const gate = deferred();
    f.queue.push(
      afterGate(gate.promise, () => text('Task finished.')),
      () => text('Never sent.'),
    );
    const task = f.platform.turn('t1', 'Run the scheduled work.', f.signal(), {
      source: 'task',
      ref: 'task-1',
    });
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.platform.turns.running()[0]).toMatchObject({
      threadId: 't1',
      source: 'task',
    });

    const chat = new DotAgent(
      f.store,
      f.workspace,
      f.config,
      f.dot.id,
      f.platform.services(),
    );
    const events = await lastValueFrom(
      chat.run(chatInput('t2', 'Are you free?')).pipe(toArray()),
    );
    expect(errorsOf(events)).toHaveLength(1);
    expect(errorsOf(events)[0]).toMatch(/busy with background work \(task\)/);
    expect(f.requests).toHaveLength(1);
    // The failed attempt did not free (or take over) the lock.
    expect(f.platform.turns.running()[0]).toMatchObject({ threadId: 't1' });

    gate.resolve();
    expect(await task).toBe('Task finished.');
    expect(f.platform.turns.running()).toEqual([]);
    // The unused reply is still in the queue.
    expect(f.queue).toHaveLength(1);
  });

  it('stops a running turn through POST /api/dots/:id/turn/stop', async () => {
    const f = rig();
    const app = createApp({
      store: f.store,
      runner: new Runner(f.store, { mode: 'live', baseUrl: 'https://x.test' }),
      config: { mode: 'live', baseUrl: 'https://x.test' },
      platform: f.platform,
    });
    const stop = () =>
      app.request(`/api/dots/${f.dot.id}/turn/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    expect(await (await stop()).json()).toEqual({ stopped: false });

    f.queue.push(afterGate(new Promise(() => {}), () => text('Never.')));
    const turn = f.platform.turn('t1', 'Take your time.', f.signal());
    const settled = turn.then(
      () => 'resolved',
      () => 'rejected',
    );
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    expect(f.platform.turns.isDotBusy(f.dot.id)).toBe(true);

    const response = await stop();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopped: true });
    // A stopped turn gives its Dot back, and a new one can start.
    expect(await settled).toBe('rejected');
    await vi.waitFor(() =>
      expect(f.platform.turns.isDotBusy(f.dot.id)).toBe(false),
    );
    expect(await (await stop()).json()).toEqual({ stopped: false });
    f.queue.push(() => text('Back again.'));
    expect(await f.platform.turn('t1', 'Hello again.', f.signal())).toBe(
      'Back again.',
    );
  });
});

describe('two Dots on one SQLite file (spike 3)', () => {
  it('run at the same time, and both conversations are stored', async () => {
    const f = rig();
    const second = f.workspace.createDot(
      f.workspace.spaces()[0].id,
      'Second',
      'Answer briefly.',
      true,
      true,
    );
    f.workspace.bindThread('other', second.id, 'Other');
    const gate = deferred();
    let arrived = 0;
    const reply = (answer: string) =>
      afterGate(
        gate.promise,
        () => text(answer),
        () => (arrived += 1),
      );
    f.queue.push(reply('Answer one.'), reply('Answer two.'));

    const one = f.platform.turn('t1', 'Question one.', f.signal());
    const two = f.platform.turn('other', 'Question two.', f.signal());
    await vi.waitFor(() => expect(arrived).toBe(2));
    expect(f.platform.turns.running()).toHaveLength(2);
    expect(f.platform.turns.running().map((turn) => turn.dotId)).toEqual(
      expect.arrayContaining([f.dot.id, second.id]),
    );
    // Writes through the other connections while both runs are open do not trip over the runner's.
    f.store.createTask('A task made during the overlap.');
    f.workspace.renameThread('t2', 'Renamed during the overlap');

    gate.resolve();
    const answers = await Promise.all([one, two]);
    expect([...answers].sort()).toEqual(['Answer one.', 'Answer two.']);
    expect(
      f.platform.runner
        .listThreads()
        .map((thread) => thread.id)
        .sort(),
    ).toEqual(['other', 't1']);
    for (const threadId of ['t1', 'other'])
      expect(
        f.platform.runner
          .getThreadMessages(threadId)
          .map((message) => message.role),
      ).toEqual(['user', 'assistant']);
    expect(f.platform.turns.running()).toEqual([]);
  });
});

/** Runs a destructive command that needs approval; returns the pending approval. */
async function askForApproval(f: ReturnType<typeof rig>, threadId = 't1') {
  f.queue.push(
    () => toolCall('c1', 'computer_exec', rm),
    () => text('I am waiting for your approval to delete the build folder.'),
  );
  await f.platform.turn(threadId, 'Clean the build folder.', f.signal());
  const [pending] = f.workspace.approvals.list({ status: 'pending' });
  expect(pending).toBeDefined();
  expect(f.fake.count_of('exec')).toBe(0);
  return pending;
}

describe('approvals with the server wired in', () => {
  it('re-enqueues a durable resume marker on a new Platform over the same files', async () => {
    const f = rig();
    const pending = await askForApproval(f);

    // The owner approves while the Dot is busy (a turn is running), so the resume cannot be delivered...
    f.platform.turns.acquire(f.dot.id, 't2', 'chat', () => {});
    f.platform.approvals.decide(pending.id, 'approve');
    const [marker] = f.workspace.resumes.all();
    expect(marker).toMatchObject({
      kind: 'approval',
      refId: pending.id,
      threadId: 't1',
      dotId: f.dot.id,
      source: 'approval',
      attempts: 0,
    });
    expect(f.requests).toHaveLength(2);
    // ...and the process dies with the marker (and the decision) on disk.
    await f.close();

    const next = f.boot();
    expect(next.workspace.resumes.all()).toHaveLength(1);
    expect(next.workspace.approvals.get(pending.id)?.status).toBe('approved');
    f.queue.push(
      () => toolCall('c2', 'computer_exec', rm),
      () => text('The build folder is gone.'),
    );
    await next.platform.start();
    await vi.waitFor(() =>
      expect(next.workspace.resumes.all()).toHaveLength(0),
    );

    // The command ran exactly once, on the approval, and the approval was used up.
    expect(f.fake.count_of('exec')).toBe(1);
    expect(next.workspace.approvals.get(pending.id)?.status).toBe('consumed');
    expect(next.workspace.approvals.list({ status: 'pending' })).toEqual([]);
    const stored = next.platform.runner.getThreadMessages('t1');
    expect(stored.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'The build folder is gone.',
    });
    expect(
      stored.find(
        (message) =>
          message.role === 'user' &&
          message.content ===
            `Approval ${pending.id} granted for: ${pending.summary}. Perform exactly that action now.`,
      ),
    ).toMatchObject({ metadata: { source: 'approval', ref: pending.id } });
    expect(next.platform.turns.running()).toEqual([]);
  });

  /** The owner approves while another turn runs on the thread: the resume is deferred, untouched. */
  async function approveWhileRunning(f: ReturnType<typeof rig>) {
    await f.platform.start();
    const pending = await askForApproval(f);
    const gate = deferred();
    f.queue.push(
      afterGate(gate.promise, () => text('Still here.')),
      () => toolCall('c2', 'computer_exec', rm),
      () => text('The build folder is gone.'),
    );
    const running = f.platform.turn('t1', 'Anything new?', f.signal());
    await vi.waitFor(() => expect(f.requests).toHaveLength(3));
    f.platform.approvals.decide(pending.id, 'approve');
    expect(f.workspace.resumes.all()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Deferred, not failed: no resume turn ran and the marker has no failed attempt.
    expect(f.requests).toHaveLength(3);
    expect(f.workspace.resumes.all()[0]).toMatchObject({
      attempts: 0,
      lastError: null,
    });
    expect(f.fake.count_of('exec')).toBe(0);
    gate.resolve();
    expect(await running).toBe('Still here.');
    return pending;
  }
  const expectResumed = (f: ReturnType<typeof rig>, approvalId: string) => {
    expect(f.workspace.resumes.all()).toHaveLength(0);
    expect(f.fake.count_of('exec')).toBe(1);
    expect(f.workspace.approvals.get(approvalId)?.status).toBe('consumed');
    expect(f.requests).toHaveLength(5);
    expect(
      f.platform.runner
        .getThreadMessages('t1')
        .filter((message) => message.role === 'assistant')
        .at(-1),
    ).toMatchObject({ content: 'The build folder is gone.' });
  };

  it('defers the resume of an approval given mid-run and delivers it once the thread is free', async () => {
    const f = rig();
    const pending = await approveWhileRunning(f);
    const [marker] = f.workspace.resumes.all();
    expect(await f.platform.resumes.attempt(marker.id)).toBe('delivered');
    expectResumed(f, pending.id);
  });

  // The Dot lock is released in DotAgent's teardown, a moment before SqliteAgentRunner.run() clears its
  // own "active" entry for the thread, so the release-triggered attempt can see "Thread already
  // running". ResumeQueue retries such a deferral shortly instead of waiting for the 30 second sweep.
  it('delivers that resume on the release of the lock, without waiting for the sweep', async () => {
    const f = rig();
    const pending = await approveWhileRunning(f);
    await vi.waitFor(() => expect(f.workspace.resumes.all()).toHaveLength(0), {
      timeout: 3000,
    });
    expectResumed(f, pending.id);
  });

  it('does not re-run a scheduled task while its conversation has a pending approval', async () => {
    const f = rig();
    const task = f.store.createTask('Clean the build folder every night.');
    f.workspace.bindTask(task.id, 't1');
    let executions = 0;
    const runner = new Runner(
      f.store,
      { mode: 'live', baseUrl: 'https://x.test' },
      async (claim, _memories, signal) => {
        executions += 1;
        // Like the server: the first run is a real turn in the task's conversation.
        const reply =
          executions === 1
            ? await f.platform.turn('t1', claim.prompt, signal, {
                source: 'task',
                ref: claim.id,
              })
            : 'Ran again.';
        return { text: reply, sources: [], sample: false };
      },
      90_000,
      { excluded: () => f.workspace.taskIdsFor(f.platform.turns.exclusions()) },
    );

    f.queue.push(
      () => toolCall('c1', 'computer_exec', rm),
      () => text('Waiting for your approval.'),
    );
    await runner.tick();
    expect(executions).toBe(1);
    expect(f.store.task(task.id)?.status).toBe('completed');
    const [pending] = f.workspace.approvals.list({ status: 'pending' });
    expect(pending).toMatchObject({ threadId: 't1' });

    // The task is queued again, but its conversation is waiting for the owner.
    f.store.action(task.id, 'run');
    const exclusions = f.platform.turns.exclusions();
    expect(exclusions.threadIds).toContain('t1');
    const excluded = f.workspace.taskIdsFor(exclusions);
    expect(excluded).toEqual([task.id]);
    expect(f.store.claim(Date.now(), 60_000, excluded)).toBeNull();
    await runner.tick();
    expect(executions).toBe(1);
    expect(f.store.task(task.id)?.status).toBe('queued');

    // Decided: the resume turn runs in the conversation, and the task can run again afterwards.
    f.queue.push(() => text('Understood, I will not delete it.'));
    f.platform.approvals.decide(pending.id, 'deny', 'Not now.');
    await vi.waitFor(() => expect(f.workspace.resumes.all()).toHaveLength(0));
    expect(f.platform.turns.exclusions().threadIds).not.toContain('t1');
    expect(f.workspace.taskIdsFor(f.platform.turns.exclusions())).toEqual([]);
    await runner.tick();
    expect(executions).toBe(2);
    expect(f.store.task(task.id)?.status).toBe('completed');
    expect(f.fake.count_of('exec')).toBe(0);
    // The decision was written to the task's activity.
    expect(
      f.store.detail(task.id)?.events.map((event) => event.text),
    ).toContain(`Approval ${pending.id} denied; resumed in conversation.`);
  });
});
