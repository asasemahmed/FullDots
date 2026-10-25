import { afterEach, expect, it, vi } from 'vitest';
import type { Stream } from '@agentclientprotocol/sdk';
import { Store } from '../src/server/store.js';
import { ApprovalService } from '../src/server/approval-service.js';
import { codingPermission } from '../src/server/approval-gate.js';
import {
  codingTools,
  type CodingToolDeps,
} from '../src/server/agents/coding-tools.js';
import { runAcp } from '../src/server/agents/acp-client.js';
import { CodingBridgeError } from '../src/server/agents/acp-policy.js';
import { computerFixture } from './fixtures/fake-computer.js';
import { fakeCodingAgent } from './fixtures/fake-coding-agent.js';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);

function fixture(options: Parameters<typeof fakeCodingAgent>[0] = {}) {
  const computer = computerFixture();
  const store = new Store(':memory:');
  cleanup.push(() => {
    store.close();
    computer.workspace.close();
  });
  const thread = computer.workspace.bindThread(
    'coding-test-thread',
    computer.id,
    'Coding test',
  );
  const approvals = new ApprovalService({
    approvals: computer.workspace.approvals,
    resumes: { enqueue: (marker) => computer.workspace.resumes.add(marker) },
    audit: computer.workspace.computers,
    notify: async () => {},
    ttlMs: 60_000,
  });
  const fake = fakeCodingAgent(options);
  const abort = new AbortController();
  const close = vi.fn();
  const connect = vi.fn(
    async (_target: unknown, _signal: AbortSignal, _provider?: string) => ({
      stream: undefined as unknown as Stream,
      close,
    }),
  );
  const handoff = vi.fn(async (input) =>
    computer.workspace.handoffs.create(input),
  );
  const deps: CodingToolDeps = {
    store,
    workspace: computer.workspace,
    computer: computer.service,
    approvals,
    handoffs: { start: handoff },
    dotId: computer.id,
    threadId: thread.id,
    signal: abort.signal,
    check: () => {
      if (computer.workspace.dot(computer.id)?.paused) abort.abort();
      abort.signal.throwIfAborted();
    },
    progress: vi.fn(),
    connect,
    run: (options) => runAcp({ ...options, target: fake.app }),
  };
  return { ...computer, store, deps, fake, close, handoff, abort, connect };
}

it('omits the tool when disabled, stopped, paused, or computer access is revoked', async () => {
  const f = fixture();
  expect(await codingTools(f.deps)).toEqual([]);
  f.store.codingSessions.configure(f.id, true);
  const target = vi
    .spyOn(f.service, 'codingTarget')
    .mockRejectedValueOnce(new Error('Stopped'));
  expect(await codingTools(f.deps)).toEqual([]);
  target.mockRestore();
  f.workspace.setDotPaused(f.id, true);
  expect(await codingTools(f.deps)).toEqual([]);
  f.workspace.setDotPaused(f.id, false);
  f.workspace.computers.patch(f.id, { enabled: false });
  expect(await codingTools(f.deps)).toEqual([]);
});

it.each(['approve', 'deny'] as const)(
  'turns a worker permission into an approval and forwards %s',
  async (decision) => {
    const f = fixture({ permission: true });
    f.store.codingSessions.configure(f.id, true);
    const tools = await codingTools(f.deps);
    expect(tools.map((tool) => tool.name)).toEqual([
      'delegate_to_coding_agent',
    ]);
    const running = tools[0].execute!({ task: 'Write a file' });
    await vi.waitFor(() =>
      expect(f.workspace.approvals.list({ status: 'pending' })).toHaveLength(1),
    );
    const approval = f.workspace.approvals.list()[0];
    expect(approval.summary).toContain('Write the requested file');
    expect(approval.argsRedacted).toContain('/workspace/result.txt');
    expect(approval.argsRedacted).toContain('write result.txt');
    expect(approval.argsRedacted).not.toContain('fixture-sensitive-value');
    f.deps.approvals.decide(approval.id, decision);
    await expect(running).resolves.toMatchObject({ status: 'completed' });
    expect(f.fake.state.outcome).toEqual({
      outcome: {
        outcome: 'selected',
        optionId: decision === 'approve' ? 'once' : 'deny',
      },
    });
    expect(f.workspace.resumes.all()).toEqual([]);
    expect(f.store.codingSessions.list(f.id)[0]).toMatchObject({
      status: 'completed',
      agentSessionId: 'fixture-session',
    });
    expect(f.close).toHaveBeenCalled();
    expect(f.deps.progress).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Working on') }),
    );
  },
);

