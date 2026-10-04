import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  BookOpen,
  ChevronRight,
  Clock3,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Search,
  Settings2,
  SquarePen,
  X,
} from 'lucide-react';
import type { Dot, WorkspaceState } from '../../shared/types';
import { Mascot } from '../Mascot';
import { SpaceNav } from '../SpaceNav';
import { ThreadList } from '../ThreadList';
import type { Dialog } from '../WorkspaceDialog';
import { filterChats, groupChats, listableChats } from './chat-groups';
import { MOBILE_QUERY, useMediaQuery, useStoredFlag } from './hooks';
import { RowMenu } from './RowMenu';
import '../sidebar.css';

export type NavView = 'chat' | 'tasks' | 'memories' | 'space';

export interface SidebarProps {
  workspace: WorkspaceState;
  dot: Dot;
  view: NavView;
  selectedThread?: string;
  spaceId: string;
  pageId?: string;
  taskCount: number;
  memoryCount: number;
  configured: boolean;
  /** Desktop slim icon-only mode. Ignored on phones, which use the drawer. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Phone drawer. */
  mobileOpen: boolean;
  onDismissMobile: () => void;
  onHome: () => void;
  onNewChat: (dot?: Dot) => void;
  onChooseDot: (dot: Dot) => void;
  onSelectThread: (id: string) => void;
  onRenameThread: (id: string, title: string) => Promise<boolean>;
  onDeleteThreads: (ids: string[]) => Promise<boolean>;
  onOpenPage: (spaceId: string, pageId?: string) => void;
  onView: (view: 'tasks' | 'memories') => void;
  onDialog: (dialog: Dialog) => void;
}

function Section({
  title,
  storageKey,
  collapsed,
  actionLabel,
  onAction,
  children,
}: {
  title: string;
  storageKey: string;
  /** The slim sidebar shows every section's items and none of the chrome. */
  collapsed: boolean;
  actionLabel: string;
  onAction: () => void;
  children: ReactNode;
}) {
  const [closed, setClosed] = useStoredFlag(storageKey, false);
  const id = `sb-${storageKey.split('.').pop()}`;
  return (
    <section className="sb-section" aria-label={title}>
      <div className="sb-section-head">
        <button
          type="button"
          className="sb-section-toggle"
          aria-expanded={!closed}
          aria-controls={id}
          onClick={() => setClosed(!closed)}
        >
          <ChevronRight
            size={12}
            aria-hidden
            className={closed ? '' : 'turned'}
          />
          {title}
        </button>
        <button
          type="button"
          className="sb-icon"
          aria-label={actionLabel}
          title={actionLabel}
          onClick={onAction}
        >
          <Plus size={14} aria-hidden />
        </button>
      </div>
      {(collapsed || !closed) && (
        <div className="sb-section-body" id={id}>
          {children}
        </div>
      )}
    </section>
  );
}

