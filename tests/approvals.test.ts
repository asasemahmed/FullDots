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
  type GateDeps,
  type HandoffStarter,
} from '../src/server/approval-gate.js';
import {
  approvalPrompt,
  requestApprovalTool,
  requestHandoffTool,
} from '../src/server/approval-tools.js';
import { intentHash, type ElementIdentity } from '../src/server/approvals.js';
import { ComputerStore } from '../src/server/computer-store.js';
import { ResumeQueue } from '../src/server/resume-queue.js';
import { ResumeStore } from '../src/server/resume-store.js';
import { TurnRegistry } from '../src/server/turn-registry.js';
import type { Handoff, HandoffKind } from '../src/shared/types.js';
import { completion } from './fixtures/model-stream.js';
import { FakeComputer, fakeTransport } from './fixtures/fake-computer.js';

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
  vi.useRealTimers();
  hooks.gate = undefined;
  hooks.extraTools = [];
  closers.splice(0).forEach((closer) => closer.close());
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const DOT_NAME = 'Scout';
const NOTE = 'Not now, please.';

// ---------------------------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------------------------

/** Approval store + service + resume queue on one in-memory database; the resume turn is a mock. */
function services(
  options: {
    ttlMs?: number;
    taskOf?: (threadId: string) => string | undefined;
  } = {},
) {
  const db = new DatabaseSync(':memory:');
  closers.push(db);
  const clock = { t: 1_000_000 };
  const approvals = new ApprovalStore(db, () => clock.t);
  const resumeStore = new ResumeStore(db);
  const registry = new TurnRegistry();
  const turn = vi.fn(
    async (
      _threadId: string,
      _prompt: string,
      _signal: AbortSignal,
      _metadata: { source: string; ref?: string },
    ) => 'ok',
  );
  const resumes = new ResumeQueue({
    store: resumeStore,
    registry,
    turn,
    log: () => {},
  });
  const audit = new ComputerStore(db);
  const notify = vi.fn(async () => {});
  const recordTaskEvent = vi.fn();
  const service = new ApprovalService({
    approvals,
    resumes,
    audit,
    notify,
    ttlMs: options.ttlMs ?? 60_000,
    taskOf: options.taskOf,
    recordTaskEvent,
    log: () => {},
  });
  return {
    db,
    clock,
    approvals,
    resumeStore,
    registry,
    turn,
    resumes,
    audit,
    notify,
    recordTaskEvent,
    service,
  };
}
type Services = ReturnType<typeof services>;

const handoffRow = (
  input: { dotId: string; threadId: string; kind: HandoffKind; reason: string },
  id = 'handoff-1',
): Handoff => ({
  ...input,
  id,
  status: 'waiting',
  createdAt: 0,
  finishedAt: null,
  controlRequestId: null,
});
const fakeHandoffs = () => {
  const start = vi.fn<HandoffStarter['start']>(async (input) =>
    handoffRow(input),
  );
  return { start };
};

/** What the gate needs to know about the page, set by hand. */
class StubComputer implements GateComputer {
  url: string | undefined;
  elements: ElementIdentity[] = [];
  focus: ElementIdentity | undefined;
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
    return this.focus;
  }
}

/** Tool call ids are unique within a thread, so the rigs share one counter. */
let callSeq = 0;

type McpInfo = ReturnType<GateDeps['mcpInfo']>;

/** The gate with real stores, driven through its hooks the way TanStack calls them. */
function rig(
  options: {
    mode?: GateDeps['mode'];
    svc?: Services;
    computer?: GateComputer;
    handoffs?: HandoffStarter;
    mcp?: Record<string, McpInfo>;
    /** Makes this the resume turn of that approval: the only turn that may use it. */
    resume?: string;
  } = {},
) {
  const svc = options.svc ?? services();
  const budget: TurnBudget = {};
  const handoffs = (options.handoffs ?? fakeHandoffs()) as ReturnType<
    typeof fakeHandoffs
  >;
  const { middleware, gate } = approvalGate({
    dotId: 'dot',
    dotName: DOT_NAME,
    threadId: 'thread',
    source: options.resume ? 'approval' : 'chat',
    ...(options.resume ? { ref: options.resume } : {}),
    mode: options.mode ?? 'sensitive',
    budget,
    approvals: svc.service,
    handoffs,
    computer: options.computer,
    mcpInfo: (name) => options.mcp?.[name],
    parse: gateParse,
  });
  const before = (toolName: string, args: unknown, toolCallId?: string) =>
    middleware.onBeforeToolCall!({} as never, {
      toolCall: {} as never,
      tool: undefined,
      args,
      toolName,
      toolCallId: toolCallId ?? `call-${++callSeq}`,
    });
  const after = (toolName: string, result: unknown, ok = true) =>
    middleware.onAfterToolCall!({} as never, {
      toolCall: {} as never,
      tool: undefined,
      toolName,
      toolCallId: `after-${++callSeq}`,
      ok,
      duration: 1,
      result,
    });
  return { svc, budget, handoffs, gate, middleware, before, after };
}

/** The stored answer of a hook decision. */
const resultOf = (decision: unknown): Json => {
  const skipped = decision as { type?: string; result?: Json } | undefined;
  expect(skipped?.type).toBe('skip');
  return skipped?.result ?? {};
};
const rm = { command: 'rm -rf build' };

// ---------------------------------------------------------------------------------------------
// ApprovalService
// ---------------------------------------------------------------------------------------------

