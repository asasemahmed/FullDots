// A team run's work band: drawn where the lead called start_team_run (or where a direct team chat
// sent the owner's message), one lane per member in member order. Step by step shows the later
// steps waiting in order with a connector between lanes. In a review run the members' lanes fold
// into "3 results, under review by Critic" while the reviewer's lane is full size, and the band
// shows "Checked by Critic" or "Sent back" once the reviewer has spoken.
import { Fragment, useState, type ReactNode } from 'react';
import type { ToolCall } from '@ag-ui/core';
import { ArrowDown, ShieldCheck, Undo2 } from 'lucide-react';
import type { TeamRunBand as RunBandData } from '../../shared/teams';
import { Mascot, dotLook } from '../Mascot';
import { laneView } from './lane-model';
import { useLanesContext, type LanesValue } from './lanes-context';
import {
  reviewBadge,
  reviewerEntry,
  runCall,
  runPhase,
  waitingLine,
  workerEntries,
  type StepEntry,
} from './team-run-model';
import { useNow } from './useNow';
import { colors, Lane, names, ResultChip } from './WorkBand';
import './lanes.css';
import './team-run.css';

export function TeamRunBand({
  call,
  result,
}: {
  call: ToolCall;
  result: string | undefined;
}) {
  const lanes = useLanesContext();
  const parsed = runCall(call, result);
  if (parsed.pending)
    return <p className="fd-band-note">Putting the team to work…</p>;
  if (parsed.error)
    return (
      <p className="fd-band-note is-refused">
        The team run did not start: {parsed.error}
      </p>
    );
  const run = parsed.runId
    ? lanes?.runs?.find((item) => item.id === parsed.runId)
    : undefined;
  // Outside a chat that tracks lanes (a teammate's transcript inside a lane): a plain line.
  if (!lanes || !run)
    return (
      <p className="fd-band-note">
        Put the team to work
        {parsed.members.length ? `: ${names(parsed.members)}` : ''}
      </p>
    );
  return <RunBand run={run} lanes={lanes} />;
}

