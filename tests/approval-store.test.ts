import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApprovalStore } from '../src/server/approval-store.js';

let db: DatabaseSync;
let now: number;
let store: ApprovalStore;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  now = 1_000_000;
  store = new ApprovalStore(db, () => now);
});

let counter = 0;
const input = (
  patch: Partial<Parameters<ApprovalStore['create']>[0]> = {},
) => ({
  threadId: 't1',
  dotId: 'd1',
  toolCallId: `call-${++counter}`,
  tool: 'computer_exec',
  argsHash: `hash-${counter}`,
  summary: 'Remove the build folder',
  argsRedacted: 'rm -rf build',
  ttlMs: 60_000,
  ...patch,
});

describe('create and lookup', () => {
  it('creates a pending approval with an expiry', () => {
    const a = store.create(input());
    expect(a.status).toBe('pending');
    expect(a.note).toBeNull();
    expect(a.decidedAt).toBeNull();
    expect(a.consumedAt).toBeNull();
    expect(a.createdAt).toBe(now);
    expect(a.expiresAt).toBe(now + 60_000);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.get(a.id)).toEqual(a);
    expect(store.byToolCall(a.threadId, a.toolCallId)).toEqual(a);
  });
  it('stores a null argsHash for advisory requests', () => {
    const a = store.create(input({ argsHash: null, tool: 'request_approval' }));
    expect(store.get(a.id)?.argsHash).toBeNull();
  });
  it('is idempotent on (threadId, toolCallId)', () => {
    const first = store.create(input({ toolCallId: 'same' }));
    now += 5;
    const second = store.create(
      input({ toolCallId: 'same', summary: 'other' }),
    );
    expect(second).toEqual(first);
    expect(store.list({})).toHaveLength(1);
    const otherThread = store.create(
      input({ toolCallId: 'same', threadId: 't2' }),
    );
    expect(otherThread.id).not.toBe(first.id);
  });
  it('returns undefined for unknown ids', () => {
    expect(store.get('nope')).toBeUndefined();
    expect(store.byToolCall('t1', 'nope')).toBeUndefined();
  });
});

describe('list', () => {
  it('filters and sorts newest first', () => {
    const a = store.create(input());
    now += 10;
    const b = store.create(input({ dotId: 'd2' }));
    now += 10;
    const c = store.create(input({ threadId: 't2' }));
    store.decide(a.id, 'approve');
    expect(store.list({}).map((x) => x.id)).toEqual([c.id, b.id, a.id]);
    expect(store.list({ status: 'pending' }).map((x) => x.id)).toEqual([
      c.id,
      b.id,
    ]);
    expect(store.list({ status: 'approved' }).map((x) => x.id)).toEqual([a.id]);
    expect(store.list({ threadId: 't2' }).map((x) => x.id)).toEqual([c.id]);
    expect(store.list({ dotId: 'd2' }).map((x) => x.id)).toEqual([b.id]);
    expect(store.list({ limit: 2 })).toHaveLength(2);
    expect(store.list({ status: 'denied' })).toEqual([]);
  });
  it('sorts rows created in the same millisecond newest first', () => {
    const a = store.create(input());
    const b = store.create(input());
    expect(store.list({}).map((x) => x.id)).toEqual([b.id, a.id]);
  });
  it('defaults to 100 rows', () => {
    for (let i = 0; i < 105; i++) store.create(input());
    expect(store.list({})).toHaveLength(100);
    expect(store.list({ limit: 500 })).toHaveLength(105);
  });
});

describe('decide', () => {
  it('approves with a note', () => {
    const a = store.create(input());
    now += 7;
    const decided = store.decide(a.id, 'approve', 'go ahead');
    expect(decided.status).toBe('approved');
    expect(decided.note).toBe('go ahead');
    expect(decided.decidedAt).toBe(now);
    expect(store.get(a.id)).toEqual(decided);
  });
  it('denies', () => {
    const a = store.create(input());
    expect(store.decide(a.id, 'deny').status).toBe('denied');
    expect(store.get(a.id)?.note).toBeNull();
  });
  it('throws when the approval is not pending', () => {
    const a = store.create(input());
    store.decide(a.id, 'approve');
    expect(() => store.decide(a.id, 'deny')).toThrow(
      'Approval is not pending.',
    );
    expect(() => store.decide(a.id, 'approve')).toThrow(
      'Approval is not pending.',
    );
    expect(store.get(a.id)?.status).toBe('approved');
    const b = store.create(input());
    store.decide(b.id, 'deny');
    expect(() => store.decide(b.id, 'approve')).toThrow(
      'Approval is not pending.',
    );
  });
  it('throws for an unknown id', () => {
    expect(() => store.decide('nope', 'approve')).toThrow(
      'Approval not found.',
    );
  });
  it('treats a pending approval past its expiry as expired', () => {
    const a = store.create(input({ ttlMs: 1000 }));
    now += 1000;
    expect(() => store.decide(a.id, 'approve')).toThrow(
      'Approval is not pending.',
    );
    expect(store.get(a.id)?.status).toBe('expired');
  });
});

