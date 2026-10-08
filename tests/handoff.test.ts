import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { ChatMiddleware } from '@tanstack/ai';
import type { ToolDefinition } from '@copilotkit/runtime/v2';
import { DotAgent } from '../src/server/dot-agent.js';
import { SqliteAgentRunner } from '../src/server/sqlite-runner.js';
import { runThreadTurn } from '../src/server/headless.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { TurnBudget } from '../src/server/turn-budget.js';
import { ApprovalStore } from '../src/server/approval-store.js';
import { ApprovalService } from '../src/server/approval-service.js';
import {
  approvalGate,
  gateParse,
  type GateComputer,
} from '../src/server/approval-gate.js';
import { requestHandoffTool } from '../src/server/approval-tools.js';
import type { ElementIdentity } from '../src/server/approvals.js';
import { ComputerService } from '../src/server/computer-service.js';
import { ComputerStore } from '../src/server/computer-store.js';
import {
  HandoffService,
  type HandoffServiceDeps,
} from '../src/server/handoff-service.js';
import { HandoffStore } from '../src/server/handoff-store.js';
import { ResumeQueue } from '../src/server/resume-queue.js';
import { ResumeStore } from '../src/server/resume-store.js';
import { TurnRegistry } from '../src/server/turn-registry.js';
import type { HandoffKind } from '../src/shared/types.js';
import { completion } from './fixtures/model-stream.js';
import {
  FakeComputer,
  computerFixture,
  fakeTransport,
  page,
} from './fixtures/fake-computer.js';

// The gate is injected into a real DotAgent without editing dot-agent.ts: DotAgent passes
// `middleware: [turnBudget(...)]`, so the object turnBudget returns can carry the gate's hooks too.
const hooks = vi.hoisted(() => ({
  gate: undefined as ((budget: TurnBudget) => ChatMiddleware) | undefined,
  extraTools: [] as ToolDefinition[],
}));
vi.mock('../src/server/turn-budget.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../src/server/turn-budget.js')>();
  return {
    ...original,
    turnBudget: (maxSteps: number, budget: TurnBudget) => {
      const base = original.turnBudget(maxSteps, budget);
      const gate = hooks.gate?.(budget);
      return gate
        ? {
            ...base,
            onBeforeToolCall: gate.onBeforeToolCall,
            onAfterToolCall: gate.onAfterToolCall,
          }
        : base;
    },
  };
});
vi.mock('../src/server/tanstack-tools.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../src/server/tanstack-tools.js')>();
  return {
    ...original,
    tanstackTools: (tools: Parameters<typeof original.tanstackTools>[0]) =>
      original.tanstackTools([...tools, ...hooks.extraTools]),
  };
});

const closers: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  hooks.gate = undefined;
  hooks.extraTools = [];
  closers.splice(0).forEach((closer) => closer.close());
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const DOT = 'dot-1';
const THREAD = 'thread-1';
const REASON = 'Sign in to the portal';

const input = (kind: HandoffKind = 'credential', reason = REASON) => ({
  dotId: DOT,
  threadId: THREAD,
  kind,
  reason,
});

// ---------------------------------------------------------------------------------------------
// Unit: real stores on :memory:, stubbed computer service, resumes and notifications
// ---------------------------------------------------------------------------------------------

function unit(overrides: Partial<HandoffServiceDeps> = {}) {
  const db = new DatabaseSync(':memory:');
  closers.push(db);
  const handoffs = new HandoffStore(db);
  const audit = new ComputerStore(db);
  const computers = {
    requestOwnerControl: vi.fn(async () => ({
      holder: 'bot' as const,
      requested: true,
      transitioning: false,
      resumeSnapshotRequired: false,
      request: { id: 'request-1', status: 'waiting' },
    })),
    cancelOwnerControl: vi.fn(async () => ({
      holder: 'bot' as const,
      requested: false,
      transitioning: false,
      resumeSnapshotRequired: false,
    })),
    stop: vi.fn(async () => ({})),
    start: vi.fn(async () => ({})),
  };
  const enqueue = vi.fn();
  const notify = vi.fn(async () => {});
  const log = vi.fn();
  const service = new HandoffService({
    handoffs,
    computers: computers as unknown as HandoffServiceDeps['computers'],
    resumes: { enqueue },
    audit,
    notify,
    log,
    ...overrides,
  });
  const auditOf = () =>
    audit
      .auditEntries(DOT)
      .reverse()
      .map(({ tool, actor, outcome }) => ({ tool, actor, outcome }));
  return { handoffs, audit, computers, enqueue, notify, log, service, auditOf };
}

