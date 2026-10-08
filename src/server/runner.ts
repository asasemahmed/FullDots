import { Store } from './store.js';
import type { Result, Memory } from '../shared/types.js';
import type { Claim } from './store.js';
import { research, type Config } from './research.js';
import { isDotBusy } from './turn-registry.js';
export class Runner {
  private timer?: ReturnType<typeof setInterval>;
  private active = new Map<string, AbortController>();
  constructor(
    private store: Store,
    private config: Config,
    private execute?: (
      claim: Claim,
      memories: Memory[],
      signal: AbortSignal,
      progress: (text: string) => void,
    ) => Promise<Result>,
    private timeoutMs = 90_000,
    private options: { excluded?: () => string[] } = {},
  ) {}
  private exclusionsFailed = false;
  start() {
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), 1000);
      void this.tick();
    }
  }
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const task of this.store.tasks()) {
      if (this.active.has(task.id) && task.lease)
        this.store.release(
          { ...task, lease: task.lease },
          'Server stopping; queued for restart.',
        );
    }
    this.abortAll();
  }
  abort(id: string) {
    this.active.get(id)?.abort(new Error('Run stopped.'));
  }
  abortAll() {
    for (const controller of this.active.values())
      controller.abort(new Error('Run stopped because settings changed.'));
  }
  private excludedTaskIds(): string[] {
    try {
      return this.options.excluded?.() ?? [];
    } catch (error) {
      if (!this.exclusionsFailed) {
        this.exclusionsFailed = true;
        console.error(
          'Runner exclusions failed: ' +
            (error instanceof Error ? error.message : 'unknown error'),
        );
      }
      return [];
    }
  }
  async tick() {
    if (this.active.size) return;
    // The lease must outlive the run so a slow task is never claimed twice.
    const claim = this.store.claim(
      Date.now(),
      this.timeoutMs + 90_000,
      this.excludedTaskIds(),
    );
    if (!claim) return;
    const controller = new AbortController();
    this.active.set(claim.id, controller);
    const ownershipCheck = setInterval(() => {
      if (!this.store.owns(claim))
        controller.abort(new Error('Run permission or lease was revoked.'));
    }, 100);
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error(
            `Research exceeded the ${Math.round(this.timeoutMs / 1000)} second time limit.`,
          ),
        ),
      this.timeoutMs,
    );
    try {
      const settings = this.store.settings();
      const memories = settings.memoryAllowed ? this.store.memories() : [];
      const progress = (text: string) => {
        if (!this.store.owns(claim))
          controller.abort(new Error('Run permission or lease was revoked.'));
        controller.signal.throwIfAborted();
        this.store.event(claim.id, claim.lease, text);
      };
      const result = this.execute
        ? await this.execute(claim, memories, controller.signal, progress)
        : await research(
            claim.prompt,
            memories,
            this.config,
            controller.signal,
            progress,
          );
      controller.signal.throwIfAborted();
      this.store.finish(claim, result);
    } catch (error) {
      // A chat turn took the Dot between the claim and the turn: try again later, not a failure.
      if (isDotBusy(error))
        this.store.release(
          claim,
          'Waiting: the Dot was busy with another turn.',
        );
      else
        this.store.fail(
          claim,
          error instanceof Error
            ? error.message
            : 'Unexpected research failure.',
        );
    } finally {
      clearInterval(ownershipCheck);
      clearTimeout(timeout);
      this.active.delete(claim.id);
    }
  }
}
