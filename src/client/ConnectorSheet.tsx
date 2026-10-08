import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  ExternalLink,
  Globe,
  Info,
  KeyRound,
  LoaderCircle,
  Pencil,
  Power,
  RefreshCw,
  Trash2,
  Unplug,
  X,
  Zap,
} from 'lucide-react';
import { api, authHeaders } from './api';
import {
  STDIO_OFF_NOTE,
  StatusPill,
  connectorSubtitle,
  connectorTitle,
  isPresetBlocked,
  knownEnv,
  prettyName,
} from './ConnectorGallery';
import { ConnectorLogo } from './connector-logos';
import type { ConnectorAuthController } from './useConnectorAuth';
import { SECRET_NAME, looksLikeCredential } from '../shared/connector-config';
import type { ConnectorPreset } from '../shared/connector-presets';
import type {
  ConnectorAuth,
  ConnectorConfig,
  ConnectorStatus,
  ConnectorToolInfo,
  ConnectorTransport,
  ConnectorValue,
  ConnectorValueView,
  ConnectorView,
} from '../shared/types';

export { STDIO_OFF_NOTE };

/** Same wording the server uses for a literal under a secret-looking name. */
export const secretNameMessage = (name: string) =>
  `${name} must reference an environment variable (env:VAR_NAME); secrets are never stored.`;

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,99}$/;

// ---- Drafts (the form's model) ------------------------------------------------

export type ValueKind = 'env' | 'literal';
export interface ValueRow {
  name: string;
  kind: ValueKind;
  /** The variable NAME for kind 'env'; the literal text for kind 'literal'. */
  value: string;
}
export interface ConnectorDraft {
  /** Set while editing an existing connector (transport is then fixed). */
  id?: string;
  presetId?: string | null;
  name: string;
  transport: ConnectorTransport;
  url: string;
  command: string;
  args: string;
  cwd: string;
  rows: ValueRow[];
  /** How the connector signs in. Left out of the request when undefined. */
  auth?: ConnectorAuth;
  /** True when an existing connector had a cwd (so clearing it is sent). */
  hadCwd?: boolean;
}

export const emptyDraft = (): ConnectorDraft => ({
  name: '',
  transport: 'http',
  url: '',
  command: '',
  args: '',
  cwd: '',
  rows: [],
});

function recordToRows(
  record: Record<string, ConnectorValue | ConnectorValueView> | undefined,
): ValueRow[] {
  return Object.entries(record ?? {}).map(([name, value]): ValueRow =>
    'env' in value
      ? { name, kind: 'env', value: value.env }
      : {
          name,
          kind: 'literal',
          // Defensive: never put a literal under a secret-looking name on screen.
          value: SECRET_NAME.test(name) ? '' : value.literal,
        },
  );
}

export function presetToDraft(preset: ConnectorPreset): ConnectorDraft {
  return {
    presetId: preset.id,
    name: preset.name,
    transport: preset.transport,
    url: preset.url ?? '',
    command: preset.command ?? '',
    args: (preset.args ?? []).join('\n'),
    cwd: '',
    auth: preset.auth,
    rows: recordToRows(
      preset.transport === 'http' ? preset.headers : preset.env,
    ),
  };
}

export function connectorToDraft(connector: ConnectorView): ConnectorDraft {
  return {
    id: connector.id,
    presetId: connector.presetId,
    name: connector.name,
    transport: connector.transport,
    url: connector.url ?? '',
    command: connector.command ?? '',
    args: connector.args.join('\n'),
    cwd: connector.cwd ?? '',
    hadCwd: connector.cwd !== null,
    auth: connector.auth,
    rows: recordToRows(
      connector.transport === 'http' ? connector.headers : connector.env,
    ),
  };
}

const isAuthorizationRow = (row: ValueRow) =>
  row.name.trim().toLowerCase() === 'authorization';

/**
 * The draft for "use a token instead": `auth: 'token'` and the preset's token
 * header pointing at its environment variable.
 */
export function tokenDraft(
  base: ConnectorDraft,
  tokenEnv: NonNullable<ConnectorPreset['tokenEnv']>,
): ConnectorDraft {
  const header = tokenEnv.header ?? 'Authorization';
  return {
    ...base,
    auth: 'token',
    rows: [
      ...base.rows.filter(
        (row) => row.name.trim().toLowerCase() !== header.toLowerCase(),
      ),
      { name: header, kind: 'env', value: tokenEnv.name },
    ],
  };
}

/** Client-side checks that mirror the server's secret rules. */
export function validateDraft(draft: ConnectorDraft): string[] {
  const errors: string[] = [];
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/.test(draft.name))
    errors.push(
      'name: use 1-40 letters, numbers, spaces, dashes or underscores.',
    );
  if (draft.transport === 'http' && !draft.url.trim())
    errors.push('url: required for http connectors');
  if (draft.transport === 'stdio' && !draft.command.trim())
    errors.push('command: required for stdio connectors');
  if (draft.auth === 'oauth') {
    if (draft.transport === 'stdio')
      errors.push('Browser sign-in works with remote servers only.');
    else if (draft.rows.some(isAuthorizationRow))
      errors.push(
        'Browser sign-in sets the Authorization header itself; remove that header or choose Token header.',
      );
  }
  for (const row of draft.rows) {
    const name = row.name.trim();
    if (!name) {
      if (row.value.trim()) errors.push('Every row needs a name.');
      continue;
    }
    if (row.kind === 'literal') {
      if (SECRET_NAME.test(name)) errors.push(secretNameMessage(name));
    } else {
      const value = row.value.trim();
      if (!ENV_NAME.test(value))
        errors.push(
          looksLikeCredential(value)
            ? `${name}: enter the NAME of an environment variable, never the secret itself.`
            : `${name}: environment variable names use capital letters, digits and underscores (for example GITHUB_TOKEN).`,
        );
    }
  }
  return errors;
}

