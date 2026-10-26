import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/store.js';
import { CodingSessions } from '../src/server/agents/coding-sessions.js';

it('persists settings and marks unfinished sessions interrupted on restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'fulldots-coding-'));
  const path = join(root, 'store.sqlite');
  let store: Store | undefined;
  try {
    store = new Store(path);
    store.codingSessions.configure('dot-a', true);
    const session = store.codingSessions.start('dot-a', 'thread-a', 'claude');
    store.codingSessions.attach(session.id, 'agent-session');
    expect(() =>
      store!.codingSessions.start('dot-a', 'another-thread', 'claude'),
    ).toThrow();
    store.close();
    store = new Store(path);
    expect(store.codingSessions.enabled('dot-a')).toBe(true);
    expect(store.codingSessions.enabled('dot-b')).toBe(false);
    expect(store.codingSessions.get(session.id)).toMatchObject({
      status: 'interrupted',
      agentSessionId: 'agent-session',
    });
    const next = store.codingSessions.start('dot-a', 'thread-a', 'claude');
    store.codingSessions.finish(next.id, 'completed');
    expect(store.codingSessions.list('dot-a')[0].status).toBe('completed');
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('adds the agent choice to an earlier database and keeps Claude Code for existing Dots', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE coding_agent_settings(dotId TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0)',
  );
  db.prepare(
    'INSERT INTO coding_agent_settings(dotId,enabled) VALUES (?,1)',
  ).run('old-dot');
  const sessions = new CodingSessions(db);
  expect(sessions.enabled('old-dot')).toBe(true);
  expect(sessions.provider('old-dot')).toBe('claude');
  expect(sessions.provider('never-saved')).toBe('claude');
  // Starting again on the migrated database does not add the column twice.
  expect(() => new CodingSessions(db)).not.toThrow();
  sessions.configure('old-dot', true, 'codex');
  expect(sessions.provider('old-dot')).toBe('codex');
  sessions.configure('old-dot', false);
  expect(sessions.provider('old-dot')).toBe('codex');
  expect(() =>
    sessions.configure('old-dot', true, 'gemini' as unknown as 'codex'),
  ).toThrow();
  expect(sessions.provider('old-dot')).toBe('codex');
  db.close();
});
