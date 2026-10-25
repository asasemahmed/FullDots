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
  FolderOpen,
  Inbox,
  LayoutGrid,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Pencil,
  Play,
  Plug,
  Plus,
  Search,
  Settings2,
  SquarePen,
  Users,
  X,
} from 'lucide-react';
import type { Dot, WorkspaceState } from '../../shared/types';
import { Mascot, dotLook } from '../Mascot';
import { SpaceNav } from '../SpaceNav';
import { ThreadList } from '../ThreadList';
import type { Dialog } from '../WorkspaceDialog';
import { MOBILE_QUERY, useMediaQuery, useStoredFlag } from './hooks';
import { RowMenu } from './RowMenu';
import type { DotLive } from './useDotLive';
import '../sidebar.css';
import { BrandMark } from '../DotCharacter';
import { ConnectorLogo } from '../connector-logos';
import { COMPUTER_STEP_LABELS } from '../../shared/step-label';
import { shortcutLabel } from '../palette/palette-model';
import { roleLine } from '../room/mentions';
import { TeamRows, type SidebarTeams } from '../teams/TeamsSection';

export type NavView =
  'chat' | 'tasks' | 'memories' | 'space' | 'inbox' | 'mission' | 'team';

export interface SidebarProps {
  workspace: WorkspaceState;
  dot: Dot;
  view: NavView;
  selectedThread?: string;
  spaceId: string;
  pageId?: string;
  fileId?: string;
  taskCount: number;
  memoryCount: number;
  /** What needs the owner: pending approvals, waiting handoffs and open questions. */
  approvalCount?: number;
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
  /** Pauses or resumes one Dot. */
  onTogglePause?: (dot: Dot) => void;
  onSelectThread: (id: string) => void;
  onRenameThread: (id: string, title: string) => Promise<boolean>;
  onDeleteThreads: (ids: string[]) => Promise<boolean>;
  /** Writes one conversation to a Markdown file the owner keeps. */
  onExportThread: (id: string) => Promise<void>;
  onOpenPage: (spaceId: string, pageId?: string) => void;
  onOpenFile: (spaceId: string, fileId: string) => void;
  onView: (view: 'tasks' | 'memories' | 'inbox' | 'mission') => void;
  onDialog: (dialog: Dialog) => void;
  /** Opens the Ctrl+K palette. */
  onOpenPalette?: (query?: string) => void;
  /** What each Dot is doing right now (useDotLive) and what of it waits for the owner. */
  dotLive?: ReadonlyMap<string, DotLive>;
  /** Named teams, behind the Teams button in the footer. */
  teams?: SidebarTeams;
}

type Flyout = 'spaces' | 'teams';

/** Brands shown on the Apps button: apps owners connect most. Marks the app already bundles. */
const APP_MARKS = [
  ['gmail', 'Gmail'],
  ['google-calendar', 'Google Calendar'],
  ['github', 'GitHub'],
  ['notion', 'Notion'],
] as const;

/** Mission control's "navigate · Pricing" in a few plain words: "Opening website". */
function stepText(step: string): string {
  return COMPUTER_STEP_LABELS[step.split(' · ')[0]!] ?? 'Using its computer';
}

/** The line under a Dot's name: what it is doing, or its role while it is idle. */
export function dotStatus(
  dot: Dot,
  live?: DotLive,
): { text: string; tone: 'paused' | 'needs' | 'busy' | 'idle' } {
  if (dot.paused) return { text: 'Paused', tone: 'paused' };
  if (live?.state === 'needs-input')
    return { text: 'Needs you', tone: 'needs' };
  if (live?.state === 'working')
    return { text: live.step ? stepText(live.step) : 'Working', tone: 'busy' };
  return { text: roleLine(dot.instructions, 60), tone: 'idle' };
}

/**
 * A panel that opens above the footer for Spaces or Teams. Escape, the close button or a click
 * outside closes it; the first two hand focus back to the footer button that opened it.
 */
