// Local, durable replacement for the CopilotKit Intelligence thread store.
// Adapted from @copilotkit/sqlite-runner (MIT) to use node:sqlite and to serve
// the runtime's local thread endpoints (thread list, messages, events, state).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ReplaySubject, type Observable } from 'rxjs';
import {
  EventType,
  compactEvents,
  type AbstractAgent,
  type BaseEvent,
  type Message,
} from '@ag-ui/client';
import {
  AgentRunner,
  finalizeRunEvents,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  type LocalThreadEndpointRecord,
} from '@copilotkit/runtime/v2';

interface ActiveRun {
  subject: ReplaySubject<BaseEvent>;
  agent?: AbstractAgent;
  runId: string;
  stopRequested: boolean;
}

export class SqliteAgentRunner extends AgentRunner {
  readonly ɵsupportsLocalThreadEndpoints = true as const;
  private db: DatabaseSync;
  // Run state is process-local on purpose: a crash must not leave a thread
  // marked as running forever.
  private active = new Map<string, ActiveRun>();

  constructor(path: string) {
    super();
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS chat_runs(id INTEGER PRIMARY KEY AUTOINCREMENT, threadId TEXT NOT NULL, runId TEXT NOT NULL UNIQUE, agentId TEXT NOT NULL, events TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_runs_thread ON chat_runs(threadId, id);
      CREATE TABLE IF NOT EXISTS chat_threads(threadId TEXT PRIMARY KEY, agentId TEXT NOT NULL, messages TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);`);
  }

  close() {
    this.db.close();
  }

  private historicEvents(threadId: string): BaseEvent[] {
    return this.db
      .prepare('SELECT events FROM chat_runs WHERE threadId=? ORDER BY id')
      .all(threadId)
      .flatMap((row) => JSON.parse(String(row.events)) as BaseEvent[]);
  }

  private storeRun(
    threadId: string,
    runId: string,
    agentId: string,
    events: BaseEvent[],
    messages: Message[],
  ) {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          'INSERT OR REPLACE INTO chat_runs(threadId, runId, agentId, events, createdAt) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          threadId,
          runId,
          agentId,
          JSON.stringify(compactEvents(events)),
          now,
        );
      if (messages.length)
        this.db
          .prepare(
            `INSERT INTO chat_threads(threadId, agentId, messages, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(threadId) DO UPDATE SET messages=excluded.messages, updatedAt=excluded.updatedAt`,
          )
          .run(threadId, agentId, JSON.stringify(messages), now, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const { threadId, agent, input } = request;
    if (this.active.has(threadId)) throw new Error('Thread already running');
    const historicIds = new Set<string>();
    for (const event of this.historicEvents(threadId)) {
      if ('messageId' in event && typeof event.messageId === 'string')
        historicIds.add(event.messageId);
      if (event.type === EventType.RUN_STARTED) {
        const started = event as BaseEvent & {
          input?: { messages?: Message[] };
        };
        for (const message of started.input?.messages ?? [])
          historicIds.add(message.id);
      }
    }
    const freshMessages = () =>
      input.messages.filter((message) => !historicIds.has(message.id));
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    const events: BaseEvent[] = [];
    const state: ActiveRun = {
      subject,
      agent,
      runId: input.runId,
      stopRequested: false,
    };
    this.active.set(threadId, state);
    const emit = (event: BaseEvent) => {
      events.push(event);
      subject.next(event);
    };
    const finish = () => {
      if (
        state.stopRequested &&
        !events.some((event) => event.type === EventType.RUN_STARTED)
      ) {
        const started = {
          type: EventType.RUN_STARTED,
          threadId,
          runId: input.runId,
          input: { ...input, messages: freshMessages() },
        } as BaseEvent;
        events.unshift(started);
        subject.next(started);
      }
      for (const event of finalizeRunEvents(events, {
        stopRequested: state.stopRequested,
      }))
        emit(event);
      try {
        if (events.length)
          this.storeRun(
            threadId,
            input.runId,
            agent.agentId ?? '',
            events,
            agent.messages,
          );
      } catch (error) {
        console.error('Could not save the conversation run:', error);
      }
      this.active.delete(threadId);
      state.agent = undefined;
      subject.complete();
    };
    void agent
      .runAgent(input, {
        onEvent: ({ event }) => {
          if (
            event.type === EventType.RUN_STARTED &&
            !(event as BaseEvent & { input?: unknown }).input
          )
            event = {
              ...event,
              input: { ...input, messages: freshMessages() },
            } as BaseEvent;
          emit(event);
        },
      })
      .then(finish, finish);
    return subject.asObservable();
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const subject = new ReplaySubject<BaseEvent>(Infinity);
    const emitted = new Set<string>();
    for (const event of compactEvents(this.historicEvents(request.threadId))) {
      subject.next(event);
      if ('messageId' in event && typeof event.messageId === 'string')
        emitted.add(event.messageId);
    }
    const running = this.active.get(request.threadId);
    if (running)
      running.subject.subscribe({
        next: (event) => {
          if (
            'messageId' in event &&
            typeof event.messageId === 'string' &&
            emitted.has(event.messageId)
          )
            return;
          subject.next(event);
        },
        complete: () => subject.complete(),
        error: (error) => subject.error(error),
      });
    else subject.complete();
    return subject.asObservable();
  }

  isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    return Promise.resolve(this.active.has(request.threadId));
  }

  stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    const running = this.active.get(request.threadId);
    if (
      !running?.agent ||
      running.stopRequested ||
      (request.runId && request.runId !== running.runId)
    )
      return Promise.resolve(false);
    running.stopRequested = true;
    try {
      running.agent.abortRun();
      return Promise.resolve(true);
    } catch {
      running.stopRequested = false;
      return Promise.resolve(false);
    }
  }

  listThreads(): LocalThreadEndpointRecord[] {
    return this.db
      .prepare(
        'SELECT threadId, agentId, createdAt, updatedAt FROM chat_threads ORDER BY updatedAt DESC',
      )
      .all()
      .map((row) => ({
        id: String(row.threadId),
        name: null,
        agentId: String(row.agentId),
        organizationId: '',
        createdById: '',
        archived: false,
        createdAt: new Date(Number(row.createdAt)).toISOString(),
        updatedAt: new Date(Number(row.updatedAt)).toISOString(),
      }));
  }

  getThreadMessages(threadId: string): Message[] {
    const row = this.db
      .prepare('SELECT messages FROM chat_threads WHERE threadId=?')
      .get(threadId);
    return row ? (JSON.parse(String(row.messages)) as Message[]) : [];
  }

  getThreadEvents(threadId: string): BaseEvent[] {
    return compactEvents(this.historicEvents(threadId));
  }

  getThreadState(threadId: string): Record<string, unknown> | null {
    const snapshot = this.getThreadEvents(threadId)
      .filter((event) => event.type === EventType.STATE_SNAPSHOT)
      .at(-1) as (BaseEvent & { snapshot?: unknown }) | undefined;
    return snapshot?.snapshot && typeof snapshot.snapshot === 'object'
      ? (snapshot.snapshot as Record<string, unknown>)
      : null;
  }

  clearThreads() {
    this.db.exec('DELETE FROM chat_runs; DELETE FROM chat_threads;');
  }
}
