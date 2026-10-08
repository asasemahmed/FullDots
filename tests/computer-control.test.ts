import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ComputerConflictError } from '../src/server/computer-service.js';
import { HandoffStore } from '../src/server/handoff-store.js';
import { computerFixture, page } from './fixtures/fake-computer.js';

const fixtures: ReturnType<typeof computerFixture>[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.workspace.close();
  for (const db of dbs.splice(0)) db.close();
});
function setup() {
  const f = computerFixture();
  fixtures.push(f);
  f.fake.pages['https://form.test/'] = page('Form', [
    { ref: 'e1', role: 'button', name: 'Go' },
  ]);
  return f;
}
const click = async (f: ReturnType<typeof setup>) => {
  await f.service.action(
    f.id,
    'navigate',
    { url: 'https://form.test/' },
    'agent',
  );
  const shot = (await f.service.action(f.id, 'snapshot', {}, 'agent')) as {
    snapshotId: number;
  };
  return f.service.action(
    f.id,
    'click',
    { ref: 'e1', snapshotId: shot.snapshotId },
    'agent',
  );
};
const kindOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ComputerConflictError);
  return (error as ComputerConflictError).kind;
};

it('asks the owner for control and blocks the agent until it is answered', async () => {
  const f = setup();
  const control = await f.service.requestOwnerControl(f.id, 'Sign in please.');
  expect(control.request).toMatchObject({ status: 'waiting' });
  expect(f.fake.bodies['control/request'][0]).toEqual({
    reason: 'Sign in please.',
  });
  const status = await f.service.status(f.id);
  expect(status.control?.request?.status).toBe('waiting');
  expect(status.control?.requested).toBe(true);
  expect(
    await kindOf(
      f.service.action(f.id, 'click', { ref: 'e1', snapshotId: 1 }, 'agent'),
    ),
  ).toBe('owner_control');
  // Asking again returns the request that is already active.
  const again = await f.service.requestOwnerControl(f.id, 'Again.');
  expect(again.request?.id).toBe(control.request?.id);
});

it('clips the reason to 500 characters', async () => {
  const f = setup();
  await f.service.requestOwnerControl(f.id, 'x'.repeat(900));
  expect(
    (f.fake.bodies['control/request'][0] as { reason: string }).reason,
  ).toHaveLength(500);
});

it('needs the browser permission to ask', async () => {
  const f = setup();
  f.workspace.computers.patch(f.id, { browser: false });
  await expect(f.service.requestOwnerControl(f.id, 'x')).rejects.toThrow(
    'Computer permission is disabled.',
  );
  expect(f.fake.count_of('control/request')).toBe(0);
  expect(
    f.workspace.computers
      .audit(f.id)
      .find((entry) => entry.action === 'request_control')?.outcome,
  ).toBe('failed');
});

it('hands the wheel back after the owner takes and releases control', async () => {
  const f = setup();
  await f.service.requestOwnerControl(f.id, 'Sign in please.');
  const taken = await f.service.control(f.id, 'take');
  expect(taken.control).toMatchObject({
    holder: 'human',
    request: { status: 'taken' },
  });
  const released = await f.service.control(f.id, 'release');
  expect(released.control).toMatchObject({
    holder: 'bot',
    resumeSnapshotRequired: true,
    request: { status: 'completed' },
  });
  expect(
    await kindOf(
      f.service.action(f.id, 'click', { ref: 'e1', snapshotId: 1 }, 'agent'),
    ),
  ).toBe('snapshot_required');
  await f.service.action(f.id, 'snapshot', {}, 'agent');
  expect(f.fake.resumeSnapshotRequired).toBe(false);
});

it('cancels a waiting request so the agent may act again', async () => {
  const f = setup();
  await f.service.requestOwnerControl(f.id, 'Sign in please.');
  const control = await f.service.cancelOwnerControl(f.id);
  expect(control).toMatchObject({
    holder: 'bot',
    requested: false,
    resumeSnapshotRequired: false,
    request: { status: 'cancelled' },
  });
  expect(f.fake.count_of('control/release')).toBe(0);
  await expect(click(f)).resolves.toMatchObject({ action: 'click' });
});

