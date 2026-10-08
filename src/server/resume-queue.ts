// Delivers resume markers: starts a new turn in the same thread once the thread and the Dot are
// free. Markers are persisted first (ResumeStore), delivered second, and removed only after the
// turn ran. Retries happen when a Dot's lock is released and on a periodic sweep.
//
// Rules:
// - A busy thread or Dot defers the marker without counting as a failure (attempts unchanged).
// - Any other error bumps `attempts` and schedules `nextAt` with backoff.
// - A marker that failed MAX_ATTEMPTS times, or is older than `maxAgeMs`, is given up: it is
//   removed, logged once (never its prompt) and reported to `onGiveUp`. A resume that keeps
//   failing would otherwise append its prompt to the thread forever.
// - Markers of one thread are delivered oldest first: while an older marker of the thread is
//   stored, a newer one waits. A failing marker blocks later ones of its thread until it is
//   delivered or given up; that keeps the conversation in order.
// - Attempts never overlap for one marker, and only one attempt per Dot runs at a time.
import type { TurnMetadata } from '../shared/types.js';
import { NO_TIME_LIMIT_MS } from './limits.js';
import { isDotBusy, type TurnRegistry } from './turn-registry.js';
import type {
  NewResumeMarker,
  ResumeMarker,
  ResumeStore,
} from './resume-store.js';

export const MAX_ATTEMPTS = 10;
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Quick retries while the runner finishes the turn that just released the Dot (about 5 s). */
const RUNNING_RETRY_MS = 250;
const RUNNING_RETRIES = 20;
export const DEFAULT_SWEEP_MS = 30_000;
export const DEFAULT_BACKOFF_MS = [1000, 2000, 5000, 15_000, 60_000];

export interface ResumeQueueDeps {
  store: ResumeStore;
  registry: TurnRegistry;
  /** = platform.turn */
  turn: (
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata: TurnMetadata,
  ) => Promise<string>;
  sweepMs?: number;
  /** Delay after the n-th failed attempt; the last entry repeats. */
  backoffMs?: number[];
  /** A marker older than this is given up on (default 7 days). */
  maxAgeMs?: number;
  /** Called once when a marker is removed without delivery (too many failures, or too old). */
  onGiveUp?: (marker: ResumeMarker, lastError: string) => void;
  /** Called after a marker's turn ran, with the text the turn returned. */
  onDelivered?: (marker: ResumeMarker, text: string) => void;
  log?: (line: string) => void;
}

export type AttemptResult = 'delivered' | 'deferred' | 'failed' | 'gave_up';

export class ResumeQueue {
  private inFlight = new Map<string, string>(); // marker id -> dotId
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly sweepMs: number;
  private readonly backoffMs: number[];
  private readonly maxAgeMs: number;
  private readonly log: (line: string) => void;

  constructor(private deps: ResumeQueueDeps) {
    this.sweepMs = deps.sweepMs ?? DEFAULT_SWEEP_MS;
    this.backoffMs =
      deps.backoffMs && deps.backoffMs.length > 0
        ? deps.backoffMs
        : DEFAULT_BACKOFF_MS;
    this.maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.log = deps.log ?? ((line) => console.error(line));
  }