describe('consume', () => {
  it('uses only the named approval when an id is given, and lapses an unused one', () => {
    const a = store.create(input({ argsHash: 'h' }));
    const b = store.create(input({ argsHash: 'h' }));
    store.decide(a.id, 'approve');
    store.decide(b.id, 'approve');
    expect(store.consume('t1', 'h', b.id)?.id).toBe(b.id);
    expect(store.consume('t1', 'h', b.id)).toBeUndefined();
    expect(store.lapse(a.id)).toBe(true);
    expect(store.get(a.id)?.status).toBe('expired');
    expect(store.lapse(a.id)).toBe(false);
    expect(store.lapse(b.id)).toBe(false);
  });
  it('is single use', () => {
    const a = store.create(input({ argsHash: 'h' }));
    store.decide(a.id, 'approve');
    now += 3;
    const consumed = store.consume('t1', 'h');
    expect(consumed?.id).toBe(a.id);
    expect(consumed?.status).toBe('consumed');
    expect(consumed?.consumedAt).toBe(now);
    expect(store.consume('t1', 'h')).toBeUndefined();
    expect(store.get(a.id)?.status).toBe('consumed');
  });
  it('ignores pending and denied approvals', () => {
    const pending = store.create(input({ argsHash: 'h' }));
    expect(store.consume('t1', 'h')).toBeUndefined();
    store.decide(pending.id, 'deny');
    expect(store.consume('t1', 'h')).toBeUndefined();
    expect(store.get(pending.id)?.status).toBe('denied');
  });
  it('ignores other threads and other hashes', () => {
    const a = store.create(input({ argsHash: 'h' }));
    store.decide(a.id, 'approve');
    expect(store.consume('t2', 'h')).toBeUndefined();
    expect(store.consume('t1', 'other')).toBeUndefined();
    expect(store.consume('t1', 'h')?.id).toBe(a.id);
  });
  it('ignores advisory approvals without a hash', () => {
    const a = store.create(input({ argsHash: null }));
    store.decide(a.id, 'approve');
    expect(store.consume('t1', '')).toBeUndefined();
  });
  it('never consumes an approval past its expiry', () => {
    const a = store.create(input({ argsHash: 'h', ttlMs: 1000 }));
    store.decide(a.id, 'approve');
    now += 1000;
    expect(store.consume('t1', 'h')).toBeUndefined();
    expect(store.get(a.id)?.status).toBe('approved');
  });
  it('consumes one approval per call, oldest decision first', () => {
    const a = store.create(input({ argsHash: 'h' }));
    const b = store.create(input({ argsHash: 'h' }));
    now += 1;
    store.decide(b.id, 'approve');
    now += 1;
    store.decide(a.id, 'approve');
    expect(store.consume('t1', 'h')?.id).toBe(b.id);
    expect(store.consume('t1', 'h')?.id).toBe(a.id);
    expect(store.consume('t1', 'h')).toBeUndefined();
  });
});

describe('expire and pendingThreadIds', () => {
  it('expires pending and unused approved approvals past their expiry', () => {
    const early = store.create(input({ ttlMs: 1000 }));
    const late = store.create(input({ ttlMs: 100_000 }));
    const approved = store.create(input({ ttlMs: 1000 }));
    store.decide(approved.id, 'approve');
    const used = store.create(input({ ttlMs: 1000, argsHash: 'used' }));
    store.decide(used.id, 'approve');
    store.consume('t1', 'used');
    now += 5000;
    expect(store.expire()).toBe(2);
    expect(store.get(early.id)?.status).toBe('expired');
    expect(store.get(late.id)?.status).toBe('pending');
    expect(store.get(approved.id)?.status).toBe('expired');
    expect(store.get(used.id)?.status).toBe('consumed');
    expect(store.expire()).toBe(0);
    expect(store.expire(now + 200_000)).toBe(1);
    expect(store.get(late.id)?.status).toBe('expired');
  });
  it('lists distinct threads with live pending approvals', () => {
    store.create(input({ threadId: 'b' }));
    store.create(input({ threadId: 'b' }));
    store.create(input({ threadId: 'a' }));
    const decided = store.create(input({ threadId: 'c' }));
    store.decide(decided.id, 'approve');
    store.create(input({ threadId: 'old', ttlMs: 10 }));
    now += 100;
    expect(store.pendingThreadIds()).toEqual(['a', 'b']);
    expect(
      store.list({ status: 'pending' }).some((x) => x.threadId === 'old'),
    ).toBe(true);
    store.expire();
    expect(store.pendingThreadIds()).toEqual(['a', 'b']);
  });
});
