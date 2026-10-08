// Owns the life of an approval: asked for (and the owner told), decided (and the Dot told to continue),
// used once, expired. The gate (approval-gate.ts) asks and consumes; the HTTP routes decide.
import { randomUUID } from 'node:crypto';
import type { Approval } from '../shared/types.js';
import type { ApprovalStore } from './approval-store.js';
import type { ComputerStore } from './computer-store.js';
import type { Notify } from './notify.js';
import type { ResumeQueue } from './resume-queue.js';

export interface ApprovalServiceDeps {
  approvals: ApprovalStore;
  resumes: Pick<ResumeQueue, 'enqueue'>;
  audit: Pick<ComputerStore, 'record'>;
  notify: Notify;
  ttlMs: number;
  /** The task a thread belongs to, if any. */
  taskOf?: (threadId: string) => string | undefined;
  recordTaskEvent?: (taskId: string, text: string) => void;
  log?: (line: string) => void;
}

export interface ApprovalRequestInput {
  threadId: string;
  dotId: string;
  toolCallId: string;
  tool: string;
  /** null = a summary-only request: advisory, never consumed. */
  argsHash: string | null;
  summary: string;
  argsRedacted: string;
}

const DEFAULT_SWEEP_MS = 600_000;

export class ApprovalService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly log: (line: string) => void;

  constructor(private deps: ApprovalServiceDeps) {
    this.log = deps.log ?? ((line) => console.error(line));
  }

  /**
   * Idempotent on (threadId, toolCallId) for the same pending action; the owner is notified only when
   * the row is new. Some providers reuse tool call ids (`call_0`) across turns, so an id whose row is
   * for another action, or already decided, gets a fresh row under a suffixed id instead of the old row.
   */
  request(input: ApprovalRequestInput): Approval {
    const existing = this.deps.approvals.byToolCall(
      input.threadId,
      input.toolCallId,
    );
    if (
      existing?.status === 'pending' &&
      existing.tool === input.tool &&
      existing.argsHash === input.argsHash
    )
      return existing;
    const approval = this.deps.approvals.create({
      ...input,
      toolCallId: existing
        ? `${input.toolCallId}#${randomUUID().slice(0, 8)}`
        : input.toolCallId,
      ttlMs: this.deps.ttlMs,
    });
    this.tell({
      title: 'Approval needed',
      text: approval.summary,
      url: '/#/approvals',
    });
    return approval;
  }

  /**
   * Persists the decision first, then records it and queues the resume turn, so a crash between the
   * steps never loses the decision. Throws when the approval is not pending.
   */
  decide(id: string, decision: 'approve' | 'deny', note?: string): Approval {
    const approval = this.deps.approvals.decide(id, decision, note);
    const approved = decision === 'approve';
    this.guarded('audit', () =>
      this.deps.audit.record({
        dotId: approval.dotId,
        threadId: approval.threadId,
        tool: approval.tool,
        actor: 'owner',
        outcome: approved ? 'approved' : 'denied',
      }),
    );
    this.guarded('task event', () => {
      const taskId = this.deps.taskOf?.(approval.threadId);
      if (taskId)
        this.deps.recordTaskEvent?.(
          taskId,
          `Approval ${approval.id} ${approved ? 'approved' : 'denied'}; resumed in conversation.`,
        );
    });
    this.deps.resumes.enqueue({
      kind: 'approval',
      refId: approval.id,
      threadId: approval.threadId,
      dotId: approval.dotId,
      source: 'approval',
      prompt: approved
        ? approval.argsHash === null
          ? `Approval ${approval.id} granted for: ${approval.summary}. This grant is advisory: actions that need confirmation will still ask.`
          : `Approval ${approval.id} granted for: ${approval.summary}. Perform exactly that action now.`
        : `Approval ${approval.id} was denied${note ? `. Owner's note: ${JSON.stringify(note)}` : ''}. Do not perform that action. Acknowledge the decision and continue with anything else you can do, or stop.`,
    });
    return approval;
  }

  /**
   * Uses up an approved intent: true once per approval. An advisory approval (no hash) never matches.
   * The use is audited as an approved action of the agent.
   */
  consume(
    threadId: string,
    argsHash: string,
    approvalId?: string,
  ): Approval | undefined {
    const approval = this.deps.approvals.consume(
      threadId,
      argsHash,
      approvalId,
    );
    if (approval)
      this.guarded('audit', () =>
        this.deps.audit.record({
          dotId: approval.dotId,
          threadId: approval.threadId,
          tool: approval.tool,
          actor: 'agent',
          outcome: 'approved',
        }),
      );
    return approval;
  }

  /** Ends an approval's validity once the turn it was delivered to is over. */
  lapse(id: string): boolean {
    let lapsed = false;
    this.guarded('lapse', () => {
      lapsed = this.deps.approvals.lapse(id);
    });
    return lapsed;
  }

  /** Marks pending approvals past their expiry. The timer never keeps the process alive. */
  startSweep(intervalMs: number = DEFAULT_SWEEP_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.guarded('expiry sweep', () => this.deps.approvals.expire());
    }, intervalMs);
    this.timer.unref();
  }

  stopSweep(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private tell(event: { title: string; text: string; url: string }): void {
    try {
      Promise.resolve(this.deps.notify(event)).catch((error: unknown) =>
        this.log(`Notification failed: ${errorText(error)}`),
      );
    } catch (error) {
      this.log(`Notification failed: ${errorText(error)}`);
    }
  }

  /** Side records must not undo or block a decision that is already stored. */
  private guarded(what: string, body: () => unknown): void {
    try {
      body();
    } catch (error) {
      this.log(`Approval ${what} failed: ${errorText(error)}`);
    }
  }
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'unknown error';
