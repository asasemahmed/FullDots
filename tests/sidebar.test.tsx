import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({ api: vi.fn(), authHeaders: () => ({}) }));
import {
  chatGroupFor,
  chatRecency,
  chatWhen,
  filterChats,
  latestChat,
  listableChats,
  newestFirst,
} from '../src/client/sidebar/chat-groups';
import { HISTORY_LIMIT, ThreadList } from '../src/client/ThreadList';
import { Sidebar, dotStatus } from '../src/client/sidebar/Sidebar';
import { liveDots, type DotLive } from '../src/client/sidebar/useDotLive';
import type {
  ConversationSummary,
  Dot,
  WorkspaceState,
} from '../src/shared/types';

// Wednesday 2026-10-14, 15:30 local time.
const now = new Date(2026, 9, 14, 15, 30).getTime();
const daysAgo = (days: number, hour = 9) =>
  new Date(2026, 9, 14 - days, hour, 0).getTime();
function chat(
  id: string,
  title: string,
  createdAt: number,
  extra: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id,
    dotId: 'dot-1',
    ownerId: 'owner',
    title,
    createdAt,
    updatedAt: null,
    empty: false,
    ...extra,
  };
}
const dot = (id: string, name: string): Dot => ({
  id,
  spaceId: 'space-1',
  spaceIds: ['space-1'],
  name,
  instructions: 'Help',
  researchAllowed: true,
  memoryAllowed: true,
  createdAt: 1,
});

it('sorts chats newest first by last activity', () => {
  const chats = [
    chat('old', 'Ancient', daysAgo(90)),
    chat('revived', 'Revived', daysAgo(60), { updatedAt: daysAgo(0, 8) }),
    chat('today-late', 'Late today', daysAgo(0, 14)),
    chat('yesterday', 'Last night', daysAgo(1, 23)),
  ];
  expect(newestFirst(chats).map((item) => item.id)).toEqual([
    'today-late',
    'revived',
    'yesterday',
    'old',
  ]);
  expect(chats[0]!.id).toBe('old');
});

it('labels a chat row with the time today, then Yesterday, a weekday and a date', () => {
  const today = daysAgo(0, 9);
  expect(chatWhen(today, now)).toBe(
    new Date(today).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }),
  );
  expect(chatWhen(daysAgo(1), now)).toBe('Yesterday');
  const weekday = (time: number) =>
    new Date(time).toLocaleDateString(undefined, { weekday: 'short' });
  expect(chatWhen(daysAgo(3), now)).toBe(weekday(daysAgo(3)));
  expect(chatWhen(daysAgo(6), now)).toBe(weekday(daysAgo(6)));
  // A week ago has today's weekday name: it gets a date instead.
  expect(chatWhen(daysAgo(7), now)).toBe(
    new Date(daysAgo(7)).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    }),
  );
  const lastYear = new Date(2025, 4, 2).getTime();
  expect(chatWhen(lastYear, now)).toBe(
    new Date(lastYear).toLocaleDateString(undefined, {
      month: 'short',
      year: 'numeric',
    }),
  );
});

it('prefers last activity over creation time and tolerates clock skew', () => {
  const revived = chat('r', 'Revived', daysAgo(60), {
    updatedAt: daysAgo(0, 8),
  });
  expect(chatGroupFor(chatRecency(revived), now)).toBe('today');
  expect(chatGroupFor(now + 3_600_000, now)).toBe('today');
  expect(chatGroupFor(daysAgo(7, 0), now)).toBe('week');
  expect(chatGroupFor(daysAgo(8), now)).toBe('month');
});

it('filters titles case-insensitively and requires every word', () => {
  const chats = [
    chat('1', 'Plan the Lisbon trip', 1),
    chat('2', 'Lisbon hotels', 2),
    chat('3', 'Tax questions', 3),
  ];
  expect(filterChats(chats, 'lisbon').map((c) => c.id)).toEqual(['1', '2']);
  expect(filterChats(chats, '  TRIP  lis ').map((c) => c.id)).toEqual(['1']);
  expect(filterChats(chats, 'zzz')).toEqual([]);
  expect(filterChats(chats, '   ')).toBe(chats);
});

it('hides never-used chats unless one is open, and picks the latest real chat of a Dot', () => {
  const chats = [
    chat('blank', 'A new thought', daysAgo(0), { empty: true }),
    chat('used', 'Real', daysAgo(2), { updatedAt: daysAgo(1) }),
    chat('other-dot', 'Other', daysAgo(0), { dotId: 'dot-2' }),
  ];
  expect(listableChats(chats).map((c) => c.id)).toEqual(['used', 'other-dot']);
  expect(listableChats(chats, 'blank').map((c) => c.id)).toContain('blank');
  expect(latestChat(chats, 'dot-1')?.id).toBe('used');
  expect(latestChat(chats, 'dot-3')).toBeUndefined();
});