function FlyoutPanel({
  id,
  title,
  actionLabel,
  onAction,
  onClose,
  children,
}: {
  id: string;
  title: string;
  actionLabel: string;
  onAction: () => void;
  onClose: (restoreFocus: boolean) => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  // The sidebar re-renders on every live update: keep the latest callback without re-running
  // the effect below, which would move focus each time.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    panel.current
      ?.querySelector<HTMLElement>('.sb-flyout-body button')
      ?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      // Its own row menus are portalled to <body>: a click in one is not a click outside. A footer
      // button that opens a panel handles its own click (toggle, or switch panels).
      if (
        panel.current?.contains(target) ||
        target.closest?.('[data-flyout], .sb-menu')
      )
        return;
      close.current(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  return (
    <div
      ref={panel}
      id={id}
      className="sb-flyout"
      role="dialog"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        // Claimed here so the phone drawer's own Escape handler stays out of it.
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
      }}
    >
      <div className="sb-flyout-head">
        <h2 className="sb-flyout-title">{title}</h2>
        <button
          type="button"
          className="sb-icon"
          aria-label={actionLabel}
          title={actionLabel}
          onClick={onAction}
        >
          <Plus size={15} aria-hidden />
        </button>
        <button
          type="button"
          className="sb-icon"
          aria-label={`Close ${title}`}
          onClick={() => onClose(true)}
        >
          <X size={15} aria-hidden />
        </button>
      </div>
      <div className="sb-flyout-body">{children}</div>
    </div>
  );
}

function DotRow({
  dot,
  active,
  live,
  collapsed,
  configured,
  workspace,
  selectedThread,
  onChoose,
  onNewChat,
  onEdit,
  onTogglePause,
  onSelectThread,
  onRenameThread,
  onDeleteThreads,
  onExportThread,
}: {
  dot: Dot;
  active: boolean;
  live?: DotLive;
  collapsed: boolean;
  configured: boolean;
  workspace: WorkspaceState;
  selectedThread?: string;
  onChoose: () => void;
  onNewChat: () => void;
  onEdit: () => void;
  onTogglePause?: () => void;
  onSelectThread: (id: string) => void;
  onRenameThread: (id: string, title: string) => Promise<boolean>;
  onDeleteThreads: (ids: string[]) => Promise<boolean>;
  onExportThread: (id: string) => Promise<void>;
}) {
  // Every Dot's chats start hidden; the arrow shows them and the choice is remembered.
  const [open, setOpen] = useStoredFlag(
    `fulldots.sidebar.dot.${dot.id}`,
    false,
  );
  const status = dotStatus(dot, live);
  const waiting = live?.waiting ?? 0;
  const historyId = `sb-history-${dot.id}`;
  const label = [dot.name, status.text, waiting && `${waiting} waiting for you`]
    .filter(Boolean)
    .join(', ');
  return (
    <li className={`sb-dot-item ${open && !collapsed ? 'open' : ''}`}>
      <div className={`sb-row-wrap sb-dot-row ${active ? 'selected' : ''}`}>
        <button
          type="button"
          className="sb-icon sb-twisty"
          aria-expanded={open}
          // Only while the list exists: a reference to a missing id is an error for screen readers.
          aria-controls={open && !collapsed ? historyId : undefined}
          aria-label={`${open ? 'Hide' : 'Show'} ${dot.name}’s chats`}
          title={open ? 'Hide chats' : 'Show chats'}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight
            size={13}
            aria-hidden
            className={open ? 'turned' : ''}
          />
        </button>
        <button
          type="button"
          className={`sb-row sb-dot ${active ? 'active' : ''}`}
          aria-current={active ? 'page' : undefined}
          {...(collapsed ? { 'aria-label': label, title: label } : {})}
          onClick={onChoose}
        >
          <span className="sb-avatar">
            <Mascot
              identity={dot.id}
              {...dotLook(dot)}
              name={dot.name}
              small
              decorative
              {...(dot.paused
                ? { state: 'paused' }
                : live?.state
                  ? { state: live.state }
                  : {})}
            />
          </span>
          <span className="sb-dot-text sb-text">
            <span className="sb-text sb-dot-name">{dot.name}</span>
            {status.text && (
              <span className={`sb-text sb-dot-status ${status.tone}`}>
                {status.text}
              </span>
            )}
          </span>
          {waiting > 0 && (
            <span className="sb-count" aria-hidden>
              {waiting > 99 ? '99+' : waiting}
            </span>
          )}
          {waiting > 0 && !collapsed && (
            <span className="sb-sr">{`, ${waiting} waiting for you`}</span>
          )}
        </button>
        <RowMenu
          label={`${dot.name} options`}
          className="sb-row-more"
          items={[
            {
              id: 'chat',
              label: 'New chat',
              icon: <SquarePen size={14} aria-hidden />,
              onSelect: onNewChat,
            },
            {
              id: 'edit',
              label: 'Edit Dot',
              icon: <Pencil size={14} aria-hidden />,
              onSelect: onEdit,
            },
            {
              id: 'pause',
              label: dot.paused ? 'Resume Dot' : 'Pause Dot',
              icon: dot.paused ? (
                <Play size={14} aria-hidden />
              ) : (
                <Pause size={14} aria-hidden />
              ),
              onSelect: () => onTogglePause?.(),
            },
          ]}
        />
      </div>
      {open && !collapsed && (
        <ThreadList
          id={historyId}
          dotId={dot.id}
          chats={workspace.conversations}
          dots={workspace.dots}
          selectedId={selectedThread}
          newChatLabel={`New chat with ${dot.name}`}
          {...(configured ? { onNewChat } : {})}
          onSelect={onSelectThread}
          onRename={onRenameThread}
          onDelete={onDeleteThreads}
          onExport={onExportThread}
        />
      )}
    </li>
  );
}

