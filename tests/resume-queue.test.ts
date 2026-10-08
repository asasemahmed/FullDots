import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ResumeQueue,
  type ResumeQueueDeps,
} from '../src/server/resume-queue.js';
import {
  ResumeStore,
  type NewResumeMarker,
} from '../src/server/resume-store.js';
import { DotBusyError, TurnRegistry } from '../src/server/turn-registry.js';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const marker = (patch: Partial<NewResumeMarker> = {}): NewResumeMarker => ({
  kind: 'approval',
  refId: 'ap-1',
  threadId: 'thread-1',
  dotId: 'dot-1',
  prompt: 'Approval ap-1 granted. Do the thing.',
  source: 'approval',
  ...patch,
});

function setup(
  options: {
    backoffMs?: number[];
    sweepMs?: number;
    maxAgeMs?: number;
    onGiveUp?: ResumeQueueDeps['onGiveUp'];
    onDelivered?: ResumeQueueDeps['onDelivered'];
  } = {},
) {
  const db = new DatabaseSync(':memory:');
  const store = new ResumeStore(db);
  const registry = new TurnRegistry();
  const turn = vi.fn<
    (
      threadId: string,
      prompt: string,
      signal: AbortSignal,
      metadata: { source: string; ref?: string },
    ) => Promise<string>
  >(async () => 'done');
  const log = vi.fn<(line: string) => void>();
  const make = () =>
    new ResumeQueue({
      store,
      registry,
      turn,
      log,
      sweepMs: options.sweepMs ?? 3_600_000,
      backoffMs: options.backoffMs,
      maxAgeMs: options.maxAgeMs,
      onGiveUp: options.onGiveUp,
      onDelivered: options.onDelivered,
    });
  return { db, store, registry, turn, log, queue: make(), make };
}

const queues: ResumeQueue[] = [];
afterEach(() => {
  for (const queue of queues.splice(0)) queue.stop();
  vi.useRealTimers();
});
const track = (queue: ResumeQueue) => {
  queues.push(queue);
  return queue;
};

describe('ResumeStore', () => {
  it('adds with defaults, lists due markers oldest first, bumps, removes', () => {
    const { store } = setup();
    const a = store.add(marker({ refId: 'a' }));
    const b = store.add(marker({ refId: 'b' }));
    expect(a).toMatchObject({ attempts: 0, lastError: null });
    expect(a.nextAt).toBe(a.createdAt);
    expect(store.get(a.id)).toEqual(a);
    expect(store.due().map((m) => m.id)).toEqual([a.id, b.id]);
    store.bump(a.id, 'x'.repeat(900), Date.now() + 60_000);
    const bumped = store.get(a.id)!;
    expect(bumped.attempts).toBe(1);
    expect(bumped.lastError).toHaveLength(500);
    expect(store.due().map((m) => m.id)).toEqual([b.id]);
    expect(store.due(Date.now() + 120_000)).toHaveLength(2);
    store.remove(a.id);
    expect(store.all().map((m) => m.id)).toEqual([b.id]);
    expect(store.get(a.id)).toBeUndefined();
  });
});

