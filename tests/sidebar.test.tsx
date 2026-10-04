import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({ api: vi.fn() }));
import {
  chatGroupFor,
  filterChats,
  groupChats,
  latestChat,
  listableChats,
} from '../src/client/sidebar/chat-groups';
import { ThreadList } from '../src/client/ThreadList';
import { Sidebar } from '../src/client/sidebar/Sidebar';
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

it('puts chats into calendar-day groups, newest first', () => {
  const chats = [
    chat('old', 'Ancient', daysAgo(90)),
    chat('today-early', 'Early today', daysAgo(0, 1)),
    chat('yesterday', 'Last night', daysAgo(1, 23)),
    chat('week', 'This week', daysAgo(5)),
    chat('month', 'This month', daysAgo(20)),
    chat('today-late', 'Late today', daysAgo(0, 14)),
  ];
  const groups = groupChats(chats, now);
  expect(groups.map((group) => group.label)).toEqual([
    'Today',
    'Yesterday',
    'Previous 7 days',
    'Previous 30 days',
    'Older',
  ]);
  expect(groups[0].items.map((item) => item.id)).toEqual([
    'today-late',
    'today-early',
  ]);
  expect(groups.flatMap((group) => group.items)).toHaveLength(6);
});

it('leaves out empty groups and handles no chats', () => {
  expect(groupChats([], now)).toEqual([]);
  expect(
    groupChats([chat('a', 'A', daysAgo(40))], now).map((group) => group.id),
  ).toEqual(['older']);
});

it('prefers last activity over creation time and tolerates clock skew', () => {
  const revived = chat('r', 'Revived', daysAgo(60), {
    updatedAt: daysAgo(0, 8),
  });
  expect(groupChats([revived], now)[0].id).toBe('today');
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
  options: { dots?: Dot[]; query?: string; selectedId?: string } = {},
) =>
  renderToStaticMarkup(
    <ThreadList
      chats={chats}
      dots={options.dots ?? [dot('dot-1', 'Dot')]}
      selectedId={options.selectedId}
      query={options.query ?? ''}
      onSelect={() => {}}
      onRename={noop}
      onDelete={noop}
    />,
  );

it('lists chats under date headings with the full title on hover and no Dot label for a single Dot', () => {
  const title =
    'Use your computer: open https://httpbin.org/forms/post (a public test form)';
  const html = render([chat('1', title, Date.now())], { selectedId: '1' });
  expect(html).toContain('>Today<');
  expect(html).toContain(`title="${title}"`);
  expect(html).toContain('aria-current="page"');
  expect(html).toContain('aria-label="Actions for Use your computer');
  expect(html).not.toContain('sb-chat-dot');
});

it('shows a small Dot avatar per chat only when there are several Dots', () => {
  const dots = [dot('dot-1', 'Dot'), dot('dot-2', 'Scout')];
  const html = render(
    [
      chat('1', 'One', Date.now()),
      chat('2', 'Two', Date.now(), { dotId: 'dot-2' }),
    ],
    { dots },
  );
  expect(html.match(/sb-chat-dot/g)).toHaveLength(2);
  expect(html).toContain('aria-label="Two, Scout"');
});

it('explains an empty list and a search with no matches', () => {
  expect(render([])).toContain('No chats yet');
  expect(
    render([chat('1', 'Tax questions', Date.now())], { query: 'zzz' }),
  ).toContain('No chats match your search.');
});

it('keeps never-used chats out of the list but offers to clear them', () => {
  const html = render([
    chat('1', 'Real chat', Date.now()),
    chat('2', 'A new thought', Date.now(), { empty: true }),
    chat('3', 'A new thought', Date.now(), { empty: true }),
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
  options: { collapsed?: boolean; tasks?: number; configured?: boolean } = {},
) =>
  renderToStaticMarkup(
    <Sidebar
      workspace={workspace(
        [dot('dot-1', 'Dot')],
        [chat('1', 'Hello there', Date.now())],
      )}
      dot={dot('dot-1', 'Dot')}
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
      onOpenPage={() => {}}
      onView={() => {}}
      onDialog={() => {}}
    />,
  );

it('renders one sidebar with New chat, search, sections and a compact footer', () => {
  const html = sidebar();
  expect(html.match(/<aside/g)).toHaveLength(1);
  expect(html).not.toContain('icon-rail');
  for (const text of [
    'New chat',
    'Search chats',
    'Dots',
    'Spaces',
    'Chats',
    'Hello there',
  ])
    expect(html).toContain(text);
  for (const label of [
    'aria-label="Collapse sidebar"',
    'aria-label="Scheduled and activity"',
    'aria-label="Memories (2)"',
    'aria-label="Settings and setup"',
  ])
    expect(html).toContain(label);
  expect(html).not.toContain('Make it your own');
  expect(html).not.toContain('sb-badge');
});

it('badges the activity button only when there are tasks', () => {
  expect(sidebar({ tasks: 3 })).toMatch(/class="sb-badge"[^>]*>3</);
});

it('names every icon in the slim sidebar', () => {
  const html = sidebar({ collapsed: true });
  expect(html).toContain('class="sb collapsed ');
  expect(html).toContain('aria-label="Expand sidebar"');
  expect(html).toContain('aria-label="New chat with Dot"');
  expect(html).toContain('aria-label="Dot" title="Dot"');
  expect(html).toContain('aria-label="Everyday" title="Everyday"');
});

it('asks for setup instead of listing chats before the service is configured', () => {
  const html = sidebar({ configured: false });
  expect(html).toContain('Set up text chat');
  expect(html).toContain('disabled=""');
});
