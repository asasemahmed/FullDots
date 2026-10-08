// Owns the life of an owner handoff: the Dot stopped because a person has to act on its computer
// (a password, a verification code, a human check). Started by the approval gate, finished when the
// owner gives the computer back (released) or declines (dismiss); both queue a resume turn so the
// Dot continues, or stops, in the same thread.
//
// Order matters: the handoff row is stored first, so the owner can always see and answer it, and
// the computer-side control request, the audit entry and the notification are best effort around it.
import type { Handoff, HandoffKind } from '../shared/types.js';
import type { ComputerService } from './computer-service.js';
import type { ComputerStore } from './computer-store.js';
import type { HandoffStore } from './handoff-store.js';
import type { Notify } from './notify.js';
import type { ResumeQueue } from './resume-queue.js';

export interface HandoffServiceDeps {
  handoffs: Pick<
    HandoffStore,
    'create' | 'get' | 'waitingFor' | 'finish' | 'list'
  > & {
    /** Optional: stores the computer-side request id on a handoff after the request succeeded. */
    setControlRequestId?: (id: string, requestId: string) => void;
  };
  computers: Pick<
    ComputerService,
    'requestOwnerControl' | 'cancelOwnerControl' | 'stop' | 'start'
  >;
  resumes: Pick<ResumeQueue, 'enqueue'>;
  audit: Pick<ComputerStore, 'record'>;
  notify: Notify;
  log?: (line: string) => void;
}

const KIND_LABEL: Record<HandoffKind, string> = {
  credential: 'sign-in',
  two_factor: 'verification code',
  captcha: 'human check',
  other: 'requested',
};

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : 'unknown error').slice(0, 200);

export class HandoffService {
  private readonly log: (line: string) => void;

  constructor(private deps: HandoffServiceDeps) {
    this.log = deps.log ?? ((line) => console.error(line));
  }

  /**
   * Asks the owner to take over. One handoff per conversation: while one is waiting there it is
   * returned unchanged. Another conversation of the same Dot gets its own row (the computer returns
   * the request that is already open), so every waiting conversation is resumed when the owner is
   * done. Throws only when the handoff cannot be stored; everything around it is best effort.
   */
  async start(input: {
    dotId: string;
    threadId: string;
    kind: HandoffKind;
    reason: string;
  }): Promise<Handoff> {
    const waiting = this.waiting(input.dotId).find(
      (row) => row.threadId === input.threadId,
    );
    if (waiting) return waiting;
    let handoff = this.deps.handoffs.create(input);

    try {
      const control = await this.deps.computers.requestOwnerControl(
        input.dotId,
        input.reason,
        'agent',
      );
      const requestId = control.request?.id;
      if (requestId && this.deps.handoffs.setControlRequestId) {
        this.deps.handoffs.setControlRequestId(handoff.id, requestId);
        handoff = this.deps.handoffs.get(handoff.id) ?? handoff;
      }
    } catch (error) {
      // The handoff stays waiting: the owner can still take control from the computer panel,
      // and "Take control" re-requests when no request is active.
      this.log(`Handoff control request failed: ${errorText(error)}`);
    }

    this.guarded('audit', () =>
      this.deps.audit.record({
        dotId: input.dotId,
        threadId: input.threadId,
        tool: 'handoff',
        actor: 'agent',
        outcome: 'pending',
      }),
    );
    this.tell({
      title: 'Your turn on the computer',
      text: input.reason,
      url: `/#/dots/${encodeURIComponent(input.dotId)}/threads/${encodeURIComponent(input.threadId)}`,
    });
    return handoff;
  }

  /**
   * The owner gave the computer back: finishes every waiting handoff of the Dot and queues one resume
   * turn per conversation. Returns the oldest one, or undefined when none was waiting.
   */
  released(dotId: string): Handoff | undefined {
    const finished = this.waiting(dotId).map((row) => this.finishDone(row));
    return finished[0];
  }

  private finishDone(waiting: Handoff): Handoff {
    const handoff = this.deps.handoffs.finish(waiting.id, 'done');
    this.guarded('audit', () =>
      this.deps.audit.record({
        dotId: handoff.dotId,
        threadId: handoff.threadId,
        tool: 'handoff',
        actor: 'owner',
        outcome: 'succeeded',
      }),
    );
    this.deps.resumes.enqueue({
      kind: 'handoff',
      refId: handoff.id,
      threadId: handoff.threadId,
      dotId: handoff.dotId,
      source: 'handoff',
      prompt: `The owner finished the ${KIND_LABEL[handoff.kind]} step and handed the computer back. Take a fresh snapshot (computer_snapshot) and continue from where you stopped. Never type the secret yourself.`,
    });
    return handoff;
  }

  /** Waiting handoffs of a Dot, oldest first. */
  private waiting(dotId: string): Handoff[] {
    return this.deps.handoffs
      .list({ status: 'waiting', dotId })
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * The owner declined to take over: gives the computer back to the Dot and tells it to stop. The
   * computer request is shared, so every waiting handoff of that Dot is declined with it.
   */
  async dismiss(id: string): Promise<Handoff> {
    const existing = this.deps.handoffs.get(id);
    if (!existing) throw new Error('Handoff not found.');
    if (existing.status !== 'waiting')
      throw new Error('Handoff is not waiting.');

    try {
      await this.deps.computers.cancelOwnerControl(existing.dotId);
    } catch (error) {
      // Documented fallback: restarting the computer clears whatever request is left over.
      this.log(
        `Handoff control cancel failed, restarting the computer: ${errorText(error)}`,
      );
      try {
        await this.deps.computers.stop(existing.dotId);
      } catch (stopError) {
        this.log(`Handoff computer stop failed: ${errorText(stopError)}`);
      }
      try {
        await this.deps.computers.start(existing.dotId);
      } catch (startError) {
        this.log(`Handoff computer start failed: ${errorText(startError)}`);
      }
    }

    const others = this.waiting(existing.dotId).filter((row) => row.id !== id);
    const handoff = this.finishDismissed(existing);
    for (const row of others) this.finishDismissed(row);
    return handoff;
  }

  private finishDismissed(waiting: Handoff): Handoff {
    const handoff = this.deps.handoffs.finish(waiting.id, 'dismissed');
    this.guarded('audit', () =>
      this.deps.audit.record({
        dotId: handoff.dotId,
        threadId: handoff.threadId,
        tool: 'handoff',
        actor: 'owner',
        outcome: 'denied',
      }),
    );
    this.deps.resumes.enqueue({
      kind: 'handoff',
      refId: handoff.id,
      threadId: handoff.threadId,
      dotId: handoff.dotId,
      source: 'handoff',
      prompt: `The owner declined to take over for: ${handoff.reason}. Do not retry that step. Report what you completed and what remains, then stop.`,
    });
    return handoff;
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

  /** Side records must not undo or block a handoff that is already stored. */
  private guarded(what: string, body: () => unknown): void {
    try {
      body();
    } catch (error) {
      this.log(`Handoff ${what} failed: ${errorText(error)}`);
    }
  }
}
