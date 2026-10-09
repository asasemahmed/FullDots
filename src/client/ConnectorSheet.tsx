import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Copy,
  ExternalLink,
  Globe,
  Info,
  KeyRound,
  LoaderCircle,
  Lock,
  LogIn,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Terminal,
  Trash2,
  Unlock,
  Unplug,
  X,
  Zap,
  type LucideIcon,
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
  /** Form-only: this row is the token header the "Token" fields edit. Never sent. */
  token?: boolean;
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
        'Browser sign-in sets the Authorization header itself; remove that header or choose Token.',
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
    <section className="cs-sec" aria-label="Tools">
      <h4 className="cs-sec-title">
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

/** A flag that turns on for a moment ("Copied") and then off again. */
function useFlash(ms = 2000): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const flash = () => {
    setOn(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOn(false), ms);
  };
  return [on, flash];
}

function CopyLine({ text, label }: { text: string; label: string }) {
  const [copied, flashCopied] = useFlash();
  const codeRef: RefObject<HTMLElement | null> = useRef(null);
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
    flashCopied();
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

const URL_MESSAGE = 'Use https:// (http only for localhost)';
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** The inline hint under the URL field; empty when the URL is acceptable. */
export function urlProblem(url: string): string {
  const text = url.trim();
  if (!text) return '';
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return URL_MESSAGE;
  }
  if (parsed.protocol === 'https:') return '';
  if (parsed.protocol === 'http:' && LOCAL_HOSTS.includes(parsed.hostname))
    return '';
  return URL_MESSAGE;
}

const GENERIC_LABELS = new Set(['www', 'mcp', 'api', 'app']);
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

