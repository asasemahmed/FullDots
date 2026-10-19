// P4 named teams in the client: the sidebar section, the builder (radio groups, keyboard helpers),
// the team page, the Dot dialog's "Can hand work to", the team chat banner, palette actions and the
// #/team/<id> hash.
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: () => ({}),
  ApiError: class extends Error {},
}));
import { parseAppHash } from '../src/client/app-hash';
import {
  buildActions,
  dispatchTarget,
  resultToItem,
  type PaletteHandlers,
} from '../src/client/palette/palette-model';
import { Sidebar } from '../src/client/sidebar/Sidebar';
import {
  addToTeam,
  draftPayload,
  emptyDraft,
  hasErrors,
  makeLead,
  moveMember,
  movedMessage,
  orbitAngles,
  orderKey,
  removeFromTeam,
  setRole,
  teamIsFull,
  validateDraft,
  type TeamDraft,
} from '../src/client/teams/builder-model';
import { rovingIndex } from '../src/client/teams/controls';
import {
  DotDelegatesField,
  madeTeamName,
} from '../src/client/teams/DotDelegatesField';
import { TeamBuilder } from '../src/client/teams/TeamBuilder';
import { TeamPage } from '../src/client/teams/TeamPage';
import type { SidebarTeams } from '../src/client/teams/TeamsSection';
import { TeamChatBanner } from '../src/client/teams/useTeamChat';
import type { Team, TeamDetail } from '../src/shared/teams';
import type { Dot, WorkspaceState } from '../src/shared/types';

const dot = (id: string, name: string, extra: Partial<Dot> = {}): Dot => ({
  id,
  spaceId: 'space-1',
  spaceIds: ['space-1'],
  name,
  instructions: `${name} helps.`,
  researchAllowed: true,
  memoryAllowed: true,
  createdAt: 1,
  ...extra,
});
const dots = [
  dot('lead', 'Captain', { color: 'coral' }),
  dot('scout', 'Scout', { color: 'mint' }),
  dot('writer', 'Writer'),
  dot('critic', 'Critic', { paused: true }),
];
const team: Team = {
  id: 'team-1',
  name: 'Launch crew',
  emoji: '🚀',
  color: 'coral',
  description: 'Ships our launches.',
  leadDotId: 'lead',
  style: 'sequential',
  mode: 'lead',
  summarize: false,
  reviewerDotId: null,
  spaceId: null,
  runLog: true,
  createdAt: 1,
  updatedAt: 2,
  archivedAt: null,
  members: [
    { dotId: 'scout', role: 'Finds sources', position: 0 },
    { dotId: 'writer', role: 'Writes the post', position: 1 },
    { dotId: 'critic', role: '', position: 2 },
  ],
};
const workspace: WorkspaceState = {
  spaces: [{ id: 'space-1', name: 'Everyday', description: '', createdAt: 1 }],
  dots,
  conversations: [],
  setup: {
    model: true,
    browser: true,
    search: true,
    voice: false,
    missing: [],
  },
  calls: [],
};
const noop = () => {};
const sidebarTeams = (extra: Partial<SidebarTeams> = {}): SidebarTeams => ({
  teams: [team],
  working: new Set(),
  onOpen: noop,
  onStartChat: noop,
  onEdit: noop,
  onArchive: noop,
  onCreate: noop,
  ...extra,
});
const sidebar = (teams?: SidebarTeams, collapsed = false) =>
  renderToStaticMarkup(
    <Sidebar
      workspace={workspace}
      dot={dots[0]!}
      view="team"
      spaceId=""
      taskCount={0}
      memoryCount={0}
      configured
      collapsed={collapsed}
      onToggleCollapsed={noop}
      mobileOpen={false}
      onDismissMobile={noop}
      onHome={noop}
      onNewChat={noop}
      onChooseDot={noop}
      onSelectThread={noop}
      onRenameThread={async () => true}
      onDeleteThreads={async () => true}
      onExportThread={async () => {}}
      onOpenPage={noop}
      onOpenFile={noop}
      onView={noop}
      onDialog={noop}
      {...(teams ? { teams } : {})}
    />,
  );

