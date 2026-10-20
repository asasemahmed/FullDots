import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  Bookmark,
  Clock3,
  CornerDownLeft,
  FileText,
  FolderPlus,
  MessageSquare,
  Pause,
  Play,
  Plus,
  Search,
  Settings2,
  Inbox,
  LayoutGrid,
  SquarePen,
  Users,
  UsersRound,
  MessageSquarePlus,
  type LucideIcon,
} from 'lucide-react';
import { SEARCH_QUERY_MAX } from '../../shared/search';
import { api } from '../api';
import { BrandMark } from '../DotCharacter';
import { Mascot } from '../Mascot';
import { idleSearch, type SearchState } from './debounced-search';
import {
  buildActions,
  buildGroups,
  dispatchTarget,
  handlePaletteKey,
  highlightParts,
  highlightTerms,
  optionDomId,
  recentItems,
  resolveActive,
  shortcutLabel,
  type PaletteHandlers,
  type PaletteIcon,
  type PaletteItem,
  type PaletteWorkspace,
  type RecentEntry,
} from './palette-model';
import { usePaletteSearch } from './useCommandPalette';
import './palette.css';

const LIST_ID = 'pal-listbox';
const ICONS: Record<PaletteIcon, LucideIcon> = {
  chat: MessageSquare,
  page: FileText,
  prompt: Bookmark,
  dot: SquarePen,
  'new-chat': SquarePen,
  'create-dot': Plus,
  team: Users,
  'create-team': UsersRound,
  'team-chat': MessageSquarePlus,
  'create-space': FolderPlus,
  settings: Settings2,
  approvals: Inbox,
  mission: LayoutGrid,
  scheduled: Clock3,
  pause: Pause,
  resume: Play,
};

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Text to start with (the sidebar box hands over what was typed there). */
  initialQuery?: string;
  workspace: PaletteWorkspace;
  currentDotId?: string;
  /** Chats cannot start until the model is set up. */
  configured: boolean;
  recents?: RecentEntry[];
  handlers: PaletteHandlers;
  /** Starting search state; the server render uses it to show results. */
  initialSearch?: SearchState;
}

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlightParts(text, terms).map((part, index) =>
        part.match ? (
          <mark key={index}>{part.text}</mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** Titles of recently opened pages that were stored without one. */
function useRecentPageTitles(recents: RecentEntry[]) {
  const [titles, setTitles] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    for (const entry of recents)
      if (entry.kind === 'page' && !entry.title)
        void api<{ title: string }>(
          `/spaces/${entry.spaceId}/pages/${entry.id}`,
        )
          .then((page) => {
            if (active)
              setTitles((known) => ({ ...known, [entry.id]: page.title }));
          })
          .catch(() => {});
    return () => {
      active = false;
    };
  }, [recents]);
  return titles;
}

