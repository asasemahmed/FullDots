import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Approval, ApprovalStatus } from '../shared/types.js';

export type ApprovalCreateInput = Omit<
  Approval,
  | 'id'
  | 'status'
  | 'note'
  | 'createdAt'
  | 'expiresAt'
  | 'decidedAt'
  | 'consumedAt'
> & { ttlMs: number };

export interface ApprovalFilter {
  status?: ApprovalStatus;
  threadId?: string;
  dotId?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 100;

function toApproval(row: Record<string, unknown>): Approval {
  return { ...row } as unknown as Approval;
}

export class ApprovalStore {
  /** `now` is injectable for tests. */
  constructor(
    private db: DatabaseSync,
    private now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, dotId TEXT NOT NULL, toolCallId TEXT NOT NULL,
      tool TEXT NOT NULL, argsHash TEXT, summary TEXT NOT NULL, argsRedacted TEXT NOT NULL, status TEXT NOT NULL, note TEXT,
      createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, decidedAt INTEGER, consumedAt INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS approvals_call ON approvals(threadId, toolCallId);
      CREATE INDEX IF NOT EXISTS approvals_status ON approvals(status, createdAt);`);
  }

  /** Idempotent on (threadId, toolCallId): a repeat call returns the stored row. */
  create(input: ApprovalCreateInput): Approval {
    const existing = this.byToolCall(input.threadId, input.toolCallId);
    if (existing) return existing;
    const createdAt = this.now();
    const approval: Approval = {
      id: randomUUID(),
      threadId: input.threadId,
      dotId: input.dotId,
      toolCallId: input.toolCallId,
      tool: input.tool,
      argsHash: input.argsHash,
      summary: input.summary,
      argsRedacted: input.argsRedacted,
      status: 'pending',
      note: null,
      createdAt,
      expiresAt: createdAt + input.ttlMs,
      decidedAt: null,
      consumedAt: null,
    };
    this.db
      .prepare(
        'INSERT INTO approvals(id,threadId,dotId,toolCallId,tool,argsHash,summary,argsRedacted,status,note,createdAt,expiresAt,decidedAt,consumedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        approval.id,
        approval.threadId,
        approval.dotId,
        approval.toolCallId,
        approval.tool,
        approval.argsHash,
        approval.summary,
        approval.argsRedacted,
        approval.status,
        approval.note,
        approval.createdAt,
        approval.expiresAt,
        approval.decidedAt,
        approval.consumedAt,
      );
    return approval;
  }

  byToolCall(threadId: string, toolCallId: string): Approval | undefined {
    const row = this.db
      .prepare('SELECT * FROM approvals WHERE threadId=? AND toolCallId=?')
      .get(threadId, toolCallId);
    return row ? toApproval(row) : undefined;
  }

  get(id: string): Approval | undefined {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id);
    return row ? toApproval(row) : undefined;
  }

  /** Newest first. */
  list(filter: ApprovalFilter = {}): Approval[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.status) {
      where.push('status=?');
      params.push(filter.status);
    }
    if (filter.threadId) {
      where.push('threadId=?');
      params.push(filter.threadId);
    }
    if (filter.dotId) {
      where.push('dotId=?');
      params.push(filter.dotId);
    }
    params.push(
      filter.limit !== undefined && filter.limit > 0
        ? Math.floor(filter.limit)
        : DEFAULT_LIMIT,
    );
    return this.db
      .prepare(
        `SELECT * FROM approvals${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY createdAt DESC, rowid DESC LIMIT ?`,
      )
      .all(...params)
      .map(toApproval);
  }

  /** Only from 'pending' and before its expiry; otherwise throws. */
  decide(id: string, decision: 'approve' | 'deny', note?: string): Approval {
    const now = this.now();
    this.db
      .prepare(
        "UPDATE approvals SET status='expired' WHERE id=? AND status='pending' AND expiresAt<=?",
      )
      .run(id, now);
    const row = this.db
      .prepare(
        "UPDATE approvals SET status=?, note=?, decidedAt=? WHERE id=? AND status='pending' RETURNING *",
      )
      .get(
        decision === 'approve' ? 'approved' : 'denied',
        note ?? null,
        now,
        id,
      );
    if (row) return toApproval(row);
    if (!this.get(id)) throw new Error('Approval not found.');
    throw new Error('Approval is not pending.');
  }

  /**
   * Atomic single use: the first caller flips one approved, unexpired row to consumed; later callers
   * get undefined. An approval that was never used stops counting at its expiry like a pending one.
   */
  consume(
    threadId: string,
    argsHash: string,
    approvalId?: string,
  ): Approval | undefined {
    const now = this.now();
    const row = this.db
      .prepare(
        `UPDATE approvals SET status='consumed', consumedAt=? WHERE id=(SELECT id FROM approvals WHERE threadId=? AND argsHash=? AND status='approved' AND expiresAt>? AND (? IS NULL OR id=?) ORDER BY decidedAt, createdAt, rowid LIMIT 1) RETURNING *`,
      )
      .get(
        now,
        threadId,
        argsHash,
        now,
        approvalId ?? null,
        approvalId ?? null,
      );
    return row ? toApproval(row) : undefined;
  }

  /** An approval not used on its resume turn stops counting: true when it was still approved. */
  lapse(id: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE approvals SET status='expired' WHERE id=? AND status='approved'",
      )
      .run(id);
    return Number(result.changes) > 0;
  }

  /** Marks every pending or approved-but-unused approval past its expiry; returns how many. */
  expire(now: number = this.now()): number {
    const result = this.db
      .prepare(
        "UPDATE approvals SET status='expired' WHERE status IN ('pending', 'approved') AND expiresAt<=?",
      )
      .run(now);
    return Number(result.changes);
  }

  /** Threads with at least one non-expired pending approval. */
  pendingThreadIds(): string[] {
    return this.db
      .prepare(
        "SELECT DISTINCT threadId FROM approvals WHERE status='pending' AND expiresAt>? ORDER BY threadId",
      )
      .all(this.now())
      .map((row) => String(row.threadId));
  }
}
