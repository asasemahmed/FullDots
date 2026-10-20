import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: () => ({}),
}));
import { CommandPalette } from '../src/client/palette/CommandPalette';
import { PromptsSettings } from '../src/client/palette/PromptsSettings';
import { WorkspaceDialog } from '../src/client/WorkspaceDialog';
import { Sidebar } from '../src/client/sidebar/Sidebar';
import {
  SEARCH_DEBOUNCE_MS,
  createSearchRunner,
  idleSearch,
  type SearchState,
} from '../src/client/palette/debounced-search';
import {
  buildActions,
  buildGroups,
  dispatchTarget,
  flatItems,
  handlePaletteKey,
  highlightParts,
  isPaletteShortcut,
  jumpGroup,
  moveActive,
  optionDomId,
  recentItems,
  resolveActive,
  resultToItem,
  shortcutLabel,
  type PaletteGroup,
  type PaletteHandlers,
  type PaletteItem,
  type PaletteWorkspace,
} from '../src/client/palette/palette-model';
import { addRecent } from '../src/client/palette/recents';
import type { SearchResult } from '../src/shared/search';
import type { Prompt } from '../src/shared/prompts';
import type {
  ConversationSummary,
  Dot,
  Space,
  State,
  WorkspaceState,
} from '../src/shared/types';

const dot = (id: string, name: string, paused = false): Dot => ({
  id,
  spaceId: 'space-1',
  spaceIds: ['space-1'],
  name,
  instructions: 'Help',
  researchAllowed: true,
  memoryAllowed: true,
  createdAt: 1,
  paused,
});
const space: Space = {
  id: 'space-1',
  name: 'Everyday',
  description: '',
  createdAt: 1,
};
const chat = (
  id: string,
  title: string,
  dotId = 'dot-1',
): ConversationSummary => ({
  id,
  dotId,
  ownerId: 'owner',
  title,
  createdAt: 1,
  updatedAt: 2,
  empty: false,
});
const workspace: PaletteWorkspace = {
  dots: [dot('dot-1', 'Scout'), dot('dot-2', 'Writer', true)],
  spaces: [space],
  conversations: [chat('t1', 'Falcon launch'), chat('t2', 'Budget')],
};
const hit = (
  type: SearchResult['type'],
  id: string,
  title: string,
  extra: Partial<SearchResult> = {},
): SearchResult => ({
  type,
  id,
  title,
  snippet: '',
  updatedAt: 1,
  ...extra,
});
const results: SearchResult[] = [
  hit('chat', 't1', 'Falcon launch', { threadId: 't1', dotId: 'dot-1' }),
  hit('message', 'm1', 'Budget', {
    threadId: 't2',
    dotId: 'dot-1',
    snippet: '…talked about the falcon budget…',
  }),
  hit('page', 'p1', 'Falcon notes', { spaceId: 'space-1' }),
  hit('dot', 'dot-2', 'Falcon keeper', { dotId: 'dot-2' }),
  hit('prompt', 'pr1', 'Falcon prompt', { snippet: 'Describe the falcon' }),
];
const handlers: PaletteHandlers = {
  openThread: vi.fn(),
  openPage: vi.fn(),
  openDot: vi.fn(),
  usePrompt: vi.fn(),
  runAction: vi.fn(),
};
const searched = (query: string, found: SearchResult[]): SearchState => ({
  loading: false,
  resultsFor: query,
  results: found,
  error: '',
});

function render(
  props: Partial<Parameters<typeof CommandPalette>[0]> = {},
): string {
  return renderToStaticMarkup(
    <CommandPalette
      open
      onClose={() => {}}
      workspace={workspace}
      currentDotId="dot-1"
      configured
      handlers={handlers}
      {...props}
    />,
  );
}

afterEach(() => vi.clearAllMocks());

