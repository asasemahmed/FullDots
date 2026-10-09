import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {
  CircleAlert,
  Cpu,
  FolderLock,
  Info,
  Plug,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react';
import { api } from './api';
import { ConnectorsSettings } from './ConnectorsSettings';
import {
  ApprovalModeField,
  DotConnectorGrants,
  type GrantInput,
} from './DotConnectorGrants';
import { Mascot } from './Mascot';
import { ModelPicker, modelFields, type ModelChoice } from './ModelPicker';
import { ModelProvidersSettings } from './ModelProvidersSettings';
import type {
  ApprovalMode,
  ConnectorView,
  Dot,
  DotConnectorGrant,
  Memory,
  State,
  WorkspaceState,
} from '../shared/types';
import './dialog.css';
export type Dialog =
  | { type: 'space' }
  | { type: 'dot'; dot?: Dot; spaceId: string }
  | { type: 'settings'; tab?: SettingsTab }
  | { type: 'memory'; memory?: Memory }
  | { type: 'schedule'; threadId: string };
export type SettingsTab = 'general' | 'models' | 'connectors' | 'about';
const SETTINGS_TABS: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'models', label: 'Models', icon: Cpu },
  { id: 'connectors', label: 'Connectors', icon: Plug },
  { id: 'about', label: 'About', icon: Info },
];
const TAB_STORAGE_KEY = 'fulldots-settings-tab';
/** The tab used last time; storage can be missing or blocked, so every access is guarded. */
export function readStoredTab(): SettingsTab {
  try {
    const stored = localStorage.getItem(TAB_STORAGE_KEY);
    if (SETTINGS_TABS.some((item) => item.id === stored))
      return stored as SettingsTab;
  } catch {
    /* private window or blocked storage */
  }
  return 'general';
}
function storeTab(tab: SettingsTab) {
  try {
    localStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    /* ignore */
  }
}

/** Longest role instructions the server accepts. */
const DOT_INSTRUCTIONS_MAX = 2000;

/** One titled group of the Dot form: icon tile, title, one-line description, then the fields. */
function DotSection({
  id,
  icon: Icon,
  title,
  description,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="dlg-section" role="group" aria-labelledby={`dot-sec-${id}`}>
      <div className="dlg-section-head">
        <span className="dlg-icon" aria-hidden="true">
          <Icon size={16} strokeWidth={1.9} />
        </span>
        <div>
          <h3 id={`dot-sec-${id}`}>{title}</h3>
          <p>{description}</p>
        </div>
      </div>
      <div className="dlg-section-body">{children}</div>
    </div>
  );
}

/** A permission row with a real checkbox (role switch) drawn as a toggle. */
function DotSwitchRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="dlg-switch-row">
      <span className="dlg-switch-text">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        className="dlg-sr"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="dlg-switch-track" aria-hidden="true" />
    </label>
  );
}

/** The two workspace-wide permission switches, shared by the Dot form and Settings. */
function PermissionRows({
  research,
  memory,
  onResearch,
  onMemory,
}: {
  research: boolean;
  memory: boolean;
  onResearch: (value: boolean) => void;
  onMemory: (value: boolean) => void;
}) {
  return (
    <>
      <label className="permission-row">
        <input
          type="checkbox"
          checked={research}
          onChange={(e) => onResearch(e.target.checked)}
        />
        <span>
          <strong>Public-page research</strong>
          <small>
            Allow the server-side read-only browser tool. Global settings always
            take precedence.
          </small>
        </span>
      </label>
      <label className="permission-row">
        <input
          type="checkbox"
          checked={memory}
          onChange={(e) => onMemory(e.target.checked)}
        />
        <span>
          <strong>Use saved memories</strong>
          <small>
            Include your preferences in new turns. Changing permission stops
            active work.
          </small>
        </span>
      </label>
    </>
  );
}

