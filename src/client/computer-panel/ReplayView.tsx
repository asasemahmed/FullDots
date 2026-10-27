import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Globe,
  ImageOff,
  Radio,
  Settings,
} from 'lucide-react';
import '../computer-replay.css';
import { displayUrl } from './model';
import {
  STATE_LABELS,
  nextIndex,
  replayTurns,
  stepText,
  stepsOfTurn,
  type ReplayEntry,
} from './replay-model';
import { useReplay } from './useReplay';

export interface ReplayViewProps {
  dotName: string;
  entries: readonly ReplayEntry[];
  /** The conversation being replayed; without one there is nothing to show. */
  hasThread: boolean;
  /** Whether new pictures are being kept. Undefined while unknown. */
  replayOn?: boolean;
  loading?: boolean;
  error?: string;
  /** 0 is every turn. Defaults to the latest turn. */
  turn?: number;
  onTurn?: (turn: number) => void;
  /** Which step is shown. Defaults to the last one of the turn. */
  index?: number;
  onIndex?: (index: number) => void;
  frameUrl?: (frameId: string) => string | undefined;
  onJumpToLive: () => void;
  onOpenSettings?: () => void;
}

const PILLS: Record<ReplayEntry['state'], string> = {
  done: 'cp-pill-ok',
  failed: 'cp-pill-bad',
  running: 'cp-pill-warn',
  interrupted: '',
};

const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * A scrubber over the browser steps of a conversation: where the Dot was, what it did, whether it
 * worked, and the screen afterwards when a picture was kept. Drawn from props so every state renders
 * on its own; {@link ReplayPanel} supplies the data.
 */