describe('palette markup', () => {
  it('renders nothing while closed', () => {
    expect(render({ open: false })).toBe('');
  });

  it('is a modal dialog with a combobox that controls a listbox of options', () => {
    const html = render({
      initialQuery: 'falcon',
      initialSearch: searched('falcon', results),
    });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/<input[^>]*role="combobox"/);
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="pal-listbox"');
    expect(html).toContain('id="pal-listbox"');
    expect(html).toContain('role="listbox"');
    expect(html.match(/role="option"/g)!.length).toBeGreaterThanOrEqual(5);
    // Results are grouped, and groups are labelled.
    expect(html).toContain('role="group"');
    for (const label of ['Chats', 'Messages', 'Pages', 'Dots', 'Prompts'])
      expect(html).toContain(`>${label}<`);
    // No action is called "falcon", so that group stays out.
    expect(html).not.toContain('>Actions<');
    expect(html.indexOf('>Chats<')).toBeLessThan(html.indexOf('>Messages<'));
    expect(html.indexOf('>Dots<')).toBeLessThan(html.indexOf('>Prompts<'));
  });

  it('points aria-activedescendant at the single selected option', () => {
    const html = render({
      initialQuery: 'falcon',
      initialSearch: searched('falcon', results),
    });
    const active = html.match(/aria-activedescendant="([^"]+)"/)?.[1];
    expect(active).toBe(optionDomId('chat:t1'));
    expect(html).toContain(`id="${active}"`);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toMatch(
      new RegExp(`id="${active}" role="option" aria-selected="true"`),
    );
  });

  it('highlights the matched text in titles and snippets', () => {
    const html = render({
      initialQuery: 'falcon',
      initialSearch: searched('falcon', results),
    });
    expect(html).toContain('<mark>Falcon</mark>');
    expect(html).toContain('<mark>falcon</mark>');
  });

  it('shows recent chats and a few actions when the query is empty', () => {
    const html = render({
      recents: [
        { kind: 'chat', id: 't2' },
        { kind: 'chat', id: 'gone' },
        { kind: 'page', id: 'p1', spaceId: 'space-1', title: 'Falcon notes' },
      ],
    });
    expect(html).toContain('>Recent<');
    expect(html).toContain('Budget');
    expect(html).toContain('Falcon notes');
    expect(html).not.toContain('gone');
    expect(html).toContain('>Actions<');
    expect(html).toContain('New chat with Scout');
    expect(html).toContain('Create Dot');
    expect(html).not.toContain('>Chats<');
  });

  it('offers a friendly empty state and a live status', () => {
    const html = render({
      initialQuery: 'zzz',
      initialSearch: searched('zzz', []),
    });
    expect(html).toContain('Nothing found for “zzz”');
    expect(html).toContain('role="status"');
    expect(html).toContain('No results');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('aria-activedescendant');
  });

  it('keeps New chat out of the list until setup is done', () => {
    expect(render({ configured: false })).not.toContain('New chat with');
  });
});

