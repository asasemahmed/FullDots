import type { KeyboardEvent, Ref } from 'react';
import { ArrowLeft, Check, ExternalLink } from 'lucide-react';
import type { Dot } from '../../shared/types';
import type {
  ComputerKind,
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
 * One labelled switch with its help text and a note while it saves. A plain function rather than a
 * component, so the sheet stays a tree of host elements.
 */
function settingSwitch({
  id,
  title,
  help,
  note,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  title: string;
  help: string;
  note?: SaveNote;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <li key={id} className="cp-setting">
      <div className="cp-setting-text">
        <label htmlFor={id}>{title}</label>
        <p id={`${id}-help`}>{help}</p>
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
        id={id}
        type="checkbox"
        role="switch"
        className="cp-switch"
        aria-describedby={`${id}-help`}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </li>
  );
}

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
  onSetPermission: (key: PermissionKey, value: boolean | ComputerKind) => void;
  onStart: () => void;
  onStop: () => void;
  onClose: () => void;
}) {
  const running = status.state === 'running';
  const currentKind: ComputerKind =
    optimistic.kind ?? status.permissions.kind ?? 'browser';
  const currentEnabled =
    optimistic.enabled ?? status.permissions.enabled ?? false;
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
      <div className="cp-field">
        <label htmlFor={`${id}-kind`}>Computer kind</label>
        <select
          id={`${id}-kind`}
          aria-label="Computer kind"
          aria-describedby={running ? `${id}-kind-help` : undefined}
          value={currentKind}
          disabled={busy || !status.configured || running}
          onChange={(event) =>
            onSetPermission('kind', event.target.value as ComputerKind)
          }
        >
          <option value="browser">Browser</option>
          <option value="desktop">Full desktop</option>
        </select>
        <span className={`cp-save cp-save-${notes.kind ?? 'none'}`}>
          <span role="status">
            {notes.kind === 'saving' && 'Saving…'}
            {notes.kind === 'saved' && (
              <>
                <Check size={12} aria-hidden="true" /> Saved
              </>
            )}
            {notes.kind === 'error' && 'Could not save. Try again.'}
          </span>
        </span>
        {running && (
          <p id={`${id}-kind-help`} className="cp-hint">
            Stop the computer before changing its kind.
          </p>
        )}
      </div>
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
        {PERMISSION_COPY.map(({ key, title, description }) =>
          settingSwitch({
            id: `${id}-${key}`,
            title,
            help: description(dot.name),
            note: notes[key],
            checked:
              key === 'desktop'
                ? !!(optimistic.desktop ?? status.permissions.desktop)
                : !!(optimistic[key] ?? status.permissions[key]),
            disabled:
              !status.configured ||
              busy ||
              (key === 'desktop' &&
                (currentKind !== 'desktop' || !currentEnabled)),
            onChange: (value) => onSetPermission(key, value),
          }),
        )}
      </ul>
      {(currentKind === 'desktop' ||
        Boolean(optimistic.desktop ?? status.permissions.desktop)) && (
        <p className="cp-hint">
          Full desktop includes a terminal. The Dot can run commands in its own
          computer through it, even with Terminal off. Every key press and typed
          text still asks you first.
        </p>
      )}
      <h4 className="cp-section-title">Replay</h4>
      <ul className="cp-settings">
        {settingSwitch({
          id: `${id}-replay`,
          title: 'Keep a replay',
          help: `Save a small picture of the screen after each computer step ${dot.name} takes, so you can step back through it. The oldest go first, and a conversation’s pictures go when you delete it.${
            status.permissions.browser || Boolean(status.permissions.desktop)
              ? ''
              : ' Turn on Browser or Full desktop to use it.'
          }`,
          note: notes.replay,
          checked:
            optimistic.replay ??
            ((status.permissions.browser ||
              Boolean(status.permissions.desktop)) &&
              status.permissions.replay !== false),
          disabled:
            !status.configured ||
            busy ||
            (!status.permissions.browser && !status.permissions.desktop),
          onChange: (value) => onSetPermission('replay', value),
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