const noop = async () => true;
const render = (
  chats: ConversationSummary[],
  options: { dots?: Dot[]; selectedId?: string; onNewChat?: () => void } = {},
) =>
  renderToStaticMarkup(
    <ThreadList
      dotId="dot-1"
      chats={chats}
      dots={options.dots ?? [dot('dot-1', 'Dot')]}
      selectedId={options.selectedId}
      newChatLabel="New chat with Dot"
      {...(options.onNewChat ? { onNewChat: options.onNewChat } : {})}
      onSelect={() => {}}
      onRename={noop}
      onDelete={noop}
      onExport={async () => {}}
    />,
  );

it('lists one Dot’s chats newest first, each with a time and its full title on hover', () => {
  const title =
    'Use your computer: open https://httpbin.org/forms/post (a public test form)';
  const html = render(
    [
      chat('2', 'Older one', Date.now() - 3 * 86_400_000),
      chat('1', title, Date.now()),
      chat('3', 'Not mine', Date.now(), { dotId: 'dot-2' }),
    ],
    { selectedId: '1', onNewChat: () => {} },
  );
  expect(html).toContain('class="sb-history"');
  expect(html.indexOf('New chat with Dot')).toBeLessThan(html.indexOf(title));
  expect(html.indexOf('Use your computer')).toBeLessThan(
    html.indexOf('Older one'),
  );
  expect(html).toContain(`title="${title}"`);
  expect(html).toContain('aria-current="page"');
  expect(html).toContain('aria-label="Actions for Use your computer');
  expect(html.match(/class="sb-chat-when"/g)).toHaveLength(2);
  expect(html).not.toContain('Not mine');
  expect(html).not.toContain('sb-chat-dot');
});

it('leaves out New chat without a handler and explains an empty list', () => {
  const html = render([]);
  expect(html).toContain('No chats yet.');
  expect(html).not.toContain('New chat with Dot');
});

it('shows the latest chats first and the rest behind Show more, never hiding the open one', () => {
  const chats = Array.from({ length: HISTORY_LIMIT + 3 }, (_, index) =>
    chat(`c${index}`, `Chat number ${index}`, Date.now() - index * 60_000),
  );
  const html = render(chats);
  expect(html.match(/class="sb-chat-main"/g)).toHaveLength(HISTORY_LIMIT);
  expect(html).toContain('Show 3 more');
  const open = render(chats, { selectedId: `c${HISTORY_LIMIT + 2}` });
  expect(open).toContain(`Chat number ${HISTORY_LIMIT + 2}`);
  expect(open).not.toContain('more</button>');
});

it('keeps never-used chats out of the list but offers to clear them', () => {
  const html = render([
    chat('1', 'Real chat', Date.now()),
    chat('2', 'A new thought', Date.now(), { empty: true }),
    chat('3', 'A new thought', Date.now(), { empty: true }),
    chat('4', 'A new thought', Date.now(), { empty: true, dotId: 'dot-2' }),
  ]);
  expect(html).toContain('Real chat');
  expect(html).not.toContain('>A new thought<');
  expect(html).toContain('Clear 2 empty chats');
  expect(
    render([chat('2', 'A new thought', Date.now(), { empty: true })], {
      selectedId: '2',
    }),
  ).toContain('>A new thought<');
});

it('says what a Dot is doing, or its role while idle', () => {
  const scout = {
    ...dot('dot-1', 'Scout'),
    instructions: 'Finds sources.\nMore',
  };
  expect(dotStatus(scout)).toEqual({ text: 'Finds sources.', tone: 'idle' });
  expect(
    dotStatus(scout, { state: 'working', waiting: 0, step: null }),
  ).toEqual({ text: 'Working', tone: 'busy' });
  expect(
    dotStatus(scout, { state: 'working', waiting: 0, step: 'navigate · Docs' }),
  ).toEqual({ text: 'Using its computer', tone: 'busy' });
  expect(
    dotStatus(scout, { state: 'needs-input', waiting: 2, step: null }),
  ).toEqual({ text: 'Needs you', tone: 'needs' });
  expect(dotStatus({ ...scout, paused: true })).toEqual({
    text: 'Paused',
    tone: 'paused',
  });
});

it('reads each Dot’s state, what waits for the owner and its computer step from mission control', () => {
  const live = liveDots({
    dots: [
      {
        id: 'a',
        state: 'working',
        waiting: { total: 0 },
        activity: { step: 'click · Save' },
      },
      { id: 'b', state: 'needs-input', waiting: { total: 2 }, activity: null },
      { id: 'c', state: 'idle', waiting: { total: 1 }, activity: null },
      { id: 'd', state: 'idle', waiting: { total: 0 }, activity: null },
    ] as never,
  });
  expect([...live]).toEqual([
    ['a', { state: 'working', waiting: 0, step: 'click · Save' }],
    ['b', { state: 'needs-input', waiting: 2, step: null }],
    ['c', { waiting: 1, step: null }],
  ]);
});

