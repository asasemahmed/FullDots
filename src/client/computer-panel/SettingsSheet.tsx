import type { KeyboardEvent, Ref } from 'react';
import { ArrowLeft, Check, ExternalLink } from 'lucide-react';
import type { Dot } from '../../shared/types';
import type {
  ComputerPermissions,
  ComputerStatus,
} from '../../shared/computer-types';
import type { Working } from './PanelHeader';
import {
  COMPUTER_DOCS_URL,
  PERMISSION_COPY,
  type PermissionKey,
} from './model';

export type SaveNote = 'saving' | 'saved' | 'error';

/**
 * Permissions and power, one plain sentence each. Slides over the panel's body; the header, with
 * its gear, stays where it is.
 */
export function SettingsSheet({
  id,
  dot,
  dots,
  status,
  optimistic,
  notes,
  busy,
  working,
  hidden,
  sheetRef,
  onSelectDot,
  onSetPermission,
  onStart,
  onStop,
  onClose,
}: {
  id: string;
  dot: Dot;
  dots?: readonly Dot[];
  status: ComputerStatus;
  /** Values just chosen and still being saved, so a switch moves the moment it is pressed. */
  optimistic: Partial<ComputerPermissions>;
  notes: Partial<Record<PermissionKey, SaveNote>>;
  busy: boolean;
  working?: Working;
  hidden: boolean;
  sheetRef?: Ref<HTMLDivElement>;
  onSelectDot?: (id: string) => void;
  onSetPermission: (key: PermissionKey, value: boolean) => void;
  onStart: () => void;
  onStop: () => void;
  onClose: () => void;
}) {
  const running = status.state === 'running';
  return (
    <div
      id={id}
      ref={sheetRef}
      className="cp-sheet"
      role="region"
      aria-label="Computer settings"
      tabIndex={-1}
      hidden={hidden}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape' && !event.defaultPrevented) onClose();
      }}
    >
      <div className="cp-sheet-head">
        <button
          type="button"
          className="cp-icon-btn"
          aria-label="Back to the screen"
          onClick={onClose}
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
        <h3>Computer settings</h3>
        <button type="button" className="cp-btn" onClick={onClose}>
          Done
        </button>
      </div>
      {dots && dots.length > 1 && onSelectDot && (
        <label className="cp-field">
          <span>Computer for</span>
          <select
            value={dot.id}
            aria-label="Select Dot computer"
            onChange={(event) => onSelectDot(event.target.value)}
          >
            {dots.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {!status.configured && (
        <p className="cp-callout">
          No computer service is connected yet, so nothing here can be changed.{' '}
          <a href={COMPUTER_DOCS_URL} target="_blank" rel="noreferrer">
            Setup guide
            <ExternalLink size={11} aria-hidden="true" />
          </a>
        </p>
      )}
      <h4 className="cp-section-title">What {dot.name} can use</h4>
      <ul className="cp-settings">
        {PERMISSION_COPY.map(({ key, title, description }) => {
          const note = notes[key];
          const checked = optimistic[key] ?? status.permissions[key];
          return (
            <li key={key} className="cp-setting">
              <div className="cp-setting-text">
                <label htmlFor={`${id}-${key}`}>{title}</label>
                <p id={`${id}-${key}-help`}>{description(dot.name)}</p>
                <span className={`cp-save cp-save-${note ?? 'none'}`}>
                  <span role="status">
                    {note === 'saving' && 'Saving…'}
                    {note === 'saved' && (
                      <>
                        <Check size={12} aria-hidden="true" /> Saved
                      </>
                    )}
                    {note === 'error' && 'Could not save. Try again.'}
                  </span>
                </span>
              </div>
              <input
                id={`${id}-${key}`}
                type="checkbox"
                role="switch"
                className="cp-switch"
                aria-describedby={`${id}-${key}-help`}
                checked={checked}
                disabled={!status.configured || busy}
                onChange={(event) => onSetPermission(key, event.target.checked)}
              />
            </li>
          );
        })}
      </ul>
      <h4 className="cp-section-title">Power</h4>
      <div className="cp-actions">
        <button
          type="button"
          className="cp-btn cp-btn-primary"
          disabled={
            busy || !status.configured || !status.permissions.enabled || running
          }
          onClick={onStart}
        >
          {working === 'start' ? 'Starting…' : 'Start computer'}
        </button>
        <button
          type="button"
          className="cp-btn"
          disabled={busy || !running}
          onClick={onStop}
        >
          {working === 'stop' ? 'Stopping…' : 'Stop computer'}
        </button>
      </div>
      <p className="cp-hint">
        Stopping keeps {dot.name}’s workspace files. Websites may ask you to
        sign in again.
      </p>
    </div>
  );
}
