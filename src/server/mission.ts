// GET /api/mission: one card per Dot for mission control. Aggregates what already exists: the turn
// each Dot holds (TurnRegistry), its queued background tasks, what waits for the owner (approvals,
// handoffs, questions) and today's tokens against its budget. Ids, titles and counts only.
import { Hono } from 'hono';
import type {
  MissionDot,
  MissionGroup,
  MissionResponse,
} from '../shared/inbox.js';
import type { Store } from './store.js';
import type { TurnRegistry } from './turn-registry.js';
import type { WorkspaceStore } from './workspace.js';

export interface MissionDeps {
  store: Pick<Store, 'tasks' | 'settings'>;
  workspace: WorkspaceStore;
  turns: Pick<TurnRegistry, 'running'>;
  /**
   * Groups of Dots, in order. Named teams (P4) plug in here; without it every Dot is in one group.
   */
  groups?: (dotIds: string[]) => MissionGroup[];
}

const count = (map: Map<string, number>, key: string) =>
  map.set(key, (map.get(key) ?? 0) + 1);

export function missionSnapshot(
  deps: MissionDeps,
  now = Date.now(),
): MissionResponse {
  const { store, workspace, turns } = deps;
  const allPaused = store.settings().paused;
  const conversations = workspace.conversations();
  const titleOf = new Map(conversations.map((item) => [item.id, item.title]));
  const running = new Map(turns.running().map((turn) => [turn.dotId, turn]));

  const queued = new Map<string, number>();
  for (const task of store.tasks())
    if (task.status === 'queued') {
      const dotId = workspace.taskDot(task.id);
      if (dotId) count(queued, dotId);
    }
  const approvals = new Map<string, number>();
  for (const approval of workspace.approvals.list({
    status: 'pending',
    limit: 1000,
  }))
    count(approvals, approval.dotId);
  const handoffs = new Map<string, number>();
  for (const handoff of workspace.handoffs.list({
    status: 'waiting',
    limit: 1000,
  }))
    count(handoffs, handoff.dotId);
  const questions = workspace.inbox.openQuestionsByDot();

  // The newest chat of each Dot (the list is newest first), for "Open chat" on an idle card.
  const latest = new Map<string, string>();
  for (const item of conversations)
    if (!latest.has(item.dotId)) latest.set(item.dotId, item.id);

  const dots: MissionDot[] = workspace.dots().map((dot) => {
    const turn = running.get(dot.id);
    const waiting = {
      approvals: approvals.get(dot.id) ?? 0,
      handoffs: handoffs.get(dot.id) ?? 0,
      questions: questions.get(dot.id) ?? 0,
      total: 0,
    };
    waiting.total = waiting.approvals + waiting.handoffs + waiting.questions;
    const paused = allPaused || !!dot.paused;
    const usage = workspace.usage.summary(dot.id, now, 1);
    // The newest computer step of the running turn, when it took one.
    const step = turn
      ? workspace.frames
          .steps(dot.id, turn.threadId)
          .filter((item) => item.createdAt >= turn.startedAt)
          .at(-1)
      : undefined;
    return {
      id: dot.id,
      name: dot.name,
      ...(dot.color ? { color: dot.color } : {}),
      ...(dot.species ? { species: dot.species } : {}),
      ...(dot.gear ? { gear: dot.gear } : {}),
      paused: !!dot.paused,
      state: turn
        ? 'working'
        : waiting.total > 0
          ? 'needs-input'
          : paused
            ? 'paused'
            : 'idle',
      activity: turn
        ? {
            threadId: turn.threadId,
            threadTitle: titleOf.get(turn.threadId) ?? 'Conversation',
            source: turn.source,
            startedAt: turn.startedAt,
            step: step
              ? [step.action, step.title].filter(Boolean).join(' · ')
              : null,
          }
        : null,
      threadId: turn?.threadId ?? latest.get(dot.id) ?? null,
      queued: queued.get(dot.id) ?? 0,
      waiting,
      usage: { today: usage.today, budget: usage.budget },
    };
  });
  const ids = dots.map((dot) => dot.id);
  return {
    dots,
    groups: deps.groups?.(ids) ?? [
      { id: 'all', label: 'Your Dots', dotIds: ids },
    ],
    allPaused,
    generatedAt: now,
  };
}

export function missionRoutes(deps: MissionDeps) {
  const app = new Hono();
  app.get('/mission', (c) => c.json(missionSnapshot(deps)));
  return app;
}
