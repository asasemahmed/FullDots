// The work band: drawn where a Dot handed work to teammates, one lane per hand-off, live while they
// work and folded into result chips once they are done. Lanes read the progress endpoint (see
// useLanes); only a lane the owner expands connects to the teammate's live chat.
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import type { ToolCall } from '@ag-ui/core';
import {
  ChevronDown,
  ExternalLink,
  Hand,
  RotateCcw,
  Square,
  Undo2,
} from 'lucide-react';
import type { LaneProgress } from '../../shared/lanes';
import type { Dot } from '../../shared/types';
import { ApprovalCard } from '../ApprovalCard';
import { Mascot, dotPalette, dotLook } from '../Mascot';
import {
  bandLanes,
  bandSettled,
  formatElapsed,
  formatTokens,
  handOffCalls,
  laneElapsed,
  laneView,
  type HandOffCall,
} from './lane-model';
// Loaded when a lane is first expanded: it brings the CopilotKit agent machinery with it.
const LaneTranscript = lazy(() =>
  import('./LaneTranscript').then((module) => ({
    default: module.LaneTranscript,
  })),
);
import { useLanesContext, type LanesValue } from './lanes-context';
import { useNow } from './useNow';
import './lanes.css';

/** How long the hand-off packet flies, and the gap between two packets. */
export const PACKET_MS = 600;
export const PACKET_STAGGER_MS = 160;

const reducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const colors = (dot: Pick<Dot, 'id' | 'color'>) => {
  const palette = dotPalette(dot);
  return {
    '--lane': palette.base,
    '--lane-light': palette.light,
    '--lane-dark': palette.dark,
  } as CSSProperties;
};

export const names = (list: string[]) =>
  list.length <= 1
    ? (list[0] ?? '')
    : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;

/** Draws a band for a turn's `delegate_to_dot` / `check_delegation` calls. */
export function WorkBand({
  calls,
  results,
}: {
  calls: ToolCall[];
  results: ReadonlyMap<string, string>;
}) {
  const lanes = useLanesContext();
  const handOffs = handOffCalls(calls, results);
  if (!handOffs.length)
    return (
      <p className="fd-band-note">
        Checked on {calls.length === 1 ? 'a teammate’s' : 'teammates’'} work
      </p>
    );
  // Outside a chat that tracks lanes (a teammate's transcript inside a lane): a plain line.
  if (!lanes)
    return (
      <p className="fd-band-note">
        Handed work to {names(handOffs.map((call) => call.to || 'a teammate'))}
      </p>
    );
  return <Band handOffs={handOffs} lanes={lanes} />;
}