describe('sidebar Teams section', () => {
  it('sits between Dots and Spaces with a create button and one row per team', () => {
    const html = sidebar(sidebarTeams({ activeTeamId: 'team-1' }));
    const dotsAt = html.indexOf('aria-label="Dots"');
    const teamsAt = html.indexOf('aria-label="Teams"');
    const spacesAt = html.indexOf('aria-label="Spaces"');
    expect(dotsAt).toBeGreaterThan(-1);
    expect(teamsAt).toBeGreaterThan(dotsAt);
    expect(spacesAt).toBeGreaterThan(teamsAt);
    expect(html).toContain('aria-label="Create team"');
    expect(html).toContain('aria-controls="sb-teams"');
    expect(html).toContain('🚀');
    expect(html).toContain('Launch crew');
    expect(html).toContain('aria-label="Launch crew options"');
    // Lead first and larger, then members; three of four shown plus none hidden.
    expect(html.match(/team-stack-face/g)).toHaveLength(4);
    expect(html.indexOf('class="team-stack-face lead"')).toBeLessThan(
      html.indexOf('class="team-stack-face "'),
    );
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain('sb-team-pulse');
  });

  it('pulses and says "working" while any member works', () => {
    const html = sidebar(sidebarTeams({ working: new Set(['writer']) }));
    expect(html).toContain('sb-team-pulse');
    expect(html).toContain('>working<');
    expect(html).toContain('sb-team working');
  });

  it('offers a first team when there is none, and hides chrome when slim', () => {
    expect(sidebar(sidebarTeams({ teams: [] }))).toContain(
      'Make your first team',
    );
    const slim = sidebar(sidebarTeams(), true);
    expect(slim).toContain('aria-label="Launch crew"');
    expect(slim).not.toContain('Make your first team');
  });

  it('is absent when the host passes no teams', () => {
    expect(sidebar()).not.toContain('aria-label="Teams"');
  });
});

describe('builder rules', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  it('makes the first Dot the lead, the rest members, and stops at 8 members', () => {
    let draft = emptyDraft();
    expect(draft).toMatchObject({
      mode: 'lead',
      style: 'parallel',
      summarize: false,
    });
    draft = addToTeam(draft, 'a');
    expect(draft.leadDotId).toBe('a');
    for (const id of ids.slice(1)) draft = addToTeam(draft, id);
    expect(draft.members.map((member) => member.dotId)).toEqual(
      ids.slice(1, 9),
    );
    expect(teamIsFull(draft)).toBe(true);
    expect(addToTeam(draft, 'a')).toBe(draft);
  });

  it('promotes the first member when the lead leaves, and swaps on "make lead"', () => {
    let draft = ['a', 'b', 'c'].reduce(addToTeam, emptyDraft());
    draft = setRole(draft, 'c', 'Checks');
    const swapped = makeLead(draft, 'c');
    expect(swapped.leadDotId).toBe('c');
    expect(swapped.members).toEqual([
      { dotId: 'b', role: '' },
      { dotId: 'a', role: '' },
    ]);
    const removed = removeFromTeam(draft, 'a');
    expect(removed.leadDotId).toBe('b');
    expect(removed.members.map((member) => member.dotId)).toEqual(['c']);
  });

  it('reorders with arrow keys, Home and End, and announces the new place', () => {
    expect(orderKey('ArrowUp', 2, 4)).toBe(1);
    expect(orderKey('ArrowUp', 0, 4)).toBeUndefined();
    expect(orderKey('ArrowDown', 1, 4)).toBe(2);
    expect(orderKey('ArrowDown', 3, 4)).toBeUndefined();
    expect(orderKey('Home', 2, 4)).toBe(0);
    expect(orderKey('End', 0, 4)).toBe(3);
    expect(orderKey('Enter', 0, 4)).toBeUndefined();
    const draft = ['lead', 'a', 'b', 'c'].reduce(addToTeam, emptyDraft());
    expect(
      moveMember(draft, 2, 0).members.map((member) => member.dotId),
    ).toEqual(['c', 'a', 'b']);
    expect(
      moveMember(draft, 0, 9).members.map((member) => member.dotId),
    ).toEqual(['b', 'c', 'a']);
    expect(movedMessage('Scout', 0, 3)).toBe('Scout moved to place 1 of 3.');
    expect(rovingIndex('ArrowRight', 2, 3)).toBe(0);
    expect(rovingIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(rovingIndex('x', 0, 3)).toBe(-1);
  });

  it('validates like the server and builds the request body', () => {
    const empty = validateDraft(emptyDraft({ emoji: 'ab' }));
    expect(empty).toEqual({
      name: 'Give the team a name.',
      emoji: 'Choose one emoji for the team.',
      lead: 'Add a Dot to lead the team.',
      members: 'Add at least one member besides the lead.',
    });
    const draft: TeamDraft = {
      ...['lead', 'scout'].reduce(addToTeam, emptyDraft()),
      name: ' Launch crew ',
    };
    expect(validateDraft(draft, [team]).name).toContain('already exists');
    expect(validateDraft(draft, [{ ...team, archivedAt: 5 }])).toEqual({});
    expect(hasErrors(validateDraft({ ...draft, id: 'team-1' }, [team]))).toBe(
      false,
    );
    expect(draftPayload(setRole(draft, 'scout', ' Finds '))).toEqual({
      name: 'Launch crew',
      emoji: '🚀',
      color: 'coral',
      description: '',
      leadDotId: 'lead',
      style: 'parallel',
      mode: 'lead',
      summarize: false,
      reviewerDotId: null,
      runLog: true,
      members: [{ dotId: 'scout', role: 'Finds' }],
    });
    expect(orbitAngles(4)).toEqual([-90, 0, 90, 180]);
  });
});