describe('palette model', () => {
  const groups = (): PaletteGroup[] =>
    buildGroups({
      query: 'falcon',
      results,
      workspace,
      actions: buildActions({
        dots: workspace.dots,
        currentDotId: 'dot-1',
        configured: true,
      }),
      recents: [],
    });

  it('orders groups Chats, Messages, Pages, Dots, Prompts, Actions', () => {
    const typed = buildGroups({
      query: 'o',
      results,
      workspace,
      actions: buildActions({
        dots: workspace.dots,
        currentDotId: 'dot-1',
        configured: true,
      }),
      recents: [],
    });
    expect(typed.map((group) => group.id)).toEqual([
      'chat',
      'message',
      'page',
      'dot',
      'prompt',
      'action',
    ]);
  });

  it('builds actions with the current Dot first and Pause or Resume per Dot', () => {
    const titles = buildActions({
      dots: workspace.dots,
      currentDotId: 'dot-2',
      configured: true,
    }).map((item) => item.title);
    expect(titles[0]).toBe('New chat with Writer');
    expect(titles).toEqual(
      expect.arrayContaining([
        'Create Dot',
        'Create Space',
        'Open Settings',
        'Open Inbox',
        'Open Mission control',
        'Scheduled and activity',
        'New chat with Scout',
        'Resume Writer',
        'Pause Scout',
      ]),
    );
    expect(titles).not.toContain('Pause Writer');
    expect(titles).not.toContain('Resume Scout');
  });

  it('filters actions by every typed word', () => {
    const actions = buildActions({
      dots: workspace.dots,
      currentDotId: 'dot-1',
      configured: true,
    });
    const found = buildGroups({
      query: 'pause scout',
      results: [],
      workspace,
      actions,
      recents: [],
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.items.map((item) => item.title)).toEqual(['Pause Scout']);
    expect(
      buildGroups({
        query: 'new chat writer',
        results: [],
        workspace,
        actions,
        recents: [],
      })[0]!.items.map((item) => item.title),
    ).toEqual(['New chat with Writer']);
  });

  it('maps results to rows and ignores types it does not know', () => {
    expect(resultToItem(results[2]!, workspace)).toMatchObject({
      group: 'page',
      subtitle: 'Everyday',
      target: { kind: 'page', spaceId: 'space-1', pageId: 'p1' },
    });
    expect(resultToItem(results[1]!, workspace)).toMatchObject({
      group: 'message',
      subtitle: 'Scout',
      target: { kind: 'chat', threadId: 't2' },
    });
    expect(
      resultToItem(
        { ...hit('page', 'x', 'No space'), spaceId: undefined },
        workspace,
      ),
    ).toBeUndefined();
    expect(
      resultToItem(
        { ...hit('chat', 'x', 'Widget'), type: 'widget' as never },
        workspace,
      ),
    ).toBeUndefined();
  });

  it('drops recent chats that were deleted and pages without a title', () => {
    const items = recentItems(
      [
        { kind: 'chat', id: 't1' },
        { kind: 'chat', id: 'deleted' },
        { kind: 'page', id: 'p1', spaceId: 'space-1' },
        { kind: 'page', id: 'p2', spaceId: 'space-1' },
      ],
      workspace,
      { p2: 'Resolved title' },
    );
    expect(items.map((item) => item.title)).toEqual([
      'Falcon launch',
      'Resolved title',
    ]);
  });

  it('splits text into highlighted runs without regex surprises', () => {
    expect(highlightParts('Falcon and falcon', ['falcon'])).toEqual([
      { text: 'Falcon', match: true },
      { text: ' and ', match: false },
      { text: 'falcon', match: true },
    ]);
    expect(highlightParts('cost (50%) [a+b]', ['(50%)', 'a+b'])).toEqual([
      { text: 'cost ', match: false },
      { text: '(50%)', match: true },
      { text: ' [', match: false },
      { text: 'a+b', match: true },
      { text: ']', match: false },
    ]);
    expect(highlightParts('plain', [])).toEqual([
      { text: 'plain', match: false },
    ]);
    expect(highlightParts('', ['x'])).toEqual([{ text: '', match: false }]);
  });

  it('gives every option its own DOM id, even for odd characters', () => {
    const ids = ['chat:a b', 'chat:a_b', 'chat:a:b', 'chat:a-b', 'page:é'];
    const dom = ids.map(optionDomId);
    expect(new Set(dom).size).toBe(ids.length);
    for (const id of dom) expect(id).toMatch(/^pal-opt-[A-Za-z0-9_-]+$/);
  });

  it('sends each kind of row to the right handler', () => {
    const items = flatItems(groups());
    for (const item of items.slice(0, 5)) dispatchTarget(item.target, handlers);
    expect(handlers.openThread).toHaveBeenCalledWith('t1', 'dot-1');
    expect(handlers.openThread).toHaveBeenCalledWith('t2', 'dot-1');
    expect(handlers.openPage).toHaveBeenCalledWith('space-1', 'p1');
    expect(handlers.openDot).toHaveBeenCalledWith('dot-2');
    expect(handlers.usePrompt).toHaveBeenCalledWith('pr1', undefined);
    dispatchTarget({ kind: 'action', action: { type: 'settings' } }, handlers);
    expect(handlers.runAction).toHaveBeenCalledWith({ type: 'settings' });
  });
});

describe('palette keyboard', () => {
  const build = (): PaletteGroup[] => [
    {
      id: 'chat',
      label: 'Chats',
      items: [item('chat', 'a'), item('chat', 'b')],
    },
    { id: 'page', label: 'Pages', items: [item('page', 'c')] },
    {
      id: 'action',
      label: 'Actions',
      items: [item('action', 'd'), item('action', 'e')],
    },
  ];
  function item(group: PaletteItem['group'], id: string): PaletteItem {
    return {
      id: `${group}:${id}`,
      group,
      title: id,
      icon: 'chat',
      target: { kind: 'dot', dotId: id },
    };
  }
  const press = (
    activeId: string | undefined,
    key: string,
    extra: Record<string, boolean> = {},
  ) => handlePaletteKey(build(), activeId, { key, ...extra });

  it('starts on the first item and keeps a still-listed selection', () => {
    expect(resolveActive(build(), undefined)).toBe('chat:a');
    expect(resolveActive(build(), 'action:e')).toBe('action:e');
    expect(resolveActive(build(), 'gone')).toBe('chat:a');
    expect(resolveActive([], undefined)).toBeUndefined();
  });

  it('moves with the arrow keys and wraps at both ends', () => {
    expect(press(undefined, 'ArrowDown').activeId).toBe('chat:b');
    expect(press('chat:b', 'ArrowDown').activeId).toBe('page:c');
    expect(press('action:e', 'ArrowDown').activeId).toBe('chat:a');
    expect(press('chat:a', 'ArrowUp').activeId).toBe('action:e');
    expect(press('page:c', 'ArrowUp').activeId).toBe('chat:b');
    expect(moveActive(build(), 'zzz', 1)).toBe('chat:a');
    expect(moveActive(build(), 'zzz', -1)).toBe('action:e');
    expect(moveActive([], undefined, 1)).toBeUndefined();
    expect(press('chat:a', 'ArrowDown')).toMatchObject({ handled: true });
  });

  it('cycles through the groups with Tab and Shift+Tab', () => {
    expect(press('chat:b', 'Tab').activeId).toBe('page:c');
    expect(press('page:c', 'Tab').activeId).toBe('action:d');
    expect(press('action:e', 'Tab').activeId).toBe('chat:a');
    expect(press('chat:a', 'Tab', { shiftKey: true }).activeId).toBe(
      'action:d',
    );
    expect(press('action:e', 'Tab', { shiftKey: true }).activeId).toBe(
      'page:c',
    );
    expect(jumpGroup(build(), undefined, 1)).toBe('chat:a');
    // Tab is always handled so focus never leaves the palette.
    expect(handlePaletteKey([], undefined, { key: 'Tab' })).toEqual({
      handled: true,
      activeId: undefined,
    });
  });

  it('chooses the active item on Enter and closes on Escape', () => {
    expect(press('page:c', 'Enter').choose?.id).toBe('page:c');
    expect(press(undefined, 'Enter').choose?.id).toBe('chat:a');
    expect(handlePaletteKey([], undefined, { key: 'Enter' })).toEqual({
      handled: true,
      activeId: undefined,
    });
    expect(press('chat:a', 'Escape')).toMatchObject({
      handled: true,
      close: true,
    });
  });

  it('leaves typing, shortcuts and IME input alone', () => {
    expect(press('chat:a', 'a').handled).toBe(false);
    expect(press('chat:a', 'Backspace').handled).toBe(false);
    expect(press('chat:a', 'Enter', { ctrlKey: true }).handled).toBe(false);
    expect(press('chat:a', 'ArrowDown', { altKey: true }).handled).toBe(false);
    expect(press('chat:a', 'Enter', { isComposing: true }).handled).toBe(false);
    expect(press('chat:a', 'Escape', { isComposing: true }).handled).toBe(
      false,
    );
  });

  it('recognises Ctrl+K and Cmd+K, but not when the page already used the key', () => {
    const key = {
      key: 'k',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    };
    expect(isPaletteShortcut(key)).toBe(true);
    expect(isPaletteShortcut({ ...key, key: 'K' })).toBe(true);
    expect(isPaletteShortcut({ ...key, ctrlKey: false, metaKey: true })).toBe(
      true,
    );
    expect(isPaletteShortcut({ ...key, ctrlKey: false })).toBe(false);
    expect(isPaletteShortcut({ ...key, shiftKey: true })).toBe(false);
    expect(isPaletteShortcut({ ...key, altKey: true })).toBe(false);
    expect(isPaletteShortcut({ ...key, key: 'j' })).toBe(false);
    expect(isPaletteShortcut({ ...key, defaultPrevented: true })).toBe(false);
    expect(shortcutLabel('MacIntel')).toBe('⌘K');
    expect(shortcutLabel('Win32')).toBe('Ctrl K');
  });
});

describe('recent items', () => {
  it('keeps the newest first, drops repeats and stays short', () => {
    let list = addRecent([], { kind: 'chat', id: 'a' }, 3);
    list = addRecent(list, { kind: 'page', id: 'a', spaceId: 's' }, 3);
    list = addRecent(list, { kind: 'chat', id: 'b' }, 3);
    list = addRecent(list, { kind: 'chat', id: 'a' }, 3);
    expect(list.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
      'chat:a',
      'chat:b',
      'page:a',
    ]);
    expect(addRecent(list, { kind: 'chat', id: 'z' }, 3)).toHaveLength(3);
  });
});