it('denies by default on permission timeout even if the Dot approval mode is off', async () => {
  const f = fixture();
  const dot = f.workspace.dot(f.id)!;
  f.workspace.updateDot(f.id, { ...dot, approvalMode: 'off' });
  const result = await codingPermission(
    {
      dotId: f.id,
      threadId: f.deps.threadId,
      approvals: f.deps.approvals,
      workspace: f.workspace,
      signal: f.abort.signal,
      redact: (text) => text,
      timeoutMs: 0,
    },
    {
      sessionId: 'fixture',
      toolCall: { toolCallId: 'call', title: 'Change files' },
      options: [
        { kind: 'allow_always', optionId: 'always', name: 'Always allow' },
      ],
    },
  );
  expect(result.outcome.outcome).toBe('cancelled');
  expect(f.workspace.approvals.list()[0].status).toBe('denied');
});

it.each(['new', 'prompt'] as const)(
  'maps auth-required on %s to an owner hand-off',
  async (authAt) => {
    const f = fixture({ authAt });
    f.store.codingSessions.configure(f.id, true);
    const [tool] = await codingTools(f.deps);
    await expect(tool.execute!({ task: 'Task' })).resolves.toMatchObject({
      status: 'handoff',
    });
    expect(f.handoff).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'credential',
        reason: expect.stringContaining('Sign in to Claude Code'),
      }),
    );
    expect(f.store.codingSessions.list(f.id)[0].status).toBe(
      'authentication_required',
    );
    expect(f.close).toHaveBeenCalled();
  },
);

it.each(['pause', 'revoke', 'stop'] as const)(
  'cancels and closes a worker on %s',
  async (action) => {
    const f = fixture({ waitForCancel: true });
    f.store.codingSessions.configure(f.id, true);
    const [tool] = await codingTools(f.deps);
    const running = tool.execute!({ task: 'Task' });
    await vi.waitFor(() => expect(f.fake.state.prompted).toBe(true));
    if (action === 'pause') f.workspace.setDotPaused(f.id, true);
    if (action === 'revoke') f.store.codingSessions.configure(f.id, false);
    if (action === 'stop')
      vi.spyOn(f.service, 'status').mockResolvedValue({
        state: 'stopped',
      } as Awaited<ReturnType<typeof f.service.status>>);
    await expect(running).resolves.toMatchObject({ status: 'cancelled' });
    expect(f.fake.state.cancelled).toBeGreaterThan(0);
    expect(f.close).toHaveBeenCalled();
    expect(f.store.codingSessions.list(f.id)[0].status).toBe('cancelled');
  },
);

it('refuses a saved switch revoked after tool discovery', async () => {
  const f = fixture();
  f.store.codingSessions.configure(f.id, true);
  const [tool] = await codingTools(f.deps);
  f.store.codingSessions.configure(f.id, false);
  await expect(tool.execute!({ task: 'Task' })).rejects.toThrow('disabled');
  expect(f.store.codingSessions.list(f.id)).toEqual([]);
});

