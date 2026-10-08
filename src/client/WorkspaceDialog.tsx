import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Info, Plug, Settings2, X, type LucideIcon } from 'lucide-react';
import { api } from './api';
import { ConnectorsSettings } from './ConnectorsSettings';
import {
  ApprovalModeField,
  DotConnectorGrants,
  type GrantInput,
} from './DotConnectorGrants';
import type {
  ApprovalMode,
  ConnectorView,
  Dot,
  DotConnectorGrant,
  Memory,
  State,
  WorkspaceState,
} from '../shared/types';
export type Dialog =
  | { type: 'space' }
  | { type: 'dot'; dot?: Dot; spaceId: string }
  | { type: 'settings'; tab?: SettingsTab }
  | { type: 'memory'; memory?: Memory }
  | { type: 'schedule'; threadId: string };
export type SettingsTab = 'general' | 'connectors' | 'about';
const SETTINGS_TABS: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
  { id: 'general', label: 'General', icon: Settings2 },
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
  const [model, setModel] = useState(
    dialog.type === 'dot' ? (dialog.dot?.model ?? '') : '',
  );
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  useEffect(() => {
    if (dialog.type !== 'dot') return;
    let active = true;
    void api<{ models: string[] }>('/models')
      .then((result) => {
        if (active) setModelOptions(result.models);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [dialog.type]);
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
  const [tab, setTab] = useState<SettingsTab>(() =>
    dialog.type === 'settings' && dialog.tab ? dialog.tab : readStoredTab(),
  );
  // The connectors tab mounts on first visit and then stays, so a sign-in in
  // progress survives a tab switch.
  const [connectorsSeen, setConnectorsSeen] = useState(tab === 'connectors');
  const selectTab = (next: SettingsTab) => {
    setTab(next);
    if (next === 'connectors') setConnectorsSeen(true);
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
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className={
          dialog.type === 'settings' ? 'modal modal-settings' : 'modal'
        }
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        ref={container}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <span className="eyebrow">FULLDOTS</span>
        <h2 id="dialog-title">{title}</h2>
        <form
          className={dialog.type === 'settings' ? 'ss-form' : undefined}
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
                model: model.trim() || null,
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
          {(dialog.type === 'space' || dialog.type === 'dot') && (
            <>
              <label className="field-label" htmlFor="entity-name">
                Name
              </label>
              <input
                id="entity-name"
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </>
          )}
          {dialog.type !== 'settings' && (
            <>
              <label className="field-label" htmlFor="entity-text">
                {dialog.type === 'dot'
                  ? 'Role instructions'
                  : dialog.type === 'space'
                    ? 'What belongs here?'
                    : dialog.type === 'memory'
                      ? 'Preference or context'
                      : 'Task to revisit'}
              </label>
              <textarea
                id="entity-text"
                rows={4}
                maxLength={dialog.type === 'schedule' ? 4000 : 2000}
                required={dialog.type !== 'space'}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  dialog.type === 'dot'
                    ? 'You are a thoughtful research partner. Compare evidence and be clear about uncertainty.'
                    : ''
                }
              />
            </>
          )}
          {dialog.type === 'dot' && (
            <>
              <label className="field-label" htmlFor="dot-model">
                Model
              </label>
              <input
                id="dot-model"
                list="dot-model-options"
                value={model}
                maxLength={200}
                spellCheck={false}
                autoComplete="off"
                placeholder={
                  workspace.setup.defaultModel
                    ? `Default: ${workspace.setup.defaultModel}`
                    : 'Server default'
                }
                aria-describedby="dot-model-help"
                onChange={(event) => setModel(event.target.value)}
              />
              <datalist id="dot-model-options">
                {modelOptions.map((option) => (
                  <option key={option} value={option} />
                ))}
              </datalist>
              <p className="muted" id="dot-model-help">
                Leave blank to use the server default. Any model your provider
                offers works, for example a stronger model for research and a
                faster one for quick tasks.
              </p>
            </>
          )}
          {dialog.type === 'dot' && (
            <DotConnectorGrants
              connectors={connectors}
              value={grants}
              onChange={(next) => {
                setGrants(next);
                setGrantsDirty(true);
              }}
            />
          )}
          {dialog.type === 'dot' && (
            <ApprovalModeField
              value={approvalMode}
              onChange={setApprovalMode}
            />
          )}
          {dialog.type === 'dot' && (
            <fieldset className="space-access-fields">
              <legend>Space access</legend>
              <p className="muted">
                Choose where this Dot can read and edit pages.
              </p>
              {workspace.spaces.map((space) => (
                <label className="permission-row" key={space.id}>
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
              <label className="field-label" htmlFor="default-space">
                Default destination for saved pages
              </label>
              <select
                id="default-space"
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
            </fieldset>
          )}
          {dialog.type === 'dot' && (
            <PermissionRows
              research={research}
              memory={memory}
              onResearch={setResearch}
              onMemory={setMemory}
            />
          )}
          {dialog.type === 'schedule' && (
            <>
              <label className="field-label" htmlFor="schedule-interval">
                Repeat after each successful run
              </label>
              <select
                id="schedule-interval"
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
              >
                <option value="60">Every minute (testing)</option>
                <option value="3600">Every hour</option>
                <option value="86400">Every day</option>
                <option value="604800">Every week</option>
              </select>
              <p className="muted">
                Runs on the server in this same conversation, even with the tab
                closed. Failed runs wait for manual retry.
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
                      {workspace.setup.missing.length
                        ? `Add ${workspace.setup.missing.join(', ')} to the server environment, then restart.`
                        : 'Text configuration is present. A successful conversation confirms connectivity.'}
                    </p>
                    <p>
                      Web search: {workspace.setup.search ? 'on' : 'off'}. Page
                      reader: {workspace.setup.browser ? 'on' : 'off'}. Voice:{' '}
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
            <p className="muted">
              Memories are explicit preferences, not automatic learning. Avoid
              secrets; enabled memories go to your model provider.
            </p>
          )}
          {error && (
            <p className="chat-error" role="alert">
              {error}
            </p>
          )}
          {(dialog.type !== 'settings' || tab === 'general') && (
            <button className="primary full" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          )}
        </form>
      </section>
    </div>
  );
}