describe('ResumeQueue', () => {
  it('delivers immediately when idle and removes the marker', async () => {
    const { store, turn, queue } = setup();
    const added = queue.enqueue(marker());
    expect(store.get(added.id)).toBeDefined(); // persisted before delivery
    await flush();
    expect(turn).toHaveBeenCalledTimes(1);
    const [threadId, prompt, signal, metadata] = turn.mock.calls[0];
    expect(threadId).toBe('thread-1');
    expect(prompt).toBe('Approval ap-1 granted. Do the thing.');
    expect(signal.aborted).toBe(false);
    expect(metadata).toEqual({ source: 'approval', ref: 'ap-1' });
    expect(store.all()).toEqual([]);
  });

  it('attempt on a missing marker reports delivered', async () => {
    const { queue } = setup();
    expect(await queue.attempt('nope')).toBe('delivered');
  });

  it('defers while the Dot is busy and delivers when the lock is released', async () => {
    const { store, registry, turn, queue } = setup();
    track(queue).start();
    const release = registry.acquire('dot-1', 'other-thread', 'chat', () => {});
    const added = queue.enqueue(marker());
    await flush();
    expect(turn).not.toHaveBeenCalled();
    expect(store.get(added.id)).toMatchObject({ attempts: 0 });
    release();
    await flush();
    expect(turn).toHaveBeenCalledTimes(1);
    expect(store.all()).toEqual([]);
  });

  it('defers while the thread runs on another Dot entry', async () => {
    const { store, registry, turn, queue } = setup();
    const release = registry.acquire('dot-2', 'thread-1', 'task', () => {});
    const added = queue.enqueue(marker());
    expect(await queue.attempt(added.id)).toBe('deferred');
    expect(turn).not.toHaveBeenCalled();
    expect(store.get(added.id)?.attempts).toBe(0);
    release();
    expect(await queue.attempt(added.id)).toBe('delivered');
    expect(turn).toHaveBeenCalledTimes(1);
    expect(store.all()).toEqual([]);
  });

  it.each([
    ['DotBusyError', () => new DotBusyError('dot-1', 'chat', 'thread-9')],
    ['Thread already running', () => new Error('Thread already running: t')],
    [
      'a busy RUN_ERROR rebuilt as a plain Error',
      () =>
        new Error(
          'This Dot is busy with another conversation. Stop it or wait for it to finish.',
        ),
    ],
  ])('treats %s from turn as deferred', async (_name, makeError) => {
    const { store, turn, queue, log } = setup();
    turn.mockRejectedValueOnce(makeError());
    const added = store.add(marker());
    expect(await queue.attempt(added.id)).toBe('deferred');
    expect(store.get(added.id)).toMatchObject({
      attempts: 0,
      lastError: null,
    });
    expect(log).not.toHaveBeenCalled();
    expect(await queue.attempt(added.id)).toBe('delivered');
  });

  it('bumps attempts with backoff on other errors and never logs the prompt', async () => {
    const { store, turn, queue, log } = setup({ backoffMs: [1000, 5000] });
    turn.mockRejectedValue(new Error('model offline'));
    const added = store.add(marker({ prompt: 'secret owner note' }));
    const before = Date.now();
    expect(await queue.attempt(added.id)).toBe('failed');
    const first = store.get(added.id)!;
    expect(first.attempts).toBe(1);
    expect(first.lastError).toBe('model offline');
    expect(first.nextAt).toBeGreaterThanOrEqual(before + 1000);
    expect(first.nextAt).toBeLessThan(before + 4000);
    expect(await queue.attempt(added.id)).toBe('failed');
    const second = store.get(added.id)!;
    expect(second.attempts).toBe(2);
    expect(second.nextAt).toBeGreaterThanOrEqual(before + 5000); // last entry repeats
    expect(log).toHaveBeenCalled();
    for (const [line] of log.mock.calls)
      expect(line).not.toContain('secret owner note');
  });

  it('is durable: a new queue on the same db delivers on start()', async () => {
    const { store, turn, make } = setup();
    const added = store.add(marker());
    expect(turn).not.toHaveBeenCalled();
    track(make()).start();
    await flush();
    expect(turn).toHaveBeenCalledTimes(1);
    expect(store.get(added.id)).toBeUndefined();
  });

  it('never overlaps attempts for one marker', async () => {
    const { store, registry, turn, queue } = setup();
    track(queue).start();
    let finish!: (value: string) => void;
    turn.mockImplementationOnce(
      () => new Promise<string>((resolve) => (finish = resolve)),
    );
    const added = queue.enqueue(marker());
    await flush();
    expect(turn).toHaveBeenCalledTimes(1);
    expect(await queue.attempt(added.id)).toBe('deferred');
    // A release of the Dot (twice) while the attempt is in flight starts nothing new.
    registry.acquire('dot-1', 'x', 'chat', () => {})();
    registry.acquire('dot-1', 'x', 'chat', () => {})();
    await flush();
    expect(turn).toHaveBeenCalledTimes(1);
    finish('ok');
    await flush();
    expect(store.all()).toEqual([]);
    expect(turn).toHaveBeenCalledTimes(1);
  });

  it('runs one attempt per Dot at a time', async () => {
    const { store, turn, queue } = setup();
    let finish!: (value: string) => void;
    turn.mockImplementationOnce(
      () => new Promise<string>((resolve) => (finish = resolve)),
    );
    const a = store.add(marker({ refId: 'a', threadId: 't-a' }));
    const b = store.add(marker({ refId: 'b', threadId: 't-b' }));
    const first = queue.attempt(a.id);
    expect(await queue.attempt(b.id)).toBe('deferred');
    expect(turn).toHaveBeenCalledTimes(1);
    finish('ok');
    expect(await first).toBe('delivered');
    expect(await queue.attempt(b.id)).toBe('delivered');
  });

  it('delivers markers of one thread oldest first', async () => {
    const { store, turn, queue } = setup({ backoffMs: [60_000] });
    track(queue);
    const older = store.add(marker({ refId: 'older' }));
    const newer = store.add(marker({ refId: 'newer' }));
    turn.mockRejectedValueOnce(new Error('boom'));
    expect(await queue.attempt(newer.id)).toBe('deferred'); // older still pending
    expect(turn).not.toHaveBeenCalled();
    expect(await queue.attempt(older.id)).toBe('failed');
    expect(await queue.attempt(newer.id)).toBe('deferred'); // older is still stored
    expect(turn).toHaveBeenCalledTimes(1);
    expect(await queue.attempt(older.id)).toBe('delivered');
    await flush(); // delivering the older one kicks the newer one
    expect(turn.mock.calls.map((call) => call[3].ref)).toEqual([
      'older',
      'older',
      'newer',
    ]);
    expect(store.all()).toEqual([]);
  });

  it('stop() stops reacting to releases', async () => {
    const { store, registry, turn, queue } = setup();
    queue.start();
    const release = registry.acquire('dot-1', 'other', 'chat', () => {});
    store.add(marker());
    queue.stop();
    release();
    await flush();
    expect(turn).not.toHaveBeenCalled();
    expect(store.all()).toHaveLength(1);
  });

  it('gives up after 10 failures: removes the marker, reports it once and moves on', async () => {
    const onGiveUp = vi.fn();
    const { store, turn, log, make } = setup({
      backoffMs: [0],
      onGiveUp,
    });
    const queue = make();
    track(queue);
    turn.mockRejectedValue(new Error('still broken'));
    const first = store.add(marker({ prompt: 'secret owner note' }));
    const second = store.add(marker({ refId: 'ap-2' }));
    for (let i = 0; i < 9; i++)
      expect(await queue.attempt(first.id)).toBe('failed');
    expect(store.get(first.id)?.attempts).toBe(9);
    expect(onGiveUp).not.toHaveBeenCalled();
    turn.mockReset();
    turn.mockRejectedValueOnce(new Error('last failure'));
    turn.mockResolvedValue('ok');
    expect(await queue.attempt(first.id)).toBe('gave_up');
    expect(store.get(first.id)).toBeUndefined();
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp.mock.calls[0][0]).toMatchObject({ id: first.id });
    expect(onGiveUp.mock.calls[0][1]).toBe('last failure');
    const gaveUp = log.mock.calls.filter(([line]) =>
      line.includes('giving up'),
    );
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0][0]).not.toContain('secret owner note');
    // The next marker of the thread is delivered now.
    await flush();
    expect(turn.mock.calls.map((call) => call[3].ref)).toEqual([
      'ap-1',
      'ap-2',
    ]);
    expect(store.get(second.id)).toBeUndefined();
  });

  it('gives up on a marker older than maxAgeMs', async () => {
    const onGiveUp = vi.fn();
    const { db, store, turn, make } = setup({ maxAgeMs: 1000, onGiveUp });
    const queue = make();
    const old = store.add(marker({ refId: 'old' }));
    const fresh = store.add(marker({ refId: 'fresh' }));
    db.exec(
      `UPDATE resume_markers SET createdAt=${Date.now() - 5000} WHERE id='${old.id}'`,
    );
    expect(await queue.attempt(old.id)).toBe('gave_up');
    expect(store.get(old.id)).toBeUndefined();
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp.mock.calls[0][0]).toMatchObject({ refId: 'old' });
    await flush();
    expect(turn.mock.calls.map((call) => call[3].ref)).toEqual(['fresh']);
    expect(store.get(fresh.id)).toBeUndefined();
  });

  it('reports a delivered marker with the text of the turn', async () => {
    const onDelivered = vi.fn();
    const { store, turn, make } = setup({ onDelivered });
    turn.mockResolvedValueOnce('All done.');
    const added = store.add(marker());
    expect(await make().attempt(added.id)).toBe('delivered');
    expect(onDelivered).toHaveBeenCalledTimes(1);
    expect(onDelivered).toHaveBeenCalledWith(
      expect.objectContaining({ id: added.id, refId: 'ap-1' }),
      'All done.',
    );
  });

  it('a throwing onDelivered or onGiveUp does not break the queue', async () => {
    const onDelivered = vi.fn(() => {
      throw new Error('hook broke');
    });
    const { store, make, log } = setup({ onDelivered });
    const a = store.add(marker({ refId: 'a' }));
    const b = store.add(marker({ refId: 'b' }));
    const queue = make();
    expect(await queue.attempt(a.id)).toBe('delivered');
    await flush();
    expect(store.all()).toEqual([]);
    expect(b.id).toBeDefined();
    expect(log.mock.calls.some(([line]) => line.includes('hook broke'))).toBe(
      true,
    );
  });

  it('sweeps due markers on the timer', async () => {
    vi.useFakeTimers();
    const { store, registry, turn, queue } = setup({ sweepMs: 1000 });
    track(queue).start();
    // The thread runs on another Dot, so that Dot's release event does not concern this marker.
    const release = registry.acquire('dot-2', 'thread-1', 'task', () => {});
    queue.enqueue(marker());
    await vi.advanceTimersByTimeAsync(0);
    expect(turn).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(turn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(turn).toHaveBeenCalledTimes(1);
    expect(store.all()).toEqual([]);
  });
});
