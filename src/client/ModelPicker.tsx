import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  Check,
  ChevronDown,
  CircleAlert,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Search,
  Sparkles,
} from 'lucide-react';
import { api } from './api';
import { ModelLogo } from './model-logos';
import type { ModelInfo } from '../shared/model-presets';
import './model-providers.css';

/** A provider with the models it offers, as `GET /api/models` returns it. */
export interface PickerProvider {
  id: string;
  name: string;
  presetId: string;
  models: ModelInfo[];
}

export interface ModelsData {
  /** Label of the default model, for example "Groq · llama-3.3-70b-versatile". */
  default?: string | null;
  providers: PickerProvider[];
}

/** What a Dot stores: a model id plus its provider (null provider = the default one). */
export interface ModelChoice {
  providerId: string | null;
  model: string;
}

/** The two Dot fields a choice becomes: an empty model is null, and so is the default provider. */
export function modelFields(choice: ModelChoice): {
  model: string | null;
  modelProviderId: string | null;
} {
  return {
    model: choice.model.trim() || null,
    modelProviderId: choice.providerId,
  };
}

export const MODEL_ID_PATTERN = /^[\w.:/@+-]+$/;
export const MODEL_ID_MAX = 200;
/** Rows drawn per provider; typing narrows the list, so nothing is out of reach. */
export const GROUP_LIMIT = 60;

/** The message under the custom-id field, empty when the id is acceptable. */
export function modelIdProblem(id: string): string {
  const text = id.trim();
  if (!text) return 'Type a model id.';
  if (text.length > MODEL_ID_MAX)
    return `Use at most ${MODEL_ID_MAX} characters.`;
  if (!MODEL_ID_PATTERN.test(text))
    return 'Use letters, digits and . : / @ + - _ only, with no spaces.';
  return '';
}

