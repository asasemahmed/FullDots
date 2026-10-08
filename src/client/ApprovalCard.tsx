import { useId, useState, type ReactNode } from 'react';
import {
  Clock,
  KeyRound,
  LoaderCircle,
  MonitorSmartphone,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  type LucideIcon,
} from 'lucide-react';
import type {
  Approval,
  ApprovalStatus,
  HandoffKind,
  HandoffResult,
  PendingApprovalResult,
} from '../shared/types';
import type { ApprovalToolResult } from './chat-turns';
import { ConnectorLogo } from './connector-logos';
import './approvals.css';

export const NOTE_LIMIT = 1000;
export const EXACT_PREVIEW = 600;

export const HANDOFF_HINT =
  'Type the password or code on the live screen; never paste it into the chat.';
export const ADVISORY_NOTE = 'This approval does not unlock a specific action.';

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

const STATUS_ICONS: Record<ApprovalStatus, LucideIcon> = {
  pending: ShieldAlert,
  approved: ShieldCheck,
  consumed: ShieldCheck,
  denied: ShieldX,
  expired: Clock,
};

export type ApprovalTone = 'pending' | 'done' | 'denied' | 'expired';

/** The visual tone of a status: amber waiting, green done, red denied, grey expired. */
export function statusTone(status: ApprovalStatus): ApprovalTone {
  if (status === 'approved' || status === 'consumed') return 'done';
  return status;
}

export function statusLabel(status: ApprovalStatus): string {
  return status === 'pending' ? 'Waiting for you' : STATUS_LABELS[status];
}

export function approvalTitle(status: ApprovalStatus): string {
  return status === 'pending' ? 'Needs your approval' : STATUS_LABELS[status];
}

export function statusIcon(status: ApprovalStatus): LucideIcon {
  return STATUS_ICONS[status];
}

/** `mcp__github__create_issue` becomes { connector: 'github', tool: 'create_issue' }. */
export function parseConnectorTool(
  tool: string | undefined,
): { connector: string; tool: string } | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(tool ?? '');
  return match ? { connector: match[1], tool: match[2] } : undefined;
}

