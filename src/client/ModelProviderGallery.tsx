import { useId, useState } from 'react';
import {
  Check,
  CircleAlert,
  KeyRound,
  Monitor,
  Search,
  Server,
  Star,
  type LucideIcon,
} from 'lucide-react';
import { authHeaders } from './api';
import { ModelLogo } from './model-logos';
import { ModelPicker, type ModelChoice } from './ModelPicker';
import type { ModelPreset, ModelProviderView } from '../shared/model-presets';
import './model-providers.css';

// ---- Data ------------------------------------------------------------------------

export interface DefaultModel {
  providerId: string;
  model: string;
}

/** `GET /api/model-providers`. */
export interface ModelProvidersData {
  providers: ModelProviderView[];
  presets: ModelPreset[];
  defaultModel: DefaultModel | null;
}

// ---- Requests --------------------------------------------------------------------

export class ModelProviderRequestError extends Error {
  constructor(
    message: string,
    public status = 0,
    /** On a 409 (provider still in use): the Dots, or "default model", that use it. */
    public dots: string[] = [],
  ) {
    super(message);
  }
}

/** Like `api()`, but keeps the status and the `dots` list of a 409 and tolerates a 204. */
export async function providerRequest<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      ...authHeaders(),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
    dots?: unknown;
  };
  if (!response.ok)
    throw new ModelProviderRequestError(
      data.error ?? `Request failed (${response.status}).`,
      response.status,
      Array.isArray(data.dots)
        ? data.dots.filter((dot): dot is string => typeof dot === 'string')
        : [],
    );
  return data as T;
}

// ---- Names and captions -----------------------------------------------------------

