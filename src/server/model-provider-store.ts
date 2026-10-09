import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ModelPresetId,
  ModelProviderKeyKind,
  ModelProviderView,
} from '../shared/model-presets.js';
import { open, seal } from './connector-crypto.js';

export const MODEL_PROVIDER_SCHEMA = `CREATE TABLE IF NOT EXISTS model_providers(
  id TEXT PRIMARY KEY, presetId TEXT NOT NULL, name TEXT NOT NULL,
  baseUrl TEXT NOT NULL, keyKind TEXT NOT NULL CHECK(keyKind IN ('stored','env','none')),
  keySealed TEXT, keyLast4 TEXT, keyEnvName TEXT, extra TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
  lastTestedAt INTEGER, lastError TEXT);
CREATE TABLE IF NOT EXISTS model_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);`;

/** The id of the virtual provider built from `.env`; never stored. */
export const ENV_PROVIDER_ID = 'env';
/** `lastError` is capped at this many characters (as ERROR_MAX in connector-oauth.ts). */
export const LAST_ERROR_MAX = 200;
/** Shown in place of `lastError` when a stored key no longer decrypts. */
export const KEY_UNREADABLE_ERROR =
  'The stored API key could not be decrypted. Enter it again.';

const DEFAULT_MODEL_KEY = 'defaultModel';
const EXTRA_VALUE_MAX = 200;

/** Provider-specific values (today only the Anthropic workspace id). */
export type ModelProviderExtra = { anthropicWorkspaceId?: string };

/** How a provider's key is supplied. Env references store only the variable name. */
export type ModelProviderKeyInput =
  | { kind: 'stored'; value: string }
  | { kind: 'env'; envName: string }
  | { kind: 'none' };

/**
 * A provider row as the server sees it. `key.set` is exact for `stored` (the ciphertext opens)
 * and `none`; for `env` the store cannot know, so it is false and the registry fills it in.
 */
export interface ModelProviderRecord extends Omit<
  ModelProviderView,
  'builtIn'
> {
  extra: ModelProviderExtra;
}

export interface NewModelProvider {
  presetId: ModelPresetId;
  name: string;
  baseUrl: string;
  key: ModelProviderKeyInput;
  extra?: ModelProviderExtra;
  enabled?: boolean;
}

export interface ModelProviderPatch {
  name?: string;
  baseUrl?: string;
  /** `stored` replaces the key, `none` or `env` clear a stored one. */
  key?: ModelProviderKeyInput;
  extra?: ModelProviderExtra;
  enabled?: boolean;
}

/** The workspace-wide default: a plain model id plus the provider that serves it. */
export interface DefaultModelSetting {
  providerId: string;
  model: string;
}

export interface ModelProviderStoreOptions {
  now?: () => number;
}

type Row = Record<string, unknown>;

const aad = (id: string) => `${id}:apiKey`;

function cap(text: string): string {
  return text.length > LAST_ERROR_MAX
    ? `${text.slice(0, LAST_ERROR_MAX - 1)}…`
    : text;
}

function parseExtra(text: unknown): ModelProviderExtra {
  try {
    const value: unknown = JSON.parse(String(text));
    return cleanExtra(value);
  } catch {
    return {};
  }
}

function cleanExtra(value: unknown): ModelProviderExtra {
  if (!value || typeof value !== 'object') return {};
  const raw = (value as Record<string, unknown>).anthropicWorkspaceId;
  const id =
    typeof raw === 'string' ? raw.trim().slice(0, EXTRA_VALUE_MAX) : '';
  return id ? { anthropicWorkspaceId: id } : {};
}

function cleanEnvName(name: string): string {
  if (!/^[A-Z_][A-Z0-9_]{0,99}$/.test(name))
    throw new Error('Invalid environment variable name');
  return name;
}

export class ModelProviderStore {
  private readonly now: () => number;

  constructor(
    private db: DatabaseSync,
    private key: Buffer,
    options: ModelProviderStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    db.exec(MODEL_PROVIDER_SCHEMA);
  }

