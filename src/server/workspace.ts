import { ApprovalStore } from './approval-store.js';
import { ComputerStore } from './computer-store.js';
import { ComputerFrameStore } from './computer-frames.js';
import { ConnectorAuthStore } from './connector-auth-store.js';
import { loadConnectorKey } from './connector-crypto.js';
import { ConnectorStore } from './connector-store.js';
import { ModelProviderStore } from './model-provider-store.js';
import { HandoffStore } from './handoff-store.js';
import { ResumeStore } from './resume-store.js';
import { UsageStore } from './usage-store.js';
import { TriggerStore } from './trigger-store.js';
import { TeamStore } from './team-store.js';
import { NamedTeamStore } from './teams/named-team-store.js';
import { RuleStore } from './rule-store.js';
import { PromptStore } from './prompt-store.js';
import { SearchStore } from './search-store.js';
import { ParticipantStore } from './participant-store.js';
import { PinStore } from './pin-store.js';
import { copyThreadRows } from './thread-branch.js';
import { InboxStore } from './inbox-store.js';
import { DotNotesStore } from './dot-notes-store.js';
import { Pages } from './pages.js';
import { SpaceFiles } from './space-files.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DOT_COLORS,
  DOT_GEAR,
  DOT_SPECIES,
  type ApprovalMode,
  type CallReceipt,
  type Conversation,
  type Dot,
  type DotColor,
  type DotGear,
  type DotSpecies,
  type Space,
} from '../shared/types.js';
/** A call still marked active after this long is treated as abandoned. */
const LIVE_CALL_MS = 60 * 60 * 1000;
/**
 * NULL (every Dot from before colours, species or gear) or an unknown value drops the field, so the
 * palette and the penguin follow the Dot's id and the penguin wears nothing.
 */
function knownLook<
  T extends { color?: unknown; species?: unknown; gear?: unknown },
