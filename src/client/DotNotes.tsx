// What a Dot remembers about its owner, made visible: one editable note per Dot, its history, and the
// opt-in switch that lets the Dot propose lines (which wait in the Inbox). Used in the Dot dialog and in
// a sheet opened from the chat header. Nothing here saves on its own: every change is the owner's click.
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { History, LoaderCircle, NotebookPen, RotateCcw, X } from 'lucide-react';
import { api } from './api';
import { relativeTime } from './ApprovalsView';
import { dotColor, Mascot, dotLook } from './Mascot';
import {
  NOTE_MAX,
  type DotNote,
  type DotNoteVersion,
  type NoteVersionReason,
} from '../shared/notes';
import type { Dot } from '../shared/types';
import './dot-notes.css';

const REASON_LABELS: Record<NoteVersionReason, string> = {
  edit: 'Before you edited it',
  clear: 'Before you cleared it',
  proposal: 'Before a saved suggestion',
};

/** The first part of an older text, on one line, for the history list. */
export function versionPreview(text: string, max = 140): string {
  const flat = Array.from(text.replace(/\s+/g, ' ').trim());
  return flat.length > max
    ? `${flat.slice(0, max - 1).join('')}…`
    : flat.join('');
}

export interface DotNotesViewProps {
  dot: Pick<Dot, 'id' | 'name' | 'color' | 'memoryAllowed'>;
  loaded: boolean;
  draft: string;
  /** The box differs from what is stored. */
  dirty: boolean;
  versions: DotNoteVersion[];
  proposals: boolean;
  busy?: 'save' | 'clear' | 'restore' | 'switch';
  /** Waiting for the owner to confirm Clear. */
  confirming?: boolean;
  /** A short line after something worked, announced politely. */
  status?: string;
  error?: string;
  onDraft: (text: string) => void;
  onSave: () => void;
  onAskClear: () => void;
  onCancelClear: () => void;
  onClear: () => void;
  onRestore: (versionId: string) => void;
  onProposals: (value: boolean) => void;
  /** Current time for "5 min ago"; injectable for tests. */
  now?: number;
}