function rowsToRecord(rows: ValueRow[]): Record<string, ConnectorValue> {
  const record: Record<string, ConnectorValue> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    record[name] =
      row.kind === 'env' ? { env: row.value.trim() } : { literal: row.value };
  }
  return record;
}

/** The request body the form sends: POST for a new connector, PATCH when editing. */
export function draftToBody(draft: ConnectorDraft): Partial<ConnectorConfig> {
  const body: Partial<ConnectorConfig> = {
    name: draft.name.trim(),
    transport: draft.transport,
  };
  if (draft.transport === 'http') {
    body.url = draft.url.trim();
    body.headers = rowsToRecord(draft.rows);
    if (draft.auth) body.auth = draft.auth;
  } else {
    body.command = draft.command.trim();
    body.args = draft.args
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const cwd = draft.cwd.trim();
    if (cwd || draft.hadCwd) body.cwd = cwd;
    body.env = rowsToRecord(draft.rows);
  }
  if (draft.presetId && !draft.id) body.presetId = draft.presetId;
  return body;
}

// ---- Requests -------------------------------------------------------------------

export class ConnectorRequestError extends Error {
  constructor(
    message: string,
    public errors: string[] = [],
    public warnings: string[] = [],
  ) {
    super(message);
  }
}

/** Like `api()` but keeps the `errors` / `warnings` lists of a 400 response. */
export async function connectorRequest<T>(
  path: string,
  method: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
    errors?: string[];
    warnings?: string[];
  };
  if (!response.ok)
    throw new ConnectorRequestError(
      data.error ?? `Request failed (${response.status}).`,
      data.errors ?? [],
      data.warnings ?? [],
    );
  return data as T;
}

const reasonOf = (error: unknown, fallback = 'That did not work.') =>
  error instanceof ConnectorRequestError && error.errors.length
    ? error.errors.join(' ')
    : error instanceof Error
      ? error.message
      : fallback;

// ---- Tools ----------------------------------------------------------------------

export type ToolGroupId = 'reads' | 'changes' | 'destructive';
export interface ToolGroup {
  id: ToolGroupId;
  label: string;
  tools: ConnectorToolInfo[];
}

/** Reads (read-only), Changes data, Destructive. Empty groups are left out. */
export function groupTools(tools: ConnectorToolInfo[]): ToolGroup[] {
  const groups: ToolGroup[] = [
    { id: 'reads', label: 'Reads', tools: [] },
    { id: 'changes', label: 'Changes data', tools: [] },
    { id: 'destructive', label: 'Destructive', tools: [] },
  ];
  for (const tool of tools)
    groups[tool.destructive ? 2 : tool.readOnly ? 0 : 1]!.tools.push(tool);
  return groups.filter((group) => group.tools.length > 0);
}

const firstLine = (text: string) => text.trim().split(/\r?\n/)[0] ?? '';

