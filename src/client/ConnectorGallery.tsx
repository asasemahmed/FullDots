import { useId, useState } from 'react';
import {
  Check,
  CircleAlert,
  Globe,
  KeyRound,
  LoaderCircle,
  LogIn,
  Plug,
  Plus,
  Search,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import { ConnectorLogo } from './connector-logos';
import type {
  ConnectorPreset,
  ConnectorPresetCategory,
} from '../shared/connector-presets';
import type { ConnectorStatus, ConnectorView } from '../shared/types';

export const STDIO_OFF_NOTE =
  'Local program connectors are off. Set CONNECTORS_ALLOW_STDIO=true on the server to allow them.';

// ---- Names and captions ----------------------------------------------------

const PRETTY: Record<string, string> = {
  github: 'GitHub',
  paypal: 'PayPal',
  huggingface: 'Hugging Face',
  'google-drive': 'Google Drive',
  'google-calendar': 'Google Calendar',
  gmail: 'Gmail',
  neon: 'Neon',
  'cloudflare-docs': 'Cloudflare Docs',
  filesystem: 'Files',
  fetch: 'Web pages',
};

/** "github" -> "GitHub", "my-tool" -> "My Tool". */
export function prettyName(id: string): string {
  return (
    PRETTY[id] ??
    id
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((word) => word[0]!.toUpperCase() + word.slice(1))
      .join(' ')
  );
}

/** Presets show their friendly name; a connector keeps its own name unless it is the preset's default. */
export function connectorTitle(connector: ConnectorView): string {
  return connector.presetId && connector.name === connector.presetId
    ? prettyName(connector.presetId)
    : connector.name;
}

/** One muted line: the URL without its scheme, or the command. */
export function connectorSubtitle(connector: {
  transport: 'http' | 'stdio';
  url: string | null;
  command: string | null;
  args: string[];
}): string {
  if (connector.transport === 'stdio')
    return [connector.command ?? '', ...connector.args].join(' ').trim();
  return (connector.url ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export interface Caption {
  label: string;
  icon: LucideIcon;
}

/** The small chip on a preset card. */
export function authCaption(preset: ConnectorPreset): Caption {
  if (preset.transport === 'stdio')
    return { label: 'Local program', icon: Terminal };
  if (preset.auth === 'oauth') return { label: 'Browser sign-in', icon: Globe };
  if (preset.auth === 'token') return { label: 'Token', icon: KeyRound };
  return { label: 'No sign-in', icon: LogIn };
}

export const CATEGORY_LABEL: Record<ConnectorPresetCategory, string> = {
  work: 'Work',
  dev: 'Developer tools',
  data: 'Data',
  files: 'Files',
  web: 'Web',
};
const CATEGORY_ORDER: ConnectorPresetCategory[] = [
  'work',
  'dev',
  'data',
  'files',
  'web',
];

export const categoryLabel = (category: string | undefined): string =>
  CATEGORY_LABEL[category as ConnectorPresetCategory] ?? 'Other';

export interface PresetGroup {
  category: ConnectorPresetCategory | 'other';
  presets: ConnectorPreset[];
}

/** Presets by category, in a fixed order; one without a known category goes last under Other. */
export function groupPresets(presets: ConnectorPreset[]): PresetGroup[] {
  const groups: PresetGroup[] = CATEGORY_ORDER.map((category) => ({
    category,
    presets: presets.filter((preset) => preset.category === category),
  }));
  groups.push({
    category: 'other',
    presets: presets.filter(
      (preset) => !CATEGORY_ORDER.includes(preset.category),
    ),
  });
  return groups.filter((group) => group.presets.length > 0);
}

// ---- Status ----------------------------------------------------------------

const STATE_LABEL: Record<ConnectorStatus['state'], string> = {
  connected: 'Connected',
  error: 'Error',
  missing_env: 'Setup needed',
  needs_auth: 'Not connected',
  disabled: 'Off',
  connecting: 'Connecting…',
};
const STATE_TONE: Record<ConnectorStatus['state'], string> = {
  connected: 'ok',
  error: 'bad',
  missing_env: 'warn',
  needs_auth: 'warn',
  disabled: 'neutral',
  connecting: 'neutral',
};

export const needsAttention = (connector: ConnectorView) =>
  connector.enabled &&
  ['needs_auth', 'missing_env', 'error'].includes(connector.status.state);

/**
 * The status pill. `detail` adds the reason next to it (an error text, the
 * missing variables); cards pass `detail={false}` and show it on its own line.
 */
export function StatusPill({
  status,
  detail = true,
}: {
  status: ConnectorStatus;
  detail?: boolean;
}) {
  return (
    <span className="cn-status">
      <span
        className={`cn-pill cn-pill-${STATE_TONE[status.state]}`}
        data-state={status.state}
      >
        {status.state === 'connected' && (
          <Check size={12} strokeWidth={2.4} aria-hidden="true" />
        )}
        {status.state === 'connecting' && (
          <LoaderCircle
            size={12}
            strokeWidth={2.4}
            className="cx-spin"
            aria-hidden="true"
          />
        )}
        {STATE_LABEL[status.state]}
      </span>
      {detail && <StatusDetail status={status} />}
    </span>
  );
}

export function StatusDetail({ status }: { status: ConnectorStatus }) {
  if (status.state === 'error' && status.error)
    return <span className="cn-detail cn-detail-bad">{status.error}</span>;
  if (status.state === 'missing_env')
    return (
      <span className="cn-detail cn-detail-warn">
        Set{' '}
        {(status.missing ?? []).map((name, index) => (
          <span key={name}>
            {index > 0 && ', '}
            <code>{name}</code>
          </span>
        ))}{' '}
        on the server
      </span>
    );
  return null;
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

// ---- Filtering ---------------------------------------------------------------

export type GalleryFilter = 'all' | 'connected' | 'attention';
const FILTERS: { id: GalleryFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'connected', label: 'Connected' },
  { id: 'attention', label: 'Needs attention' },
];

const norm = (text: string) => text.trim().toLowerCase();

export function filterConnectors(
  connectors: ConnectorView[],
  query: string,
  filter: GalleryFilter,
): ConnectorView[] {
  const needle = norm(query);
  return connectors.filter((connector) => {
    if (filter === 'connected' && connector.status.state !== 'connected')
      return false;
    if (filter === 'attention' && !needsAttention(connector)) return false;
    if (!needle) return true;
    return [
      connector.name,
      connectorTitle(connector),
      connectorSubtitle(connector),
    ].some((text) => norm(text).includes(needle));
  });
}

export function filterPresets(
  presets: ConnectorPreset[],
  query: string,
): ConnectorPreset[] {
  const needle = norm(query);
  if (!needle) return presets;
  return presets.filter((preset) =>
    [
      preset.id,
      preset.name,
      prettyName(preset.id),
      preset.description,
      preset.url ?? '',
      categoryLabel(preset.category),
    ].some((text) => norm(text).includes(needle)),
  );
}

export const isPresetBlocked = (preset: ConnectorPreset, allowStdio: boolean) =>
  !allowStdio && (preset.requiresStdio || preset.transport === 'stdio');

// ---- Gallery -------------------------------------------------------------------

export interface GalleryProps {
  connectors: ConnectorView[];
  presets: ConnectorPreset[];
  allowStdio: boolean;
  /** The connector whose browser sign-in is in progress. */
  connectingId?: string;
  onOpenConnector: (connector: ConnectorView) => void;
  /** The card's inline "Connect": starts the browser sign-in. */
  onConnect: (connector: ConnectorView) => void;
  onOpenPreset: (preset: ConnectorPreset) => void;
  onCustom: () => void;
  initialQuery?: string;
  initialFilter?: GalleryFilter;
}

function ConnectorCard({
  connector,
  connecting,
  onOpen,
  onConnect,
}: {
  connector: ConnectorView;
  connecting: boolean;
  onOpen: () => void;
  onConnect: () => void;
}) {
  const { status } = connector;
  const tools = status.tools.length;
  const title = connectorTitle(connector);
  const subtitle = connectorSubtitle(connector);
  const canConnect =
    connector.enabled &&
    status.state === 'needs_auth' &&
    connector.auth === 'oauth';
  return (
    <li
      className="cg-card"
      data-connector={connector.name}
      data-state={status.state}
    >
      <div className="cg-card-head">
        <ConnectorLogo
          presetId={connector.presetId}
          name={connector.name}
          url={connector.url}
          transport={connector.transport}
          size={56}
        />
        <div className="cg-card-id">
          <button
            type="button"
            className="cg-card-open"
            onClick={onOpen}
            aria-label={`${title}, ${STATE_LABEL[status.state]}. Open details`}
          >
            {title}
          </button>
          <span className="cg-sub" title={subtitle}>
            {subtitle}
          </span>
        </div>
      </div>
      {(status.state === 'error' || status.state === 'missing_env') && (
        <p className="cg-card-note">
          <CircleAlert size={13} aria-hidden="true" />
          <StatusDetail status={status} />
        </p>
      )}
      <div className="cg-card-foot">
        <StatusPill status={status} detail={false} />
        <span className="cg-count">
          {tools} {tools === 1 ? 'tool' : 'tools'}
        </span>
        {canConnect && (
          <button
            type="button"
            className="cg-action cg-action-primary"
            disabled={connecting}
            onClick={onConnect}
          >
            {connecting ? (
              <>
                <LoaderCircle
                  size={14}
                  className="cx-spin"
                  aria-hidden="true"
                />
                Waiting…
              </>
            ) : (
              'Connect'
            )}
          </button>
        )}
        {connector.enabled && status.state === 'missing_env' && (
          <button
            type="button"
            className="cg-action cg-action-primary"
            onClick={onOpen}
          >
            Set up
          </button>
        )}
      </div>
    </li>
  );
}

function PresetCard({
  preset,
  added,
  blocked,
  onOpen,
}: {
  preset: ConnectorPreset;
  added: boolean;
  blocked: boolean;
  onOpen: () => void;
}) {
  const caption = authCaption(preset);
  const descId = useId();
  return (
    <li
      className="cg-card cg-card-preset"
      data-preset={preset.id}
      data-added={added ? 'true' : undefined}
      data-blocked={blocked ? 'true' : undefined}
    >
      <div className="cg-card-head">
        <ConnectorLogo
          presetId={preset.id}
          name={preset.name}
          url={preset.url}
          transport={preset.transport}
          size={56}
        />
        <div className="cg-card-id">
          <button
            type="button"
            className="cg-card-open"
            disabled={blocked}
            aria-describedby={descId}
            onClick={onOpen}
          >
            {prettyName(preset.id)}
          </button>
          <span className="cg-sub">{categoryLabel(preset.category)}</span>
        </div>
      </div>
      <p className="cg-desc" id={descId}>
        {preset.description}
      </p>
      <div className="cg-card-foot">
        <span className="cg-chip">
          <caption.icon size={12} aria-hidden="true" />
          {caption.label}
        </span>
        {blocked ? (
          <span className="cg-added cg-off">Off on this server</span>
        ) : added ? (
          <span className="cg-added">
            <Check size={13} strokeWidth={2.4} aria-hidden="true" />
            Added
          </span>
        ) : (
          <span className="cg-go" aria-hidden="true">
            Set up
          </span>
        )}
      </div>
    </li>
  );
}

export function ConnectorGallery({
  connectors,
  presets,
  allowStdio,
  connectingId,
  onOpenConnector,
  onConnect,
  onOpenPreset,
  onCustom,
  initialQuery = '',
  initialFilter = 'all',
}: GalleryProps) {
  const [query, setQuery] = useState(initialQuery);
  const [filter, setFilter] = useState<GalleryFilter>(initialFilter);
  const searchId = useId();
  const mine = filterConnectors(connectors, query, filter);
  const groups = groupPresets(filterPresets(presets, query));
  const addedPresets = new Set(
    connectors.flatMap((connector) =>
      connector.presetId ? [connector.presetId] : [],
    ),
  );
  const anyBlocked =
    !allowStdio && presets.some((preset) => isPresetBlocked(preset, false));
  const showCustom = !norm(query) || 'custom connector'.includes(norm(query));
  const attention = connectors.filter(needsAttention).length;
  return (
    <div className="cg-root">
      <header className="cg-header">
        <div className="cg-titles">
          <h3 className="cg-title">Connectors</h3>
          <p className="cg-subtitle">
            Give your Dots access to the tools you use. Sign in with your
            browser — secrets stay on this computer.
          </p>
        </div>
        <div className="cg-tools">
          <div className="cg-search">
            <Search size={15} aria-hidden="true" />
            <input
              id={searchId}
              type="search"
              value={query}
              placeholder="Search connectors"
              aria-label="Search connectors"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="cg-filter" role="group" aria-label="Show">
            {FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="cg-filter-btn"
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
                {item.id === 'attention' && attention > 0 && (
                  <span className="cg-badge">{attention}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      </header>

      {connectors.length > 0 && (
        <section className="cg-section" aria-labelledby={`${searchId}-mine`}>
          <h4 className="cg-heading" id={`${searchId}-mine`}>
            Your connectors{' '}
            <span className="cg-heading-count">{mine.length}</span>
          </h4>
          {mine.length > 0 ? (
            <ul className="cg-grid">
              {mine.map((connector) => (
                <ConnectorCard
                  key={connector.id}
                  connector={connector}
                  connecting={connectingId === connector.id}
                  onOpen={() => onOpenConnector(connector)}
                  onConnect={() => onConnect(connector)}
                />
              ))}
            </ul>
          ) : (
            <p className="cg-empty">
              {filter === 'attention' && !norm(query)
                ? 'Nothing needs attention.'
                : 'No connector matches.'}
            </p>
          )}
        </section>
      )}

      <section className="cg-section" aria-labelledby={`${searchId}-add`}>
        <h4 className="cg-heading" id={`${searchId}-add`}>
          Add a connector
        </h4>
        {connectors.length === 0 && !norm(query) && (
          <p className="cg-lead">
            No connectors yet. Pick one below to let a Dot use another service.
          </p>
        )}
        {groups.map((group) => (
          <div className="cg-group" key={group.category}>
            <h5 className="cg-group-title">{categoryLabel(group.category)}</h5>
            <ul className="cg-grid">
              {group.presets.map((preset) => (
                <PresetCard
                  key={preset.id}
                  preset={preset}
                  added={addedPresets.has(preset.id)}
                  blocked={isPresetBlocked(preset, allowStdio)}
                  onOpen={() => {
                    const existing = connectors.find(
                      (connector) => connector.presetId === preset.id,
                    );
                    if (existing) onOpenConnector(existing);
                    else onOpenPreset(preset);
                  }}
                />
              ))}
            </ul>
          </div>
        ))}
        {(showCustom || groups.length === 0) && (
          <div className="cg-group">
            {groups.length > 0 && (
              <h5 className="cg-group-title">Your own server</h5>
            )}
            <ul className="cg-grid">
              {showCustom && (
                <li className="cg-card cg-card-preset" data-preset="custom">
                  <div className="cg-card-head">
                    <ConnectorLogo name="" transport="http" size={56} />
                    <div className="cg-card-id">
                      <button
                        type="button"
                        className="cg-card-open"
                        onClick={onCustom}
                        aria-describedby={`${searchId}-custom`}
                      >
                        Custom connector
                      </button>
                      <span className="cg-sub">Any MCP server</span>
                    </div>
                  </div>
                  <p className="cg-desc" id={`${searchId}-custom`}>
                    Connect a remote server by URL, or run a local program.
                  </p>
                  <div className="cg-card-foot">
                    <span className="cg-chip">
                      <Plug size={12} aria-hidden="true" />
                      Your choice
                    </span>
                    <span className="cg-go" aria-hidden="true">
                      <Plus size={13} /> Add
                    </span>
                  </div>
                </li>
              )}
            </ul>
            {groups.length === 0 && !showCustom && (
              <p className="cg-empty">No connector matches.</p>
            )}
          </div>
        )}
        {/* Local programs are greyed out below; say why once, after the cards. */}
        {anyBlocked && (
          <p className="cg-note" role="note">
            {STDIO_OFF_NOTE}
          </p>
        )}
      </section>
    </div>
  );
}
