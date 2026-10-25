import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  ChevronRight,
  Download,
  GitBranch,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import type { ConversationSummary, Dot } from '../shared/types';
import { MAX_CONVERSATION_TITLE_LENGTH } from '../shared/conversation-title';
import { Mascot, dotLook } from './Mascot';
import { RowMenu } from './sidebar/RowMenu';
import {
  chatRecency,
  chatWhen,
  listableChats,
  newestFirst,
} from './sidebar/chat-groups';
import { descendants, nestChats, workRunning } from './sidebar/chat-tree';
import './sidebar/chat-tree.css';

type Mode = 'idle' | 'rename' | 'confirm';

/** Chats a Dot's list shows before "Show more". */
export const HISTORY_LIMIT = 8;

function ChatRow({
  chat,
  dot,
  when,
  branchOf,
  active,
  onSelect,
  onRename,
  onDelete,
  onExport,
  onDeleted,
  nest,
  pulse = false,
}: {
  chat: ConversationSummary;
  /** Set only for a teammate's chat nested here, so the row can say whose it is. */
  dot?: Dot;
  /** Last activity, short: "9:41", "Yesterday", "Oct 21". */
  when: string;
  /** For a branch: the title of the chat it came from (undefined once that chat is gone). */
  branchOf?: string;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  /** Writes the conversation to a Markdown file the owner keeps. */
  onExport: () => Promise<void>;
  /** The row is gone: let the list put keyboard focus somewhere sensible. */
  onDeleted: () => void;
  /** Teammates' chats nested under this one: how deep it sits, and its own nested chats. */
  nest?: { depth: number; count: number; open: boolean; onToggle: () => void };
  /** Work is running in it, or in a chat nested under it. */
  pulse?: boolean;
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
  const runExport = async () => {
    if (busy) return;
    setBusy(true);
    await onExport();
    setBusy(false);
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
  const depth = nest?.depth ?? 0;
  return (
    <li
      className={`sb-chat ${active ? 'active' : ''} ${menuOpen ? 'menu-open' : ''} ${depth ? 'sb-chat-nested' : ''} ${nest?.count ? 'sb-chat-parent' : ''}`}
      style={depth ? ({ '--sb-depth': depth } as CSSProperties) : undefined}
    >
      {!!nest?.count && (
        <button
          type="button"
          className="sb-chat-twisty"
          aria-expanded={nest.open}
          aria-label={`${nest.open ? 'Hide' : 'Show'} ${nest.count} teammate ${nest.count === 1 ? 'chat' : 'chats'} of ${chat.title}`}
          title={nest.open ? 'Hide teammates’ chats' : 'Show teammates’ chats'}
          onClick={nest.onToggle}
        >
          <ChevronRight
            size={12}
            aria-hidden
            className={nest.open ? 'turned' : ''}
          />
        </button>
      )}
      <button
        ref={main}
        type="button"
        className="sb-chat-main"
        title={chat.title}
        aria-label={
          dot || chat.branchedFrom || pulse
            ? [
                chat.title,
                dot?.name,
                chat.branchedFrom &&
                  (branchOf ? `branch of ${branchOf}` : 'branch'),
                pulse && 'work running',
              ]
                .filter(Boolean)
                .join(', ')
            : undefined
        }
        aria-current={active ? 'page' : undefined}
        onClick={onSelect}
        onKeyDown={hotkeys}
      >
        {dot && (
          <span className="sb-chat-dot">
            <Mascot
              identity={dot.id}
              {...dotLook(dot)}
              name={dot.name}
              small
              decorative
            />
          </span>
        )}
        {chat.branchedFrom && (
          <GitBranch size={12} className="sb-chat-branch" aria-hidden="true" />
        )}
        <span className="sb-chat-title">{chat.title}</span>
        {chat.branchedFrom && branchOf && (
          <span className="sb-chat-from" aria-hidden="true">
            from {branchOf}
          </span>
        )}
        {pulse && <span className="sb-chat-pulse" aria-hidden="true" />}
      </button>
      <span className="sb-chat-when">{when}</span>
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
            id: 'export',
            label: 'Export as Markdown',
            icon: <Download size={14} aria-hidden />,
            onSelect: () => void runExport(),
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

/** One Dot's chats, newest first, under its row in the sidebar. */
export function ThreadList({
  id,
  dotId,
  chats,
  dots,
  selectedId,
  newChatLabel = 'New chat',
  onNewChat,
  onSelect,
  onRename,
  onDelete,
  onExport,
}: {
  /** The list's element id, for the toggle that shows it. */
  id?: string;
  /** Whose chats these are. */
  dotId: string;
  /** Every chat: teammates' chats made by a hand-off nest under the chat that handed the work over. */
  chats: ConversationSummary[];
  dots: Dot[];
  selectedId?: string;
  newChatLabel?: string;
  /** The first row starts a new chat; left out when there is none. */
  onNewChat?: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => Promise<boolean>;
  onDelete: (ids: string[]) => Promise<boolean>;
  /** Writes one conversation to a Markdown file the owner keeps. */
  onExport: (id: string) => Promise<void>;
}) {
  const [clearing, setClearing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const shown = newestFirst(listableChats(chats, selectedId));
  const tree = nestChats(shown);
  const own = new Set(
    shown.filter((chat) => chat.dotId === dotId).map((chat) => chat.id),
  );
  // This Dot's chats, except those nested under another of its own chats.
  const roots = shown.filter((chat) => {
    const parent = chat.handedBy?.threadId;
    return (
      chat.dotId === dotId && !(parent && parent !== chat.id && own.has(parent))
    );
  });
  // The open chat is never hidden behind "Show more".
  const selectedAt = selectedId
    ? roots.findIndex(
        (chat) =>
          chat.id === selectedId ||
          descendants(chat.id, tree).some((child) => child.id === selectedId),
      )
    : -1;
  const visible = all
    ? roots
    : roots.slice(0, Math.max(HISTORY_LIMIT, selectedAt + 1));
  const hidden = roots.length - visible.length;
  const emptyIds = chats
    .filter(
      (chat) => chat.empty && chat.dotId === dotId && chat.id !== selectedId,
    )
    .map((chat) => chat.id);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const fold = (id: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const now = Date.now();
  const row = (
    chat: ConversationSummary,
    depth: number,
    seen: ReadonlySet<string>,
  ): ReactNode => {
    const children = (tree.children.get(chat.id) ?? []).filter(
      (child) => !seen.has(child.id),
    );
    const open = !folded.has(chat.id);
    const next = new Set([...seen, chat.id]);
    return (
      <Fragment key={chat.id}>
        <ChatRow
          chat={chat}
          // A teammate's chat nested here shows its Dot.
          dot={
            chat.dotId === dotId
              ? undefined
              : dots.find((item) => item.id === chat.dotId)
          }
          when={chatWhen(chatRecency(chat), now)}
          branchOf={
            chat.branchedFrom &&
            chats.find((item) => item.id === chat.branchedFrom?.threadId)?.title
          }
          active={selectedId === chat.id}
          onSelect={() => onSelect(chat.id)}
          onRename={(title) => onRename(chat.id, title)}
          onDelete={() => onDelete([chat.id])}
          onExport={() => onExport(chat.id)}
          onDeleted={refocus}
          nest={{
            depth,
            count: children.length,
            open,
            onToggle: () => fold(chat.id),
          }}
          pulse={workRunning(chat, tree)}
        />
        {open &&
          children.map((child) => row(child, Math.min(depth + 1, 3), next))}
      </Fragment>
    );
  };
  // After a delete the focused row disappears; hand focus to the list's first row.
  const refocus = () =>
    setTimeout(
      () =>
        list.current
          ?.querySelector<HTMLElement>('.sb-history-new, .sb-chat-main')
          ?.focus(),
      50,
    );
  const arrows = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [
      ...(list.current?.querySelectorAll<HTMLElement>(
        '.sb-history-new, .sb-chat-main',
      ) ?? []),
    ];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    rows[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
  };
  return (
    <ul className="sb-history" id={id} ref={list} onKeyDown={arrows}>
      {onNewChat && (
        <li>
          <button
            type="button"
            className="sb-row sb-history-new"
            onClick={onNewChat}
          >
            <Plus size={14} aria-hidden />
            <span className="sb-text">{newChatLabel}</span>
          </button>
        </li>
      )}
      {visible.map((chat) => row(chat, 0, new Set()))}
      {!roots.length && (
        <li className="sb-note" role="status">
          No chats yet.
        </li>
      )}
      {hidden > 0 ? (
        <li className="sb-history-more">
          <button
            type="button"
            className="sb-link"
            onClick={() => setAll(true)}
          >
            Show {hidden} more
          </button>
        </li>
      ) : (
        all &&
        roots.length > HISTORY_LIMIT && (
          <li className="sb-history-more">
            <button
              type="button"
              className="sb-link"
              onClick={() => setAll(false)}
            >
              Show fewer
            </button>
          </li>
        )
      )}
      {emptyIds.length > 0 && (
        <li className="sb-tidy">
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
        </li>
      )}
    </ul>
  );
}
