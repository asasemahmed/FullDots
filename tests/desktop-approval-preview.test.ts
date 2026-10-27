import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalStore } from '../src/server/approval-store.js';
import { ApprovalService } from '../src/server/approval-service.js';
import { intentHash, redactArgs } from '../src/server/approvals.js';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function fixture() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  let now = 1000;
  const store = new ApprovalStore(db, () => now);
  const text = 'printf "fixture"\n\techo done';
  const input = {
    threadId: 'thread',
    dotId: 'dot',
    toolCallId: 'call',
    tool: 'desktop_type',
    argsHash: intentHash({ tool: 'desktop_type', args: { text } }),
    summary: 'Dot wants to type on the desktop',
    argsRedacted: redactArgs('desktop_type', { text }),
    argsPreview: text,
    ttlMs: 1000,
  };
  const preview = (id: string) =>
    db.prepare('SELECT argsPreview FROM approvals WHERE id=?').get(id)
      ?.argsPreview;
  return {
    db,
    store,
    text,
    input,
    preview,
    advance: () => {
      now += 1001;
    },
  };
}
it('stores the full removable preview only for desktop typing and omits it from internal rows', () => {
  const f = fixture();
  const approval = f.store.create(f.input);
  expect(f.preview(approval.id)).toBe(f.text);
  expect(f.store.forOwner(approval).argsPreview).toBe(f.text);
  for (const row of [
    approval,
    f.store.get(approval.id),
    f.store.byToolCall('thread', 'call'),
    ...f.store.list(),
  ]) {
    expect(row).not.toHaveProperty('argsPreview');
    expect(JSON.stringify(row)).not.toContain(f.text);
    expect(row?.argsRedacted).toBe('type [hidden] on desktop');
  }
  const other = f.store.create({
    ...f.input,
    tool: 'computer_exec',
    toolCallId: 'other',
  });
  expect(f.preview(other.id)).toBeNull();
  expect(f.store.forOwner(other)).not.toHaveProperty('argsPreview');
  expect(f.store.desktopTypeCharacters(approval.id)).toBe(f.text.length);
});
it.each(['approve', 'deny'] as const)(
  'clears the preview atomically on %s',
  (decision) => {
    const f = fixture();
    const row = f.store.create(f.input);
    expect(f.store.decide(row.id, decision)).not.toHaveProperty('argsPreview');
    expect(f.preview(row.id)).toBeNull();
    expect(f.store.forOwner(f.store.get(row.id)!).argsPreview).toBeNull();
  },
);
it('clears on expiry, expired decision, consumption and lapse', () => {
  const f = fixture();
  const row = f.store.create(f.input);
  f.advance();
  expect(f.store.expire()).toBe(1);
  expect(f.preview(row.id)).toBeNull();
  const expired = f.store.create({ ...f.input, toolCallId: 'expired' });
  f.advance();
  expect(() => f.store.decide(expired.id, 'approve')).toThrow('not pending');
  expect(f.preview(expired.id)).toBeNull();
  const consumed = f.store.create({ ...f.input, toolCallId: 'consumed' });
  f.store.decide(consumed.id, 'approve');
  // Consumption also clears any residual preview from an older writer.
  f.db
    .prepare('UPDATE approvals SET argsPreview=? WHERE id=?')
    .run(f.text, consumed.id);
  expect(f.store.consume('thread', f.input.argsHash, consumed.id)?.status).toBe(
    'consumed',
  );
  expect(f.preview(consumed.id)).toBeNull();
  const lapsed = f.store.create({ ...f.input, toolCallId: 'lapsed' });
  f.store.decide(lapsed.id, 'approve');
  f.db
    .prepare('UPDATE approvals SET argsPreview=? WHERE id=?')
    .run(f.text, lapsed.id);
  expect(f.store.lapse(lapsed.id)).toBe(true);
  expect(f.preview(lapsed.id)).toBeNull();
});
it('never returns an expired preview before the periodic expiry sweep', () => {
  const f = fixture();
  const row = f.store.create(f.input);
  f.advance();
  expect(f.store.forOwner(row).argsPreview).toBeNull();
  expect(f.preview(row.id)).toBeNull();
  expect(f.store.desktopTypeCharacters(row.id)).toBeUndefined();
});

