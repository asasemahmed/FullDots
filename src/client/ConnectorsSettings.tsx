import { useCallback, useEffect, useState } from 'react';
import { api, authHeaders } from './api';
import { SECRET_NAME, looksLikeCredential } from '../shared/connector-config';
import type { ConnectorPreset } from '../shared/connector-presets';
import type {
  ConnectorConfig,
  ConnectorStatus,
  ConnectorTransport,
  ConnectorValue,
  ConnectorValueView,
  ConnectorView,
} from '../shared/types';

export interface ConnectorsData {
  connectors: ConnectorView[];
  presets: ConnectorPreset[];
  allowStdio: boolean;
}

export const STDIO_OFF_NOTE =
  'Local program connectors are off. Set CONNECTORS_ALLOW_STDIO=true on the server to allow them.';

/** Same wording the server uses for a literal under a secret-looking name. */
export const secretNameMessage = (name: string) =>
  `${name} must reference an environment variable (env:VAR_NAME); secrets are never stored.`;

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,99}$/;

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
    rows: recordToRows(
      connector.transport === 'http' ? connector.headers : connector.env,
    ),
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

const STATE_LABEL: Record<ConnectorStatus['state'], string> = {
  connected: 'Connected',
  error: 'Error',
  missing_env: 'Missing variables',
  disabled: 'Disabled',
  connecting: 'Connecting',
};
const STATE_TONE: Record<ConnectorStatus['state'], string> = {
  connected: 'ok',
  error: 'bad',
  missing_env: 'warn',
  disabled: 'neutral',
  connecting: 'neutral',
};

