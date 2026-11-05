// Where Dot computers run, and the secrets FullDots made for each of the owner's servers. Only the
// ssh alias is stored about a server: no key, password or passphrase. The supervisor token and the
// computer master token of each server are generated here and stored sealed with the connector key;
// they never leave the server process except to the owner's own server, over ssh, on stdin.
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { open, seal } from './connector-crypto.js';
import { requireAlias } from './remote-ssh.js';
import type { ComputerWhere } from '../shared/remote-computer-types.js';

export const REMOTE_SCHEMA = `CREATE TABLE IF NOT EXISTS remote_computer_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS remote_computer_servers(alias TEXT PRIMARY KEY, supervisorToken TEXT NOT NULL, computerToken TEXT NOT NULL, createdAt INTEGER NOT NULL);`;

const aad = (alias: string, column: string) => `remote:${alias}:${column}`;

export interface RemoteSecrets {
  supervisorToken: string;
  computerToken: string;
}

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

  /** The server's secrets, made the first time the server is used. */
  secrets(alias: string): RemoteSecrets {
    requireAlias(alias);
    const row = this.db
      .prepare(
        'SELECT supervisorToken, computerToken FROM remote_computer_servers WHERE alias=?',
      )
      .get(alias) as
      { supervisorToken: string; computerToken: string } | undefined;
    if (row) {
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
      throw new Error(
        `The stored tokens for ${alias} could not be decrypted. Set up this server again.`,
      );
    }
    const made = {
      supervisorToken: randomBytes(32).toString('hex'),
      computerToken: randomBytes(32).toString('hex'),
    };
    this.db
      .prepare(
        'INSERT INTO remote_computer_servers(alias,supervisorToken,computerToken,createdAt) VALUES (?,?,?,?)',
      )
      .run(
        alias,
        seal(this.key, made.supervisorToken, aad(alias, 'supervisorToken')),
        seal(this.key, made.computerToken, aad(alias, 'computerToken')),
        Date.now(),
      );
    return made;
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