function Band({
  handOffs,
  lanes,
}: {
  handOffs: HandOffCall[];
  lanes: LanesValue;
}) {
  const entries = bandLanes(handOffs, lanes.lanes);
  // A band of refused hand-offs only has nothing to fold.
  const settled =
    entries.some(({ lane }) => lane) && bandSettled(entries, lanes.skipped);
  const [open, setOpen] = useState(false);
  const active = entries.some(
    ({ lane }) => lane && !laneView(lane, '').finished,
  );
  const now = useNow(active);
  const band = useRef<HTMLDivElement>(null);
  const sender = useRef<HTMLSpanElement>(null);
  const [handing, setHanding] = useState(false);
  const handingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(handingTimer.current), []);
  const senderDot =
    lanes.dot(entries.find(({ lane }) => lane)?.lane?.parentDotId ?? '') ??
    lanes.hostDot;
  const memberName = (entry: { call: HandOffCall; lane?: LaneProgress }) =>
    (entry.lane && lanes.dot(entry.lane.childDotId)?.name) ||
    entry.call.to ||
    'A teammate';
  const freshIds = entries
    .map(({ lane }) => lane?.id)
    .filter((id): id is string => !!id && lanes.fresh.has(id));
  const freshKey = freshIds.join(',');

  // The hand-off: a packet in the sender's colour flies from the sender to each new lane.
  useLayoutEffect(() => {
    if (!freshKey) return;
    const ids = freshKey.split(',');
    lanes.played(ids);
    const root = band.current;
    const from = sender.current;
    if (!root || !from || reducedMotion()) return;
    setHanding(true);
    const box = root.getBoundingClientRect();
    const start = from.getBoundingClientRect();
    ids.forEach((id, index) => {
      const target = root.querySelector<HTMLElement>(
        `[data-lane="${CSS.escape(id)}"] .fd-lane-avatar`,
      );
      if (!target || typeof root.animate !== 'function') return;
      const end = target.getBoundingClientRect();
      const packet = document.createElement('span');
      packet.className = 'fd-packet';
      packet.setAttribute('aria-hidden', 'true');
      root.appendChild(packet);
      const x0 = start.left + start.width / 2 - box.left - 7;
      const y0 = start.top + start.height / 2 - box.top - 7;
      const x1 = end.left + end.width / 2 - box.left - 7;
      const y1 = end.top + end.height / 2 - box.top - 7;
      const animation = packet.animate(
        [
          { transform: `translate(${x0}px, ${y0}px) scale(0.6)`, opacity: 0 },
          {
            transform: `translate(${(x0 + x1) / 2 + 24}px, ${(y0 + y1) / 2}px) scale(1.15)`,
            opacity: 1,
            offset: 0.5,
          },
          { transform: `translate(${x1}px, ${y1}px) scale(0.4)`, opacity: 0 },
        ],
        {
          duration: PACKET_MS,
          delay: index * PACKET_STAGGER_MS,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'both',
        },
      );
      // Packets remove themselves; one still flying when the band unmounts goes with it.
      animation.onfinish = () => packet.remove();
      animation.oncancel = () => packet.remove();
    });
    clearTimeout(handingTimer.current);
    handingTimer.current = setTimeout(
      () => setHanding(false),
      PACKET_MS + ids.length * PACKET_STAGGER_MS,
    );
    // `lanes` changes every render; the animation runs once per new set of lanes.
  }, [freshKey]);

  const showLanes = !settled || open;
  const done = entries.filter(({ lane }) => lane?.status === 'done').length;
  const count = (statuses: string[]) =>
    entries.filter(({ lane }) => lane && statuses.includes(lane.status)).length;
  const working = count(['working']);
  const waiting = count(['queued', 'waiting']);
  return (
    <div
      ref={band}
      className={`fd-band ${settled ? 'is-settled' : 'is-live'}`}
      style={colors(senderDot)}
    >
      <div className="fd-band-head">
        <span className="fd-band-sender" ref={sender}>
          <Mascot
            identity={senderDot.id}
            {...dotLook(senderDot)}
            name={senderDot.name}
            small
            decorative
            state={handing ? 'handing-off' : 'idle'}
          />
        </span>
        <p className="fd-band-title">
          <strong>{senderDot.name}</strong> handed work to{' '}
          {names(entries.map(memberName))}
        </p>
        <span className="fd-band-count">
          {settled
            ? `${done} of ${entries.length} done`
            : [working && `${working} working`, waiting && `${waiting} waiting`]
                .filter(Boolean)
                .join(' · ')}
        </span>
      </div>
      {showLanes ? (
        <div className="fd-band-lanes">
          {entries.map((entry) =>
            entry.lane ? (
              <Lane
                key={entry.call.callId}
                lane={entry.lane}
                lanes={lanes}
                now={now}
              />
            ) : (
              <PendingLane key={entry.call.callId} call={entry.call} />
            ),
          )}
        </div>
      ) : null}
      {settled && (
        <div className="fd-band-results">
          {!open && (
            <ul className="fd-band-chips" aria-label="Results">
              {entries.map((entry) => (
                <li key={entry.call.callId}>
                  <ResultChip
                    name={memberName(entry)}
                    lane={entry.lane}
                    dot={entry.lane && lanes.dot(entry.lane.childDotId)}
                    refused={entry.call.error}
                  />
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="fd-band-toggle"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? 'Fold the work' : 'Show the work'}
          </button>
        </div>
      )}
    </div>
  );
}

export function ResultChip({
  name,
  lane,
  dot,
  refused,
  label,
}: {
  name: string;
  lane?: LaneProgress;
  dot?: Dot;
  refused?: string;
  /** In place of the status the lane gives (a team run's reviewer: "Checked"). */
  label?: string;
}) {
  const status =
    label ??
    (refused
      ? 'Not handed over'
      : lane?.status === 'done'
        ? 'Done'
        : lane?.status === 'stopped'
          ? 'Stopped'
          : 'Skipped');
  return (
    <span
      className={`fd-result-chip is-${lane?.status ?? 'refused'}`}
      style={colors(dot ?? { id: lane?.childDotId ?? name })}
      title={refused}
    >
      <Mascot
        identity={dot?.id ?? lane?.childDotId}
        {...dotLook(dot)}
        name={name}
        small
        decorative
        state={lane ? laneView(lane, name).mascot : 'idle'}
      />
      <span className="fd-result-chip-name">{name}</span>
      <span className="fd-result-chip-status">{status}</span>
    </span>
  );
}

/** A hand-off whose call is still running (or was refused): no lane exists for it yet. */
function PendingLane({ call }: { call: HandOffCall }) {
  return (
    <div
      className={`fd-lane is-pending ${call.error ? 'is-refused' : ''}`}
      role="group"
      aria-label={`${call.to || 'A teammate'}: ${call.error ? 'not handed over' : 'handing over'}`}
    >
      <div className="fd-lane-head">
        <span className="fd-lane-who">
          <strong>{call.to || 'A teammate'}</strong>
          <span className="fd-lane-brief">{call.brief}</span>
        </span>
      </div>
      <p className="fd-lane-line">
        {call.error ? `Not handed over: ${call.error}` : 'Handing over…'}
      </p>
    </div>
  );
}

const BRIEF_FOLD = 110;

export function Lane({
  lane,
  lanes,
  now,
  mascot,
  tag,
}: {
  lane: LaneProgress;
  lanes: LanesValue;
  now: number;
  /** The character's state in place of the lane's (a team run's reviewer at work: reviewing). */
  mascot?: string;
  /** A short label next to the name ("Reviewer", "Revising"). */
  tag?: string;
}) {
  const member = lanes.dot(lane.childDotId);
  const name = member?.name ?? 'A teammate';
  const view = laneView(lane, name);
  const [briefOpen, setBriefOpen] = useState(false);
  const expanded = lanes.expanded.includes(lane.id);
  const busy = lanes.pending.has(lane.id) || lanes.pending.has('*');
  const skipped = lanes.skipped.has(lane.id);
  const approvalArea = useRef<HTMLDivElement>(null);
  const transcriptId = `fd-lane-chat-${lane.id}`;
  const briefId = `fd-lane-brief-${lane.id}`;
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    // Only on the lane itself, so typing in a note or a button press is never taken over.
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey)
      return;
    if (event.key === 'Enter') {
      event.preventDefault();
      lanes.toggle(lane.id);
    } else if ((event.key === 's' || event.key === 'S') && view.stoppable) {
      event.preventDefault();
      void lanes.stop(lane.id);
    } else if (event.key === 'a' || event.key === 'A') {
      const button = approvalArea.current?.querySelector<HTMLElement>(
        'button:not([disabled])',
      );
      if (button) {
        event.preventDefault();
        button.focus();
      }
    }
  };
  const elapsed = formatElapsed(laneElapsed(lane, lanes.receivedAt, now));
  const wait = lane.wait;
  const longBrief = lane.brief.length > BRIEF_FOLD;
  return (
    <section
      className={`fd-lane is-${lane.status} tone-${view.tone}${skipped ? ' is-skipped' : ''}`}
      data-lane={lane.id}
      role="group"
      aria-label={`${name}: ${view.line}`}
      aria-describedby={briefId}
      aria-keyshortcuts="Enter S A"
      tabIndex={0}
      onKeyDown={keys}
      style={colors(member ?? { id: lane.childDotId })}
    >
      <div className="fd-lane-head">
        <span className="fd-lane-avatar">
          <Mascot
            identity={lane.childDotId}
            {...dotLook(member)}
            name={name}
            small
            decorative
            state={mascot ?? view.mascot}
          />
        </span>
        <span className="fd-lane-who">
          <strong>
            {name}
            {tag && <span className="fd-lane-tag">{tag}</span>}
          </strong>
          <span
            id={briefId}
            className={`fd-lane-brief ${briefOpen ? 'is-open' : ''}`}
          >
            {lane.brief}
          </span>
        </span>
        <span className={`fd-lane-chip tone-${view.tone}`}>
          {view.chip}
          {lane.attempt > 1 && (
            <span className="fd-lane-attempt"> · try {lane.attempt}</span>
          )}
        </span>
      </div>
      {longBrief && (
        <button
          type="button"
          className="fd-lane-link"
          aria-expanded={briefOpen}
          aria-controls={briefId}
          onClick={() => setBriefOpen(!briefOpen)}
        >
          {briefOpen ? 'Less of the brief' : 'Whole brief'}
        </button>
      )}
      <p className="fd-lane-line">
        <span className="fd-lane-light" aria-hidden />
        <span>{skipped ? 'Failed · skipped' : view.line}</span>
        <span className="fd-lane-meta">
          {elapsed}
          {lane.tokens !== null && ` · ${formatTokens(lane.tokens)}`}
        </span>
      </p>
      {!view.finished && lane.preview.length > 0 && (
        <p className="fd-lane-preview" key={lane.preview.join('\n')}>
          {lane.preview.map((line, index) => (
            <span key={index}>{line}</span>
          ))}
        </p>
      )}
      {lane.status === 'failed' && !skipped && (
        <div className="fd-lane-problem">
          <p>{lane.result || 'The teammate could not finish.'}</p>
          <div className="fd-lane-buttons">
            <button
              type="button"
              className="fd-lane-button primary"
              disabled={busy}
              onClick={() => void lanes.retry(lane.id)}
            >
              <RotateCcw size={14} aria-hidden /> Try again
            </button>
            <button
              type="button"
              className="fd-lane-button"
              disabled={busy}
              onClick={() => lanes.skip(lane.id)}
            >
              <Undo2 size={14} aria-hidden /> Skip
            </button>
          </div>
        </div>
      )}
      {lane.status === 'stopped' && (
        <div className="fd-lane-buttons">
          <button
            type="button"
            className="fd-lane-button"
            disabled={busy}
            onClick={() => void lanes.retry(lane.id)}
          >
            <RotateCcw size={14} aria-hidden /> Try again
          </button>
        </div>
      )}
      {wait?.kind === 'approval' && (
        <div className="fd-lane-approval" ref={approvalArea}>
          <ApprovalCard
            result={{
              status: 'pending_approval',
              approvalId: wait.approval.id,
              summary: wait.approval.summary,
              exact: wait.approval.argsRedacted,
            }}
            approval={wait.approval}
            onDecide={lanes.decide}
          />
        </div>
      )}
      {wait?.kind === 'handoff' && (
        <div className="fd-lane-handoff" ref={approvalArea}>
          <p>{wait.handoff.reason}</p>
          <button
            type="button"
            className="fd-lane-button primary"
            disabled={busy}
            onClick={() => void lanes.takeOver(lane)}
          >
            <Hand size={14} aria-hidden /> Take over
          </button>
        </div>
      )}
      <div className="fd-lane-actions">
        {view.stoppable && (
          <button
            type="button"
            className="fd-lane-button"
            disabled={busy}
            aria-label={`Stop ${name}`}
            onClick={() => void lanes.stop(lane.id)}
          >
            <Square size={12} aria-hidden /> Stop
          </button>
        )}
        {lanes.onOpenThread && (
          <button
            type="button"
            className="fd-lane-button"
            onClick={() => lanes.onOpenThread?.(lane.childThreadId)}
          >
            <ExternalLink size={13} aria-hidden /> Open chat
          </button>
        )}
        <button
          type="button"
          className="fd-lane-button fd-lane-expand"
          aria-expanded={expanded}
          aria-controls={transcriptId}
          aria-label={`${expanded ? 'Hide' : 'Show'} ${name}’s chat here`}
          title={expanded ? 'Hide the chat' : 'Watch the chat here'}
          onClick={() => lanes.toggle(lane.id)}
        >
          <ChevronDown size={15} aria-hidden />
        </button>
      </div>
      {expanded && (
        <Suspense
          fallback={
            <p className="fd-lane-transcript-note">Opening {name}’s chat…</p>
          }
        >
          <LaneTranscript id={transcriptId} lane={lane} name={name} />
        </Suspense>
      )}
    </section>
  );
}