describe('HandoffService.start', () => {
  it('stores a waiting handoff, asks for control, audits and notifies', async () => {
    const u = unit();
    const handoff = await u.service.start(
      input('two_factor', 'Enter the code'),
    );
    expect(handoff).toMatchObject({
      dotId: DOT,
      threadId: THREAD,
      kind: 'two_factor',
      reason: 'Enter the code',
      status: 'waiting',
    });
    expect(u.handoffs.get(handoff.id)).toEqual(handoff);
    expect(u.computers.requestOwnerControl).toHaveBeenCalledWith(
      DOT,
      'Enter the code',
      'agent',
    );
    expect(u.auditOf()).toEqual([
      { tool: 'handoff', actor: 'agent', outcome: 'pending' },
    ]);
    expect(u.notify).toHaveBeenCalledWith({
      title: 'Your turn on the computer',
      text: 'Enter the code',
      url: `/#/dots/${DOT}/threads/${THREAD}`,
    });
    expect(u.enqueue).not.toHaveBeenCalled();
  });

  it('gives a second conversation of the Dot its own handoff and resumes both on release', async () => {
    const u = unit();
    const first = await u.service.start(input());
    const second = await u.service.start({ ...input(), threadId: 'thread-2' });
    expect(second.id).not.toBe(first.id);
    expect(u.handoffs.list({ dotId: DOT, status: 'waiting' })).toHaveLength(2);
    u.service.released(DOT);
    expect(u.handoffs.list({ dotId: DOT, status: 'waiting' })).toHaveLength(0);
    expect(
      u.enqueue.mock.calls.map(([marker]) => marker.threadId).sort(),
    ).toEqual([THREAD, 'thread-2']);
  });

  it('declines every waiting conversation of the Dot on dismiss', async () => {
    const u = unit();
    const first = await u.service.start(input());
    await u.service.start({ ...input(), threadId: 'thread-2' });
    await u.service.dismiss(first.id);
    expect(u.handoffs.list({ dotId: DOT, status: 'dismissed' })).toHaveLength(
      2,
    );
    expect(u.enqueue).toHaveBeenCalledTimes(2);
    expect(u.computers.cancelOwnerControl).toHaveBeenCalledTimes(1);
  });

  it('returns the waiting handoff of the conversation instead of asking twice', async () => {
    const u = unit();
    const first = await u.service.start(input());
    const second = await u.service.start(input('captcha', 'Another reason'));
    expect(second).toEqual(first);
    expect(u.handoffs.list({ dotId: DOT })).toHaveLength(1);
    expect(u.computers.requestOwnerControl).toHaveBeenCalledTimes(1);
    expect(u.notify).toHaveBeenCalledTimes(1);
    // Another Dot is not affected.
    const other = await u.service.start({ ...input(), dotId: 'dot-2' });
    expect(other.id).not.toBe(first.id);
  });

  it('starts a new handoff once the previous one is finished', async () => {
    const u = unit();
    const first = await u.service.start(input());
    u.service.released(DOT);
    const second = await u.service.start(input());
    expect(second.id).not.toBe(first.id);
    expect(u.computers.requestOwnerControl).toHaveBeenCalledTimes(2);
  });

  it('keeps the handoff waiting when the control request fails', async () => {
    const u = unit();
    u.computers.requestOwnerControl.mockRejectedValue(
      new Error('Computer service returned HTTP 502.'),
    );
    const handoff = await u.service.start(input());
    expect(handoff.status).toBe('waiting');
    expect(handoff.controlRequestId).toBeNull();
    expect(u.handoffs.waitingFor(DOT)?.id).toBe(handoff.id);
    expect(u.log).toHaveBeenCalledWith(
      expect.stringContaining('control request failed'),
    );
    expect(u.auditOf()).toHaveLength(1);
    expect(u.notify).toHaveBeenCalledTimes(1);
  });

  it('never fails because of the audit or the notification', async () => {
    const u = unit({
      audit: {
        record: () => {
          throw new Error('audit down');
        },
      },
      notify: () => Promise.reject(new Error('webhook down')),
    });
    const handoff = await u.service.start(input());
    expect(handoff.status).toBe('waiting');
    await vi.waitFor(() =>
      expect(u.log).toHaveBeenCalledWith('Notification failed: webhook down'),
    );
    expect(u.log).toHaveBeenCalledWith('Handoff audit failed: audit down');
  });

  it('throws only when the handoff cannot be stored', async () => {
    const u = unit();
    const broken = new HandoffService({
      handoffs: {
        create: () => {
          throw new Error('disk full');
        },
        get: () => undefined,
        waitingFor: () => undefined,
        list: () => [],
        finish: u.handoffs.finish.bind(u.handoffs),
      },
      computers: u.computers as unknown as HandoffServiceDeps['computers'],
      resumes: { enqueue: u.enqueue },
      audit: u.audit,
      notify: u.notify,
      log: u.log,
    });
    await expect(broken.start(input())).rejects.toThrow('disk full');
    expect(u.computers.requestOwnerControl).not.toHaveBeenCalled();
    expect(u.notify).not.toHaveBeenCalled();
  });

  it('records the control request id when the store can hold it', async () => {
    const db = new DatabaseSync(':memory:');
    closers.push(db);
    const store = new HandoffStore(db);
    const rows = new Map<string, string>();
    const setControlRequestId = vi.fn((id: string, requestId: string) => {
      rows.set(id, requestId);
    });
    const u = unit({
      handoffs: {
        create: store.create.bind(store),
        get: (id) => {
          const row = store.get(id);
          return row && rows.has(id)
            ? { ...row, controlRequestId: rows.get(id)! }
            : row;
        },
        waitingFor: store.waitingFor.bind(store),
        list: store.list.bind(store),
        finish: store.finish.bind(store),
        setControlRequestId,
      },
    });
    const handoff = await u.service.start(input());
    expect(setControlRequestId).toHaveBeenCalledWith(handoff.id, 'request-1');
    expect(handoff.controlRequestId).toBe('request-1');
  });
});

