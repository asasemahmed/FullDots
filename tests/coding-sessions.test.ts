import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';

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