  list(): ModelProviderRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM model_providers ORDER BY createdAt, rowid')
        .all() as Row[]
    ).map((row) => this.toRecord(row));
  }

  get(id: string): ModelProviderRecord | undefined {
    const row = this.row(id);
    return row ? this.toRecord(row) : undefined;
  }

  /** True when another provider already uses `name` (case-insensitive). */
  nameTaken(name: string, exceptId?: string): boolean {
    const wanted = name.trim().toLowerCase();
    return (
      this.db.prepare('SELECT id, name FROM model_providers').all() as Row[]
    ).some(
      (row) =>
        row.id !== exceptId && String(row.name).trim().toLowerCase() === wanted,
    );
  }

  create(input: NewModelProvider): ModelProviderRecord {
    const id = randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO model_providers(id, presetId, name, baseUrl, keyKind, keySealed, keyLast4, keyEnvName, extra, enabled, createdAt, updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.presetId,
        input.name,
        input.baseUrl,
        ...this.keyColumns(id, input.key),
        JSON.stringify(cleanExtra(input.extra)),
        input.enabled === false ? 0 : 1,
        now,
        now,
      );
    return this.get(id)!;
  }

  /** Returns undefined when the id does not exist. Dropping a stored key deletes its ciphertext. */
  update(
    id: string,
    patch: ModelProviderPatch,
  ): ModelProviderRecord | undefined {
    const row = this.row(id);
    if (!row) return undefined;
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const set = (column: string, value: string | number | null) => {
      sets.push(`${column}=?`);
      values.push(value);
    };
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.baseUrl !== undefined) set('baseUrl', patch.baseUrl);
    if (patch.extra !== undefined)
      set('extra', JSON.stringify(cleanExtra(patch.extra)));
    if (patch.enabled !== undefined) set('enabled', patch.enabled ? 1 : 0);
    if (patch.key !== undefined) {
      const [kind, sealed, last4, envName] = this.keyColumns(id, patch.key);
      set('keyKind', kind);
      set('keySealed', sealed);
      set('keyLast4', last4);
      set('keyEnvName', envName);
      // A new key or a changed endpoint invalidates the last test result.
      set('lastTestedAt', null);
      set('lastError', null);
    }
    if (patch.baseUrl !== undefined && patch.key === undefined) {
      set('lastTestedAt', null);
      set('lastError', null);
    }
    // Strictly increasing so caches keyed on updatedAt notice two edits in one millisecond.
    set('updatedAt', Math.max(this.now(), Number(row.updatedAt) + 1));
    this.db
      .prepare(`UPDATE model_providers SET ${sets.join(', ')} WHERE id=?`)
      .run(...values, id);
    return this.get(id);
  }

  delete(id: string): boolean {
    return (
      Number(
        this.db.prepare('DELETE FROM model_providers WHERE id=?').run(id)
          .changes,
      ) > 0
    );
  }

  /**
   * The plaintext key of a stored provider; undefined when none is stored or it no longer
   * decrypts (wrong key file, tampering). Only the registry should call this.
   */
  readKey(id: string): string | undefined {
    const row = this.row(id);
    if (!row || row.keyKind !== 'stored' || typeof row.keySealed !== 'string')
      return undefined;
    return open(this.key, row.keySealed, aad(id));
  }

  /** Records a test result. `error` is capped; callers must redact it first. Leaves updatedAt alone. */
  setStatus(
    id: string,
    status: { lastTestedAt: number | null; lastError: string | null },
  ): void {
    this.db
      .prepare(
        'UPDATE model_providers SET lastTestedAt=?, lastError=? WHERE id=?',
      )
      .run(
        status.lastTestedAt,
        status.lastError === null ? null : cap(status.lastError),
        id,
      );
  }

  getDefaultModel(): DefaultModelSetting | undefined {
    const row = this.db
      .prepare('SELECT value FROM model_settings WHERE key=?')
      .get(DEFAULT_MODEL_KEY) as Row | undefined;
    if (!row) return undefined;
    try {
      const value = JSON.parse(
        String(row.value),
      ) as Partial<DefaultModelSetting>;
      return typeof value.providerId === 'string' &&
        typeof value.model === 'string' &&
        value.providerId &&
        value.model
        ? { providerId: value.providerId, model: value.model }
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** `undefined` clears the default (falls back to .env). */
  setDefaultModel(value: DefaultModelSetting | undefined): void {
    if (!value) {
      this.db
        .prepare('DELETE FROM model_settings WHERE key=?')
        .run(DEFAULT_MODEL_KEY);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO model_settings(key, value) VALUES (?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(
        DEFAULT_MODEL_KEY,
        JSON.stringify({ providerId: value.providerId, model: value.model }),
      );
  }

  private row(id: string): Row | undefined {
    return this.db
      .prepare('SELECT * FROM model_providers WHERE id=?')
      .get(id) as Row | undefined;
  }

  /** `[keyKind, keySealed, keyLast4, keyEnvName]` for an input. */
  private keyColumns(
    id: string,
    key: ModelProviderKeyInput,
  ): [ModelProviderKeyKind, string | null, string | null, string | null] {
    if (key.kind === 'stored') {
      const value = key.value.trim();
      if (!value) throw new Error('The API key is empty');
      return ['stored', seal(this.key, value, aad(id)), value.slice(-4), null];
    }
    if (key.kind === 'env')
      return ['env', null, null, cleanEnvName(key.envName)];
    return ['none', null, null, null];
  }

  private toRecord(row: Row): ModelProviderRecord {
    const id = String(row.id);
    const kind = String(row.keyKind) as ModelProviderKeyKind;
    const readable =
      kind === 'stored' &&
      typeof row.keySealed === 'string' &&
      open(this.key, row.keySealed, aad(id)) !== undefined;
    const unreadable = kind === 'stored' && !readable;
    const text = (value: unknown) =>
      typeof value === 'string' && value ? value : undefined;
    return {
      id,
      presetId: String(row.presetId) as ModelPresetId,
      name: String(row.name),
      baseUrl: String(row.baseUrl),
      key: {
        kind,
        set: readable,
        ...(readable && text(row.keyLast4)
          ? { last4: text(row.keyLast4)! }
          : {}),
        ...(kind === 'env' && text(row.keyEnvName)
          ? { envName: text(row.keyEnvName)! }
          : {}),
      },
      extra: parseExtra(row.extra),
      enabled: Number(row.enabled) === 1,
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
      lastTestedAt:
        typeof row.lastTestedAt === 'number' ? row.lastTestedAt : null,
      lastError: unreadable
        ? KEY_UNREADABLE_ERROR
        : typeof row.lastError === 'string'
          ? row.lastError
          : null,
    };
  }
}