function ToolsList({ tools }: { tools: ConnectorToolInfo[] }) {
  if (tools.length === 0) return null;
  const groups = groupTools(tools);
  return (
    <section className="cs-section" aria-label="Tools">
      <h4 className="cs-h">
        Tools <span className="cs-h-count">{tools.length}</span>
      </h4>
      {groups.map((group) => (
        <details
          className="cs-tool-group"
          key={group.id}
          open={tools.length <= 15 || undefined}
        >
          <summary>
            <span className={`cs-dot cs-dot-${group.id}`} aria-hidden="true" />
            {group.label}
            <span className="cs-h-count">{group.tools.length}</span>
          </summary>
          <ul>
            {group.tools.map((tool) => (
              <li key={tool.toolName} title={firstLine(tool.description)}>
                <code>{tool.name}</code>
                {tool.description && (
                  <span className="cs-tool-desc">
                    {firstLine(tool.description)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}

// ---- Small pieces -----------------------------------------------------------------

function Banner({
  tone,
  icon,
  children,
  role,
}: {
  tone: 'ok' | 'bad' | 'warn' | 'info';
  icon: ReactNode;
  children: ReactNode;
  role?: 'alert' | 'status';
}) {
  return (
    <div className={`cs-banner cs-banner-${tone}`} role={role}>
      <span className="cs-banner-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="cs-banner-body">{children}</div>
    </div>
  );
}

function CopyLine({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const codeRef: RefObject<HTMLElement | null> = useRef(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No clipboard permission: select the text so Ctrl+C works.
      const node = codeRef.current;
      const selection = window.getSelection();
      if (node && selection) {
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return;
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="cs-copy">
      <code ref={codeRef} className="cs-mono" aria-label={label}>
        {text}
      </code>
      <button type="button" className="cs-btn cs-btn-sm" onClick={copy}>
        {copied ? (
          <Check size={14} aria-hidden="true" />
        ) : (
          <Copy size={14} aria-hidden="true" />
        )}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <span className="cx-sr" role="status">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </div>
  );
}

function ProblemList({
  problems,
  warnings = [],
}: {
  problems: string[];
  warnings?: string[];
}) {
  return (
    <>
      {problems.length > 0 && (
        <ul className="cn-problems" role="alert">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="cn-warnings">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </>
  );
}

const formatDate = (time: number) =>
  new Date(time).toLocaleDateString('en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

// ---- The form (custom connectors and editing) ------------------------------------

export function ValueRowsEditor({
  draft,
  onChange,
}: {
  draft: ConnectorDraft;
  onChange: (draft: ConnectorDraft) => void;
}) {
  const set = (patch: Partial<ConnectorDraft>) =>
    onChange({ ...draft, ...patch });
  const setRow = (index: number, patch: Partial<ValueRow>) =>
    set({
      rows: draft.rows.map((row, i) =>
        i === index ? { ...row, ...patch } : row,
      ),
    });
  return (
    <fieldset className="cn-fieldset">
      <legend>
        {draft.transport === 'http' ? 'Headers' : 'Environment variables'}
      </legend>
      <p className="cn-note">
        Secrets are never stored here. Point to a variable set on the server
        (for example <code>GITHUB_TOKEN</code>), or use a literal for values
        that are not secret.
      </p>
      {draft.rows.map((row, index) => (
        <div className="cn-value-row" key={index}>
          <input
            aria-label="Name"
            placeholder={
              draft.transport === 'http' ? 'Authorization' : 'VARIABLE'
            }
            value={row.name}
            spellCheck={false}
            onChange={(event) => setRow(index, { name: event.target.value })}
          />
          <select
            aria-label="Kind"
            value={row.kind}
            onChange={(event) =>
              setRow(index, {
                kind: event.target.value as ValueKind,
                value: '',
              })
            }
          >
            <option value="env">Env variable</option>
            <option value="literal">Literal</option>
          </select>
          <input
            aria-label={
              row.kind === 'env' ? 'Environment variable name' : 'Literal value'
            }
            placeholder={row.kind === 'env' ? 'GITHUB_TOKEN' : 'value'}
            value={row.value}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setRow(index, { value: event.target.value })}
          />
          <button
            type="button"
            className="cn-remove cs-btn cs-btn-sm"
            aria-label="Remove row"
            onClick={() =>
              set({ rows: draft.rows.filter((_, i) => i !== index) })
            }
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="cs-btn cs-btn-sm"
        onClick={() =>
          set({
            rows: [...draft.rows, { name: '', kind: 'env', value: '' }],
          })
        }
      >
        Add {draft.transport === 'http' ? 'header' : 'variable'}
      </button>
    </fieldset>
  );
}

const AUTH_CHOICES: { id: ConnectorAuth; label: string; hint: string }[] = [
  {
    id: 'oauth',
    label: 'Browser sign-in',
    hint: 'Sign in on the provider’s page',
  },
  {
    id: 'token',
    label: 'Token header',
    hint: 'Read a token from the server’s .env',
  },
  { id: 'none', label: 'None', hint: 'The server needs no credentials' },
];

export function ConnectorForm({
  draft,
  allowStdio,
  busy,
  problems,
  warnings,
  saveLabel,
  onChange,
  onSave,
  onCancel,
}: {
  draft: ConnectorDraft;
  allowStdio: boolean;
  busy: boolean;
  problems: string[];
  warnings: string[];
  /** Overrides the primary button text. */
  saveLabel?: string;
  onChange: (draft: ConnectorDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const editing = !!draft.id;
  const group = useId();
  const set = (patch: Partial<ConnectorDraft>) =>
    onChange({ ...draft, ...patch });
  const auth: ConnectorAuth =
    draft.auth ?? (draft.rows.some(isAuthorizationRow) ? 'token' : 'none');
  const setAuth = (next: ConnectorAuth) => {
    let rows = draft.rows;
    if (next === 'oauth') rows = rows.filter((row) => !isAuthorizationRow(row));
    if (next === 'token' && !rows.some(isAuthorizationRow))
      rows = [...rows, { name: 'Authorization', kind: 'env', value: '' }];
    set({ auth: next, rows });
  };
  const http = draft.transport === 'http';
  return (
    <div
      className="cn-form"
      role="group"
      aria-label="Connector details"
      data-enter
    >
      <label className="field-label" htmlFor="cn-name">
        Name
      </label>
      <input
        id="cn-name"
        value={draft.name}
        maxLength={40}
        onChange={(event) => set({ name: event.target.value })}
      />
      <label className="field-label" htmlFor="cn-transport">
        Type
      </label>
      <select
        id="cn-transport"
        value={draft.transport}
        disabled={editing}
        onChange={(event) =>
          set({
            transport: event.target.value as ConnectorTransport,
            rows: [],
            ...(event.target.value === 'stdio'
              ? { auth: 'none' as const }
              : {}),
          })
        }
      >
        <option value="http">Remote server (http)</option>
        <option value="stdio" disabled={!allowStdio}>
          Local program (stdio)
        </option>
      </select>
      {!allowStdio && <p className="cn-note cn-note-warn">{STDIO_OFF_NOTE}</p>}
      {http ? (
        <>
          <label className="field-label" htmlFor="cn-url">
            URL
          </label>
          <input
            id="cn-url"
            value={draft.url}
            placeholder="https://example.com/mcp"
            spellCheck={false}
            onChange={(event) => set({ url: event.target.value })}
          />
          <fieldset className="cs-radios">
            <legend className="field-label">Authorization</legend>
            {AUTH_CHOICES.map((choice) => (
              <label className="cs-radio" key={choice.id}>
                <input
                  type="radio"
                  name={`${group}-auth`}
                  value={choice.id}
                  checked={auth === choice.id}
                  onChange={() => setAuth(choice.id)}
                />
                <span>
                  <strong>{choice.label}</strong>
                  <small>{choice.hint}</small>
                </span>
              </label>
            ))}
          </fieldset>
        </>
      ) : (
        <>
          <label className="field-label" htmlFor="cn-command">
            Command
          </label>
          <input
            id="cn-command"
            value={draft.command}
            placeholder="npx"
            spellCheck={false}
            onChange={(event) => set({ command: event.target.value })}
          />
          <label className="field-label" htmlFor="cn-args">
            Arguments (one per line)
          </label>
          <textarea
            id="cn-args"
            rows={3}
            value={draft.args}
            spellCheck={false}
            onChange={(event) => set({ args: event.target.value })}
          />
          <label className="field-label" htmlFor="cn-cwd">
            Working directory (optional)
          </label>
          <input
            id="cn-cwd"
            value={draft.cwd}
            spellCheck={false}
            onChange={(event) => set({ cwd: event.target.value })}
          />
        </>
      )}
      {http && auth === 'oauth' ? (
        <details className="cs-more">
          <summary>Extra headers (optional)</summary>
          <ValueRowsEditor draft={draft} onChange={onChange} />
        </details>
      ) : (
        <ValueRowsEditor draft={draft} onChange={onChange} />
      )}
      <ProblemList problems={problems} warnings={warnings} />
      <div className="cs-actions">
        <button
          type="button"
          className="cs-btn cs-btn-primary"
          data-primary
          disabled={busy}
          onClick={onSave}
        >
          {busy
            ? 'Saving…'
            : (saveLabel ??
              (editing
                ? 'Save connector'
                : http && auth === 'oauth'
                  ? 'Add and connect'
                  : 'Add connector'))}
        </button>
        <button
          type="button"
          className="cs-btn"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---- The sheet -------------------------------------------------------------------------

export type SheetTarget =
  | { kind: 'connector'; id: string }
  | { kind: 'preset'; preset: ConnectorPreset }
  | { kind: 'custom' };

export interface ConnectorSheetProps {
  target: SheetTarget;
  connectors: ConnectorView[];
  presets: ConnectorPreset[];
  allowStdio: boolean;
  auth: ConnectorAuthController;
  onClose: () => void;
  /** A connector was created or changed; the container merges it and, for a new one, retargets the sheet. */
  onSaved: (view: ConnectorView) => void;
  onDeleted: (id: string) => void;
}

type SheetView = 'main' | 'edit' | 'token' | 'oauth';

function targetKey(target: SheetTarget): string {
  return target.kind === 'connector'
    ? `c:${target.id}`
    : target.kind === 'preset'
      ? `p:${target.preset.id}`
      : 'custom';
}

export function ConnectorSheet(props: ConnectorSheetProps) {
  const { target, connectors, presets, onClose } = props;
  const titleId = useId();
  const root = useRef<HTMLElement>(null);
  const key = targetKey(target);
  const [viewState, setViewState] = useState<{ key: string; view: SheetView }>({
    key,
    view: 'main',
  });
  const view: SheetView = viewState.key === key ? viewState.view : 'main';
  const setView = (next: SheetView) => setViewState({ key, view: next });

  const connector =
    target.kind === 'connector'
      ? connectors.find((item) => item.id === target.id)
      : undefined;
  const preset =
    target.kind === 'preset'
      ? target.preset
      : connector?.presetId
        ? presets.find((item) => item.id === connector.presetId)
        : undefined;

  // Esc closes the sheet, not the whole settings dialog: listen in the capture
  // phase and stop the event before the dialog's own handler sees it.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    root.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Ignore when the sheet is hidden (another settings tab is showing).
      if (!root.current || root.current.getClientRects().length === 0) return;
      event.stopPropagation();
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  if (target.kind === 'connector' && !connector) {
    // Deleted or not loaded yet.
    return (
      <SheetFrame sheetRef={root} titleId={titleId} onClose={onClose}>
        <div className="cs-body">
          <p className="cs-muted">This connector is gone.</p>
        </div>
      </SheetFrame>
    );
  }

  const title = connector
    ? connectorTitle(connector)
    : preset
      ? prettyName(preset.id)
      : 'Custom connector';
  const subtitle = connector
    ? connectorSubtitle(connector)
    : preset
      ? connectorSubtitle({
          transport: preset.transport,
          url: preset.url ?? null,
          command: preset.command ?? null,
          args: preset.args ?? [],
        })
      : 'Any MCP server';

  return (
    <SheetFrame sheetRef={root} titleId={titleId} onClose={onClose}>
      <header className="cs-head">
        <ConnectorLogo
          presetId={connector?.presetId ?? preset?.id}
          name={connector ? connector.name : (preset?.name ?? '')}
          url={connector ? connector.url : (preset?.url ?? null)}
          transport={connector?.transport ?? preset?.transport ?? 'http'}
          size={64}
        />
        <div className="cs-head-id">
          <h3 className="cs-title" id={titleId}>
            {title}
          </h3>
          <p className="cs-url" title={subtitle}>
            {subtitle}
          </p>
          <div className="cs-head-meta">
            {connector && (
              <StatusPill status={connector.status} detail={false} />
            )}
            {preset && (
              <a
                className="cs-link"
                href={preset.docsUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                Docs <ExternalLink size={12} aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
      </header>
      <div className="cs-body" data-enter>
        {target.kind === 'custom' ? (
          <NewConnectorForm
            draft={emptyDraft()}
            {...props}
            onCancel={onClose}
          />
        ) : !connector && preset ? (
          <PresetPanel
            preset={preset}
            view={view}
            setView={setView}
            {...props}
          />
        ) : connector && view === 'edit' ? (
          <EditPanel
            connector={connector}
            {...props}
            onDone={() => setView('main')}
          />
        ) : connector ? (
          <ConnectorPanel
            connector={connector}
            preset={preset}
            view={view}
            setView={setView}
            {...props}
          />
        ) : null}
      </div>
    </SheetFrame>
  );
}

function SheetFrame({
  sheetRef,
  titleId,
  onClose,
  children,
}: {
  sheetRef: RefObject<HTMLElement | null>;
  titleId: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <div className="cs-scrim" onClick={onClose} aria-hidden="true" />
      <aside
        className="cs-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={sheetRef}
        tabIndex={-1}
      >
        <button
          type="button"
          className="cs-close"
          aria-label="Close details"
          onClick={onClose}
        >
          <X size={18} aria-hidden="true" />
        </button>
        {children}
      </aside>
    </>
  );
}

// ---- Panels ------------------------------------------------------------------------------

type PanelProps = Pick<
  ConnectorSheetProps,
  | 'connectors'
  | 'presets'
  | 'allowStdio'
  | 'auth'
  | 'onClose'
  | 'onSaved'
  | 'onDeleted'
>;

/** Runs an async action with a busy flag and an error message. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = async (action: () => Promise<string | void>) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const result = await action();
      if (mounted.current && typeof result === 'string') setNote(result);
    } catch (e) {
      if (mounted.current) setError(reasonOf(e));
    }
    if (mounted.current) setBusy(false);
  };
  return { busy, error, note, run, setError };
}

/** Create a connector from a draft and return the view; throws a readable message. */
async function createFrom(draft: ConnectorDraft): Promise<ConnectorView> {
  const local = validateDraft(draft);
  if (local.length) throw new Error(local.join(' '));
  try {
    return await connectorRequest<ConnectorView>(
      '/connectors',
      'POST',
      draftToBody(draft),
    );
  } catch (error) {
    throw new Error(reasonOf(error), { cause: error });
  }
}

function NewConnectorForm({
  draft: initial,
  allowStdio,
  auth,
  onSaved,
  onCancel,
}: PanelProps & { draft: ConnectorDraft; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [problems, setProblems] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const blocked = draft.transport === 'stdio' && !allowStdio;
  const save = async () => {
    const local = validateDraft(draft);
    setProblems(local);
    setWarnings([]);
    if (local.length) return;
    if (draft.transport === 'http' && draft.auth === 'oauth') {
      // The popup opens right here, inside the click; the connector is created after.
      auth.start(async () => {
        const view = await createFrom(draft);
        onSaved(view);
        return view.id;
      });
      return;
    }
    setSaving(true);
    try {
      onSaved(
        await connectorRequest<ConnectorView>(
          '/connectors',
          'POST',
          draftToBody(draft),
        ),
      );
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof ConnectorRequestError) {
        setProblems(error.errors.length ? error.errors : [error.message]);
        setWarnings(error.warnings);
      } else setProblems([reasonOf(error, 'Could not save.')]);
    }
    if (mounted.current) setSaving(false);
  };
  const starting = ['starting', 'waiting', 'finishing'].includes(
    auth.state.phase,
  );
  return (
    <>
      {auth.state.phase === 'failed' && !auth.state.connectorId && (
        <Banner tone="bad" icon={<CircleAlert size={18} />} role="alert">
          {auth.state.message}
        </Banner>
      )}
      <ConnectorForm
        draft={draft}
        allowStdio={allowStdio}
        busy={saving || starting || blocked}
        problems={problems}
        warnings={warnings}
        onChange={setDraft}
        onSave={() => void save()}
        onCancel={onCancel}
      />
    </>
  );
}

function PresetPanel({
  preset,
  view,
  setView,
  ...rest
}: PanelProps & {
  preset: ConnectorPreset;
  view: SheetView;
  setView: (view: SheetView) => void;
}) {
  const blocked = isPresetBlocked(preset, rest.allowStdio);
  if (preset.transport === 'stdio' || preset.auth === 'none')
    return (
      <>
        {preset.description && <p className="cs-lead">{preset.description}</p>}
        {blocked && (
          <Banner tone="warn" icon={<CircleAlert size={18} />}>
            {STDIO_OFF_NOTE}
          </Banner>
        )}
        {preset.note && <p className="cs-muted">{preset.note}</p>}
        <NewConnectorForm
          draft={presetToDraft(preset)}
          {...rest}
          onCancel={rest.onClose}
        />
      </>
    );
  if (preset.auth === 'token' || view === 'token')
    return (
      <TokenPanel preset={preset} view={view} setView={setView} {...rest} />
    );
  return <OAuthPanel preset={preset} setView={setView} {...rest} />;
}

/** The connector's header env reference: its token variable. */
function tokenReference(
  connector: ConnectorView | undefined,
  preset: ConnectorPreset | undefined,
): { name: string; set?: boolean; header: string } | undefined {
  if (connector) {
    const rows = Object.entries(connector.headers).filter(
      (entry): entry is [string, { env: string; set: boolean }] =>
        'env' in entry[1],
    );
    const row =
      rows.find(([header]) => header.toLowerCase() === 'authorization') ??
      rows[0];
    if (row) return { name: row[1].env, set: row[1].set, header: row[0] };
  }
  const env = preset?.tokenEnv;
  return env
    ? { name: env.name, header: env.header ?? 'Authorization' }
    : undefined;
}

function ConnectorPanel({
  connector,
  preset,
  view,
  setView,
  ...rest
}: PanelProps & {
  connector: ConnectorView;
  preset: ConnectorPreset | undefined;
  view: SheetView;
  setView: (view: SheetView) => void;
}) {
  const mode = view === 'token' || view === 'oauth' ? view : connector.auth;
  return (
    <>
      {mode === 'token' ? (
        <TokenPanel
          connector={connector}
          preset={preset}
          view={view}
          setView={setView}
          {...rest}
        />
      ) : mode === 'oauth' ? (
        <OAuthPanel
          connector={connector}
          preset={preset}
          setView={setView}
          {...rest}
        />
      ) : null}
      <ManageSection
        connector={connector}
        preset={preset}
        onEdit={() => setView('edit')}
        {...rest}
      />
    </>
  );
}

function EditPanel({
  connector,
  onDone,
  onSaved,
  allowStdio,
}: PanelProps & { connector: ConnectorView; onDone: () => void }) {
  const [draft, setDraft] = useState(() => connectorToDraft(connector));
  const [problems, setProblems] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const local = validateDraft(draft);
    setProblems(local);
    setWarnings([]);
    if (local.length) return;
    setSaving(true);
    try {
      onSaved(
        await connectorRequest<ConnectorView>(
          `/connectors/${connector.id}`,
          'PATCH',
          draftToBody(draft),
        ),
      );
      onDone();
      return;
    } catch (error) {
      if (error instanceof ConnectorRequestError) {
        setProblems(error.errors.length ? error.errors : [error.message]);
        setWarnings(error.warnings);
      } else setProblems([reasonOf(error, 'Could not save.')]);
    }
    setSaving(false);
  };
  return (
    <ConnectorForm
      draft={draft}
      allowStdio={allowStdio}
      busy={saving}
      problems={problems}
      warnings={warnings}
      onChange={setDraft}
      onSave={() => void save()}
      onCancel={onDone}
    />
  );
}

// ---- Browser sign-in ----------------------------------------------------------------------

function OAuthPanel({
  connector,
  preset,
  setView,
  auth,
  onSaved,
}: PanelProps & {
  connector?: ConnectorView;
  preset: ConnectorPreset | undefined;
  setView: (view: SheetView) => void;
}) {
  const [draft, setDraft] = useState(() =>
    preset ? presetToDraft(preset) : emptyDraft(),
  );
  const title = connector
    ? connectorTitle(connector)
    : preset
      ? prettyName(preset.id)
      : 'this service';
  const state = auth.state;
  const status = connector?.status;
  const mine =
    state.phase !== 'idle' &&
    (connector ? state.connectorId === connector.id : !state.connectorId);
  const running = ['starting', 'waiting', 'finishing'].includes(state.phase);
  const otherRunning = running && !mine;
  const connected = status?.state === 'connected';
  const reconnect = !!status?.authorizedAt;
  const tokenEnv = preset?.tokenEnv;

  const connect = () =>
    auth.start(async () => {
      if (!connector) {
        const view = await createFrom({ ...draft, auth: 'oauth' });
        onSaved(view);
        return view.id;
      }
      if (connector.auth !== 'oauth') {
        // Switching from a token: drop the Authorization header, keep the rest.
        const view = await connectorRequest<ConnectorView>(
          `/connectors/${connector.id}`,
          'PATCH',
          {
            auth: 'oauth',
            headers: Object.fromEntries(
              Object.entries(connector.headers)
                .filter(([name]) => name.toLowerCase() !== 'authorization')
                .map(([name, value]): [string, ConnectorValue] => [
                  name,
                  'env' in value
                    ? { env: value.env }
                    : { literal: value.literal },
                ]),
            ),
          },
        );
        onSaved(view);
      }
      return connector.id;
    });

  return (
    <div className="cs-panel">
      {preset?.description && !connected && (
        <p className="cs-lead">{preset.description}</p>
      )}
      {preset?.authNote && (
        <Banner tone="info" icon={<Info size={18} />}>
          {preset.authNote}
        </Banner>
      )}

      {connected && status && (
        <Banner tone="ok" icon={<CircleCheck size={18} />} role="status">
          <strong>
            {status.account ? `Connected as ${status.account}` : 'Connected'}
          </strong>
          {status.authorizedAt && (
            <span> since {formatDate(status.authorizedAt)}</span>
          )}
          <p>
            {title} is ready. Your Dots can use it once you give them access in
            their settings.
          </p>
        </Banner>
      )}

      {!connected && status?.state === 'error' && status.error && (
        <Banner tone="bad" icon={<CircleAlert size={18} />} role="alert">
          {status.error}
        </Banner>
      )}

      {!connector && (
        <div className="cs-fields">
          <label className="field-label" htmlFor="cs-name">
            Name
          </label>
          <input
            id="cs-name"
            value={draft.name}
            maxLength={40}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
          />
          <details className="cs-more">
            <summary>Advanced</summary>
            <label className="field-label" htmlFor="cs-url">
              Server URL
            </label>
            <input
              id="cs-url"
              value={draft.url}
              spellCheck={false}
              onChange={(event) =>
                setDraft({ ...draft, url: event.target.value })
              }
            />
          </details>
        </div>
      )}

      {!connected && (
        <>
          {state.phase === 'waiting' && mine ? (
            <div className="cs-waiting" role="status">
              <div className="cs-waiting-row">
                <LoaderCircle
                  size={18}
                  className="cx-spin"
                  aria-hidden="true"
                />
                <strong>Waiting for the browser…</strong>
              </div>
              <p>
                {state.blocked
                  ? 'Your browser blocked the pop-up.'
                  : 'Finish signing in in the window that opened. Nothing happens here until you approve.'}
              </p>
              <div className="cs-actions">
                {state.link && (
                  <a
                    className="cs-btn cs-btn-primary"
                    href={state.link}
                    target="_blank"
                    rel="noopener"
                  >
                    <ExternalLink size={14} aria-hidden="true" />
                    {state.blocked
                      ? 'Open the sign-in page'
                      : 'Open the sign-in page again'}
                  </a>
                )}
                <button type="button" className="cs-btn" onClick={auth.cancel}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              {state.phase === 'failed' && mine && (
                <Banner
                  tone="bad"
                  icon={<CircleAlert size={18} />}
                  role="alert"
                >
                  <strong>Could not connect</strong>
                  <p>{state.message}</p>
                </Banner>
              )}
              <div className="cs-actions">
                <button
                  type="button"
                  className="cs-btn cs-btn-primary cs-btn-lg"
                  data-primary
                  disabled={running || otherRunning}
                  onClick={connect}
                >
                  {running && mine ? (
                    <>
                      <LoaderCircle
                        size={16}
                        className="cx-spin"
                        aria-hidden="true"
                      />
                      {state.phase === 'finishing'
                        ? 'Finishing…'
                        : 'Opening the browser…'}
                    </>
                  ) : (
                    <>
                      <Globe size={16} aria-hidden="true" />
                      {state.phase === 'failed' && mine
                        ? 'Try again'
                        : reconnect
                          ? 'Reconnect with browser'
                          : 'Connect with browser'}
                    </>
                  )}
                </button>
                {tokenEnv && !running && (
                  <button
                    type="button"
                    className="cs-btn"
                    onClick={() => setView('token')}
                  >
                    <KeyRound size={14} aria-hidden="true" />
                    Use a token instead
                  </button>
                )}
              </div>
              {otherRunning && (
                <p className="cs-muted">
                  Another sign-in is in progress. Finish it first.
                </p>
              )}
              {!(state.phase === 'failed' && mine) && (
                <p className="cs-muted">
                  You sign in on {title}’s own page. FullDots never sees your
                  password, and the access it receives stays on this computer.
                </p>
              )}
            </>
          )}
        </>
      )}
      {preset?.note && !connected && <p className="cs-muted">{preset.note}</p>}
    </div>
  );
}

// ---- Token ---------------------------------------------------------------------------------

function TokenPanel({
  connector,
  preset,
  view,
  setView,
  connectors,
  onSaved,
}: PanelProps & {
  connector?: ConnectorView;
  preset: ConnectorPreset | undefined;
  view: SheetView;
  setView: (view: SheetView) => void;
}) {
  const known = knownEnv(connectors);
  const reference = tokenReference(connector, preset);
  const [draft, setDraft] = useState<ConnectorDraft>(() => {
    const base = connector
      ? connectorToDraft(connector)
      : preset
        ? presetToDraft(preset)
        : emptyDraft();
    if (preset?.tokenEnv && (base.auth !== 'token' || view === 'token'))
      return tokenDraft(base, preset.tokenEnv);
    return { ...base, auth: 'token' };
  });
  const action = useAction();
  const title = connector
    ? connectorTitle(connector)
    : preset
      ? prettyName(preset.id)
      : 'the service';
  const envName = reference?.name ?? preset?.requiredEnv[0]?.name ?? 'TOKEN';
  const isSet = reference?.set ?? known.get(envName);
  const scheme = preset?.tokenEnv?.scheme;
  const label = preset?.tokenEnv?.label ?? preset?.requiredEnv[0]?.label;

  const saveAndTest = () =>
    action.run(async () => {
      const local = validateDraft(draft);
      if (local.length) throw new Error(local.join(' '));
      const saved = draft.id
        ? await connectorRequest<ConnectorView>(
            `/connectors/${draft.id}`,
            'PATCH',
            draftToBody(draft),
          )
        : await createFrom(draft);
      onSaved(saved);
      const status = await api<ConnectorStatus>(
        `/connectors/${saved.id}/test`,
        'POST',
        {},
      );
      onSaved({ ...saved, status });
      return status.state === 'connected'
        ? `Connected. ${status.tools.length} ${status.tools.length === 1 ? 'tool' : 'tools'} found.`
        : status.state === 'missing_env'
          ? `Not connected yet: set ${(status.missing ?? []).join(', ')} on the server and restart it.`
          : (status.error ?? 'The connector did not connect.');
    });

  const connected = connector?.status.state === 'connected';
  const setup = (
    <>
      <ol className="cs-steps">
        <li>
          <div className="cs-step-n" aria-hidden="true">
            1
          </div>
          <div className="cs-step-body">
            <strong>Create a token</strong>
            <p>
              {label ? `${label}. ` : ''}
              {preset ? (
                <a
                  className="cs-link"
                  href={preset.docsUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Open the {title} docs{' '}
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
              ) : (
                `Create one in ${title}.`
              )}
            </p>
          </div>
        </li>
        <li>
          <div className="cs-step-n" aria-hidden="true">
            2
          </div>
          <div className="cs-step-body">
            <strong>
              Add this line to <code>.env</code> on the server
            </strong>
            <CopyLine text={`${envName}=`} label={`${envName} line for .env`} />
            <p>
              Paste the token after the equals sign, then restart the server.
              {scheme && (
                <>
                  {' '}
                  The value must start with <code>{scheme}</code>, for example{' '}
                  <code>
                    {envName}={scheme} …
                  </code>
                  .
                </>
              )}
            </p>
          </div>
        </li>
        <li>
          <div className="cs-step-n" aria-hidden="true">
            3
          </div>
          <div className="cs-step-body">
            <strong>Check it</strong>
            <p className="cs-check-row">
              <code>{envName}</code>
              {isSet === undefined ? (
                <span className="cn-pill cn-pill-neutral">
                  Checked after you save
                </span>
              ) : isSet ? (
                <span className="cn-pill cn-pill-ok cn-set">
                  <Check size={12} strokeWidth={2.4} aria-hidden="true" /> Set
                </span>
              ) : (
                <span className="cn-pill cn-pill-warn cn-unset">Not set</span>
              )}
            </p>
          </div>
        </li>
      </ol>
      <details className="cs-more">
        <summary>Headers</summary>
        <ValueRowsEditor draft={draft} onChange={setDraft} />
      </details>
      <ProblemList problems={action.error ? [action.error] : []} />
      {action.note && (
        <p className="cs-result" role="status">
          {action.note}
        </p>
      )}
      <div className="cs-actions">
        <button
          type="button"
          className="cs-btn cs-btn-primary cs-btn-lg"
          data-primary
          disabled={action.busy}
          onClick={saveAndTest}
        >
          {action.busy ? (
            <>
              <LoaderCircle size={16} className="cx-spin" aria-hidden="true" />
              Testing…
            </>
          ) : (
            <>
              <Zap size={16} aria-hidden="true" />
              Save and test
            </>
          )}
        </button>
        {preset?.auth === 'oauth' && (
          <button
            type="button"
            className="cs-btn"
            onClick={() => setView('oauth')}
          >
            <Globe size={14} aria-hidden="true" />
            Use browser sign-in instead
          </button>
        )}
      </div>
    </>
  );

  return (
    <div className="cs-panel">
      {preset?.description && !connector && (
        <p className="cs-lead">{preset.description}</p>
      )}
      {connected && (
        <Banner tone="ok" icon={<CircleCheck size={18} />} role="status">
          <strong>Connected</strong>
          <span> with a token from the server’s environment.</span>
        </Banner>
      )}
      {connected ? (
        <details className="cs-more">
          <summary>Token setup</summary>
          <div className="cs-panel">{setup}</div>
        </details>
      ) : (
        setup
      )}
      {preset?.note && <p className="cs-muted">{preset.note}</p>}
    </div>
  );
}

// ---- Actions on an existing connector ---------------------------------------------------------

function ManageSection({
  connector,
  onEdit,
  onSaved,
  onDeleted,
  onClose,
  auth,
}: PanelProps & {
  connector: ConnectorView;
  preset: ConnectorPreset | undefined;
  onEdit: () => void;
}) {
  const action = useAction();
  const title = connectorTitle(connector);
  const oauth = connector.auth === 'oauth';
  const hasAccess =
    connector.status.state === 'connected' || !!connector.status.authorized;
  return (
    <>
      <ToolsList tools={connector.status.tools} />
      <section className="cs-section" aria-label="Manage">
        <ProblemList problems={action.error ? [action.error] : []} />
        {action.note && (
          <p className="cs-result" role="status">
            {action.note}
          </p>
        )}
        <div className="cs-actions">
          {connector.enabled && (
            <button
              type="button"
              className="cs-btn"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  onSaved(
                    await api<ConnectorView>(
                      `/connectors/${connector.id}/reload`,
                      'POST',
                      {},
                    ),
                  );
                })
              }
            >
              <RefreshCw size={14} aria-hidden="true" />
              Reload tools
            </button>
          )}
          {connector.enabled && (
            <button
              type="button"
              className="cs-btn"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  const status = await api<ConnectorStatus>(
                    `/connectors/${connector.id}/test`,
                    'POST',
                    {},
                  );
                  onSaved({ ...connector, status });
                  return status.state === 'connected'
                    ? 'The connection works.'
                    : (status.error ?? 'The connector is not connected.');
                })
              }
            >
              <Zap size={14} aria-hidden="true" />
              Test
            </button>
          )}
          <button
            type="button"
            className="cs-btn"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                onSaved(
                  await connectorRequest<ConnectorView>(
                    `/connectors/${connector.id}`,
                    'PATCH',
                    { enabled: !connector.enabled },
                  ),
                );
              })
            }
          >
            <Power size={14} aria-hidden="true" />
            {connector.enabled ? 'Turn off' : 'Turn on'}
          </button>
          {oauth && hasAccess && (
            <button
              type="button"
              className="cs-btn"
              disabled={action.busy}
              onClick={() => {
                if (
                  !window.confirm(
                    `Disconnect ${title}? Dots keep their grants but cannot use ${title} until you connect again.`,
                  )
                )
                  return;
                void action.run(async () => {
                  auth.reset();
                  onSaved(
                    await api<ConnectorView>(
                      `/connectors/${connector.id}/disconnect`,
                      'POST',
                      {},
                    ),
                  );
                });
              }}
            >
              <Unplug size={14} aria-hidden="true" />
              Disconnect
            </button>
          )}
          <button
            type="button"
            className="cs-btn"
            disabled={action.busy}
            onClick={onEdit}
          >
            <Pencil size={14} aria-hidden="true" />
            Edit
          </button>
          <button
            type="button"
            className="cs-btn cs-btn-danger"
            disabled={action.busy}
            onClick={() => {
              if (
                !window.confirm(
                  `Delete the connector "${connector.name}"? Dots lose access to it.`,
                )
              )
                return;
              void action.run(async () => {
                await api(`/connectors/${connector.id}`, 'DELETE', {});
                onDeleted(connector.id);
                onClose();
              });
            }}
          >
            <Trash2 size={14} aria-hidden="true" />
            Delete
          </button>
        </div>
      </section>
    </>
  );
}