function PaletteDialog({
  onClose,
  initialQuery = '',
  workspace,
  currentDotId,
  configured,
  recents = [],
  handlers,
  initialSearch = idleSearch,
}: CommandPaletteProps) {
  const [query, setQuery] = useState(initialQuery);
  const [activeId, setActiveId] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const search = usePaletteSearch(query, initialSearch);
  const pageTitles = useRecentPageTitles(recents);
  const actions = useMemo(
    () =>
      buildActions({
        dots: workspace.dots,
        currentDotId,
        configured,
        ...(workspace.teams ? { teams: workspace.teams } : {}),
      }),
    [workspace.dots, workspace.teams, currentDotId, configured],
  );
  const recentRows = useMemo(
    () => recentItems(recents, workspace, pageTitles),
    [recents, workspace, pageTitles],
  );
  const groups = useMemo(
    () =>
      buildGroups({
        query,
        results: search.results,
        workspace,
        actions,
        recents: recentRows,
      }),
    [query, search.results, workspace, actions, recentRows],
  );
  const active = resolveActive(groups, activeId);
  const count = groups.reduce((sum, group) => sum + group.items.length, 0);

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    input.current?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    if (active)
      document
        .getElementById(optionDomId(active))
        ?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const choose = (item: PaletteItem) => {
    onClose();
    dispatchTarget(item.target, handlers);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const result = handlePaletteKey(groups, active, {
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      isComposing: event.nativeEvent.isComposing,
    });
    if (!result.handled) return;
    event.preventDefault();
    if (result.close) {
      event.stopPropagation();
      onClose();
    } else if (result.choose) choose(result.choose);
    else setActiveId(result.activeId);
  };

  const typed = query.trim();
  const terms = (item: PaletteItem) =>
    highlightTerms(
      search.resultsFor && item.group !== 'action' ? search.resultsFor : typed,
      item,
    );
  const status = search.loading
    ? 'Searching…'
    : count
      ? `${count} ${count === 1 ? 'result' : 'results'}`
      : typed
        ? 'No results'
        : '';

  return (
    <div
      className="pal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="pal"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="pal-input-row">
          <span className="pal-brand" aria-hidden="true">
            <BrandMark size={22} />
          </span>
          <input
            ref={input}
            className="pal-input"
            type="text"
            role="combobox"
            aria-label="Search chats, pages, Dots and actions"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={count > 0}
            aria-controls={LIST_ID}
            aria-activedescendant={active ? optionDomId(active) : undefined}
            placeholder="Search, or jump to anything…"
            autoComplete="off"
            spellCheck={false}
            maxLength={SEARCH_QUERY_MAX}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="pal-key">Esc</kbd>
        </div>
        {search.error && (
          <p className="pal-note" role="status">
            Search is unavailable right now. Actions still work.
          </p>
        )}
        <div className="pal-results">
          <div id={LIST_ID} role="listbox" aria-label="Results">
            {groups.map((group) => (
              <div
                key={group.id}
                role="group"
                aria-labelledby={`pal-group-${group.id}`}
                className="pal-group"
              >
                <div className="pal-group-label" id={`pal-group-${group.id}`}>
                  {group.label}
                </div>
                {group.items.map((item) => {
                  const Icon = ICONS[item.icon];
                  const isActive = item.id === active;
                  return (
                    <div
                      key={item.id}
                      id={optionDomId(item.id)}
                      role="option"
                      aria-selected={isActive}
                      className={`pal-item${isActive ? ' active' : ''}`}
                      onMouseMove={() => {
                        if (!isActive) setActiveId(item.id);
                      }}
                      // Keep the focus in the input so the keyboard keeps working.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => choose(item)}
                    >
                      <span className="pal-lead" aria-hidden="true">
                        {item.dotId && item.group !== 'action' ? (
                          <Mascot identity={item.dotId} small decorative />
                        ) : (
                          <Icon size={16} />
                        )}
                      </span>
                      <span className="pal-text">
                        <span className="pal-title">
                          <Highlight text={item.title} terms={terms(item)} />
                        </span>
                        {item.snippet && (
                          <span className="pal-snippet">
                            <Highlight
                              text={item.snippet}
                              terms={terms(item)}
                            />
                          </span>
                        )}
                      </span>
                      {item.subtitle && (
                        <span className="pal-sub">{item.subtitle}</span>
                      )}
                      {isActive && (
                        <CornerDownLeft
                          className="pal-enter"
                          size={14}
                          aria-hidden="true"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {!count && (
            <div className="pal-empty">
              <Mascot
                hero
                name="Dot"
                state={search.loading ? 'working' : 'idle'}
                decorative
              />
              {typed ? (
                <>
                  <strong>
                    {search.loading
                      ? 'Looking around…'
                      : `Nothing found for “${typed}”`}
                  </strong>
                  <span>
                    Search matches the exact letters you type, so try fewer
                    words.
                  </span>
                </>
              ) : (
                <>
                  <strong>Where to?</strong>
                  <span>
                    Type to search chats, messages, pages, Dots and prompts.
                  </span>
                </>
              )}
            </div>
          )}
        </div>
        <div className="pal-foot" aria-hidden="true">
          <span>
            <kbd className="pal-key">↑</kbd>
            <kbd className="pal-key">↓</kbd> move
          </span>
          <span>
            <kbd className="pal-key">↵</kbd> open
          </span>
          <span>
            <kbd className="pal-key">Tab</kbd> next group
          </span>
          <span className="pal-foot-end">
            <Search size={12} /> {shortcutLabel()} toggles
          </span>
        </div>
        <div className="pal-sr" role="status" aria-live="polite">
          {status}
        </div>
      </div>
    </div>
  );
}

/** The Ctrl+K command palette: search everything, jump anywhere, run an action. */
export function CommandPalette(props: CommandPaletteProps) {
  if (!props.open) return null;
  return <PaletteDialog {...props} />;
}
