import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import type { ConversationSummary, Dot } from '../shared/types';
import { MAX_CONVERSATION_TITLE_LENGTH } from '../shared/conversation-title';
import { Mascot } from './Mascot';
import { RowMenu } from './sidebar/RowMenu';
import { filterChats, groupChats, listableChats } from './sidebar/chat-groups';

type Mode = 'idle' | 'rename' | 'confirm';

function ChatRow({
  chat,
  dot,
  active,
  onSelect,
  onRename,
  onDelete,
  onDeleted,
}: {
  chat: ConversationSummary;
  /** Set only when the workspace has several Dots, so the row can say which. */
  dot?: Dot;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  /** The row is gone: let the list put keyboard focus somewhere sensible. */
  onDeleted: () => void;
}) {
  const [mode, setMode] = useState<Mode>('idle');
  const [draft, setDraft] = useState(chat.title);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const main = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const settled = useRef(false);
  useEffect(() => {
    if (mode === 'idle' && restoreFocus.current) {
      restoreFocus.current = false;
      main.current?.focus();
    }
  }, [mode]);
  const finish = () => {
    restoreFocus.current = true;
    setMode('idle');
  };
  const startRename = () => {
    settled.current = false;
    setDraft(chat.title);
    setMode('rename');
  };
  const commitRename = async () => {
    if (settled.current) return;
    settled.current = true;
    const title = draft.trim().replace(/\s+/g, ' ');
    if (!title || title === chat.title) return finish();
    setBusy(true);
    const ok = await onRename(title);
    setBusy(false);
    if (ok) finish();
    else settled.current = false;
  };
  const cancelRename = () => {
    settled.current = true;
    finish();
  };
  const hotkeys = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'F2') {
      event.preventDefault();
      startRename();
    } else if (event.key === 'Delete') {
      event.preventDefault();
      setMode('confirm');
    }
  };
  if (mode === 'rename')
    return (
      <li className="sb-chat editing">
        <input
          className="sb-chat-input"
          aria-label={`Rename chat ${chat.title}`}
          value={draft}
          maxLength={MAX_CONVERSATION_TITLE_LENGTH}
          disabled={busy}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void commitRename();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              cancelRename();
            }
          }}
        />
      </li>
    );
  if (mode === 'confirm')
    return (
      <li
        className="sb-chat confirming"
        role="group"
        aria-label={`Delete ${chat.title}?`}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            finish();
          }
        }}
      >
        <span className="sb-confirm-text">Delete this chat?</span>
        <button
          type="button"
          className="sb-pill danger"
          autoFocus
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const ok = await onDelete();
            setBusy(false);
            if (ok) onDeleted();
            else finish();
          }}
        >
          Delete
        </button>
        <button
          type="button"
          className="sb-pill"
          disabled={busy}
          onClick={finish}
        >
          Cancel
        </button>
      </li>
    );
  return (
    <li
      className={`sb-chat ${active ? 'active' : ''} ${menuOpen ? 'menu-open' : ''}`}
    >
      <button
        ref={main}
        type="button"
        className="sb-chat-main"
        title={chat.title}
        aria-label={dot ? `${chat.title}, ${dot.name}` : undefined}
        aria-current={active ? 'page' : undefined}
        onClick={onSelect}
        onKeyDown={hotkeys}
      >
        {dot && (
          <span className="sb-chat-dot">
            <Mascot identity={dot.id} name={dot.name} small decorative />
          </span>
        )}
        <span className="sb-chat-title">{chat.title}</span>
      </button>
      <RowMenu
        label={`Actions for ${chat.title}`}
        className="sb-chat-more"
        onOpenChange={setMenuOpen}
        items={[
          {
            id: 'rename',
            label: 'Rename',
            icon: <Pencil size={14} aria-hidden />,
            onSelect: startRename,
          },
          {
            id: 'delete',
            label: 'Delete',
            icon: <Trash2 size={14} aria-hidden />,
            danger: true,
            onSelect: () => setMode('confirm'),
          },
        ]}
      />
    </li>
  );
}

export function ThreadList({
  chats,
  dots,
  selectedId,
  query,
  onSelect,
  onRename,
  onDelete,
}: {
  chats: ConversationSummary[];
  dots: Dot[];
  selectedId?: string;
  query: string;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => Promise<boolean>;
  onDelete: (ids: string[]) => Promise<boolean>;
}) {
  const [clearing, setClearing] = useState(false);
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const shown = filterChats(listableChats(chats, selectedId), query);
  const groups = groupChats(shown);
  const emptyIds = chats
    .filter((chat) => chat.empty && chat.id !== selectedId)
    .map((chat) => chat.id);
  const searching = query.trim().length > 0;
  const many = dots.length > 1;
  // After a delete the focused row disappears; hand focus to the list's first row.
  const refocus = () =>
    setTimeout(
      () => list.current?.querySelector<HTMLElement>('.sb-chat-main')?.focus(),
      50,
    );
  const arrows = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [
      ...(list.current?.querySelectorAll<HTMLElement>('.sb-chat-main') ?? []),
    ];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    rows[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
  };
  let body: ReactNode;
  if (!shown.length)
    body = (
      <p className="sb-note" role="status">
        {searching
          ? 'No chats match your search.'
          : 'No chats yet. Start one with New chat.'}
      </p>
    );
  else
    body = groups.map((group) => (
      <div className="sb-group" key={group.id}>
        <h3 className="sb-group-label">{group.label}</h3>
        <ul className="sb-chat-list">
          {group.items.map((chat) => (
            <ChatRow
              key={chat.id}
              chat={chat}
              dot={
                many ? dots.find((item) => item.id === chat.dotId) : undefined
              }
              active={selectedId === chat.id}
              onSelect={() => onSelect(chat.id)}
              onRename={(title) => onRename(chat.id, title)}
              onDelete={() => onDelete([chat.id])}
              onDeleted={refocus}
            />
          ))}
        </ul>
      </div>
    ));
  return (
    <section className="sb-chats" aria-labelledby="sb-chats-label">
      <h2 className="sb-label" id="sb-chats-label">
        Chats
      </h2>
      <div className="sb-chat-scroll" ref={list} onKeyDown={arrows}>
        {body}
        {!searching && emptyIds.length > 0 && (
          <div className="sb-tidy">
            {clearing ? (
              <>
                <span className="sb-confirm-text">
                  Remove {emptyIds.length} empty{' '}
                  {emptyIds.length === 1 ? 'chat' : 'chats'}?
                </span>
                <button
                  type="button"
                  className="sb-pill danger"
                  disabled={busy}
                  autoFocus
                  onClick={async () => {
                    setBusy(true);
                    await onDelete(emptyIds);
                    setBusy(false);
                    setClearing(false);
                    refocus();
                  }}
                >
                  Remove
                </button>
                <button
                  type="button"
                  className="sb-pill"
                  disabled={busy}
                  onClick={() => setClearing(false)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="sb-link"
                onClick={() => setClearing(true)}
              >
                Clear {emptyIds.length} empty{' '}
                {emptyIds.length === 1 ? 'chat' : 'chats'}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