export function Sidebar({
  workspace,
  dot,
  view,
  selectedThread,
  spaceId,
  pageId,
  taskCount,
  memoryCount,
  configured,
  collapsed: collapsedPreference,
  onToggleCollapsed,
  mobileOpen,
  onDismissMobile,
  onHome,
  onNewChat,
  onChooseDot,
  onSelectThread,
  onRenameThread,
  onDeleteThreads,
  onOpenPage,
  onView,
  onDialog,
}: SidebarProps) {
  const phone = useMediaQuery(MOBILE_QUERY);
  const collapsed = collapsedPreference && !phone;
  const [query, setQuery] = useState('');
  const aside = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const focusSearch = useRef(false);
  const several = workspace.dots.length > 1;
  // Label helper: when text is hidden (slim mode) the button needs a name and a tooltip.
  const tip = (label: string) =>
    collapsed ? { 'aria-label': label, title: label } : {};

  useEffect(() => {
    if (!collapsed && focusSearch.current) {
      focusSearch.current = false;
      search.current?.focus();
    }
  }, [collapsed]);

  // Phone drawer: take focus when it opens, close on Escape.
  useEffect(() => {
    if (!mobileOpen) return;
    aside.current?.querySelector<HTMLElement>('.sb-close')?.focus();
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onDismissMobile();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [mobileOpen, onDismissMobile]);

  const searchKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && query) {
      event.preventDefault();
      event.stopPropagation();
      setQuery('');
    } else if (event.key === 'Enter') {
      // The first match in the order the list shows them.
      const first = groupChats(
        filterChats(
          listableChats(workspace.conversations, selectedThread),
          query,
        ),
      )[0]?.items[0];
      if (first && query.trim()) onSelectThread(first.id);
    } else if (event.key === 'ArrowDown') {
      const row = aside.current?.querySelector<HTMLElement>('.sb-chat-main');
      if (row) {
        event.preventDefault();
        row.focus();
      }
    }
  };

  return (
    <aside
      id="workspace-sidebar"
      ref={aside}
      className={`sb ${collapsed ? 'collapsed' : ''} ${mobileOpen ? 'open' : ''}`}
      aria-label="Workspace sidebar"
    >
      <div className="sb-head">
        <button
          type="button"
          className="sb-brand"
          aria-label="FullDots home"
          title={collapsed ? 'FullDots home' : undefined}
          onClick={onHome}
        >
          <span className="dotted-logo" aria-hidden>
            <i />
            <i />
            <i />
            <i />
          </span>
          <span className="sb-text">FullDots</span>
        </button>
        <button
          type="button"
          className="sb-icon sb-collapse"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          aria-controls="workspace-sidebar"
          onClick={onToggleCollapsed}
        >
          {collapsed ? (
            <PanelLeftOpen size={17} aria-hidden />
          ) : (
            <PanelLeftClose size={17} aria-hidden />
          )}
        </button>
        <button
          type="button"
          className="sb-icon sb-close"
          aria-label="Close navigation"
          onClick={onDismissMobile}
        >
          <X size={18} aria-hidden />
        </button>
      </div>

      <div className="sb-actions">
        <button
          type="button"
          className="sb-new"
          disabled={!configured}
          {...tip(`New chat with ${dot.name}`)}
          onClick={() => onNewChat()}
        >
          {several ? (
            <span className="sb-new-avatar">
              <Mascot identity={dot.id} name={dot.name} small decorative />
            </span>
          ) : (
            <SquarePen size={16} aria-hidden />
          )}
          <span className="sb-text">New chat</span>
        </button>
        <label className="sb-search">
          <Search size={14} aria-hidden />
          <input
            ref={search}
            type="search"
            placeholder="Search chats"
            aria-label="Search chats"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={searchKeys}
          />
          {query && (
            <button
              type="button"
              className="sb-icon sb-search-clear"
              aria-label="Clear search"
              onClick={() => {
                setQuery('');
                search.current?.focus();
              }}
            >
              <X size={13} aria-hidden />
            </button>
          )}
        </label>
        <button
          type="button"
          className="sb-row sb-search-icon"
          aria-label="Search chats"
          title="Search chats"
          onClick={() => {
            focusSearch.current = true;
            onToggleCollapsed();
          }}
        >
          <Search size={17} aria-hidden />
        </button>
      </div>

      <div className="sb-body">
        <Section
          title="Dots"
          storageKey="fulldots.sidebar.dots"
          collapsed={collapsed}
          actionLabel="Create Dot"
          onAction={() =>
            onDialog({ type: 'dot', spaceId: workspace.spaces[0].id })
          }
        >
          <nav aria-label="Dots" className="sb-list">
            {workspace.dots.map((item) => {
              const active = dot.id === item.id && view === 'chat';
              return (
                <div className="sb-row-wrap" key={item.id}>
                  <button
                    type="button"
                    className={`sb-row sb-dot ${active ? 'active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                    {...tip(item.name)}
                    onClick={() => onChooseDot(item)}
                  >
                    <span className="sb-avatar">
                      <Mascot
                        identity={item.id}
                        name={item.name}
                        small
                        decorative
                      />
                    </span>
                    <span className="sb-text">{item.name}</span>
                  </button>
                  <RowMenu
                    label={`${item.name} options`}
                    className="sb-row-more"
                    items={[
                      {
                        id: 'chat',
                        label: 'New chat',
                        icon: <SquarePen size={14} aria-hidden />,
                        onSelect: () => onNewChat(item),
                      },
                      {
                        id: 'edit',
                        label: 'Edit Dot',
                        icon: <Pencil size={14} aria-hidden />,
                        onSelect: () =>
                          onDialog({
                            type: 'dot',
                            dot: item,
                            spaceId: item.spaceId,
                          }),
                      },
                    ]}
                  />
                </div>
              );
            })}
          </nav>
        </Section>

        <Section
          title="Spaces"
          storageKey="fulldots.sidebar.spaces"
          collapsed={collapsed}
          actionLabel="Create Space"
          onAction={() => onDialog({ type: 'space' })}
        >
          <nav aria-label="Spaces" className="sb-list sb-spaces">
            {workspace.spaces.map((space) => (
              <SpaceNav
                key={space.id}
                space={space}
                collapsed={collapsed}
                active={view === 'space' && spaceId === space.id}
                pageId={pageId}
                onOpen={(id) => onOpenPage(space.id, id)}
              />
            ))}
          </nav>
        </Section>

        {configured ? (
          <ThreadList
            chats={workspace.conversations}
            dots={workspace.dots}
            selectedId={view === 'chat' ? selectedThread : undefined}
            query={query}
            onSelect={onSelectThread}
            onRename={onRenameThread}
            onDelete={onDeleteThreads}
          />
        ) : (
          <p className="sb-note sb-chats">
            Set up text chat to begin a persistent conversation.
          </p>
        )}
      </div>

      <div className="sb-foot">
        <button
          type="button"
          className={`sb-icon sb-foot-button ${view === 'tasks' ? 'active' : ''}`}
          aria-label="Scheduled and activity"
          title="Scheduled & activity"
          aria-current={view === 'tasks' ? 'page' : undefined}
          onClick={() => onView('tasks')}
        >
          <Clock3 size={17} aria-hidden />
          {taskCount > 0 && (
            <span className="sb-badge" aria-label={`${taskCount} tasks`}>
              {taskCount > 99 ? '99+' : taskCount}
            </span>
          )}
        </button>
        <button
          type="button"
          className={`sb-icon sb-foot-button ${view === 'memories' ? 'active' : ''}`}
          aria-label={`Memories (${memoryCount})`}
          title={`Memories (${memoryCount})`}
          aria-current={view === 'memories' ? 'page' : undefined}
          onClick={() => onView('memories')}
        >
          <BookOpen size={17} aria-hidden />
        </button>
        <span className="sb-foot-gap" />
        <button
          type="button"
          className="sb-icon sb-foot-button"
          aria-label="Settings and setup"
          title="Settings & setup"
          onClick={() => onDialog({ type: 'settings' })}
        >
          <Settings2 size={17} aria-hidden />
        </button>
      </div>
    </aside>
  );
}
