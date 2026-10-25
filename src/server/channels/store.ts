import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { ActionSnapshot, ActionStore } from '@copilotkit/channels-core';
import { loadConnectorKey, open, seal } from '../connector-crypto.js';
import type {
  ChannelInput,
  ChannelProvider,
  ChannelSettings,
} from '../../shared/channels.js';

export interface ChannelThread {
  id: string;
  provider: ChannelProvider;
  revision: number;
  conversationKey: string;
  dotId: string;
  target: unknown;
}
export interface Outgoing {
  id: string;
  threadId: string;
  nodes: unknown;
  attempts: number;
  nextAt: number;
}

export class ChannelStore implements ActionStore {
  readonly db: DatabaseSync;
  private key: Buffer;
  constructor(
    path: string,
    key = loadConnectorKey({ env: process.env, databasePath: path }),
  ) {
    this.key = key;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS channel_settings(provider TEXT PRIMARY KEY, value TEXT NOT NULL, botToken TEXT, appToken TEXT);
      CREATE TABLE IF NOT EXISTS channel_threads(id TEXT PRIMARY KEY, provider TEXT NOT NULL, revision INTEGER NOT NULL, conversationKey TEXT NOT NULL, dotId TEXT NOT NULL, target TEXT NOT NULL, UNIQUE(provider,revision,conversationKey));
      CREATE TABLE IF NOT EXISTS channel_ingress(provider TEXT NOT NULL, revision INTEGER NOT NULL, eventId TEXT NOT NULL, PRIMARY KEY(provider,revision,eventId));
      CREATE TABLE IF NOT EXISTS channel_actions(id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_outbox(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, nodes TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS channel_approvals(approvalId TEXT PRIMARY KEY);`);
  }
  close() {
    this.db.close();
  }
  settings(provider: ChannelProvider): ChannelSettings {
    const row = this.db
      .prepare('SELECT * FROM channel_settings WHERE provider=?')
      .get(provider);
    const stored = row
      ? (JSON.parse(String(row.value)) as ChannelSettings)
      : undefined;
    return {
      provider,
      enabled: false,
      dotId: '',
      workspaceId: '',
      ownerUserIds: [],
      chatId: '',
      revision: 0,
      ignored: 0,
      ...stored,
      botTokenSet: !!row?.botToken,
      appTokenSet: !!row?.appToken,
      status: 'disabled',
      failure: null,
    };
  }
  credentials(provider: ChannelProvider) {
    const row = this.db
      .prepare(
        'SELECT botToken,appToken FROM channel_settings WHERE provider=?',
      )
      .get(provider);
    const read = (column: string) =>
      row?.[column]
        ? open(this.key, String(row[column]), `channel:${provider}:${column}`)
        : undefined;
    return { botToken: read('botToken'), appToken: read('appToken') };
  }
  configure(provider: ChannelProvider, input: ChannelInput) {
    const before = this.settings(provider);
    const row = this.db
      .prepare(
        'SELECT botToken,appToken FROM channel_settings WHERE provider=?',
      )
      .get(provider);
    const token = (column: 'botToken' | 'appToken') =>
      input[column] === undefined
        ? (row?.[column] ?? null)
        : input[column] === null
          ? null
          : seal(this.key, input[column], `channel:${provider}:${column}`);
    const { botToken: _bot, appToken: _app, ...fields } = input;
    void _bot;
    void _app;
    this.db
      .prepare(
        `INSERT INTO channel_settings VALUES(?,?,?,?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value,botToken=excluded.botToken,appToken=excluded.appToken`,
      )
      .run(
        provider,
        JSON.stringify({ ...before, ...fields, revision: before.revision + 1 }),
        token('botToken'),
        token('appToken'),
      );
    return this.settings(provider);
  }
  ignored(provider: ChannelProvider) {
    const settings = this.settings(provider);
    const row = this.db
      .prepare('SELECT value FROM channel_settings WHERE provider=?')
      .get(provider);
    if (row)
      this.db
        .prepare('UPDATE channel_settings SET value=? WHERE provider=?')
        .run(
          JSON.stringify({
            ...JSON.parse(String(row.value)),
            ignored: settings.ignored + 1,
          }),
          provider,
        );
    return settings.ignored + 1;
  }
  thread(
    provider: ChannelProvider,
    revision: number,
    key: string,
  ): ChannelThread | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM channel_threads WHERE provider=? AND revision=? AND conversationKey=?',
      )
      .get(provider, revision, key);
    return row ? this.readThread(row) : undefined;
  }
  byThread(id: string): ChannelThread | undefined {
    const row = this.db
      .prepare('SELECT * FROM channel_threads WHERE id=?')
      .get(id);
    return row ? this.readThread(row) : undefined;
  }
  private readThread(row: Record<string, unknown>): ChannelThread {
    return {
      ...row,
      target: JSON.parse(String(row.target)),
    } as unknown as ChannelThread;
  }
  bind(thread: ChannelThread) {
    this.db
      .prepare('INSERT INTO channel_threads VALUES(?,?,?,?,?,?)')
      .run(
        thread.id,
        thread.provider,
        thread.revision,
        thread.conversationKey,
        thread.dotId,
        JSON.stringify(thread.target),
      );
  }
  accept(
    provider: ChannelProvider,
    revision: number,
    eventId: string,
  ): boolean {
    return (
      this.db
        .prepare('INSERT OR IGNORE INTO channel_ingress VALUES(?,?,?)')
        .run(provider, revision, eventId).changes === 1
    );
  }
  async put(id: string, snapshot: ActionSnapshot, ttlMs = 86400_000) {
    this.db
      .prepare('INSERT OR REPLACE INTO channel_actions VALUES(?,?,?)')
      .run(id, JSON.stringify(snapshot), Date.now() + ttlMs);
  }
  async get(id: string): Promise<ActionSnapshot | undefined> {
    const row = this.db
      .prepare(
        'SELECT snapshot FROM channel_actions WHERE id=? AND expiresAt>?',
      )
      .get(id, Date.now());
    return row
      ? (JSON.parse(String(row.snapshot)) as ActionSnapshot)
      : undefined;
  }
  async consume(id: string): Promise<ActionSnapshot | undefined> {
    const row = this.db
      .prepare('DELETE FROM channel_actions WHERE id=? RETURNING *')
      .get(id);
    return row && Number(row.expiresAt) > Date.now()
      ? (JSON.parse(String(row.snapshot)) as ActionSnapshot)
      : undefined;
  }
  async delete(id: string) {
    this.db.prepare('DELETE FROM channel_actions WHERE id=?').run(id);
  }
  enqueue(threadId: string, nodes: unknown, id: string = randomUUID()) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO channel_outbox(id,threadId,nodes) VALUES(?,?,?)',
      )
      .run(id, threadId, JSON.stringify(nodes));
  }
  pending(): Outgoing[] {
    return this.db
      .prepare(
        `SELECT c.* FROM channel_outbox c WHERE c.sent=0 AND c.attempts<5 AND c.nextAt<=?
      AND NOT EXISTS(SELECT 1 FROM channel_outbox older WHERE older.threadId=c.threadId AND older.rowid<c.rowid AND older.sent=0) ORDER BY c.rowid LIMIT 100`,
      )
      .all(Date.now())
      .map(
        (row) =>
          ({
            ...row,
            nodes: JSON.parse(String(row.nodes)),
          }) as unknown as Outgoing,
      );
  }
  sent(id: string) {
    this.db.prepare('UPDATE channel_outbox SET sent=1 WHERE id=?').run(id);
  }
  retry(id: string, attempts: number) {
    this.db
      .prepare(
        'UPDATE channel_outbox SET attempts=attempts+1,nextAt=? WHERE id=?',
      )
      .run(Date.now() + Math.min(60_000, 1000 * 2 ** attempts), id);
  }
  hasApproval(id: string) {
    return !!this.db
      .prepare('SELECT 1 FROM channel_approvals WHERE approvalId=?')
      .get(id);
  }
  markApproval(id: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO channel_approvals VALUES(?)')
      .run(id);
  }
}