describe('HandoffService.released', () => {
  it.each([
    ['credential', 'sign-in'],
    ['two_factor', 'verification code'],
    ['captcha', 'human check'],
    ['other', 'requested'],
  ] as const)(
    'finishes a %s handoff and resumes the turn',
    async (kind, label) => {
      const u = unit();
      const started = await u.service.start(input(kind));
      const done = u.service.released(DOT);
      expect(done).toMatchObject({ id: started.id, status: 'done' });
      expect(done?.finishedAt).not.toBeNull();
      expect(u.handoffs.waitingFor(DOT)).toBeUndefined();
      expect(u.auditOf()).toEqual([
        { tool: 'handoff', actor: 'agent', outcome: 'pending' },
        { tool: 'handoff', actor: 'owner', outcome: 'succeeded' },
      ]);
      expect(u.enqueue).toHaveBeenCalledTimes(1);
      expect(u.enqueue).toHaveBeenCalledWith({
        kind: 'handoff',
        refId: started.id,
        threadId: THREAD,
        dotId: DOT,
        source: 'handoff',
        prompt: `The owner finished the ${label} step and handed the computer back. Take a fresh snapshot (computer_snapshot) and continue from where you stopped. Never type the secret yourself.`,
      });
    },
  );

  it('returns undefined when nothing is waiting', async () => {
    const u = unit();
    expect(u.service.released(DOT)).toBeUndefined();
    await u.service.start(input());
    u.service.released(DOT);
    expect(u.service.released(DOT)).toBeUndefined();
    expect(u.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('HandoffService.dismiss', () => {
  it('cancels the request, dismisses the handoff and tells the Dot to stop', async () => {
    const u = unit();
    const started = await u.service.start(input());
    const dismissed = await u.service.dismiss(started.id);
    expect(dismissed).toMatchObject({ id: started.id, status: 'dismissed' });
    expect(u.computers.cancelOwnerControl).toHaveBeenCalledWith(DOT);
    expect(u.computers.stop).not.toHaveBeenCalled();
    expect(u.handoffs.waitingFor(DOT)).toBeUndefined();
    expect(u.auditOf()[1]).toEqual({
      tool: 'handoff',
      actor: 'owner',
      outcome: 'denied',
    });
    expect(u.enqueue).toHaveBeenCalledWith({
      kind: 'handoff',
      refId: started.id,
      threadId: THREAD,
      dotId: DOT,
      source: 'handoff',
      prompt: `The owner declined to take over for: ${REASON}. Do not retry that step. Report what you completed and what remains, then stop.`,
    });
    expect(u.enqueue.mock.calls[0][0].prompt).toContain('declined');
  });

  it('restarts the computer when cancelling fails, and still dismisses', async () => {
    const u = unit();
    u.computers.cancelOwnerControl.mockRejectedValue(new Error('HTTP 500'));
    const started = await u.service.start(input());
    const dismissed = await u.service.dismiss(started.id);
    expect(dismissed.status).toBe('dismissed');
    expect(u.computers.stop).toHaveBeenCalledWith(DOT);
    expect(u.computers.start).toHaveBeenCalledWith(DOT);
    expect(u.computers.stop.mock.invocationCallOrder[0]).toBeLessThan(
      u.computers.start.mock.invocationCallOrder[0],
    );
    expect(u.enqueue).toHaveBeenCalledTimes(1);
  });

  it('still dismisses when the fallback itself fails', async () => {
    const u = unit();
    u.computers.cancelOwnerControl.mockRejectedValue(new Error('HTTP 500'));
    u.computers.stop.mockRejectedValue(new Error('supervisor down'));
    u.computers.start.mockRejectedValue(new Error('supervisor down'));
    const started = await u.service.start(input());
    expect((await u.service.dismiss(started.id)).status).toBe('dismissed');
    expect(u.computers.start).toHaveBeenCalled();
    expect(u.log).toHaveBeenCalledWith(
      expect.stringContaining('computer stop failed'),
    );
    expect(u.log).toHaveBeenCalledWith(
      expect.stringContaining('computer start failed'),
    );
  });

  it('rejects an unknown handoff and one that is not waiting', async () => {
    const u = unit();
    await expect(u.service.dismiss('nope')).rejects.toThrow(
      'Handoff not found.',
    );
    const started = await u.service.start(input());
    u.service.released(DOT);
    await expect(u.service.dismiss(started.id)).rejects.toThrow(
      'Handoff is not waiting.',
    );
    expect(u.computers.cancelOwnerControl).not.toHaveBeenCalled();
    expect(u.enqueue).toHaveBeenCalledTimes(1); // only the release resume
  });
});

// ---------------------------------------------------------------------------------------------
// Integration: the real ComputerService over the fake computer's control endpoints
// ---------------------------------------------------------------------------------------------

function integration() {
  const f = computerFixture();
  closers.push(f.workspace);
  f.fake.pages['https://login.test/'] = page('Login', [
    { ref: 'e1', role: 'button', name: 'Go' },
  ]);
  f.service.setHandoffs(f.workspace.handoffs);
  const enqueue = vi.fn();
  const notify = vi.fn(async () => {});
  const service = new HandoffService({
    handoffs: f.workspace.handoffs,
    computers: f.service,
    resumes: { enqueue },
    audit: f.workspace.computers,
    notify,
    log: () => {},
  });
  const click = async () => {
    await f.service.action(
      f.id,
      'navigate',
      { url: 'https://login.test/' },
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
  return { ...f, handoffs: service, enqueue, notify, click };
}

describe('HandoffService with the computer service', () => {
  const ask = { kind: 'credential' as const, threadId: THREAD, reason: REASON };

  it('asks the computer for the owner and blocks the agent meanwhile', async () => {
    const i = integration();
    const handoff = await i.handoffs.start({ dotId: i.id, ...ask });
    expect(i.fake.request).toMatchObject({ status: 'waiting' });
    expect(i.fake.bodies['control/request']).toEqual([{ reason: REASON }]);
    await expect(i.click()).rejects.toThrow(/take control|asked/i);
    const status = await i.service.status(i.id);
    expect(status.handoff).toMatchObject({
      id: handoff.id,
      kind: 'credential',
    });
    expect(status.control?.requested).toBe(true);
    // A second start asks nothing more of the computer.
    await i.handoffs.start({ dotId: i.id, ...ask });
    expect(i.fake.count_of('control/request')).toBe(1);
  });

  it('finishes the handoff when the owner took and released control', async () => {
    const i = integration();
    const handoff = await i.handoffs.start({ dotId: i.id, ...ask });
    await i.service.control(i.id, 'take');
    expect(i.fake.holder).toBe('human');
    await i.service.control(i.id, 'release');
    expect(i.fake.request?.status).toBe('completed');
    const done = i.handoffs.released(i.id);
    expect(done).toMatchObject({ id: handoff.id, status: 'done' });
    expect(i.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        refId: handoff.id,
        prompt: expect.stringContaining('computer_snapshot'),
      }),
    );
    expect((await i.service.status(i.id)).handoff).toBeUndefined();
  });

  it('dismisses a waiting handoff by cancelling the computer request', async () => {
    const i = integration();
    const handoff = await i.handoffs.start({ dotId: i.id, ...ask });
    const dismissed = await i.handoffs.dismiss(handoff.id);
    expect(dismissed.status).toBe('dismissed');
    expect(i.fake.request?.status).toBe('cancelled');
    expect(i.fake.count_of('control/release')).toBe(0);
    // The agent may act again, without a fresh snapshot being required.
    await expect(i.click()).resolves.toMatchObject({ action: 'click' });
    expect(i.enqueue.mock.calls[0][0].prompt).toContain('declined');
  });

  it('dismisses after the owner had taken control: cancelled, then released', async () => {
    const i = integration();
    const handoff = await i.handoffs.start({ dotId: i.id, ...ask });
    await i.service.control(i.id, 'take');
    await i.handoffs.dismiss(handoff.id);
    expect(i.fake.holder).toBe('bot');
    expect(i.fake.request?.status).toBe('completed');
  });

  it('restarts the computer when the cancel call fails', async () => {
    const i = integration();
    const stop = vi
      .spyOn(i.service, 'stop')
      .mockResolvedValue({} as Awaited<ReturnType<typeof i.service.stop>>);
    const start = vi
      .spyOn(i.service, 'start')
      .mockResolvedValue({} as Awaited<ReturnType<typeof i.service.start>>);
    const handoff = await i.handoffs.start({ dotId: i.id, ...ask });
    i.fake.failNext = '/control/cancel';
    const dismissed = await i.handoffs.dismiss(handoff.id);
    expect(dismissed.status).toBe('dismissed');
    expect(stop).toHaveBeenCalledWith(i.id);
    expect(start).toHaveBeenCalledWith(i.id);
    expect(i.enqueue).toHaveBeenCalledTimes(1);
  });

  it('keeps the handoff waiting when the computer refuses the request', async () => {
    const i = integration();
    i.workspace.computers.patch(i.id, { browser: false });
    const handoff = await i.handoffs.start({ dotId: i.id, ...ask });
    expect(handoff.status).toBe('waiting');
    expect(i.fake.count_of('control/request')).toBe(0);
    expect(i.workspace.handoffs.waitingFor(i.id)?.id).toBe(handoff.id);
    expect(i.notify).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------
// End to end: the gate inside a real DotAgent, a queued fake model, the real HandoffService
// over the fake computer
// ---------------------------------------------------------------------------------------------

/** What the gate needs to know about the page, set by hand. */
class StubComputer implements GateComputer {
  url: string | undefined;
  elements: ElementIdentity[] = [];
  private known = new Map<number, Map<string, ElementIdentity>>();
  snapshot(
    id: number,
    url: string,
    refs: Record<string, [role: string, name: string]>,
  ) {
    this.url = url;
    const map = new Map(
      Object.entries(refs).map(([ref, [role, name]]) => [ref, { role, name }]),
    );
    this.known.set(id, map);
    this.elements = [...map.values()];
  }
  identityInTurn(ref: string, snapshotId: number) {
    return this.known.get(snapshotId)?.get(ref);
  }
  latestUrl() {
    return this.url;
  }
  latestElements() {
    return this.elements;
  }
  presumedFocus() {
    return undefined;
  }
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return completion(
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    'tool_calls',
  );
}
const text = (content: string) => completion({ role: 'assistant', content });
const systemText = (request: Json) =>
  JSON.stringify(request.messages.filter((m: Json) => m.role === 'system'));

function e2e(
  replies: Array<() => Response | Promise<Response>>,
  options: { tools?: ToolDefinition[] } = {},
) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const runner = new SqliteAgentRunner(':memory:');
  closers.push(store, workspace, runner);
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'TanStack');
  const fake = new FakeComputer();
  workspace.computers.patch(dot.id, {
    enabled: true,
    browser: true,
    files: true,
    shell: true,
  });
  const config: PlatformConfig = {
    apiKey: 'fixture',
    model: 'custom-model',
    baseUrl: 'https://unused.invalid/v1',
    voiceName: 'marin',
    computerSupervisorUrl: 'http://127.0.0.1:4312',
    computerSupervisorToken: 'supervisor-secret',
    computerToken: 'master-secret',
  };
  const requests: Json[] = [];
  const queue = [...replies];
  const computerFetch = fakeTransport(fake, dot.id);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (!String(input).startsWith('https://unused.invalid'))
      return computerFetch(input, init);
    requests.push(JSON.parse(String(init?.body)));
    const reply = queue.shift();
    if (!reply) throw new Error('Unexpected model request.');
    return reply();
  });

  const db = new DatabaseSync(':memory:');
  closers.push(db);
  const registry = new TurnRegistry();
  const resumeTurn = vi.fn(
    async (
      _threadId: string,
      _prompt: string,
      _signal: AbortSignal,
      _metadata: { source: string; ref?: string },
    ) => 'ok',
  );
  const resumes = new ResumeQueue({
    store: new ResumeStore(db),
    registry,
    turn: resumeTurn,
    log: () => {},
  });
  const notify = vi.fn(async () => {});
  const computers = new ComputerService(
    workspace,
    config,
    () => false,
    fakeTransport(fake, dot.id),
  );
  computers.setHandoffs(workspace.handoffs);
  const handoffs = new HandoffService({
    handoffs: workspace.handoffs,
    computers,
    resumes,
    audit: workspace.computers,
    notify,
    log: () => {},
  });
  const approvals = new ApprovalService({
    approvals: new ApprovalStore(db),
    resumes,
    audit: workspace.computers,
    notify,
    ttlMs: 60_000,
    log: () => {},
  });
  const screen = new StubComputer();
  hooks.extraTools = options.tools ?? [];
  hooks.gate = (budget) =>
    approvalGate({
      dotId: dot.id,
      dotName: dot.name,
      threadId: 'thread',
      source: 'chat',
      mode: 'sensitive',
      budget,
      approvals,
      handoffs,
      computer: screen,
      mcpInfo: () => undefined,
      parse: gateParse,
    }).middleware;
  const agent = () => new DotAgent(store, workspace, config, dot.id);
  const turn = (prompt: string) =>
    runThreadTurn(
      runner,
      agent(),
      'thread',
      prompt,
      new AbortController().signal,
    );
  const toolMessages = () =>
    runner
      .getThreadMessages('thread')
      .filter((message) => message.role === 'tool')
      .map((message) => String(message.content));
  return {
    dot,
    fake,
    screen,
    workspace,
    computers,
    handoffs,
    notify,
    resumeTurn,
    requests,
    turn,
    toolMessages,
  };
}

describe('handoffs inside a DotAgent turn', () => {
  it('stops at a password field: no typing, a waiting handoff, a control request and a wrap-up', async () => {
    const f = e2e([
      () =>
        toolCall('t1', 'computer_type', {
          ref: 'p1',
          snapshotId: 1,
          text: 'hunter2-secret',
        }),
      () => text('Please take control of the computer and sign in.'),
    ]);
    f.screen.snapshot(1, 'https://login.test/', {
      u1: ['textbox', 'Email'],
      p1: ['textbox', 'Password'],
      s1: ['button', 'Sign in'],
    });
    const reply = await f.turn('Sign in to the portal.');
    expect(reply).toBe('Please take control of the computer and sign in.');
    expect(f.fake.count_of('type')).toBe(0);

    const [row] = f.workspace.handoffs.list({ dotId: f.dot.id });
    expect(row).toMatchObject({
      status: 'waiting',
      kind: 'credential',
      threadId: 'thread',
    });
    expect(row.reason).toContain('Password');
    expect(f.fake.request).toMatchObject({ status: 'waiting' });
    expect(f.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Your turn on the computer',
        url: expect.stringMatching(/^\/#\/dots\/.+\/threads\/thread$/),
      }),
    );

    // The tool result tells the model what happened, and never holds the secret.
    expect(f.toolMessages()).toHaveLength(1);
    expect(f.toolMessages()[0]).toContain('"status":"handoff"');
    expect(f.toolMessages()[0]).not.toContain('hunter2');
    // The reply after it is the tool-less wrap-up that asks the owner to take control.
    expect(f.requests).toHaveLength(2);
    expect(f.requests[0].tools?.length).toBeGreaterThan(0);
    expect(f.requests[1].tools ?? []).toEqual([]);
    expect(systemText(f.requests[1])).toContain('take control');
  });

  it('classifies a verification-code field as two_factor', async () => {
    const f = e2e([
      () =>
        toolCall('t1', 'computer_type', {
          ref: 'c1',
          snapshotId: 1,
          text: '123456',
        }),
      () => text('Please take control and enter the code.'),
    ]);
    f.screen.snapshot(1, 'https://login.test/2fa', {
      c1: ['textbox', 'Verification code'],
    });
    await f.turn('Finish signing in.');
    expect(f.fake.count_of('type')).toBe(0);
    expect(f.workspace.handoffs.waitingFor(f.dot.id)).toMatchObject({
      kind: 'two_factor',
      status: 'waiting',
    });
    expect(f.fake.request).toMatchObject({ status: 'waiting' });
  });

  it('starts an "other" handoff for request_handoff', async () => {
    const f = e2e(
      [
        () =>
          toolCall('h1', 'request_handoff', {
            reason: 'Log in to the portal',
          }),
        () => text('Please take over the computer.'),
      ],
      { tools: [requestHandoffTool()] },
    );
    await f.turn('Check the portal.');
    expect(f.workspace.handoffs.waitingFor(f.dot.id)).toMatchObject({
      kind: 'other',
      reason: 'Log in to the portal',
    });
    expect(f.fake.request).toMatchObject({ status: 'waiting' });
    expect(f.requests[1].tools ?? []).toEqual([]);
    expect(systemText(f.requests[1])).toContain('take control');
  });

  it('resumes the Dot after the owner takes and releases control', async () => {
    const f = e2e([
      () =>
        toolCall('t1', 'computer_type', {
          ref: 'p1',
          snapshotId: 1,
          text: 'x',
        }),
      () => text('Please take control.'),
    ]);
    f.screen.snapshot(1, 'https://login.test/', {
      p1: ['textbox', 'Password'],
    });
    await f.turn('Sign in.');
    const [row] = f.workspace.handoffs.list({ dotId: f.dot.id });

    await f.computers.control(f.dot.id, 'take');
    await f.computers.control(f.dot.id, 'release');
    expect(f.handoffs.released(f.dot.id)?.id).toBe(row.id);
    expect(f.workspace.handoffs.get(row.id)?.status).toBe('done');
    await vi.waitFor(() => expect(f.resumeTurn).toHaveBeenCalledTimes(1));
    const [threadId, prompt, , metadata] = f.resumeTurn.mock.calls[0];
    expect(threadId).toBe('thread');
    expect(prompt).toContain('sign-in step');
    expect(prompt).toContain('computer_snapshot');
    expect(metadata).toEqual({ source: 'handoff', ref: row.id });
  });

  it('dismiss cancels the request and resumes the Dot with a stop instruction', async () => {
    const f = e2e(
      [
        () => toolCall('h1', 'request_handoff', { reason: 'Solve the check' }),
        () => text('Please take over.'),
      ],
      { tools: [requestHandoffTool()] },
    );
    await f.turn('Open the site.');
    const [row] = f.workspace.handoffs.list({ dotId: f.dot.id });
    await f.handoffs.dismiss(row.id);
    expect(f.fake.request?.status).toBe('cancelled');
    expect(f.workspace.handoffs.get(row.id)?.status).toBe('dismissed');
    await vi.waitFor(() => expect(f.resumeTurn).toHaveBeenCalledTimes(1));
    expect(f.resumeTurn.mock.calls[0][1]).toContain('declined');
    expect(f.resumeTurn.mock.calls[0][1]).toContain('Solve the check');
  });
});