>({ color, species, gear, ...row }: T) {
  return {
    ...row,
    ...(DOT_COLORS.includes(color as DotColor) ? { color } : {}),
    ...(DOT_SPECIES.includes(species as DotSpecies) ? { species } : {}),
    ...(DOT_GEAR.includes(gear as DotGear) && gear !== 'none' ? { gear } : {}),
  };
}
/** How a Dot is drawn; every field is optional and null clears it. */
export interface DotLook {
  color?: DotColor | null;
  species?: DotSpecies | null;
  gear?: DotGear | null;
}
export class WorkspaceStore {
  private db: DatabaseSync;
  readonly pages: Pages;
  /** Files kept in Spaces, beside the pages. */
  readonly spaceFiles: SpaceFiles;
  readonly computers: ComputerStore;
  /** Computer replay steps and their pictures. */
  readonly frames: ComputerFrameStore;
  readonly connectors: ConnectorStore;
  readonly connectorAuth: ConnectorAuthStore;
  /** Model providers whose API keys are stored encrypted; Dots reference them by id. */
  readonly modelProviders: ModelProviderStore;
  readonly approvals: ApprovalStore;
  readonly handoffs: HandoffStore;
  readonly resumes: ResumeStore;
  readonly usage: UsageStore;
  readonly triggers: TriggerStore;
  readonly team: TeamStore;
  /** Named teams (a lead and its members) and their runs: see docs/TEAMS.md. */
  readonly teams: NamedTeamStore;
  /** Rules per Dot (send messages, spend money, ...): see docs/APPROVALS.md. */
  readonly rules: RuleStore;
  readonly prompts: PromptStore;
  readonly search: SearchStore;
  /** Group chats: Dots added to a conversation besides its host. */
  readonly participants: ParticipantStore;
  /** Messages pinned to the top of a conversation. */
  readonly pins: PinStore;
  /** Questions from `ask_owner` and results of finished background turns. */
  readonly inbox: InboxStore;
  /** What each Dot remembers about the owner, with every earlier text kept. */
  readonly notes: DotNotesStore;
  constructor(
    path: string,
    readonly ownerId: string,
    options: { connectorKey?: Buffer } = {},
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_threads(taskId TEXT PRIMARY KEY, threadId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, startedAt INTEGER NOT NULL, endedAt INTEGER, status TEXT NOT NULL, transcript TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS captures(threadId TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    for (const [table, column, definition] of [
      ['dots', 'learningContainerId', 'TEXT'],
      ['dots', 'skillDeliveryEnabled', 'INTEGER NOT NULL DEFAULT 0'],
      ['thread_bindings', 'learningContainerId', 'TEXT'],
      ['dots', 'model', 'TEXT'],
      ['dots', 'approvalMode', 'TEXT'],
      ['dots', 'paused', 'INTEGER NOT NULL DEFAULT 0'],
      ['dots', 'modelProviderId', 'TEXT'],
      ['dots', 'color', 'TEXT'],
      ['dots', 'species', 'TEXT'],
      ['dots', 'gear', 'TEXT'],
      // A branch remembers the conversation and message it was copied from.
      ['thread_bindings', 'branchedFromThreadId', 'TEXT'],
      ['thread_bindings', 'branchedFromMessageId', 'TEXT'],
      ['dots', 'notesProposals', 'INTEGER NOT NULL DEFAULT 0'],
      // A team chat names its team; every other conversation keeps NULL.
      ['thread_bindings', 'teamId', 'TEXT'],
    ]) {
      if (
        !this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((field) => field.name === column)
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    // Migrate only once: restarting must never restore a revoked grant.
    if (
      !this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='dot_spaces'",
        )
        .get()
    ) {
      this.db.exec(`BEGIN;
        CREATE TABLE dot_spaces(dotId TEXT NOT NULL, spaceId TEXT NOT NULL, PRIMARY KEY(dotId, spaceId));
        INSERT INTO dot_spaces SELECT id, spaceId FROM dots;
        COMMIT;`);
    }
    this.computers = new ComputerStore(this.db);
    this.frames = new ComputerFrameStore(this.db);
    this.connectors = new ConnectorStore(this.db);
    const connectorKey =
      options.connectorKey ??
      loadConnectorKey({ env: process.env, databasePath: path });
    this.connectorAuth = new ConnectorAuthStore(this.db, connectorKey);
    this.modelProviders = new ModelProviderStore(this.db, connectorKey);
    this.approvals = new ApprovalStore(this.db);
    this.handoffs = new HandoffStore(this.db);
    this.resumes = new ResumeStore(this.db);
    this.participants = new ParticipantStore(this.db);
    this.usage = new UsageStore(this.db);
    this.triggers = new TriggerStore(this.db, connectorKey);
    this.team = new TeamStore(this.db);
    this.teams = new NamedTeamStore(this.db);
    this.rules = new RuleStore(this.db);
    const spaceExists = (id: string) =>
      this.spaces().some((space) => space.id === id);
    // Created first: deleting a page moves its files up, so Pages needs the table to exist.
    this.spaceFiles = new SpaceFiles(this.db, spaceExists, (spaceId, id) =>
      this.pages.exists(spaceId, id),
    );
    this.pages = new Pages(this.db, spaceExists);
    this.prompts = new PromptStore(this.db);
    this.search = new SearchStore(this.db, ownerId);
    this.pins = new PinStore(this.db);
    this.inbox = new InboxStore(this.db);
    this.notes = new DotNotesStore(this.db);
    if (
      !this.db
        .prepare('PRAGMA table_info(calls)')
        .all()
        .some((column) => column.name === 'anchorMessageId')
    )
      this.db.exec('ALTER TABLE calls ADD COLUMN anchorMessageId TEXT');
    if (!this.spaces().length) {
      const space = this.createSpace(
        'Everyday',
        'A little space for your day.',
      );
      this.createDot(
        space.id,
        'Dot',
        'Be thoughtful, practical, and concise. Help the user think clearly and follow through.',
        true,
        true,
      );
    }
  }
  close() {
    this.db.close();
  }
  spaces(): Space[] {
    return this.db
      .prepare('SELECT * FROM spaces ORDER BY createdAt')
      .all() as unknown as Space[];
  }
  createSpace(name: string, description: string): Space {
    const space = {
      id: randomUUID(),
      name,
      description,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO spaces VALUES (?, ?, ?, ?)')
      .run(space.id, name, description, space.createdAt);
    return space;
  }
  dots(): Dot[] {
    return (
      this.db
        .prepare('SELECT * FROM dots ORDER BY createdAt')
        .all()
        // Columns from the removed Automatic Learning feature stay in the table but are not read.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        .map(({ learningContainerId, skillDeliveryEnabled, ...row }) => ({
          ...knownLook(row),
          spaceIds: this.db
            .prepare(
              'SELECT spaceId FROM dot_spaces WHERE dotId=? ORDER BY spaceId',
            )
            .all(String(row.id))
            .map((grant) => String(grant.spaceId)),
          researchAllowed: !!row.researchAllowed,
          memoryAllowed: !!row.memoryAllowed,
          paused: !!row.paused,
          approvalMode: row.approvalMode ?? 'sensitive',
          modelProviderId: row.modelProviderId ?? null,
          notesProposals: !!row.notesProposals,
        })) as unknown as Dot[]
    );
  }
  dot(id: string) {
    return this.dots().find((dot) => dot.id === id);
  }
  createDot(
    spaceId: string,
    name: string,
    instructions: string,
    researchAllowed: boolean,
    memoryAllowed: boolean,
    spaceIds: string[] = [spaceId],
    model: string | null = null,
    approvalMode: ApprovalMode = 'sensitive',
    modelProviderId: string | null = null,
    look: DotLook = {},
  ): Dot {
    const color = look.color ?? null;
    const species = look.species ?? null;
    const gear = look.gear && look.gear !== 'none' ? look.gear : null;
    this.validateSpaceAccess(spaceId, spaceIds);
    const dot: Dot = {
      id: randomUUID(),
      spaceId,
      spaceIds: [...new Set(spaceIds)].sort(),
      name,
      instructions,
      researchAllowed,
      memoryAllowed,
      model,
      modelProviderId,
      approvalMode,
      paused: false,
      notesProposals: false,
      ...(color ? { color } : {}),
      ...(species ? { species } : {}),
      ...(gear ? { gear } : {}),
      createdAt: Date.now(),
    };
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt, model, approvalMode, modelProviderId, color, species, gear) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          dot.id,
          spaceId,
          name,
          instructions,
          +researchAllowed,
          +memoryAllowed,
          dot.createdAt,
          model,
          approvalMode,
          modelProviderId,
          color,
          species,
          gear,
        );
      for (const id of dot.spaceIds)
        this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(dot.id, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return dot;
  }
  canAccessSpace(dotId: string, spaceId: string) {
    return !!this.db
      .prepare('SELECT 1 FROM dot_spaces WHERE dotId=? AND spaceId=?')
      .get(dotId, spaceId);
  }
  private validateSpaceAccess(defaultSpace: string, spaceIds: string[]) {
    if (
      !spaceIds.includes(defaultSpace) ||
      spaceIds.some((id) => !this.spaces().some((space) => space.id === id))
    )
      throw new Error('Space access must include a valid default destination.');
  }
  updateDot(
    id: string,
    patch: Pick<
      Dot,
      'name' | 'instructions' | 'researchAllowed' | 'memoryAllowed'
    > & {
      spaceId?: string;
      spaceIds?: string[];
      model?: string | null;
      modelProviderId?: string | null;
      approvalMode?: ApprovalMode | null;
      /** Undefined keeps the current colour; null clears it. */
      color?: DotColor | null;
      /** Undefined keeps the current species; null clears it. */
      species?: DotSpecies | null;
      /** Undefined keeps the current gear; null or 'none' clears it. */
      gear?: DotGear | null;
      /** Undefined keeps the current choice. */
      notesProposals?: boolean;
    },
  ): Dot {
    const current = this.dot(id);
    if (!current) throw new Error('Dot not found.');
    const defaultSpace = patch.spaceId ?? current.spaceId;
    const spaceIds = patch.spaceIds ?? current.spaceIds;
    this.validateSpaceAccess(defaultSpace, spaceIds);
    const model =
      patch.model === undefined ? (current.model ?? null) : patch.model;
    const modelProviderId =
      patch.modelProviderId === undefined
        ? (current.modelProviderId ?? null)
        : patch.modelProviderId;
    const approvalMode =
      patch.approvalMode ?? current.approvalMode ?? 'sensitive';
    const color =
      patch.color === undefined ? (current.color ?? null) : patch.color;
    const species =
      patch.species === undefined ? (current.species ?? null) : patch.species;
    const gearChoice =
      patch.gear === undefined ? (current.gear ?? null) : patch.gear;
    const gear = gearChoice === 'none' ? null : gearChoice;
    const notesProposals =
      patch.notesProposals ?? current.notesProposals ?? false;
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'UPDATE dots SET name=?, instructions=?, researchAllowed=?, memoryAllowed=?, model=?, approvalMode=?, modelProviderId=?, color=?, species=?, gear=?, notesProposals=? WHERE id=?',
        )
        .run(
          patch.name,
          patch.instructions,
          +patch.researchAllowed,
          +patch.memoryAllowed,
          model,
          approvalMode,
          modelProviderId,
          color,
          species,
          gear,
          +notesProposals,
          id,
        );
      this.db
        .prepare('UPDATE dots SET spaceId=? WHERE id=?')
        .run(defaultSpace, id);
      this.db.prepare('DELETE FROM dot_spaces WHERE dotId=?').run(id);
      for (const space of new Set(spaceIds))
        this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(id, space);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.dot(id)!;
  }
  /** Pauses or resumes one Dot: a paused Dot starts no turns and its background work waits. */
  setDotPaused(id: string, paused: boolean): Dot {
    if (!this.dot(id)) throw new Error('Dot not found.');
    this.db.prepare('UPDATE dots SET paused=? WHERE id=?').run(+paused, id);
    return this.dot(id)!;
  }
  pausedDotIds(): string[] {
    return this.db
      .prepare('SELECT id FROM dots WHERE paused=1')
      .all()
      .map((row) => String(row.id));
  }
  conversations(): Conversation[] {
    return this.db
      .prepare(
        'SELECT id, dotId, ownerId, title, createdAt, branchedFromThreadId, branchedFromMessageId, teamId FROM thread_bindings WHERE ownerId=? ORDER BY createdAt DESC',
      )
      .all(this.ownerId)
      .map(
        ({ branchedFromThreadId, branchedFromMessageId, teamId, ...row }) => ({
          ...(row as unknown as Conversation),
          ...(typeof teamId === 'string' ? { teamId } : {}),
          ...(typeof branchedFromThreadId === 'string'
            ? {
                branchedFrom: {
                  threadId: branchedFromThreadId,
                  messageId:
                    typeof branchedFromMessageId === 'string'
                      ? branchedFromMessageId
                      : null,
                },
              }
            : {}),
        }),
      );
  }
  bindThread(id: string, dotId: string, title: string): Conversation {
    const dot = this.dot(dotId);
    if (!dot) throw new Error('Dot not found.');
    const value: Conversation = {
      id,
      dotId,
      ownerId: this.ownerId,
      title,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, dotId, this.ownerId, title, value.createdAt);
    return value;
  }
  /**
   * Binds a branch of `source` for the same Dot, recording where it came from, and copies the
   * source's participants when the group chat's table exists. One transaction; the chat history is
   * copied before this by thread-branch.ts.
   */
  bindBranch(
    id: string,
    source: Conversation,
    messageId: string | null,
    title: string,
  ): Conversation {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = this.bindThread(id, source.dotId, title);
      this.db
        .prepare(
          'UPDATE thread_bindings SET branchedFromThreadId=?, branchedFromMessageId=? WHERE id=?',
        )
        .run(source.id, messageId, id);
      copyThreadRows(this.db, 'thread_participants', source.id, id);
      this.db.exec('COMMIT');
      return { ...value, branchedFrom: { threadId: source.id, messageId } };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /** The owner's conversation; with `dotId`, only when that Dot is its host or a participant. */
  requireThread(id: string, dotId?: string): Conversation {
    const thread = this.conversations().find((thread) => thread.id === id);
    if (
      !thread ||
      (dotId &&
        thread.dotId !== dotId &&
        !this.participants.has(thread.id, dotId))
    )
      throw new Error('Conversation does not belong to this Dot and owner.');
    return thread;
  }
  /** The host Dot and the participants of a conversation, host first. */
  threadMembers(id: string): string[] {
    const thread = this.requireThread(id);
    return [
      thread.dotId,
      ...this.participants
        .list(id)
        .map((row) => row.dotId)
        .filter((dotId) => dotId !== thread.dotId),
    ];
  }
  renameThread(id: string, title: string): Conversation {
    this.requireThread(id);
    this.db
      .prepare('UPDATE thread_bindings SET title=? WHERE id=? AND ownerId=?')
      .run(title, id, this.ownerId);
    return this.requireThread(id);
  }
  /**
   * Ids of conversations that something other than chat history points at: a
   * page conversation, a scheduled task, a call receipt, a pinned message or an inbox item.
   * Such a conversation is never "empty" even before its first message is stored.
   */
  linkedThreadIds(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT threadId FROM task_threads
         UNION SELECT threadId FROM page_threads
         UNION SELECT threadId FROM calls
         UNION SELECT threadId FROM pinned_messages
         UNION SELECT threadId FROM inbox_items`,
      )
      .all();
    return new Set(rows.map((row) => String(row.threadId)));
  }
  /** A call that has not ended and is recent enough to still be live. */
  hasLiveCall(threadId: string, now = Date.now()): boolean {
    return this.calls(threadId).some(
      (call) => call.endedAt === null && now - call.startedAt < LIVE_CALL_MS,
    );
  }
  /**
   * Removes a conversation and everything that exists only because of it:
   * its binding, page-conversation link and review receipts, capture, task
   * binding (the tasks themselves stay) and call receipts. Pages keep their
   * content but forget which conversation produced them.
   */
  deleteThread(id: string) {
    this.requireThread(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const sql of [
        'DELETE FROM calls WHERE threadId=?',
        'DELETE FROM captures WHERE threadId=?',
        'DELETE FROM task_threads WHERE threadId=?',
        'DELETE FROM page_threads WHERE threadId=?',
        'DELETE FROM page_reviews WHERE threadId=?',
        'UPDATE pages SET sourceThreadId=NULL WHERE sourceThreadId=?',
        'UPDATE space_files SET sourceThreadId=NULL WHERE sourceThreadId=?',
        'DELETE FROM approvals WHERE threadId=?',
        'DELETE FROM handoffs WHERE threadId=?',
        'DELETE FROM resume_markers WHERE threadId=?',
        'DELETE FROM trigger_events WHERE triggerId IN (SELECT id FROM triggers WHERE threadId=?)',
        'DELETE FROM triggers WHERE threadId=?',
        'DELETE FROM computer_frames WHERE threadId=?',
        'DELETE FROM thread_participants WHERE threadId=?',
        'DELETE FROM pinned_messages WHERE threadId=?',
        'DELETE FROM inbox_items WHERE threadId=?',
        'DELETE FROM team_run_steps WHERE runId IN (SELECT id FROM team_runs WHERE threadId=?)',
        'DELETE FROM team_runs WHERE threadId=?',
      ])
        this.db.prepare(sql).run(id);
      this.db
        .prepare('DELETE FROM thread_bindings WHERE id=? AND ownerId=?')
        .run(id, this.ownerId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  bindTask(taskId: string, threadId: string) {
    this.requireThread(threadId);
    this.db
      .prepare('INSERT INTO task_threads VALUES (?, ?)')
      .run(taskId, threadId);
  }
  /** Task ids bound to any of the threads, or to any conversation of any of the Dots. */
  taskIdsFor(exclusions: { threadIds: string[]; dotIds: string[] }): string[] {
    const { threadIds, dotIds } = exclusions;
    if (!threadIds.length && !dotIds.length) return [];
    const marks = (values: string[]) => values.map(() => '?').join(', ');
    return this.db
      .prepare(
        `SELECT taskId FROM task_threads WHERE threadId IN (${marks(threadIds)})
         OR threadId IN (SELECT id FROM thread_bindings WHERE dotId IN (${marks(dotIds)}))`,
      )
      .all(...threadIds, ...dotIds)
      .map((row) => String(row.taskId));
  }
  /** The scheduled task bound to a conversation, if any. */
  threadTask(threadId: string): string | undefined {
    const row = this.db
      .prepare('SELECT taskId FROM task_threads WHERE threadId=? LIMIT 1')
      .get(threadId);
    return typeof row?.taskId === 'string' ? row.taskId : undefined;
  }
  /** The Dot whose conversation a task runs in. */
  taskDot(taskId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT b.dotId FROM task_threads t JOIN thread_bindings b ON b.id=t.threadId
         WHERE t.taskId=? AND b.ownerId=?`,
      )
      .get(taskId, this.ownerId);
    return typeof row?.dotId === 'string' ? row.dotId : undefined;
  }
  taskThread(taskId: string): string | undefined {
    const row = this.db
      .prepare('SELECT threadId FROM task_threads WHERE taskId=?')
      .get(taskId);
    return typeof row?.threadId === 'string' ? row.threadId : undefined;
  }
  calls(threadId?: string): CallReceipt[] {
    if (threadId) this.requireThread(threadId);
    return this.db
      .prepare(
        `SELECT * FROM calls ${threadId ? 'WHERE threadId=?' : ''} ORDER BY startedAt DESC`,
      )
      .all(...(threadId ? [threadId] : [])) as unknown as CallReceipt[];
  }
  createCall(threadId: string): CallReceipt {
    this.requireThread(threadId);
    const call: CallReceipt = {
      id: randomUUID(),
      threadId,
      startedAt: Date.now(),
      endedAt: null,
      status: 'connecting',
      transcript: '',
      error: null,
    };
    this.db
      .prepare(
        'INSERT INTO calls(id, threadId, startedAt, endedAt, status, transcript, error) VALUES (?, ?, ?, NULL, ?, ?, NULL)',
      )
      .run(call.id, threadId, call.startedAt, call.status, '');
    return call;
  }
  call(id: string): CallReceipt {
    const call = this.calls().find((call) => call.id === id);
    if (!call) throw new Error('Call not found.');
    this.requireThread(call.threadId);
    return call;
  }
  setCall(
    id: string,
    status: CallReceipt['status'],
    transcript: string,
    error: string | null = null,
  ) {
    const call = this.call(id);
    if (call.endedAt) return call;
    this.db
      .prepare(
        'UPDATE calls SET status=?, transcript=?, error=?, endedAt=? WHERE id=?',
      )
      .run(
        status,
        transcript,
        error,
        status === 'ended' || status === 'failed' ? Date.now() : null,
        id,
      );
    return this.call(id);
  }
  saveLateTranscript(id: string, transcript: string) {
    this.call(id);
    return (
      this.db
        .prepare(
          "UPDATE calls SET transcript=? WHERE id=? AND transcript='' AND endedAt IS NOT NULL",
        )
        .run(transcript, id).changes > 0
    );
  }
  anchorCall(id: string, anchor: string | undefined) {
    this.call(id);
    this.db
      .prepare('UPDATE calls SET anchorMessageId=? WHERE id=?')
      .run(anchor ?? null, id);
  }
  setCallError(id: string, error: string | null) {
    this.call(id);
    this.db.prepare('UPDATE calls SET error=? WHERE id=?').run(error, id);
  }
  saveCapture(threadId: string, value: unknown) {
    this.requireThread(threadId);
    this.db
      .prepare(
        'INSERT INTO captures VALUES (?, ?) ON CONFLICT(threadId) DO UPDATE SET value=excluded.value',
      )
      .run(threadId, JSON.stringify(value));
  }
  capture(threadId: string): unknown {
    this.requireThread(threadId);
    const row = this.db
      .prepare('SELECT value FROM captures WHERE threadId=?')
      .get(threadId);
    return typeof row?.value === 'string' ? JSON.parse(row.value) : null;
  }
}