export function WorkspaceDialog({
  dialog,
  state,
  workspace,
  onClose,
  mutate,
}: {
  dialog: Dialog;
  state: State;
  workspace: WorkspaceState;
  onClose: () => void;
  mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
  const [name, setName] = useState(
    dialog.type === 'dot' ? (dialog.dot?.name ?? '') : '',
  );
  const [text, setText] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.instructions ?? '')
      : dialog.type === 'memory'
        ? (dialog.memory?.text ?? '')
        : '',
  );
  const [research, setResearch] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.researchAllowed ?? true)
      : state.settings.researchAllowed,
  );
  const [memory, setMemory] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.memoryAllowed ?? true)
      : state.settings.memoryAllowed,
  );
  const [spaceIds, setSpaceIds] = useState(
    dialog.type === 'dot' ? (dialog.dot?.spaceIds ?? [dialog.spaceId]) : [],
  );
  const [defaultSpace, setDefaultSpace] = useState(
    dialog.type === 'dot' ? (dialog.dot?.spaceId ?? dialog.spaceId) : '',
  );
  const [interval, setInterval] = useState('86400');
  // A model id plus the provider that serves it; a null provider means the default one.
  const [modelChoice, setModelChoice] = useState<ModelChoice>({
    providerId:
      dialog.type === 'dot' ? (dialog.dot?.modelProviderId ?? null) : null,
    model: dialog.type === 'dot' ? (dialog.dot?.model ?? '') : '',
  });
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(
    dialog.type === 'dot'
      ? (dialog.dot?.approvalMode ?? 'sensitive')
      : 'sensitive',
  );
  const [connectors, setConnectors] = useState<ConnectorView[]>([]);
  const [grants, setGrants] = useState<GrantInput[]>([]);
  const [grantsDirty, setGrantsDirty] = useState(false);
  const savedDotId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (dialog.type !== 'dot') return;
    let active = true;
    void Promise.all([
      api<{ connectors: ConnectorView[] }>('/connectors'),
      dialog.dot
        ? api<{ grants: DotConnectorGrant[] }>(
            `/dots/${dialog.dot.id}/connectors`,
          )
        : Promise.resolve({ grants: [] as DotConnectorGrant[] }),
    ])
      .then(([list, existing]) => {
        if (!active) return;
        setConnectors(list.connectors);
        setGrants(
          existing.grants.map((grant) => ({
            connectorId: grant.connectorId,
            tools: grant.tools,
            ...(Object.keys(grant.overrides ?? {}).length
              ? { overrides: grant.overrides }
              : {}),
          })),
        );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [dialog.type]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scrolled, setScrolled] = useState(false);
  const [tab, setTab] = useState<SettingsTab>(() =>
    dialog.type === 'settings' && dialog.tab ? dialog.tab : readStoredTab(),
  );
  // The models and connectors tabs mount on first visit and then stay, so a sign-in in
  // progress (or a half-typed key) survives a tab switch.
  const [connectorsSeen, setConnectorsSeen] = useState(tab === 'connectors');
  const [modelsSeen, setModelsSeen] = useState(tab === 'models');
  const selectTab = (next: SettingsTab) => {
    setTab(next);
    if (next === 'connectors') setConnectorsSeen(true);
    if (next === 'models') setModelsSeen(true);
    storeTab(next);
  };
  const onTabKeyDown = (event: ReactKeyboardEvent) => {
    const step =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? -1
          : 0;
    const count = SETTINGS_TABS.length;
    const current = SETTINGS_TABS.findIndex((item) => item.id === tab);
    let index: number;
    if (step) index = (current + step + count) % count;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = count - 1;
    else return;
    event.preventDefault();
    const next = SETTINGS_TABS[index]!.id;
    selectTab(next);
    document.getElementById(`settings-tab-${next}`)?.focus();
  };
  const container = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    container.current
      ?.querySelector<HTMLElement>('input,textarea,select')
      ?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const items = [
          ...(container.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]),input,textarea,select,a[href]',
          ) ?? []),
        ];
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
          event.preventDefault();
          items[0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);
  const title =
    dialog.type === 'space'
      ? 'A space for something.'
      : dialog.type === 'dot'
        ? dialog.dot
          ? 'Make this Dot yours.'
          : 'Meet your next specialist.'
        : dialog.type === 'settings'
          ? 'Settings'
          : dialog.type === 'memory'
            ? 'Something to remember.'
            : 'Let your Dot keep time.';
  const isDot = dialog.type === 'dot';
  const showFooter = dialog.type !== 'settings' || tab === 'general';
  const submitLabel = busy
    ? 'Saving…'
    : isDot
      ? dialog.dot
        ? 'Save changes'
        : 'Create Dot'
      : 'Save';
  return (
    <div className="modal-backdrop dlg-backdrop" onClick={onClose}>
      <section
        className={[
          'modal',
          dialog.type === 'settings' ? 'modal-settings' : '',
          'dlg',
          isDot ? 'dlg-dot' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        ref={container}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="dlg-header" data-scrolled={scrolled}>
          <div className="dlg-heading">
            <span className="eyebrow">FULLDOTS</span>
            <h2 id="dialog-title">{title}</h2>
          </div>
          <button
            type="button"
            className="dlg-close"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <form
          className={
            dialog.type === 'settings' ? 'ss-form dlg-form' : 'dlg-form'
          }
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            let path = '',
              method = 'POST',
              body: unknown;
            if (dialog.type === 'space') {
              path = '/spaces';
              body = { name, description: text };
            }
            if (dialog.type === 'dot') {
              path = dialog.dot ? `/dots/${dialog.dot.id}` : '/dots';
              method = dialog.dot ? 'PUT' : 'POST';
              body = {
                spaceId: defaultSpace,
                spaceIds,
                name,
                instructions: text,
                researchAllowed: research,
                memoryAllowed: memory,
                ...modelFields(modelChoice),
                approvalMode,
              };
            }
            if (dialog.type === 'settings') {
              path = '/settings';
              method = 'PATCH';
              body = { researchAllowed: research, memoryAllowed: memory };
            }
            if (dialog.type === 'memory') {
              path = dialog.memory
                ? `/memories/${dialog.memory.id}`
                : '/memories';
              method = dialog.memory ? 'PUT' : 'POST';
              body = { text };
            }
            if (dialog.type === 'schedule') {
              path = '/tasks';
              body = {
                prompt: text,
                threadId: dialog.threadId,
                intervalSeconds: Number(interval),
              };
            }
            let saved: boolean;
            if (dialog.type === 'dot' && grantsDirty) {
              try {
                // A new Dot needs its id before the grants can be saved. The
                // last step goes through mutate so the workspace refreshes.
                let dotId = dialog.dot?.id ?? savedDotId.current;
                if (dotId) saved = await mutate(`/dots/${dotId}`, 'PUT', body);
                else {
                  dotId = (await api<Dot>('/dots', 'POST', body)).id;
                  savedDotId.current = dotId;
                  saved = true;
                }
                if (saved)
                  saved = await mutate(`/dots/${dotId}/connectors`, 'PUT', {
                    grants: grants.filter((grant) =>
                      connectors.some((item) => item.id === grant.connectorId),
                    ),
                  });
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not save.');
                setBusy(false);
                return;
              }
            } else saved = await mutate(path, method, body);
            if (saved) onClose();
            else
              setError('Could not save. Review the workspace error and retry.');
            setBusy(false);
          }}
        >
          <div
            className="dlg-body"
            onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
          >
            {dialog.type === 'dot' && (
              <>
                <DotSection
                  id="identity"
                  icon={Sparkles}
                  title="Identity"
                  description="Name your specialist and tell it what it does."
                >
                  <div className="dlg-identity">
                    <span className="dlg-avatar">
                      <Mascot
                        identity={dialog.dot?.id}
                        name={name || 'New Dot'}
                      />
                    </span>
                    <div className="dlg-identity-fields">
                      <label className="dlg-label" htmlFor="entity-name">
                        Name
                      </label>
                      <input
                        id="entity-name"
                        className="dlg-input dlg-input-lg"
                        value={name}
                        maxLength={40}
                        placeholder="Research partner"
                        autoComplete="off"
                        onChange={(e) => setName(e.target.value)}
                        required
                      />
                      <p className="dlg-hint">Each Dot keeps its own colour.</p>
                    </div>
                  </div>
                  <label className="dlg-label" htmlFor="entity-text">
                    Role instructions
                  </label>
                  <textarea
                    id="entity-text"
                    className="dlg-input dlg-textarea"
                    rows={5}
                    maxLength={DOT_INSTRUCTIONS_MAX}
                    required
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    aria-describedby="dot-instructions-hint"
                    placeholder="You are a thoughtful research partner. Compare evidence and be clear about uncertainty."
                  />
                  <div className="dlg-hint-row" id="dot-instructions-hint">
                    <span className="dlg-hint">
                      Describe the role, tone and what to avoid.
                    </span>
                    <span className="dlg-hint dlg-count">
                      {text.length} / {DOT_INSTRUCTIONS_MAX}
                    </span>
                  </div>
                </DotSection>
                <DotSection
                  id="model"
                  icon={Cpu}
                  title="Model"
                  description="Which AI model this Dot runs on."
                >
                  <label className="dlg-vh" htmlFor="dot-model">
                    Model
                  </label>
                  <ModelPicker
                    id="dot-model"
                    value={modelChoice}
                    onChange={setModelChoice}
                    defaultLabel={workspace.setup.defaultModel ?? null}
                    describedBy="dot-model-help"
                  />
                  <p className="dlg-hint" id="dot-model-help">
                    Use the default, or pick any model from the providers you
                    added in Settings → Models. A stronger one suits research; a
                    faster one suits quick tasks.
                  </p>
                </DotSection>
                <DotSection
                  id="connectors"
                  icon={Plug}
                  title="Connectors"
                  description="Tools from your connected services this Dot may use."
                >
                  <DotConnectorGrants
                    connectors={connectors}
                    value={grants}
                    onChange={(next) => {
                      setGrants(next);
                      setGrantsDirty(true);
                    }}
                  />
                </DotSection>
                <DotSection
                  id="approvals"
                  icon={ShieldCheck}
                  title="Approvals"
                  description="When this Dot should stop and ask you first."
                >
                  <ApprovalModeField
                    value={approvalMode}
                    onChange={setApprovalMode}
                  />
                </DotSection>
                <DotSection
                  id="access"
                  icon={FolderLock}
                  title="Access"
                  description="Where this Dot can read and edit pages, and what it may use."
                >
                  <div
                    className="dlg-list"
                    role="group"
                    aria-label="Space access"
                  >
                    {workspace.spaces.length === 0 && (
                      <p className="dlg-hint">No Spaces yet.</p>
                    )}
                    {workspace.spaces.map((space) => (
                      <label className="dlg-check-row" key={space.id}>
                        <input
                          type="checkbox"
                          checked={spaceIds.includes(space.id)}
                          onChange={(event) => {
                            const next = event.target.checked
                              ? [...spaceIds, space.id]
                              : spaceIds.filter((id) => id !== space.id);
                            setSpaceIds(next);
                            if (!next.includes(defaultSpace))
                              setDefaultSpace(next[0] ?? '');
                          }}
                        />
                        <span>{space.name}</span>
                      </label>
                    ))}
                  </div>
                  <label className="dlg-label" htmlFor="default-space">
                    Default destination for saved pages
                  </label>
                  <select
                    id="default-space"
                    className="dlg-input dlg-select"
                    value={defaultSpace}
                    required
                    onChange={(event) => setDefaultSpace(event.target.value)}
                  >
                    <option value="" disabled>
                      Choose a Space
                    </option>
                    {workspace.spaces
                      .filter((space) => spaceIds.includes(space.id))
                      .map((space) => (
                        <option key={space.id} value={space.id}>
                          {space.name}
                        </option>
                      ))}
                  </select>
                  <div className="dlg-switches">
                    <DotSwitchRow
                      title="Public-page research"
                      description="Allow the server-side read-only browser tool. Global settings always take precedence."
                      checked={research}
                      onChange={setResearch}
                    />
                    <DotSwitchRow
                      title="Use saved memories"
                      description="Include your preferences in new turns. Changing permission stops active work."
                      checked={memory}
                      onChange={setMemory}
                    />
                  </div>
                </DotSection>
              </>
            )}
            {dialog.type === 'space' && (
              <>
                <label className="field-label" htmlFor="entity-name">
                  Name
                </label>
                <input
                  id="entity-name"
                  className="dlg-input"
                  value={name}
                  maxLength={40}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </>
            )}
            {(dialog.type === 'space' ||
              dialog.type === 'memory' ||
              dialog.type === 'schedule') && (
              <>
                <label className="field-label" htmlFor="entity-text">
                  {dialog.type === 'space'
                    ? 'What belongs here?'
                    : dialog.type === 'memory'
                      ? 'Preference or context'
                      : 'Task to revisit'}
                </label>
                <textarea
                  id="entity-text"
                  className="dlg-input dlg-textarea"
                  rows={4}
                  maxLength={dialog.type === 'schedule' ? 4000 : 2000}
                  required={dialog.type !== 'space'}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </>
            )}
            {dialog.type === 'schedule' && (
              <>
                <label className="field-label" htmlFor="schedule-interval">
                  Repeat after each successful run
                </label>
                <select
                  id="schedule-interval"
                  className="dlg-input dlg-select"
                  value={interval}
                  onChange={(e) => setInterval(e.target.value)}
                >
                  <option value="60">Every minute (testing)</option>
                  <option value="3600">Every hour</option>
                  <option value="86400">Every day</option>
                  <option value="604800">Every week</option>
                </select>
                <p className="dlg-hint">
                  Runs on the server in this same conversation, even with the
                  tab closed. Failed runs wait for manual retry.
                </p>
              </>
            )}
            {dialog.type === 'settings' && (
              <div className="ss-shell">
                <div
                  className="ss-tabs"
                  role="tablist"
                  aria-label="Settings"
                  aria-orientation="vertical"
                  onKeyDown={onTabKeyDown}
                >
                  {SETTINGS_TABS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      className="ss-tab"
                      id={`settings-tab-${item.id}`}
                      aria-selected={tab === item.id}
                      aria-controls={`settings-panel-${item.id}`}
                      tabIndex={tab === item.id ? 0 : -1}
                      onClick={() => selectTab(item.id)}
                    >
                      <item.icon size={17} aria-hidden="true" />
                      {item.label}
                    </button>
                  ))}
                </div>
                <div className="ss-panels">
                  <div
                    className="ss-panel"
                    role="tabpanel"
                    id="settings-panel-general"
                    aria-labelledby="settings-tab-general"
                    hidden={tab !== 'general'}
                  >
                    <PermissionRows
                      research={research}
                      memory={memory}
                      onResearch={setResearch}
                      onMemory={setMemory}
                    />
                    <div className="config-note">
                      <strong>Service setup</strong>
                      <p>
                        {workspace.setup.missing.includes('model provider') ? (
                          <>
                            Add a model provider in{' '}
                            <button
                              type="button"
                              className="mp-linkbtn"
                              onClick={() => selectTab('models')}
                            >
                              Settings → Models
                            </button>
                            , or set OPENAI_API_KEY and restart.
                          </>
                        ) : workspace.setup.missing.length ? (
                          `Add ${workspace.setup.missing.join(', ')} to the server environment, then restart.`
                        ) : (
                          'A model provider is ready. A successful conversation confirms connectivity.'
                        )}
                      </p>
                      <p>
                        Web search: {workspace.setup.search ? 'on' : 'off'}.
                        Page reader: {workspace.setup.browser ? 'on' : 'off'}.
                        Voice:{' '}
                        {workspace.setup.voice
                          ? 'configuration present'
                          : 'needs VOICE_API_KEY and VOICE_MODEL'}
                        .
                      </p>
                      <a
                        href="https://github.com/asasemahmed/FullDots/blob/main/docs/SETUP.md"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Template setup guide ↗
                      </a>
                    </div>
                  </div>
                  <div
                    className="ss-panel ss-panel-connectors"
                    role="tabpanel"
                    id="settings-panel-models"
                    aria-labelledby="settings-tab-models"
                    hidden={tab !== 'models'}
                  >
                    {modelsSeen && <ModelProvidersSettings />}
                  </div>
                  <div
                    className="ss-panel ss-panel-connectors"
                    role="tabpanel"
                    id="settings-panel-connectors"
                    aria-labelledby="settings-tab-connectors"
                    hidden={tab !== 'connectors'}
                  >
                    {connectorsSeen && <ConnectorsSettings />}
                  </div>
                  <div
                    className="ss-panel"
                    role="tabpanel"
                    id="settings-panel-about"
                    aria-labelledby="settings-tab-about"
                    hidden={tab !== 'about'}
                  >
                    <div className="config-note">
                      <strong>About</strong>
                      <p>
                        FullDots is an open source template <span>v0.1</span>.
                        Fork it and make it your own.
                      </p>
                      <a
                        href="https://github.com/asasemahmed/FullDots"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Make it your own ↗
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            )}
            {dialog.type === 'memory' && (
              <p className="dlg-hint">
                Memories are explicit preferences, not automatic learning. Avoid
                secrets; enabled memories go to your model provider.
              </p>
            )}
          </div>
          {(showFooter || error) && (
            <footer className="dlg-footer">
              {error && (
                <p className="dlg-error" role="alert">
                  <CircleAlert size={16} aria-hidden="true" />
                  <span>{error}</span>
                </p>
              )}
              {showFooter && (
                <div className="dlg-actions">
                  <button type="button" className="dlg-btn" onClick={onClose}>
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="dlg-btn dlg-primary"
                    disabled={busy}
                  >
                    {submitLabel}
                  </button>
                </div>
              )}
            </footer>
          )}
        </form>
      </section>
    </div>
  );
}
