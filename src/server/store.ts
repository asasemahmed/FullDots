import { DatabaseSync } from 'node:sqlite';
import { CodingSessions } from './agents/coding-sessions.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { redactForStorage } from './redaction.js';
import type {
  Action,
  Detail,
  Memory,
  Result,
  Run,
  Settings,
  Task,
  TaskEvent,
  TaskKind,
} from '../shared/types.js';

export type Claim = Task & { lease: string };
export interface NewTask {
  kind?: TaskKind;
  intervalSeconds?: number | null;
  maxRuns?: number | null;
  triggerId?: string | null;
}
const MAX_BOUND_EXCLUDES = 30_000;
// Columns added after the first release; ALTER TABLE keeps existing rows and their ids.
const TASK_COLUMNS: [string, string][] = [
  ['kind', "TEXT NOT NULL DEFAULT 'once'"],
  ['runCount', 'INTEGER NOT NULL DEFAULT 0'],
  ['maxRuns', 'INTEGER'],
  ['lastRunAt', 'INTEGER'],
  ['triggerId', 'TEXT'],
  ['summary', 'TEXT'],
];
const defaults: Settings = {
  name: 'Dot',
  paused: false,
  researchAllowed: true,
  memoryAllowed: true,
};
export class Store {
  private db: DatabaseSync;
  readonly codingSessions: CodingSessions;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, intervalSeconds INTEGER, nextRunAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, error TEXT, lease TEXT, leaseUntil INTEGER,
        kind TEXT NOT NULL DEFAULT 'once', runCount INTEGER NOT NULL DEFAULT 0, maxRuns INTEGER, lastRunAt INTEGER, triggerId TEXT, summary TEXT);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, taskId TEXT NOT NULL, status TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER, result TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL, runId TEXT, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status, nextRunAt);
      CREATE INDEX IF NOT EXISTS runs_task ON runs(taskId, startedAt);
      CREATE INDEX IF NOT EXISTS events_task ON events(taskId, id);`);
    this.db
      .prepare('INSERT OR IGNORE INTO settings VALUES (1, ?)')
      .run(JSON.stringify(defaults));
    this.migrateTasks();
    this.codingSessions = new CodingSessions(this.db);
  }
  private migrateTasks() {
    const present = new Set(
      (
        this.db.prepare('PRAGMA table_info(tasks)').all() as {
          name: string;
        }[]
      ).map((column) => column.name),
    );
    const missing = TASK_COLUMNS.filter(([name]) => !present.has(name));
    if (!missing.length) return;
    // A database from before these columns: add them in one write.
    this.transaction(() => {
      for (const [name, type] of missing)
        this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
      if (!present.has('kind'))
        this.db.exec(
          "UPDATE tasks SET kind='repeat' WHERE intervalSeconds IS NOT NULL",
        );
    });
  }
  close() {
    this.db.close();
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  settings(): Settings {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE id=1')
      .get() as { value: string };
    return JSON.parse(row.value) as Settings;
  }
  updateSettings(patch: Partial<Settings>): Settings {
    return this.transaction(() => {
      const previous = this.settings();
      const settings = { ...previous, ...patch };
      this.db
        .prepare('UPDATE settings SET value=? WHERE id=1')
        .run(JSON.stringify(settings));
      if (
        (!previous.paused && settings.paused) ||
        (previous.researchAllowed && !settings.researchAllowed) ||
        (previous.memoryAllowed && !settings.memoryAllowed) ||
        !!previous.composioAllowed !== !!settings.composioAllowed
      ) {
        const running = this.tasks().filter((t) => t.status === 'running');
        for (const task of running) {
          this.invalidate(
            task,
            'interrupted',
            'Run interrupted because settings changed. Review completed effects before retrying.',
          );
        }
      }
      return settings;
    });
  }
  tasks(): Task[] {
    return this.db
      .prepare('SELECT * FROM tasks ORDER BY createdAt DESC')
      .all() as unknown as Task[];
  }
  task(id: string): Task | undefined {
    return this.db
      .prepare('SELECT * FROM tasks WHERE id=?')
      .get(id) as unknown as Task | undefined;
  }
  createTask(prompt: string, options: number | null | NewTask = null): Task {
    const input: NewTask =
      typeof options === 'number' || options === null
        ? { intervalSeconds: options }
        : options;
    const intervalSeconds = input.intervalSeconds ?? null;
    const kind: TaskKind = input.kind ?? (intervalSeconds ? 'repeat' : 'once');
    if (kind === 'goal' && !intervalSeconds)
      throw new Error('A goal needs a check interval.');
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO tasks (id, prompt, status, intervalSeconds, nextRunAt, createdAt, updatedAt, kind, maxRuns, triggerId)
         VALUES (?, ?, 'queued', ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        prompt,
        intervalSeconds,
        now,
        now,
        kind,
        input.maxRuns ?? null,
        input.triggerId ?? null,
      );
    this.event(
      id,
      null,
      kind === 'goal'
        ? 'Goal added. The Dot works on it until it is achieved.'
        : kind === 'event'
          ? 'Started by a trigger.'
          : 'Task added to the queue.',
    );
    return this.task(id)!;
  }
  detail(id: string): Detail | undefined {
    const task = this.task(id);
    if (!task) return undefined;
    const rows = this.db
      .prepare(
        'SELECT * FROM runs WHERE taskId=? ORDER BY startedAt DESC, rowid DESC',
      )
      .all(id) as unknown as (Omit<Run, 'result'> & {
      result: string | null;
    })[];
    return {
      task,
      runs: rows.map((row) => ({
        ...row,
        result: row.result ? (JSON.parse(row.result) as Result) : null,
      })),
      events: this.db
        .prepare('SELECT * FROM events WHERE taskId=? ORDER BY id')
        .all(id) as unknown as TaskEvent[],
    };
  }
  event(taskId: string, runId: string | null, text: string) {
    this.db
      .prepare(
        'INSERT INTO events (taskId, runId, text, createdAt) VALUES (?, ?, ?, ?)',
      )
      .run(taskId, runId, text, Date.now());
  }
  private invalidate(task: Task, status: string, reason: string) {
    const now = Date.now();
    if (task.lease)
      this.db
        .prepare(
          "UPDATE runs SET status='interrupted', finishedAt=?, error=? WHERE id=? AND status='running'",
        )
        .run(now, reason, task.lease);
    this.db
      .prepare(
        'UPDATE tasks SET status=?, lease=NULL, leaseUntil=NULL, updatedAt=?, error=? WHERE id=?',
      )
      .run(status, now, status === 'interrupted' ? reason : null, task.id);
    this.event(task.id, task.lease, reason);
  }
  action(id: string, action: Action): Task | undefined {
    return this.transaction(() => {
      const task = this.task(id);
      if (!task) return undefined;
      if (action === 'run' && task.status === 'running') return task;
      const status =
        action === 'run'
          ? 'queued'
          : action === 'pause'
            ? 'paused'
            : 'cancelled';
      this.invalidate(
        task,
        status,
        action === 'run' ? 'Task queued for a new run.' : `Task ${status}.`,
      );
      this.db
        .prepare('UPDATE tasks SET error=NULL, nextRunAt=NULL WHERE id=?')
        .run(id);
      return this.task(id);
    });
  }
  schedule(id: string, intervalSeconds: number | null): Task | undefined {
    const task = this.task(id);
    if (!task) return undefined;
    const next =
      intervalSeconds && task.status === 'completed'
        ? Date.now() + intervalSeconds * 1000
        : null;
    this.db
      .prepare(
        'UPDATE tasks SET intervalSeconds=?, nextRunAt=?, updatedAt=? WHERE id=?',
      )
      .run(intervalSeconds, next, Date.now(), id);
    this.event(
      id,
      null,
      intervalSeconds
        ? `Repeats every ${intervalSeconds / 60} minutes after a successful run.`
        : 'Repeat schedule removed.',
    );
    return this.task(id);
  }
  /**
   * Claims the next due task. `excludeTaskIds` are skipped this tick: they are neither
   * claimed nor lease-recovered (a task whose turn is live in this process keeps its row as is).
   */
  claim(
    now = Date.now(),
    /** A number, or the lease for the task about to be claimed (it depends on the task's kind). */
    leaseMs: number | ((task: Task) => number) = 180_000,
    excludeTaskIds: string[] = [],
  ): Claim | null {
    const excludedSet = new Set(excludeTaskIds);
    // SQLite binds at most 32766 variables; a longer list is filtered in JS instead.
    const bound = excludeTaskIds.length <= MAX_BOUND_EXCLUDES;
    const notExcluded =
      bound && excludeTaskIds.length
        ? ` AND id NOT IN (${excludeTaskIds.map(() => '?').join(', ')})`
        : '';
    return this.transaction(() => {
      const settings = this.settings();
      if (settings.paused || !settings.researchAllowed) return null;
      const expired = (
        this.db
          .prepare(
            "SELECT * FROM tasks WHERE status='running' AND leaseUntil<=?",
          )
          .all(now) as unknown as Task[]
      ).filter((task) => !excludedSet.has(task.id));
      for (const task of expired)
        this.invalidate(
          task,
          'interrupted',
          'Worker lease expired. Review completed effects before retrying.',
        );
      const due = this.db.prepare(
        `SELECT * FROM tasks WHERE (status='queued' OR (status='completed' AND nextRunAt IS NOT NULL AND nextRunAt<=?))${notExcluded} ORDER BY createdAt${bound ? ' LIMIT 1' : ''}`,
      );
      const task = (bound
        ? due.get(now, ...excludeTaskIds)
        : due
            .all(now)
            .find((row) => !excludedSet.has(String(row.id)))) as unknown as
        Task | undefined;
      if (!task) return null;
      const lease = randomUUID();
      this.db
        .prepare(
          "UPDATE tasks SET status='running', lease=?, leaseUntil=?, nextRunAt=NULL, error=NULL, updatedAt=? WHERE id=?",
        )
        .run(
          lease,
          now + (typeof leaseMs === 'number' ? leaseMs : leaseMs(task)),
          now,
          task.id,
        );
      this.db
        .prepare(
          "INSERT INTO runs VALUES (?, ?, 'running', ?, NULL, NULL, NULL)",
        )
        .run(lease, task.id, now);
      this.event(task.id, lease, 'Run started.');
      return { ...this.task(task.id)!, lease };
    });
  }
  owns(claim: Claim): boolean {
    const task = this.task(claim.id);
    return task?.status === 'running' && task.lease === claim.lease;
  }
  finish(claim: Claim, result: Result, now = Date.now()): boolean {
    return this.transaction(() => {
      if (!this.owns(claim)) return false;
      const task = this.task(claim.id)!;
      this.db
        .prepare(
          "UPDATE runs SET status='completed', finishedAt=?, result=? WHERE id=?",
        )
        .run(now, JSON.stringify(result), claim.lease);
      const runCount = task.runCount + 1;
      // A goal the Dot marked done during this run has no next run.
      const repeats =
        !!task.intervalSeconds && !(task.kind === 'goal' && task.summary);
      const limited = task.maxRuns !== null && runCount >= task.maxRuns;
      this.db
        .prepare(
          "UPDATE tasks SET status='completed', lease=NULL, leaseUntil=NULL, updatedAt=?, nextRunAt=?, runCount=?, lastRunAt=? WHERE id=?",
        )
        .run(
          now,
          repeats && !limited ? now + task.intervalSeconds! * 1000 : null,
          runCount,
          now,
          claim.id,
        );
      this.event(
        claim.id,
        claim.lease,
        result.sample ? 'Fictional sample brief ready.' : 'Run completed.',
      );
      if (repeats && limited)
        this.event(
          claim.id,
          null,
          `Stopped after ${runCount} ${runCount === 1 ? 'run' : 'runs'}, its run limit.`,
        );
      return true;
    });
  }
  /**
   * Marks a goal achieved. Called by the Dot on the goal's own running turn; the run itself
   * finishes normally and then schedules nothing more.
   */
  completeGoal(taskId: string, summary: string): Task | undefined {
    return this.transaction(() => {
      const task = this.task(taskId);
      if (!task || task.kind !== 'goal') return undefined;
      const text = summary.trim().slice(0, 2000) || 'Goal achieved.';
      this.db
        .prepare(
          'UPDATE tasks SET summary=?, nextRunAt=NULL, updatedAt=? WHERE id=?',
        )
        .run(text, Date.now(), taskId);
      this.event(taskId, task.lease, `Goal achieved: ${text}`);
      return this.task(taskId);
    });
  }
  interrupt(claim: Claim, reason: string) {
    this.transaction(() => {
      if (this.owns(claim)) this.invalidate(claim, 'interrupted', reason);
    });
  }
  /** Puts a claim back in the queue when nothing ran, for example when the Dot was busy. */
  release(claim: Claim, reason: string) {
    this.transaction(() => {
      if (this.owns(claim)) this.invalidate(claim, 'queued', reason);
    });
  }
  fail(claim: Claim, error: string) {
    this.transaction(() => {
      if (!this.owns(claim)) return;
      const now = Date.now();
      this.db
        .prepare(
          "UPDATE runs SET status='failed', finishedAt=?, error=? WHERE id=?",
        )
        .run(now, error, claim.lease);
      this.db
        .prepare(
          "UPDATE tasks SET status='failed', lease=NULL, leaseUntil=NULL, error=?, updatedAt=? WHERE id=?",
        )
        .run(error, now, claim.id);
      this.event(claim.id, claim.lease, error);
    });
  }
  memories(): Memory[] {
    return this.db
      .prepare('SELECT * FROM memories ORDER BY createdAt DESC')
      .all() as unknown as Memory[];
  }
  saveMemory(rawText: string, id: string = randomUUID()): Memory {
    const text = redactForStorage(rawText, (count) =>
      console.warn(
        `Redacted ${count} secret-like value${count === 1 ? '' : 's'} before saving a memory.`,
      ),
    );
    this.db
      .prepare(
        'INSERT INTO memories VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET text=excluded.text',
      )
      .run(id, text, Date.now());
    return this.db
      .prepare('SELECT * FROM memories WHERE id=?')
      .get(id) as unknown as Memory;
  }
  deleteMemory(id: string): boolean {
    return (
      this.db.prepare('DELETE FROM memories WHERE id=?').run(id).changes > 0
    );
  }
}
