import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  CodingTaskBusyError,
  codingProviderSchema,
  type CodingProviderId,
} from './acp-policy.js';

export type CodingStatus =
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'timed_out'
  | 'failed'
  | 'authentication_required'
  | 'interrupted';
export interface CodingSession {
  id: string;
  dotId: string;
  threadId: string;
  provider: string;
  agentSessionId: string | null;
  status: CodingStatus;
  createdAt: number;
  finishedAt: number | null;
}

export class CodingSessions {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS coding_agent_settings(dotId TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS coding_sessions(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, threadId TEXT NOT NULL,
        provider TEXT NOT NULL, agentSessionId TEXT, status TEXT NOT NULL, createdAt INTEGER NOT NULL, finishedAt INTEGER);
      CREATE INDEX IF NOT EXISTS coding_sessions_dot ON coding_sessions(dotId, createdAt);
      CREATE UNIQUE INDEX IF NOT EXISTS coding_sessions_active ON coding_sessions(dotId) WHERE status='running';`);
    // SQLite has no ADD COLUMN IF NOT EXISTS. Existing Dots keep Claude Code.
    if (
      !(
        db.prepare('PRAGMA table_info(coding_agent_settings)').all() as {
          name: string;
        }[]
      ).some((column) => column.name === 'provider')
    )
      db.exec(
        "ALTER TABLE coding_agent_settings ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'",
      );
    // A lost process cannot continue an unobserved action after an application restart.
    db.prepare(
      "UPDATE coding_sessions SET status='interrupted', finishedAt=? WHERE status='running'",
    ).run(Date.now());
  }
  enabled(dotId: string): boolean {
    return (
      this.db
        .prepare('SELECT enabled FROM coding_agent_settings WHERE dotId=?')
        .get(dotId)?.enabled === 1
    );
  }
  /** The coding agent this Dot uses. Claude Code unless the owner chose another one. */
  provider(dotId: string): CodingProviderId {
    const saved = codingProviderSchema.safeParse(
      this.db
        .prepare('SELECT provider FROM coding_agent_settings WHERE dotId=?')
        .get(dotId)?.provider,
    );
    return saved.success ? saved.data : 'claude';
  }
  /** Leaving `provider` out keeps the saved choice (Claude Code for a new Dot). */
  configure(dotId: string, enabled: boolean, provider?: CodingProviderId) {
    const chosen = codingProviderSchema.optional().parse(provider);
    this.db
      .prepare(
        "INSERT INTO coding_agent_settings(dotId,enabled,provider) VALUES (?,?,COALESCE(?,'claude')) ON CONFLICT(dotId) DO UPDATE SET enabled=excluded.enabled, provider=COALESCE(?, provider)",
      )
      .run(dotId, +enabled, chosen ?? null, chosen ?? null);
    return { enabled, provider: this.provider(dotId) };
  }
  start(dotId: string, threadId: string, provider: string): CodingSession {
    const id = randomUUID();
    try {
      this.db
        .prepare(
          "INSERT INTO coding_sessions(id,dotId,threadId,provider,status,createdAt) VALUES (?,?,?,?,'running',?)",
        )
        .run(id, dotId, threadId, provider, Date.now());
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes(
          'UNIQUE constraint failed: coding_sessions.dotId',
        )
      )
        throw new CodingTaskBusyError();
      throw error;
    }
    return this.get(id)!;
  }
  attach(id: string, agentSessionId: string) {
    this.db
      .prepare('UPDATE coding_sessions SET agentSessionId=? WHERE id=?')
      .run(agentSessionId, id);
  }
  finish(id: string, status: Exclude<CodingStatus, 'running'>) {
    this.db
      .prepare(
        "UPDATE coding_sessions SET status=?, finishedAt=? WHERE id=? AND status='running'",
      )
      .run(status, Date.now(), id);
  }
  get(id: string): CodingSession | undefined {
    return this.db
      .prepare('SELECT * FROM coding_sessions WHERE id=?')
      .get(id) as unknown as CodingSession | undefined;
  }
  list(dotId: string): CodingSession[] {
    return this.db
      .prepare(
        'SELECT * FROM coding_sessions WHERE dotId=? ORDER BY createdAt DESC,rowid DESC LIMIT 50',
      )
      .all(dotId) as unknown as CodingSession[];
  }
}
