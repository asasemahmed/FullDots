import { Globe, LoaderCircle, MonitorOff } from 'lucide-react';
import type { Frame } from '../computer-input';
import { ComputerScreen } from '../ComputerScreen';
import type { StreamPhase } from '../useComputerStream';
import { displayUrl, type Activity } from './model';

export type Snapshot = {
  base64: string;
  width: number;
  height: number;
  url: string;
  capturedAt: number;
};
export type PagePosition = { url: string; title?: string };

/** Small, quiet labels laid over the corners of the screen. They never take clicks. */
export function ScreenOverlay({
  phase,
  page,
  activity,
  dotName,
  capturedAt,
}: {
  /** `snapshot` is the fallback picture, not the live screen. */
  phase: 'live' | 'reconnecting' | 'paused' | 'snapshot';
  page?: PagePosition;
  activity?: Activity;
  dotName: string;
  capturedAt?: number;
}) {
  const badge =
    phase === 'live'
      ? { label: 'LIVE', tone: 'live' }
      : phase === 'reconnecting'
        ? { label: 'Reconnecting…', tone: 'wait' }
        : phase === 'paused'
          ? { label: 'Paused', tone: 'idle' }
          : { label: 'Snapshot', tone: 'idle' };
  const where = page?.url ? displayUrl(page.url) : '';
  const heading = page?.title?.trim() || where;
  return (
    <div className="cp-overlay">
      <div className="cp-overlay-top">
        <span
          className={`cp-badge cp-badge-${badge.tone}`}
          role="status"
          title={
            phase === 'snapshot' && capturedAt
              ? `Updated ${new Date(capturedAt).toLocaleTimeString()}`
              : undefined
          }
        >
          <i aria-hidden="true" />
          {badge.label}
        </span>
        {heading && (
          <span className="cp-page" title={page?.url}>
            <Globe size={11} aria-hidden="true" />
            <span className="cp-page-title">{heading}</span>
            {page?.title?.trim() && where && (
              <span className="cp-page-url">{where}</span>
            )}
          </span>
        )}
      </div>
      {activity && (
        <div className="cp-overlay-bottom">
          <span className="cp-activity" role="status">
            <i aria-hidden="true" />
            {dotName} is {activity.verb}…
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * The computer's screen, as wide as the panel, with the picture kept in proportion.
 *
 * The live canvas is always mounted so it can connect; when it cannot show anything yet, or has
 * given up, a still picture or a plain placeholder stands in its place.
 */
export function ScreenStage({
  dotId,
  dotName,
  browser,
  human,
  typeChars,
  streamKey,
  stream,
  snapshot,
  snapshotError,
  page,
  activity,
  busy,
  onPhase,
  onFrameSize,
  onRetryStream,
  onClickSnapshot,
  onOpenSettings,
}: {
  dotId: string;
  dotName: string;
  /** Browser permission is on. */
  browser: boolean;
  /** The owner holds control. */
  human: boolean;
  typeChars: number;
  streamKey: number;
  stream: StreamPhase;
  snapshot?: Snapshot;
  snapshotError: string;
  page?: PagePosition;
  activity?: Activity;
  busy: boolean;
  onPhase: (phase: StreamPhase) => void;
  onFrameSize: (size: Frame | undefined) => void;
  onRetryStream: () => void;
  onClickSnapshot: (point: { x: number; y: number }) => void;
  onOpenSettings: () => void;
}) {
  const liveShown =
    browser &&
    (stream.phase === 'live' ||
      stream.phase === 'reconnecting' ||
      stream.phase === 'paused');
  const over =
    stream.phase === 'failed' || stream.phase === 'ended' ? stream : undefined;
  const gaveUp = !!over;
  return (
    <>
      <div
        className={`cp-stage${human ? ' is-human' : ''}`}
        data-stage={
          !browser ? 'off' : liveShown ? 'live' : snapshot ? 'snapshot' : 'wait'
        }
      >
        {browser && (
          <ComputerScreen
            key={streamKey}
            dotId={dotId}
            dotName={dotName}
            interactive={human}
            typeChars={typeChars}
            onPhase={onPhase}
            onFrameSize={onFrameSize}
            overlay={
              <ScreenOverlay
                phase={
                  stream.phase === 'reconnecting' || stream.phase === 'paused'
                    ? stream.phase
                    : 'live'
                }
                page={page}
                activity={human ? undefined : activity}
                dotName={dotName}
              />
            }
          />
        )}
        {!browser ? (
          <div className="cp-placeholder">
            <MonitorOff size={22} aria-hidden="true" />
            <p>The browser is turned off, so there is no screen to show.</p>
            <button type="button" className="cp-btn" onClick={onOpenSettings}>
              Open settings
            </button>
          </div>
        ) : liveShown ? null : snapshot ? (
          <div className="cp-snapshot">
            <button
              type="button"
              className="cp-snapshot-button"
              aria-label={
                human
                  ? 'Click a point on the computer screen'
                  : 'Computer screen; take control to interact'
              }
              disabled={!human || busy}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                const at = (offset: number, shown: number, size: number) =>
                  Math.min(
                    size - 1,
                    Math.max(0, Math.floor((offset / shown) * size)),
                  );
                onClickSnapshot({
                  x: at(event.clientX - rect.left, rect.width, snapshot.width),
                  y: at(event.clientY - rect.top, rect.height, snapshot.height),
                });
              }}
            >
              <img
                src={`data:image/png;base64,${snapshot.base64}`}
                alt={`Browser screen for ${dotName}`}
              />
            </button>
            <ScreenOverlay
              phase="snapshot"
              page={{ url: snapshot.url, title: page?.title }}
              activity={human ? undefined : activity}
              dotName={dotName}
              capturedAt={snapshot.capturedAt}
            />
          </div>
        ) : (
          <div className="cp-placeholder" role="status">
            {gaveUp ? (
              <MonitorOff size={22} aria-hidden="true" />
            ) : (
              <LoaderCircle className="cp-spin" size={22} aria-hidden="true" />
            )}
            <p>
              {gaveUp
                ? 'The live screen is not available.'
                : 'Connecting to the screen…'}
            </p>
          </div>
        )}
      </div>
      {browser && (gaveUp || snapshotError) && (
        <div className="cp-notice" role="status">
          <span>{over ? over.message : snapshotError}</span>
          {over && (
            <button type="button" className="cp-link" onClick={onRetryStream}>
              {over.phase === 'ended' ? 'Watch here' : 'Retry live view'}
            </button>
          )}
        </div>
      )}
    </>
  );
}
