import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvalRoutes } from '../src/server/approval-routes.js';
import { ApprovalService } from '../src/server/approval-service.js';
import { ApprovalStore } from '../src/server/approval-store.js';
import { HandoffStore } from '../src/server/handoff-store.js';
import type { Handoff } from '../src/shared/types.js';

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function setup() {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  const approvalStore = new ApprovalStore(db);
  const handoffStore = new HandoffStore(db);
  const enqueue = vi.fn();
  const record = vi.fn();
  const approvals = new ApprovalService({
    approvals: approvalStore,
    resumes: { enqueue },
    audit: { record },
    notify: async () => undefined,
    ttlMs: 60_000,
  });
  const dismiss = vi.fn<(id: string) => Promise<Handoff>>(async (id) => {
    if (!handoffStore.get(id)) throw new Error('Handoff not found.');
    return handoffStore.finish(id, 'dismissed');
  });
  const app = new Hono().route(
    '/api',
    approvalRoutes({
      approvals,
      approvalStore,
      handoffs: { dismiss },
      handoffStore,
    }),
  );
  let counter = 0;
  const ask = (
    patch: Partial<Parameters<ApprovalService['request']>[0]> = {},
  ) =>
    approvals.request({
      threadId: 't1',
      dotId: 'd1',
      toolCallId: `call-${++counter}`,
      tool: 'computer_exec',
      argsHash: `hash-${counter}`,
      summary: 'Remove the build folder',
      argsRedacted: 'rm -rf build',
      ...patch,
    });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body:
        body === undefined
          ? method === 'GET'
            ? undefined
            : '{}'
          : typeof body === 'string'
            ? body
            : JSON.stringify(body),
    });
    return {
      status: response.status,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: (await response.json()) as any,
    };
  };
  return { call, ask, enqueue, record, dismiss, approvalStore, handoffStore };
}

