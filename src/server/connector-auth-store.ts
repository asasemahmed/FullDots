import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { open, seal } from './connector-crypto.js';

export const CONNECTOR_AUTH_SCHEMA = `CREATE TABLE IF NOT EXISTS connector_auth(
  connectorId TEXT PRIMARY KEY,
  redirectUrl TEXT NOT NULL DEFAULT '',
  discovery TEXT,
  clientInfo TEXT,
  tokens TEXT,
  pendingStateHash TEXT,
  pendingVerifier TEXT,
  pendingExpiresAt INTEGER,
  authorizedAt INTEGER, expiresAt INTEGER, scope TEXT,
  updatedAt INTEGER NOT NULL);`;

export const PENDING_TTL_MS = 10 * 60 * 1000;

export type ConnectorAuthClearScope =
  'all' | 'client' | 'tokens' | 'verifier' | 'discovery';

/** Decrypted view of a row. JSON fields are `unknown`: callers cast to the SDK types. */
export interface ConnectorAuthRecord {
  connectorId: string;
  /** Redirect URL the stored client registration was made with; undefined when none recorded. */
  redirectUrl: string | undefined;
  discovery: unknown;
  clientInfo: unknown;
  tokens: unknown;
  /** True while an unexpired pending authorization exists. The verifier is never exposed here. */
  pending: boolean;
  /** authorizedAt/expiresAt/scope are only reported while the tokens decrypt. */
  authorizedAt: number | undefined;
  expiresAt: number | undefined;
  scope: string | undefined;
  updatedAt: number;
}

type Row = Record<string, unknown>;

/** SHA-256 hex of the raw OAuth `state`; this is what is stored and what `takePending` takes. */
export function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