/** A readable connector name from a server URL: "mcp.linear.app" -> "linear". */
export function nameFromUrl(url: string): string {
  let host: string;
  try {
    host = new URL(url.trim()).hostname;
  } catch {
    return '';
  }
  if (!host) return '';
  let name = host;
  if (!/^[\d.]+$/.test(host) && !host.includes(':')) {
    const labels = host.split('.').filter(Boolean);
    while (labels.length > 2 && GENERIC_LABELS.has(labels[0]!)) labels.shift();
    let index = labels.length - 2;
    if (labels.length >= 3 && SECOND_LEVEL.has(labels[index]!)) index -= 1;
    name = labels[Math.max(index, 0)] ?? host;
  }
  return name
    .replace(/[^A-Za-z0-9 _-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 40);
}

/** The row the "Token" fields edit: the flagged one, else Authorization, else the first variable. */
function tokenRowIndex(rows: ValueRow[]): number {
  const flagged = rows.findIndex((row) => row.token);
  if (flagged >= 0) return flagged;
  const authorization = rows.findIndex(isAuthorizationRow);
  if (authorization >= 0) return authorization;
  return rows.findIndex((row) => row.kind === 'env');
}

function Collapsible({
  title,
  hint,
  open,
  onToggle,
  children,
}: {
  title: string;
  hint?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const bodyId = useId();
  return (
    <div className="cs-collapse" data-open={open || undefined}>
      <button
        type="button"
        className="cs-collapse-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <span className="cs-collapse-title">{title}</span>
        {hint && <span className="cs-collapse-hint">{hint}</span>}
        <ChevronDown size={16} className="cs-chevron" aria-hidden="true" />
      </button>
      <div className="cs-collapse-body" id={bodyId} hidden={!open}>
        {children}
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section className="cs-step" aria-labelledby={titleId}>
      <div className="cs-step-head">
        <span className="cs-num" aria-hidden="true">
          {n}
        </span>
        <h4 className="cs-step-title" id={titleId}>
          {title}
        </h4>
      </div>
      {children}
    </section>
  );
}

function Field({
  id,
  label,
  optional,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="cs-field">
      <label className="cs-label" htmlFor={id}>
        {label}
        {optional && <span className="cs-opt"> (optional)</span>}
      </label>
      {children}
      {error ? (
        <p className="cs-hint cs-hint-bad" id={`${id}-msg`}>
          {error}
        </p>
      ) : hint ? (
        <p className="cs-hint" id={`${id}-msg`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

interface Choice<T extends string> {
  id: T;
  label: string;
  hint?: string;
  icon: LucideIcon;
  disabled?: boolean;
}

/** Radio inputs dressed as big selectable options ("seg" in one line, "card" with a hint). */
function ChoiceGroup<T extends string>({
  name,
  label,
  value,
  choices,
  variant,
  onChange,
}: {
  name: string;
  label: string;
  value: T;
  choices: Choice<T>[];
  variant: 'seg' | 'card';
  onChange: (id: T) => void;
}) {
  return (
    <div
      className={`cs-choices cs-choices-${choices.length}`}
      role="radiogroup"
      aria-label={label}
    >
      {choices.map((choice) => (
        <label className={`cs-pick cs-pick-${variant}`} key={choice.id}>
          <input
            type="radio"
            name={name}
            value={choice.id}
            checked={value === choice.id}
            disabled={choice.disabled}
            onChange={() => onChange(choice.id)}
          />
          <span className="cs-pick-icon">
            <choice.icon size={16} aria-hidden="true" />
          </span>
          <span className="cs-pick-text">
            <strong>{choice.label}</strong>
            {choice.hint && <small>{choice.hint}</small>}
          </span>
        </label>
      ))}
    </div>
  );
}

/** The sticky action bar at the bottom of a page; `inline` keeps it in the flow. */
function PageFooter({
  messages,
  inline,
  children,
}: {
  messages?: ReactNode;
  inline?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={inline ? 'cs-footer cs-footer-inline' : 'cs-footer'}>
      {messages}
      <div className="cs-footer-actions">{children}</div>
    </div>
  );
}

export function ValueRowsEditor({
  draft,
  onChange,
  hideIndex = -1,
}: {
  draft: ConnectorDraft;
  onChange: (draft: ConnectorDraft) => void;
  /** A row that another part of the form edits (the token header). */
  hideIndex?: number;
}) {
  const uid = useId();
  const http = draft.transport === 'http';
  const set = (patch: Partial<ConnectorDraft>) =>
    onChange({ ...draft, ...patch });
  const setRow = (index: number, patch: Partial<ValueRow>) =>
    set({
      rows: draft.rows.map((row, i) =>
        i === index ? { ...row, ...patch } : row,
      ),
    });
  return (
    <div className="cs-rows">
      <p className="cs-hint">
        Secrets are never stored here. Point to a variable set on the server
        (for example <code>GITHUB_TOKEN</code>), or use a value for things that
        are not secret.
      </p>
      {draft.rows.map((row, index) =>
        index === hideIndex ? null : (
          <div className="cs-value-row" key={index}>
            <input
              className="cs-input cs-row-name"
              aria-label="Name"
              placeholder={http ? 'Header name' : 'VARIABLE'}
              value={row.name}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setRow(index, { name: event.target.value })}
            />
            <div className="cs-kind" role="radiogroup" aria-label="Kind">
              {(
                [
                  ['env', 'Variable'],
                  ['literal', 'Value'],
                ] as const
              ).map(([kind, text]) => (
                <label className="cs-kind-opt" key={kind}>
                  <input
                    type="radio"
                    name={`${uid}-kind-${index}`}
                    value={kind}
                    checked={row.kind === kind}
                    onChange={() => setRow(index, { kind, value: '' })}
                  />
                  <span>{text}</span>
                </label>
              ))}
            </div>
            <input
              className="cs-input cs-row-value"
              aria-label={
                row.kind === 'env'
                  ? 'Environment variable name'
                  : 'Literal value'
              }
              placeholder={row.kind === 'env' ? 'GITHUB_TOKEN' : 'value'}
              value={row.value}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setRow(index, { value: event.target.value })}
            />
            <button
              type="button"
              className="cs-icon-btn cs-row-remove"
              aria-label="Remove row"
              onClick={() =>
                set({ rows: draft.rows.filter((_, i) => i !== index) })
              }
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        ),
      )}
      <button
        type="button"
        className="cs-btn cs-btn-ghost cs-add"
        onClick={() =>
          set({
            rows: [...draft.rows, { name: '', kind: 'env', value: '' }],
          })
        }
      >
        <Plus size={14} aria-hidden="true" />
        Add {http ? 'header' : 'variable'}
      </button>
    </div>
  );
}

const AUTH_CHOICES: Choice<ConnectorAuth>[] = [
  {
    id: 'oauth',
    label: 'Browser sign-in',
    hint: 'Sign in on the service’s page',
    icon: LogIn,
  },
  {
    id: 'token',
    label: 'Token',
    hint: 'A token from the server’s .env',
    icon: KeyRound,
  },
  { id: 'none', label: 'None', hint: 'No credentials', icon: Unlock },
];

export function ConnectorForm({
  draft,
  allowStdio,
  busy,
  blocked = false,
  problems,
  warnings,
  saveLabel,
  envStatus,
  onChange,
  onSave,
  onCancel,
}: {
  draft: ConnectorDraft;
  allowStdio: boolean;
  busy: boolean;
  /** The primary action cannot work here (a local program on a server that forbids them). */
  blocked?: boolean;
  problems: string[];
  warnings: string[];
  /** Overrides the primary button text. */
  saveLabel?: string;
  /** Which environment variables the server is known to have set. */
  envStatus?: Map<string, boolean>;
  onChange: (draft: ConnectorDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const editing = !!draft.id;
  const uid = useId();
  const set = (patch: Partial<ConnectorDraft>) =>
    onChange({ ...draft, ...patch });
  const http = draft.transport === 'http';
  const auth: ConnectorAuth =
    draft.auth ?? (draft.rows.some(isAuthorizationRow) ? 'token' : 'none');
  // A preset or an existing connector has its transport fixed: skip step 1.
  const showWhere = !editing && !draft.presetId;
  const [nameTouched, setNameTouched] = useState(draft.name !== '');
  const [urlBlurred, setUrlBlurred] = useState(false);
  const [headerOpen, setHeaderOpen] = useState(false);
  const tokenIdx = http && auth === 'token' ? tokenRowIndex(draft.rows) : -1;
  const [advancedOpen, setAdvancedOpen] = useState(() =>
    draft.rows.some((_, index) => index !== tokenIdx),
  );

  const setAuth = (next: ConnectorAuth) => {
    let rows = draft.rows;
    if (next === 'oauth') rows = rows.filter((row) => !isAuthorizationRow(row));
    // Leaving the token option drops its row when nothing was typed into it.
    if (next !== 'token')
      rows = rows.filter((row) => !(row.token && !row.value.trim()));
    if (
      next === 'token' &&
      !rows.some((row) => row.token || isAuthorizationRow(row))
    )
      rows = [
        ...rows,
        { name: 'Authorization', kind: 'env', value: '', token: true },
      ];
    set({ auth: next, rows });
  };
  const setTokenRow = (patch: Partial<ValueRow>) => {
    if (tokenIdx >= 0)
      set({
        rows: draft.rows.map((row, index) =>
          index === tokenIdx ? { ...row, ...patch, token: true } : row,
        ),
      });
    else
      set({
        rows: [
          ...draft.rows,
          {
            name: 'Authorization',
            kind: 'env',
            value: '',
            token: true,
            ...patch,
          },
        ],
      });
  };

  const tokenRow = tokenIdx >= 0 ? draft.rows[tokenIdx] : undefined;
  const tokenEnv = tokenRow?.value.trim() ?? '';
  const tokenSet = tokenEnv ? envStatus?.get(tokenEnv) : undefined;
  const urlError =
    http && (urlBlurred || problems.length > 0) ? urlProblem(draft.url) : '';
  const connectionStep = showWhere ? 2 : 1;

  return (
    <div
      className="cn-form"
      role="group"
      aria-label="Connector details"
      data-enter
    >
      {showWhere && (
        <Step n={1} title="Where does it run?">
          <ChoiceGroup
            name={`${uid}-where`}
            label="Where does it run?"
            variant="seg"
            value={draft.transport}
            choices={[
              {
                id: 'http',
                label: 'Remote server (URL)',
                icon: Globe,
              },
              {
                id: 'stdio',
                label: 'Local program',
                icon: allowStdio ? Terminal : Lock,
                disabled: !allowStdio,
              },
            ]}
            onChange={(transport) =>
              set({
                transport,
                rows: [],
                ...(transport === 'stdio' ? { auth: 'none' as const } : {}),
              })
            }
          />
          {!allowStdio && (
            <p className="cs-hint cs-hint-icon">
              <Lock size={13} aria-hidden="true" />
              <span>{STDIO_OFF_NOTE}</span>
            </p>
          )}
        </Step>
      )}

      <Step n={connectionStep} title="Connection">
        {http ? (
          <Field id="cn-url" label="Server URL" error={urlError}>
            <input
              id="cn-url"
              className="cs-input"
              value={draft.url}
              placeholder="https://example.com/mcp"
              inputMode="url"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={urlError ? true : undefined}
              aria-describedby={urlError ? 'cn-url-msg' : undefined}
              onBlur={() => setUrlBlurred(true)}
              onChange={(event) =>
                set({
                  url: event.target.value,
                  ...(nameTouched
                    ? {}
                    : { name: nameFromUrl(event.target.value) }),
                })
              }
            />
          </Field>
        ) : (
          <>
            <Field id="cn-command" label="Command">
              <input
                id="cn-command"
                className="cs-input"
                value={draft.command}
                placeholder="npx"
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => set({ command: event.target.value })}
              />
            </Field>
            <Field id="cn-args" label="Arguments" hint="One argument per line.">
              <textarea
                id="cn-args"
                className="cs-input"
                rows={3}
                value={draft.args}
                placeholder={'-y\n@modelcontextprotocol/server-everything'}
                spellCheck={false}
                aria-describedby="cn-args-msg"
                onChange={(event) => set({ args: event.target.value })}
              />
            </Field>
            <Field id="cn-cwd" label="Working folder" optional>
              <input
                id="cn-cwd"
                className="cs-input"
                value={draft.cwd}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => set({ cwd: event.target.value })}
              />
            </Field>
          </>
        )}
        <Field
          id="cn-name"
          label="Name"
          hint={
            http && !editing && !draft.presetId
              ? 'Filled in from the URL. Change it if you like.'
              : undefined
          }
        >
          <input
            id="cn-name"
            className="cs-input"
            value={draft.name}
            maxLength={40}
            aria-describedby={
              http && !editing && !draft.presetId ? 'cn-name-msg' : undefined
            }
            onChange={(event) => {
              setNameTouched(event.target.value !== '');
              set({ name: event.target.value });
            }}
          />
        </Field>
      </Step>

      {http && (
        <Step n={connectionStep + 1} title="How does it sign in?">
          <ChoiceGroup
            name={`${uid}-auth`}
            label="Sign-in"
            variant="card"
            value={auth}
            choices={AUTH_CHOICES}
            onChange={setAuth}
          />
          {auth === 'token' && (
            <div className="cs-token">
              <h5 className="cs-sec-title">Token</h5>
              <Field
                id="cn-token-env"
                label="Environment variable"
                hint={
                  <>
                    Add <code>{tokenEnv || 'VARIABLE'}=</code> followed by the
                    token to <code>.env</code> on the server, then restart it.
                    If the server expects a scheme, include it in the value, for
                    example <code>Bearer …</code>.
                  </>
                }
              >
                <div className="cs-with-pill">
                  <input
                    id="cn-token-env"
                    className="cs-input"
                    value={tokenRow?.value ?? ''}
                    placeholder="GITHUB_TOKEN"
                    spellCheck={false}
                    autoComplete="off"
                    autoCapitalize="characters"
                    aria-describedby="cn-token-env-msg"
                    onChange={(event) =>
                      setTokenRow({
                        kind: 'env',
                        value: event.target.value
                          .toUpperCase()
                          .replace(/\s/g, ''),
                      })
                    }
                  />
                  {tokenEnv &&
                    (tokenSet === undefined ? (
                      <span className="cn-pill cn-pill-neutral">
                        Checked after you save
                      </span>
                    ) : tokenSet ? (
                      <span className="cn-pill cn-pill-ok cn-set">
                        <Check size={12} strokeWidth={2.4} aria-hidden="true" />{' '}
                        Set
                      </span>
                    ) : (
                      <span className="cn-pill cn-pill-warn cn-unset">
                        Not set
                      </span>
                    ))}
                </div>
              </Field>
              <p className="cs-header-line">
                <span>
                  Sent in the{' '}
                  <strong>{tokenRow?.name || 'Authorization'}</strong> header.
                </span>
                <button
                  type="button"
                  className="cs-linkbtn"
                  aria-expanded={headerOpen}
                  onClick={() => setHeaderOpen(!headerOpen)}
                >
                  Change header
                </button>
              </p>
              {headerOpen && (
                <Field id="cn-token-header" label="Header name">
                  <input
                    id="cn-token-header"
                    className="cs-input"
                    value={tokenRow?.name ?? 'Authorization'}
                    placeholder="Authorization"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) =>
                      setTokenRow({ name: event.target.value })
                    }
                  />
                </Field>
              )}
            </div>
          )}
        </Step>
      )}

      <Collapsible
        title="Advanced"
        hint={http ? 'Custom headers' : 'Environment variables'}
        open={advancedOpen}
        onToggle={() => setAdvancedOpen(!advancedOpen)}
      >
        {http && auth === 'oauth' && (
          <p className="cs-hint">
            Browser sign-in sets the Authorization header itself.
          </p>
        )}
        <ValueRowsEditor
          draft={draft}
          onChange={onChange}
          hideIndex={tokenIdx}
        />
      </Collapsible>

      <PageFooter
        messages={<ProblemList problems={problems} warnings={warnings} />}
      >
        <button
          type="button"
          className="cs-btn cs-btn-ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="cs-btn cs-btn-primary"
          data-primary
          disabled={busy || blocked}
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
      </PageFooter>
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
      <SheetFrame sheetRef={root} label="Connector" onClose={onClose}>
        <p className="cs-muted">This connector is gone.</p>
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
  // What a click on the subtitle copies: the full URL, or the command line.
  const copyText =
    target.kind === 'custom'
      ? undefined
      : ((connector ? connector.url : preset?.url) ?? subtitle);

  return (
    <SheetFrame sheetRef={root} titleId={titleId} onClose={onClose}>
      <header className="cs-head">
        <ConnectorLogo
          presetId={connector?.presetId ?? preset?.id}
          name={connector ? connector.name : (preset?.name ?? '')}
          url={connector ? connector.url : (preset?.url ?? null)}
          transport={connector?.transport ?? preset?.transport ?? 'http'}
          size={56}
        />
        <div className="cs-head-id">
          <div className="cs-title-row">
            <h3 className="cs-title" id={titleId}>
              {title}
            </h3>
            {connector && (
              <StatusPill status={connector.status} detail={false} />
            )}
          </div>
          <HeadSubtitle text={subtitle} copy={copyText} />
        </div>
        {preset && (
          <a
            className="cs-link cs-head-docs"
            href={preset.docsUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            Docs <ExternalLink size={12} aria-hidden="true" />
          </a>
        )}
      </header>
      {target.kind === 'custom' ? (
        <NewConnectorForm draft={emptyDraft()} {...props} onCancel={onClose} />
      ) : !connector && preset ? (
        <PresetPanel preset={preset} view={view} setView={setView} {...props} />
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
    </SheetFrame>
  );
}

/** The muted line under the name: click it to copy the URL or command. */
function HeadSubtitle({ text, copy }: { text: string; copy?: string }) {
  const [copied, flashCopied] = useFlash();
  if (!text) return null;
  if (copy === undefined) return <p className="cs-sub">{text}</p>;
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(copy);
      flashCopied();
    } catch {
      // No clipboard permission: the text stays selectable in the title tooltip.
    }
  };
  return (
    <>
      <button
        type="button"
        className="cs-sub cs-sub-copy"
        title={`Copy ${copy}`}
        aria-label={`Copy ${copy}`}
        onClick={() => void onCopy()}
      >
        <span className="cs-sub-text">{text}</span>
        {copied ? (
          <Check size={13} aria-hidden="true" />
        ) : (
          <Copy size={13} aria-hidden="true" />
        )}
      </button>
      <span className="cx-sr" role="status">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </>
  );
}

/**
 * The detail page that replaces the gallery: a top bar with the way back, and one
 * scrolling column. Each panel ends in a `.cs-footer` that sticks to the bottom.
 */
function SheetFrame({
  sheetRef,
  titleId,
  label,
  onClose,
  children,
}: {
  sheetRef: RefObject<HTMLElement | null>;
  titleId?: string;
  label?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <section
      className="cs-page"
      aria-label={label}
      aria-labelledby={label ? undefined : titleId}
      ref={sheetRef}
      tabIndex={-1}
    >
      <div className="cs-topbar">
        <button
          type="button"
          className="cs-back"
          aria-label="Back to connectors"
          onClick={onClose}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          Connectors
        </button>
      </div>
      <div className="cs-scroll" data-enter>
        <div className="cs-content">{children}</div>
      </div>
    </section>
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
  connectors,
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
        busy={saving || starting}
        blocked={blocked}
        problems={problems}
        warnings={warnings}
        envStatus={knownEnv(connectors)}
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
  connectors,
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
      envStatus={knownEnv(connectors)}
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
  const [advancedOpen, setAdvancedOpen] = useState(false);

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

  const waiting = state.phase === 'waiting' && mine;
  const failedHere = state.phase === 'failed' && mine;

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
        <section className="cs-sec" aria-label="Name">
          <h4 className="cs-sec-title">Name</h4>
          <label className="cx-sr" htmlFor="cs-name">
            Name
          </label>
          <input
            id="cs-name"
            className="cs-input"
            value={draft.name}
            maxLength={40}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
          />
          <Collapsible
            title="Advanced"
            hint="Server URL"
            open={advancedOpen}
            onToggle={() => setAdvancedOpen(!advancedOpen)}
          >
            <Field id="cs-url" label="Server URL">
              <input
                id="cs-url"
                className="cs-input"
                value={draft.url}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) =>
                  setDraft({ ...draft, url: event.target.value })
                }
              />
            </Field>
          </Collapsible>
        </section>
      )}

      {!connected && waiting && (
        <div className="cs-waiting" role="status">
          <div className="cs-waiting-row">
            <LoaderCircle size={18} className="cx-spin" aria-hidden="true" />
            <strong>Waiting for the browser…</strong>
          </div>
          <p>
            {state.blocked
              ? 'Your browser blocked the pop-up.'
              : 'Finish signing in in the window that opened. Nothing happens here until you approve.'}
          </p>
        </div>
      )}
      {!connected && failedHere && (
        <Banner tone="bad" icon={<CircleAlert size={18} />} role="alert">
          <strong>Could not connect</strong>
          <p>{state.message}</p>
        </Banner>
      )}
      {!connected && otherRunning && (
        <p className="cs-muted">
          Another sign-in is in progress. Finish it first.
        </p>
      )}
      {!connected && !waiting && !failedHere && (
        <p className="cs-muted">
          You sign in on {title}’s own page. FullDots never sees your password,
          and the access it receives stays on this computer.
        </p>
      )}
      {preset?.note && !connected && <p className="cs-muted">{preset.note}</p>}

      {!connected && (
        <PageFooter>
          {waiting ? (
            <>
              <button
                type="button"
                className="cs-btn cs-btn-ghost"
                onClick={auth.cancel}
              >
                Cancel
              </button>
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
            </>
          ) : (
            <>
              {tokenEnv && !running && (
                <button
                  type="button"
                  className="cs-btn cs-btn-ghost cs-footer-alt"
                  onClick={() => setView('token')}
                >
                  <KeyRound size={14} aria-hidden="true" />
                  Use a token instead
                </button>
              )}
              <button
                type="button"
                className="cs-btn cs-btn-primary"
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
                    {failedHere
                      ? 'Try again'
                      : reconnect
                        ? 'Reconnect with browser'
                        : 'Connect with browser'}
                  </>
                )}
              </button>
            </>
          )}
        </PageFooter>
      )}
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
  const [headersOpen, setHeadersOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
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
      <section className="cs-sec" aria-label="Set up a token">
        {!connected && <h4 className="cs-sec-title">Set up a token</h4>}
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
              <CopyLine
                text={`${envName}=`}
                label={`${envName} line for .env`}
              />
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
      </section>
      <Collapsible
        title="Advanced"
        hint="Custom headers"
        open={headersOpen}
        onToggle={() => setHeadersOpen(!headersOpen)}
      >
        <ValueRowsEditor draft={draft} onChange={setDraft} />
      </Collapsible>
      <PageFooter
        inline={connected}
        messages={
          <>
            <ProblemList problems={action.error ? [action.error] : []} />
            {action.note && (
              <p className="cs-result" role="status">
                {action.note}
              </p>
            )}
          </>
        }
      >
        {preset?.auth === 'oauth' && (
          <button
            type="button"
            className="cs-btn cs-btn-ghost cs-footer-alt"
            onClick={() => setView('oauth')}
          >
            <Globe size={14} aria-hidden="true" />
            Use browser sign-in instead
          </button>
        )}
        <button
          type="button"
          className="cs-btn cs-btn-primary"
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
      </PageFooter>
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
        <Collapsible
          title="Token setup"
          open={setupOpen}
          onToggle={() => setSetupOpen(!setupOpen)}
        >
          {setup}
        </Collapsible>
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
      <section className="cs-sec" aria-label="Manage">
        <h4 className="cs-sec-title">Manage</h4>
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
            className="cs-btn cs-btn-danger cs-push"
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