it.each([
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
  'exit-plan-auto',
  'exit-plan-clear-auto',
  'custom-mode',
])(
  'denies a mode-changing allow_once option %s even after owner approval',
  async (optionId) => {
    const f = fixture({
      permission: true,
      modes: ['default', 'custom-mode'],
      permissionOptions: [
        { optionId, name: 'Approve', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
    f.store.codingSessions.configure(f.id, true);
    const [tool] = await codingTools(f.deps);
    const running = tool.execute!({ task: 'Task' });
    await vi.waitFor(() =>
      expect(f.workspace.approvals.list()).toHaveLength(1),
    );
    f.deps.approvals.decide(f.workspace.approvals.list()[0].id, 'approve');
    await running;
    expect(f.fake.state.outcome).toEqual({
      outcome: { outcome: 'selected', optionId: 'deny' },
    });
  },
);

it('denies an approved allow_always-only request', async () => {
  const f = fixture({
    permission: true,
    permissionOptions: [
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
    ],
  });
  f.store.codingSessions.configure(f.id, true);
  const [tool] = await codingTools(f.deps);
  const running = tool.execute!({ task: 'Task' });
  await vi.waitFor(() => expect(f.workspace.approvals.list()).toHaveLength(1));
  f.deps.approvals.decide(f.workspace.approvals.list()[0].id, 'approve');
  await running;
  expect(f.fake.state.outcome).toEqual({ outcome: { outcome: 'cancelled' } });
});

it('returns a clear result for a second task for the same Dot', async () => {
  const f = fixture();
  f.store.codingSessions.configure(f.id, true);
  f.store.codingSessions.start(f.id, f.deps.threadId, 'claude');
  const [tool] = await codingTools(f.deps);
  await expect(tool.execute!({ task: 'Task' })).resolves.toEqual({
    status: 'busy',
    message: 'A coding task is already running for this Dot.',
  });
});

it('distinguishes the task timeout from owner cancellation', async () => {
  const f = fixture({ waitForCancel: true });
  f.store.codingSessions.configure(f.id, true);
  f.deps.timeoutMs = 100;
  const [tool] = await codingTools(f.deps);
  await expect(tool.execute!({ task: 'Task' })).resolves.toMatchObject({
    status: 'timed_out',
    message: expect.stringContaining('timed out'),
  });
  expect(f.store.codingSessions.list(f.id)[0].status).toBe('timed_out');
});

it('reports the bridge install reason', async () => {
  const f = fixture();
  f.store.codingSessions.configure(f.id, true);
  f.deps.connect = async () => {
    throw new CodingBridgeError('Coding adapter installation failed.');
  };
  const [tool] = await codingTools(f.deps);
  await expect(tool.execute!({ task: 'Task' })).resolves.toMatchObject({
    status: 'failed',
    message: 'Coding adapter installation failed.',
  });
});

it('denies a pending approval when a mode violation closes its session', async () => {
  const f: ReturnType<typeof fixture> = fixture({
    permission: true,
    modeUpdate: 'acceptEdits',
    beforeModeUpdate: async () => {
      await vi.waitFor(() =>
        expect(f.workspace.approvals.list({ status: 'pending' })).toHaveLength(
          1,
        ),
      );
    },
  });
  f.store.codingSessions.configure(f.id, true);
  const [tool] = await codingTools(f.deps);
  await expect(tool.execute!({ task: 'Task' })).resolves.toMatchObject({
    status: 'failed',
    message: expect.stringContaining('left default permission mode'),
  });
  await vi.waitFor(() =>
    expect(f.workspace.approvals.list({ status: 'pending' })).toHaveLength(0),
  );
  expect(f.workspace.approvals.list()[0].status).toBe('denied');
  expect(f.workspace.resumes.all()).toEqual([]);
});

const codexModes = [
  'read-only',
  'workspace-write',
  'agent',
  'agent-full-access',
];

it('uses Claude Code unless the owner chose another agent', async () => {
  const f = fixture();
  f.store.codingSessions.configure(f.id, true);
  const [tool] = await codingTools(f.deps);
  await expect(tool.execute!({ task: 'Task' })).resolves.toMatchObject({
    status: 'completed',
  });
  expect(f.connect.mock.calls[0][2]).toBe('claude');
  expect(f.store.codingSessions.list(f.id)[0].provider).toBe('claude');
  expect(f.fake.state.mode).toBe('default');
});

it('starts Codex in the ask-first preset when the owner chose it', async () => {
  const f = fixture({ initialMode: 'agent', modes: codexModes });
  f.store.codingSessions.configure(f.id, true, 'codex');
  const [tool] = await codingTools(f.deps);
  await expect(tool.execute!({ task: 'Task' })).resolves.toMatchObject({
    status: 'completed',
  });
  expect(f.connect.mock.calls[0][2]).toBe('codex');
  expect(f.store.codingSessions.list(f.id)[0].provider).toBe('codex');
  expect(f.fake.state.mode).toBe('read-only');
  expect(f.fake.state.sessionMeta).toBeUndefined();
});

it.each(['approve', 'deny'] as const)(
  'sends a Codex permission request through the owner approval and forwards %s',
  async (decision) => {
    const f = fixture({
      permission: true,
      initialMode: 'read-only',
      modes: codexModes,
      permissionOptions: [
        { optionId: 'allow_once', name: 'Yes, proceed', kind: 'allow_once' },
        {
          optionId: 'allow_for_session',
          name: 'Do not ask again',
          kind: 'allow_always',
        },
        { optionId: 'cancel', name: 'No', kind: 'reject_once' },
      ],
    });
    f.store.codingSessions.configure(f.id, true, 'codex');
    const [tool] = await codingTools(f.deps);
    const running = tool.execute!({ task: 'Task' });
    await vi.waitFor(() =>
      expect(f.workspace.approvals.list({ status: 'pending' })).toHaveLength(1),
    );
    f.deps.approvals.decide(f.workspace.approvals.list()[0].id, decision);
    await expect(running).resolves.toMatchObject({ status: 'completed' });
    expect(f.fake.state.outcome).toEqual({
      outcome: {
        outcome: 'selected',
        optionId: decision === 'approve' ? 'allow_once' : 'cancel',
      },
    });
  },
);

it.each(['read-only', 'agent-full-access', 'implement_plan'])(
  'denies a Codex allow_once option %s that changes the preset even after approval',
  async (optionId) => {
    const f = fixture({
      permission: true,
      initialMode: 'read-only',
      modes: codexModes,
      permissionOptions: [
        { optionId, name: 'Approve', kind: 'allow_once' },
        { optionId: 'decline', name: 'Deny', kind: 'reject_once' },
      ],
    });
    f.store.codingSessions.configure(f.id, true, 'codex');
    const [tool] = await codingTools(f.deps);
    const running = tool.execute!({ task: 'Task' });
    await vi.waitFor(() =>
      expect(f.workspace.approvals.list()).toHaveLength(1),
    );
    f.deps.approvals.decide(f.workspace.approvals.list()[0].id, 'approve');
    await running;
    expect(f.fake.state.outcome).toEqual({
      outcome: { outcome: 'selected', optionId: 'decline' },
    });
  },
);

it('turns Codex auth-required on session/new into a Codex sign-in hand-off', async () => {
  const f = fixture({ authAt: 'new' });
  f.store.codingSessions.configure(f.id, true, 'codex');
  const [tool] = await codingTools(f.deps);
  await expect(tool.execute!({ task: 'Task' })).resolves.toMatchObject({
    status: 'handoff',
  });
  const reason = f.handoff.mock.calls[0][0].reason;
  expect(reason).toContain('Sign in to Codex');
  expect(reason).toContain('API key');
  expect(reason).toContain('ChatGPT');
  expect(reason).not.toContain('Claude');
  expect(f.handoff).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'credential' }),
  );
  expect(f.store.codingSessions.list(f.id)[0]).toMatchObject({
    provider: 'codex',
    status: 'authentication_required',
  });
  expect(f.close).toHaveBeenCalled();
});

it('stops Codex before any prompt when the ask-first preset is not offered', async () => {
  const f = fixture({
    initialMode: 'agent',
    modes: ['workspace-write', 'agent', 'agent-full-access'],
  });
  f.store.codingSessions.configure(f.id, true, 'codex');
  const [tool] = await codingTools(f.deps);
  await expect(tool.execute!({ task: 'Task' })).resolves.toMatchObject({
    status: 'failed',
  });
  expect(f.fake.state.prompted).toBe(false);
  expect(f.fake.state.mode).toBe('');
});
