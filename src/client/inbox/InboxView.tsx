// The needs-you inbox: approvals, "your turn on the computer", questions from Dots working in the
// background, and their finished work. Replaces the Approvals page; `#/approvals` opens it on the
// Approvals section.
import {
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  Archive,
  Bell,
  BellOff,
  BookmarkPlus,
  Check,
  LoaderCircle,
  MessageSquare,
  Send,
} from 'lucide-react';
import type {
  Approval,
  ConversationSummary,
  Dot,
  Handoff,
} from '../../shared/types';
import type {
  InboxItem,
  InboxResponse,
  InboxSection,
} from '../../shared/inbox';
import { ApprovalCard, type DecideApproval } from '../ApprovalCard';
import { relativeTime } from '../ApprovalsView';
import { Mascot, dotLook } from '../Mascot';
import { api } from '../api';
import { takeOverHere } from '../computer-panel/take-over';
import { notificationPermission, type NotifyPermission } from './notifications';
import '../approvals.css';
import './inbox.css';

const ANSWER_LIMIT = 4000;

const SECTION_LABELS: Record<InboxSection, string> = {
  approvals: 'Approvals',
  handoffs: 'Your turn on the computer',
  questions: 'Questions',
  memory: 'Memory',
  results: 'Finished work',
};

const sectionId = (section: InboxSection) => `inbox-${section}`;

export interface InboxViewProps {
  inbox?: InboxResponse;
  dots: Dot[];
  conversations: ConversationSummary[];
  /** The section to bring into view (from `#/approvals`). */
  focus?: InboxSection;
  onDecide: DecideApproval;
  onOpenThread: (threadId: string) => void;
  /** Opens that Dot's conversation and its computer panel. */
  onOpenComputer: (handoff: Handoff) => void;
  /** Opens the computer and takes control in one click. */
  onTakeOver: (handoff: Handoff) => Promise<void>;
  onDismissHandoff: (id: string) => Promise<void>;
  onAnswer: (id: string, text: string) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
  /** Saves a Dot's proposed line into its note. */
  onSaveNote: (id: string) => Promise<void>;
  onRead: (id: string) => Promise<void>;
  /** The notification switch, injectable for tests. */
  notifications?: ReactNode;
}

function When({ at }: { at: number }) {
  const label = relativeTime(at);
  if (!label) return null;
  const date = new Date(at);
  const valid = Number.isFinite(date.getTime());
  return (
    <time
      dateTime={valid ? date.toISOString() : undefined}
      title={valid ? date.toLocaleString() : undefined}
    >
      {label}
    </time>
  );
}

/** "Scout · in Morning news · 5 min ago", with the Dot's character. */
function Who({
  dot,
  where,
  at,
  state = 'idle',
}: {
  dot?: Dot;
  where: string;
  at: number;
  state?: string;
}) {
  return (
    <div className="inbox-who">
      <span className="inbox-who-face">
        <Mascot
          small
          identity={dot?.id}
          {...dotLook(dot)}
          name={dot?.name}
          state={state}
          decorative
        />
      </span>
      <span className="inbox-who-text">
        <strong>{dot?.name ?? 'A Dot'}</strong>
        <span className="approval-meta">
          <span className="approval-where">in {where}</span>
          <span aria-hidden="true">·</span>
          <When at={at} />
        </span>
      </span>
    </div>
  );
}

/** A button that shows a spinner while its action runs and reports a failure next to it. */
function ActionButton({
  label,
  busyLabel,
  icon,
  tone = 'secondary',
  onAction,
  disabled,
}: {
  label: string;
  busyLabel: string;
  icon?: ReactNode;
  tone?: 'primary' | 'secondary' | 'link';
  onAction: () => Promise<void>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={
        tone === 'link' ? 'approval-link has-icon' : `approval-btn is-${tone}`
      }
      disabled={busy || disabled}
      onClick={() => {
        setBusy(true);
        void onAction().finally(() => setBusy(false));
      }}
    >
      {busy ? (
        <LoaderCircle size={14} className="approval-spin" aria-hidden="true" />
      ) : (
        icon
      )}
      {busy ? busyLabel : label}
    </button>
  );
}

