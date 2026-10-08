import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { CONNECTOR_AUTH_SCHEMA } from './connector-auth-store.js';
import type {
  Connector,
  ConnectorConfig,
  ConnectorValue,
  DotConnectorGrant,
  ToolOverride,
} from '../shared/types.js';

type Row = Record<string, unknown>;

function toConnector(row: Row): Connector {
  return {
    id: String(row.id),
    name: String(row.name),
    transport: row.transport as Connector['transport'],
    url: row.url === null ? null : String(row.url),
    command: row.command === null ? null : String(row.command),
    args: JSON.parse(String(row.args)) as string[],
    cwd: row.cwd === null ? null : String(row.cwd),
    headers: JSON.parse(String(row.headers)) as Record<string, ConnectorValue>,
    env: JSON.parse(String(row.env)) as Record<string, ConnectorValue>,
    callTimeoutMs: Number(row.callTimeoutMs),
    enabled: Number(row.enabled) === 1,
    presetId: row.presetId === null ? null : String(row.presetId),
    auth: row.auth as Connector['auth'],
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function toGrant(row: Row): DotConnectorGrant {
  return {
    dotId: String(row.dotId),
    connectorId: String(row.connectorId),
    tools: JSON.parse(String(row.tools)) as DotConnectorGrant['tools'],
    overrides: JSON.parse(String(row.overrides)) as Record<
      string,
      ToolOverride
    >,
  };
}

/** New connectors: `token` when an Authorization header is configured, else `none`. */
function defaultAuth(headers: ConnectorConfig['headers']): Connector['auth'] {
  return Object.keys(headers ?? {}).some(
    (name) => name.toLowerCase() === 'authorization',
  )
    ? 'token'
    : 'none';
}

function mapUnique(error: unknown): never {
  if (error instanceof Error && /UNIQUE/i.test(error.message))
    throw new Error('A connector with that name exists.');
  throw error;
}

export class ConnectorStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS connectors(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, transport TEXT NOT NULL,
  url TEXT, command TEXT, args TEXT NOT NULL DEFAULT '[]', cwd TEXT, headers TEXT NOT NULL DEFAULT '{}', env TEXT NOT NULL DEFAULT '{}',
  callTimeoutMs INTEGER NOT NULL DEFAULT 30000, enabled INTEGER NOT NULL DEFAULT 1, presetId TEXT,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS dot_connectors(dotId TEXT NOT NULL, connectorId TEXT NOT NULL,
  tools TEXT NOT NULL DEFAULT '"*"', overrides TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(dotId, connectorId));`);
    // SQLite has no ADD COLUMN IF NOT EXISTS; existing rows keep today's behaviour ('token').
    if (
      !db
        .prepare('PRAGMA table_info(connectors)')
        .all()
        .some((field) => field.name === 'auth')
    )
      db.exec(
        "ALTER TABLE connectors ADD COLUMN auth TEXT NOT NULL DEFAULT 'token'",
      );
    db.exec(CONNECTOR_AUTH_SCHEMA);
  }

  list(): Connector[] {
    return this.db
      .prepare('SELECT * FROM connectors ORDER BY createdAt, rowid')
      .all()
      .map((row) => toConnector(row));
  }

  get(id: string): Connector | undefined {
    const row = this.db.prepare('SELECT * FROM connectors WHERE id=?').get(id);
    return row ? toConnector(row) : undefined;
  }

  create(config: ConnectorConfig): Connector {
    const id = randomUUID();
    const now = Date.now();
    try {
      this.db
        .prepare(
          'INSERT INTO connectors(id,name,transport,url,command,args,cwd,headers,env,callTimeoutMs,enabled,presetId,auth,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          config.name,
          config.transport,
          config.url ?? null,
          config.command ?? null,
          JSON.stringify(config.args ?? []),
          config.cwd ?? null,
          JSON.stringify(config.headers ?? {}),
          JSON.stringify(config.env ?? {}),
          config.callTimeoutMs ?? 30_000,
          (config.enabled ?? true) ? 1 : 0,
          config.presetId ?? null,
          config.auth ?? defaultAuth(config.headers),
          now,
          now,
        );
    } catch (error) {
      mapUnique(error);
    }
    return this.get(id)!;
  }

  update(id: string, patch: Partial<ConnectorConfig>): Connector {
    const current = this.get(id);
    if (!current) throw new Error('Connector not found.');
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as Partial<ConnectorConfig>;
    const next = {
      name: defined.name ?? current.name,
      transport: defined.transport ?? current.transport,
      url: 'url' in defined ? (defined.url ?? null) : current.url,
      command:
        'command' in defined ? (defined.command ?? null) : current.command,
      args: defined.args ?? current.args,
      cwd: 'cwd' in defined ? (defined.cwd ?? null) : current.cwd,
      headers: defined.headers ?? current.headers,
      env: defined.env ?? current.env,
      callTimeoutMs: defined.callTimeoutMs ?? current.callTimeoutMs,
      enabled: defined.enabled ?? current.enabled,
      presetId:
        'presetId' in defined ? (defined.presetId ?? null) : current.presetId,
      auth: defined.auth ?? current.auth,
    };
    try {
      this.db
        .prepare(
          'UPDATE connectors SET name=?,transport=?,url=?,command=?,args=?,cwd=?,headers=?,env=?,callTimeoutMs=?,enabled=?,presetId=?,auth=?,updatedAt=? WHERE id=?',
        )
        .run(
          next.name,
          next.transport,
          next.url,
          next.command,
          JSON.stringify(next.args),
          next.cwd,
          JSON.stringify(next.headers),
          JSON.stringify(next.env),
          next.callTimeoutMs,
          next.enabled ? 1 : 0,
          next.presetId,
          next.auth,
          Math.max(Date.now(), current.updatedAt + 1),
          id,
        );
    } catch (error) {
      mapUnique(error);
    }
    return this.get(id)!;
  }

  delete(id: string): boolean {
    this.db.prepare('DELETE FROM connector_auth WHERE connectorId=?').run(id);
    this.db.prepare('DELETE FROM dot_connectors WHERE connectorId=?').run(id);
    return (
      Number(
        this.db.prepare('DELETE FROM connectors WHERE id=?').run(id).changes,
      ) > 0
    );
  }

  grants(dotId: string): DotConnectorGrant[] {
    return this.db
      .prepare(
        'SELECT * FROM dot_connectors WHERE dotId=? ORDER BY connectorId',
      )
      .all(dotId)
      .map((row) => toGrant(row));
  }

  grant(dotId: string, connectorId: string): DotConnectorGrant | undefined {
    const row = this.db
      .prepare('SELECT * FROM dot_connectors WHERE dotId=? AND connectorId=?')
      .get(dotId, connectorId);
    return row ? toGrant(row) : undefined;
  }

  setGrant(
    dotId: string,
    connectorId: string,
    tools: '*' | string[],
    overrides: Record<string, ToolOverride> = {},
  ): DotConnectorGrant {
    this.db
      .prepare(
        'INSERT INTO dot_connectors(dotId,connectorId,tools,overrides) VALUES (?,?,?,?) ON CONFLICT(dotId,connectorId) DO UPDATE SET tools=excluded.tools, overrides=excluded.overrides',
      )
      .run(
        dotId,
        connectorId,
        JSON.stringify(tools),
        JSON.stringify(overrides),
      );
    return this.grant(dotId, connectorId)!;
  }

  revoke(dotId: string, connectorId: string): boolean {
    return (
      Number(
        this.db
          .prepare('DELETE FROM dot_connectors WHERE dotId=? AND connectorId=?')
          .run(dotId, connectorId).changes,
      ) > 0
    );
  }

  /** SHA-256 of the Dot's grants + enabled flags of their connectors; changes on any grant or enable/disable. */
  grantHash(dotId: string): string {
    const payload = this.grants(dotId).map((grant) => ({
      ...grant,
      enabled: this.get(grant.connectorId)?.enabled ?? false,
    }));
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }
}
