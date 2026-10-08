// Durable resume markers: "this Dot owes a new turn in this thread". A marker is written before
// anyone tries to deliver it and removed only after the turn ran, so a restart loses nothing.
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { TurnSource } from '../shared/types.js';

export interface ResumeMarker {
  id: string;
  kind: 'approval' | 'handoff' | 'delegation';
  /** Approval id, handoff id, ... (passed to the turn as `ref`). */
  refId: string;
  threadId: string;
  dotId: string;
  prompt: string;
  source: TurnSource;
  attempts: number;
  nextAt: number;
  createdAt: number;
  lastError: string | null;
}

export type NewResumeMarker = Omit<
  ResumeMarker,
  'id' | 'attempts' | 'nextAt' | 'createdAt' | 'lastError'
>;

const MAX_ERROR_CHARS = 500;
const COLUMNS =
  'id,kind,refId,threadId,dotId,prompt,source,attempts,nextAt,createdAt,lastError';
// rowid breaks ties between markers created in the same millisecond, so "oldest first" is stable.
const ORDER = 'ORDER BY createdAt ASC, rowid ASC';

export class ResumeStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS resume_markers(id TEXT PRIMARY KEY, kind TEXT NOT NULL, refId TEXT NOT NULL, threadId TEXT NOT NULL,
      dotId TEXT NOT NULL, prompt TEXT NOT NULL, source TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL, lastError TEXT);`);
  }

  add(input: NewResumeMarker): ResumeMarker {
    const now = Date.now();
    const marker: ResumeMarker = {
      id: randomUUID(),
      kind: input.kind,
      refId: input.refId,
      threadId: input.threadId,
      dotId: input.dotId,
      prompt: input.prompt,
      source: input.source,
      attempts: 0,
      nextAt: now,
      createdAt: now,
      lastError: null,
    };
    this.db
      .prepare(
        `INSERT INTO resume_markers(${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        marker.id,
        marker.kind,
        marker.refId,
        marker.threadId,
        marker.dotId,
        marker.prompt,
        marker.source,
        marker.attempts,
        marker.nextAt,
        marker.createdAt,
        marker.lastError,
      );
    return marker;
  }

  get(id: string): ResumeMarker | undefined {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM resume_markers WHERE id=?`)
      .get(id);
    return row ? (row as unknown as ResumeMarker) : undefined;
  }

  /** Markers whose retry time has come, oldest first. */
  due(now = Date.now()): ResumeMarker[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM resume_markers WHERE nextAt<=? ${ORDER}`)
      .all(now) as unknown as ResumeMarker[];
  }

  /** Every stored marker, oldest first. */
  all(): ResumeMarker[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM resume_markers ${ORDER}`)
      .all() as unknown as ResumeMarker[];
  }

  bump(id: string, error: string, nextAt: number): void {
    this.db
      .prepare(
        'UPDATE resume_markers SET attempts=attempts+1, lastError=?, nextAt=? WHERE id=?',
      )
      .run(error.slice(0, MAX_ERROR_CHARS), nextAt, id);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM resume_markers WHERE id=?').run(id);
  }
}
