import { useState } from 'react';
import type {
  ComputerAction,
  ComputerAudit,
} from '../../shared/computer-types';
import { auditLabel, formatOutput, visibleAudit } from './model';

/** Runs a computer action. Resolves the result, or undefined when it failed (the panel shows why). */
export type Act = (action: ComputerAction, input: unknown) => Promise<unknown>;

/** Why a tool cannot be used right now, with a way to fix it when settings can. */
export type Blocked = { message: string; settings: boolean };

function BlockedNote({
  blocked,
  onOpenSettings,
}: {
  blocked: Blocked;
  onOpenSettings: () => void;
}) {
  return (
    <p className="cp-blocked" role="status">
      {blocked.message}
      {blocked.settings && (
        <>
          {' '}
          <button type="button" className="cp-link" onClick={onOpenSettings}>
            Open settings
          </button>
        </>
      )}
    </p>
  );
}

function Output({ text, onClear }: { text: string; onClear: () => void }) {
  if (!text) return null;
  return (
    <div className="cp-output">
      <pre tabIndex={0} aria-label="Output">
        {text}
      </pre>
      <button type="button" className="cp-link" onClick={onClear}>
        Clear output
      </button>
    </div>
  );
}

export function FilesTool({
  blocked,
  busy,
  fileChars,
  act,
  onOpenSettings,
}: {
  blocked?: Blocked;
  busy: boolean;
  fileChars: number;
  act: Act;
  onOpenSettings: () => void;
}) {
  const [path, setPath] = useState('');
  const [contents, setContents] = useState('');
  const [output, setOutput] = useState('');
  const disabled = !!blocked || busy;
  return (
    <div className="cp-tool">
      {blocked && (
        <BlockedNote blocked={blocked} onOpenSettings={onOpenSettings} />
      )}
      <label className="cp-field">
        <span>Path in the workspace</span>
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="notes.txt"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
        />
      </label>
      <div className="cp-actions">
        <button
          type="button"
          className="cp-btn"
          disabled={disabled}
          onClick={() =>
            void act('files_list', { path }).then((result) => {
              if (result !== undefined) setOutput(formatOutput(result));
            })
          }
        >
          List files
        </button>
        <button
          type="button"
          className="cp-btn"
          disabled={disabled || !path.trim()}
          onClick={() =>
            void act('files_read', { path }).then((result) => {
              if (result === undefined) return;
              setOutput(formatOutput(result));
              if (
                result &&
                typeof result === 'object' &&
                'text' in result &&
                typeof result.text === 'string'
              )
                setContents(result.text);
            })
          }
        >
          Read file
        </button>
      </div>
      <label className="cp-field">
        <span>File contents</span>
        <textarea
          aria-label="File contents to save"
          value={contents}
          onChange={(event) => setContents(event.target.value)}
          disabled={disabled}
          maxLength={fileChars}
          rows={5}
        />
      </label>
      <button
        type="button"
        className="cp-btn"
        disabled={disabled || !path.trim()}
        onClick={() =>
          void act('files_write', { path, contents }).then((result) => {
            if (result !== undefined) setOutput(formatOutput(result));
          })
        }
      >
        Save file (replaces contents)
      </button>
      <Output text={output} onClear={() => setOutput('')} />
    </div>
  );
}

export function TerminalTool({
  dotName,
  blocked,
  busy,
  commandChars,
  act,
  onOpenSettings,
}: {
  dotName: string;
  blocked?: Blocked;
  busy: boolean;
  commandChars: number;
  act: Act;
  onOpenSettings: () => void;
}) {
  const [command, setCommand] = useState('');
  const [output, setOutput] = useState('');
  const disabled = !!blocked || busy;
  return (
    <form
      className="cp-tool"
      onSubmit={(event) => {
        event.preventDefault();
        void act('exec', { command, timeoutMs: 30000 }).then((result) => {
          if (result !== undefined) setOutput(formatOutput(result));
        });
      }}
    >
      {blocked ? (
        <BlockedNote blocked={blocked} onOpenSettings={onOpenSettings} />
      ) : (
        <p className="cp-hint">
          Runs inside {dotName}’s computer, not on your device. Commands stop
          after 30 seconds.
        </p>
      )}
      <label className="cp-field">
        <span>Command</span>
        <textarea
          aria-label="Terminal command"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          maxLength={commandChars}
          rows={3}
          disabled={disabled}
          placeholder="pwd"
          spellCheck={false}
        />
      </label>
      <button className="cp-btn" disabled={disabled || !command.trim()}>
        Run command
      </button>
      <Output text={output} onClear={() => setOutput('')} />
    </form>
  );
}

