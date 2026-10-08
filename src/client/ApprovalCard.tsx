import { useState } from 'react';
import { Monitor, ShieldQuestion } from 'lucide-react';
import type {
  Approval,
  ApprovalStatus,
  HandoffResult,
  PendingApprovalResult,
} from '../shared/types';
import type { ApprovalToolResult } from './chat-turns';
import './chat-activity.css';

export const NOTE_LIMIT = 1000;
export const EXACT_PREVIEW = 600;

export type DecideApproval = (
  id: string,
  decision: 'approve' | 'deny',
  note?: string,
) => Promise<void>;

const STATUS_LABELS: Record<Exclude<ApprovalStatus, 'pending'>, string> = {
  approved: 'Approved',
  consumed: 'Done',
  denied: 'Denied',
  expired: 'Expired',
};

/** Shell commands and anything multi-line read better in a monospace block. */
export function looksLikeCommand(exact: string): boolean {
  const text = exact.trim();
  if (text.includes('\n')) return true;
  // JSON arguments are shown inline; anything else is treated as a command.
  return !!text && !/^[{["]/.test(text);
}

/** The two labelled parts every approval shows: what the Dot says, and what will run. */
export function ApprovalParts({
  summary,
  exact,
}: {
  summary: string;
  exact: string;
}) {
  const [more, setMore] = useState(false);
  const long = exact.length > EXACT_PREVIEW;
  const shown = long && !more ? `${exact.slice(0, EXACT_PREVIEW)}…` : exact;
  return (
    <dl className="approval-parts">
      <div>
        <dt>Dot&apos;s description</dt>
        <dd>{summary || 'No description given.'}</dd>
      </div>
      <div>
        <dt>Exact action</dt>
        <dd>
          {exact ? (
            looksLikeCommand(exact) ? (
              <pre className="approval-exact">{shown}</pre>
            ) : (
              <code className="approval-exact inline">{shown}</code>
            )
          ) : (
            <span className="muted">Nothing specific to run.</span>
          )}
          {long && (
            <button
              type="button"
              className="approval-more"
              aria-expanded={more}
              onClick={() => setMore(!more)}
            >
              {more ? 'Show less' : 'Show more'}
            </button>
          )}
        </dd>
      </div>
    </dl>
  );
}

/** Approve / Deny with an optional note. Used by the chat card and the approvals view. */
export function ApprovalDecision({
  id,
  onDecide,
  idPrefix = 'approval',
}: {
  id: string;
  onDecide: DecideApproval;
  idPrefix?: string;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approve' | 'deny'>();
  const [error, setError] = useState('');
  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(decision);
    setError('');
    try {
      await onDecide(id, decision, note.trim() || undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your answer.');
    } finally {
      setBusy(undefined);
    }
  };
  const field = `${idPrefix}-note-${id}`;
  return (
    <div className="approval-decision">
      <label htmlFor={field} className="approval-note-label">
        Note for the Dot (optional)
      </label>
      <textarea
        id={field}
        rows={2}
        maxLength={NOTE_LIMIT}
        value={note}
        disabled={!!busy}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="approval-buttons">
        <button
          type="button"
          className="primary"
          disabled={!!busy}
          onClick={() => void decide('approve')}
        >
          Approve
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void decide('deny')}
        >
          Deny
        </button>
      </div>
      {error && (
        <p className="approval-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function ApprovalBadge({ status }: { status: ApprovalStatus }) {
  if (status === 'pending')
    return <span className="approval-badge is-pending">Waiting for you</span>;
  return (
    <span className={`approval-badge is-${status}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

function HandoffCard({
  result,
  onViewComputer,
}: {
  result: HandoffResult;
  onViewComputer?: () => void;
}) {
  return (
    <section
      className="approval-card is-handoff"
      aria-label="Your turn on the computer"
    >
      <header className="approval-head">
        <Monitor size={14} aria-hidden="true" />
        <strong>Your turn on the computer: {result.reason}</strong>
      </header>
      <p className="approval-hint">
        Type the password or code on the live screen; never paste it into the
        chat.
      </p>
      {onViewComputer && (
        <div className="approval-buttons">
          <button type="button" onClick={onViewComputer}>
            View live
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * The card the owner answers in the chat. `result` is what the tool returned
 * when it paused; `approval` is the live row (absent until the first poll, in
 * which case the card assumes the request is still waiting).
 */
export function ApprovalCard({
  result,
  approval,
  onDecide,
  onViewComputer,
}: {
  result: ApprovalToolResult;
  approval?: Approval;
  onDecide?: DecideApproval;
  onViewComputer?: () => void;
}) {
  if (result.status === 'handoff')
    return <HandoffCard result={result} onViewComputer={onViewComputer} />;
  const asked: PendingApprovalResult = result;
  const status: ApprovalStatus = approval?.status ?? 'pending';
  const advisory = asked.advisory === true || approval?.argsHash === null;
  return (
    <section className="approval-card" aria-label="Approval request">
      <header className="approval-head">
        <ShieldQuestion size={14} aria-hidden="true" />
        <strong>
          {status === 'pending' ? 'Approval needed' : 'Approval request'}
        </strong>
        {advisory && (
          <span
            className="approval-advisory"
            title="This answer informs the Dot but does not unlock a specific action."
          >
            (advisory)
          </span>
        )}
        <ApprovalBadge status={status} />
      </header>
      <ApprovalParts
        summary={approval?.summary || asked.summary}
        exact={approval?.argsRedacted || asked.exact}
      />
      {approval?.note && status !== 'pending' && (
        <p className="approval-note">Your note: {approval.note}</p>
      )}
      {status === 'pending' && onDecide && asked.approvalId && (
        <ApprovalDecision id={asked.approvalId} onDecide={onDecide} />
      )}
    </section>
  );
}