describe('debounced search', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function harness(
    fetcher: (query: string, signal: AbortSignal) => Promise<SearchResult[]>,
  ) {
    let state: SearchState = idleSearch;
    const runner = createSearchRunner({
      fetcher,
      onState: (update) => {
        state = update(state);
      },
    });
    return { runner, state: () => state };
  }

  it('waits 150 ms after the last keystroke and searches once', async () => {
    const fetcher = vi.fn(async (query: string) => [
      hit('page', query, `Page ${query}`, { spaceId: 's' }),
    ]);
    const { runner, state } = harness(fetcher);
    expect(SEARCH_DEBOUNCE_MS).toBe(150);
    runner.search('f');
    vi.advanceTimersByTime(100);
    runner.search('fa');
    vi.advanceTimersByTime(100);
    runner.search(' fal ');
    expect(state().loading).toBe(true);
    vi.advanceTimersByTime(149);
    expect(fetcher).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe('fal');
    await vi.runAllTimersAsync();
    expect(state()).toMatchObject({
      loading: false,
      resultsFor: 'fal',
      error: '',
    });
    expect(state().results.map((result) => result.id)).toEqual(['fal']);
  });

  it('never shows the answer to an older query', async () => {
    let release!: (value: SearchResult[]) => void;
    const slow = new Promise<SearchResult[]>((resolve) => (release = resolve));
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(slow)
      .mockResolvedValueOnce([hit('dot', 'new', 'New answer')]);
    const { runner, state } = harness(fetcher);
    runner.search('old');
    vi.advanceTimersByTime(150);
    const signal = fetcher.mock.calls[0]![1] as AbortSignal;
    runner.search('newer');
    expect(signal.aborted).toBe(true);
    vi.advanceTimersByTime(150);
    await vi.runAllTimersAsync();
    release([hit('dot', 'old', 'Old answer')]);
    await vi.runAllTimersAsync();
    expect(state().results.map((result) => result.title)).toEqual([
      'New answer',
    ]);
    expect(state().resultsFor).toBe('newer');
  });

  it('clears on an empty query without asking the server', async () => {
    const fetcher = vi.fn(async () => [hit('dot', 'a', 'A')]);
    const { runner, state } = harness(fetcher);
    runner.search('a');
    await vi.runAllTimersAsync();
    expect(state().results).toHaveLength(1);
    runner.search('   ');
    expect(state()).toEqual(idleSearch);
    await vi.runAllTimersAsync();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the old rows while loading and reports failures', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce([hit('dot', 'a', 'A')])
      .mockRejectedValueOnce(new Error('Search is down.'));
    const { runner, state } = harness(fetcher);
    runner.search('a');
    await vi.runAllTimersAsync();
    runner.search('ab');
    expect(state()).toMatchObject({ loading: true });
    expect(state().results).toHaveLength(1);
    await vi.runAllTimersAsync();
    expect(state()).toMatchObject({ loading: false, error: 'Search is down.' });
    expect(state().results).toHaveLength(1);
    runner.cancel();
  });
});

