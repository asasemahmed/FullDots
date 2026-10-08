import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { ComputerStore } from '../src/server/computer-store.js';

const dot = 'dot-1';

it('begin and finish round-trip through audit()', () => {
  const store = new ComputerStore(new DatabaseSync(':memory:'));
  const id = store.begin(dot, 'navigate', 'agent', 't0');
  expect(store.audit(dot)).toEqual([
    {
      id,
      action: 'navigate',
      actor: 'agent',
      outcome: 'pending',
      createdAt: expect.any(Number),
    },
  ]);
  store.finish(id, 'succeeded');
  expect(store.audit(dot)).toEqual([
    {
      id,
      action: 'navigate',
      actor: 'agent',
      outcome: 'succeeded',
      createdAt: expect.any(Number),
    },
  ]);
  expect(store.auditEntries(dot)[0]).toMatchObject({
    id,
    threadId: 't0',
    tool: 'navigate',
    outcome: 'succeeded',
  });
});

it('record keeps threadId and tool in auditEntries', () => {
  const store = new ComputerStore(new DatabaseSync(':memory:'));
  const id = store.record({
    dotId: dot,
    threadId: 't1',
    tool: 'mcp__x__y',
    actor: 'agent',
    outcome: 'succeeded',
  });
  expect(store.auditEntries(dot)).toEqual([
    {
      id,
      dotId: dot,
      threadId: 't1',
      tool: 'mcp__x__y',
      actor: 'agent',
      outcome: 'succeeded',
      createdAt: expect.any(Number),
    },
  ]);
});

it('keeps only the newest 1000 rows per Dot', () => {
  const store = new ComputerStore(new DatabaseSync(':memory:'));
  for (let i = 0; i < 1005; i++)
    store.record({
      dotId: dot,
      threadId: null,
      tool: 'navigate',
      actor: 'owner',
      outcome: 'succeeded',
    });
  expect(store.auditEntries(dot, 2000)).toHaveLength(1000);
});

it('migrates computer_audit rows into action_audit once', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    `CREATE TABLE computer_audit(id TEXT PRIMARY KEY,dotId TEXT NOT NULL,action TEXT NOT NULL,actor TEXT NOT NULL,outcome TEXT NOT NULL,createdAt INTEGER NOT NULL)`,
  );
  const insert = db.prepare('INSERT INTO computer_audit VALUES (?,?,?,?,?,?)');
  insert.run('a', dot, 'navigate', 'agent', 'succeeded', 1);
  insert.run('b', dot, 'type', 'owner', 'failed', 2);

  new ComputerStore(db);
  expect(db.prepare('SELECT COUNT(*) AS n FROM action_audit').get()).toEqual({
    n: 2,
  });
  expect(
    db
      .prepare(
        'SELECT id,threadId,tool,createdAt FROM action_audit ORDER BY id',
      )
      .all(),
  ).toEqual([
    { id: 'a', threadId: null, tool: 'navigate', createdAt: 1 },
    { id: 'b', threadId: null, tool: 'type', createdAt: 2 },
  ]);

  const second = new ComputerStore(db);
  expect(db.prepare('SELECT COUNT(*) AS n FROM action_audit').get()).toEqual({
    n: 2,
  });
  expect(second.audit(dot).map((row) => row.action)).toEqual([
    'type',
    'navigate',
  ]);
});