function Section({
  section,
  count,
  children,
}: {
  section: InboxSection;
  count: number;
  children: ReactNode;
}) {
  return (
    <section
      className="approvals-section inbox-section"
      id={sectionId(section)}
      aria-labelledby={`${sectionId(section)}-title`}
      tabIndex={-1}
    >
      <h2 className="approvals-heading" id={`${sectionId(section)}-title`}>
        {SECTION_LABELS[section]}
        <span className="approvals-count">{count}</span>
      </h2>
      {children}
    </section>
  );
}

function QuestionCard({
  item,
  dot,
  where,
  onAnswer,
  onArchive,
  onOpenThread,
}: {
  item: InboxItem;
  dot?: Dot;
  where: string;
  onAnswer: (id: string, text: string) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
  onOpenThread: (threadId: string) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'answer' | 'archive'>();
  const [error, setError] = useState('');
  const field = `inbox-answer-${useId().replace(/:/g, '')}`;
  const run = async (kind: 'answer' | 'archive') => {
    setBusy(kind);
    setError('');
    try {
      if (kind === 'answer') await onAnswer(item.id, text.trim());
      else await onArchive(item.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that.');
    } finally {
      setBusy(undefined);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim() && !busy) void run('answer');
  };
  return (
    <li className="approval-card inbox-card is-question">
      <Who dot={dot} where={where} at={item.createdAt} state="needs-input" />
      <p className="inbox-question">{item.text}</p>
      <form className="inbox-answer" onSubmit={submit} aria-busy={!!busy}>
        <label htmlFor={field} className="approval-note-label">
          Your answer
        </label>
        <textarea
          id={field}
          rows={2}
          maxLength={ANSWER_LIMIT}
          value={text}
          disabled={!!busy}
          placeholder={`Reply to ${dot?.name ?? 'the Dot'}…`}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey))
              submit(event);
          }}
        />
        <div className="approval-footer">
          <div className="approval-footer-start">
            <button
              type="button"
              className="approval-link has-icon"
              onClick={() => onOpenThread(item.threadId)}
            >
              <MessageSquare size={13} aria-hidden="true" />
              Open conversation
            </button>
          </div>
          <div className="approval-buttons">
            <button
              type="button"
              className="approval-btn is-secondary"
              disabled={!!busy}
              title="The Dot is told there is no answer and carries on without it."
              onClick={() => void run('archive')}
            >
              {busy === 'archive' ? (
                <LoaderCircle
                  size={14}
                  className="approval-spin"
                  aria-hidden="true"
                />
              ) : (
                <Archive size={14} aria-hidden="true" />
              )}
              Skip
            </button>
            <button
              type="submit"
              className="approval-btn is-primary"
              disabled={!!busy || !text.trim()}
            >
              {busy === 'answer' ? (
                <LoaderCircle
                  size={14}
                  className="approval-spin"
                  aria-hidden="true"
                />
              ) : (
                <Send size={14} aria-hidden="true" />
              )}
              {busy === 'answer' ? 'Sending…' : 'Send answer'}
            </button>
          </div>
        </div>
      </form>
      {error && (
        <p className="approval-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** A line a Dot would like to remember. Nothing is saved until the owner clicks Save. */
function MemoryCard({
  item,
  dot,
  where,
  onSave,
  onDiscard,
  onOpenThread,
}: {
  item: InboxItem;
  dot?: Dot;
  where: string;
  onSave: (id: string) => Promise<void>;
  onDiscard: (id: string) => Promise<void>;
  onOpenThread: (threadId: string) => void;
}) {
  const [error, setError] = useState('');
  const run = (action: (id: string) => Promise<void>) => async () => {
    setError('');
    try {
      await action(item.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not do that.');
    }
  };
  const name = dot?.name ?? 'The Dot';
  return (
    <li className="approval-card inbox-card is-memory">
      <Who dot={dot} where={where} at={item.createdAt} />
      <p className="inbox-memory-intro">{name} would like to remember:</p>
      <blockquote className="inbox-memory-line">{item.text}</blockquote>
      <p className="inbox-memory-hint">
        Nothing is saved until you click Save. It then joins what {name}{' '}
        remembers about you, and you can edit or clear it any time.
      </p>
      <div className="approval-footer">
        <div className="approval-footer-start">
          <button
            type="button"
            className="approval-link has-icon"
            onClick={() => onOpenThread(item.threadId)}
          >
            <MessageSquare size={13} aria-hidden="true" />
            Open conversation
          </button>
        </div>
        <div className="approval-buttons">
          <ActionButton
            label="Discard"
            busyLabel="Discarding…"
            icon={<Archive size={14} aria-hidden="true" />}
            onAction={run(onDiscard)}
          />
          <ActionButton
            tone="primary"
            label="Save"
            busyLabel="Saving…"
            icon={<BookmarkPlus size={14} aria-hidden="true" />}
            onAction={run(onSave)}
          />
        </div>
      </div>
      {error && (
        <p className="approval-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

function ResultCard({
  item,
  dot,
  where,
  onOpenThread,
  onRead,
  onArchive,
}: {
  item: InboxItem;
  dot?: Dot;
  where: string;
  onOpenThread: (threadId: string) => void;
  onRead: (id: string) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
}) {
  const unread = item.readAt === null;
  return (
    <li
      className={`approval-card inbox-card is-result ${unread ? 'is-unread' : ''}`}
    >
      <div className="inbox-result-head">
        <Who dot={dot} where={where} at={item.createdAt} state="complete" />
        {unread && <span className="inbox-unread">New</span>}
      </div>
      <h3 className="inbox-result-title">{item.title}</h3>
      <p className="inbox-excerpt">{item.text}</p>
      <div className="approval-footer">
        <div className="approval-footer-start">
          <button
            type="button"
            className="approval-link has-icon"
            onClick={() => {
              if (unread) void onRead(item.id).catch(() => {});
              onOpenThread(item.threadId);
            }}
          >
            <MessageSquare size={13} aria-hidden="true" />
            Open chat
          </button>
        </div>
        <div className="approval-buttons">
          {unread && (
            <ActionButton
              label="Mark read"
              busyLabel="Saving…"
              icon={<Check size={14} aria-hidden="true" />}
              onAction={() => onRead(item.id)}
            />
          )}
          <ActionButton
            label="Archive"
            busyLabel="Archiving…"
            icon={<Archive size={14} aria-hidden="true" />}
            onAction={() => onArchive(item.id)}
          />
        </div>
      </div>
    </li>
  );
}

/** "Enable desktop notifications" (asks the browser only on click), or the current state. */
export function NotificationSwitch({
  initial = notificationPermission(),
}: {
  initial?: NotifyPermission;
}) {
  const [permission, setPermission] = useState<NotifyPermission>(initial);
  if (permission === 'unsupported') return null;
  if (permission === 'granted')
    return (
      <span className="inbox-notify is-on">
        <Bell size={14} aria-hidden="true" />
        Desktop notifications on
      </span>
    );
  if (permission === 'denied')
    return (
      <span
        className="inbox-notify is-off"
        title="Allow notifications for this site in your browser settings."
      >
        <BellOff size={14} aria-hidden="true" />
        Notifications blocked
      </span>
    );
  return (
    <button
      type="button"
      className="inbox-notify-button"
      onClick={() =>
        void Notification.requestPermission()
          .then(setPermission)
          .catch(() => setPermission(notificationPermission()))
      }
    >
      <Bell size={14} aria-hidden="true" />
      Enable desktop notifications
    </button>
  );
}

export function InboxView(props: InboxViewProps) {
  const { inbox, dots, conversations, focus } = props;
  const dotOf = (id: string) => dots.find((dot) => dot.id === id);
  const where = (threadId: string) =>
    conversations.find((chat) => chat.id === threadId)?.title ??
    'a conversation';
  const counts = inbox?.counts;
  const present: InboxSection[] = inbox
    ? (
        [
          ['approvals', inbox.approvals.length],
          ['handoffs', inbox.handoffs.length],
          ['questions', inbox.questions.length],
          ['memory', inbox.memory.length],
          ['results', inbox.results.length],
        ] as const
      )
        .filter(([, count]) => count > 0)
        .map(([section]) => section)
    : [];

  // Brings a section into view once it is there (a notification link, `#/approvals`).
  const ready = !!inbox;
  useEffect(() => {
    if (!focus || !ready) return;
    const target = document.getElementById(sectionId(focus));
    if (!target) return;
    target.scrollIntoView?.({ block: 'start' });
    target.focus({ preventScroll: true });
  }, [focus, ready]);

  const jump = (section: InboxSection) => {
    const target = document.getElementById(sectionId(section));
    target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    target?.focus({ preventScroll: true });
  };

  const needsYou = counts?.needsYou ?? 0;
  return (
    <main className="main-content approvals-view inbox-view">
      <header className="approvals-header inbox-header">
        <div className="inbox-title">
          <span className="inbox-hero" aria-hidden="true">
            <Mascot state={needsYou ? 'needs-input' : 'complete'} decorative />
          </span>
          <div>
            <h1>Inbox</h1>
            <p>
              {!inbox
                ? 'Looking for anything that needs you…'
                : needsYou
                  ? `${needsYou} ${needsYou === 1 ? 'thing needs' : 'things need'} you`
                  : 'Nothing needs you right now'}
            </p>
          </div>
        </div>
        {props.notifications ?? <NotificationSwitch />}
      </header>

      {present.length > 1 && (
        <nav className="inbox-jump" aria-label="Inbox sections">
          {present.map((section) => (
            <button
              key={section}
              type="button"
              className={`inbox-chip is-${section}`}
              onClick={() => jump(section)}
            >
              {SECTION_LABELS[section]}
              <span className="inbox-chip-count">
                {section === 'results'
                  ? counts?.unread || inbox!.results.length
                  : section === 'approvals'
                    ? inbox!.approvals.length
                    : section === 'handoffs'
                      ? inbox!.handoffs.length
                      : section === 'memory'
                        ? inbox!.memory.length
                        : inbox!.questions.length}
              </span>
            </button>
          ))}
        </nav>
      )}

      {inbox && !present.length && (
        <div className="approvals-empty inbox-empty">
          <h2>All caught up</h2>
          <p>
            When a Dot needs your approval, your help on the computer or an
            answer, it shows up here. So does the work your Dots finish in the
            background.
          </p>
        </div>
      )}

      {inbox && inbox.approvals.length > 0 && (
        <Section section="approvals" count={inbox.approvals.length}>
          <ul className="approvals-list">
            {inbox.approvals.map((approval: Approval) => (
              <li key={approval.id} className="inbox-entry">
                <Who
                  dot={dotOf(approval.dotId)}
                  where={where(approval.threadId)}
                  at={approval.createdAt}
                  state="needs-input"
                />
                <ApprovalCard
                  result={{
                    status: 'pending_approval',
                    approvalId: approval.id,
                    summary: approval.summary,
                    exact: approval.argsRedacted,
                    ...(approval.argsHash === null
                      ? { advisory: true as const }
                      : {}),
                  }}
                  approval={approval}
                  onDecide={props.onDecide}
                />
                <button
                  type="button"
                  className="inbox-open"
                  onClick={() => props.onOpenThread(approval.threadId)}
                >
                  <MessageSquare size={13} aria-hidden="true" />
                  Open conversation
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {inbox && inbox.handoffs.length > 0 && (
        <Section section="handoffs" count={inbox.handoffs.length}>
          <ul className="approvals-list">
            {inbox.handoffs.map((handoff) => (
              <li key={handoff.id} className="inbox-entry">
                <Who
                  dot={dotOf(handoff.dotId)}
                  where={where(handoff.threadId)}
                  at={handoff.createdAt}
                  state="needs-input"
                />
                <ApprovalCard
                  result={{
                    status: 'handoff',
                    handoffId: handoff.id,
                    kind: handoff.kind,
                    reason: handoff.reason,
                  }}
                  onViewComputer={() => props.onOpenComputer(handoff)}
                  onTakeOver={() => props.onTakeOver(handoff)}
                />
                <div className="inbox-entry-actions">
                  <button
                    type="button"
                    className="inbox-open"
                    onClick={() => props.onOpenThread(handoff.threadId)}
                  >
                    <MessageSquare size={13} aria-hidden="true" />
                    Open conversation
                  </button>
                  <ActionButton
                    tone="link"
                    label="Decline"
                    busyLabel="Declining…"
                    onAction={() => props.onDismissHandoff(handoff.id)}
                  />
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {inbox && inbox.questions.length > 0 && (
        <Section section="questions" count={inbox.questions.length}>
          <ul className="approvals-list">
            {inbox.questions.map((item) => (
              <QuestionCard
                key={item.id}
                item={item}
                dot={dotOf(item.dotId)}
                where={where(item.threadId)}
                onAnswer={props.onAnswer}
                onArchive={props.onArchive}
                onOpenThread={props.onOpenThread}
              />
            ))}
          </ul>
        </Section>
      )}

      {inbox && inbox.memory.length > 0 && (
        <Section section="memory" count={inbox.memory.length}>
          <ul className="approvals-list">
            {inbox.memory.map((item) => (
              <MemoryCard
                key={item.id}
                item={item}
                dot={dotOf(item.dotId)}
                where={where(item.threadId)}
                onSave={props.onSaveNote}
                onDiscard={props.onArchive}
                onOpenThread={props.onOpenThread}
              />
            ))}
          </ul>
        </Section>
      )}

      {inbox && inbox.results.length > 0 && (
        <Section section="results" count={inbox.results.length}>
          <ul className="approvals-list">
            {inbox.results.map((item) => (
              <ResultCard
                key={item.id}
                item={item}
                dot={dotOf(item.dotId)}
                where={where(item.threadId)}
                onOpenThread={props.onOpenThread}
                onRead={props.onRead}
                onArchive={props.onArchive}
              />
            ))}
          </ul>
        </Section>
      )}
    </main>
  );
}

/** The inbox wired to the API: the item actions refetch the snapshot when they are done. */
export function InboxPage(
  props: Omit<
    InboxViewProps,
    'onAnswer' | 'onArchive' | 'onRead' | 'onTakeOver' | 'onSaveNote'
  > & { onRefresh: () => Promise<void> | void },
) {
  const { onRefresh, ...view } = props;
  const post = async (path: string, body: unknown = {}) => {
    try {
      await api(path, 'POST', body);
    } finally {
      await onRefresh();
    }
  };
  const then =
    <A extends unknown[]>(run: (...args: A) => Promise<void>) =>
    async (...args: A) => {
      try {
        await run(...args);
      } finally {
        await onRefresh();
      }
    };
  return (
    <InboxView
      {...view}
      onDecide={then(view.onDecide)}
      onDismissHandoff={then(view.onDismissHandoff)}
      onAnswer={(id, text) =>
        post(`/inbox/${encodeURIComponent(id)}/answer`, { text })
      }
      onArchive={(id) => post(`/inbox/${encodeURIComponent(id)}/archive`)}
      onSaveNote={(id) => post(`/inbox/${encodeURIComponent(id)}/save-note`)}
      onRead={(id) => post(`/inbox/${encodeURIComponent(id)}/read`)}
      onTakeOver={(handoff) =>
        takeOverHere({
          dotId: handoff.dotId,
          open: () => view.onOpenComputer(handoff),
        })
      }
    />
  );
}
