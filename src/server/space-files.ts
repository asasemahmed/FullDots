import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  MAX_SPACE_FILE_MB,
  typeOfName,
  type SpaceFile,
} from '../shared/space-files.js';

export class SpaceFileError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 413 = 400,
  ) {
    super(message);
  }
}

const NAME_MAX = 200;
const COLUMNS =
  'id, spaceId, parentId, name, mediaType, size, sha256, sourceThreadId, createdAt, updatedAt';

/** A file name without a path: no slashes, no control characters, not "." or "..". */
export function cleanFileName(raw: string): string {
  const unsafe = (char: string) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 || char === '/' || char === '\\';
  };
  const name = Array.from(raw, (char) => (unsafe(char) ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || name === '.' || name === '..' || name.length > NAME_MAX)
    throw new SpaceFileError(
      `Give the file a name of 1 to ${NAME_MAX} characters, without slashes.`,
    );
  return name;
}

export const fileUpload = z
  .object({
    name: z.string().min(1).max(1000),
    /** The file's bytes, base64 encoded. */
    contentBase64: z.string().max(100_000_000),
    parentId: z.string().min(1).nullable().default(null),
  })
  .strict();
export const filePatch = z
  .object({
    name: z.string().min(1).max(1000).optional(),
    parentId: z.string().min(1).nullable().optional(),
  })
  .strict();

type Row = Omit<SpaceFile, 'kind'>;
const withKind = (row: Row): SpaceFile => ({
  ...row,
  kind: typeOfName(row.name).kind,
});

/** Files stored in a Space: details in `space_files`, the bytes in the same row. */
export class SpaceFiles {
  constructor(
    private readonly db: DatabaseSync,
    private readonly spaceExists: (id: string) => boolean,
    private readonly pageExists: (spaceId: string, id: string) => boolean,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS space_files(
      id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, parentId TEXT, name TEXT NOT NULL,
      mediaType TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, sourceThreadId TEXT,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, data BLOB NOT NULL);
    CREATE INDEX IF NOT EXISTS space_files_by_space ON space_files(spaceId, parentId)`);
  }

  private requireSpace(spaceId: string) {
    if (!this.spaceExists(spaceId))
      throw new SpaceFileError('Space not found.', 404);
  }
  private requireParent(spaceId: string, parentId: string | null) {
    if (parentId && !this.pageExists(spaceId, parentId))
      throw new SpaceFileError('That page is not in this Space.');
  }

  /** `name`, or `name (2)`, `name (3)` … so two files in one place never share a name. */
  private uniqueName(
    spaceId: string,
    parentId: string | null,
    name: string,
    ignoreId?: string,
  ): string {
    const taken = new Set(
      (
        this.db
          .prepare(
            'SELECT name FROM space_files WHERE spaceId=? AND parentId IS ? AND id IS NOT ?',
          )
          .all(spaceId, parentId, ignoreId ?? null) as { name: string }[]
      ).map((row) => row.name.toLowerCase()),
    );
    if (!taken.has(name.toLowerCase())) return name;
    // Keeps the extension exactly as written: "A.TXT" becomes "A (2).TXT".
    const dot = name.lastIndexOf('.');
    const [stem, extension] =
      dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 2; ; n++) {
      const next = `${stem} (${n})${extension}`;
      if (!taken.has(next.toLowerCase())) return next;
    }
  }

  list(spaceId: string): SpaceFile[] {
    this.requireSpace(spaceId);
    return (
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM space_files WHERE spaceId=? ORDER BY createdAt, id`,
        )
        .all(spaceId) as unknown as Row[]
    ).map(withKind);
  }

  get(spaceId: string, id: string): SpaceFile {
    this.requireSpace(spaceId);
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM space_files WHERE id=? AND spaceId=?`)
      .get(id, spaceId) as Row | undefined;
    if (!row) throw new SpaceFileError('File not found in this Space.', 404);
    return withKind(row);
  }

  content(spaceId: string, id: string): { file: SpaceFile; data: Buffer } {
    const file = this.get(spaceId, id);
    const row = this.db
      .prepare('SELECT data FROM space_files WHERE id=?')
      .get(id) as { data: Uint8Array };
    return { file, data: Buffer.from(row.data) };
  }

  create(
    spaceId: string,
    input: {
      name: string;
      data: Uint8Array;
      parentId?: string | null;
    },
    options: { maxBytes: number; sourceThreadId?: string | null },
  ): SpaceFile {
    this.requireSpace(spaceId);
    const parentId = input.parentId ?? null;
    this.requireParent(spaceId, parentId);
    if (input.data.byteLength > options.maxBytes)
      throw new SpaceFileError(
        `Files can be at most ${Math.floor(options.maxBytes / 1024 / 1024)} MB. Raise SPACE_FILE_MAX_MB (up to ${MAX_SPACE_FILE_MB}) to allow more.`,
        413,
      );
    const name = this.uniqueName(spaceId, parentId, cleanFileName(input.name));
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare('INSERT INTO space_files VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        id,
        spaceId,
        parentId,
        name,
        typeOfName(name).mediaType,
        input.data.byteLength,
        createHash('sha256').update(input.data).digest('hex'),
        options.sourceThreadId ?? null,
        now,
        now,
        input.data,
      );
    return this.get(spaceId, id);
  }

  /** Renames and moves. Changing the extension changes how the file is shown, so it is allowed. */
  update(
    spaceId: string,
    id: string,
    patch: z.infer<typeof filePatch>,
  ): SpaceFile {
    const current = this.get(spaceId, id);
    const parentId =
      patch.parentId === undefined ? current.parentId : patch.parentId;
    this.requireParent(spaceId, parentId);
    const name = this.uniqueName(
      spaceId,
      parentId,
      patch.name === undefined ? current.name : cleanFileName(patch.name),
      id,
    );
    this.db
      .prepare(
        'UPDATE space_files SET name=?, mediaType=?, parentId=?, updatedAt=? WHERE id=? AND spaceId=?',
      )
      .run(name, typeOfName(name).mediaType, parentId, Date.now(), id, spaceId);
    return this.get(spaceId, id);
  }

  delete(spaceId: string, id: string): boolean {
    this.requireSpace(spaceId);
    return (
      this.db
        .prepare('DELETE FROM space_files WHERE id=? AND spaceId=?')
        .run(id, spaceId).changes > 0
    );
  }
}