export function StatusPill({ status }: { status: ConnectorStatus }) {
  return (
    <span className="cn-status">
      <span
        className={`cn-pill cn-pill-${STATE_TONE[status.state]}`}
        data-state={status.state}
      >
        {STATE_LABEL[status.state]}
      </span>
      {status.state === 'error' && status.error && (
        <span className="cn-detail cn-detail-bad">{status.error}</span>
      )}
      {status.state === 'missing_env' && (
        <span className="cn-detail cn-detail-warn">
          Set on the server:{' '}
          {(status.missing ?? []).map((name, index) => (
            <span key={name}>
              {index > 0 && ', '}
              <code>{name}</code>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

function valueSummary(name: string, value: ConnectorValueView) {
  if ('env' in value)
    return (
      <>
        <code>{name}</code> from <code>{value.env}</code>{' '}
        <span className={value.set ? 'cn-set' : 'cn-unset'}>
          {value.set ? 'set' : 'not set'}
        </span>
      </>
    );
  // Defensive: a literal under a secret-looking name is never shown.
  return SECRET_NAME.test(name) ? (
    <>
      <code>{name}</code> (hidden)
    </>
  ) : (
    <>
      <code>{name}</code> = {value.literal}
    </>
  );
}

function ConnectorRow({
  connector,
  busy,
  onToggle,
  onReload,
  onTest,
  onEdit,
  onDelete,
}: {
  connector: ConnectorView;
  busy: boolean;
  onToggle: () => void;
  onReload: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const headers = Object.entries(connector.headers ?? {});
  const env = Object.entries(connector.env ?? {});
  const tools = connector.status.tools;
  return (
    <li className="cn-row" data-connector={connector.name}>
      <div className="cn-row-head">
        <strong>{connector.name}</strong>
        <span className="cn-transport">
          {connector.transport === 'http' ? 'Remote (http)' : 'Local program'}
        </span>
        <StatusPill status={connector.status} />
        <span className="cn-count">
          {tools.length} {tools.length === 1 ? 'tool' : 'tools'}
        </span>
      </div>
      {(headers.length > 0 || env.length > 0) && (
        <ul className="cn-values">
          {headers.map(([name, value]) => (
            <li key={`h:${name}`}>Header: {valueSummary(name, value)}</li>
          ))}
          {env.map(([name, value]) => (
            <li key={`e:${name}`}>Env: {valueSummary(name, value)}</li>
          ))}
        </ul>
      )}
      {tools.length > 0 && (
        <details className="cn-tools">
          <summary>Tools</summary>
          <ul>
            {tools.map((tool) => (
              <li key={tool.toolName}>
                <code>{tool.name}</code>
                {tool.readOnly && <span className="cn-tag">read-only</span>}
                {tool.destructive && (
                  <span className="cn-tag cn-tag-destructive">destructive</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="cn-actions">
        <button type="button" disabled={busy} onClick={onToggle}>
          {connector.enabled ? 'Disable' : 'Enable'}
        </button>
        <button type="button" disabled={busy} onClick={onReload}>
          Reload
        </button>
        <button type="button" disabled={busy} onClick={onTest}>
          Test
        </button>
        <button type="button" disabled={busy} onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          className="cn-danger"
          disabled={busy}
          onClick={onDelete}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

/** Which env variables are known to be set, from existing connectors' references. */
export function knownEnv(connectors: ConnectorView[]): Map<string, boolean> {
  const known = new Map<string, boolean>();
  for (const connector of connectors)
    for (const record of [connector.headers, connector.env])
      for (const value of Object.values(record ?? {}))
        if ('env' in value) known.set(value.env, value.set);
  return known;
}

export function PresetPicker({
  presets,
  allowStdio,
  connectors,
  onPick,
}: {
  presets: ConnectorPreset[];
  allowStdio: boolean;
  connectors: ConnectorView[];
  onPick: (preset: ConnectorPreset) => void;
}) {
  const known = knownEnv(connectors);
  return (
    <ul className="cn-presets">
      {presets.map((preset) => {
        const blocked =
          !allowStdio && (preset.requiresStdio || preset.transport === 'stdio');
        return (
          <li key={preset.id} className="cn-preset" data-preset={preset.id}>
            <div className="cn-row-head">
              <strong>{preset.name}</strong>
              <span className="cn-transport">
                {preset.transport === 'http'
                  ? 'Remote (http)'
                  : 'Local program'}
              </span>
              <button
                type="button"
                disabled={blocked}
                onClick={() => onPick(preset)}
              >
                Use
              </button>
            </div>
            {preset.requiredEnv.length > 0 && (
              <ul className="cn-values">
                {preset.requiredEnv.map((variable) => {
                  const isSet = known.get(variable.name);
                  return (
                    <li key={variable.name}>
                      <code>{variable.name}</code> {variable.label}
                      {isSet !== undefined && (
                        <>
                          {' '}
                          <span className={isSet ? 'cn-set' : 'cn-unset'}>
                            {isSet ? 'set' : 'not set'}
                          </span>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {preset.note && <p className="cn-note">{preset.note}</p>}
            {blocked && (
              <p className="cn-note cn-note-warn">{STDIO_OFF_NOTE}</p>
            )}
            <a href={preset.docsUrl} target="_blank" rel="noreferrer">
              Docs ↗
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function ConnectorForm({
  draft,
  allowStdio,
  busy,
  problems,
  warnings,
  onChange,
  onSave,
  onCancel,
}: {
  draft: ConnectorDraft;
  allowStdio: boolean;
  busy: boolean;
  problems: string[];
  warnings: string[];
  onChange: (draft: ConnectorDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const editing = !!draft.id;
  const set = (patch: Partial<ConnectorDraft>) =>
    onChange({ ...draft, ...patch });
  const setRow = (index: number, patch: Partial<ValueRow>) =>
    set({
      rows: draft.rows.map((row, i) =>
        i === index ? { ...row, ...patch } : row,
      ),
    });
  return (
    <div className="cn-form" role="group" aria-label="Connector details">
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
          set({ transport: event.target.value as ConnectorTransport, rows: [] })
        }
      >
        <option value="http">Remote server (http)</option>
        <option value="stdio" disabled={!allowStdio}>
          Local program (stdio)
        </option>
      </select>
      {!allowStdio && <p className="cn-note cn-note-warn">{STDIO_OFF_NOTE}</p>}
      {draft.transport === 'http' ? (
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
              className="cn-remove"
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
          onClick={() =>
            set({
              rows: [...draft.rows, { name: '', kind: 'env', value: '' }],
            })
          }
        >
          Add {draft.transport === 'http' ? 'header' : 'variable'}
        </button>
      </fieldset>
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
      <div className="cn-actions">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={onSave}
        >
          {busy ? 'Saving…' : editing ? 'Save connector' : 'Add connector'}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ConnectorsSettings({
  initial,
}: {
  /** Data for the first render (tests, or a parent that already fetched it). */
  initial?: ConnectorsData;
}) {
  const [data, setData] = useState<ConnectorsData | undefined>(initial);
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [message, setMessage] = useState('');
  const [draft, setDraft] = useState<ConnectorDraft | undefined>();
  const [problems, setProblems] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<ConnectorsData>('/connectors'));
      setLoadError('');
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : 'Could not load connectors.',
      );
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const replace = (view: ConnectorView) =>
    setData(
      (current) =>
        current && {
          ...current,
          connectors: current.connectors.map((item) =>
            item.id === view.id ? view : item,
          ),
        },
    );

  const run = async (id: string, action: () => Promise<void>) => {
    setBusyId(id);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'That did not work.');
    }
    setBusyId('');
  };

  const save = async () => {
    if (!draft) return;
    const local = validateDraft(draft);
    setProblems(local);
    setWarnings([]);
    if (local.length) return;
    setSaving(true);
    try {
      const body = draftToBody(draft);
      if (draft.id)
        await connectorRequest<ConnectorView>(
          `/connectors/${draft.id}`,
          'PATCH',
          body,
        );
      else await connectorRequest<ConnectorView>('/connectors', 'POST', body);
      setDraft(undefined);
      await load();
    } catch (error) {
      if (error instanceof ConnectorRequestError) {
        setProblems(error.errors.length ? error.errors : [error.message]);
        setWarnings(error.warnings);
      } else
        setProblems([
          error instanceof Error ? error.message : 'Could not save.',
        ]);
    }
    setSaving(false);
  };

  const startDraft = (next: ConnectorDraft) => {
    setDraft(next);
    setProblems([]);
    setWarnings([]);
  };

  const connectors = data?.connectors ?? [];
  const allowStdio = data?.allowStdio ?? false;
  return (
    <div
      className="cn-root"
      onKeyDown={(event) => {
        // These fields live inside the settings form: Enter must not submit it.
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          if (draft) void save();
        }
      }}
    >
      {loadError && (
        <p className="cn-problems" role="alert">
          {loadError}
        </p>
      )}
      {!data && !loadError && <p className="muted">Loading connectors…</p>}
      {data && connectors.length === 0 && (
        <p className="muted">
          No connectors yet. Add one to let a Dot use another service.
        </p>
      )}
      {connectors.length > 0 && (
        <ul className="cn-list">
          {connectors.map((connector) => (
            <ConnectorRow
              key={connector.id}
              connector={connector}
              busy={busyId === connector.id}
              onToggle={() =>
                void run(connector.id, async () => {
                  replace(
                    await connectorRequest<ConnectorView>(
                      `/connectors/${connector.id}`,
                      'PATCH',
                      { enabled: !connector.enabled },
                    ),
                  );
                })
              }
              onReload={() =>
                void run(connector.id, async () => {
                  replace(
                    await api<ConnectorView>(
                      `/connectors/${connector.id}/reload`,
                      'POST',
                      {},
                    ),
                  );
                })
              }
              onTest={() =>
                void run(connector.id, async () => {
                  const status = await api<ConnectorStatus>(
                    `/connectors/${connector.id}/test`,
                    'POST',
                    {},
                  );
                  replace({ ...connector, status });
                })
              }
              onEdit={() => startDraft(connectorToDraft(connector))}
              onDelete={() => {
                if (
                  !window.confirm(
                    `Delete the connector "${connector.name}"? Dots lose access to it.`,
                  )
                )
                  return;
                void run(connector.id, async () => {
                  await api(`/connectors/${connector.id}`, 'DELETE', {});
                  await load();
                });
              }}
            />
          ))}
        </ul>
      )}
      {message && (
        <p className="cn-problems" role="alert">
          {message}
        </p>
      )}
      <details className="cn-add" open={!!draft || undefined}>
        <summary>Add connector</summary>
        {data && (
          <>
            <p className="muted">Start from a preset, or fill in your own.</p>
            <PresetPicker
              presets={data.presets}
              allowStdio={allowStdio}
              connectors={connectors}
              onPick={(preset) => startDraft(presetToDraft(preset))}
            />
            {!draft && (
              <button type="button" onClick={() => startDraft(emptyDraft())}>
                Custom connector
              </button>
            )}
          </>
        )}
        {draft && (
          <ConnectorForm
            draft={draft}
            allowStdio={allowStdio}
            busy={saving}
            problems={problems}
            warnings={warnings}
            onChange={setDraft}
            onSave={() => void save()}
            onCancel={() => setDraft(undefined)}
          />
        )}
      </details>
    </div>
  );
}
