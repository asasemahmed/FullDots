// The proposals a Dot may make for its own note. A proposal is an inbox item (kind `memory`) and
// nothing else: it never touches the note, never pauses or resumes a turn and unlocks nothing. The
// note changes only when the owner saves the item, which is the owner's click in the inbox.
import type { InboxItem } from '../shared/inbox.js';
import { PROPOSAL_MAX } from '../shared/notes.js';
import { NoteTooLongError, type DotNotesStore } from './dot-notes-store.js';
import { redactForStorage } from './redaction.js';
import type { InboxStore } from './inbox-store.js';

/** How many proposals of one Dot may wait at once; more would only bury the inbox. */
export const MAX_OPEN_PROPOSALS = 10;

export class NotesError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'NotesError';
  }
}

export interface DotNotesServiceDeps {
  notes: DotNotesStore;
  inbox: InboxStore;
  /** The Dot's name and whether its owner switched proposals on; undefined when there is no such Dot. */
  dot: (
    dotId: string,
  ) => { name: string; notesProposals?: boolean | undefined } | undefined;
  /** Called after the inbox changed; the platform emits `inbox.changed`. */
  changed?: () => void;
}

export class DotNotesService {
  constructor(private deps: DotNotesServiceDeps) {}

  /** True while the Dot's owner allows it to propose notes. Read on every use, so a change applies at once. */
  proposalsOn(dotId: string): boolean {
    return this.deps.dot(dotId)?.notesProposals === true;
  }

  /**
   * Stores a proposed line for the owner. Refused when the switch is off. The same line twice is
   * one item; a Dot with many proposals waiting has to wait for the owner.
   */
  propose(input: { dotId: string; threadId: string; note: string }): InboxItem {
    const dot = this.deps.dot(input.dotId);
    if (!dot?.notesProposals)
      throw new NotesError('This Dot may not propose notes.', 409);
    // A proposal waits in the inbox, which is storage too, so secrets are hidden here as well.
    const line = redactForStorage(
      input.note.replace(/\s+/g, ' ').trim(),
      (count) =>
        console.warn(
          `Redacted ${count} secret-like value${count === 1 ? '' : 's'} from a note proposed by Dot ${input.dotId}.`,
        ),
    );
    if (!line || Array.from(line).length > PROPOSAL_MAX)
      throw new NotesError(
        `Propose one short line of 1 to ${PROPOSAL_MAX} characters.`,
        400,
      );
    const waiting = this.deps.inbox.openMemory(input.dotId);
    const same = waiting.find((item) => item.text === line);
    if (same) return same;
    if (waiting.length >= MAX_OPEN_PROPOSALS)
      throw new NotesError(
        'Several proposals are still waiting for the owner. Do not propose more now.',
        409,
      );
    const item = this.deps.inbox.create({
      kind: 'memory',
      dotId: input.dotId,
      threadId: input.threadId,
      title: `${dot.name} would like to remember something`,
      text: line,
    });
    this.changed();
    return item;
  }

  /**
   * The owner saves a proposal: the line joins the note (the old text is kept as a version) and
   * the item is archived. The line is added first, and a line the note already has is not added
   * twice, so a retry after a failure cannot duplicate it.
   */
  save(id: string): { item: InboxItem; note: string } {
    const item = this.require(id);
    if (item.archivedAt !== null)
      throw new NotesError('This proposal is no longer waiting.', 409);
    let note;
    try {
      note = this.deps.notes.appendLine(item.dotId, item.text);
    } catch (error) {
      if (error instanceof NoteTooLongError)
        throw new NotesError(
          'The note is full. Make room in it, then save this line.',
          409,
        );
      throw error;
    }
    this.deps.inbox.archive(id);
    this.changed();
    return {
      item: this.deps.inbox.get(id) ?? item,
      note: note.text,
    };
  }

  private require(id: string): InboxItem {
    const item = this.deps.inbox.get(id);
    if (!item || item.kind !== 'memory')
      throw new NotesError('Proposal not found.', 404);
    return item;
  }

  private changed() {
    try {
      this.deps.changed?.();
    } catch (error) {
      console.error(
        `Inbox change hook failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
