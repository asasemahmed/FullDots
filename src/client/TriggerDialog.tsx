import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CircleAlert, Copy, Webhook, X, Radar } from 'lucide-react';
import { api } from './api';
import { useModalDialog } from './useModalDialog';
import type {
  ConnectorView,
  DotConnectorGrant,
  Trigger,
  TriggerAuth,
} from '../shared/types';
import './automations.css';

const INTERVALS: [string, string][] = [
  ['60', 'Every minute'],
  ['300', 'Every 5 minutes'],
  ['900', 'Every 15 minutes'],
  ['3600', 'Every hour'],
  ['86400', 'Every day'],
];
const AUTH: [TriggerAuth, string, string][] = [
  [
    'bearer',
    'Bearer token',
    'The caller sends Authorization: Bearer <secret>.',
  ],
  [
    'hmac',
    'Signed body (HMAC)',
    'For GitHub and services that sign each delivery with a shared secret.',
  ],
  [
    'query',
    'Secret in the URL',
    'For services that can only call a URL. Anyone with the URL can fire it.',
  ],
];

interface Created {
  trigger: Trigger;
  secret: string | null;
  url: string | null;
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="trg-copy">
      <span className="field-label">{label}</span>
      <div className="trg-copy-row">
        <code>{value}</code>
        <button
          type="button"
          className="dlg-btn"
          onClick={() =>
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? (
            <Check size={14} aria-hidden="true" />
          ) : (
            <Copy size={14} aria-hidden="true" />
          )}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <span className="sr-only" role="status">
          {copied ? `${label} copied` : ''}
        </span>
      </div>
    </div>
  );
}