/** "https://api.groq.com/openai/v1/" -> "api.groq.com/openai/v1". */
export function hostPath(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

export function presetOf(
  presets: ModelPreset[],
  view: Pick<ModelProviderView, 'presetId'>,
): ModelPreset | undefined {
  return presets.find((preset) => preset.id === view.presetId);
}

/** One muted line: the preset name (when it adds something) and the address, in plain type. */
export function providerSubtitle(
  view: ModelProviderView,
  preset: ModelPreset | undefined,
): string {
  const address = hostPath(view.baseUrl);
  return preset && preset.name !== view.name
    ? `${preset.name} · ${address}`
    : address;
}

export interface Caption {
  label: string;
  icon: LucideIcon;
}

/** The small chip on a preset card. */
export function presetCaption(preset: ModelPreset): Caption {
  if (preset.id === 'custom')
    return { label: 'Any compatible server', icon: Server };
  if (preset.local) return { label: 'Runs on this computer', icon: Monitor };
  return { label: 'API key', icon: KeyRound };
}

// ---- Status -----------------------------------------------------------------------

export type StatusTone = 'ok' | 'warn' | 'bad' | 'neutral';

export interface ProviderStatus {
  tone: StatusTone;
  label: string;
  /** The reason, shown on its own line under the name. */
  detail?: string;
}

/**
 * The pill on a provider card. `count` is the number of models, once known.
 * Order matters: a provider that is off says so before anything else.
 */
export function providerStatus(
  view: ModelProviderView,
  preset: ModelPreset | undefined,
  count?: number,
): ProviderStatus {
  if (!view.enabled) return { tone: 'neutral', label: 'Disabled' };
  if (view.key.kind !== 'none' && !view.key.set)
    return {
      tone: 'warn',
      label: 'Key missing',
      detail:
        view.key.kind === 'env' && view.key.envName
          ? `Set ${view.key.envName} in the server .env and restart.`
          : 'The saved key could not be used. Paste it again.',
    };
  if (view.lastError)
    return preset?.local
      ? {
          tone: 'warn',
          label: 'Not running',
          detail: `${preset.name} did not answer. Start it, then test again.`,
        }
      : { tone: 'bad', label: 'Error', detail: view.lastError };
  if (count !== undefined)
    return {
      tone: 'ok',
      label: `Ready · ${count} ${count === 1 ? 'model' : 'models'}`,
    };
  if (view.lastTestedAt === null && !view.builtIn)
    return { tone: 'neutral', label: 'Not tested yet' };
  return { tone: 'ok', label: 'Ready' };
}

export function StatusPill({ status }: { status: ProviderStatus }) {
  return (
    <span className="cn-status">
      <span
        className={`cn-pill cn-pill-${status.tone}`}
        data-tone={status.tone}
      >
        {status.tone === 'ok' && (
          <Check size={12} strokeWidth={2.4} aria-hidden="true" />
        )}
        {status.label}
      </span>
    </span>
  );
}

// ---- Filtering ---------------------------------------------------------------------

const norm = (text: string) => text.trim().toLowerCase();

export function filterProviders(
  providers: ModelProviderView[],
  presets: ModelPreset[],
  query: string,
): ModelProviderView[] {
  const needle = norm(query);
  if (!needle) return providers;
  return providers.filter((view) =>
    [
      view.name,
      presetOf(presets, view)?.name ?? '',
      view.baseUrl,
      view.presetId,
    ].some((text) => norm(text).includes(needle)),
  );
}

export function filterPresets(
  presets: ModelPreset[],
  query: string,
): ModelPreset[] {
  const needle = norm(query);
  if (!needle) return presets;
  return presets.filter((preset) =>
    [preset.id, preset.name, preset.description].some((text) =>
      norm(text).includes(needle),
    ),
  );
}

/** "OpenRouter · deepseek/deepseek-v4" for the default model bar. */
export function defaultModelLabel(
  defaultModel: DefaultModel | null,
  providers: ModelProviderView[],
): string {
  if (!defaultModel) return '';
  const provider = providers.find(
    (item) => item.id === defaultModel.providerId,
  );
  return `${provider?.name ?? defaultModel.providerId} · ${defaultModel.model}`;
}

// ---- Gallery -----------------------------------------------------------------------

export interface ModelGalleryProps {
  providers: ModelProviderView[];
  presets: ModelPreset[];
  defaultModel: DefaultModel | null;
  /** Model counts, for the cards whose list has been fetched. */
  counts?: Record<string, number>;
  /** A failed attempt to change the default model. */
  defaultError?: string;
  onOpenProvider: (provider: ModelProviderView) => void;
  onOpenPreset: (preset: ModelPreset) => void;
  onChangeDefault: (choice: ModelChoice) => void;
  initialQuery?: string;
}

function ProviderCard({
  view,
  preset,
  count,
  isDefault,
  onOpen,
}: {
  view: ModelProviderView;
  preset: ModelPreset | undefined;
  count: number | undefined;
  isDefault: boolean;
  onOpen: () => void;
}) {
  const status = providerStatus(view, preset, count);
  const subtitle = providerSubtitle(view, preset);
  return (
    <li
      className="cg-card mp-card"
      data-provider={view.id}
      data-tone={status.tone}
    >
      <div className="cg-card-head">
        <ModelLogo presetId={view.presetId} size={56} />
        <div className="cg-card-id">
          <button
            type="button"
            className="cg-card-open"
            onClick={onOpen}
            aria-label={`${view.name}, ${status.label}. Open details`}
          >
            {view.name}
          </button>
          <span className="cg-sub" title={subtitle}>
            {subtitle}
          </span>
        </div>
      </div>
      {status.detail && (
        <p className="cg-card-note">
          <CircleAlert size={13} aria-hidden="true" />
          <span
            className={
              status.tone === 'bad'
                ? 'cn-detail cn-detail-bad'
                : 'cn-detail cn-detail-warn'
            }
          >
            {status.detail}
          </span>
        </p>
      )}
      <div className="cg-card-foot">
        <StatusPill status={status} />
        {view.builtIn && <span className="mp-badge">From .env</span>}
        {isDefault && (
          <span className="mp-badge mp-badge-default">
            <Star size={11} aria-hidden="true" />
            Default
          </span>
        )}
      </div>
    </li>
  );
}

function PresetCard({
  preset,
  added,
  onOpen,
}: {
  preset: ModelPreset;
  added: number;
  onOpen: () => void;
}) {
  const caption = presetCaption(preset);
  const descId = useId();
  return (
    <li
      className="cg-card cg-card-preset"
      data-preset={preset.id}
      data-added={added > 0 ? 'true' : undefined}
    >
      <div className="cg-card-head">
        <ModelLogo presetId={preset.id} size={56} />
        <div className="cg-card-id">
          <button
            type="button"
            className="cg-card-open"
            aria-describedby={descId}
            onClick={onOpen}
          >
            {preset.name}
          </button>
          <span className="cg-sub">
            {preset.baseUrl ? hostPath(preset.baseUrl) : 'You choose the URL'}
          </span>
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
        {added > 0 && (
          <span className="cg-added mp-added">
            <Check size={13} strokeWidth={2.4} aria-hidden="true" />
            {added} added
          </span>
        )}
        <span className="cg-go" aria-hidden="true">
          Set up
        </span>
      </div>
    </li>
  );
}

export function ModelProviderGallery({
  providers,
  presets,
  defaultModel,
  counts = {},
  defaultError,
  onOpenProvider,
  onOpenPreset,
  onChangeDefault,
  initialQuery = '',
}: ModelGalleryProps) {
  const [query, setQuery] = useState(initialQuery);
  const searchId = useId();
  const mine = filterProviders(providers, presets, query);
  const available = filterPresets(presets, query);
  const addedCount = (presetId: string) =>
    providers.filter((view) => view.presetId === presetId && !view.builtIn)
      .length;
  const userProviders = providers.filter((view) => !view.builtIn);
  const defaultProvider = defaultModel
    ? providers.find((view) => view.id === defaultModel.providerId)
    : undefined;
  return (
    <div className="cg-root mp-root">
      <header className="cg-header">
        <div className="cg-titles">
          <h3 className="cg-title">Models</h3>
          <p className="cg-subtitle">
            Bring your own keys. Keys are encrypted on this computer and never
            shown again.
          </p>
        </div>
        <div className="cg-tools">
          <div className="cg-search">
            <Search size={15} aria-hidden="true" />
            <input
              id={searchId}
              type="search"
              value={query}
              placeholder="Search providers"
              aria-label="Search providers"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
      </header>

      <section className="mp-default" aria-label="Default model">
        <span className="mp-default-icon" aria-hidden="true">
          <Star size={18} />
        </span>
        <div className="mp-default-text">
          <span className="mp-default-label">Default model</span>
          {defaultModel ? (
            <span className="mp-default-value">
              {defaultProvider && (
                <ModelLogo presetId={defaultProvider.presetId} size={20} />
              )}
              <span className="mp-default-name">
                {defaultModelLabel(defaultModel, providers)}
              </span>
            </span>
          ) : (
            <span className="mp-default-value mp-default-none">
              None yet. Add a provider, then choose a model.
            </span>
          )}
          <small>Dots without a model of their own use this one.</small>
          {defaultError && (
            <small className="mp-default-error" role="alert">
              {defaultError}
            </small>
          )}
        </div>
        {providers.length > 0 && (
          <ModelPicker
            variant="button"
            buttonLabel={defaultModel ? 'Change' : 'Choose'}
            allowDefault={false}
            value={{
              providerId: defaultModel?.providerId ?? null,
              model: defaultModel?.model ?? '',
            }}
            onChange={onChangeDefault}
          />
        )}
      </section>

      {providers.length > 0 && (
        <section className="cg-section" aria-labelledby={`${searchId}-mine`}>
          <h4 className="cg-heading" id={`${searchId}-mine`}>
            Your providers{' '}
            <span className="cg-heading-count">{mine.length}</span>
          </h4>
          {mine.length > 0 ? (
            <ul className="cg-grid">
              {mine.map((view) => (
                <ProviderCard
                  key={view.id}
                  view={view}
                  preset={presetOf(presets, view)}
                  count={counts[view.id]}
                  isDefault={defaultModel?.providerId === view.id}
                  onOpen={() => onOpenProvider(view)}
                />
              ))}
            </ul>
          ) : (
            <p className="cg-empty">No provider matches.</p>
          )}
        </section>
      )}

      <section className="cg-section" aria-labelledby={`${searchId}-add`}>
        <h4 className="cg-heading" id={`${searchId}-add`}>
          Add a provider
        </h4>
        {userProviders.length === 0 && !norm(query) && (
          <p className="cg-lead">
            {providers.length === 0
              ? 'No providers yet. Pick one below to give your Dots a model.'
              : 'Only the .env provider so far. Pick another below to use more models.'}
          </p>
        )}
        {available.length > 0 ? (
          <ul className="cg-grid">
            {available.map((preset) => (
              <PresetCard
                key={preset.id}
                preset={preset}
                added={addedCount(preset.id)}
                onOpen={() => onOpenPreset(preset)}
              />
            ))}
          </ul>
        ) : (
          <p className="cg-empty">No provider matches.</p>
        )}
        <p className="cg-note mp-footnote" role="note">
          Looking for Perplexity? Add OpenRouter and use its perplexity/ models.
        </p>
      </section>
    </div>
  );
}