describe('sidebar entry point', () => {
  const state = (onOpenPalette?: () => void) =>
    renderToStaticMarkup(
      <Sidebar
        workspace={
          {
            spaces: [space],
            dots: workspace.dots,
            conversations: workspace.conversations,
            calls: [],
            setup: { missing: [] },
          } as unknown as WorkspaceState
        }
        dot={workspace.dots[0]!}
        view="chat"
        spaceId=""
        taskCount={0}
        memoryCount={0}
        configured
        collapsed={false}
        onToggleCollapsed={() => {}}
        mobileOpen={false}
        onDismissMobile={() => {}}
        onHome={() => {}}
        onNewChat={() => {}}
        onChooseDot={() => {}}
        onSelectThread={() => {}}
        onRenameThread={async () => true}
        onDeleteThreads={async () => true}
        onExportThread={async () => {}}
        onOpenPage={() => {}}
        onOpenFile={() => {}}
        onView={() => {}}
        onDialog={() => {}}
        onOpenPalette={onOpenPalette}
      />,
    );

  it('keeps the title filter and adds a Search everywhere button with the shortcut', () => {
    const html = state(() => {});
    expect(html).toContain('placeholder="Search chats"');
    expect(html).toContain('Search everywhere');
    expect(html).toContain('aria-keyshortcuts="Control+K Meta+K"');
    expect(html).toMatch(/<kbd[^>]*>(Ctrl K|⌘K)<\/kbd>/);
  });

  it('is unchanged when no palette is wired in', () => {
    const html = state();
    expect(html).not.toContain('Search everywhere');
    expect(html).toContain('aria-label="Search chats"');
  });
});

