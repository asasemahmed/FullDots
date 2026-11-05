// Where Dot computers run, and the secrets FullDots made for each of the owner's servers. Only the
// ssh alias is stored about a server: no key, password or passphrase. The supervisor token and the
// computer master token of each server are generated here (or pasted by the owner) and stored
// sealed with the connector key; they leave the server process only to the owner's own server,
// over ssh on stdin, or once to the owner when they ask for the supervisor settings.
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { open, seal } from './connector-crypto.js';
import { requireAlias } from './remote-ssh.js';
import type { ComputerWhere } from '../shared/remote-computer-types.js';

export const REMOTE_SCHEMA = `CREATE TABLE IF NOT EXISTS remote_computer_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS remote_computer_servers(alias TEXT PRIMARY KEY, supervisorToken TEXT NOT NULL, computerToken TEXT NOT NULL, createdAt INTEGER NOT NULL);`;

const aad = (alias: string, column: string) => `remote:${alias}:${column}`;
/** What a pasted token must look like: long and free of anything a shell or env file reads. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

export interface RemoteSecrets {
  supervisorToken: string;
  computerToken: string;
}

export class UnreadableSecretsError extends Error {}

export class RemoteStore {
  private readonly db: DatabaseSync;
  constructor(
    db: DatabaseSync | string,
    private readonly key: Buffer,
  ) {
    this.db = typeof db === 'string' ? new DatabaseSync(db) : db;
    if (typeof db === 'string')
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec(REMOTE_SCHEMA);
    const columns = this.db
      .prepare('PRAGMA table_info(remote_computer_servers)')
      .all()
      .map((column) => (column as { name?: unknown }).name);
    // A random id written onto the supervisor, so two aliases for one server are noticed.
    if (!columns.includes('serverId'))
      this.db.exec(
        'ALTER TABLE remote_computer_servers ADD COLUMN serverId TEXT',
      );
    // When the owner last saw the supervisor settings; they are shown once per set of tokens.
    if (!columns.includes('revealedAt'))
      this.db.exec(
        'ALTER TABLE remote_computer_servers ADD COLUMN revealedAt INTEGER',
      );
  }

  private setting(key: string): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM remote_computer_settings WHERE key=?')
      .get(key) as { value?: unknown } | undefined;
    return typeof row?.value === 'string' ? row.value : undefined;
  }

  private put(key: string, value: string | undefined) {
    if (value === undefined)
      this.db
        .prepare('DELETE FROM remote_computer_settings WHERE key=?')
        .run(key);
    else
      this.db
        .prepare(
          'INSERT INTO remote_computer_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        )
        .run(key, value);
  }

  /** Where computers run by default: this machine (the default) or the owner's server. */
  defaults(): { where: ComputerWhere; alias?: string } {
    const where = this.setting('where') === 'remote' ? 'remote' : 'local';
    const alias = this.setting('alias');
    return { where, ...(alias ? { alias } : {}) };
  }

  setDefaults(where: ComputerWhere, alias: string | undefined) {
    if (alias !== undefined) requireAlias(alias);
    this.put('where', where);
    this.put('alias', alias);
  }

  private row(alias: string) {
    return this.db
      .prepare(
        'SELECT supervisorToken, computerToken, serverId, revealedAt FROM remote_computer_servers WHERE alias=?',
      )
      .get(alias) as
      | {
          supervisorToken: string;
          computerToken: string;
          serverId: string | null;
          revealedAt: number | null;
        }
      | undefined;
  }

  private write(alias: string, secrets: RemoteSecrets) {
    const serverId =
      this.row(alias)?.serverId ?? randomBytes(8).toString('hex');
    this.db
      .prepare(
        `INSERT INTO remote_computer_servers(alias,supervisorToken,computerToken,createdAt,serverId,revealedAt) VALUES (?,?,?,?,?,NULL)
         ON CONFLICT(alias) DO UPDATE SET supervisorToken=excluded.supervisorToken, computerToken=excluded.computerToken, revealedAt=NULL`,
      )
      .run(
        alias,
        seal(this.key, secrets.supervisorToken, aad(alias, 'supervisorToken')),
        seal(this.key, secrets.computerToken, aad(alias, 'computerToken')),
        Date.now(),
        serverId,
      );
    return secrets;
  }

  /** The server's secrets, made the first time the server is used. */
  secrets(alias: string): RemoteSecrets {
    requireAlias(alias);
    const row = this.row(alias);
    if (!row)
      return this.write(alias, {
        supervisorToken: randomBytes(32).toString('hex'),
        computerToken: randomBytes(32).toString('hex'),
      });
    const supervisorToken = open(
      this.key,
      row.supervisorToken,
      aad(alias, 'supervisorToken'),
    );
    const computerToken = open(
      this.key,
      row.computerToken,
      aad(alias, 'computerToken'),
    );
    if (supervisorToken && computerToken)
      return { supervisorToken, computerToken };
    throw new UnreadableSecretsError(
      `The stored tokens for ${alias} could not be decrypted (the connector key changed). Run Start the supervisor again, or Make new tokens in Settings → Computers.`,
    );
  }

  /** New tokens for a server. Its supervisor must be started again to use them. */
  reset(alias: string): RemoteSecrets {
    requireAlias(alias);
    return this.write(alias, {
      supervisorToken: randomBytes(32).toString('hex'),
      computerToken: randomBytes(32).toString('hex'),
    });
  }

  /** Tokens the owner already uses on a supervisor they started by hand. */
  importTokens(alias: string, secrets: RemoteSecrets) {
    requireAlias(alias);
    if (
      !TOKEN_PATTERN.test(secrets.supervisorToken) ||
      !TOKEN_PATTERN.test(secrets.computerToken)
    )
      throw new Error(
        'Each token must be 32 to 256 letters, digits, dash or underscore.',
      );
    this.write(alias, secrets);
  }

  /** The id FullDots writes on this server's supervisor. */
  serverId(alias: string): string {
    requireAlias(alias);
    if (!this.row(alias)) this.secrets(alias);
    const row = this.row(alias)!;
    if (row.serverId) return row.serverId;
    const made = randomBytes(8).toString('hex');
    this.db
      .prepare('UPDATE remote_computer_servers SET serverId=? WHERE alias=?')
      .run(made, alias);
    return made;
  }

  /** The alias whose server id this is, if it is one of ours. */
  aliasForServerId(serverId: string): string | undefined {
    const row = this.db
      .prepare('SELECT alias FROM remote_computer_servers WHERE serverId=?')
      .get(serverId) as { alias?: string } | undefined;
    return row?.alias;
  }

  /**
   * Marks the supervisor settings as shown and returns the tokens, once per set of tokens.
   * Showing them again needs new tokens (`reset`), so a leaked copy can be retired.
   */
  revealOnce(alias: string): RemoteSecrets {
    const secrets = this.secrets(alias);
    const changed = this.db
      .prepare(
        'UPDATE remote_computer_servers SET revealedAt=? WHERE alias=? AND revealedAt IS NULL',
      )
      .run(Date.now(), alias);
    if (Number(changed.changes) !== 1)
      throw new Error(
        'The supervisor settings for this server were already shown. Make new tokens to see them again; the old ones stop working.',
      );
    return secrets;
  }

  /** Every server FullDots made secrets for. */
  servers(): string[] {
    return (
      this.db
        .prepare('SELECT alias FROM remote_computer_servers ORDER BY alias')
        .all() as { alias: string }[]
    ).map((row) => row.alias);
  }
}