/** The note, as plain markup over props: the container below holds the state and the requests. */
export function DotNotesView(props: DotNotesViewProps) {
  const { dot, versions, busy, confirming } = props;
  const id = useId().replace(/:/g, '');
  const field = `dot-notes-field-${id}`;
  const hint = `dot-notes-hint-${id}`;
  const now = props.now ?? Date.now();
  const locked = !props.loaded || !!busy;
  const tint = `var(--dot-${dotColor(dot)}-base)`;
  const style = {
    '--notes-base': tint,
    '--notes-light': `var(--dot-${dotColor(dot)}-light)`,
    '--notes-dark': `var(--dot-${dotColor(dot)}-dark)`,
  } as CSSProperties;
  return (
    <div className="dot-notes" style={style} aria-busy={!props.loaded}>
      <div className="dot-notes-head">
        <span className="dot-notes-face">
          <Mascot
            small
            decorative
            identity={dot.id}
            {...dotLook(dot)}
            name={dot.name}
          />
        </span>
        <div>
          <h4 className="dot-notes-title">
            What {dot.name} remembers about you
          </h4>
          <p className="dot-notes-sub">
            Only what you write or save here. {dot.name} reads it before each
            reply.
          </p>
        </div>
      </div>
      {!dot.memoryAllowed && (
        <p className="dot-notes-warn" role="note">
          Saved memories are off for {dot.name}, so this note is kept but not
          used. Turn them on under Access.
        </p>
      )}
      <label className="dot-notes-label" htmlFor={field}>
        Notes about you
      </label>
      <textarea
        id={field}
        className="dot-notes-field"
        rows={7}
        maxLength={NOTE_MAX}
        value={props.draft}
        disabled={locked}
        aria-describedby={hint}
        placeholder={`Nothing yet. For example: I like short answers with the summary first. I live in Cairo.`}
        onChange={(event) => props.onDraft(event.target.value)}
      />
      <div className="dot-notes-meta" id={hint}>
        <span aria-live="polite" className="dot-notes-status">
          {props.error ? '' : props.dirty ? 'Not saved yet' : props.status}
        </span>
        <span className="dot-notes-count">
          {props.draft.length.toLocaleString('en-US')} /{' '}
          {NOTE_MAX.toLocaleString('en-US')}
        </span>
      </div>
      {props.error && (
        <p className="dot-notes-error" role="alert">
          {props.error}
        </p>
      )}
      {confirming ? (
        <div className="dot-notes-confirm" role="group" aria-label="Clear note">
          <p>
            Clear everything {dot.name} remembers about you? You can bring it
            back from History.
          </p>
          <div className="dot-notes-actions">
            <button
              type="button"
              className="dot-notes-btn is-danger"
              disabled={locked}
              onClick={props.onClear}
            >
              {busy === 'clear' ? 'Clearing…' : 'Yes, clear it'}
            </button>
            <button
              type="button"
              className="dot-notes-btn"
              disabled={locked}
              onClick={props.onCancelClear}
            >
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div className="dot-notes-actions">
          <button
            type="button"
            className="dot-notes-btn is-primary"
            disabled={locked || !props.dirty}
            onClick={props.onSave}
          >
            {busy === 'save' ? (
              <LoaderCircle
                size={14}
                className="dot-notes-spin"
                aria-hidden="true"
              />
            ) : (
              <NotebookPen size={14} aria-hidden="true" />
            )}
            {busy === 'save' ? 'Saving…' : 'Save note'}
          </button>
          <button
            type="button"
            className="dot-notes-btn"
            disabled={locked || (!props.draft && !props.dirty)}
            onClick={props.onAskClear}
          >
            Clear
          </button>
        </div>
      )}
      <details className="dot-notes-history">
        <summary>
          <History size={14} aria-hidden="true" />
          History
          <span className="dot-notes-history-count">{versions.length}</span>
        </summary>
        {versions.length === 0 ? (
          <p className="dot-notes-empty">
            Earlier versions show up here after you edit or clear the note.
          </p>
        ) : (
          <ul className="dot-notes-versions">
            {versions.map((version) => (
              <li key={version.id}>
                <div className="dot-notes-version-head">
                  <span>
                    {REASON_LABELS[version.reason]}
                    <span aria-hidden="true"> · </span>
                    <time
                      dateTime={new Date(version.createdAt).toISOString()}
                      title={new Date(version.createdAt).toLocaleString()}
                    >
                      {relativeTime(version.createdAt, now)}
                    </time>
                  </span>
                  <button
                    type="button"
                    className="dot-notes-restore"
                    disabled={locked}
                    aria-label={`Restore this version: ${versionPreview(version.text, 60)}`}
                    onClick={() => props.onRestore(version.id)}
                  >
                    <RotateCcw size={12} aria-hidden="true" />
                    Restore
                  </button>
                </div>
                <p className="dot-notes-version-text">
                  {versionPreview(version.text)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </details>
      <label className="dot-notes-switch">
        <span className="dot-notes-switch-text">
          <strong>Let {dot.name} propose notes</strong>
          <small>
            {dot.name} may suggest one short line to remember. Suggestions wait
            in your Inbox, and nothing is saved until you click Save there.
          </small>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="dot-notes-sr"
          checked={props.proposals}
          disabled={!!busy}
          onChange={(event) => props.onProposals(event.target.checked)}
        />
        <span className="dot-notes-track" aria-hidden="true" />
      </label>
    </div>
  );
}

/** Saves the Dot's "may propose notes" switch through the ordinary Dot update. */
export async function setNotesProposals(
  dot: Pick<
    Dot,
    'id' | 'name' | 'instructions' | 'researchAllowed' | 'memoryAllowed'
  >,
  value: boolean,
): Promise<void> {
  await api(`/dots/${dot.id}`, 'PUT', {
    name: dot.name,
    instructions: dot.instructions,
    researchAllowed: dot.researchAllowed,
    memoryAllowed: dot.memoryAllowed,
    notesProposals: value,
  });
}

/** The note wired to the API. */
export function DotNotes({ dot }: { dot: Dot }) {
  const [saved, setSaved] = useState('');
  const [draft, setDraft] = useState('');
  const [versions, setVersions] = useState<DotNoteVersion[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [proposals, setProposals] = useState(!!dot.notesProposals);
  const [busy, setBusy] = useState<DotNotesViewProps['busy']>();
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => setProposals(!!dot.notesProposals), [dot.notesProposals]);

  const loadVersions = async () => {
    const result = await api<{ versions: DotNoteVersion[] }>(
      `/dots/${dot.id}/notes/versions`,
    );
    setVersions(result.versions);
  };

  useEffect(() => {
    let active = true;
    setLoaded(false);
    void Promise.all([
      api<DotNote>(`/dots/${dot.id}/notes`),
      api<{ versions: DotNoteVersion[] }>(`/dots/${dot.id}/notes/versions`),
    ])
      .then(([note, history]) => {
        if (!active) return;
        setSaved(note.text);
        setDraft(note.text);
        setVersions(history.versions);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (active)
          setError(e instanceof Error ? e.message : 'Could not load the note.');
      });
    return () => {
      active = false;
    };
  }, [dot.id]);

  const act = async (
    kind: NonNullable<DotNotesViewProps['busy']>,
    run: () => Promise<string | undefined>,
  ) => {
    setBusy(kind);
    setError('');
    setStatus('');
    try {
      const message = await run();
      if (message) setStatus(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(undefined);
    }
  };

  const adopt = (note: DotNote) => {
    setSaved(note.text);
    setDraft(note.text);
  };

  return (
    <DotNotesView
      dot={dot}
      loaded={loaded}
      draft={draft}
      dirty={draft.trim() !== saved}
      versions={versions}
      proposals={proposals}
      busy={busy}
      confirming={confirming}
      status={status}
      error={error}
      onDraft={(text) => {
        setDraft(text);
        setStatus('');
      }}
      onSave={() =>
        void act('save', async () => {
          adopt(
            await api<DotNote>(`/dots/${dot.id}/notes`, 'PUT', { text: draft }),
          );
          await loadVersions();
          return 'Saved';
        })
      }
      onAskClear={() => setConfirming(true)}
      onCancelClear={() => setConfirming(false)}
      onClear={() =>
        void act('clear', async () => {
          adopt(await api<DotNote>(`/dots/${dot.id}/notes/clear`, 'POST', {}));
          setConfirming(false);
          await loadVersions();
          return 'Cleared. The old note is in History.';
        })
      }
      onRestore={(versionId) =>
        void act('restore', async () => {
          adopt(
            await api<DotNote>(
              `/dots/${dot.id}/notes/restore/${encodeURIComponent(versionId)}`,
              'POST',
              {},
            ),
          );
          await loadVersions();
          return 'Restored';
        })
      }
      onProposals={(value) =>
        void act('switch', async () => {
          await setNotesProposals(dot, value);
          setProposals(value);
          return value
            ? `${dot.name} can now suggest notes. They wait in your Inbox.`
            : `${dot.name} will not suggest notes.`;
        })
      }
    />
  );
}

/** The chat header's Notes button and the sheet it opens. */
export function DotNotesButton({ dot }: { dot: Dot }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={opener}
        type="button"
        className="icon-button"
        aria-label={`Notes: what ${dot.name} remembers about you`}
        aria-haspopup="dialog"
        title="Notes"
        onClick={() => setOpen(true)}
      >
        <NotebookPen size={18} />
      </button>
      {open && (
        <DotNotesSheet
          dot={dot}
          onClose={() => {
            setOpen(false);
            opener.current?.focus();
          }}
        />
      )}
    </>
  );
}

/** A side sheet with the note: Escape and the backdrop close it, and Tab stays inside. */
export function DotNotesSheet({
  dot,
  onClose,
}: {
  dot: Dot;
  onClose: () => void;
}) {
  const sheet = useRef<HTMLElement>(null);
  const titleId = useId().replace(/:/g, '');
  useEffect(() => {
    sheet.current?.querySelector<HTMLElement>('textarea,button')?.focus();
  }, []);
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = [
      ...(sheet.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),summary',
      ) ?? []),
    ];
    if (!items.length) return;
    if (event.shiftKey && document.activeElement === items[0]) {
      event.preventDefault();
      items.at(-1)?.focus();
    } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
      event.preventDefault();
      items[0]?.focus();
    }
  };
  return (
    <div className="dot-notes-backdrop" onClick={onClose}>
      <aside
        ref={sheet}
        className="dot-notes-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <header className="dot-notes-sheet-head">
          <h3 id={titleId}>Notes</h3>
          <button
            type="button"
            className="dot-notes-close"
            aria-label="Close notes"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="dot-notes-sheet-body">
          <DotNotes dot={dot} />
        </div>
      </aside>
    </div>
  );
}