function RunBand({ run, lanes }: { run: RunBandData; lanes: LanesValue }) {
  const [open, setOpen] = useState(false);
  const phase = runPhase(run);
  const settled = phase === 'settled';
  const workers = workerEntries(run, lanes.lanes);
  const reviewer = reviewerEntry(run, lanes.lanes);
  const active = [...workers, ...(reviewer ? [reviewer] : [])].some(
    ({ lane }) => lane && !laneView(lane, '').finished,
  );
  const now = useNow(active);
  const lead = lanes.dot(run.leadDotId) ?? lanes.hostDot;
  const name = (id: string) => lanes.dot(id)?.name ?? 'A teammate';
  const reviewerName = reviewer ? name(reviewer.step.dotId) : '';
  const badge = reviewBadge(run, reviewerName);
  const sequential = run.style === 'sequential';
  const done = workers.filter(({ step }) => step.status === 'done').length;
  const working = workers.filter(
    ({ lane }) => lane?.status === 'working',
  ).length;
  const waiting = workers.filter(
    ({ step, lane }) =>
      step.status === 'queued' ||
      lane?.status === 'queued' ||
      lane?.status === 'waiting',
  ).length;
  const team = `${run.teamEmoji} ${run.teamName}`;

  const stepCard = (entry: StepEntry, index: number, tag?: string) => {
    // While members revise, the reviewer's first check is done but its last one is still to come.
    const later = entry.step.role === 'reviewer' && phase === 'revising';
    if (entry.lane && !later)
      return (
        <Lane
          lane={entry.lane}
          lanes={lanes}
          now={now}
          {...(tag ? { tag } : {})}
          {...(entry.step.role === 'reviewer' && entry.lane.status === 'working'
            ? { mascot: 'reviewing' }
            : {})}
        />
      );
    const previous = index > 0 ? workers[index - 1] : undefined;
    return (
      <WaitingStep
        entry={entry}
        name={name(entry.step.dotId)}
        lanes={lanes}
        line={
          entry.step.role === 'reviewer'
            ? phase === 'revising'
              ? 'Checks again when the revisions are in'
              : 'Checks the work when every member is done'
            : waitingLine(
                entry,
                previous && name(previous.step.dotId),
                sequential,
              )
        }
        {...(tag ? { tag } : {})}
      />
    );
  };

  const workerLanes = (
    <div
      className={`fd-band-lanes${sequential ? ' is-sequence' : ''}`}
      aria-label={sequential ? 'Steps, in order' : undefined}
      role={sequential ? 'list' : undefined}
    >
      {workers.map((entry, index) => (
        <Fragment key={entry.step.dotId}>
          {sequential && index > 0 && (
            <span className="fd-run-connector" aria-hidden>
              <ArrowDown size={14} />
            </span>
          )}
          {sequential ? (
            <div role="listitem" className="fd-run-step">
              {stepCard(entry, index, `Step ${index + 1}`)}
            </div>
          ) : (
            stepCard(
              entry,
              index,
              entry.step.firstDelegationId ? 'Revised' : undefined,
            )
          )}
        </Fragment>
      ))}
    </div>
  );

  let body: ReactNode = null;
  if (!settled && phase === 'reviewing' && reviewer) {
    // The members' work is in: it folds under the reviewer, whose lane is full size.
    body = (
      <>
        <div
          className="fd-run-review-fold"
          role="group"
          aria-label={`${done} ${done === 1 ? 'result' : 'results'}, under review by ${reviewerName}`}
        >
          <ul className="fd-band-chips" aria-hidden>
            {workers.map((entry) => (
              <li key={entry.step.dotId}>
                <ResultChip
                  name={name(entry.step.dotId)}
                  {...(entry.lane ? { lane: entry.lane } : {})}
                  {...(lanes.dot(entry.step.dotId)
                    ? { dot: lanes.dot(entry.step.dotId)! }
                    : {})}
                />
              </li>
            ))}
          </ul>
          <p className="fd-run-review-line">
            <ShieldCheck size={14} aria-hidden /> {done}{' '}
            {done === 1 ? 'result' : 'results'}, under review by{' '}
            <strong>{reviewerName}</strong>
          </p>
        </div>
        <div className="fd-band-lanes fd-run-reviewer">
          {stepCard(reviewer, workers.length, 'Reviewer')}
        </div>
      </>
    );
  } else if (!settled || open) {
    body = (
      <>
        {workerLanes}
        {reviewer && (
          <div className="fd-band-lanes fd-run-reviewer">
            {stepCard(reviewer, workers.length, 'Reviewer')}
          </div>
        )}
      </>
    );
  }

  return (
    <div
      className={`fd-band fd-run-band ${settled ? 'is-settled' : 'is-live'} phase-${phase}`}
      style={colors(lead)}
      data-run={run.id}
    >
      <div className="fd-band-head">
        <span className="fd-band-sender">
          <Mascot
            identity={lead.id}
            {...dotLook(lead)}
            name={lead.name}
            small
            decorative
            state={settled ? 'idle' : 'working'}
          />
        </span>
        <p className="fd-band-title">
          {run.mode === 'direct' ? (
            <>
              Sent to <strong>{team}</strong>
            </>
          ) : (
            <>
              <strong>{lead.name}</strong> put <strong>{team}</strong> to work
            </>
          )}
          {sequential && <span className="fd-run-style"> · step by step</span>}
        </p>
        <span className="fd-band-count">
          {settled
            ? `${done} of ${workers.length} done`
            : phase === 'reviewing'
              ? `Under review by ${reviewerName}`
              : [
                  working && `${working} working`,
                  waiting && `${waiting} waiting`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
        </span>
      </div>
      {badge && (
        <p
          className={`fd-run-badge is-${badge.tone}`}
          role="status"
          aria-live="polite"
        >
          {badge.tone === 'sent-back' ? (
            <Undo2 size={13} aria-hidden />
          ) : (
            <ShieldCheck size={13} aria-hidden />
          )}
          {badge.text}
          {badge.tone === 'checked' && run.sentBack && (
            <span className="fd-run-badge-note"> · sent back once</span>
          )}
        </p>
      )}
      {body}
      {settled && (
        <div className="fd-band-results">
          {!open && (
            <ul className="fd-band-chips" aria-label="Results">
              {workers.map((entry) => (
                <li key={entry.step.dotId}>
                  <ResultChip
                    name={name(entry.step.dotId)}
                    {...(entry.lane ? { lane: entry.lane } : {})}
                    {...(lanes.dot(entry.step.dotId)
                      ? { dot: lanes.dot(entry.step.dotId)! }
                      : {})}
                    {...(entry.lane
                      ? {}
                      : {
                          label:
                            entry.step.status === 'cancelled'
                              ? 'Stopped'
                              : 'Skipped',
                        })}
                  />
                </li>
              ))}
              {reviewer && (
                <li>
                  <ResultChip
                    name={reviewerName}
                    {...(reviewer.lane ? { lane: reviewer.lane } : {})}
                    {...(lanes.dot(reviewer.step.dotId)
                      ? { dot: lanes.dot(reviewer.step.dotId)! }
                      : {})}
                    label={
                      reviewer.step.status === 'done'
                        ? 'Checked'
                        : 'Not reviewed'
                    }
                  />
                </li>
              )}
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

/** A step that has no lane yet (or never got one): who, its brief, and why it waits. */
function WaitingStep({
  entry,
  name,
  lanes,
  line,
  tag,
}: {
  entry: StepEntry;
  name: string;
  lanes: LanesValue;
  line: string;
  tag?: string;
}) {
  const dot = lanes.dot(entry.step.dotId);
  return (
    <section
      className={`fd-lane is-queued is-step-${entry.step.status}`}
      role="group"
      aria-label={`${name}: ${line}`}
      tabIndex={0}
      style={colors(dot ?? { id: entry.step.dotId })}
    >
      <div className="fd-lane-head">
        <span className="fd-lane-avatar">
          <Mascot
            identity={entry.step.dotId}
            {...dotLook(dot)}
            name={name}
            small
            decorative
            state={entry.step.status === 'queued' ? 'idle' : 'stopped'}
          />
        </span>
        <span className="fd-lane-who">
          <strong>
            {name}
            {tag && <span className="fd-lane-tag">{tag}</span>}
          </strong>
          <span className="fd-lane-brief">{entry.step.brief}</span>
        </span>
        <span className="fd-lane-chip tone-neutral">
          {entry.step.status === 'queued' ? 'Waiting' : 'Not run'}
        </span>
      </div>
      <p className="fd-lane-line">
        <span className="fd-lane-light" aria-hidden />
        <span>{line}</span>
      </p>
    </section>
  );
}