export function ActivityTool({
  dotName,
  audit,
}: {
  dotName: string;
  audit: readonly ComputerAudit[];
}) {
  const entries = visibleAudit(audit);
  if (!entries.length)
    return <p className="cp-hint cp-tool">No activity yet.</p>;
  return (
    <ol className="cp-audit" aria-label="Recent activity">
      {entries.map((entry) => (
        <li key={entry.id} data-outcome={entry.outcome}>
          <strong>{auditLabel(entry)}</strong>
          <span>
            {entry.actor === 'agent' ? dotName : 'You'} ·{' '}
            {new Date(entry.createdAt).toLocaleTimeString()}
            {entry.outcome === 'failed' && ' · failed'}
            {entry.outcome === 'pending' && ' · in progress'}
          </span>
        </li>
      ))}
    </ol>
  );
}

const KEYS = [
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
];

/** Exact clicks, text and keys, for when pointing at the screen is not precise enough. */
export function KeyboardTool({
  human,
  busy,
  dims,
  typeChars,
  act,
}: {
  human: boolean;
  busy: boolean;
  dims?: { width: number; height: number };
  typeChars: number;
  act: Act;
}) {
  const [point, setPoint] = useState({ x: 0, y: 0 });
  const [text, setText] = useState('');
  const [key, setKey] = useState('Enter');
  const disabled = !human || busy;
  return (
    <div className="cp-tool">
      <p className="cp-hint">
        {human
          ? 'Most of the time you can click and type on the screen itself. These are for exact clicks and for text that goes straight to the browser, not into chat.'
          : 'Take control first. Then you can click exact points, type text and press keys here.'}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void act('human_click', point);
        }}
      >
        <div className="cp-row">
          <label className="cp-field cp-field-inline">
            <span>X</span>
            <input
              type="number"
              min="0"
              max={dims ? dims.width - 1 : undefined}
              value={point.x}
              disabled={disabled}
              onChange={(event) =>
                setPoint({ ...point, x: Number(event.target.value) })
              }
            />
          </label>
          <label className="cp-field cp-field-inline">
            <span>Y</span>
            <input
              type="number"
              min="0"
              max={dims ? dims.height - 1 : undefined}
              value={point.y}
              disabled={disabled}
              onChange={(event) =>
                setPoint({ ...point, y: Number(event.target.value) })
              }
            />
          </label>
          <button className="cp-btn" disabled={disabled || !dims}>
            Click
          </button>
        </div>
      </form>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const value = text;
          setText('');
          void act('human_type', { text: value });
        }}
      >
        <div className="cp-row">
          <input
            type="password"
            aria-label="Text to type into computer"
            placeholder="Type into the focused field"
            autoComplete="off"
            value={text}
            maxLength={typeChars}
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
          />
          <button className="cp-btn" disabled={disabled || !text}>
            Type
          </button>
        </div>
      </form>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void act('human_key', { key });
        }}
      >
        <div className="cp-row">
          <select
            aria-label="Key to press"
            value={key}
            disabled={disabled}
            onChange={(event) => setKey(event.target.value)}
          >
            {KEYS.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
          <button className="cp-btn" disabled={disabled}>
            Press key
          </button>
        </div>
      </form>
      <div className="cp-actions">
        <button
          type="button"
          className="cp-btn"
          disabled={disabled}
          onClick={() => void act('human_scroll', { deltaY: -500 })}
        >
          Scroll up
        </button>
        <button
          type="button"
          className="cp-btn"
          disabled={disabled}
          onClick={() => void act('human_scroll', { deltaY: 500 })}
        >
          Scroll down
        </button>
      </div>
    </div>
  );
}