it('hashes characters beyond the displayed preview, including whitespace and controls', () => {
  const prefix = 'a'.repeat(2000);
  const hash = (text: string) =>
    intentHash({ tool: 'desktop_type', args: { text } });
  const baseline = hash(prefix + 'abc');
  for (const text of [
    prefix + 'abd',
    prefix + 'abc\n',
    prefix + 'abc\t',
    prefix + 'abc' + String.fromCharCode(7),
  ])
    expect(hash(text)).not.toBe(baseline);
});
it('adds a nullable preview column to an existing approvals table without replacing rows', () => {
  const f = fixture();
  const row = f.store.create({ ...f.input, argsPreview: undefined });
  f.db.exec('ALTER TABLE approvals DROP COLUMN argsPreview');
  const migrated = new ApprovalStore(f.db, () => 1000);
  expect(migrated.get(row.id)).toEqual(row);
  expect(f.preview(row.id)).toBeNull();
  expect(
    f.db
      .prepare('PRAGMA table_info(approvals)')
      .all()
      .filter((r) => r.name === 'argsPreview'),
  ).toHaveLength(1);
});
it('keeps text out of notifications, audit, resume prompts and service results', () => {
  const f = fixture();
  const notify = vi.fn(),
    record = vi.fn(),
    enqueue = vi.fn(),
    log = vi.fn();
  const service = new ApprovalService({
    approvals: f.store,
    resumes: { enqueue },
    audit: { record },
    notify,
    ttlMs: 1000,
    log,
  });
  const row = service.request(f.input);
  expect(row).not.toHaveProperty('argsPreview');
  service.decide(row.id, 'approve');
  service.consume('thread', f.input.argsHash, row.id);
  for (const spy of [notify, record, enqueue, log])
    expect(JSON.stringify(spy.mock.calls)).not.toContain('printf');
  expect(f.preview(row.id)).toBeNull();
});

it('exposes pending text only through authenticated approval routes and clears it from decision responses', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const config = {
    mode: 'sample' as const,
    voiceName: 'fixture',
    baseUrl: 'https://model.invalid',
    model: 'fixture',
  };
  const platform = new Platform(store, workspace, config, ':memory:');
  vi.spyOn(platform.resumes, 'enqueue').mockImplementation((marker) =>
    workspace.resumes.add(marker),
  );
  try {
    const ownerToken = ['fixture', 'owner', 'preview', 'only'].join('-');
    const app = createApp({
      store,
      runner: new Runner(store, config),
      platform,
      config,
      ownerToken,
    });
    const headers = {
      Authorization: `Bearer ${ownerToken}`,
      'Content-Type': 'application/json',
    };
    const text = 'printf "route-preview"\n\techo fixture';
    const row = platform.approvals.request({
      threadId: 'fixture-thread',
      dotId: workspace.dots()[0].id,
      toolCallId: 'call',
      tool: 'desktop_type',
      argsHash: intentHash({ tool: 'desktop_type', args: { text } }),
      summary: 'Type on desktop',
      argsRedacted: 'type [hidden] on desktop',
      argsPreview: text,
    });
    for (const path of ['/api/approvals', `/api/approvals/${row.id}`]) {
      const denied = await app.request(path);
      expect(denied.status).toBe(401);
      expect(await denied.text()).not.toContain('route-preview');
      const response = await app.request(path, { headers });
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.json();
      expect(
        path === '/api/approvals'
          ? body.approvals[0].argsPreview
          : body.argsPreview,
      ).toBe(text);
    }
    const inbox = await app.request('/api/inbox', { headers });
    expect(await inbox.text()).not.toContain('route-preview');
    const decided = await app.request(`/api/approvals/${row.id}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(decided.status).toBe(200);
    expect(JSON.stringify(await decided.json())).not.toContain('route-preview');
    const after = await app.request(`/api/approvals/${row.id}`, { headers });
    expect((await after.json()).argsPreview).toBeNull();
  } finally {
    await platform.stop();
    workspace.close();
    store.close();
  }
});