describe('prompts settings', () => {
  const prompt = (
    id: string,
    title: string,
    dotId: string | null = null,
  ): Prompt => ({
    id,
    title,
    body: `Body of ${title}`,
    scope: dotId ? 'dot' : 'global',
    dotId,
    teamId: null,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
  });

  it('lists prompts with edit and archive buttons and their scope', () => {
    const html = renderToStaticMarkup(
      <PromptsSettings
        dots={workspace.dots}
        initial={[prompt('1', 'Weekly review'), prompt('2', 'Edit', 'dot-2')]}
      />,
    );
    expect(html).toContain('Weekly review');
    expect(html).toContain('Every Dot');
    expect(html).toContain('Writer');
    expect(html).toContain('aria-label="Edit Weekly review"');
    expect(html).toContain('aria-label="Archive Weekly review"');
    expect(html).toContain('New prompt');
  });

  it('explains an empty list', () => {
    const html = renderToStaticMarkup(
      <PromptsSettings dots={workspace.dots} initial={[]} />,
    );
    expect(html).toContain('No saved prompts yet.');
  });

  it('is a tab of the settings dialog', () => {
    const html = renderToStaticMarkup(
      <WorkspaceDialog
        dialog={{ type: 'settings', tab: 'prompts' }}
        state={{ settings: {} } as unknown as State}
        workspace={
          {
            spaces: [space],
            dots: workspace.dots,
            setup: { missing: [] },
          } as unknown as WorkspaceState
        }
        onClose={() => {}}
        mutate={async () => true}
      />,
    );
    expect(html).toMatch(/id="settings-tab-prompts"[^>]*aria-selected="true"/);
    expect(html).toContain('id="settings-panel-prompts"');
    expect(html).toContain('Saved prompts');
  });
});