export function ReplayView({
  dotName,
  entries,
  hasThread,
  replayOn,
  loading = false,
  error = '',
  turn,
  onTurn,
  index,
  onIndex,
  frameUrl,
  onJumpToLive,
  onOpenSettings,
}: ReplayViewProps) {
  const id = useId();
  const turns = replayTurns(entries);
  const chosenTurn =
    turn !== undefined && (turn === 0 || turns.includes(turn))
      ? turn
      : (turns.at(-1) ?? 0);
  const steps = stepsOfTurn(entries, chosenTurn);
  const total = steps.length;
  const current = Math.min(Math.max(index ?? total - 1, 0), total - 1);
  const step = total ? steps[current] : undefined;
  const picture = step?.frameId ? frameUrl?.(step.frameId) : undefined;
  const go = (next: number) => onIndex?.(next);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextIndex(event.key, current, total);
    if (next === undefined) return;
    event.preventDefault();
    go(next);
  };

  const head = (
    <div className="cp-replay-head">
      <h3 id={`${id}-title`}>Replay</h3>
      {turns.length > 1 && (
        <label className="cp-replay-turn">
          <span className="sr-only">Turn to replay</span>
          <select
            value={chosenTurn}
            onChange={(event) => {
              onTurn?.(Number(event.target.value));
              onIndex?.(Number.MAX_SAFE_INTEGER);
            }}
          >
            {turns.map((value) => (
              <option key={value} value={value}>
                {value === turns.at(-1)
                  ? `Latest request (${value})`
                  : `Request ${value}`}
              </option>
            ))}
            <option value={0}>Whole conversation</option>
          </select>
        </label>
      )}
      <button type="button" className="cp-btn" onClick={onJumpToLive}>
        <Radio size={14} aria-hidden="true" />
        Jump to live
      </button>
    </div>
  );

  if (!hasThread || !total)
    return (
      <section className="cp-replay" aria-labelledby={`${id}-title`}>
        {head}
        <p className="cp-replay-empty" role="status">
          {!hasThread
            ? `Open a conversation with ${dotName} to replay what it did on the computer.`
            : loading
              ? 'Loading the steps…'
              : error ||
                `${dotName} has not used the computer in this conversation yet.`}
        </p>
      </section>
    );

  return (
    <section className="cp-replay" aria-labelledby={`${id}-title`}>
      {head}
      {replayOn === false && (
        <p className="cp-replay-note">
          Pictures of new steps are off for {dotName}. The steps still show from
          the chat.
          {onOpenSettings && (
            <button
              type="button"
              className="cp-btn cp-btn-quiet"
              onClick={onOpenSettings}
            >
              <Settings size={13} aria-hidden="true" />
              Settings
            </button>
          )}
        </p>
      )}
      <figure className="cp-replay-frame" data-state={step!.state}>
        {picture ? (
          <img
            src={picture}
            alt={`The screen after step ${current + 1}: ${step!.label}${step!.detail ? `, ${step!.detail}` : ''}`}
          />
        ) : (
          <div className="cp-replay-noframe">
            <ImageOff size={22} aria-hidden="true" />
            <span>
              {step!.frameId
                ? 'Loading the picture…'
                : 'No picture was kept for this step.'}
            </span>
          </div>
        )}
      </figure>
      <div className="cp-replay-scrub">
        <button
          type="button"
          className="cp-icon-btn"
          aria-label="Previous step"
          disabled={current === 0}
          onClick={() => go(current - 1)}
        >
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <div
          className="cp-replay-track"
          role="slider"
          tabIndex={0}
          aria-label="Step"
          aria-valuemin={1}
          aria-valuemax={total}
          aria-valuenow={current + 1}
          aria-valuetext={stepText(step!, current, total)}
          aria-describedby={`${id}-step`}
          onKeyDown={onKeyDown}
        >
          {steps.map((entry, position) => (
            <span
              key={entry.toolCallId}
              className="cp-replay-tick"
              data-state={entry.state}
              data-frame={entry.frameId ? 'yes' : 'no'}
              data-current={position === current ? 'yes' : undefined}
              aria-hidden="true"
              title={stepText(entry, position, total)}
              onClick={() => go(position)}
            />
          ))}
        </div>
        <button
          type="button"
          className="cp-icon-btn"
          aria-label="Next step"
          disabled={current === total - 1}
          onClick={() => go(current + 1)}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="cp-replay-step" id={`${id}-step`}>
        <p className="cp-replay-what">
          <span className="cp-replay-count">
            {current + 1}/{total}
          </span>
          <strong>{step!.label}</strong>
          {step!.detail && <span> {step!.detail}</span>}
        </p>
        {(step!.url || step!.title) && (
          <p className="cp-replay-where" title={step!.url}>
            <Globe size={12} aria-hidden="true" />
            {step!.title && (
              <span className="cp-replay-title">{step!.title}</span>
            )}
            {step!.url && (
              <span className="cp-replay-url">{displayUrl(step!.url)}</span>
            )}
          </p>
        )}
        <p className="cp-replay-outcome">
          <span className={`cp-pill ${PILLS[step!.state]}`}>
            {STATE_LABELS[step!.state]}
          </span>
          {step!.message && <span>{step!.message}</span>}
          {step!.createdAt !== undefined && (
            <time dateTime={new Date(step!.createdAt).toISOString()}>
              {time(step!.createdAt)}
            </time>
          )}
        </p>
      </div>
    </section>
  );
}

/** The Replay tab with its data: the open conversation's steps and the pictures the server kept. */
export function ReplayPanel({
  dotId,
  dotName,
  threadId,
  onJumpToLive,
  onOpenSettings,
}: {
  dotId: string;
  dotName: string;
  threadId?: string;
  onJumpToLive: () => void;
  onOpenSettings?: () => void;
}) {
  const data = useReplay(dotId, threadId, true);
  const [turn, setTurn] = useState<number>();
  const [index, setIndex] = useState<number>();
  const turns = replayTurns(data.entries);
  const chosenTurn =
    turn !== undefined && (turn === 0 || turns.includes(turn))
      ? turn
      : (turns.at(-1) ?? 0);
  const steps = stepsOfTurn(data.entries, chosenTurn);
  const current = Math.min(index ?? steps.length - 1, steps.length - 1);
  const frameId = steps[current]?.frameId;
  const { loadFrame } = data;
  useEffect(() => {
    if (frameId) loadFrame(frameId);
  }, [frameId, loadFrame]);
  return (
    <ReplayView
      dotName={dotName}
      entries={data.entries}
      hasThread={!!threadId}
      replayOn={data.replayOn}
      loading={data.loading}
      error={data.error}
      turn={chosenTurn}
      onTurn={setTurn}
      index={current}
      onIndex={setIndex}
      frameUrl={data.frameUrl}
      onJumpToLive={onJumpToLive}
      onOpenSettings={onOpenSettings}
    />
  );
}