const aad = (connectorId: string, column: string) => `${connectorId}:${column}`;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export class ConnectorAuthStore {
  constructor(
    private db: DatabaseSync,
    private key: Buffer,
  ) {
    db.exec(CONNECTOR_AUTH_SCHEMA);
  }

  private sealJson(id: string, column: string, value: object): string {
    return seal(this.key, JSON.stringify(value), aad(id, column));
  }

  private openJson(id: string, column: string, value: unknown): unknown {
    if (typeof value !== 'string') return undefined;
    const text = open(this.key, value, aad(id, column));
    return text === undefined ? undefined : parseJson(text);
  }

  private upsert(
    id: string,
    values: Record<string, string | number | null>,
    now: number,
  ): void {
    const columns = Object.keys(values);
    const assignments = columns.map((column) => `${column}=excluded.${column}`);
    this.db
      .prepare(
        `INSERT INTO connector_auth(connectorId,${columns.join(',')},updatedAt) VALUES (?,${columns.map(() => '?').join(',')},?)
         ON CONFLICT(connectorId) DO UPDATE SET ${assignments.join(',')},updatedAt=excluded.updatedAt`,
      )
      .run(id, ...columns.map((column) => values[column]!), now);
  }

  get(id: string, now = Date.now()): ConnectorAuthRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM connector_auth WHERE connectorId=?')
      .get(id) as Row | undefined;
    if (!row) return undefined;
    const tokens = this.openJson(id, 'tokens', row.tokens);
    const num = (value: unknown) =>
      typeof value === 'number' ? value : undefined;
    return {
      connectorId: id,
      redirectUrl: row.redirectUrl ? String(row.redirectUrl) : undefined,
      discovery: row.discovery ? parseJson(String(row.discovery)) : undefined,
      clientInfo: this.openJson(id, 'clientInfo', row.clientInfo),
      tokens,
      pending:
        row.pendingStateHash !== null && (num(row.pendingExpiresAt) ?? 0) > now,
      authorizedAt: tokens === undefined ? undefined : num(row.authorizedAt),
      expiresAt: tokens === undefined ? undefined : num(row.expiresAt),
      scope:
        tokens === undefined || typeof row.scope !== 'string'
          ? undefined
          : row.scope,
      updatedAt: Number(row.updatedAt),
    };
  }

  saveDiscovery(id: string, discovery: object, now = Date.now()): void {
    this.upsert(id, { discovery: JSON.stringify(discovery) }, now);
  }

  /** `redirectUrl`, when given, records the redirect URL this registration was made with. */
  saveClientInfo(
    id: string,
    info: object,
    redirectUrl?: string,
    now = Date.now(),
  ): void {
    this.upsert(
      id,
      {
        clientInfo: this.sealJson(id, 'clientInfo', info),
        ...(redirectUrl === undefined ? {} : { redirectUrl }),
      },
      now,
    );
  }

  /** Also records authorizedAt (kept across refreshes), expiresAt (from `expires_in`) and scope. */
  saveTokens(id: string, tokens: object, now = Date.now()): void {
    const fields = tokens as { expires_in?: unknown; scope?: unknown };
    const existing = this.db
      .prepare(
        'SELECT authorizedAt FROM connector_auth WHERE connectorId=? AND tokens IS NOT NULL',
      )
      .get(id) as Row | undefined;
    this.upsert(
      id,
      {
        tokens: this.sealJson(id, 'tokens', tokens),
        authorizedAt:
          typeof existing?.authorizedAt === 'number'
            ? existing.authorizedAt
            : now,
        expiresAt:
          typeof fields.expires_in === 'number'
            ? now + fields.expires_in * 1000
            : null,
        scope: typeof fields.scope === 'string' ? fields.scope : null,
      },
      now,
    );
  }

  /** Overwrites any earlier pending flow: only the latest `state` is valid. `state` is stored as SHA-256 hex. */
  beginPending(
    id: string,
    redirectUrl: string,
    verifier: string,
    state: string,
    ttlMs = PENDING_TTL_MS,
    now = Date.now(),
  ): void {
    this.upsert(
      id,
      {
        redirectUrl,
        pendingStateHash: hashState(state),
        pendingVerifier: seal(this.key, verifier, aad(id, 'pendingVerifier')),
        pendingExpiresAt: now + ttlMs,
      },
      now,
    );
  }

  /**
   * Single use. RETURNING reports the updated row, so the pending columns are
   * read first and then cleared with a conditional UPDATE; only the caller
   * whose UPDATE changes the row wins, even across processes. Expired or
   * undecryptable pendings return undefined (and are cleared).
   */
  takePending(
    stateHash: string,
    now = Date.now(),
  ): { connectorId: string; verifier: string } | undefined {
    const row = this.db
      .prepare(
        'SELECT connectorId, pendingVerifier, pendingExpiresAt FROM connector_auth WHERE pendingStateHash=?',
      )
      .get(stateHash) as Row | undefined;
    if (!row) return undefined;
    const taken = this.db
      .prepare(
        `UPDATE connector_auth SET pendingStateHash=NULL, pendingVerifier=NULL, pendingExpiresAt=NULL
         WHERE pendingStateHash=?`,
      )
      .run(stateHash);
    if (Number(taken.changes) !== 1 || Number(row.pendingExpiresAt) <= now)
      return undefined;
    const connectorId = String(row.connectorId);
    const verifier = open(
      this.key,
      String(row.pendingVerifier),
      aad(connectorId, 'pendingVerifier'),
    );
    return verifier === undefined ? undefined : { connectorId, verifier };
  }

  /** Mirrors the SDK's `invalidateCredentials` scopes. `all` removes the row. */
  clear(id: string, scope: ConnectorAuthClearScope, now = Date.now()): void {
    if (scope === 'all') {
      this.delete(id);
      return;
    }
    const sets: Record<Exclude<ConnectorAuthClearScope, 'all'>, string> = {
      client: "clientInfo=NULL, redirectUrl=''",
      tokens: 'tokens=NULL, authorizedAt=NULL, expiresAt=NULL, scope=NULL',
      verifier:
        'pendingStateHash=NULL, pendingVerifier=NULL, pendingExpiresAt=NULL',
      discovery: 'discovery=NULL',
    };
    this.db
      .prepare(
        `UPDATE connector_auth SET ${sets[scope]}, updatedAt=? WHERE connectorId=?`,
      )
      .run(now, id);
  }

  delete(id: string): boolean {
    return (
      Number(
        this.db
          .prepare('DELETE FROM connector_auth WHERE connectorId=?')
          .run(id).changes,
      ) > 0
    );
  }

  /** Drops expired pending flows; returns how many. */
  sweep(now = Date.now()): number {
    return Number(
      this.db
        .prepare(
          `UPDATE connector_auth SET pendingStateHash=NULL, pendingVerifier=NULL, pendingExpiresAt=NULL
           WHERE pendingStateHash IS NOT NULL AND pendingExpiresAt <= ?`,
        )
        .run(now).changes,
    );
  }

  hasTokens(id: string): boolean {
    const row = this.db
      .prepare('SELECT tokens FROM connector_auth WHERE connectorId=?')
      .get(id) as Row | undefined;
    return this.openJson(id, 'tokens', row?.tokens) !== undefined;
  }
}
