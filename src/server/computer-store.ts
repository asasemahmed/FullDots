import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  ComputerAudit,
  ComputerPermissions,
} from '../shared/computer-types.js';
import type { ActionAuditEntry } from '../shared/types.js';
export class ComputerStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS computer_permissions(dotId TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS computer_audit(id TEXT PRIMARY KEY,dotId TEXT NOT NULL,action TEXT NOT NULL,actor TEXT NOT NULL,outcome TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS action_audit(id TEXT PRIMARY KEY,dotId TEXT NOT NULL,threadId TEXT,tool TEXT NOT NULL,actor TEXT NOT NULL,outcome TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS action_audit_dot ON action_audit(dotId,createdAt);`);
    const row = db.prepare('SELECT COUNT(*) AS n FROM action_audit').get();
    if (Number(row?.n) === 0)
      db.exec(
        `INSERT INTO action_audit(id,dotId,threadId,tool,actor,outcome,createdAt) SELECT id,dotId,NULL,action,actor,outcome,createdAt FROM computer_audit`,
      );
  }
  permissions(id: string): ComputerPermissions {
    const row = this.db
      .prepare('SELECT value FROM computer_permissions WHERE dotId=?')
      .get(id);
    return row
      ? JSON.parse(String(row.value))
      : { enabled: false, browser: false, files: false, shell: false };
  }
  patch(id: string, patch: Partial<ComputerPermissions>) {
    const value = { ...this.permissions(id), ...patch };
    this.db
      .prepare('INSERT OR REPLACE INTO computer_permissions VALUES (?,?)')
      .run(id, JSON.stringify(value));
    return value;
  }
  begin(
    dotId: string,
    action: string,
    actor: 'owner' | 'agent',
    threadId: string | null = null,
  ) {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO action_audit(id,dotId,threadId,tool,actor,outcome,createdAt) VALUES (?,?,?,?,?,?,?)',
      )
      .run(id, dotId, threadId, action, actor, 'pending', Date.now());
    return id;
  }
  finish(id: string, outcome: 'succeeded' | 'failed') {
    this.db
      .prepare('UPDATE action_audit SET outcome=? WHERE id=?')
      .run(outcome, id);
    this.cap(id);
  }
  record(entry: Omit<ActionAuditEntry, 'id' | 'createdAt'>) {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO action_audit(id,dotId,threadId,tool,actor,outcome,createdAt) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        id,
        entry.dotId,
        entry.threadId,
        entry.tool,
        entry.actor,
        entry.outcome,
        Date.now(),
      );
    this.cap(id);
    return id;
  }
  audit(dotId: string): ComputerAudit[] {
    return this.db
      .prepare(
        'SELECT id,tool AS action,actor,outcome,createdAt FROM action_audit WHERE dotId=? ORDER BY createdAt DESC,rowid DESC LIMIT 50',
      )
      .all(dotId) as unknown as ComputerAudit[];
  }
  auditEntries(dotId: string, limit = 100): ActionAuditEntry[] {
    return this.db
      .prepare(
        'SELECT id,dotId,threadId,tool,actor,outcome,createdAt FROM action_audit WHERE dotId=? ORDER BY createdAt DESC,rowid DESC LIMIT ?',
      )
      .all(dotId, limit) as unknown as ActionAuditEntry[];
  }
  private cap(id: string) {
    this.db
      .prepare(
        `DELETE FROM action_audit WHERE dotId=(SELECT dotId FROM action_audit WHERE id=?) AND outcome!='pending' AND id NOT IN (SELECT id FROM action_audit WHERE dotId=(SELECT dotId FROM action_audit WHERE id=?) AND outcome!='pending' ORDER BY createdAt DESC,rowid DESC LIMIT 1000)`,
      )
      .run(id, id);
  }
}
