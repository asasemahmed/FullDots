import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ArrowLeft,
  Ban,
  Check,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  Eye,
  EyeOff,
  FileCode,
  Info,
  KeyRound,
  LoaderCircle,
  Power,
  RefreshCw,
  Search,
  Star,
  Trash2,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { ModelLogo } from './model-logos';
import {
  ModelProviderRequestError,
  StatusPill,
  hostPath,
  providerRequest,
  providerStatus,
  providerSubtitle,
  type DefaultModel,
} from './ModelProviderGallery';
import { formatContext, modelIdProblem } from './ModelPicker';
import type {
  ModelInfo,
  ModelPreset,
  ModelProviderKeyKind,
  ModelProviderView,
} from '../shared/model-presets';
import './model-providers.css';

// ---- The draft: what the form edits, and what it sends ----------------------------

export type KeyMode = ModelProviderKeyKind;

export interface ProviderDraft {
  name: string;
  baseUrl: string;
  keyMode: KeyMode;
  /** The pasted key. Only ever lives in this form's state, never rendered back. */
  keyValue: string;
  envName: string;
  workspaceId: string;
  /** The saved key is being replaced (an existing provider with a stored key). */
  replacing: boolean;
}

/** The base URL can be typed for the custom preset and for programs on this computer. */
export const baseUrlEditable = (preset: ModelPreset): boolean =>
  !preset.baseUrl || !!preset.local;