it('cancels then releases a request the owner had already taken', async () => {
  const f = setup();
  await f.service.requestOwnerControl(f.id, 'Sign in please.');
  await f.service.control(f.id, 'take');
  const control = await f.service.cancelOwnerControl(f.id);
  expect(control).toMatchObject({
    holder: 'bot',
    resumeSnapshotRequired: true,
    request: { status: 'completed' },
  });
  expect(
    f.fake.calls.filter(
      (call) => call === 'control/cancel' || call === 'control/release',
    ),
  ).toEqual(['control/cancel', 'control/release']);
});

it('does nothing and does not throw when no request is active', async () => {
  const f = setup();
  const control = await f.service.cancelOwnerControl(f.id);
  expect(control).toMatchObject({ holder: 'bot', requested: false });
  expect(f.fake.count_of('control/cancel')).toBe(0);
  await f.service.requestOwnerControl(f.id, 'x');
  await f.service.cancelOwnerControl(f.id);
  const again = await f.service.cancelOwnerControl(f.id);
  expect(again.request?.status).toBe('cancelled');
  expect(f.fake.count_of('control/cancel')).toBe(1);
});

it('treats a request that is no longer active as already cancelled', async () => {
  const f = setup();
  await f.service.requestOwnerControl(f.id, 'x');
  // The request ends between the read and the cancel.
  const real = f.fake.handle;
  let reads = 0;
  f.fake.handle = async (url, init) => {
    if (new URL(url).pathname === '/control' && (reads += 1) === 1) {
      const response = await real(url, init);
      f.fake.request!.status = 'cancelled';
      return response;
    }
    return real(url, init);
  };
  await expect(f.service.cancelOwnerControl(f.id)).resolves.toMatchObject({
    request: { status: 'cancelled' },
  });
  expect(f.fake.count_of('control/cancel')).toBe(1);
});

it('reports a cancel that fails', async () => {
  const f = setup();
  await f.service.requestOwnerControl(f.id, 'x');
  f.fake.failNext = '/control/cancel';
  await expect(f.service.cancelOwnerControl(f.id)).rejects.toThrow(
    'Computer service returned HTTP 500.',
  );
  expect(f.fake.request?.status).toBe('waiting');
  await expect(f.service.cancelOwnerControl(f.id)).resolves.toMatchObject({
    request: { status: 'cancelled' },
  });
});

it('records request_control and cancel_control in the audit trail', async () => {
  const f = setup();
  await f.service.requestOwnerControl(f.id, 'x');
  await f.service.cancelOwnerControl(f.id);
  const audit = f.workspace.computers.audit(f.id);
  expect(audit).toContainEqual(
    expect.objectContaining({
      action: 'request_control',
      actor: 'agent',
      outcome: 'succeeded',
    }),
  );
  expect(audit).toContainEqual(
    expect.objectContaining({
      action: 'cancel_control',
      actor: 'owner',
      outcome: 'succeeded',
    }),
  );
});

it('shows a waiting handoff in the status once a store is attached', async () => {
  const f = setup();
  expect((await f.service.status(f.id)).handoff).toBeUndefined();
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  const handoffs = new HandoffStore(db);
  f.service.setHandoffs(handoffs);
  expect((await f.service.status(f.id)).handoff).toBeUndefined();
  const handoff = handoffs.create({
    dotId: f.id,
    threadId: 't',
    kind: 'captcha',
    reason: 'Solve the check.',
  });
  expect((await f.service.status(f.id)).handoff).toEqual({
    id: handoff.id,
    kind: 'captcha',
    reason: 'Solve the check.',
    createdAt: handoff.createdAt,
  });
  handoffs.finish(handoff.id, 'done');
  expect((await f.service.status(f.id)).handoff).toBeUndefined();
});