  start(): void {
    if (this.timer || this.unsubscribe) return;
    for (const marker of this.deps.store.all()) this.kick(marker.id);
    this.timer = setInterval(() => this.sweep(), this.sweepMs);
    this.timer.unref();
    this.unsubscribe = this.deps.registry.onRelease((dotId) => {
      for (const marker of this.deps.store.all())
        if (marker.dotId === dotId) this.kick(marker.id);
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  enqueue(input: NewResumeMarker): ResumeMarker {
    const marker = this.deps.store.add(input);
    this.kick(marker.id);
    return marker;
  }

  async attempt(id: string): Promise<AttemptResult> {
    const { store, registry } = this.deps;
    const marker = store.get(id);
    if (!marker) return 'delivered';
    if (this.inFlight.has(id)) return 'deferred';
    if (Date.now() - marker.createdAt > this.maxAgeMs)
      return this.giveUp(marker, marker.lastError ?? 'expired', 'too old');
    for (const dotId of this.inFlight.values())
      if (dotId === marker.dotId) return 'deferred';
    if (registry.isThreadRunning(marker.threadId)) return 'deferred';
    if (registry.isDotBusy(marker.dotId)) return 'deferred';
    const oldest = store.all().find((m) => m.threadId === marker.threadId);
    if (oldest && oldest.id !== marker.id) return 'deferred';

    this.inFlight.set(id, marker.dotId);
    let text = '';
    let lastError: string | undefined;
    try {
      text = await this.deps.turn(
        marker.threadId,
        marker.prompt,
        AbortSignal.timeout(NO_TIME_LIMIT_MS), // the turn has its own limits
        { source: marker.source, ref: marker.refId },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Another turn took the Dot first; the release of its lock kicks this marker again.
      if (isDotBusy(error)) return 'deferred';
      if (/Thread already running/.test(message)) {
        // The Dot's lock is released a moment before the runner marks the thread free, so a
        // release-triggered attempt can land in that gap. Try again shortly instead of waiting
        // for the sweep.
        this.retrySoon(id);
        return 'deferred';
      }
      const delay =
        this.backoffMs[Math.min(marker.attempts, this.backoffMs.length - 1)];
      store.bump(id, message, Date.now() + delay);
      // Never log marker.prompt: it can hold the owner's note.
      this.log(
        `Resume ${marker.kind} ${marker.refId} failed (attempt ${marker.attempts + 1}): ${message.slice(0, 200)}`,
      );
      if (marker.attempts + 1 < MAX_ATTEMPTS) return 'failed';
      lastError = message;
    } finally {
      this.inFlight.delete(id);
    }
    // After `finally`: the next marker of this Dot must not see this one as still running.
    if (lastError !== undefined)
      return this.giveUp(marker, lastError, 'too many failures');
    store.remove(id);
    this.retries.delete(id);
    try {
      this.deps.onDelivered?.(marker, text);
    } catch (error) {
      this.log(
        `Resume ${marker.kind} ${marker.refId}: onDelivered failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.kickNext(marker.threadId);
    return 'delivered';
  }

  /** Removes a marker that will not be delivered, tells the platform, and lets the thread go on. */
  private giveUp(
    marker: ResumeMarker,
    lastError: string,
    why: string,
  ): AttemptResult {
    this.deps.store.remove(marker.id);
    this.retries.delete(marker.id);
    this.log(
      `Resume ${marker.kind} ${marker.refId}: giving up (${why}): ${lastError.slice(0, 200)}`,
    );
    try {
      this.deps.onGiveUp?.(marker, lastError);
    } catch (error) {
      this.log(
        `Resume ${marker.kind} ${marker.refId}: onGiveUp failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.kickNext(marker.threadId);
    return 'gave_up';
  }

  /** The next marker of a thread was waiting for the one before it. */
  private kickNext(threadId: string): void {
    const next = this.deps.store.all().find((m) => m.threadId === threadId);
    if (next) this.kick(next.id);
  }

  private retries = new Map<string, number>();
  private retrySoon(id: string): void {
    const count = (this.retries.get(id) ?? 0) + 1;
    if (count > RUNNING_RETRIES) {
      this.retries.delete(id);
      return; // The sweep takes over.
    }
    this.retries.set(id, count);
    setTimeout(() => {
      try {
        if (!this.deps.store.get(id)) this.retries.delete(id);
        else this.kick(id);
      } catch {
        this.retries.delete(id); // The store was closed (shutdown).
      }
    }, RUNNING_RETRY_MS).unref();
  }

  private sweep(): void {
    for (const marker of this.deps.store.due()) this.kick(marker.id);
  }

  /** Fire-and-forget attempt that can never reject. */
  private kick(id: string): void {
    this.attempt(id).catch((error: unknown) => {
      this.log(
        `Resume attempt crashed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}