export const suggestEnvName = (preset: ModelPreset): string =>
  `${preset.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;

export function draftFor(
  view: ModelProviderView | undefined,
  preset: ModelPreset,
): ProviderDraft {
  if (view)
    return {
      name: view.name,
      baseUrl: view.baseUrl,
      keyMode: view.key.kind,
      keyValue: '',
      envName: view.key.envName ?? '',
      workspaceId: '',
      // A stored key that cannot be read has to be pasted again.
      replacing: view.key.kind === 'stored' && !view.key.set,
    };
  return {
    name: preset.name,
    baseUrl: preset.baseUrl ?? '',
    keyMode: preset.local ? 'none' : 'stored',
    keyValue: '',
    envName: '',
    workspaceId: '',
    replacing: false,
  };
}

const URL_MESSAGE = 'Use https:// (http only for localhost).';
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** The inline message under the base URL field; empty when the address is acceptable. */
export function baseUrlProblem(url: string): string {
  const text = url.trim();
  if (!text) return 'Enter the server address.';
  if (text.length > 500) return 'Use at most 500 characters.';
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return 'Enter a full address such as https://api.example.com/v1.';
  }
  if (parsed.username || parsed.password)
    return 'Leave the username and password out of the address.';
  if (parsed.search || parsed.hash) return 'Remove everything after ? or #.';
  if (parsed.protocol === 'https:') return '';
  if (parsed.protocol === 'http:' && LOOPBACK.includes(parsed.hostname))
    return '';
  return URL_MESSAGE;
}

export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,99}$/;

export function envNameProblem(name: string): string {
  if (!name) return 'Enter the variable name.';
  if (!ENV_NAME_PATTERN.test(name))
    return 'Use capital letters, digits and underscores, for example GROQ_API_KEY.';
  return '';
}

/** A pasted key's problem (the server's rules: 8 to 4000 characters, no spaces). */
export function keyValueProblem(value: string): string {
  const text = value.trim();
  if (text.length < 8) return 'An API key is at least 8 characters.';
  if (text.length > 4000) return 'An API key is at most 4000 characters.';
  if (/\s/.test(text)) return 'An API key has no spaces.';
  return '';
}

/** A soft warning when the key does not start like this provider's usually do. Never blocks. */
export function keyHintWarning(value: string, preset: ModelPreset): string {
  const text = value.trim();
  if (!text || !preset.keyHint) return '';
  return preset.keyHint.prefix.some((prefix) => text.startsWith(prefix))
    ? ''
    : `${preset.keyHint.label}. Check that you copied the right key.`;
}

export interface DraftProblems {
  name?: string;
  baseUrl?: string;
  key?: string;
  envName?: string;
}

const trimSlash = (url: string) => url.trim().replace(/\/+$/, '');

/** Whether a key has to be typed: a new provider, a replacement, or switching to a stored key. */
const needsKeyValue = (draft: ProviderDraft, view?: ModelProviderView) =>
  draft.keyMode === 'stored' &&
  (!view || view.key.kind !== 'stored' || draft.replacing);

export function draftProblems(
  draft: ProviderDraft,
  preset: ModelPreset,
  view?: ModelProviderView,
): DraftProblems {
  const problems: DraftProblems = {};
  const name = draft.name.trim();
  if (!name) problems.name = 'Give the provider a name.';
  else if (name.length > 60) problems.name = 'Use at most 60 characters.';
  if (baseUrlEditable(preset)) {
    const message = baseUrlProblem(draft.baseUrl);
    if (message) problems.baseUrl = message;
  }
  if (needsKeyValue(draft, view)) {
    if (!draft.keyValue.trim())
      problems.key = preset.keyOptional
        ? 'Paste a key, or choose “No key”.'
        : 'Paste your API key.';
    else {
      const message = keyValueProblem(draft.keyValue);
      if (message) problems.key = message;
    }
  }
  if (draft.keyMode === 'env') {
    const message = envNameProblem(draft.envName);
    if (message) problems.envName = message;
  }
  return problems;
}

export const problemList = (problems: DraftProblems): string[] =>
  Object.values(problems).filter((text): text is string => !!text);

function keyBody(draft: ProviderDraft) {
  return draft.keyMode === 'stored'
    ? ({ kind: 'stored', value: draft.keyValue.trim() } as const)
    : draft.keyMode === 'env'
      ? ({ kind: 'env', envName: draft.envName } as const)
      : ({ kind: 'none' } as const);
}

const extraBody = (draft: ProviderDraft, preset: ModelPreset) =>
  draft.workspaceId.trim() &&
  preset.extraFields?.some((field) => field.id === 'anthropicWorkspaceId')
    ? { extra: { anthropicWorkspaceId: draft.workspaceId.trim() } }
    : {};

/** The POST body for a new provider. */
export function createBody(draft: ProviderDraft, preset: ModelPreset) {
  return {
    presetId: preset.id,
    name: draft.name.trim(),
    ...(baseUrlEditable(preset) ? { baseUrl: draft.baseUrl.trim() } : {}),
    key: keyBody(draft),
    ...extraBody(draft, preset),
  };
}

/** The PATCH body: only what differs from the saved provider. Empty means nothing to save. */
export function patchBody(
  draft: ProviderDraft,
  preset: ModelPreset,
  view: ModelProviderView,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (draft.name.trim() !== view.name) body.name = draft.name.trim();
  if (
    baseUrlEditable(preset) &&
    trimSlash(draft.baseUrl) !== trimSlash(view.baseUrl)
  )
    body.baseUrl = draft.baseUrl.trim();
  const kind = view.key.kind;
  if (draft.keyMode === 'stored') {
    if (kind !== 'stored' || draft.replacing) body.key = keyBody(draft);
  } else if (draft.keyMode === 'env') {
    if (kind !== 'env' || draft.envName !== view.key.envName)
      body.key = keyBody(draft);
  } else if (kind !== 'none') body.key = keyBody(draft);
  Object.assign(body, extraBody(draft, preset));
  return body;
}

// ---- Page types --------------------------------------------------------------------

export type ProviderTarget =
  | {
      kind: 'provider';
      id: string;
      /** Run a connection test as the page opens. */ test?: boolean;
    }
  | { kind: 'preset'; preset: ModelPreset };

export interface TestResult {
  ok: boolean;
  count?: number;
  latencyMs: number;
  error?: string;
}

export type TestState =
  | { phase: 'idle' }
  | { phase: 'busy' }
  | { phase: 'done'; result: TestResult }
  | { phase: 'failed'; message: string };

export interface ModelsListResult {
  models: ModelInfo[];
  fetchedAt?: number;
  stale?: boolean;
  error?: string;
}

type ModelsState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; result: ModelsListResult }
  | { phase: 'failed'; message: string };

/** The one-line outcome of a test, as the page shows it. */
export function testSummary(result: TestResult): string {
  if (!result.ok) return result.error || 'The provider did not answer.';
  const parts = ['Connected'];
  if (result.count !== undefined)
    parts.push(`${result.count} ${result.count === 1 ? 'model' : 'models'}`);
  parts.push(`${Math.round(result.latencyMs)} ms`);
  return parts.join(' · ');
}

/** What a failed delete says: the server's message, plus who still uses the provider. */
export function usedByMessage(dots: string[]): string {
  return dots.length ? `Used by: ${dots.join(', ')}` : '';
}

export const MODEL_ROW_LIMIT = 100;

export function matchModels(models: ModelInfo[], query: string): ModelInfo[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return models;
  return models.filter((model) =>
    [model.id, model.name ?? ''].some((text) =>
      text.toLowerCase().includes(needle),
    ),
  );
}

const reasonOf = (error: unknown, fallback = 'That did not work.') =>
  error instanceof Error ? error.message : fallback;

// ---- Small pieces ----------------------------------------------------------------------

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
  aside,
  hint,
  warning,
  error,
  children,
}: {
  id: string;
  label: string;
  /** Sits on the label's line, right side (the "Get a key" link). */
  aside?: ReactNode;
  hint?: ReactNode;
  warning?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="cs-field">
      <div className="mp-label-row">
        <label className="cs-label" htmlFor={id}>
          {label}
        </label>
        {aside}
      </div>
      {children}
      {error ? (
        <p className="cs-hint cs-hint-bad" id={`${id}-msg`}>
          {error}
        </p>
      ) : (
        <>
          {warning && (
            <p className="cs-hint mp-hint-warn" id={`${id}-warn`}>
              <CircleAlert size={13} aria-hidden="true" />
              {warning}
            </p>
          )}
          {hint && (
            <p className="cs-hint" id={`${id}-msg`}>
              {hint}
            </p>
          )}
        </>
      )}
    </div>
  );
}

interface Choice<T extends string> {
  id: T;
  label: string;
  hint: string;
  icon: LucideIcon;
}

function ChoiceGroup<T extends string>({
  name,
  label,
  value,
  choices,
  onChange,
}: {
  name: string;
  label: string;
  value: T;
  choices: Choice<T>[];
  onChange: (id: T) => void;
}) {
  return (
    <div
      className={`cs-choices cs-choices-${choices.length}`}
      role="radiogroup"
      aria-label={label}
    >
      {choices.map((choice) => (
        <label className="cs-pick cs-pick-card" key={choice.id}>
          <input
            type="radio"
            name={name}
            value={choice.id}
            checked={value === choice.id}
            onChange={() => onChange(choice.id)}
          />
          <span className="cs-pick-icon">
            <choice.icon size={16} aria-hidden="true" />
          </span>
          <span className="cs-pick-text">
            <strong>{choice.label}</strong>
            <small>{choice.hint}</small>
          </span>
        </label>
      ))}
    </div>
  );
}

// ---- The page ----------------------------------------------------------------------------

export interface ModelProviderPageProps {
  target: ProviderTarget;
  providers: ModelProviderView[];
  presets: ModelPreset[];
  defaultModel: DefaultModel | null;
  onClose: () => void;
  /** A provider was created or changed; the container merges it and, for a new one, retargets. */
  onSaved: (view: ModelProviderView, options?: { test?: boolean }) => void;
  onDeleted: (id: string) => void;
  onDefaultChanged: (value: DefaultModel | null) => void;
  /** Ask the container to refetch the list (after a test wrote its result). */
  onReload: () => void;
  /** The number of models this provider offers, once known. */
  onCount: (id: string, count: number) => void;
  /** State for the first render (tests). */
  initialModels?: ModelsListResult;
  initialTest?: TestState;
}

export function ModelProviderPage(props: ModelProviderPageProps) {
  const { target, providers, presets, onClose } = props;
  const titleId = useId();
  const root = useRef<HTMLElement>(null);
  const view =
    target.kind === 'provider'
      ? providers.find((item) => item.id === target.id)
      : undefined;
  const preset =
    target.kind === 'preset'
      ? target.preset
      : presets.find((item) => item.id === view?.presetId);

  // Esc closes the page, not the whole settings dialog: listen in the capture phase.
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

  const frame = (children: ReactNode, label?: string) => (
    <section
      className="cs-page mp-page"
      aria-label={label}
      aria-labelledby={label ? undefined : titleId}
      ref={root}
      tabIndex={-1}
    >
      <div className="cs-topbar">
        <button
          type="button"
          className="cs-back"
          aria-label="Back to models"
          onClick={onClose}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          Models
        </button>
      </div>
      <div className="cs-scroll" data-enter>
        <div className="cs-content">{children}</div>
      </div>
    </section>
  );

  if (!preset || (target.kind === 'provider' && !view))
    return frame(
      <p className="cs-muted">This provider is gone.</p>,
      'Provider',
    );
  return frame(
    <ProviderForm {...props} view={view} preset={preset} titleId={titleId} />,
  );
}

function ProviderForm({
  target,
  view,
  preset,
  titleId,
  defaultModel,
  onClose,
  onSaved,
  onDeleted,
  onDefaultChanged,
  onReload,
  onCount,
  initialModels,
  initialTest,
}: ModelProviderPageProps & {
  view: ModelProviderView | undefined;
  preset: ModelPreset;
  titleId: string;
}) {
  const uid = useId();
  const creating = !view;
  const readOnly = !!view?.builtIn;
  const [draft, setDraft] = useState<ProviderDraft>(() =>
    draftFor(view, preset),
  );
  const set = (patch: Partial<ProviderDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [test, setTest] = useState<TestState>(initialTest ?? { phase: 'idle' });
  const [models, setModels] = useState<ModelsState>(
    initialModels
      ? { phase: 'ready', result: initialModels }
      : { phase: 'idle' },
  );
  const [query, setQuery] = useState('');
  const [manualId, setManualId] = useState('');
  const [manualTouched, setManualTouched] = useState(false);
  const [defaultBusy, setDefaultBusy] = useState('');
  const [manageError, setManageError] = useState('');
  const [usedBy, setUsedBy] = useState<string[]>([]);
  const [busyManage, setBusyManage] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const id = view?.id;
  const usable =
    !!view && view.enabled && (view.key.set || view.key.kind === 'none');

  const loadModels = useCallback(
    async (providerId: string, refresh: boolean) => {
      setModels((current) =>
        current.phase === 'ready' ? current : { phase: 'loading' },
      );
      try {
        const result = await providerRequest<ModelsListResult>(
          `/model-providers/${encodeURIComponent(providerId)}/models${refresh ? '?refresh=1' : ''}`,
        );
        if (!mounted.current) return;
        setModels({ phase: 'ready', result });
        if (!result.error && result.models.length > 0)
          onCount(providerId, result.models.length);
      } catch (error) {
        if (mounted.current)
          setModels({ phase: 'failed', message: reasonOf(error) });
      }
    },
    [onCount],
  );

  const runTest = useCallback(
    async (providerId: string) => {
      setTest({ phase: 'busy' });
      try {
        const result = await providerRequest<TestResult>(
          `/model-providers/${encodeURIComponent(providerId)}/test`,
          'POST',
          {},
        );
        if (!mounted.current) return;
        setTest({ phase: 'done', result });
        onReload();
        if (result.ok) {
          if (result.count !== undefined) onCount(providerId, result.count);
          void loadModels(providerId, true);
        }
      } catch (error) {
        if (mounted.current)
          setTest({ phase: 'failed', message: reasonOf(error) });
      }
    },
    [loadModels, onCount, onReload],
  );

  // On open: show the models the server already has; after "Add provider", test straight away.
  const autoTest = target.kind === 'provider' && !!target.test;
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !id || initialModels || initialTest) return;
    started.current = true;
    if (autoTest) void runTest(id);
    else if (usable) void loadModels(id, false);
  }, [id, autoTest, usable, initialModels, initialTest, runTest, loadModels]);

  const dirtyBody = view ? patchBody(draft, preset, view) : undefined;
  const dirty = !!dirtyBody && Object.keys(dirtyBody).length > 0;
  const live = submitted ? draftProblems(draft, preset, view) : {};

  const save = async () => {
    setSubmitted(true);
    const found = problemList(draftProblems(draft, preset, view));
    if (found.length) {
      setProblems(found);
      return;
    }
    setProblems([]);
    setSaving(true);
    try {
      if (!view) {
        const created = await providerRequest<ModelProviderView>(
          '/model-providers',
          'POST',
          createBody(draft, preset),
        );
        // The container opens the new provider's own page and tests it there.
        onSaved(created, { test: true });
        return;
      }
      const body = patchBody(draft, preset, view);
      const saved = await providerRequest<ModelProviderView>(
        `/model-providers/${encodeURIComponent(view.id)}`,
        'PATCH',
        body,
      );
      if (!mounted.current) return;
      onSaved(saved);
      setDraft(draftFor(saved, preset));
      setSubmitted(false);
      setShowKey(false);
      setTest({ phase: 'idle' });
      if ('key' in body || 'baseUrl' in body) void runTest(saved.id);
    } catch (error) {
      if (mounted.current) setProblems([reasonOf(error)]);
    }
    if (mounted.current) setSaving(false);
  };

  const toggleEnabled = async () => {
    if (!view) return;
    setBusyManage(true);
    setManageError('');
    try {
      const saved = await providerRequest<ModelProviderView>(
        `/model-providers/${encodeURIComponent(view.id)}`,
        'PATCH',
        { enabled: !view.enabled },
      );
      if (mounted.current) onSaved(saved);
    } catch (error) {
      if (mounted.current) setManageError(reasonOf(error));
    }
    if (mounted.current) setBusyManage(false);
  };

  const remove = async () => {
    if (!view) return;
    if (
      !window.confirm(
        `Delete ${view.name}? Its saved key is erased from this computer.`,
      )
    )
      return;
    setBusyManage(true);
    setManageError('');
    setUsedBy([]);
    try {
      await providerRequest(
        `/model-providers/${encodeURIComponent(view.id)}`,
        'DELETE',
      );
      onDeleted(view.id);
      onClose();
      return;
    } catch (error) {
      if (mounted.current) {
        setManageError(reasonOf(error));
        if (error instanceof ModelProviderRequestError && error.status === 409)
          setUsedBy(error.dots);
      }
    }
    if (mounted.current) setBusyManage(false);
  };

  const setDefault = async (model: string) => {
    if (!view) return;
    setDefaultBusy(model);
    setManageError('');
    try {
      const result = await providerRequest<{
        defaultModel: DefaultModel | null;
      }>('/model-providers/default', 'PUT', { providerId: view.id, model });
      if (mounted.current) onDefaultChanged(result.defaultModel);
    } catch (error) {
      if (mounted.current) setManageError(reasonOf(error));
    }
    if (mounted.current) setDefaultBusy('');
  };

  const title = view?.name ?? preset.name;
  const status = view ? providerStatus(view, preset) : undefined;
  const subtitle = view
    ? providerSubtitle(view, preset)
    : preset.baseUrl
      ? hostPath(preset.baseUrl)
      : 'Any OpenAI-compatible server';

  const keyChoices: Choice<KeyMode>[] = [
    {
      id: 'stored',
      label: 'Paste a key',
      hint: 'Encrypted on this computer.',
      icon: KeyRound,
    },
    {
      id: 'env',
      label: 'Use a variable from .env',
      hint: 'Only the name is saved.',
      icon: FileCode,
    },
    ...(preset.keyOptional
      ? [
          {
            id: 'none' as const,
            label: 'No key',
            hint: 'Nothing is sent.',
            icon: Ban,
          },
        ]
      : []),
  ];
  const keyWarning = keyHintWarning(draft.keyValue, preset);
  const keyLive = draft.keyValue.trim() ? keyValueProblem(draft.keyValue) : '';
  const envLive = draft.envName ? envNameProblem(draft.envName) : '';
  const hasSavedKey =
    view?.key.kind === 'stored' && view.key.set && !draft.replacing;
  const envVarSet =
    view?.key.kind === 'env' && view.key.envName === draft.envName
      ? view.key.set
      : undefined;
  const urlEditable = baseUrlEditable(preset);
  const urlLive =
    urlEditable && draft.baseUrl ? baseUrlProblem(draft.baseUrl) : '';
  const workspaceField = preset.extraFields?.find(
    (field) => field.id === 'anthropicWorkspaceId',
  );

  const modelList =
    models.phase === 'ready' ? models.result.models : ([] as ModelInfo[]);
  const shownModels = matchModels(modelList, query);
  const manualProblem = modelIdProblem(manualId);

  return (
    <>
      <header className="cs-head">
        <ModelLogo presetId={view?.presetId ?? preset.id} size={56} />
        <div className="cs-head-id">
          <div className="cs-title-row">
            <h3 className="cs-title" id={titleId}>
              {title}
            </h3>
            {status && <StatusPill status={status} />}
            {view?.builtIn && <span className="mp-badge">From .env</span>}
          </div>
          <p className="cs-sub">{subtitle}</p>
        </div>
        <a
          className="cs-link cs-head-docs"
          href={preset.docsUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          Docs <ExternalLink size={12} aria-hidden="true" />
        </a>
      </header>

      {creating && <p className="cs-lead">{preset.description}</p>}
      {readOnly && (
        <Banner tone="info" icon={<Info size={18} />}>
          <strong>Set in the server .env</strong>
          <p>
            This provider comes from <code>OPENAI_API_KEY</code> and{' '}
            <code>OPENAI_BASE_URL</code>. Edit that file and restart to change
            it. It cannot be removed here.
          </p>
        </Banner>
      )}
      {status?.detail && (
        <Banner
          tone={status.tone === 'bad' ? 'bad' : 'warn'}
          icon={<CircleAlert size={18} />}
          role="status"
        >
          <span>{status.detail}</span>
        </Banner>
      )}

      {!readOnly && (
        <Step n={1} title="API key">
          <ChoiceGroup
            name={`${uid}-key`}
            label="How to provide the key"
            value={draft.keyMode}
            choices={keyChoices}
            onChange={(mode) =>
              set({
                keyMode: mode,
                ...(mode === 'env' && !draft.envName
                  ? { envName: suggestEnvName(preset) }
                  : {}),
              })
            }
          />
          {draft.keyMode === 'stored' &&
            (hasSavedKey ? (
              <div className="mp-keyrow">
                <code
                  className="mp-masked"
                  aria-label="Saved key, last four characters"
                >
                  •••• {view?.key.last4 ?? ''}
                </code>
                <span className="cn-pill cn-pill-ok">
                  <Check size={12} strokeWidth={2.4} aria-hidden="true" />
                  Saved
                </span>
                <button
                  type="button"
                  className="cs-btn cs-btn-sm"
                  onClick={() => set({ replacing: true, keyValue: '' })}
                >
                  Replace key
                </button>
              </div>
            ) : (
              <Field
                id={`${uid}-key-input`}
                label={view ? 'New API key' : 'API key'}
                aside={
                  preset.keysUrl && (
                    <a
                      className="cs-link"
                      href={preset.keysUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Get a key <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  )
                }
                warning={keyWarning}
                error={live.key ?? keyLive}
                hint="Pasted keys are encrypted here and never shown again."
              >
                <div className="mp-secret">
                  <input
                    id={`${uid}-key-input`}
                    className="cs-input mp-secret-input"
                    type={showKey ? 'text' : 'password'}
                    value={draft.keyValue}
                    placeholder={
                      preset.keyHint
                        ? `${preset.keyHint.prefix[0]}…`
                        : 'Paste your key'
                    }
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                    data-lpignore="true"
                    data-1p-ignore="true"
                    aria-invalid={!!(live.key ?? keyLive) || undefined}
                    onChange={(event) => set({ keyValue: event.target.value })}
                  />
                  <button
                    type="button"
                    className="mp-eye"
                    aria-label={showKey ? 'Hide key' : 'Show key'}
                    aria-pressed={showKey}
                    onClick={() => setShowKey(!showKey)}
                  >
                    {showKey ? (
                      <EyeOff size={16} aria-hidden="true" />
                    ) : (
                      <Eye size={16} aria-hidden="true" />
                    )}
                  </button>
                </div>
                {view?.key.kind === 'stored' && view.key.set && (
                  <button
                    type="button"
                    className="cs-linkbtn mp-keep"
                    onClick={() => set({ replacing: false, keyValue: '' })}
                  >
                    Keep the saved key
                  </button>
                )}
              </Field>
            ))}
          {draft.keyMode === 'env' && (
            <Field
              id={`${uid}-env`}
              label="Variable name"
              error={live.envName ?? envLive}
              hint={
                <>
                  FullDots reads this variable from the server’s{' '}
                  <code>.env</code> each time it calls the provider, so add the
                  line there and restart. Only the name is saved.
                </>
              }
            >
              <div className="cs-with-pill">
                <input
                  id={`${uid}-env`}
                  className="cs-input mp-mono-input"
                  value={draft.envName}
                  placeholder={suggestEnvName(preset)}
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="characters"
                  aria-invalid={!!(live.envName ?? envLive) || undefined}
                  onChange={(event) =>
                    set({
                      envName: event.target.value
                        .toUpperCase()
                        .replace(/\s+/g, '_'),
                    })
                  }
                />
                {envVarSet === true && (
                  <span className="cn-pill cn-pill-ok cn-set">
                    <Check size={12} strokeWidth={2.4} aria-hidden="true" /> Set
                  </span>
                )}
                {envVarSet === false && (
                  <span className="cn-pill cn-pill-warn cn-unset">Not set</span>
                )}
              </div>
              {preset.keysUrl && (
                <a
                  className="cs-link mp-keep"
                  href={preset.keysUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Get a key <ExternalLink size={12} aria-hidden="true" />
                </a>
              )}
            </Field>
          )}
          {draft.keyMode === 'none' && (
            <p className="cs-muted">
              No key is sent. That is right for a program running on this
              computer; a hosted service will refuse the request.
            </p>
          )}
        </Step>
      )}

      <Step n={readOnly ? 1 : 2} title="Connection">
        {!readOnly && (
          <Field
            id={`${uid}-name`}
            label="Name"
            error={live.name}
            hint="Shown in lists and in each Dot’s model choice."
          >
            <input
              id={`${uid}-name`}
              className="cs-input"
              value={draft.name}
              maxLength={60}
              autoComplete="off"
              aria-invalid={!!live.name || undefined}
              onChange={(event) => set({ name: event.target.value })}
            />
          </Field>
        )}
        <Field
          id={`${uid}-url`}
          label="Base URL"
          error={readOnly ? undefined : (live.baseUrl ?? urlLive)}
          hint={
            readOnly || !urlEditable
              ? `Fixed for ${preset.name}.`
              : preset.local
                ? 'Usually http://localhost, where the program listens.'
                : 'The address your server answers on, ending in /v1 for most.'
          }
        >
          <input
            id={`${uid}-url`}
            className="cs-input mp-mono-input"
            value={readOnly ? (view?.baseUrl ?? '') : draft.baseUrl}
            readOnly={readOnly || !urlEditable}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
            autoComplete="off"
            inputMode="url"
            aria-invalid={
              (!readOnly && !!(live.baseUrl ?? urlLive)) || undefined
            }
            onChange={(event) => set({ baseUrl: event.target.value })}
          />
        </Field>
        {workspaceField && !readOnly && (
          <Field
            id={`${uid}-ws`}
            label={workspaceField.label}
            hint={
              view
                ? 'Only for keys that belong to several workspaces. Leave blank to keep the current setting.'
                : 'Only for keys that belong to several workspaces.'
            }
          >
            <input
              id={`${uid}-ws`}
              className="cs-input mp-mono-input"
              value={draft.workspaceId}
              maxLength={200}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => set({ workspaceId: event.target.value })}
            />
          </Field>
        )}
      </Step>

      <Step n={readOnly ? 2 : 3} title="Test">
        {creating ? (
          <p className="cs-muted">
            FullDots tests the connection as soon as you add the provider.
          </p>
        ) : (
          <>
            <div className="mp-test-row">
              <button
                type="button"
                className="cs-btn"
                disabled={test.phase === 'busy' || dirty || !view?.enabled}
                onClick={() => id && void runTest(id)}
              >
                {test.phase === 'busy' ? (
                  <>
                    <LoaderCircle
                      size={15}
                      className="cx-spin"
                      aria-hidden="true"
                    />
                    Testing…
                  </>
                ) : (
                  <>
                    <Zap size={15} aria-hidden="true" />
                    Test connection
                  </>
                )}
              </button>
              {dirty && (
                <span className="cs-muted">
                  Save your changes first, then test.
                </span>
              )}
              {!view?.enabled && !dirty && (
                <span className="cs-muted">
                  Turn the provider on to test it.
                </span>
              )}
            </div>
            {test.phase === 'done' && (
              <Banner
                tone={test.result.ok ? 'ok' : 'bad'}
                icon={
                  test.result.ok ? (
                    <CircleCheck size={18} />
                  ) : (
                    <CircleAlert size={18} />
                  )
                }
                role="status"
              >
                <strong className="mp-test-result">
                  {testSummary(test.result)}
                </strong>
              </Banner>
            )}
            {test.phase === 'failed' && (
              <Banner tone="bad" icon={<CircleAlert size={18} />} role="status">
                <strong className="mp-test-result">{test.message}</strong>
              </Banner>
            )}
          </>
        )}
      </Step>

      <Step n={readOnly ? 3 : 4} title="Models">
        {creating ? (
          <p className="cs-muted">
            The models this provider offers appear here once it is added.
          </p>
        ) : !usable && models.phase !== 'ready' ? (
          <p className="cs-muted">
            {view?.enabled
              ? 'Add a working key to see the models.'
              : 'Turn the provider on to see its models.'}
          </p>
        ) : (
          <>
            <div className="mp-models-bar">
              <div className="cg-search mp-models-search">
                <Search size={15} aria-hidden="true" />
                <input
                  type="search"
                  className="mp-models-input"
                  value={query}
                  placeholder="Search models"
                  aria-label="Search models"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <button
                type="button"
                className="cs-btn cs-btn-sm"
                disabled={models.phase === 'loading' || !id}
                onClick={() => id && void loadModels(id, true)}
              >
                <RefreshCw
                  size={13}
                  className={models.phase === 'loading' ? 'cx-spin' : undefined}
                  aria-hidden="true"
                />
                Refresh
              </button>
            </div>
            {models.phase === 'loading' && (
              <p className="cs-muted" role="status">
                Loading models…
              </p>
            )}
            {models.phase === 'failed' && (
              <p className="cn-problems" role="alert">
                {models.message}
              </p>
            )}
            {models.phase === 'ready' && models.result.error && (
              <p className="cs-muted mp-list-error" role="status">
                {models.result.error} You can still type a model id below, or in
                a Dot’s Model field.
              </p>
            )}
            {models.phase === 'ready' && (
              <>
                <p className="cs-muted" role="status">
                  {modelList.length}{' '}
                  {modelList.length === 1 ? 'model' : 'models'}
                  {models.result.stale ? ' (from an earlier fetch)' : ''}
                  {query.trim() ? `, ${shownModels.length} match` : ''}
                </p>
                {shownModels.length > 0 && (
                  <ul className="mp-models" aria-label="Models">
                    {shownModels.slice(0, MODEL_ROW_LIMIT).map((model) => {
                      const isDefault =
                        defaultModel?.providerId === id &&
                        defaultModel?.model === model.id;
                      const context = formatContext(model.contextLength);
                      return (
                        <li className="mp-model" key={model.id}>
                          <span className="mp-model-id">
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
                            <span className="mp-chip mp-chip-ok">Tools</span>
                          )}
                          {model.tools === false && (
                            <span
                              className="mp-chip mp-chip-warn"
                              title="No tool support: a Dot cannot use connectors or save pages with it."
                            >
                              No tools
                            </span>
                          )}
                          {context && (
                            <span className="mp-chip">{context}</span>
                          )}
                          {isDefault ? (
                            <span className="mp-badge mp-badge-default">
                              <Star size={11} aria-hidden="true" />
                              Default
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="cs-btn cs-btn-sm"
                              disabled={!!defaultBusy || !usable}
                              onClick={() => void setDefault(model.id)}
                            >
                              {defaultBusy === model.id
                                ? 'Setting…'
                                : 'Set as default'}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {shownModels.length > MODEL_ROW_LIMIT && (
                  <p className="cs-muted">
                    Showing {MODEL_ROW_LIMIT} of {shownModels.length}. Type to
                    narrow the list.
                  </p>
                )}
                {modelList.length > 0 && shownModels.length === 0 && (
                  <p className="cs-muted">No model matches.</p>
                )}
              </>
            )}
            {usable && (
              <div className="mp-manual">
                <label className="cs-label" htmlFor={`${uid}-manual`}>
                  Not in the list? Type a model id
                </label>
                <div className="mp-manual-row">
                  <input
                    id={`${uid}-manual`}
                    className="cs-input mp-mono-input"
                    value={manualId}
                    maxLength={200}
                    placeholder="llama-3.3-70b-versatile"
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={
                      (manualTouched && !!manualProblem) || undefined
                    }
                    onChange={(event) => setManualId(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        setManualTouched(true);
                        if (!manualProblem) void setDefault(manualId.trim());
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="cs-btn"
                    disabled={!!defaultBusy}
                    onClick={() => {
                      setManualTouched(true);
                      if (!manualProblem) void setDefault(manualId.trim());
                    }}
                  >
                    Set as default
                  </button>
                </div>
                {manualTouched && manualProblem && (
                  <p className="cs-hint cs-hint-bad">{manualProblem}</p>
                )}
              </div>
            )}
          </>
        )}
      </Step>

      {manageError && (
        <p className="cn-problems" role="alert">
          {manageError}
        </p>
      )}
      {usedBy.length > 0 && (
        <Banner tone="warn" icon={<CircleAlert size={18} />} role="status">
          <strong className="mp-used-by">{usedByMessage(usedBy)}</strong>
          <p>Switch them to another provider, then delete this one.</p>
        </Banner>
      )}

      {view && !readOnly && (
        <section className="cs-sec" aria-label="Manage">
          <h4 className="cs-sec-title">Manage</h4>
          <label className="mp-switch-row">
            <span className="mp-switch-text">
              <strong>Enabled</strong>
              <small>
                Turned off, Dots cannot use this provider and it leaves the
                model lists.
              </small>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="mp-switch-input"
              checked={view.enabled}
              disabled={busyManage}
              onChange={() => void toggleEnabled()}
            />
            <span className="mp-switch-track" aria-hidden="true" />
          </label>
          <div className="cs-actions">
            <button
              type="button"
              className="cs-btn cs-btn-danger"
              disabled={busyManage}
              onClick={() => void remove()}
            >
              <Trash2 size={14} aria-hidden="true" />
              Delete provider
            </button>
          </div>
        </section>
      )}

      {!readOnly && (
        <div className="cs-footer">
          {problems.length > 0 && (
            <ul className="cn-problems" role="alert">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          <div className="cs-footer-actions">
            <button type="button" className="cs-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="cs-btn cs-btn-primary"
              data-primary
              disabled={saving || (!creating && !dirty)}
              onClick={() => void save()}
            >
              {saving ? (
                <>
                  <LoaderCircle
                    size={16}
                    className="cx-spin"
                    aria-hidden="true"
                  />
                  Saving…
                </>
              ) : creating ? (
                <>
                  <Power size={16} aria-hidden="true" />
                  Add provider
                </>
              ) : (
                'Save changes'
              )}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