export function Sidebar({
  workspace,
  dot,
  view,
  selectedThread,
  spaceId,
  pageId,
  fileId,
  taskCount,
  memoryCount,
  approvalCount = 0,
  configured,
  collapsed: collapsedPreference,
  onToggleCollapsed,
  mobileOpen,
  onDismissMobile,
  onHome,
  onNewChat,
  onChooseDot,
  onTogglePause,
  onSelectThread,
  onRenameThread,
  onDeleteThreads,
  onExportThread,
  onOpenPage,
  onOpenFile,
  onView,
  onDialog,
  onOpenPalette,
  dotLive,
  teams,
}: SidebarProps) {
  const phone = useMediaQuery(MOBILE_QUERY);
  const collapsed = collapsedPreference && !phone;
  const aside = useRef<HTMLElement>(null);
  const [flyout, setFlyout] = useState<Flyout>();
  const several = workspace.dots.length > 1;
  const live = dotLive ?? new Map<string, DotLive>();
  // Label helper: when text is hidden (slim mode) the button needs a name and a tooltip.
  const tip = (label: string) =>
    collapsed ? { 'aria-label': label, title: label } : {};

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

  const closeFlyout = (restoreFocus: boolean) => {
    const which = flyout;
    setFlyout(undefined);
    if (restoreFocus && which)
      aside.current
        ?.querySelector<HTMLElement>(`[data-flyout="${which}"]`)
        ?.focus();
  };
  const toggleFlyout = (which: Flyout) => {
    if (flyout === which) return closeFlyout(false);
    // The slim rail has no room for the panel: widen the sidebar first.
    if (collapsed) onToggleCollapsed();
    setFlyout(which);
  };
  // Going back to the slim rail closes the panel: it has no room there.
  useEffect(() => {
    if (collapsed) setFlyout(undefined);
  }, [collapsed]);

  // Up and Down move between the Dot rows.
  const dotKeys = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const target = event.target as HTMLElement;
    if (!target.classList.contains('sb-dot')) return;
    const rows = [
      ...(aside.current?.querySelectorAll<HTMLElement>('.sb-dots .sb-dot') ??
        []),
    ];
    const index = rows.indexOf(target);
    event.preventDefault();
    rows[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
  };

  const footButton = (
    label: string,
    icon: ReactNode,
    options: {
      title?: string;
      active?: boolean;
      badge?: number;
      badgeLabel?: string;
      /** Amber, like everything else that waits for the owner. */
      badgeNeeds?: boolean;
      flyout?: Flyout;
      keys?: string;
      onClick: () => void;
    },
  ) => (
    <button
      type="button"
      className={`sb-icon sb-foot-button ${options.active ? 'active' : ''}`}
      aria-label={label}
      title={options.title ?? label}
      aria-current={options.active ? 'page' : undefined}
      {...(options.flyout
        ? {
            'data-flyout': options.flyout,
            'aria-haspopup': 'dialog' as const,
            'aria-expanded': flyout === options.flyout,
            ...(flyout === options.flyout
              ? { 'aria-controls': `sb-flyout-${options.flyout}` }
              : {}),
          }
        : {})}
      {...(options.keys ? { 'aria-keyshortcuts': options.keys } : {})}
      onClick={options.onClick}
    >
      {icon}
      {!!options.badge && (
        <span
          className={`sb-badge${options.badgeNeeds ? ' needs' : ''}`}
          aria-label={options.badgeLabel}
        >
          {options.badge > 99 ? '99+' : options.badge}
        </span>
      )}
    </button>
  );

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
          <BrandMark size={24} />
          <span className="sb-text brand-word">
            Full<span className="brand-word-dots">Dots</span>
          </span>
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
          // The tooltip says which Dot; the slim rail also needs it as the name.
          title={`New chat with ${dot.name}`}
          {...tip(`New chat with ${dot.name}`)}
          onClick={() => onNewChat()}
        >
          {several ? (
            <span className="sb-new-avatar">
              <Mascot
                identity={dot.id}
                {...dotLook(dot)}
                name={dot.name}
                small
                decorative
              />
            </span>
          ) : (
            <SquarePen size={16} aria-hidden />
          )}
          <span className="sb-text">New chat</span>
        </button>
      </div>

      <div className="sb-body">
        <div className="sb-label-row">
          <h2 className="sb-label" id="sb-dots-label">
            Dots
          </h2>
          <button
            type="button"
            className="sb-icon"
            aria-label="Create Dot"
            title="Create Dot"
            onClick={() =>
              onDialog({ type: 'dot', spaceId: workspace.spaces[0].id })
            }
          >
            <Plus size={14} aria-hidden />
          </button>
        </div>
        <nav aria-labelledby="sb-dots-label">
          <ul className="sb-dots" onKeyDown={dotKeys}>
            {workspace.dots.map((item) => (
              <DotRow
                key={item.id}
                dot={item}
                active={dot.id === item.id && view === 'chat'}
                live={item.paused ? undefined : live.get(item.id)}
                collapsed={collapsed}
                configured={configured}
                workspace={workspace}
                selectedThread={view === 'chat' ? selectedThread : undefined}
                onChoose={() => onChooseDot(item)}
                onNewChat={() => onNewChat(item)}
                onEdit={() =>
                  onDialog({ type: 'dot', dot: item, spaceId: item.spaceId })
                }
                onTogglePause={() => onTogglePause?.(item)}
                onSelectThread={onSelectThread}
                onRenameThread={onRenameThread}
                onDeleteThreads={onDeleteThreads}
                onExportThread={onExportThread}
              />
            ))}
          </ul>
        </nav>
        {!configured && (
          <p className="sb-note sb-setup-note">
            Set up text chat to begin a persistent conversation.
          </p>
        )}
      </div>

      <div className="sb-foot">
        {flyout === 'spaces' && (
          <FlyoutPanel
            id="sb-flyout-spaces"
            title="Spaces"
            actionLabel="Create Space"
            onAction={() => {
              setFlyout(undefined);
              onDialog({ type: 'space' });
            }}
            onClose={closeFlyout}
          >
            <nav aria-label="Spaces" className="sb-list sb-spaces">
              {workspace.spaces.map((space) => (
                <SpaceNav
                  key={space.id}
                  space={space}
                  active={view === 'space' && spaceId === space.id}
                  pageId={pageId}
                  fileId={fileId}
                  onOpen={(id) => {
                    setFlyout(undefined);
                    onOpenPage(space.id, id);
                  }}
                  onOpenFile={(id) => {
                    setFlyout(undefined);
                    onOpenFile(space.id, id);
                  }}
                />
              ))}
            </nav>
          </FlyoutPanel>
        )}
        {flyout === 'teams' && teams && (
          <FlyoutPanel
            id="sb-flyout-teams"
            title="Teams"
            actionLabel="Create team"
            onAction={() => {
              setFlyout(undefined);
              teams.onCreate();
            }}
            onClose={closeFlyout}
          >
            <TeamRows
              {...teams}
              dots={workspace.dots}
              collapsed={false}
              onOpen={(team) => {
                setFlyout(undefined);
                teams.onOpen(team);
              }}
              onStartChat={(team) => {
                setFlyout(undefined);
                teams.onStartChat(team);
              }}
              onEdit={(team) => {
                setFlyout(undefined);
                teams.onEdit(team);
              }}
              onCreate={() => {
                setFlyout(undefined);
                teams.onCreate();
              }}
            />
          </FlyoutPanel>
        )}
        <nav className="sb-foot-icons" aria-label="Workspace">
          {onOpenPalette &&
            footButton('Search everywhere', <Search size={17} aria-hidden />, {
              title: `Search everywhere (${shortcutLabel()})`,
              keys: 'Control+K Meta+K',
              onClick: () => onOpenPalette(),
            })}
          {footButton(
            approvalCount > 0 ? `Inbox (${approvalCount})` : 'Inbox',
            <Inbox size={17} aria-hidden />,
            {
              title: 'Inbox',
              active: view === 'inbox',
              badge: approvalCount,
              badgeLabel: `${approvalCount} waiting for you`,
              badgeNeeds: true,
              onClick: () => onView('inbox'),
            },
          )}
          {footButton('Mission control', <LayoutGrid size={17} aria-hidden />, {
            active: view === 'mission',
            onClick: () => onView('mission'),
          })}
          {footButton('Spaces', <FolderOpen size={17} aria-hidden />, {
            active: view === 'space',
            flyout: 'spaces',
            onClick: () => toggleFlyout('spaces'),
          })}
          {teams &&
            footButton('Teams', <Users size={17} aria-hidden />, {
              active: view === 'team',
              flyout: 'teams',
              onClick: () => toggleFlyout('teams'),
            })}
          {footButton(
            'Scheduled and activity',
            <Clock3 size={17} aria-hidden />,
            {
              title: 'Scheduled & activity',
              active: view === 'tasks',
              badge: taskCount,
              badgeLabel: `${taskCount} tasks`,
              onClick: () => onView('tasks'),
            },
          )}
          {footButton(
            `Memories (${memoryCount})`,
            <BookOpen size={17} aria-hidden />,
            {
              active: view === 'memories',
              onClick: () => onView('memories'),
            },
          )}
        </nav>
        <div className="sb-foot-buttons">
          <button
            type="button"
            className="sb-foot-wide"
            {...tip('Settings and setup')}
            onClick={() => onDialog({ type: 'settings' })}
          >
            <Settings2 size={16} aria-hidden />
            <span className="sb-text">Settings</span>
          </button>
          <button
            type="button"
            className="sb-foot-wide sb-apps"
            title={`Connect apps: ${APP_MARKS.map(([, name]) => name).join(', ')} and more`}
            {...tip('Connected apps')}
            onClick={() => onDialog({ type: 'settings', tab: 'connectors' })}
          >
            {/* The slim rail has room for one icon; the logos need the full width. */}
            <Plug size={16} aria-hidden className="sb-apps-plug" />
            <span className="sb-app-logos" aria-hidden>
              {APP_MARKS.map(([id]) => (
                <span className="sb-app-logo" key={id}>
                  <ConnectorLogo presetId={id} size={18} />
                </span>
              ))}
            </span>
            <span className="sb-text">Apps</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