/** Adds a webhook or poll trigger to a conversation. A webhook's secret is shown once, here. */
export function TriggerDialog({
  threadId,
  dotId,
  onClose,
  onCreated,
}: {
  threadId: string;
  dotId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [kind, setKind] = useState<'webhook' | 'poll'>('webhook');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [auth, setAuth] = useState<TriggerAuth>('bearer');
  const [connectors, setConnectors] = useState<ConnectorView[]>([]);
  const [grants, setGrants] = useState<DotConnectorGrant[]>([]);
  const [connectorId, setConnectorId] = useState('');
  const [tool, setTool] = useState('');
  const [args, setArgs] = useState('{}');
  const [interval, setInterval] = useState('300');
  const [dedupePath, setDedupePath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<Created>();
  const container = useRef<HTMLElement>(null);
  const modal = useModalDialog(container, { onClose });
  // The form is replaced by the secret: start there instead of on the page body.
  useEffect(() => {
    if (created) container.current?.focus();
  }, [created]);

  useEffect(() => {
    if (kind !== 'poll') return;
    let live = true;
    void Promise.all([
      api<{ connectors: ConnectorView[] }>('/connectors'),
      api<{ grants: DotConnectorGrant[] }>(`/dots/${dotId}/connectors`),
    ])
      .then(([list, granted]) => {
        if (!live) return;
        setConnectors(list.connectors);
        setGrants(granted.grants);
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [kind, dotId]);

  // Read-only tools this Dot is granted, per connected connector.
  const pollable = useMemo(
    () =>
      connectors
        .map((connector) => {
          const grant = grants.find((g) => g.connectorId === connector.id);
          const tools = grant
            ? connector.status.tools.filter(
                (item) =>
                  item.readOnly &&
                  grant.overrides[item.name] !== 'deny' &&
                  (grant.tools === '*' || grant.tools.includes(item.name)),
              )
            : [];
          return { connector, tools };
        })
        .filter((entry) => entry.tools.length),
    [connectors, grants],
  );
  const toolChoices =
    pollable.find((entry) => entry.connector.id === connectorId)?.tools ?? [];

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      let parsedArgs: Record<string, unknown> = {};
      if (kind === 'poll') {
        try {
          parsedArgs = JSON.parse(args || '{}');
        } catch {
          throw new Error('Tool arguments must be a JSON object.');
        }
        if (
          !parsedArgs ||
          typeof parsedArgs !== 'object' ||
          Array.isArray(parsedArgs)
        )
          throw new Error('Tool arguments must be a JSON object.');
      }
      const result = await api<Created>(
        '/triggers',
        'POST',
        kind === 'webhook'
          ? { kind, threadId, name, prompt, auth }
          : {
              kind,
              threadId,
              name,
              prompt,
              connectorId,
              tool,
              args: parsedArgs,
              intervalSeconds: Number(interval),
              ...(dedupePath.trim() ? { dedupePath: dedupePath.trim() } : {}),
            },
      );
      onCreated();
      if (kind === 'webhook') setCreated(result);
      else onClose();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not create the trigger.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop dlg-backdrop" onClick={onClose}>
      <section
        className="modal dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trigger-title"
        ref={container}
        tabIndex={-1}
        onKeyDown={modal.onKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="dlg-header">
          <div className="dlg-heading">
            <span className="eyebrow">FULLDOTS</span>
            <h2 id="trigger-title">
              {created ? 'Trigger ready' : 'Add a trigger'}
            </h2>
          </div>
          <button
            type="button"
            className="dlg-close"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        {created ? (
          <div className="dlg-body trg-created">
            <p className="dlg-hint">
              Give these to the service that should start this Dot&apos;s work.
              The secret is shown only now; rotate it from the activity view if
              it is lost.
            </p>
            {created.url && (
              <CopyField
                label="Webhook URL"
                value={
                  created.trigger.auth === 'query' && created.secret
                    ? `${created.url}?token=${created.secret}`
                    : created.url
                }
              />
            )}
            {created.secret && created.trigger.auth !== 'query' && (
              <CopyField label="Secret" value={created.secret} />
            )}
            {created.trigger.auth === 'hmac' && (
              <p className="dlg-hint">
                Signature header: <code>{created.trigger.hmacHeader}</code>,
                value <code>{created.trigger.hmacPrefix}</code> followed by the
                hex HMAC-SHA256 of the raw body.
              </p>
            )}
            <footer className="dlg-footer">
              <div className="dlg-actions">
                <button
                  type="button"
                  className="dlg-btn dlg-primary"
                  onClick={onClose}
                >
                  Done
                </button>
              </div>
            </footer>
          </div>
        ) : (
          <form
            className="dlg-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="dlg-body">
              <fieldset className="dlg-segments trg-kinds">
                <legend className="field-label">Starts when</legend>
                {(
                  [
                    [
                      'webhook',
                      'A service calls a URL',
                      'GitHub, Stripe, a form, a script…',
                      Webhook,
                    ],
                    [
                      'poll',
                      'A connector shows something new',
                      'Checks a read-only tool on a schedule.',
                      Radar,
                    ],
                  ] as const
                ).map(([value, label, hint, Icon]) => (
                  <label
                    key={value}
                    className="dlg-segment"
                    data-checked={kind === value}
                  >
                    <input
                      type="radio"
                      name="trigger-kind"
                      checked={kind === value}
                      onChange={() => setKind(value)}
                    />
                    <strong>
                      <Icon size={14} aria-hidden="true" /> {label}
                    </strong>
                    <small>{hint}</small>
                  </label>
                ))}
              </fieldset>
              <label className="field-label" htmlFor="trigger-name">
                Name
              </label>
              <input
                id="trigger-name"
                className="dlg-input"
                maxLength={80}
                required
                placeholder={
                  kind === 'webhook' ? 'New GitHub issue' : 'New Linear issues'
                }
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <label className="field-label" htmlFor="trigger-prompt">
                What the Dot should do
              </label>
              <textarea
                id="trigger-prompt"
                className="dlg-input dlg-textarea"
                rows={3}
                minLength={3}
                maxLength={4000}
                required
                placeholder="Read the event, label the issue, and tell me if it looks urgent."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
              {kind === 'webhook' ? (
                <>
                  <label className="field-label" htmlFor="trigger-auth">
                    How the caller proves it is allowed
                  </label>
                  <select
                    id="trigger-auth"
                    className="dlg-input dlg-select"
                    value={auth}
                    onChange={(e) => setAuth(e.target.value as TriggerAuth)}
                  >
                    {AUTH.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <p className="dlg-hint">
                    {AUTH.find(([value]) => value === auth)?.[2]} The event
                    becomes a task in this conversation; it waits for approvals
                    and budgets like any other work.
                  </p>
                </>
              ) : (
                <>
                  {!pollable.length && (
                    <p className="dlg-hint">
                      This Dot has no read-only connector tools yet. Grant a
                      connector in the Dot settings, then come back.
                    </p>
                  )}
                  <label className="field-label" htmlFor="trigger-connector">
                    Connector
                  </label>
                  <select
                    id="trigger-connector"
                    className="dlg-input dlg-select"
                    required
                    value={connectorId}
                    onChange={(e) => {
                      setConnectorId(e.target.value);
                      setTool('');
                    }}
                  >
                    <option value="">Choose a connector</option>
                    {pollable.map(({ connector }) => (
                      <option key={connector.id} value={connector.id}>
                        {connector.name}
                      </option>
                    ))}
                  </select>
                  <label className="field-label" htmlFor="trigger-tool">
                    Read-only tool to check
                  </label>
                  <select
                    id="trigger-tool"
                    className="dlg-input dlg-select"
                    required
                    value={tool}
                    onChange={(e) => setTool(e.target.value)}
                  >
                    <option value="">Choose a tool</option>
                    {toolChoices.map((item) => (
                      <option key={item.name} value={item.name}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <label className="field-label" htmlFor="trigger-args">
                    Tool arguments (JSON)
                  </label>
                  <textarea
                    id="trigger-args"
                    className="dlg-input dlg-textarea trg-code"
                    rows={3}
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                  />
                  <label className="field-label" htmlFor="trigger-interval">
                    Check
                  </label>
                  <select
                    id="trigger-interval"
                    className="dlg-input dlg-select"
                    value={interval}
                    onChange={(e) => setInterval(e.target.value)}
                  >
                    {INTERVALS.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <label className="field-label" htmlFor="trigger-path">
                    Compare only this field (optional)
                  </label>
                  <input
                    id="trigger-path"
                    className="dlg-input"
                    placeholder="issues.0.id"
                    value={dedupePath}
                    onChange={(e) => setDedupePath(e.target.value)}
                  />
                  <p className="dlg-hint">
                    The first check only remembers the answer. After that, the
                    trigger fires when the answer (or this field of it) changes.
                  </p>
                </>
              )}
            </div>
            <footer className="dlg-footer">
              {error && (
                <p className="dlg-error" role="alert">
                  <CircleAlert size={16} aria-hidden="true" />
                  <span>{error}</span>
                </p>
              )}
              <div className="dlg-actions">
                <button type="button" className="dlg-btn" onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="dlg-btn dlg-primary"
                  disabled={busy}
                >
                  Add trigger
                </button>
              </div>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}