export function formatContext(tokens: number | undefined): string {
  if (!tokens || tokens < 1) return '';
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000;
    return `${Number.isInteger(value) ? value : value.toFixed(1)}M context`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K context`;
  return `${tokens} context`;
}

export interface PickerGroup {
  provider: PickerProvider;
  /** The rows to draw (capped). */
  models: ModelInfo[];
  /** How many models match in all. */
  total: number;
}

const norm = (text: string) => text.trim().toLowerCase();

/** Providers with the models that match `query` (all of them for a matching provider name). */
export function pickerGroups(
  providers: PickerProvider[],
  query: string,
  limit = GROUP_LIMIT,
): PickerGroup[] {
  const needle = norm(query);
  return providers
    .map((provider) => {
      const providerMatches = !!needle && norm(provider.name).includes(needle);
      const matching =
        !needle || providerMatches
          ? provider.models
          : provider.models.filter((model) =>
              [model.id, model.name ?? ''].some((text) =>
                norm(text).includes(needle),
              ),
            );
      return {
        provider,
        models: matching.slice(0, limit),
        total: matching.length,
      };
    })
    .filter(
      (group) =>
        group.total > 0 ||
        // Keep an empty provider visible while nothing is typed: its refresh button lives here.
        !needle,
    );
}

export type PickerOption =
  | { kind: 'default' }
  | { kind: 'model'; providerId: string; model: string }
  | { kind: 'custom' };

/** The keyboard order: default first, then every drawn model, then "custom". */
export function pickerOptions(
  groups: PickerGroup[],
  allowDefault: boolean,
): PickerOption[] {
  return [
    ...(allowDefault ? [{ kind: 'default' } as const] : []),
    ...groups.flatMap((group) =>
      group.models.map(
        (model) =>
          ({
            kind: 'model',
            providerId: group.provider.id,
            model: model.id,
          }) as const,
      ),
    ),
    { kind: 'custom' } as const,
  ];
}

/** The text on the trigger, and whether the chosen provider has gone missing. */
export function choiceLabel(
  value: ModelChoice,
  providers: PickerProvider[] | undefined,
  defaultLabel: string | null | undefined,
): { text: string; provider?: PickerProvider; stale: boolean } {
  if (value.providerId === null) {
    if (!value.model)
      return {
        text: defaultLabel ? `Default · ${defaultLabel}` : 'Default model',
        stale: false,
      };
    return { text: `Default provider · ${value.model}`, stale: false };
  }
  const provider = providers?.find((item) => item.id === value.providerId);
  return {
    text: `${provider?.name ?? value.providerId} · ${value.model}`,
    ...(provider ? { provider } : {}),
    stale: !!providers && !provider,
  };
}

export interface ModelPickerProps {
  value: ModelChoice;
  onChange: (value: ModelChoice) => void;
  /** Id for the trigger, so a <label htmlFor> can name it. */
  id?: string;
  /** "Provider · model" of the default, shown in the first option. */
  defaultLabel?: string | null;
  /** Offer "Use default" (a Dot's model field); the default-model chooser turns it off. */
  allowDefault?: boolean;
  /** `field` is the wide trigger in a form; `button` is a small button that opens the same list. */
  variant?: 'field' | 'button';
  buttonLabel?: string;
  describedBy?: string;
  /** Provider data for the first render (tests, or a parent that already fetched it). */
  initialData?: ModelsData;
  initialOpen?: boolean;
}

/**
 * A model chooser: a search box over the models of every enabled provider, with the
 * default model first and an escape hatch for typing any model id.
 */
export function ModelPicker({
  value,
  onChange,
  id,
  defaultLabel,
  allowDefault = true,
  variant = 'field',
  buttonLabel = 'Change',
  describedBy,
  initialData,
  initialOpen = false,
}: ModelPickerProps) {
  const uid = useId();
  const listId = `${uid}-list`;
  const [open, setOpen] = useState(initialOpen);
  const [data, setData] = useState<ModelsData | undefined>(initialData);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [mode, setMode] = useState<'list' | 'custom'>('list');
  const [refreshing, setRefreshing] = useState<string[]>([]);
  const [refreshNote, setRefreshNote] = useState<Record<string, string>>({});
  const [customProvider, setCustomProvider] = useState(value.providerId ?? '');
  const [customId, setCustomId] = useState('');
  const [customTouched, setCustomTouched] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api<ModelsData>('/models'));
      setLoadError('');
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : 'Could not load models.',
      );
    }
    setLoading(false);
  }, []);

  // A Dot that already names a provider needs its name for the trigger, and to notice a
  // provider that is gone. Everything else waits until the list is opened.
  const needsNameNow = variant === 'field' && value.providerId !== null;
  useEffect(() => {
    if (needsNameNow && !initialData) void load();
  }, [needsNameNow, initialData, load]);

  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) void load();
    wasOpen.current = open;
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const providers = data?.providers;
  const groups = pickerGroups(providers ?? [], query);
  const options = pickerOptions(groups, allowDefault);
  const activeIndex = Math.min(active, options.length - 1);
  const optionId = (index: number) => `${uid}-opt-${index}`;
  const shownDefault = data?.default ?? defaultLabel;
  const label = choiceLabel(value, providers, shownDefault);

  useEffect(() => {
    if (!open || mode !== 'list') return;
    document
      .getElementById(`${uid}-opt-${activeIndex}`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [open, mode, activeIndex, uid]);

  const close = (returnFocus = true) => {
    setOpen(false);
    setMode('list');
    setQuery('');
    if (returnFocus) trigger.current?.focus();
  };
  const choose = (choice: ModelChoice) => {
    onChange(choice);
    close();
  };
  const run = (option: PickerOption) => {
    if (option.kind === 'default') choose({ providerId: null, model: '' });
    else if (option.kind === 'model')
      choose({ providerId: option.providerId, model: option.model });
    else openCustom();
  };

  const openCustom = () => {
    const first = providers?.[0]?.id ?? '';
    setCustomProvider(
      providers?.some((item) => item.id === value.providerId)
        ? (value.providerId ?? first)
        : first,
    );
    setCustomId(query.trim());
    setCustomTouched(false);
    setMode('custom');
  };
  useEffect(() => {
    if (open && mode === 'custom')
      root.current?.querySelector<HTMLInputElement>('.mp-custom-id')?.focus();
    if (open && mode === 'list') search.current?.focus();
  }, [open, mode]);

  const customProblem = modelIdProblem(customId);
  const applyCustom = () => {
    setCustomTouched(true);
    if (customProblem || !customProvider) return;
    choose({ providerId: customProvider, model: customId.trim() });
  };

  const refresh = async (providerId: string) => {
    setRefreshing((current) => [...current, providerId]);
    setRefreshNote((current) => ({ ...current, [providerId]: '' }));
    try {
      const result = await api<{ models: ModelInfo[]; error?: string }>(
        `/model-providers/${encodeURIComponent(providerId)}/models?refresh=1`,
      );
      setData((current) =>
        current
          ? {
              ...current,
              providers: current.providers.map((item) =>
                item.id === providerId
                  ? { ...item, models: result.models }
                  : item,
              ),
            }
          : current,
      );
      if (result.error)
        setRefreshNote((current) => ({
          ...current,
          [providerId]: result.error ?? '',
        }));
    } catch (error) {
      setRefreshNote((current) => ({
        ...current,
        [providerId]:
          error instanceof Error ? error.message : 'Could not refresh.',
      }));
    }
    setRefreshing((current) => current.filter((item) => item !== providerId));
  };

  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((activeIndex + step + options.length) % options.length);
    } else if (event.key === 'Enter') {
      // Never submit the form this field sits in.
      event.preventDefault();
      const option = options[activeIndex];
      if (option) run(option);
    } else if (event.key === 'Escape') {
      // Close the list, not the dialog around it.
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  const onRootKey = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  const groupStart = groups.map(
    (_, index) =>
      (allowDefault ? 1 : 0) +
      groups
        .slice(0, index)
        .reduce((sum, group) => sum + group.models.length, 0),
  );
  const customIndex = options.length - 1;
  const isCurrent = (providerId: string, model: string) =>
    value.providerId === providerId && value.model === model;
  const noProviders = !!providers && providers.length === 0;

  return (
    <div
      className={`mp-picker mp-picker-${variant}`}
      ref={root}
      onKeyDown={onRootKey}
    >
      <button
        type="button"
        id={id}
        ref={trigger}
        className={variant === 'field' ? 'mp-trigger' : 'mp-trigger-btn'}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-describedby={describedBy}
        data-stale={label.stale || undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        {variant === 'field' ? (
          <>
            {label.provider ? (
              <ModelLogo presetId={label.provider.presetId} size={24} />
            ) : (
              <span className="mp-trigger-icon" aria-hidden="true">
                <Sparkles size={14} />
              </span>
            )}
            <span className="mp-trigger-text">{label.text}</span>
            <ChevronDown size={16} className="mp-chevron" aria-hidden="true" />
          </>
        ) : (
          buttonLabel
        )}
      </button>
      {label.stale && (
        <p className="mp-stale" role="status">
          <CircleAlert size={13} aria-hidden="true" />
          This provider is turned off or no longer exists. Pick another model
          before saving.
        </p>
      )}
      {open && (
        <div
          className="mp-pop"
          role="dialog"
          aria-label="Choose a model"
          data-mode={mode}
        >
          {mode === 'list' ? (
            <>
              <div className="mp-search">
                <Search size={15} aria-hidden="true" />
                <input
                  ref={search}
                  type="text"
                  role="combobox"
                  aria-expanded="true"
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={
                    options.length ? optionId(activeIndex) : undefined
                  }
                  aria-label="Search models"
                  placeholder="Search models"
                  autoComplete="off"
                  spellCheck={false}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActive(0);
                  }}
                  onKeyDown={onSearchKey}
                />
              </div>
              <div
                className="mp-list"
                id={listId}
                role="listbox"
                aria-label="Models"
              >
                {allowDefault && (
                  <div
                    id={optionId(0)}
                    role="option"
                    className="mp-opt mp-opt-default"
                    aria-selected={
                      value.providerId === null && value.model === ''
                    }
                    data-active={activeIndex === 0 || undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => setActive(0)}
                    onClick={() => run({ kind: 'default' })}
                  >
                    <span className="mp-opt-icon" aria-hidden="true">
                      <Sparkles size={14} />
                    </span>
                    <span className="mp-opt-main">
                      <strong>
                        {shownDefault
                          ? `Use default (${shownDefault})`
                          : 'Use default'}
                      </strong>
                      <small>
                        Follows the default model in Settings → Models.
                      </small>
                    </span>
                    {value.providerId === null && value.model === '' && (
                      <Check size={15} aria-hidden="true" />
                    )}
                  </div>
                )}
                {loading && !data && (
                  <p className="mp-note" role="status">
                    <LoaderCircle
                      size={14}
                      className="cx-spin"
                      aria-hidden="true"
                    />
                    Loading models…
                  </p>
                )}
                {loadError && (
                  <p className="mp-note mp-note-bad" role="alert">
                    {loadError}{' '}
                    <button
                      type="button"
                      className="mp-linkbtn"
                      onClick={() => void load()}
                    >
                      Try again
                    </button>
                  </p>
                )}
                {noProviders && (
                  <p className="mp-note">
                    No providers are turned on. Add one in Settings → Models.
                  </p>
                )}
                {groups.map((group, groupIndex) => {
                  const { provider } = group;
                  const busy = refreshing.includes(provider.id);
                  const note = refreshNote[provider.id];
                  return (
                    <div
                      className="mp-group"
                      role="group"
                      aria-label={provider.name}
                      key={provider.id}
                    >
                      <div className="mp-group-head">
                        <ModelLogo presetId={provider.presetId} size={22} />
                        <span className="mp-group-name">{provider.name}</span>
                        <span className="mp-group-count">
                          {group.total} {group.total === 1 ? 'model' : 'models'}
                        </span>
                        <button
                          type="button"
                          className="mp-icon-btn"
                          aria-label={`Refresh ${provider.name} models`}
                          title="Refresh the list"
                          disabled={busy}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => void refresh(provider.id)}
                        >
                          <RefreshCw
                            size={13}
                            className={busy ? 'cx-spin' : undefined}
                            aria-hidden="true"
                          />
                        </button>
                      </div>
                      {note && <p className="mp-note mp-note-bad">{note}</p>}
                      {group.total === 0 && !note && (
                        <p className="mp-note">
                          No models listed. Use a custom model id below.
                        </p>
                      )}
                      {group.models.map((model, modelIndex) => {
                        const index = groupStart[groupIndex]! + modelIndex;
                        const current = isCurrent(provider.id, model.id);
                        const context = formatContext(model.contextLength);
                        return (
                          <div
                            key={model.id}
                            id={optionId(index)}
                            role="option"
                            className="mp-opt"
                            aria-selected={current}
                            data-active={activeIndex === index || undefined}
                            onMouseDown={(event) => event.preventDefault()}
                            onMouseMove={() => setActive(index)}
                            onClick={() =>
                              run({
                                kind: 'model',
                                providerId: provider.id,
                                model: model.id,
                              })
                            }
                          >
                            <span className="mp-opt-main">
                              <strong title={model.id}>
                                {model.name && model.name !== model.id
                                  ? model.name
                                  : model.id}
                              </strong>
                              {model.name && model.name !== model.id && (
                                <small className="mp-mono">{model.id}</small>
                              )}
                            </span>
                            {model.tools === true && (
                              <span
                                className="mp-chip mp-chip-ok"
                                title="Supports tools"
                              >
                                Tools
                              </span>
                            )}
                            {model.tools === false && (
                              <span
                                className="mp-chip mp-chip-warn"
                                title="This model does not support tools, so a Dot cannot use connectors or save pages with it."
                              >
                                No tools
                              </span>
                            )}
                            {context && (
                              <span className="mp-chip">{context}</span>
                            )}
                            {current && <Check size={15} aria-hidden="true" />}
                          </div>
                        );
                      })}
                      {group.total > group.models.length && (
                        <p className="mp-note">
                          Showing {group.models.length} of {group.total}. Type
                          to narrow the list.
                        </p>
                      )}
                    </div>
                  );
                })}
                {!!query.trim() &&
                  groups.length === 0 &&
                  !!providers?.length && (
                    <p className="mp-note">
                      No model matches “{query.trim()}”.
                    </p>
                  )}
                <div
                  id={optionId(customIndex)}
                  role="option"
                  className="mp-opt mp-opt-custom"
                  aria-selected={false}
                  data-active={activeIndex === customIndex || undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => setActive(customIndex)}
                  onClick={() => run({ kind: 'custom' })}
                >
                  <span className="mp-opt-icon" aria-hidden="true">
                    <Pencil size={14} />
                  </span>
                  <span className="mp-opt-main">
                    <strong>Use a custom model id…</strong>
                    <small>For a model that is not in the list.</small>
                  </span>
                </div>
              </div>
            </>
          ) : (
            <div className="mp-custom">
              <h4 className="mp-custom-title">Use a custom model id</h4>
              {noProviders || !providers?.length ? (
                <p className="mp-note">
                  {loading
                    ? 'Loading providers…'
                    : 'Add a provider in Settings → Models first.'}
                </p>
              ) : (
                <>
                  <label className="mp-label" htmlFor={`${uid}-cp`}>
                    Provider
                  </label>
                  <select
                    id={`${uid}-cp`}
                    className="mp-input"
                    value={customProvider}
                    onChange={(event) => setCustomProvider(event.target.value)}
                  >
                    {providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  </select>
                  <label className="mp-label" htmlFor={`${uid}-ci`}>
                    Model id
                  </label>
                  <input
                    id={`${uid}-ci`}
                    className="mp-input mp-custom-id"
                    value={customId}
                    maxLength={MODEL_ID_MAX}
                    placeholder="llama-3.3-70b-versatile"
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={customTouched && !!customProblem}
                    onChange={(event) => setCustomId(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        applyCustom();
                      }
                    }}
                  />
                  <p
                    className={
                      customTouched && customProblem
                        ? 'mp-hint mp-hint-bad'
                        : 'mp-hint'
                    }
                  >
                    {customTouched && customProblem
                      ? customProblem
                      : 'Type the exact id your provider expects.'}
                  </p>
                </>
              )}
              <div className="mp-custom-actions">
                <button
                  type="button"
                  className="mp-btn"
                  onClick={() => setMode('list')}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="mp-btn mp-btn-primary"
                  disabled={!providers?.length}
                  onClick={applyCustom}
                >
                  Use this model
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
