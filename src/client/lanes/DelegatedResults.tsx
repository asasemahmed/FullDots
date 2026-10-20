// What teammates handed back: the "Delegated work" turn shows as one card per teammate (folded to a
// summary, the whole result one click away), and the reply built from them names who it used.
import { useState, type CSSProperties, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { LaneProgress } from '../../shared/lanes';
import { Mascot, dotPalette, dotLook } from '../Mascot';
import { deliveredWith } from './lane-model';
import { useLanesContext, type LanesValue } from './lanes-context';
import { runResultLanes } from './team-run-model';
import './lanes.css';

const STATUS: Record<string, string> = {
  done: 'Done',
  failed: 'Could not finish',
  stopped: 'Stopped by you',
};

/** The cards of a "Delegated work" turn, or `fallback` when the lanes do not know its results. */
export function DelegatedWork({
  refId,
  fallback,
}: {
  refId: string;
  fallback: ReactNode;
}) {
  const lanes = useLanesContext();
  // A team run's results (its ref is the run) or the hand-offs delivered together.
  const group = lanes
    ? (runResultLanes(refId, lanes.runs, lanes.lanes) ??
      deliveredWith(refId, lanes.lanes))
    : [];
  if (!lanes || !group.length) return <>{fallback}</>;
  return (
    <div
      className="fd-results"
      role="group"
      aria-label="Results from teammates"
    >
      <span className="fd-results-label">
        {group.length === 1
          ? 'A teammate reported back'
          : `${group.length} teammates reported back`}
      </span>
      {group.map((lane) => (
        <ResultCard key={lane.id} lane={lane} lanes={lanes} />
      ))}
    </div>
  );
}

function ResultCard({
  lane,
  lanes,
}: {
  lane: LaneProgress;
  lanes: LanesValue;
}) {
  const member = lanes.dot(lane.childDotId);
  const name = member?.name ?? 'A teammate';
  const palette = dotPalette(member ?? { id: lane.childDotId });
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<string>();
  const [error, setError] = useState('');
  const whole = lane.resultLength > (lane.result?.length ?? 0);
  const show = async () => {
    setOpen(!open);
    if (open || full !== undefined || !whole) return;
    try {
      setFull(await lanes.loadResult(lane.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the result.');
    }
  };
  const body = full ?? lane.result ?? '';
  return (
    <article
      className={`fd-result-card is-${lane.status}`}
      style={
        {
          '--lane': palette.base,
          '--lane-light': palette.light,
        } as CSSProperties
      }
      aria-label={`${name}: ${STATUS[lane.status] ?? lane.status}`}
    >
      <header className="fd-result-head">
        <Mascot
          identity={lane.childDotId}
          {...dotLook(member)}
          name={name}
          small
          decorative
          state={
            lane.status === 'done'
              ? 'complete'
              : lane.status === 'stopped'
                ? 'stopped'
                : 'needs-input'
          }
        />
        <strong>{name}</strong>
        <span className="fd-result-status">{STATUS[lane.status]}</span>
      </header>
      {open ? (
        <div className="fd-result-body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{ img: ({ alt }) => <span>{alt}</span> }}
          >
            {body}
          </ReactMarkdown>
          {error && <p className="fd-result-error">{error}</p>}
        </div>
      ) : (
        <p className="fd-result-summary">
          {lane.preview.length ? lane.preview.join(' · ') : lane.brief}
        </p>
      )}
      <div className="fd-result-actions">
        {(lane.result || whole) && (
          <button
            type="button"
            className="fd-lane-link"
            aria-expanded={open}
            onClick={() => void show()}
          >
            {open ? 'Fold the result' : 'Show full result'}
          </button>
        )}
        {lanes.onOpenThread && (
          <button
            type="button"
            className="fd-lane-link"
            onClick={() => lanes.onOpenThread?.(lane.childThreadId)}
          >
            Open {name}’s chat
          </button>
        )}
      </div>
    </article>
  );
}

/** "Built from: Marketer, Engineer" under the reply that used the teammates' results. */
export function BuiltFrom({ refId }: { refId: string }) {
  const lanes = useLanesContext();
  if (!lanes) return null;
  const used = (
    runResultLanes(refId, lanes.runs, lanes.lanes) ??
    deliveredWith(refId, lanes.lanes)
  ).filter((lane) => lane.status === 'done');
  if (!used.length) return null;
  return (
    <p className="fd-built-from">
      <span>Built from:</span>
      {used.map((lane) => {
        const member = lanes.dot(lane.childDotId);
        const name = member?.name ?? 'A teammate';
        return (
          <span
            key={lane.id}
            className="fd-built-chip"
            style={
              {
                '--lane': dotPalette(member ?? { id: lane.childDotId }).base,
              } as CSSProperties
            }
          >
            <Mascot
              identity={lane.childDotId}
              {...dotLook(member)}
              name={name}
              small
              decorative
              state="complete"
            />
            {name}
          </span>
        );
      })}
    </p>
  );
}
