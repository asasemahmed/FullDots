import type { ReactNode } from 'react';
import {
  ExternalLink,
  LoaderCircle,
  Lock,
  Monitor,
  Plug,
  Play,
  RefreshCw,
  WifiOff,
} from 'lucide-react';
import type { ComputerStatus } from '../../shared/computer-types';
import type { Working } from './PanelHeader';
import { COMPUTER_DOCS_URL, type PanelPhase } from './model';

/** One short message and, where there is something to do about it, one button. */
export function EmptyState({
  phase,
  dotName,
  status,
  error,
  working,
  onStart,
  onEnable,
  onRetry,
}: {
  phase: Exclude<PanelPhase, 'running'>;
  dotName: string;
  status?: ComputerStatus;
  error: string;
  working?: Working;
  onStart: () => void;
  /** Turns computer access on, then starts the computer unless it is already running. */
  onEnable: () => void;
  onRetry: () => void;
}) {
  const starting = working === 'start';
  let icon: ReactNode = <Monitor size={26} aria-hidden="true" />;
  let title = '';
  let text: ReactNode = '';
  let action: ReactNode = null;
  switch (phase) {
    case 'loading':
      return (
        <div className="cp-empty" role="status">
          <LoaderCircle className="cp-spin" size={22} aria-hidden="true" />
          <p>Loading computer…</p>
        </div>
      );
    case 'unreachable':
      icon = <WifiOff size={26} aria-hidden="true" />;
      title = 'Can’t reach the computer';
      text = error || 'Check your connection and try again.';
      action = (
        <button type="button" className="cp-btn" onClick={onRetry}>
          <RefreshCw size={14} aria-hidden="true" />
          Try again
        </button>
      );
      break;
    case 'not_configured':
      icon = <Plug size={26} aria-hidden="true" />;
      title = 'No computer is set up';
      text = `Connect a computer service to give ${dotName} its own browser and files.`;
      action = (
        <a
          className="cp-btn"
          href={COMPUTER_DOCS_URL}
          target="_blank"
          rel="noreferrer"
        >
          Setup guide
          <ExternalLink size={13} aria-hidden="true" />
        </a>
      );
      break;
    case 'unavailable':
      icon = <WifiOff size={26} aria-hidden="true" />;
      title = 'Computer unavailable';
      text = status?.error ?? 'The computer service did not answer.';
      action = (
        <button type="button" className="cp-btn" onClick={onRetry}>
          <RefreshCw size={14} aria-hidden="true" />
          Try again
        </button>
      );
      break;
    case 'disabled':
      icon = <Lock size={26} aria-hidden="true" />;
      title = 'Computer access is off';
      text = `Turn it on to let you and ${dotName} use a browser, files and a terminal.`;
      action = (
        <button
          type="button"
          className="cp-btn cp-btn-primary cp-btn-large"
          onClick={onEnable}
          disabled={starting}
        >
          <Play size={15} aria-hidden="true" />
          {starting
            ? 'Starting…'
            : status?.state === 'running'
              ? 'Turn on access'
              : 'Turn on and start'}
        </button>
      );
      break;
    case 'stopped':
      title = `${dotName}’s computer is stopped`;
      text = `Start it to watch ${dotName} work and step in when you need to.`;
      action = (
        <>
          <button
            type="button"
            className="cp-btn cp-btn-primary cp-btn-large"
            onClick={onStart}
            disabled={starting}
          >
            <Play size={15} aria-hidden="true" />
            {starting ? 'Starting…' : 'Start computer'}
          </button>
          <button type="button" className="cp-link" onClick={onRetry}>
            Check again
          </button>
        </>
      );
      break;
  }
  return (
    <div className="cp-empty">
      <span className="cp-empty-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action && <div className="cp-empty-actions">{action}</div>}
    </div>
  );
}
