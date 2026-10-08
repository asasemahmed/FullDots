import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const CONNECTOR_KEY_ENV = 'CONNECTOR_SECRET_KEY';
export const CONNECTOR_KEY_FILE = 'connector.key';

/**
 * AES-256-GCM. Output: `v1.<iv>.<tag>.<ciphertext>` (base64url). `aad` binds
 * the ciphertext to its row and column (`connectorId:column`).
 */
export function seal(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** Returns `undefined` on any failure (wrong key/AAD, tampering, bad format). Never throws. */
export function open(
  key: Buffer,
  sealed: string,
  aad: string,
): string | undefined {
  try {
    const parts = sealed.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) return undefined;
    const iv = Buffer.from(parts[1]!, 'base64url');
    const tag = Buffer.from(parts[2]!, 'base64url');
    const ciphertext = Buffer.from(parts[3]!, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return undefined;
  }
}

function decodeKey(value: string): Buffer | undefined {
  const text = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) {
    const bytes = Buffer.from(text, 'base64');
    if (bytes.length === KEY_BYTES) return bytes;
  }
  return undefined;
}

export interface LoadConnectorKeyOptions {
  env?: Readonly<Record<string, string | undefined>>;
  /** Path of the SQLite file; the key file lives beside it. `:memory:` gets a random in-process key. */
  databasePath: string;
}

/**
 * Resolution order: `CONNECTOR_SECRET_KEY` (64 hex chars or base64 of exactly
 * 32 bytes, else throws), then `<dir of database>/connector.key` (created once
 * with flag `wx` and mode 0o600, which POSIX honours and Windows ignores), and
 * for `:memory:` databases a random key that lives only in this process.
 */
export function loadConnectorKey(options: LoadConnectorKeyOptions): Buffer {
  const configured = options.env?.[CONNECTOR_KEY_ENV];
  if (configured !== undefined && configured.trim() !== '') {
    const key = decodeKey(configured);
    if (!key)
      throw new Error(
        `${CONNECTOR_KEY_ENV} must be 32 bytes encoded as 64 hex characters or base64.`,
      );
    return key;
  }
  if (options.databasePath === ':memory:') return randomBytes(KEY_BYTES);
  const file = join(dirname(options.databasePath), CONNECTOR_KEY_FILE);
  const read = (): Buffer => {
    const key = decodeKey(readFileSync(file, 'utf8'));
    if (!key)
      throw new Error(
        `${file} must contain a 32-byte key (base64 or 64 hex characters). Fix or delete it, or set ${CONNECTOR_KEY_ENV}.`,
      );
    return key;
  };
  try {
    return read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const key = randomBytes(KEY_BYTES);
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(file, key.toString('base64') + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    return key;
  } catch (error) {
    // Another process created it between our read and write: use theirs.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return read();
    throw error;
  }
}