describe('approval routes', () => {
  it('lists approvals newest first and filters by status, thread and Dot', async () => {
    const { call, ask } = setup();
    const first = ask();
    const second = ask({ threadId: 't2', dotId: 'd2' });
    const third = ask();
    await call('POST', `/approvals/${first.id}`, { decision: 'deny' });
    const all = await call('GET', '/approvals');
    expect(all.status).toBe(200);
    expect(all.body.approvals.map((a: { id: string }) => a.id)).toEqual([
      third.id,
      second.id,
      first.id,
    ]);
    const pending = await call('GET', '/approvals?status=pending');
    expect(pending.body.approvals).toHaveLength(2);
    const denied = await call('GET', '/approvals?status=denied');
    expect(denied.body.approvals.map((a: { id: string }) => a.id)).toEqual([
      first.id,
    ]);
    const thread = await call('GET', '/approvals?threadId=t2');
    expect(thread.body.approvals.map((a: { id: string }) => a.id)).toEqual([
      second.id,
    ]);
    const dot = await call('GET', '/approvals?dotId=d1&status=pending');
    expect(dot.body.approvals.map((a: { id: string }) => a.id)).toEqual([
      third.id,
    ]);
    // An empty filter value means no filter.
    expect(
      (await call('GET', '/approvals?status=')).body.approvals,
    ).toHaveLength(3);
  });

  it('rejects a status outside the enum', async () => {
    const { call } = setup();
    const { status, body } = await call('GET', '/approvals?status=bogus');
    expect(status).toBe(400);
    expect(body.error).toMatch(/status/);
  });

  it('gets one approval or 404s', async () => {
    const { call, ask } = setup();
    const approval = ask();
    const found = await call('GET', `/approvals/${approval.id}`);
    expect(found).toEqual({ status: 200, body: approval });
    const missing = await call('GET', '/approvals/nope');
    expect(missing).toEqual({
      status: 404,
      body: { error: 'Approval not found.' },
    });
  });

  it('approves with a note, resumes the Dot and audits it', async () => {
    const { call, ask, enqueue, record } = setup();
    const approval = ask();
    const { status, body } = await call('POST', `/approvals/${approval.id}`, {
      decision: 'approve',
      note: 'Go ahead',
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      id: approval.id,
      status: 'approved',
      note: 'Go ahead',
    });
    expect(body.decidedAt).toEqual(expect.any(Number));
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'approval', refId: approval.id }),
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'owner', outcome: 'approved' }),
    );
  });

  it('denies without a note', async () => {
    const { call, ask, enqueue } = setup();
    const approval = ask();
    const { status, body } = await call('POST', `/approvals/${approval.id}`, {
      decision: 'deny',
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'denied', note: null });
    expect(enqueue.mock.calls[0][0].prompt).toMatch(/was denied/);
  });

  it('answers 409 when the approval was already decided, and does not resume twice', async () => {
    const { call, ask, enqueue } = setup();
    const approval = ask();
    await call('POST', `/approvals/${approval.id}`, { decision: 'approve' });
    const again = await call('POST', `/approvals/${approval.id}`, {
      decision: 'deny',
    });
    expect(again).toEqual({
      status: 409,
      body: { error: 'Approval is not pending.' },
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('404s for an unknown approval', async () => {
    const { call } = setup();
    const { status, body } = await call('POST', '/approvals/nope', {
      decision: 'approve',
    });
    expect(status).toBe(404);
    expect(body.error).toBe('Approval not found.');
  });

  it('validates the decision body', async () => {
    const { call, ask } = setup();
    const approval = ask();
    const url = `/approvals/${approval.id}`;
    for (const body of [
      { decision: 'maybe' },
      {},
      { decision: 'approve', note: 'x'.repeat(1001) },
      { decision: 'approve', extra: 1 },
      'not json',
    ]) {
      const bad = await call('POST', url, body);
      expect(bad.status).toBe(400);
      expect(typeof bad.body.error).toBe('string');
    }
    const edge = await call('POST', url, {
      decision: 'approve',
      note: 'x'.repeat(1000),
    });
    expect(edge.status).toBe(200);
  });

  it('answers 503 with a safe message when the service breaks', async () => {
    const db = new DatabaseSync(':memory:');
    dbs.push(db);
    const app = new Hono().route(
      '/api',
      approvalRoutes({
        approvals: {
          decide: () => {
            throw new Error('database password is hunter2');
          },
        },
        approvalStore: new ApprovalStore(db),
        handoffs: { dismiss: vi.fn() },
        handoffStore: new HandoffStore(db),
      }),
    );
    const response = await app.request('/api/approvals/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('hunter2');
  });
});

describe('handoff routes', () => {
  it('lists handoffs and filters by status and Dot', async () => {
    const { call, handoffStore } = setup();
    const a = handoffStore.create({
      dotId: 'd1',
      threadId: 't1',
      kind: 'credential',
      reason: 'sign in',
    });
    const b = handoffStore.create({
      dotId: 'd2',
      threadId: 't2',
      kind: 'captcha',
      reason: 'solve it',
    });
    handoffStore.finish(a.id, 'done');
    const all = await call('GET', '/handoffs');
    expect(all.status).toBe(200);
    expect(all.body.handoffs).toHaveLength(2);
    const waiting = await call('GET', '/handoffs?status=waiting');
    expect(waiting.body.handoffs.map((h: Handoff) => h.id)).toEqual([b.id]);
    const dot = await call('GET', '/handoffs?dotId=d1');
    expect(dot.body.handoffs.map((h: Handoff) => h.id)).toEqual([a.id]);
    const bad = await call('GET', '/handoffs?status=open');
    expect(bad.status).toBe(400);
  });

  it('dismisses a waiting handoff', async () => {
    const { call, handoffStore, dismiss } = setup();
    const handoff = handoffStore.create({
      dotId: 'd1',
      threadId: 't1',
      kind: 'two_factor',
      reason: 'enter the code',
    });
    const { status, body } = await call(
      'POST',
      `/handoffs/${handoff.id}/dismiss`,
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ id: handoff.id, status: 'dismissed' });
    expect(dismiss).toHaveBeenCalledWith(handoff.id);
  });

  it('maps not found to 404 and not waiting to 409', async () => {
    const { call, handoffStore } = setup();
    const missing = await call('POST', '/handoffs/nope/dismiss');
    expect(missing).toEqual({
      status: 404,
      body: { error: 'Handoff not found.' },
    });
    const handoff = handoffStore.create({
      dotId: 'd1',
      threadId: 't1',
      kind: 'other',
      reason: 'x',
    });
    handoffStore.finish(handoff.id, 'done');
    // The stub (like the real service) throws the "not waiting" message from the store.
    const done = await call('POST', `/handoffs/${handoff.id}/dismiss`);
    expect(done).toEqual({
      status: 409,
      body: { error: 'Handoff is not waiting.' },
    });
  });
});