describe('team builder', () => {
  const render = (
    initial?: TeamDraft,
    extra: Partial<Parameters<typeof TeamBuilder>[0]> = {},
  ) =>
    renderToStaticMarkup(
      <TeamBuilder
        dots={dots}
        teams={[]}
        onClose={noop}
        onSaved={noop}
        {...(initial ? { initial } : {})}
        {...extra}
      />,
    );

  it('renders name, emoji, colour and the empty stage, with Lead plans chosen', () => {
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Assemble a team.');
    expect(html).toContain('for="tb-name"');
    for (const group of [
      'Team emoji',
      'Team colour',
      'Work style',
      'Who plans the work',
    ])
      expect(html).toContain(`role="radiogroup" aria-label="${group}"`);
    expect(html).toContain('aria-label="Lead plans (recommended)"');
    expect(html).toMatch(
      /aria-checked="true"[^>]*aria-label="Lead plans \(recommended\)"/,
    );
    expect(html).toMatch(/aria-checked="true"[^>]*aria-label="All at once"/);
    expect(html).toContain('Drop a lead here');
    expect(html).toContain('aria-label="Add Captain as the lead"');
    expect(html).toContain('draggable="true"');
    // Three style cards, each with its little diagram.
    expect(html.match(/class="style-diagram/g)).toHaveLength(3);
    // Lead plans: no "Lead summarises" switch (only the team space one).
    expect(html).not.toContain('Lead summarises');
  });

  it('shows the lead in the centre, members in order with keyboard reordering and Make lead', () => {
    const draft: TeamDraft = {
      ...['lead', 'scout', 'writer'].reduce(addToTeam, emptyDraft()),
      name: 'Launch crew',
      mode: 'direct',
    };
    const html = render(draft);
    expect(html).toContain(
      'role="img" aria-label="Launch crew: Captain leads with Scout, Writer."',
    );
    expect(html).toContain('aria-label="Members, in working order"');
    expect(html).toContain(
      'aria-label="Scout, place 1 of 2. Arrow keys move it."',
    );
    expect(html).toContain('aria-keyshortcuts="ArrowUp ArrowDown Home End"');
    expect(html).toContain('aria-label="Make Writer the lead"');
    expect(html).toContain('aria-label="Scout&#x27;s role on the team"');
    expect(html).toContain('aria-label="Add Critic to the team"');
    expect(html).toContain('aria-live="polite"');
    // Direct mode shows the "lead summarises" switch.
    expect(html).toContain('role="switch"');
    expect(html).toContain('Lead summarises');
  });

  it('opens an existing team for editing', () => {
    const html = render(undefined, { team });
    expect(html).toContain('Tune your team.');
    expect(html).toContain('Save team');
    expect(html).toContain('value="Launch crew"');
    expect(html).toMatch(/aria-checked="true"[^>]*aria-label="Step by step"/);
  });
});

describe('team page', () => {
  it('shows the orbit, who does what, how it works, recent chats and runs', () => {
    const detail: TeamDetail = {
      ...team,
      conversations: [
        { id: 'chat-1', title: 'Plan the spring launch', createdAt: 5 },
      ],
      runs: [
        {
          id: 'run-1',
          teamId: 'team-1',
          threadId: 'chat-1',
          style: 'sequential',
          mode: 'lead',
          status: 'running',
          createdAt: 5,
          finishedAt: null,
          cancelledAt: null,
          reviewerDotId: null,
          verdict: null,
          sentBack: false,
          log: null,
        },
        {
          id: 'run-0',
          teamId: 'team-1',
          threadId: 'chat-1',
          style: 'parallel',
          mode: 'lead',
          status: 'done',
          createdAt: 1,
          finishedAt: 31_001,
          cancelledAt: null,
          reviewerDotId: null,
          verdict: null,
          sentBack: false,
          log: null,
        },
      ],
    };
    const html = renderToStaticMarkup(
      <TeamPage
        teamId="team-1"
        dots={dots}
        working={new Set(['scout'])}
        initial={detail}
        onStartChat={noop}
        onEdit={noop}
        onArchive={noop}
        onOpenThread={noop}
      />,
    );
    expect(html).toContain('id="team-page-title"');
    expect(html).toContain('Launch crew');
    expect(html).toContain('WORKING NOW');
    expect(html).toContain(
      'role="img" aria-label="Launch crew: Captain leads with Scout, Writer, Critic."',
    );
    expect(html).toContain('Finds sources');
    expect(html).toContain('No role yet');
    expect(html).toContain('Step by step');
    expect(html).toContain('Lead plans');
    expect(html).toContain('Start team chat');
    expect(html).toContain('Plan the spring launch');
    expect(html).toContain('Working');
    expect(html).toContain('31 s');
    expect(html.match(/> Stop</g)).toHaveLength(1);
    expect(html).toContain('class="tp-step">1<');
  });
});

describe('Dot dialog: Can hand work to', () => {
  it('locks team-given teammates with a "via" badge and offers to make a team', () => {
    const html = renderToStaticMarkup(
      <DotDelegatesField
        dotId="lead"
        dotName="Captain"
        dots={dots}
        value={['writer', 'critic']}
        onChange={noop}
        initialImplied={[
          {
            dotId: 'scout',
            teams: [{ id: 'team-1', name: 'Launch crew', emoji: '🚀' }],
          },
        ]}
      />,
    );
    expect(html).toContain('role="group" aria-label="Can hand work to"');
    const locked = html.match(/<input[^>]*dd-via-scout[^>]*>/)?.[0] ?? '';
    expect(locked).toContain('checked=""');
    expect(locked).toContain('disabled=""');
    expect(html).toContain('via 🚀 Launch crew');
    expect(html).toContain('Make a team from these teammates');
    expect(html).not.toContain('>Captain<');
    expect(madeTeamName('Captain', 0)).toBe("Captain's team");
    expect(madeTeamName('Captain', 2)).toBe("Captain's team 3");
  });

  it('does not offer a team for fewer than two teammates or a new Dot', () => {
    const one = renderToStaticMarkup(
      <DotDelegatesField
        dotId="lead"
        dotName="Captain"
        dots={dots}
        value={['scout']}
        onChange={noop}
        initialImplied={[]}
      />,
    );
    expect(one).not.toContain('Make a team');
    const fresh = renderToStaticMarkup(
      <DotDelegatesField
        dotName="New"
        dots={dots}
        value={['scout', 'writer']}
        onChange={noop}
      />,
    );
    expect(fresh).not.toContain('Make a team');
  });
});

describe('team chat banner', () => {
  it('names the team, its mode and style, and links to its page', () => {
    const lead = renderToStaticMarkup(
      <TeamChatBanner team={team} dots={dots} />,
    );
    expect(lead).toContain('href="#/team/team-1"');
    expect(lead).toContain('Lead plans: the lead briefs the team');
    const direct = renderToStaticMarkup(
      <TeamChatBanner
        team={{ ...team, mode: 'direct', style: 'parallel' }}
        dots={dots}
        error="Busy."
      />,
    );
    expect(direct).toContain('Direct: your message goes to all 3 members');
    expect(direct).toContain('role="alert"');
  });
});

describe('palette and navigation', () => {
  it('offers Start team chat for each active team, and Create team', () => {
    const actions = buildActions({
      dots,
      configured: true,
      teams: [team, { ...team, id: 'old', name: 'Old', archivedAt: 3 }],
    });
    const titles = actions.map((item) => item.title);
    expect(titles).toContain('Start team chat with 🚀 Launch crew');
    expect(titles).toContain('Create team');
    expect(titles).not.toContain('Start team chat with 🚀 Old');
    const chat = actions.find((item) => item.id === 'action:team-chat:team-1')!;
    expect(chat.target).toEqual({
      kind: 'action',
      action: { type: 'team-chat', teamId: 'team-1' },
    });
    expect(
      buildActions({ dots, configured: false, teams: [team] }).map(
        (item) => item.title,
      ),
    ).not.toContain('Start team chat with 🚀 Launch crew');
  });

  it('turns a team search hit into a row that opens the team page', () => {
    const item = resultToItem(
      {
        type: 'team',
        id: 'team-1',
        title: '🚀 Launch crew',
        snippet: '',
        updatedAt: 1,
      },
      { ...workspace, teams: [team] },
    )!;
    expect(item).toMatchObject({
      group: 'team',
      title: '🚀 Launch crew',
      subtitle: 'Led by Captain',
      target: { kind: 'team', teamId: 'team-1' },
    });
    const openTeam = vi.fn();
    dispatchTarget(item.target, { openTeam } as unknown as PaletteHandlers);
    expect(openTeam).toHaveBeenCalledWith('team-1');
  });

  it('parses #/team/<id>', () => {
    expect(parseAppHash('#/team/team-1')).toEqual({
      view: 'team',
      teamId: 'team-1',
    });
    expect(parseAppHash('#/team/a%20b')).toEqual({
      view: 'team',
      teamId: 'a b',
    });
    expect(parseAppHash('#/team/')).toBeUndefined();
  });
});

describe('flat, calm look', () => {
  it('uses no colour gradients in the Teams styles or the builder markup', () => {
    for (const file of [
      '../src/client/teams/teams.css',
      '../src/client/lanes/team-run.css',
    ])
      expect(
        readFileSync(new URL(file, import.meta.url), 'utf8'),
      ).not.toContain('gradient(');
    const html = renderToStaticMarkup(
      <TeamBuilder dots={dots} teams={[]} onClose={noop} onSaved={noop} />,
    );
    expect(html).not.toContain('gradient(');
    for (const title of ['Name and look', 'Who is on the team', 'Team space'])
      expect(html).toContain(title);
  });

  it('marks the lead with a crown and a Lead tag in one roster with the members', () => {
    const html = renderToStaticMarkup(
      <TeamBuilder
        dots={dots}
        teams={[]}
        onClose={noop}
        onSaved={noop}
        initial={['lead', 'scout'].reduce(addToTeam, emptyDraft())}
      />,
    );
    const roster = html.slice(html.indexOf('class="tb-roster"'));
    expect(roster).toContain('class="tb-lead-row"');
    expect(roster).toContain('class="tb-tag">Lead<');
    expect(roster).toContain('aria-label="Members, in working order"');
    expect(html).toContain('aria-label="Remove Captain from the team"');
  });
});
