import { useEffect, useId, useRef, useState } from 'react';
import {
  Check,
  ChevronRight,
  CircleAlert,
  Monitor,
  Square,
} from 'lucide-react';
import { computerStepIcon, type ComputerStep } from './ComputerToolCard';
import './chat-activity.css';

// How long the block keeps saying "Using the computer" after a step finishes
// while the run is still going, so it does not flicker between steps.
const LINGER_MS = 5000;

function useLingering(active: boolean, token: string) {
  // Lingering holds from the moment a step finishes until nothing new has
  // happened for LINGER_MS, with no render in between where it is off.
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setSettled(token), LINGER_MS);
    return () => clearTimeout(timer);
  }, [active, token]);
  return active && settled !== token;
}

// Wall-clock time is only known when the block was watched while it worked;
// blocks loaded from history have no timestamps, so they show no duration.
function useDuration(busy: boolean, progress: string) {
  const [timing, setTiming] = useState<{ start: number; end?: number } | null>(
    () => (busy ? { start: Date.now() } : null),
  );
  const lastProgress = useRef(0);
  useEffect(() => {
    lastProgress.current = Date.now();
  }, [progress]);
  useEffect(() => {
    setTiming((current) => {
      if (busy)
        return current
          ? current.end
            ? { start: current.start }
            : current
          : { start: Date.now() };
      if (current && !current.end)
        return { start: current.start, end: lastProgress.current };
      return current;
    });
  }, [busy]);
  return timing?.end ? timing.end - timing.start : undefined;
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return '';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}
const count = (n: number) => `${n} ${n === 1 ? 'step' : 'steps'}`;

function StateMark({ state }: { state: ComputerStep['state'] }) {
  if (state === 'running')
    return <span className="chat-activity-spinner" aria-hidden="true" />;
  if (state === 'failed') return <CircleAlert size={12} aria-hidden="true" />;
  if (state === 'interrupted') return <Square size={10} aria-hidden="true" />;
  return <Check size={12} aria-hidden="true" />;
}
const stateText = {
  running: 'In progress',
  done: 'Finished',
  failed: 'Failed',
  interrupted: 'Stopped',
};

export function ComputerActivity({
  steps,
  live,
  dotName,
  onViewLive,
  defaultExpanded = false,
}: {
  steps: ComputerStep[];
  /** The run is still going and this is its latest block. */
  live: boolean;
  dotName: string;
  onViewLive?: () => void;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const listId = useId();
  const total = steps.length;
  const running = steps.filter((step) => step.state === 'running');
  const failed = steps.filter((step) => step.state === 'failed').length;
  const stopped = steps.filter((step) => step.state === 'interrupted').length;
  const finished = steps.filter((step) => step.state !== 'running').length;
  const progress = `${total}:${finished}`;
  const lingering = useLingering(live && running.length === 0, progress);
  const busy = running.length > 0 || lingering;
  const duration = useDuration(busy, progress);
  const current = (running.at(-1) ?? steps.at(-1))?.label ?? '';
  const length = duration ? formatDuration(duration) : '';
  return (
    <div
      className={`chat-activity${busy ? ' is-live' : ''}${expanded ? ' is-open' : ''}`}
      role="group"
      aria-label={`${dotName}’s computer activity`}
    >
      <div className="chat-activity-bar">
        <button
          type="button"
          className="chat-activity-toggle"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="chat-activity-mark" aria-hidden="true">
            {busy ? (
              <span className="chat-activity-pulse" />
            ) : stopped && !failed ? (
              <Square size={10} />
            ) : (
              <Monitor size={13} />
            )}
          </span>
          <span className="chat-activity-title">
            {busy ? 'Using the computer' : 'Used the computer'}
          </span>
          {busy && current && (
            <>
              <span className="chat-activity-sep" aria-hidden="true">
                ·
              </span>
              <span className="chat-activity-current">{current}</span>
            </>
          )}
          <span className="chat-activity-sep" aria-hidden="true">
            ·
          </span>
          <span className="chat-activity-count">{count(total)}</span>
          {!busy && failed > 0 && (
            <>
              <span className="chat-activity-sep" aria-hidden="true">
                ·
              </span>
              <span className="chat-activity-warn">{failed} failed</span>
            </>
          )}
          {!busy && stopped > 0 && (
            <>
              <span className="chat-activity-sep" aria-hidden="true">
                ·
              </span>
              <span className="chat-activity-warn">stopped</span>
            </>
          )}
          {!busy && length && (
            <>
              <span className="chat-activity-sep" aria-hidden="true">
                ·
              </span>
              <span className="chat-activity-time">{length}</span>
            </>
          )}
          <ChevronRight
            className="chat-activity-chevron"
            size={14}
            aria-hidden="true"
          />
        </button>
        {onViewLive && (
          <button
            type="button"
            className="chat-activity-live"
            aria-label={`View ${dotName}’s computer live`}
            title="Open the computer panel"
            onClick={onViewLive}
          >
            <Monitor size={12} aria-hidden="true" />
            <span className="chat-activity-live-text">View live</span>
          </button>
        )}
      </div>
      {expanded && (
        <ol
          id={listId}
          className="chat-activity-steps"
          aria-label="Computer steps"
        >
          {steps.map((step) => {
            const Icon = computerStepIcon(step.name);
            return (
              <li
                key={step.id}
                className={`chat-activity-step is-${step.state}`}
              >
                <Icon
                  size={13}
                  className="chat-activity-step-icon"
                  aria-hidden="true"
                />
                <span className="chat-activity-step-label">{step.label}</span>
                <span
                  className="chat-activity-step-detail"
                  title={step.title || step.detail || undefined}
                >
                  {step.detail}
                </span>
                <span className="chat-activity-step-state">
                  <StateMark state={step.state} />
                  <span className="chat-activity-sr">
                    {stateText[step.state]}
                  </span>
                </span>
                {step.message && (
                  <span className="chat-activity-step-message">
                    {step.message}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