describe('ApprovalService', () => {
  const input = {
    threadId: 'thread',
    dotId: 'dot',
    toolCallId: 'call-1',
    tool: 'computer_exec',
    argsHash: 'hash-1',
    summary: 'Scout wants to run a shell command',
    argsRedacted: 'rm -rf build',
  };

  it('is idempotent on (threadId, toolCallId) and notifies only when the row is new', () => {
    const svc = services();
    const first = svc.service.request(input);
    const second = svc.service.request(input);
    expect(second.id).toBe(first.id);
    expect(svc.approvals.list({})).toHaveLength(1);
    expect(svc.notify).toHaveBeenCalledTimes(1);
    expect(svc.notify).toHaveBeenCalledWith({
      title: 'Approval needed',
      text: input.summary,
      url: '/#/approvals',
    });
  });

  it('gives a reused tool call id a fresh row when the old one is decided or for another action', () => {
    const svc = services();
    const first = svc.service.request(input);
    svc.service.decide(first.id, 'deny');
    const reused = svc.service.request(input);
    expect(reused.id).not.toBe(first.id);
    expect(reused.status).toBe('pending');
    expect(reused.toolCallId).toMatch(/^call-1#[0-9a-f]{8}$/);
    const other = svc.service.request({ ...input, argsHash: 'hash-2' });
    expect(other.id).not.toBe(reused.id);
    expect(svc.approvals.list({ status: 'pending' })).toHaveLength(2);
  });

  it('keeps a request alive when the notification fails', async () => {
    const svc = services();
    svc.notify.mockRejectedValueOnce(new Error('webhook down'));
    expect(svc.service.request(input).status).toBe('pending');
  });

  it('persists the decision, audits it and queues the resume turn with the exact prompts', async () => {
    const svc = services({ taskOf: () => 'task-1' });
    const approval = svc.service.request(input);
    const decided = svc.service.decide(approval.id, 'approve');
    expect(decided.status).toBe('approved');
    expect(svc.approvals.get(approval.id)?.status).toBe('approved');
    expect(svc.audit.auditEntries('dot')[0]).toMatchObject({
      tool: 'computer_exec',
      actor: 'owner',
      outcome: 'approved',
      threadId: 'thread',
    });
    expect(svc.recordTaskEvent).toHaveBeenCalledWith(
      'task-1',
      `Approval ${approval.id} approved; resumed in conversation.`,
    );
    await vi.waitFor(() => expect(svc.turn).toHaveBeenCalledTimes(1));
    expect(svc.turn).toHaveBeenCalledWith(
      'thread',
      `Approval ${approval.id} granted for: ${input.summary}. Perform exactly that action now.`,
      expect.any(AbortSignal),
      { source: 'approval', ref: approval.id },
    );
  });

  it('uses the advisory prompt for a summary-only approval', async () => {
    const svc = services();
    const approval = svc.service.request({
      ...input,
      toolCallId: 'call-2',
      tool: 'request_approval',
      argsHash: null,
    });
    svc.service.decide(approval.id, 'approve');
    await vi.waitFor(() => expect(svc.turn).toHaveBeenCalledTimes(1));
    expect(svc.turn.mock.calls[0][1]).toBe(
      `Approval ${approval.id} granted for: ${input.summary}. This grant is advisory: actions that need confirmation will still ask.`,
    );
  });

  it('puts the owner note in the denial prompt, and nothing when there is none', async () => {
    const svc = services();
    const a = svc.service.request(input);
    const b = svc.service.request({ ...input, toolCallId: 'call-2' });
    svc.service.decide(a.id, 'deny', NOTE);
    svc.service.decide(b.id, 'deny');
    await vi.waitFor(() => expect(svc.turn).toHaveBeenCalledTimes(1));
    expect(svc.turn.mock.calls[0][1]).toBe(
      `Approval ${a.id} was denied. Owner's note: ${JSON.stringify(NOTE)}. Do not perform that action. Acknowledge the decision and continue with anything else you can do, or stop.`,
    );
    expect(svc.audit.auditEntries('dot')[0]).toMatchObject({
      actor: 'owner',
      outcome: 'denied',
    });
    // The second marker waits for the first (one marker per thread at a time), then goes out.
    await vi.waitFor(() => expect(svc.turn).toHaveBeenCalledTimes(2));
    expect(svc.turn.mock.calls[1][1]).toBe(
      `Approval ${b.id} was denied. Do not perform that action. Acknowledge the decision and continue with anything else you can do, or stop.`,
    );
  });

  it('refuses to decide twice and queues nothing the second time', async () => {
    const svc = services();
    const approval = svc.service.request(input);
    svc.service.decide(approval.id, 'approve');
    expect(() => svc.service.decide(approval.id, 'deny')).toThrow(
      'Approval is not pending.',
    );
    await vi.waitFor(() => expect(svc.turn).toHaveBeenCalledTimes(1));
    expect(svc.resumeStore.all()).toHaveLength(0);
  });

  it('survives a failing audit or task event: the decision and the resume marker stay', async () => {
    const svc = services({ taskOf: () => 't' });
    svc.recordTaskEvent.mockImplementation(() => {
      throw new Error('event store down');
    });
    vi.spyOn(svc.audit, 'record').mockImplementation(() => {
      throw new Error('audit down');
    });
    const approval = svc.service.request(input);
    expect(svc.service.decide(approval.id, 'approve').status).toBe('approved');
    await vi.waitFor(() => expect(svc.turn).toHaveBeenCalledTimes(1));
  });

  it('consumes an approved hash once, for its own thread only', () => {
    const svc = services();
    const approval = svc.service.request(input);
    expect(svc.service.consume('thread', 'hash-1')).toBeUndefined();
    svc.service.decide(approval.id, 'approve');
    expect(svc.service.consume('other-thread', 'hash-1')).toBeUndefined();
    expect(svc.service.consume('thread', 'hash-1')?.id).toBe(approval.id);
    expect(svc.service.consume('thread', 'hash-1')).toBeUndefined();
    expect(svc.approvals.get(approval.id)?.status).toBe('consumed');
    expect(svc.audit.auditEntries('dot')[0]).toMatchObject({
      actor: 'agent',
      outcome: 'approved',
      tool: 'computer_exec',
    });
  });

  it('never consumes an advisory (summary-only) approval', () => {
    const svc = services();
    const approval = svc.service.request({
      ...input,
      tool: 'request_approval',
      argsHash: null,
    });
    svc.service.decide(approval.id, 'approve');
    for (const hash of ['hash-1', '', 'null', 'undefined'])
      expect(svc.service.consume('thread', hash)).toBeUndefined();
    expect(svc.approvals.get(approval.id)?.status).toBe('approved');
  });

  it('does not consume an approval that expired unused', () => {
    const svc = services({ ttlMs: 1000 });
    const approval = svc.service.request(input);
    svc.service.decide(approval.id, 'approve');
    svc.clock.t += 5000;
    expect(svc.service.consume('thread', 'hash-1')).toBeUndefined();
  });

  it('sweeps expired approvals on a timer that does not keep the process alive', () => {
    vi.useFakeTimers();
    const svc = services({ ttlMs: 500 });
    const approval = svc.service.request(input);
    svc.service.startSweep(1000);
    svc.service.startSweep(1000); // a second start changes nothing
    svc.clock.t += 2000;
    vi.advanceTimersByTime(1000);
    expect(svc.approvals.get(approval.id)?.status).toBe('expired');
    svc.service.stopSweep();
    const later = svc.service.request({ ...input, toolCallId: 'call-9' });
    svc.clock.t += 2000;
    vi.advanceTimersByTime(5000);
    expect(svc.approvals.get(later.id)?.status).toBe('pending');
  });

  it('unrefs its sweep timer', () => {
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation((() => ({
      unref,
    })) as unknown as typeof setInterval);
    const svc = services();
    svc.service.startSweep();
    expect(unref).toHaveBeenCalled();
    expect(spy.mock.calls[0][1]).toBe(600_000);
    svc.service.stopSweep();
  });
});

// ---------------------------------------------------------------------------------------------
// The gate, hook by hook
// ---------------------------------------------------------------------------------------------

describe('approval gate', () => {
  it('answers a destructive command with pending_approval and asks for the approval summary turn', async () => {
    const r = rig();
    const result = resultOf(await r.before('computer_exec', rm, 'c1'));
    expect(result).toMatchObject({
      status: 'pending_approval',
      summary: `${DOT_NAME} wants to run a shell command`,
    });
    expect(result.advisory).toBeUndefined();
    const [row] = r.svc.approvals.list({ status: 'pending' });
    expect(row).toMatchObject({
      id: result.approvalId,
      tool: 'computer_exec',
      toolCallId: 'c1',
      threadId: 'thread',
      dotId: 'dot',
    });
    // Defaults are applied before the exact text is made, so the timeout is shown.
    expect(row.argsRedacted).toBe('rm -rf build (timeout 30000 ms)');
    expect(result.exact).toBe(row.argsRedacted);
    expect(row.argsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.budget.wrapUp).toBe('approval');
    expect(r.gate.paused).toEqual({ kind: 'approval', ref: row.id });
  });

  it('lets ordinary tools run and creates nothing', async () => {
    const r = rig();
    expect(await r.before('computer_exec', { command: 'ls -la' })).toBe(
      undefined,
    );
    expect(await r.before('list_authorized_spaces', {})).toBe(undefined);
    expect(await r.before('search_web', { query: 'x' })).toBe(undefined);
    expect(r.svc.approvals.list({})).toHaveLength(0);
    expect(r.gate.paused).toBeUndefined();
    expect(r.budget.wrapUp).toBeUndefined();
  });

  it('gates every command in writes mode but not read-only page tools', async () => {
    const r = rig({ mode: 'writes' });
    expect(
      resultOf(await r.before('computer_exec', { command: 'ls' })).status,
    ).toBe('pending_approval');
    const q = rig({ mode: 'writes' });
    expect(await q.before('list_space_pages', {})).toBe(undefined);
    expect(
      resultOf(
        await q.before('create_space_page', { title: 'T', content: 'C' }),
      ).status,
    ).toBe('pending_approval');
  });

  it('answers sibling calls of a paused turn with "paused"', async () => {
    const r = rig();
    const first = resultOf(await r.before('computer_exec', rm, 'c1'));
    const second = resultOf(
      await r.before('computer_exec', { command: 'echo hi' }, 'c2'),
    );
    const third = resultOf(await r.before('list_authorized_spaces', {}, 'c3'));
    expect(second).toEqual({
      paused: 'approval pending',
      ref: first.approvalId,
    });
    expect(third).toEqual(second);
    expect(r.svc.approvals.list({})).toHaveLength(1);
  });

  it('pauses before any await, so a sibling started meanwhile sees the pause', async () => {
    const computer = new StubComputer();
    computer.snapshot(1, 'https://x.test/login', {
      p1: ['textbox', 'Password'],
    });
    let release!: (handoff: Handoff) => void;
    const handoffs = {
      start: vi.fn(
        () =>
          new Promise<Handoff>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const r = rig({ computer, handoffs });
    const handoff = r.before('computer_type', {
      ref: 'p1',
      snapshotId: 1,
      text: 'x',
    });
    // No await has happened yet.
    expect(r.gate.paused).toEqual({ kind: 'handoff', ref: 'pending' });
    expect(r.budget.wrapUp).toBe('handoff');
    const sibling = resultOf(await r.before('computer_exec', rm, 'c2'));
    expect(sibling).toEqual({ paused: 'handoff pending', ref: 'pending' });
    release(
      handoffRow({
        dotId: 'dot',
        threadId: 'thread',
        kind: 'credential',
        reason: 'r',
      }),
    );
    expect(resultOf(await handoff).handoffId).toBe('handoff-1');
    expect(r.gate.paused).toEqual({ kind: 'handoff', ref: 'handoff-1' });
    expect(r.svc.approvals.list({})).toHaveLength(0);
  });

  it('does not touch the computer when typing into a password field: handoff instead', async () => {
    const computer = new StubComputer();
    computer.snapshot(1, 'https://x.test/login', {
      u1: ['textbox', 'Email'],
      p1: ['textbox', 'Password'],
      s1: ['button', 'Sign in'],
    });
    const r = rig({ computer });
    const result = resultOf(
      await r.before('computer_type', { ref: 'p1', snapshotId: 1, text: 'pw' }),
    );
    expect(r.handoffs.start).toHaveBeenCalledWith({
      dotId: 'dot',
      threadId: 'thread',
      kind: 'credential',
      reason: expect.stringContaining('Password'),
    });
    expect(result).toMatchObject({
      status: 'handoff',
      handoffId: 'handoff-1',
      kind: 'credential',
    });
    expect(r.budget.wrapUp).toBe('handoff');
    // Detection does not depend on the approval mode, and the typed secret is nowhere in the result.
    expect(JSON.stringify(result)).not.toContain('pw');
    const off = rig({ computer, mode: 'off' });
    expect(
      resultOf(
        await off.before('computer_type', {
          ref: 'u1',
          snapshotId: 1,
          text: 'a',
        }),
      ).status,
    ).toBe('handoff'); // a sign-in form: any text field is part of it
  });

  it('classifies a verification-code field as two-factor', async () => {
    const computer = new StubComputer();
    computer.snapshot(1, 'https://x.test/2fa', {
      c1: ['textbox', 'Verification code'],
    });
    const r = rig({ computer });
    await r.before('computer_type', { ref: 'c1', snapshotId: 1, text: '1' });
    expect(r.handoffs.start.mock.calls[0][0].kind).toBe('two_factor');
  });

  it('leaves typing into an unknown element to the computer layer, which refuses it', async () => {
    const computer = new StubComputer();
    computer.snapshot(1, 'https://x.test/', { a: ['textbox', 'Name'] });
    const r = rig({ computer });
    expect(
      await r.before('computer_type', { ref: 'zz', snapshotId: 9, text: 'x' }),
    ).toBe(undefined);
    expect(await r.before('computer_click', { ref: 'a', snapshotId: 4 })).toBe(
      undefined,
    );
    expect(r.svc.approvals.list({})).toHaveLength(0);
    expect(r.handoffs.start).not.toHaveBeenCalled();
    expect(r.gate.paused).toBeUndefined();
  });

  it('does not pause the turn when the handoff cannot be started', async () => {
    const computer = new StubComputer();
    computer.snapshot(1, 'https://x.test/login', {
      p1: ['textbox', 'Password'],
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = rig({
      computer,
      handoffs: { start: vi.fn().mockRejectedValue(new Error('db down')) },
    });
    const result = resultOf(
      await r.before('computer_type', { ref: 'p1', snapshotId: 1, text: 'x' }),
    );
    expect(result.error).toContain('could not be asked');
    expect(r.gate.paused).toBeUndefined();
    expect(r.budget.wrapUp).toBeUndefined();
  });

  it('pauses on Enter in a message box when the page has a Send button, without a key press', async () => {
    const computer = new StubComputer();
    computer.snapshot(1, 'https://x.test/chat', {
      m1: ['textbox', 'Message'],
      s1: ['button', 'Send'],
    });
    computer.focus = { role: 'textbox', name: 'Message' };
    const r = rig({ computer });
    expect(await r.before('computer_key', { key: 'Tab' })).toBe(undefined);
    const result = resultOf(await r.before('computer_key', { key: 'Enter' }));
    expect(result.status).toBe('pending_approval');
    expect(result.summary).toBe(
      `${DOT_NAME} wants to press Enter in the textbox "Message"`,
    );
    expect(result.exact).toBe('press Enter in textbox "Message"');
    // Typing with submit on the same page is the same case.
    const t = rig({ computer });
    expect(
      resultOf(
        await t.before('computer_type', {
          ref: 'm1',
          snapshotId: 1,
          text: 'hello',
          submit: true,
        }),
      ).status,
    ).toBe('pending_approval');
    // Typing without submitting is plain typing.
    expect(
      await rig({ computer }).before('computer_type', {
        ref: 'm1',
        snapshotId: 1,
        text: 'hello',
      }),
    ).toBe(undefined);
  });

  it('uses up an approval with a click that has a new ref, snapshot id and query string', async () => {
    const computer = new StubComputer();
    computer.snapshot(3, 'https://x.test/compose?draft=1#top', {
      e5: ['button', 'Send'],
    });
    const r = rig({ computer });
    const first = resultOf(
      await r.before('computer_click', { ref: 'e5', snapshotId: 3 }, 'c1'),
    );
    expect(first.status).toBe('pending_approval');
    expect(first.exact).toBe('click button "Send"');
    r.svc.service.decide(first.approvalId, 'approve');

    // The page was rendered again: refs are renumbered, the query string changed.
    const next = rig({ svc: r.svc, computer, resume: first.approvalId });
    computer.snapshot(7, 'https://x.test/compose/?draft=2', {
      e9: ['button', ' send '],
    });
    expect(
      await next.before('computer_click', { ref: 'e9', snapshotId: 7 }, 'c2'),
    ).toBe(undefined);
    expect(r.svc.approvals.get(first.approvalId)?.status).toBe('consumed');

    // The approval was used up: the same click asks again.
    const again = rig({ svc: r.svc, computer });
    const second = resultOf(
      await again.before('computer_click', { ref: 'e9', snapshotId: 7 }, 'c3'),
    );
    expect(second.status).toBe('pending_approval');
    expect(second.approvalId).not.toBe(first.approvalId);
  });

  it('does not use an approval for the same click on another page or another element', async () => {
    const computer = new StubComputer();
    computer.snapshot(1, 'https://x.test/compose', { e5: ['button', 'Send'] });
    const r = rig({ computer });
    const first = resultOf(
      await r.before('computer_click', { ref: 'e5', snapshotId: 1 }),
    );
    r.svc.service.decide(first.approvalId, 'approve');
    computer.snapshot(2, 'https://x.test/other', { e5: ['button', 'Send'] });
    const other = rig({ svc: r.svc, computer, resume: first.approvalId });
    expect(
      resultOf(
        await other.before('computer_click', { ref: 'e5', snapshotId: 2 }),
      ).status,
    ).toBe('pending_approval');
    computer.snapshot(3, 'https://x.test/compose', {
      e5: ['button', 'Delete draft'],
    });
    const third = rig({ svc: r.svc, computer, resume: first.approvalId });
    expect(
      resultOf(
        await third.before('computer_click', { ref: 'e5', snapshotId: 3 }),
      ).status,
    ).toBe('pending_approval');
    expect(r.svc.approvals.get(first.approvalId)?.status).toBe('approved');
  });

  it('lets an approved command run exactly once, whatever page was open when it was asked', async () => {
    const computer = new StubComputer();
    computer.snapshot(1, 'https://x.test/a', {});
    const r = rig({ computer });
    const first = resultOf(await r.before('computer_exec', rm));
    r.svc.service.decide(first.approvalId, 'approve');
    // The resume turn has not looked at any page yet.
    const next = rig({
      svc: r.svc,
      computer: new StubComputer(),
      resume: first.approvalId,
    });
    expect(
      await next.before('computer_exec', { command: ' rm -rf build ' }),
    ).toBe(undefined);
    expect(r.svc.approvals.get(first.approvalId)?.status).toBe('consumed');
    expect(
      resultOf(await rig({ svc: r.svc }).before('computer_exec', rm))
        .approvalId,
    ).not.toBe(first.approvalId);
  });

  it('never uses an approval outside its own resume turn', async () => {
    const r = rig();
    const first = resultOf(await r.before('computer_exec', rm));
    r.svc.service.decide(first.approvalId, 'approve');
    // A chat turn, or the resume turn of another approval, asks again.
    for (const later of [
      rig({ svc: r.svc }),
      rig({ svc: r.svc, resume: 'another-approval' }),
    ])
      expect(resultOf(await later.before('computer_exec', rm)).status).toBe(
        'pending_approval',
      );
    expect(r.svc.approvals.get(first.approvalId)?.status).toBe('approved');
    // The resume turn ended without using it: it lapses.
    expect(r.svc.service.lapse(first.approvalId)).toBe(true);
    expect(r.svc.approvals.get(first.approvalId)?.status).toBe('expired');
    expect(
      await rig({ svc: r.svc, resume: first.approvalId }).before(
        'computer_exec',
        rm,
      ),
    ).not.toBe(undefined);
  });

  it('is idempotent when the same tool call is gated again after a restart', async () => {
    const svc = services();
    const a = resultOf(await rig({ svc }).before('computer_exec', rm, 'same'));
    const b = resultOf(await rig({ svc }).before('computer_exec', rm, 'same'));
    expect(b.approvalId).toBe(a.approvalId);
    expect(svc.approvals.list({})).toHaveLength(1);
    expect(svc.notify).toHaveBeenCalledTimes(1);
  });

  it('keeps an advisory approval from unlocking the next gated call', async () => {
    const r = rig();
    const asked = resultOf(
      await r.before(
        'request_approval',
        { summary: 'Delete the old build output' },
        'a1',
      ),
    );
    expect(asked).toMatchObject({ status: 'pending_approval', advisory: true });
    const [row] = r.svc.approvals.list({});
    expect(row).toMatchObject({
      tool: 'request_approval',
      argsHash: null,
      summary: 'Delete the old build output',
      argsRedacted: '(no specific action: advisory)',
    });
    expect(r.budget.wrapUp).toBe('approval');
    r.svc.service.decide(row.id, 'approve');

    const next = rig({ svc: r.svc, resume: row.id });
    const gated = resultOf(await next.before('computer_exec', rm, 'c1'));
    expect(gated.status).toBe('pending_approval');
    expect(gated.approvalId).not.toBe(row.id);
    expect(r.svc.approvals.get(row.id)?.status).toBe('approved');
  });

  it('covers exactly the intent a request_approval names, and the command then runs once', async () => {
    const r = rig();
    const asked = resultOf(
      await r.before('request_approval', {
        summary: 'Remove the build folder',
        intent: { tool: 'computer_exec', args: rm },
      }),
    );
    expect(asked.status).toBe('pending_approval');
    expect(asked.advisory).toBeUndefined();
    const row = r.svc.approvals.get(asked.approvalId)!;
    expect(row).toMatchObject({
      tool: 'computer_exec',
      summary: 'Remove the build folder',
      argsRedacted: 'rm -rf build (timeout 30000 ms)',
    });
    expect(row.argsHash).toBe(
      intentHash({
        tool: 'computer_exec',
        args: { command: 'rm -rf build', timeoutMs: 30000 },
      }),
    );
    r.svc.service.decide(row.id, 'approve');
    const next = rig({ svc: r.svc, resume: row.id });
    expect(await next.before('computer_exec', rm)).toBe(undefined);
    expect(r.svc.approvals.get(row.id)?.status).toBe('consumed');
  });

  it('resolves a click intent on the server, so the later click matches whatever its ref is', async () => {
    const computer = new StubComputer();
    computer.snapshot(2, 'https://x.test/form?a=1', {
      b1: ['button', 'Place order'],
    });
    const r = rig({ computer });
    const asked = resultOf(
      await r.before('request_approval', {
        summary: 'Place the order',
        intent: { tool: 'computer_click', args: { ref: 'b1', snapshotId: 2 } },
      }),
    );
    const row = r.svc.approvals.get(asked.approvalId)!;
    expect(row.argsHash).toBe(
      intentHash({
        tool: 'computer_click',
        url: 'https://x.test/form',
        element: { role: 'button', name: 'place order' },
        args: {},
      }),
    );
    expect(row.argsRedacted).toBe('click button "Place order"');
    r.svc.service.decide(row.id, 'approve');
    computer.snapshot(9, 'https://x.test/form?a=2', {
      z7: ['button', 'Place order'],
    });
    expect(
      await rig({ svc: r.svc, computer, resume: row.id }).before(
        'computer_click',
        {
          ref: 'z7',
          snapshotId: 9,
        },
      ),
    ).toBe(undefined);
  });

  it('answers a request_approval whose ref is not from this turn with a tool error', async () => {
    const computer = new StubComputer();
    computer.snapshot(2, 'https://x.test/', { b1: ['button', 'Send'] });
    const r = rig({ computer });
    for (const args of [
      { ref: 'b1', snapshotId: 1 },
      { ref: 'nope', snapshotId: 2 },
    ])
      expect(
        resultOf(
          await r.before('request_approval', {
            summary: 'Send it',
            intent: { tool: 'computer_click', args },
          }),
        ),
      ).toEqual({
        error:
          'That ref is not from this turn. Take a fresh snapshot and call request_approval again.',
      });
    // Without a computer there is nothing to resolve a ref against.
    expect(
      resultOf(
        await rig().before('request_approval', {
          summary: 'Send it',
          intent: {
            tool: 'computer_click',
            args: { ref: 'b1', snapshotId: 2 },
          },
        }),
      ).error,
    ).toContain('not from this turn');
    expect(r.svc.approvals.list({})).toHaveLength(0);
    expect(r.gate.paused).toBeUndefined();
    expect(r.budget.wrapUp).toBeUndefined();
  });

  it('answers a request_approval with invalid arguments with the validation message', async () => {
    const r = rig();
    const badIntent = resultOf(
      await r.before('request_approval', {
        summary: 'Run it',
        intent: { tool: 'computer_exec', args: { command: '' } },
      }),
    );
    expect(String(badIntent.error)).toContain('command');
    const noSummary = resultOf(
      await r.before('request_approval', { summary: '' }),
    );
    expect(String(noSummary.error)).toContain('summary');
    const noReason = resultOf(await r.before('request_handoff', {}));
    expect(String(noReason.error)).toContain('reason');
    expect(r.svc.approvals.list({})).toHaveLength(0);
    expect(r.gate.paused).toBeUndefined();
  });

  it('starts a handoff of kind other for request_handoff', async () => {
    const r = rig();
    const result = resultOf(
      await r.before('request_handoff', { reason: 'Log in to the portal' }),
    );
    expect(r.handoffs.start).toHaveBeenCalledWith({
      dotId: 'dot',
      threadId: 'thread',
      kind: 'other',
      reason: 'Log in to the portal',
    });
    expect(result).toEqual({
      status: 'handoff',
      handoffId: 'handoff-1',
      kind: 'other',
      reason: 'Log in to the portal',
      note: 'Nothing was typed: the owner enters this on the live screen.',
    });
    expect(r.budget.wrapUp).toBe('handoff');
    expect(r.gate.paused).toEqual({ kind: 'handoff', ref: 'handoff-1' });
  });

  it('starts a captcha handoff when a computer result carries a challenge, once per turn', async () => {
    const r = rig();
    await r.after('computer_navigate', { url: 'https://x.test', page: {} });
    expect(r.handoffs.start).not.toHaveBeenCalled();
    await r.after('computer_navigate', {
      url: 'https://x.test',
      page: { challenge: { kind: 'recaptcha', reason: 'A human check' } },
    });
    expect(r.handoffs.start).toHaveBeenCalledWith({
      dotId: 'dot',
      threadId: 'thread',
      kind: 'captcha',
      reason: 'A human check',
    });
    expect(r.budget.wrapUp).toBe('handoff');
    expect(r.gate.paused).toEqual({ kind: 'handoff', ref: 'handoff-1' });
    await r.after('computer_click', {
      challenge: { kind: 'recaptcha', reason: 'Again' },
    });
    expect(r.handoffs.start).toHaveBeenCalledTimes(1);
    // The turn is paused, so what the model tries next is answered "paused".
    expect(resultOf(await r.before('computer_exec', rm)).paused).toBe(
      'handoff pending',
    );
  });

  it('ignores challenges in failed calls and in tools that are not the computer', async () => {
    const r = rig();
    const challenge = { challenge: { kind: 'x', reason: 'A human check' } };
    await r.after('computer_click', challenge, false);
    await r.after('search_web', challenge);
    expect(r.handoffs.start).not.toHaveBeenCalled();
  });

  it('gates nothing in mode off except a deny override, and still honours an ask override', async () => {
    const r = rig({
      mode: 'off',
      mcp: {
        mcp__gh__create_issue: {
          readOnly: false,
          destructive: false,
        },
        mcp__gh__merge: {
          readOnly: false,
          destructive: true,
          override: 'ask',
        },
        mcp__gh__drop: {
          readOnly: false,
          destructive: true,
          override: 'deny',
        },
      },
    });
    expect(await r.before('computer_exec', rm)).toBe(undefined);
    expect(
      await r.before('create_space_page', { title: 'T', content: 'C' }),
    ).toBe(undefined);
    expect(await r.before('mcp__gh__create_issue', { title: 't' })).toBe(
      undefined,
    );
    expect(resultOf(await r.before('mcp__gh__drop', {}))).toEqual({
      error: 'The owner denied this tool for this Dot.',
    });
    expect(r.svc.approvals.list({})).toHaveLength(0);
    expect(r.gate.paused).toBeUndefined();
    // An `ask` override is more specific than the Dot's mode.
    const asked = resultOf(await r.before('mcp__gh__merge', { pr: 1 }));
    expect(asked.status).toBe('pending_approval');
    expect(asked.summary).toBe(`${DOT_NAME} wants to use mcp__gh__merge`);
    // Passwords still need the owner in mode off.
    const computer = new StubComputer();
    computer.snapshot(1, 'https://x.test/', { p: ['textbox', 'Password'] });
    const off = rig({ mode: 'off', computer });
    expect(
      resultOf(
        await off.before('computer_type', {
          ref: 'p',
          snapshotId: 1,
          text: 'x',
        }),
      ).status,
    ).toBe('handoff');
  });

  it('gates connector tools by what they change, and matches approvals by their arguments', async () => {
    const mcp = {
      mcp__gh__list: { readOnly: true, destructive: false },
      mcp__gh__create_issue: { readOnly: false, destructive: false },
      mcp__gh__delete_repo: { readOnly: false, destructive: true },
    };
    const r = rig({ mcp });
    expect(await r.before('mcp__gh__list', {})).toBe(undefined);
    // Changes data, but not destructive: only writes mode asks.
    expect(await r.before('mcp__gh__create_issue', { title: 't' })).toBe(
      undefined,
    );
    expect(
      resultOf(
        await rig({ mode: 'writes', mcp }).before('mcp__gh__create_issue', {
          title: 't',
        }),
      ).status,
    ).toBe('pending_approval');
    const asked = resultOf(
      await r.before('mcp__gh__delete_repo', { owner: 'a', repo: 'b' }),
    );
    expect(asked.exact).toBe('mcp__gh__delete_repo {"owner":"a","repo":"b"}');
    r.svc.service.decide(asked.approvalId, 'approve');
    const next = rig({ svc: r.svc, mcp, resume: asked.approvalId });
    // Another repo is another action; key order does not matter for the same one.
    expect(
      resultOf(
        await next.before('mcp__gh__delete_repo', { owner: 'a', repo: 'c' }),
      ).status,
    ).toBe('pending_approval');
    const again = rig({ svc: r.svc, mcp, resume: asked.approvalId });
    expect(
      await again.before('mcp__gh__delete_repo', { repo: 'b', owner: 'a' }),
    ).toBe(undefined);
  });

  it('masks secrets in the exact text of a connector call', async () => {
    const r = rig({
      mcp: { mcp__x__send: { readOnly: false, destructive: true } },
    });
    const result = resultOf(
      await r.before('mcp__x__send', { to: 'a', apiToken: 'sekret-123' }),
    );
    expect(String(result.exact)).not.toContain('sekret-123');
    expect(String(result.exact)).toContain('[hidden]');
  });

  it('lets a tool with invalid computer arguments through to its own validation', async () => {
    const r = rig();
    expect(await r.before('computer_exec', { command: 5 })).toBe(undefined);
    expect(await r.before('computer_click', { nope: true })).toBe(undefined);
    expect(r.svc.approvals.list({})).toHaveLength(0);
  });

  it('does not use an approval after it expired', async () => {
    const svc = services({ ttlMs: 1000 });
    const first = resultOf(await rig({ svc }).before('computer_exec', rm));
    svc.service.decide(first.approvalId, 'approve');
    svc.clock.t += 5000;
    const next = resultOf(await rig({ svc }).before('computer_exec', rm));
    expect(next.status).toBe('pending_approval');
    expect(next.approvalId).not.toBe(first.approvalId);
    expect(svc.approvals.expire()).toBeGreaterThanOrEqual(1);
    expect(svc.approvals.get(first.approvalId)?.status).toBe('expired');
  });
});

describe('gateParse', () => {
  it('applies computer schema defaults and trims', () => {
    expect(gateParse('computer_exec', { command: '  ls  ' })).toEqual({
      command: 'ls',
      timeoutMs: 30000,
    });
    expect(gateParse('computer_click', { ref: 'a', snapshotId: 2 })).toEqual({
      ref: 'a',
      snapshotId: 2,
    });
    expect(
      gateParse('computer_select', {
        ref: 'a',
        snapshotId: 2,
        option: ' Blue ',
      }),
    ).toEqual({ ref: 'a', snapshotId: 2, option: 'Blue' });
  });

  it('throws for invalid computer arguments and unknown keys', () => {
    expect(() => gateParse('computer_exec', { command: '' })).toThrow();
    expect(() => gateParse('computer_click', { ref: 'a' })).toThrow();
    expect(() =>
      gateParse('computer_key', { key: 'Enter', extra: 1 }),
    ).toThrow();
  });

  it('passes other tools through as plain objects', () => {
    expect(gateParse('mcp__x__y', { a: 1 })).toEqual({ a: 1 });
    expect(gateParse('create_space_page', { title: 'T' })).toEqual({
      title: 'T',
    });
    expect(gateParse('mcp__x__y', undefined)).toEqual({});
    expect(gateParse('mcp__x__y', [1])).toEqual({});
    // Owner-only actions are not agent tools and are not parsed here.
    expect(gateParse('computer_human_click', { x: 'a' })).toEqual({ x: 'a' });
  });
});

describe('approval tools and prompt', () => {
  it('defines request_approval and request_handoff with bounded parameters', () => {
    const approval = requestApprovalTool();
    const handoff = requestHandoffTool();
    expect([approval.name, handoff.name]).toEqual([
      'request_approval',
      'request_handoff',
    ]);
    expect(approval.description).toMatch(/intent/);
    expect(handoff.description).toMatch(/password|verification/i);
    const ok = (tool: ToolDefinition, value: unknown) =>
      (
        tool.parameters as unknown as {
          safeParse: (v: unknown) => { success: boolean };
        }
      ).safeParse(value).success;
    expect(ok(approval, { summary: 'x' })).toBe(true);
    expect(
      ok(approval, {
        summary: 'x',
        intent: { tool: 'computer_exec', args: { command: 'ls' } },
      }),
    ).toBe(true);
    expect(ok(approval, { summary: '' })).toBe(false);
    expect(ok(approval, { summary: 'x'.repeat(501) })).toBe(false);
    expect(ok(approval, { summary: 'x', intent: { tool: 'a' } })).toBe(false);
    expect(ok(handoff, { reason: 'Log in' })).toBe(true);
    expect(ok(handoff, { reason: 'x'.repeat(301) })).toBe(false);
    expect(ok(handoff, {})).toBe(false);
  });

  it('has executors that only say the approval system handles the tool', async () => {
    for (const tool of [requestApprovalTool(), requestHandoffTool()])
      expect(await tool.execute!({} as never)).toEqual({
        error: 'This tool is handled by the approval system.',
      });
  });

  it('gives the prompt for each approval mode', () => {
    for (const mode of ['sensitive', 'writes'] as const) {
      const text = approvalPrompt(mode);
      expect(text).toContain('pending_approval');
      expect(text).toContain('request_approval');
      expect(text).toContain('request_handoff');
      expect(text).toContain('never try to solve a verification challenge');
    }
    const off = approvalPrompt('off');
    expect(off).toContain('without asking');
    expect(off).toContain('request_handoff');
    expect(off).not.toContain('pending_approval');
    expect(off.length).toBeLessThan(approvalPrompt('sensitive').length);
  });
});

// ---------------------------------------------------------------------------------------------
// End to end: the gate inside a real DotAgent, a queued fake model and a fake computer
// ---------------------------------------------------------------------------------------------

function toolCalls(
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
  content?: string,
) {
  return completion(
    {
      role: 'assistant',
      ...(content ? { content } : {}),
      tool_calls: calls.map((call, index) => ({
        index,
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    },
    'tool_calls',
  );
}
const toolCall = (id: string, name: string, args: Record<string, unknown>) =>
  toolCalls([{ id, name, args }]);
const text = (content: string) => completion({ role: 'assistant', content });

function e2e(
  replies: Array<() => Response | Promise<Response>>,
  options: { mode?: GateDeps['mode']; tools?: ToolDefinition[] } = {},
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

  const svc = services();
  const handoffs = fakeHandoffs();
  const gates: ReturnType<typeof approvalGate>['gate'][] = [];
  hooks.extraTools = options.tools ?? [];
  // The gate sees the turn's origin the way dot-agent.ts reads it from the stored user message.
  let origin: { source: 'approval'; ref: string } | undefined;
  hooks.gate = (budget) => {
    const built = approvalGate({
      dotId: dot.id,
      dotName: dot.name,
      threadId: 'thread',
      source: origin?.source ?? 'chat',
      ...(origin ? { ref: origin.ref } : {}),
      mode: options.mode ?? 'sensitive',
      budget,
      approvals: svc.service,
      handoffs,
      mcpInfo: () => undefined,
      parse: gateParse,
    });
    gates.push(built.gate);
    return built.middleware;
  };
  const agent = () => new DotAgent(store, workspace, config, dot.id);
  const turn = (
    prompt: string,
    metadata?: { source: 'approval'; ref: string },
  ) => {
    origin = metadata;
    return runThreadTurn(
      runner,
      agent(),
      'thread',
      prompt,
      new AbortController().signal,
      metadata,
    );
  };
  const toolMessages = () =>
    runner
      .getThreadMessages('thread')
      .filter((message) => message.role === 'tool')
      .map((message) => String(message.content));
  return {
    dot,
    fake,
    svc,
    handoffs,
    gates,
    requests,
    queue,
    turn,
    toolMessages,
    runner,
  };
}
const systemText = (request: Json) =>
  JSON.stringify(request.messages.filter((m: Json) => m.role === 'system'));

describe('approval gate inside a DotAgent turn', () => {
  it('pauses a destructive command, resumes on approval and runs it exactly once', async () => {
    const f = e2e([
      () => toolCall('c1', 'computer_exec', rm),
      () => text('I am waiting for your approval to delete the build folder.'),
    ]);
    const reply = await f.turn('Clean the build folder.');
    expect(reply).toBe(
      'I am waiting for your approval to delete the build folder.',
    );
    expect(f.fake.count_of('exec')).toBe(0);
    // The stored tool message is the pending result; the next model request had no tools.
    expect(f.toolMessages()).toHaveLength(1);
    expect(f.toolMessages()[0]).toContain('pending_approval');
    expect(f.requests).toHaveLength(2);
    expect(f.requests[0].tools?.length).toBeGreaterThan(0);
    expect(f.requests[1].tools ?? []).toEqual([]);
    expect(systemText(f.requests[1])).toContain(
      "waiting for the owner's approval",
    );
    const pending = f.svc.approvals.list({ status: 'pending' });
    expect(pending).toHaveLength(1);
    const [row] = pending;
    expect(row.argsRedacted).toContain('rm -rf build');
    expect(row).toMatchObject({
      tool: 'computer_exec',
      toolCallId: 'c1',
      summary: `${f.dot.name} wants to run a shell command`,
    });
    expect(f.svc.notify).toHaveBeenCalledTimes(1);
    expect(f.svc.registry.isThreadRunning('thread')).toBe(false);

    // The owner approves: a resume marker goes out with the granted prompt.
    f.svc.service.decide(row.id, 'approve');
    await vi.waitFor(() => expect(f.svc.turn).toHaveBeenCalledTimes(1));
    const [threadId, prompt, , metadata] = f.svc.turn.mock.calls[0];
    expect(threadId).toBe('thread');
    expect(prompt).toBe(
      `Approval ${row.id} granted for: ${row.summary}. Perform exactly that action now.`,
    );
    expect(metadata).toEqual({ source: 'approval', ref: row.id });

    // The resume turn (what the queue would run): the same command now executes, once.
    f.queue.push(
      () => toolCall('c2', 'computer_exec', rm),
      () => text('The build folder is gone.'),
    );
    expect(await f.turn(prompt, { source: 'approval', ref: row.id })).toBe(
      'The build folder is gone.',
    );
    expect(f.fake.count_of('exec')).toBe(1);
    expect(f.svc.approvals.get(row.id)?.status).toBe('consumed');
    expect(f.svc.approvals.list({ status: 'pending' })).toHaveLength(0);
    // The resume turn kept its source in the stored thread.
    const resumeMessage = f.runner
      .getThreadMessages('thread')
      .find((message) => message.role === 'user' && message.content === prompt);
    expect(resumeMessage).toMatchObject({
      metadata: { source: 'approval', ref: row.id },
    });

    // Asking again needs a new approval, and nothing more runs.
    f.queue.push(
      () => toolCall('c3', 'computer_exec', rm),
      () => text('Waiting again.'),
    );
    await f.turn('Do it once more.');
    expect(f.fake.count_of('exec')).toBe(1);
    const again = f.svc.approvals.list({ status: 'pending' });
    expect(again).toHaveLength(1);
    expect(again[0].id).not.toBe(row.id);
  });

  it('puts the owner note into the resume prompt of a denial and runs nothing', async () => {
    const f = e2e([
      () => toolCall('c1', 'computer_exec', rm),
      () => text('Waiting.'),
    ]);
    await f.turn('Clean up.');
    const [row] = f.svc.approvals.list({ status: 'pending' });
    f.svc.service.decide(row.id, 'deny', NOTE);
    await vi.waitFor(() => expect(f.svc.turn).toHaveBeenCalledTimes(1));
    expect(f.svc.turn.mock.calls[0][1]).toContain(
      `Owner's note: ${JSON.stringify(NOTE)}`,
    );
    expect(f.svc.turn.mock.calls[0][3]).toEqual({
      source: 'approval',
      ref: row.id,
    });
    expect(f.svc.approvals.get(row.id)?.status).toBe('denied');
    expect(f.fake.count_of('exec')).toBe(0);
  });

  it('answers the sibling calls of a paused reply with "paused" and runs none of them', async () => {
    const f = e2e([
      () =>
        toolCalls([
          { id: 'c1', name: 'computer_exec', args: rm },
          { id: 'c2', name: 'computer_exec', args: { command: 'echo hi' } },
          { id: 'c3', name: 'list_authorized_spaces', args: {} },
        ]),
      () => text('Waiting.'),
    ]);
    await f.turn('Clean up and say hi.');
    expect(f.fake.count_of('exec')).toBe(0);
    const messages = f.toolMessages();
    expect(messages).toHaveLength(3);
    expect(messages[0]).toContain('pending_approval');
    expect(messages[1]).toContain('approval pending');
    expect(messages[2]).toContain('approval pending');
    expect(f.svc.approvals.list({})).toHaveLength(1);
    expect(f.requests[1].tools ?? []).toEqual([]);
  });

  it('runs an ordinary command without asking', async () => {
    const f = e2e([
      () => toolCall('c1', 'computer_exec', { command: 'ls' }),
      () => text('Listed.'),
    ]);
    expect(await f.turn('List files.')).toBe('Listed.');
    expect(f.fake.count_of('exec')).toBe(1);
    expect(f.svc.approvals.list({})).toHaveLength(0);
    expect(f.svc.notify).not.toHaveBeenCalled();
  });

  it('runs a destructive command in mode off', async () => {
    const f = e2e(
      [() => toolCall('c1', 'computer_exec', rm), () => text('Gone.')],
      { mode: 'off' },
    );
    expect(await f.turn('Clean up.')).toBe('Gone.');
    expect(f.fake.count_of('exec')).toBe(1);
    expect(f.svc.approvals.list({})).toHaveLength(0);
  });

  it('keeps a summary-only request_approval advisory: the next gated call still asks', async () => {
    const f = e2e(
      [
        () =>
          toolCall('a1', 'request_approval', {
            summary: 'Delete the old build output',
          }),
        () => text('Asked the owner.'),
      ],
      { tools: [requestApprovalTool(), requestHandoffTool()] },
    );
    expect(await f.turn('Tidy up.')).toBe('Asked the owner.');
    // The tools reached the model with usable schemas.
    expect(JSON.stringify(f.requests[0].tools)).toContain('request_approval');
    expect(JSON.stringify(f.requests[0].tools)).toContain('request_handoff');
    expect(f.toolMessages()[0]).toContain('"advisory":true');
    const [row] = f.svc.approvals.list({ status: 'pending' });
    expect(row.argsHash).toBeNull();
    f.svc.service.decide(row.id, 'approve');
    await vi.waitFor(() => expect(f.svc.turn).toHaveBeenCalledTimes(1));
    expect(f.svc.turn.mock.calls[0][1]).toContain('This grant is advisory');

    f.queue.push(
      () => toolCall('c1', 'computer_exec', rm),
      () => text('Still waiting.'),
    );
    await f.turn(f.svc.turn.mock.calls[0][1], {
      source: 'approval',
      ref: row.id,
    });
    expect(f.fake.count_of('exec')).toBe(0);
    expect(f.svc.approvals.get(row.id)?.status).toBe('approved');
    expect(f.svc.approvals.list({ status: 'pending' })).toHaveLength(1);
  });

  it('covers an exec intent given to request_approval and runs the command once afterwards', async () => {
    const f = e2e(
      [
        () =>
          toolCall('a1', 'request_approval', {
            summary: 'Remove the build folder',
            intent: { tool: 'computer_exec', args: rm },
          }),
        () => text('Asked.'),
      ],
      { tools: [requestApprovalTool()] },
    );
    await f.turn('Clean up.');
    const [row] = f.svc.approvals.list({ status: 'pending' });
    expect(row.argsHash).not.toBeNull();
    f.svc.service.decide(row.id, 'approve');
    f.queue.push(
      () => toolCall('c1', 'computer_exec', rm),
      () => text('Done.'),
    );
    await f.turn('Approved.', { source: 'approval', ref: row.id });
    expect(f.fake.count_of('exec')).toBe(1);
    expect(f.svc.approvals.get(row.id)?.status).toBe('consumed');
  });

  it('answers a request_approval for an unknown computer ref with a tool error and keeps going', async () => {
    const f = e2e(
      [
        () =>
          toolCall('a1', 'request_approval', {
            summary: 'Send it',
            intent: {
              tool: 'computer_click',
              args: { ref: 'e1', snapshotId: 4 },
            },
          }),
        () => text('That ref was stale.'),
      ],
      { tools: [requestApprovalTool()] },
    );
    expect(await f.turn('Send it.')).toBe('That ref was stale.');
    expect(f.toolMessages()[0]).toContain('That ref is not from this turn');
    expect(f.svc.approvals.list({})).toHaveLength(0);
    // The turn was not paused: the second request still had its tools.
    expect(f.requests[1].tools?.length).toBeGreaterThan(0);
  });

  it('ends the turn with the handoff instruction when the Dot calls request_handoff', async () => {
    const f = e2e(
      [
        () =>
          toolCall('h1', 'request_handoff', { reason: 'Log in to the portal' }),
        () => text('Please take over the computer.'),
      ],
      { tools: [requestHandoffTool()] },
    );
    expect(await f.turn('Check the portal.')).toBe(
      'Please take over the computer.',
    );
    expect(f.handoffs.start).toHaveBeenCalledWith({
      dotId: f.dot.id,
      threadId: 'thread',
      kind: 'other',
      reason: 'Log in to the portal',
    });
    expect(f.toolMessages()[0]).toContain('"status":"handoff"');
    expect(f.requests[1].tools ?? []).toEqual([]);
    expect(systemText(f.requests[1])).toContain('needs the owner');
  });
});

// ---------------------------------------------------------------------------------------------
// Cases that need the orchestrator's wiring (Platform, TurnRegistry lookups, scheduler)
// ---------------------------------------------------------------------------------------------

// Durable resume markers, approving mid-run and the scheduler exclusions, with the real Platform wiring,
// are tested in tests/integration-turns.test.ts (this file injects the gate with vi.mock).