const workspace = (
  dots: Dot[],
  conversations: ConversationSummary[],
): WorkspaceState => ({
  spaces: [{ id: 'space-1', name: 'Everyday', description: '', createdAt: 1 }],
  dots,
  conversations,
  setup: {
    model: true,
    browser: true,
    search: true,
    voice: false,
    missing: [],
  },
  calls: [],
});
const sidebar = (
  options: {
    collapsed?: boolean;
    tasks?: number;
    configured?: boolean;
    dots?: Dot[];
    dotLive?: ReadonlyMap<string, DotLive>;
  } = {},
) => {
  const dots = options.dots ?? [dot('dot-1', 'Dot')];
  return renderToStaticMarkup(
    <Sidebar
      workspace={workspace(dots, [chat('1', 'Hello there', Date.now())])}
      dot={dots[0]!}
      view="chat"
      spaceId=""
      taskCount={options.tasks ?? 0}
      memoryCount={2}
      configured={options.configured ?? true}
      collapsed={options.collapsed ?? false}
      onToggleCollapsed={() => {}}
      mobileOpen={false}
      onDismissMobile={() => {}}
      onHome={() => {}}
      onNewChat={() => {}}
      onChooseDot={() => {}}
      onSelectThread={() => {}}
      onRenameThread={noop}
      onDeleteThreads={noop}
      onExportThread={async () => {}}
      onOpenPage={() => {}}
      onOpenFile={() => {}}
      onView={() => {}}
      onDialog={() => {}}
      {...(options.dotLive ? { dotLive: options.dotLive } : {})}
    />,
  );
};

it('lists only the Dots, each with its chats closed, and a footer with places, Settings and Apps', () => {
  const html = sidebar();
  expect(html.match(/<aside/g)).toHaveLength(1);
  for (const text of ['New chat', '>Dots<', '>Settings<', '>Apps<'])
    expect(html).toContain(text);
  expect(html).toContain('aria-label="Show Dot’s chats"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('Hello there');
  expect(html).not.toContain('Search chats');
  for (const label of [
    'aria-label="Collapse sidebar"',
    'aria-label="Create Dot"',
    'aria-label="Inbox"',
    'aria-label="Mission control"',
    'aria-label="Spaces"',
    'aria-label="Scheduled and activity"',
    'aria-label="Memories (2)"',
  ])
    expect(html).toContain(label);
  // Spaces opens a panel above the footer; it is not rendered until then.
  expect(html).toContain('aria-controls="sb-flyout-spaces"');
  expect(html).toContain('aria-haspopup="dialog"');
  expect(html).not.toContain('id="sb-flyout-spaces"');
  expect(html).not.toContain('sb-badge');
});

it('shows a Dot’s chats once its arrow was used, with New chat first', () => {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) =>
      key === 'fulldots.sidebar.dot.dot-1' ? '1' : null,
    setItem: () => {},
  });
  try {
    const html = sidebar();
    expect(html).toContain('aria-label="Hide Dot’s chats"');
    expect(html).toContain('id="sb-history-dot-1"');
    expect(html.indexOf('New chat with Dot')).toBeLessThan(
      html.indexOf('Hello there'),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it('shows what each Dot is doing and counts what waits for the owner', () => {
  const html = sidebar({
    dots: [
      { ...dot('dot-1', 'Scout'), instructions: 'Finds sources' },
      dot('dot-2', 'Quill'),
    ],
    dotLive: new Map([
      ['dot-2', { state: 'needs-input', waiting: 3, step: null }],
    ]),
  });
  expect(html).toContain('sb-dot-status idle">Finds sources<');
  expect(html).toContain('sb-dot-status needs">Needs you<');
  expect(html).toMatch(/class="sb-count"[^>]*>3</);
  expect(html).toContain(', 3 waiting for you');
});

it('badges the activity button only when there are tasks', () => {
  expect(sidebar({ tasks: 3 })).toMatch(/class="sb-badge"[^>]*>3</);
});

it('names every icon in the slim sidebar', () => {
  const html = sidebar({ collapsed: true });
  expect(html).toContain('class="sb collapsed ');
  expect(html).toContain('aria-label="Expand sidebar"');
  expect(html).toContain('aria-label="New chat with Dot"');
  expect(html).toContain('aria-label="Dot, Help" title="Dot, Help"');
  expect(html).toContain('aria-label="Settings and setup"');
  expect(html).toContain('aria-label="Connected apps"');
});

it('asks for setup instead of listing chats before the service is configured', () => {
  const html = sidebar({ configured: false });
  expect(html).toContain('Set up text chat');
  expect(html).toContain('disabled=""');
});
