// One note per Dot: what the owner wants it to remember about them. Only the owner's own actions
// change it (edit, clear, restore, or saving a proposal from the inbox), and every change keeps the
// text it replaced as a version, so nothing the owner wrote is ever lost. Tables are created here and
// are keyed by Dot, not by thread.
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  NOTE_MAX,
  type DotNote,
  type DotNoteVersion,
  type NoteVersionReason,
} from '../shared/notes.js';
import { redactForStorage } from './redaction.js';

export class NoteTooLongError extends Error {
  constructor() {
    super(`A note holds up to ${NOTE_MAX.toLocaleString('en-US')} characters.`);
    this.name = 'NoteTooLongError';
  }
}

const toVersion = (row: Record<string, unknown>): DotNoteVersion => ({
  id: String(row.id),
  dotId: String(row.dotId),
  text: String(row.text),
  createdAt: Number(row.createdAt),
  reason:
    row.reason === 'clear' || row.reason === 'proposal' ? row.reason : 'edit',
});

export class DotNotesStore {
  constructor(
    private db: DatabaseSync,
    private now: () => number = Date.now,
    private log: (message: string) => void = (message) => console.warn(message),
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS dot_notes(dotId TEXT PRIMARY KEY, text TEXT NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dot_note_versions(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, text TEXT NOT NULL, createdAt INTEGER NOT NULL, reason TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS dot_note_versions_dot ON dot_note_versions(dotId, createdAt);`);
  }

  get(dotId: string): DotNote {
    const row = this.db
      .prepare('SELECT text, updatedAt FROM dot_notes WHERE dotId=?')
      .get(dotId);
    return {
      dotId,
      text: row ? String(row.text) : '',
      updatedAt: row ? Number(row.updatedAt) : null,
    };
  }

  /** Hides anything that looks like a key or token, and logs how many were hidden, never what. */
  private redact(dotId: string, text: string): string {
    return redactForStorage(text, (count) =>
      this.log(
        `Redacted ${count} secret-like value${count === 1 ? '' : 's'} before saving the note of Dot ${dotId}.`,
      ),
    );
  }

  /**
   * Replaces the note. Secrets in the text are replaced with [redacted] first; the stored text is
   * the redacted one. The text it replaces is kept as a version (unless it was empty), tagged with
   * why it was replaced. Writing the same text again changes nothing.
   */
  put(
    dotId: string,
    rawText: string,
    reason: NoteVersionReason = 'edit',
  ): DotNote {
    const text = this.redact(dotId, rawText);
    if (text.length > NOTE_MAX) throw new NoteTooLongError();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const before = this.get(dotId);
      if (before.text !== text) {
        if (before.text)
          this.db
            .prepare(
              'INSERT INTO dot_note_versions(id, dotId, text, createdAt, reason) VALUES (?,?,?,?,?)',
            )
            .run(randomUUID(), dotId, before.text, this.now(), reason);
        this.db
          .prepare(
            'INSERT INTO dot_notes(dotId, text, updatedAt) VALUES (?,?,?) ON CONFLICT(dotId) DO UPDATE SET text=excluded.text, updatedAt=excluded.updatedAt',
          )
          .run(dotId, text, this.now());
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.get(dotId);
  }

  clear(dotId: string): DotNote {
    return this.put(dotId, '', 'clear');
  }

  /**
   * Adds one line at the end of the note (a saved proposal). A line the note already has is not
   * added twice.
   */
  appendLine(dotId: string, line: string): DotNote {
    const current = this.get(dotId).text;
    const wanted = this.redact(dotId, line.trim());
    if (current.split('\n').some((existing) => existing.trim() === wanted))
      return this.get(dotId);
    return this.put(
      dotId,
      current ? `${current.replace(/\s+$/, '')}\n${wanted}` : wanted,
      'proposal',
    );
  }

  /** Earlier texts of the note, newest first. */
  versions(dotId: string, limit = 100): DotNoteVersion[] {
    return this.db
      .prepare(
        'SELECT * FROM dot_note_versions WHERE dotId=? ORDER BY createdAt DESC, rowid DESC LIMIT ?',
      )
      .all(dotId, limit)
      .map(toVersion);
  }

  /**
   * Makes an earlier text the note again. The text being replaced becomes a version of its own,
   * so a restore can be undone the same way. Undefined when the version is not this Dot's.
   */
  restore(dotId: string, versionId: string): DotNote | undefined {
    const row = this.db
      .prepare('SELECT * FROM dot_note_versions WHERE id=? AND dotId=?')
      .get(versionId, dotId);
    return row ? this.put(dotId, toVersion(row).text, 'edit') : undefined;
  }
}
