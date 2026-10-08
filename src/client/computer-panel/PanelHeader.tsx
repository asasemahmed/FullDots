import type { Ref } from 'react';
import { Power, Settings, X } from 'lucide-react';
import type { Dot } from '../../shared/types';
import { Mascot } from '../Mascot';
import { HANDOFF_PILL, PHASE_PILL, type PanelPhase } from './model';

export type Working = 'start' | 'stop' | 'take' | 'release';

/** Who the computer belongs to, whether it is on, and the two things worth a button up here. */
export function PanelHeader({
  dot,
  phase,
  working,
  needsYou = false,
  settingsOpen,
  settingsDisabled = false,
  settingsId,
  gearRef,
  onToggleSettings,
  onStop,
  onClose,
}: {
  dot: Dot;
  phase: PanelPhase;
  working?: Working;
  /** The Dot has asked for the owner's help and nobody has answered yet. */
  needsYou?: boolean;
  settingsOpen: boolean;
  /** Nothing to set until the computer's state is known. */
  settingsDisabled?: boolean;
  settingsId: string;
  gearRef?: Ref<HTMLButtonElement>;
  onToggleSettings: () => void;
  onStop: () => void;
  onClose?: () => void;
}) {
  const pill =
    working === 'start'
      ? { label: 'Starting', tone: 'warn' }
      : working === 'stop'
        ? { label: 'Stopping', tone: 'warn' }
        : needsYou
          ? HANDOFF_PILL
          : PHASE_PILL[phase];
  return (
    <header className="cp-header">
      <span className="cp-avatar">
        <Mascot identity={dot.id} name={dot.name} decorative />
      </span>
      <div className="cp-title">
        <h2>{dot.name}</h2>
        <span className={`cp-pill cp-pill-${pill.tone}`} role="status">
          <i aria-hidden="true" />
          {pill.label}
        </span>
      </div>
      <div className="cp-header-actions">
        {phase === 'running' && (
          <button
            type="button"
            className="cp-btn cp-btn-quiet"
            onClick={onStop}
            disabled={!!working}
            title="Stop the computer. Workspace files are kept."
          >
            <Power size={13} aria-hidden="true" />
            {working === 'stop' ? 'Stopping…' : 'Stop'}
          </button>
        )}
        <button
          type="button"
          ref={gearRef}
          className="cp-icon-btn"
          aria-label="Computer settings"
          aria-expanded={settingsOpen}
          aria-controls={settingsId}
          disabled={settingsDisabled}
          onClick={onToggleSettings}
        >
          <Settings size={16} aria-hidden="true" />
        </button>
        {onClose && (
          <button
            type="button"
            className="cp-icon-btn"
            aria-label="Close computer panel"
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </div>
    </header>
  );
}
