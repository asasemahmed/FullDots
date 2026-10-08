import { useState } from 'react';
import { Monitor, ShieldCheck } from 'lucide-react';
import type {
  Approval,
  ConversationSummary,
  Dot,
  Handoff,
} from '../shared/types';
import {
  ApprovalDecision,
  ApprovalParts,
  type DecideApproval,
} from './ApprovalCard';
import './chat-activity.css';

function DismissButton({ onDismiss }: { onDismiss: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void onDismiss().finally(() => setBusy(false));
      }}
    >
      Dismiss
    </button>
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
  const empty = !approvals.length && !handoffs.length;
  return (
    <main className="main-content approvals-view">
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR WORKSPACE</span>
          <h1>Approvals</h1>
          <p>
            Actions your Dots paused for you to confirm, and steps only you can
            do on the computer.
          </p>
        </div>
      </div>
      {empty && (
        <div className="large-empty">
          <ShieldCheck size={32} aria-hidden="true" />
          <h2>Nothing is waiting for you.</h2>
        </div>
      )}
      {handoffs.length > 0 && (
        <section aria-label="Waiting on the computer">
          <h2 className="approvals-heading">Your turn on the computer</h2>
          <ul className="approvals-list">
            {handoffs.map((handoff) => (
              <li key={handoff.id} className="approval-card is-handoff">
                <header className="approval-head">
                  <Monitor size={14} aria-hidden="true" />
                  <strong>{dotName(handoff.dotId)}</strong>
                  <span className="approval-where">
                    {threadTitle(handoff.threadId)}
                  </span>
                </header>
                <p>Your turn on the computer: {handoff.reason}</p>
                <p className="approval-hint">
                  Type the password or code on the live screen; never paste it
                  into the chat.
                </p>
                <div className="approval-buttons">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => onOpenComputer(handoff)}
                  >
                    Open computer
                  </button>
                  <DismissButton
                    onDismiss={() => onDismissHandoff(handoff.id)}
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {approvals.length > 0 && (
        <section aria-label="Waiting for approval">
          <h2 className="approvals-heading">Waiting for your approval</h2>
          <ul className="approvals-list">
            {approvals.map((approval) => (
              <li key={approval.id} className="approval-card">
                <header className="approval-head">
                  <strong>{dotName(approval.dotId)}</strong>
                  <span className="approval-where">
                    {threadTitle(approval.threadId)}
                  </span>
                  {approval.argsHash === null && (
                    <span className="approval-advisory">(advisory)</span>
                  )}
                </header>
                <ApprovalParts
                  summary={approval.summary}
                  exact={approval.argsRedacted}
                />
                <ApprovalDecision
                  id={approval.id}
                  onDecide={onDecide}
                  idPrefix="approvals-view"
                />
                <div className="approval-buttons">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onOpenThread(approval.threadId)}
                  >
                    Open conversation
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