/** Shell commands and anything multi-line read better in a monospace block. */
export function looksLikeCommand(exact: string): boolean {
  const text = exact.trim();
  if (text.includes('\n')) return true;
  // JSON arguments are shown inline; anything else is treated as a command.
  return !!text && !/^[{["]/.test(text);
}

/** The rounded icon tile at the start of every card header. */
export function ApprovalTile({
  tone,
  icon: Icon,
}: {
  tone: ApprovalTone | 'handoff';
  icon: LucideIcon;
}) {
  return (
    <span className={`approval-tile is-${tone}`} aria-hidden="true">
      <Icon size={18} strokeWidth={1.9} />
    </span>
  );
}

/** The two labelled parts every approval shows: what the Dot says, and what will run. */
export function ApprovalParts({
  summary,
  exact,
  tool,
}: {
  summary: string;
  exact: string;
  /** The gated tool name; MCP connector tools get a logo line above the exact action. */
  tool?: string;
}) {
  const [more, setMore] = useState(false);
  const long = exact.length > EXACT_PREVIEW;
  const shown = long && !more ? `${exact.slice(0, EXACT_PREVIEW)}…` : exact;
  const connector = parseConnectorTool(tool);
  return (
    <dl className="approval-parts">
      <div>
        <dt>Dot&apos;s description</dt>
        <dd className="approval-summary">
          {summary || 'No description given.'}
        </dd>
      </div>
      <div>
        <dt>Exact action</dt>
        <dd>
          {connector && (
            <div className="approval-connector">
              <ConnectorLogo
                presetId={connector.connector}
                name={connector.connector}
                size={20}
              />
              <span>
                {connector.connector} · {connector.tool}
              </span>
            </div>
          )}
          {exact ? (
            looksLikeCommand(exact) ? (
              <pre className="approval-exact">{shown}</pre>
            ) : (
              <code className="approval-exact inline">{shown}</code>
            )
          ) : (
            <span className="approval-none">Nothing specific to run.</span>
          )}
          {long && (
            <button
              type="button"
              className="approval-link"
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

/** Deny / Approve with an optional note. Used by the chat card and the approvals view. */
export function ApprovalDecision({
  id,
  onDecide,
  idPrefix = 'approval',
  leading,
  defaultNoteOpen = false,
}: {
  id: string;
  onDecide: DecideApproval;
  idPrefix?: string;
  /** Extra content at the start of the button row (for example "Open conversation"). */
  leading?: ReactNode;
  defaultNoteOpen?: boolean;
}) {
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(defaultNoteOpen);
  const [busy, setBusy] = useState<'approve' | 'deny'>();
  const [error, setError] = useState('');
  const uid = useId();
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
  const field = `${idPrefix}-note-${id}-${uid}`;
  return (
    <div className="approval-decision" aria-busy={!!busy}>
      {noteOpen && (
        <div className="approval-note-field">
          <label htmlFor={field} className="approval-note-label">
            Note for the Dot (optional)
          </label>
          <textarea
            id={field}
            rows={2}
            maxLength={NOTE_LIMIT}
            value={note}
            disabled={!!busy}
            placeholder="Tell the Dot why, or what to do differently"
            onChange={(event) => setNote(event.target.value)}
          />
          <span className="approval-counter">
            {note.length}/{NOTE_LIMIT}
          </span>
        </div>
      )}
      <div className="approval-footer">
        <div className="approval-footer-start">
          {leading}
          {!noteOpen && (
            <button
              type="button"
              className="approval-link"
              aria-expanded={false}
              disabled={!!busy}
              onClick={() => setNoteOpen(true)}
            >
              Add a note
            </button>
          )}
        </div>
        <div className="approval-buttons">
          <button
            type="button"
            className="approval-btn is-secondary"
            disabled={!!busy}
            onClick={() => void decide('deny')}
          >
            {busy === 'deny' && (
              <LoaderCircle
                size={14}
                className="approval-spin"
                aria-hidden="true"
              />
            )}
            {busy === 'deny' ? 'Denying…' : 'Deny'}
          </button>
          <button
            type="button"
            className="approval-btn is-primary"
            disabled={!!busy}
            onClick={() => void decide('approve')}
          >
            {busy === 'approve' && (
              <LoaderCircle
                size={14}
                className="approval-spin"
                aria-hidden="true"
              />
            )}
            {busy === 'approve' ? 'Approving…' : 'Approve'}
          </button>
        </div>
      </div>
      {error && (
        <p className="approval-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The status chip at the end of a card header. */
export function ApprovalBadge({ status }: { status: ApprovalStatus }) {
  return (
    <span className={`approval-badge is-${statusTone(status)}`}>
      {statusLabel(status)}
    </span>
  );
}

/** Small chip for summary-only requests that unlock nothing. */
export function AdvisoryChip() {
  return (
    <span className="approval-advisory" title={ADVISORY_NOTE}>
      Advisory
    </span>
  );
}

export function handoffIcon(kind: HandoffKind): LucideIcon {
  return kind === 'credential' || kind === 'two_factor'
    ? KeyRound
    : MonitorSmartphone;
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
        <ApprovalTile tone="handoff" icon={handoffIcon(result.kind)} />
        <div className="approval-title">
          <strong>Your turn on the computer</strong>
        </div>
        <span className="approval-badge is-pending">Waiting for you</span>
      </header>
      <p className="approval-reason">{result.reason}</p>
      <p className="approval-hint">{HANDOFF_HINT}</p>
      {onViewComputer && (
        <div className="approval-footer">
          <div className="approval-buttons">
            <button
              type="button"
              className="approval-btn is-primary"
              onClick={onViewComputer}
            >
              <MonitorSmartphone size={14} aria-hidden="true" />
              Open live computer
            </button>
          </div>
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
    <section
      className={`approval-card is-${statusTone(status)}`}
      aria-label="Approval request"
    >
      <header className="approval-head">
        <ApprovalTile tone={statusTone(status)} icon={statusIcon(status)} />
        <div className="approval-title">
          <strong>{approvalTitle(status)}</strong>
          {advisory && <AdvisoryChip />}
        </div>
        <ApprovalBadge status={status} />
      </header>
      <ApprovalParts
        summary={approval?.summary || asked.summary}
        exact={approval?.argsRedacted || asked.exact}
        tool={approval?.tool}
      />
      {advisory && <p className="approval-hint">{ADVISORY_NOTE}</p>}
      {approval?.note && status !== 'pending' && (
        <p className="approval-note">Your note: {approval.note}</p>
      )}
      {status === 'pending' && onDecide && asked.approvalId && (
        <ApprovalDecision id={asked.approvalId} onDecide={onDecide} />
      )}
    </section>
  );
}
