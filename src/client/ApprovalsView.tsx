import { useState, type ReactNode } from 'react';
import { CircleCheck, LoaderCircle, MessageSquare } from 'lucide-react';
import type {
  Approval,
  ConversationSummary,
  Dot,
  Handoff,
  HandoffKind,
} from '../shared/types';
import {
  AdvisoryChip,
  ApprovalBadge,
  ApprovalDecision,
  ApprovalParts,
  ApprovalTile,
  HANDOFF_HINT,
  handoffIcon,
  statusIcon,
  statusTone,
  type DecideApproval,
} from './ApprovalCard';
import './approvals.css';

const HANDOFF_KINDS: Record<HandoffKind, string> = {
  credential: 'Sign-in',
  two_factor: 'Verification code',
  captcha: 'Captcha',
  other: 'Help needed',
};

/** "Just now", "5 min ago", "2 hr ago", "3 days ago", then a plain date. */
export function relativeTime(at: number, now: number = Date.now()): string {
  if (!Number.isFinite(at)) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? 'Yesterday' : `${days} days ago`;
  return new Date(at).toLocaleDateString();
}

function When({ at }: { at: number }) {
  const label = relativeTime(at);
  if (!label) return null;
  const valid = Number.isFinite(new Date(at).getTime());
  return (
    <time
      dateTime={valid ? new Date(at).toISOString() : undefined}
      title={valid ? new Date(at).toLocaleString() : undefined}
    >
      {label}
    </time>
  );
}

function Meta({ where, at }: { where: string; at: number }) {
  return (
    <span className="approval-meta">
      <span className="approval-where">{where}</span>
      <span aria-hidden="true">·</span>
      <When at={at} />
    </span>
  );
}

function DismissButton({ onDismiss }: { onDismiss: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="approval-btn is-secondary"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void onDismiss().finally(() => setBusy(false));
      }}
    >
      {busy && (
        <LoaderCircle size={14} className="approval-spin" aria-hidden="true" />
      )}
      Dismiss
    </button>
  );
}

function Section({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="approvals-section" aria-label={label}>
      <h2 className="approvals-heading">
        {label}
        <span className="approvals-count">{count}</span>
      </h2>
      {children}
    </section>
  );
}

/** Everything that is waiting for the owner: pending approvals and handoffs. */
export function ApprovalsView({
  approvals,
  handoffs,
  dots,
  conversations,
  onDecide,
  onOpenThread,
  onOpenComputer,
  onDismissHandoff,
}: {
  approvals: Approval[];
  handoffs: Handoff[];
  dots: Dot[];
  conversations: ConversationSummary[];
  onDecide: DecideApproval;
  onOpenThread: (threadId: string) => void;
  /** Opens that Dot's conversation and its computer panel. */
  onOpenComputer: (handoff: Handoff) => void;
  onDismissHandoff: (id: string) => Promise<void>;
}) {
  const dotName = (id: string) =>
    dots.find((dot) => dot.id === id)?.name ?? 'A Dot';
  const threadTitle = (id: string) =>
    conversations.find((chat) => chat.id === id)?.title ?? 'Conversation';
  const waiting = approvals.filter((item) => item.status === 'pending');
  const decided = approvals.filter((item) => item.status !== 'pending');
  const empty = !waiting.length && !handoffs.length;
  return (
    <main className="main-content approvals-view">
      <header className="approvals-header">
        <div>
          <h1>Approvals</h1>
          <p>Actions and sign-ins waiting for you</p>
        </div>
        {!empty && (
          <div className="approvals-summary">
            {waiting.length > 0 && (
              <span className="approval-badge is-pending">
                {waiting.length} to approve
              </span>
            )}
            {handoffs.length > 0 && (
              <span className="approval-badge is-pending">
                {handoffs.length} on the computer
              </span>
            )}
          </div>
        )}
      </header>
      {empty && (
        <div className="approvals-empty">
          <span className="approvals-empty-icon" aria-hidden="true">
            <CircleCheck size={44} strokeWidth={1.5} />
          </span>
          <h2>Nothing is waiting for you</h2>
          <p>
            When a Dot needs your approval or your help on the computer, it
            shows up here.
          </p>
        </div>
      )}
      {waiting.length > 0 && (
        <Section label="Waiting for approval" count={waiting.length}>
          <ul className="approvals-list">
            {waiting.map((approval) => (
              <li key={approval.id} className="approval-card is-pending">
                <header className="approval-head">
                  <ApprovalTile tone="pending" icon={statusIcon('pending')} />
                  <div className="approval-title">
                    <strong>{dotName(approval.dotId)}</strong>
                    <Meta
                      where={threadTitle(approval.threadId)}
                      at={approval.createdAt}
                    />
                  </div>
                  {approval.argsHash === null && <AdvisoryChip />}
                  <ApprovalBadge status="pending" />
                </header>
                <ApprovalParts
                  summary={approval.summary}
                  exact={approval.argsRedacted}
                  tool={approval.tool}
                />
                <ApprovalDecision
                  id={approval.id}
                  onDecide={onDecide}
                  idPrefix="approvals-view"
                  leading={
                    <button
                      type="button"
                      className="approval-link has-icon"
                      onClick={() => onOpenThread(approval.threadId)}
                    >
                      <MessageSquare size={13} aria-hidden="true" />
                      Open conversation
                    </button>
                  }
                />
              </li>
            ))}
          </ul>
        </Section>
      )}
      {handoffs.length > 0 && (
        <Section label="Your turn on the computer" count={handoffs.length}>
          <ul className="approvals-list">
            {handoffs.map((handoff) => (
              <li key={handoff.id} className="approval-card is-handoff">
                <header className="approval-head">
                  <ApprovalTile
                    tone="handoff"
                    icon={handoffIcon(handoff.kind)}
                  />
                  <div className="approval-title">
                    <strong>{dotName(handoff.dotId)}</strong>
                    <Meta
                      where={threadTitle(handoff.threadId)}
                      at={handoff.createdAt}
                    />
                  </div>
                  <span className="approval-kind">
                    {HANDOFF_KINDS[handoff.kind] ?? HANDOFF_KINDS.other}
                  </span>
                </header>
                <p className="approval-reason">{handoff.reason}</p>
                <p className="approval-hint">{HANDOFF_HINT}</p>
                <div className="approval-footer">
                  <div className="approval-footer-start" />
                  <div className="approval-buttons">
                    <DismissButton
                      onDismiss={() => onDismissHandoff(handoff.id)}
                    />
                    <button
                      type="button"
                      className="approval-btn is-primary"
                      onClick={() => onOpenComputer(handoff)}
                    >
                      Open computer
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {decided.length > 0 && (
        <Section label="Recently decided" count={decided.length}>
          <ul className="approvals-recent">
            {decided.map((approval) => (
              <li key={approval.id} className="approvals-recent-row">
                <ApprovalTile
                  tone={statusTone(approval.status)}
                  icon={statusIcon(approval.status)}
                />
                <div className="approvals-recent-text">
                  <span className="approvals-recent-summary">
                    {approval.summary || 'No description given.'}
                  </span>
                  <Meta
                    where={`${dotName(approval.dotId)} · ${threadTitle(approval.threadId)}`}
                    at={approval.decidedAt ?? approval.createdAt}
                  />
                </div>
                <ApprovalBadge status={approval.status} />
              </li>
            ))}
          </ul>
        </Section>
      )}
    </main>
  );
}
