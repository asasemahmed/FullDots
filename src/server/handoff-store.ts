import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Handoff, HandoffKind, HandoffStatus } from '../shared/types.js';

const toHandoff = (row: Record<string, unknown>): Handoff => ({
  id: String(row.id),
  dotId: String(row.dotId),
  threadId: String(row.threadId),
  kind: String(row.kind) as HandoffKind,
  reason: String(row.reason),
  status: String(row.status) as HandoffStatus,
  createdAt: Number(row.createdAt),
  finishedAt: row.finishedAt === null ? null : Number(row.finishedAt),
  controlRequestId:
    row.controlRequestId === null ? null : String(row.controlRequestId),
});

/** Owner handoffs: moments when a Dot stopped because a person has to act on its computer. */
export class HandoffStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS handoffs(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, threadId TEXT NOT NULL, kind TEXT NOT NULL,
      reason TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL, finishedAt INTEGER, controlRequestId TEXT);
      CREATE INDEX IF NOT EXISTS handoffs_dot ON handoffs(dotId, status, createdAt);`);
  }
  create(input: {
    dotId: string;
    threadId: string;
    kind: HandoffKind;
    reason: string;
    controlRequestId?: string | null;
  }): Handoff {
    const handoff: Handoff = {
      id: randomUUID(),
      dotId: input.dotId,
      threadId: input.threadId,
      kind: input.kind,
      reason: input.reason,
      status: 'waiting',
      createdAt: Date.now(),
      finishedAt: null,
      controlRequestId: input.controlRequestId ?? null,
    };
    this.db
      .prepare('INSERT INTO handoffs VALUES (?,?,?,?,?,?,?,?,?)')
      .run(
        handoff.id,
        handoff.dotId,
        handoff.threadId,
        handoff.kind,
        handoff.reason,
        handoff.status,
        handoff.createdAt,
        handoff.finishedAt,
        handoff.controlRequestId,
      );
    return handoff;
  }
  get(id: string): Handoff | undefined {
    const row = this.db.prepare('SELECT * FROM handoffs WHERE id=?').get(id);
    return row ? toHandoff(row) : undefined;
  }
  /** The newest handoff of this Dot that is still waiting for the owner. */
  waitingFor(dotId: string): Handoff | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM handoffs WHERE dotId=? AND status='waiting' ORDER BY createdAt DESC, rowid DESC LIMIT 1",
      )
      .get(dotId);
    return row ? toHandoff(row) : undefined;
  }
  list(
    filter: { status?: HandoffStatus; dotId?: string; limit?: number } = {},
  ): Handoff[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.status) {
      where.push('status=?');
      args.push(filter.status);
    }
    if (filter.dotId) {
      where.push('dotId=?');
      args.push(filter.dotId);
    }
    args.push(Math.max(1, Math.floor(filter.limit ?? 100)));
    return this.db
      .prepare(
        `SELECT * FROM handoffs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY createdAt DESC, rowid DESC LIMIT ?`,
      )
      .all(...args)
      .map(toHandoff);
  }
  /** Moves a waiting handoff to its final state. Anything else is an error: a handoff finishes once. */
  finish(id: string, status: 'done' | 'dismissed'): Handoff {
    const changed = this.db
      .prepare(
        "UPDATE handoffs SET status=?, finishedAt=? WHERE id=? AND status='waiting'",
      )
      .run(status, Date.now(), id);
    if (!changed.changes) throw new Error('Handoff is not waiting.');
    return this.get(id)!;
  }
  setControlRequestId(id: string, requestId: string): void {
    this.db
      .prepare('UPDATE handoffs SET controlRequestId=? WHERE id=?')
      .run(requestId, id);
  }
  waitingDotIds(): string[] {
    return this.db
      .prepare("SELECT DISTINCT dotId FROM handoffs WHERE status='waiting'")
      .all()
      .map((row) => String(row.dotId));
  }
}
