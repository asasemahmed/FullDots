import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { HandoffStore } from '../src/server/handoff-store.js';

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function store() {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  return new HandoffStore(db);
}
const input = (dotId: string, reason = 'Sign in.') => ({
  dotId,
  threadId: `thread-${dotId}`,
  kind: 'credential' as const,
  reason,
});

it('creates waiting handoffs that can be read back', () => {
  const handoffs = store();
  const created = handoffs.create({ ...input('a'), controlRequestId: 'r1' });
  expect(created).toMatchObject({
    dotId: 'a',
    threadId: 'thread-a',
    kind: 'credential',
    reason: 'Sign in.',
    status: 'waiting',
    finishedAt: null,
    controlRequestId: 'r1',
  });
  expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(handoffs.get(created.id)).toEqual(created);
  expect(handoffs.get('missing')).toBeUndefined();
  expect(handoffs.create(input('a')).controlRequestId).toBeNull();
});

it('finds the newest waiting handoff of a Dot', () => {
  const handoffs = store();
  expect(handoffs.waitingFor('a')).toBeUndefined();
  const first = handoffs.create(input('a', 'first'));
  const second = handoffs.create(input('a', 'second'));
  handoffs.create(input('b'));
  expect(handoffs.waitingFor('a')?.id).toBe(second.id);
  handoffs.finish(second.id, 'done');
  expect(handoffs.waitingFor('a')?.id).toBe(first.id);
});

it('finishes a waiting handoff once', () => {
  const handoffs = store();
  const created = handoffs.create(input('a'));
  const done = handoffs.finish(created.id, 'done');
  expect(done.status).toBe('done');
  expect(done.finishedAt).toBeTypeOf('number');
  expect(() => handoffs.finish(created.id, 'dismissed')).toThrow(
    'Handoff is not waiting.',
  );
  expect(() => handoffs.finish('missing', 'done')).toThrow(
    'Handoff is not waiting.',
  );
  expect(handoffs.get(created.id)?.status).toBe('done');
});

it('lists newest first with filters and a limit', () => {
  const handoffs = store();
  const a1 = handoffs.create(input('a', '1'));
  const b1 = handoffs.create(input('b', '2'));
  const a2 = handoffs.create(input('a', '3'));
  handoffs.finish(a1.id, 'dismissed');
  expect(handoffs.list().map((h) => h.id)).toEqual([a2.id, b1.id, a1.id]);
  expect(handoffs.list({ dotId: 'a' }).map((h) => h.id)).toEqual([
    a2.id,
    a1.id,
  ]);
  expect(handoffs.list({ status: 'waiting' }).map((h) => h.id)).toEqual([
    a2.id,
    b1.id,
  ]);
  expect(handoffs.list({ status: 'dismissed' }).map((h) => h.id)).toEqual([
    a1.id,
  ]);
  expect(handoffs.list({ limit: 1 }).map((h) => h.id)).toEqual([a2.id]);
});

it('lists each Dot with a waiting handoff once', () => {
  const handoffs = store();
  const a1 = handoffs.create(input('a'));
  handoffs.create(input('a'));
  const b1 = handoffs.create(input('b'));
  expect(handoffs.waitingDotIds().sort()).toEqual(['a', 'b']);
  handoffs.finish(b1.id, 'done');
  handoffs.finish(a1.id, 'done');
  expect(handoffs.waitingDotIds()).toEqual(['a']);
});

it('keeps handoffs in a database that is reopened', () => {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  const created = new HandoffStore(db).create(input('a'));
  expect(new HandoffStore(db).waitingFor('a')?.id).toBe(created.id);
});
