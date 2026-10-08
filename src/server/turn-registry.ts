// Who is running a turn right now, per Dot. Each Dot has one computer, so at most one turn per Dot
// may run at a time, whatever started it (chat, voice, a scheduled task, a resume turn, a channel).
// Process-local on purpose, like SqliteAgentRunner's run state: a crash must not leave a Dot locked.
import type { TurnSource } from '../shared/types.js';

export class DotBusyError extends Error {
  constructor(
    readonly dotId: string,
    readonly source: TurnSource | 'chat',
    readonly threadId: string,
  ) {
    super(
      `This Dot is busy with ${source === 'chat' ? 'another conversation' : `background work (${source})`}. Stop it or wait for it to finish.`,
    );
    this.name = 'DotBusyError';
  }
}

/**
 * A DotBusyError loses its class when a turn reports it as a RUN_ERROR (runThreadTurn rebuilds a
 * plain Error from the message), so callers recognise it by its message as well.
 */
export const isDotBusy = (error: unknown): boolean =>
  error instanceof DotBusyError ||
  (error instanceof Error && /^This Dot is busy with /.test(error.message));

export interface RunningTurn {
  dotId: string;
  threadId: string;
  source: TurnSource | 'chat';
  startedAt: number;
  stop: () => void;
}

export interface RegistryLookups {
  /** Threads with an approval in status 'pending'. */
  pendingApprovalThreads: () => string[];
  /** Dots with a handoff in status 'waiting'. */
  waitingHandoffDots: () => string[];
}

export class TurnRegistry {
  private turns = new Map<string, RunningTurn>();
  private listeners = new Set<(dotId: string) => void>();
  private lookups: RegistryLookups;

  constructor(lookups: Partial<RegistryLookups> = {}) {
    this.lookups = {
      pendingApprovalThreads: lookups.pendingApprovalThreads ?? (() => []),
      waitingHandoffDots: lookups.waitingHandoffDots ?? (() => []),
    };
  }

  /** Replaces the lookups once the stores they read exist. */
  setLookups(lookups: Partial<RegistryLookups>) {
    this.lookups = { ...this.lookups, ...lookups };
  }

  /** Throws DotBusyError when the Dot already has a running turn. Returns the release function. */
  acquire(
    dotId: string,
    threadId: string,
    source: TurnSource | 'chat',
    stop: () => void,
  ): () => void {
    const current = this.turns.get(dotId);
    if (current)
      throw new DotBusyError(dotId, current.source, current.threadId);
    const turn: RunningTurn = {
      dotId,
      threadId,
      source,
      startedAt: Date.now(),
      stop,
    };
    this.turns.set(dotId, turn);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.turns.get(dotId) === turn) this.turns.delete(dotId);
      for (const listener of this.listeners) {
        try {
          listener(dotId);
        } catch (error) {
          console.error(
            'Turn release listener failed:',
            error instanceof Error ? error.message : 'unknown error',
          );
        }
      }
    };
  }

  isDotBusy(dotId: string): boolean {
    return this.turns.has(dotId);
  }

  isThreadRunning(threadId: string): boolean {
    for (const turn of this.turns.values())
      if (turn.threadId === threadId) return true;
    return false;
  }

  running(): RunningTurn[] {
    return [...this.turns.values()];
  }

  /** Stops the running turn of a Dot (calls its `stop`). False when idle. */
  stop(dotId: string): boolean {
    const turn = this.turns.get(dotId);
    if (!turn) return false;
    turn.stop();
    return true;
  }

  /** Everything a scheduler must skip right now. */
  exclusions(): { threadIds: string[]; dotIds: string[] } {
    const threadIds = new Set(this.running().map((turn) => turn.threadId));
    const dotIds = new Set(this.turns.keys());
    try {
      for (const id of this.lookups.pendingApprovalThreads()) threadIds.add(id);
      for (const id of this.lookups.waitingHandoffDots()) dotIds.add(id);
    } catch (error) {
      console.error(
        'Turn registry lookup failed:',
        error instanceof Error ? error.message : 'unknown error',
      );
    }
    return { threadIds: [...threadIds], dotIds: [...dotIds] };
  }

  /** Called with the Dot id whenever a lock is released (the resume queue retries on it). */
  onRelease(listener: (dotId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
