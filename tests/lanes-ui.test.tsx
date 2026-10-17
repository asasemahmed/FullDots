// P3 work lanes in the chat: the band of a turn's hand-offs, every lane state, result cards,
// "Built from", sidebar nesting and the helpers behind the live region and the live connections.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@ag-ui/core';
import { ChatTranscript } from '../src/client/ChatTranscript';
import { buildTranscriptItems } from '../src/client/chat-turns';
import { WorkBand } from '../src/client/lanes/WorkBand';
import { StopEverything } from '../src/client/lanes/StopEverything';
import {
  LanesContext,
  type LanesValue,
} from '../src/client/lanes/lanes-context';
import {
  LaneAnnouncer,
  MAX_LIVE_LANES,
  bandSettled,
  bandLanes,
  deliveredWith,
  formatElapsed,
  formatTokens,
  handOffCalls,
  isOwnAgentError,
  latestAttempt,
  laneView,
  toggleExpanded,
} from '../src/client/lanes/lane-model';
import { nestChats, workRunning } from '../src/client/sidebar/chat-tree';
import { liveStates } from '../src/client/sidebar/useDotLive';
import { ThreadList } from '../src/client/ThreadList';
import type { LaneProgress } from '../src/shared/lanes';
import type { Approval, ConversationSummary, Dot } from '../src/shared/types';

// The API module reads the session token the moment it loads, and there is no browser here.
vi.hoisted(() => {
  Object.assign(globalThis, {
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
});

const dot = (id: string, name: string, extra: Partial<Dot> = {}): Dot => ({
  id,
  spaceId: 'space',
  spaceIds: ['space'],
  name,
  instructions: `${name} role.`,
  researchAllowed: true,
  memoryAllowed: true,
  createdAt: 0,
  ...extra,
});
const lead = dot('lead', 'Lead', { color: 'indigo' });
const marketer = dot('marketer', 'Marketer', { color: 'coral' });
const engineer = dot('engineer', 'Engineer', { color: 'mint' });
const dots = [lead, marketer, engineer];

const lane = (
  id: string,
  childDotId: string,
  extra: Partial<LaneProgress> = {},
): LaneProgress => ({
  id,
  parentThreadId: 'lead-thread',
  parentDotId: 'lead',
  childThreadId: `child-${id}`,
  childDotId,
  batchKey: 'lead-thread:run-1',
  retryOf: null,
  attempt: 1,
  brief: `Brief for ${id}: write the launch plan.`,
  deliverable: 'A plan.',
  status: 'working',
  wait: null,
  step: 'Opening website',
  createdAt: 1000,
  startedAt: 2000,
  finishedAt: null,
  deliveredAt: null,
  elapsedMs: 65_000,
  tokens: 1500,
  preview: ['Looking at three competitors.', 'First: Acme.'],
  result: null,
  resultLength: 0,
  runId: 'run',
  ...extra,
});

const lanesValue = (
  lanes: LaneProgress[],
  extra: Partial<LanesValue> = {},
): LanesValue => ({
  threadId: 'lead-thread',
  hostDot: lead,
  lanes,
  receivedAt: Date.now(),
  loaded: true,
  dot: (id) => dots.find((item) => item.id === id),
  skipped: new Set(),
  skip: () => {},
  stop: async () => {},
  stopAll: async () => {},
  retry: async () => {},
  expanded: [],
  toggle: () => {},
  decide: async () => {},
  onOpenThread: () => {},
  takeOver: async () => {},
  fresh: new Set(),
  played: () => {},
  pending: new Set(),
  error: '',
  clearError: () => {},
  loadResult: async () => '',
  ...extra,
});

const call = (id: string, name: string, args: unknown) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});
const delegateCalls = [
  call('c1', 'delegate_to_dot', {
    dot: 'Marketer',
    brief: 'Write the launch post.',
    deliverable: 'A post.',
  }),
  call('c2', 'delegate_to_dot', {
    dot: 'Engineer',
    brief: 'Check the release build.',
    deliverable: 'A report.',
  }),
];
const results = new Map([
  ['c1', JSON.stringify({ started: true, id: 'd1', note: 'Handed over.' })],
  ['c2', JSON.stringify({ started: true, id: 'd2', note: 'Handed over.' })],
]);

const band = (lanes: LaneProgress[], extra: Partial<LanesValue> = {}) =>
  renderToStaticMarkup(
    <LanesContext.Provider value={lanesValue(lanes, extra)}>
      <WorkBand calls={delegateCalls} results={results} />
    </LanesContext.Provider>,
  );

const approval: Approval = {
  id: 'ap-1',
  threadId: 'child-d1',
  dotId: 'marketer',
  toolCallId: 'x',
  tool: 'computer_exec',
  argsHash: 'h',
  summary: 'Marketer wants to run a command',
  argsRedacted: 'ls -la',
  status: 'pending',
  note: null,
  createdAt: 0,
  expiresAt: 1,
  decidedAt: null,
  consumedAt: null,
};

describe('the transcript builder', () => {
  it('groups the hand-off calls of a turn into one band after its reply', () => {
    const messages: Message[] = [
      { id: 'u', role: 'user', content: 'Plan the launch' },
      {
        id: 'a',
        role: 'assistant',
        content: 'I asked Marketer and Engineer.',
        toolCalls: [
          ...delegateCalls,
          call('c3', 'check_delegation', { id: 'd1' }),
        ],
      },
    ];
    const items = buildTranscriptItems(messages, [], results);
    expect(items.map((item) => item.kind)).toEqual([
      'bubble',
      'bubble',
      'band',
    ]);
    const bandItem = items[2];
    expect(bandItem.kind === 'band' && bandItem.calls.map((c) => c.id)).toEqual(
      ['c1', 'c2', 'c3'],
    );
  });

  it('keeps the delegation a resume turn delivers', () => {
    const items = buildTranscriptItems(
      [
        {
          id: 'resume',
          role: 'user',
          content: 'Your teammates finished...',
          metadata: { source: 'delegation', ref: 'd1' },
        } as Message,
      ],
      [],
    );
    expect(items[0]).toMatchObject({
      kind: 'event',
      source: 'delegation',
      ref: 'd1',
    });
  });
});

describe('the work band', () => {
  it('draws a lane per teammate with its live state, step, preview, timer and tokens', () => {
    const html = band([
      lane('d1', 'marketer'),
      lane('d2', 'engineer', { status: 'queued', step: null, preview: [] }),
    ]);
    expect(html).toContain('<strong>Lead</strong> handed work to');
    expect(html).toContain('Marketer and Engineer');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Marketer: Opening website"');
    expect(html).toContain('aria-label="Engineer: Queued"');
    expect(html).toContain('Looking at three competitors.');
    expect(html).toContain('1:05');
    expect(html).toContain('1.5k tokens');
    expect(html).toContain('Stop Marketer');
    expect(html).toContain('Open chat');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('1 working · 1 waiting');
  });

  it.each([
    [
      'queued',
      lane('d1', 'marketer', { status: 'queued', step: null }),
      'Queued',
    ],
    ['working', lane('d1', 'marketer'), 'Opening website'],
    [
      'busy',
      lane('d1', 'marketer', { status: 'waiting', wait: { kind: 'busy' } }),
      'Waiting: Marketer is busy in another chat',
    ],
    [
      'budget',
      lane('d1', 'marketer', { status: 'waiting', wait: { kind: 'budget' } }),
      'Waiting: daily budget reached',
    ],
    [
      'approval',
      lane('d1', 'marketer', {
        status: 'waiting',
        wait: { kind: 'approval', approval },
      }),
      'Waiting for your approval',
    ],
    [
      'handoff',
      lane('d1', 'marketer', {
        status: 'waiting',
        wait: {
          kind: 'handoff',
          handoff: {
            id: 'h1',
            kind: 'two_factor',
            reason: 'Enter the code',
            dotId: 'marketer',
          },
        },
      }),
      'Your turn on the computer',
    ],
    [
      'paused',
      lane('d1', 'marketer', { status: 'waiting', wait: { kind: 'paused' } }),
      'Waiting: Marketer is paused',
    ],
    [
      'failed',
      lane('d1', 'marketer', {
        status: 'failed',
        result: 'The model refused.',
        finishedAt: 9000,
      }),
      'The model refused.',
    ],
    [
      'stopped',
      lane('d1', 'marketer', {
        status: 'stopped',
        result: 'Stopped by you.',
        finishedAt: 9000,
      }),
      'Stopped by you',
    ],
  ])(
    'says the %s state in words, with no images inline',
    (_state, one, words) => {
      const html = band([one, lane('d2', 'engineer')]);
      expect(html).toContain(words);
      expect(html).not.toMatch(/base64|data:image/);
    },
  );

  it('puts the approval and the take-over in the lane', () => {
    const waiting = band([
      lane('d1', 'marketer', {
        status: 'waiting',
        wait: { kind: 'approval', approval },
      }),
      lane('d2', 'engineer', {
        status: 'waiting',
        wait: {
          kind: 'handoff',
          handoff: {
            id: 'h1',
            kind: 'two_factor',
            reason: 'Enter the code',
            dotId: 'engineer',
          },
        },
      }),
    ]);
    expect(waiting).toContain('Marketer wants to run a command');
    expect(waiting).toContain('Approve');
    expect(waiting).toContain('Take over');
    expect(waiting).toContain('Enter the code');
  });

  it('offers Try again and Skip on a failed lane, and shows its coral state', () => {
    const html = band([
      lane('d1', 'marketer', {
        status: 'failed',
        result: 'Broke.',
        finishedAt: 9000,
      }),
      lane('d2', 'engineer'),
    ]);
    expect(html).toContain('is-failed');
    expect(html).toContain('Try again');
    expect(html).toContain('Skip');
  });

  it('folds into result chips once every teammate is done', () => {
    const done = { status: 'done' as const, finishedAt: 9000, step: null };
    const html = band([
      lane('d1', 'marketer', done),
      lane('d2', 'engineer', { status: 'stopped', finishedAt: 9000 }),
    ]);
    expect(html).toContain('is-settled');
    expect(html).toContain('fd-result-chip is-done');
    expect(html).toContain('fd-result-chip is-stopped');
    expect(html).toContain('Show the work');
    expect(html).not.toContain('data-lane=');
    expect(html).toContain('1 of 2 done');
  });

  it('shows the newest attempt after Try again', () => {
    const html = band([
      lane('d1', 'marketer', { status: 'failed', finishedAt: 5 }),
      lane('d3', 'marketer', { retryOf: 'd1', attempt: 2 }),
      lane('d2', 'engineer'),
    ]);
    expect(html).toContain('data-lane="d3"');
    expect(html).not.toContain('data-lane="d1"');
    expect(html).toContain('try 2');
  });

  it('draws plain lines outside a chat with lanes, and for checks only', () => {
    expect(
      renderToStaticMarkup(
        <WorkBand calls={delegateCalls} results={results} />,
      ),
    ).toContain('Handed work to Marketer and Engineer');
    expect(
      renderToStaticMarkup(
        <WorkBand
          calls={[call('c3', 'check_delegation', { id: 'd1' })]}
          results={new Map()}
        />,
      ),
    ).toContain('Checked on a teammate’s work');
  });

  it('shows a refused hand-off without a lane', () => {
    const html = renderToStaticMarkup(
      <LanesContext.Provider value={lanesValue([])}>
        <WorkBand
          calls={[delegateCalls[0]]}
          results={
            new Map([
              [
                'c1',
                JSON.stringify({
                  started: false,
                  error: 'Marketer is not on your team.',
                }),
              ],
            ])
          }
        />
      </LanesContext.Provider>,
    );
    expect(html).toContain('Not handed over: Marketer is not on your team.');
  });
});

describe('results coming back', () => {
  const delivered = [
    lane('d1', 'marketer', {
      status: 'done',
      deliveredAt: 50,
      finishedAt: 40,
      result: 'Launch post draft.',
      resultLength: 2000,
      preview: ['Launch post draft.'],
    }),
    lane('d2', 'engineer', {
      status: 'done',
      deliveredAt: 50,
      finishedAt: 45,
      result: 'Build is green.',
      resultLength: 15,
      preview: ['Build is green.'],
    }),
  ];
  const transcript = (value: LanesValue | null) =>
    renderToStaticMarkup(
      <LanesContext.Provider value={value}>
        <ChatTranscript
          calls={[]}
          messages={[
            {
              id: 'resume',
              role: 'user',
              content: 'Your teammates finished the work (2 results).',
              metadata: { source: 'delegation', ref: 'd1' },
            } as Message,
            { id: 'answer', role: 'assistant', content: 'Here is the plan.' },
          ]}
        />
      </LanesContext.Provider>,
    );

  it('shows a card per teammate and names them under the combined answer', () => {
    const html = transcript(lanesValue(delivered));
    expect(html).toContain('2 teammates reported back');
    expect(html).toContain('aria-label="Marketer: Done"');
    expect(html).toContain('Show full result');
    expect(html).toContain('Built from:');
    expect(html.indexOf('Here is the plan.')).toBeLessThan(
      html.indexOf('Built from:'),
    );
    expect(html).not.toContain('Your teammates finished the work');
  });

  it('falls back to the event line when the lanes do not know the results', () => {
    const html = transcript(null);
    expect(html).toContain('Delegated work');
    expect(html).toContain('Your teammates finished the work');
    expect(html).not.toContain('Built from:');
  });

  it('finds the results delivered together', () => {
    expect(deliveredWith('d1', delivered).map((item) => item.id)).toEqual([
      'd1',
      'd2',
    ]);
    expect(
      deliveredWith('d1', [
        delivered[0],
        { ...delivered[1], deliveredAt: 99 },
      ]).map((item) => item.id),
    ).toEqual(['d1']);
    // While the delivering turn runs, the batch's finished results are not marked yet.
    expect(
      deliveredWith(
        'd1',
        delivered.map((item) => ({ ...item, deliveredAt: null })),
      ).map((item) => item.id),
    ).toEqual(['d1', 'd2']);
  });
});

describe('Stop everything', () => {
  it('shows only while a teammate works', () => {
    const value = lanesValue([lane('d1', 'marketer')]);
    expect(
      renderToStaticMarkup(<StopEverything lanes={value} running />),
    ).toContain('Stop everything');
    expect(
      renderToStaticMarkup(<StopEverything lanes={value} running={false} />),
    ).toBe('');
  });
});

describe('lane helpers', () => {
  it('reads hand-offs from the calls and their results', () => {
    expect(
      handOffCalls(delegateCalls, new Map([['c1', results.get('c1')!]])),
    ).toEqual([
      {
        callId: 'c1',
        to: 'Marketer',
        brief: 'Write the launch post.',
        id: 'd1',
        pending: false,
      },
      {
        callId: 'c2',
        to: 'Engineer',
        brief: 'Check the release build.',
        pending: true,
      },
    ]);
  });

  it('follows Try again to the newest attempt and settles a band', () => {
    const lanes = [
      lane('d1', 'marketer', { status: 'failed' }),
      lane('d3', 'marketer', { retryOf: 'd1', status: 'done' }),
    ];
    expect(latestAttempt('d1', lanes)?.id).toBe('d3');
    const entries = bandLanes(handOffCalls([delegateCalls[0]], results), lanes);
    expect(bandSettled(entries, new Set())).toBe(true);
    const failed = bandLanes(handOffCalls([delegateCalls[0]], results), [
      lanes[0],
    ]);
    expect(bandSettled(failed, new Set())).toBe(false);
    expect(bandSettled(failed, new Set(['d1']))).toBe(true);
  });

  it('formats timers and tokens', () => {
    expect(formatElapsed(42_000)).toBe('0:42');
    expect(formatElapsed(3_723_000)).toBe('1:02:03');
    expect(formatTokens(820)).toBe('820 tokens');
    expect(formatTokens(1500)).toBe('1.5k tokens');
    expect(formatTokens(12_400)).toBe('12k tokens');
  });

  it('maps every state to the character and words', () => {
    expect(laneView(lane('a', 'x', { status: 'queued' }), 'Scout').mascot).toBe(
      'receiving',
    );
    expect(laneView(lane('a', 'x'), 'Scout').mascot).toBe('working');
    expect(laneView(lane('a', 'x', { status: 'done' }), 'Scout').mascot).toBe(
      'complete',
    );
    expect(
      laneView(lane('a', 'x', { status: 'stopped' }), 'Scout'),
    ).toMatchObject({
      mascot: 'stopped',
      line: 'Stopped by you',
      stoppable: false,
    });
    expect(
      laneView(
        lane('a', 'x', { status: 'waiting', wait: { kind: 'stalled' } }),
        'Scout',
      ).line,
    ).toContain('Try again or stop');
  });

  it('keeps at most two live transcripts open, closing the oldest', () => {
    expect(MAX_LIVE_LANES).toBe(2);
    let open = toggleExpanded([], 'a');
    open = toggleExpanded(open, 'b');
    open = toggleExpanded(open, 'c');
    expect(open).toEqual(['b', 'c']);
    expect(toggleExpanded(open, 'b')).toEqual(['c']);
  });

  it("shows only the main chat's own errors (lanes report theirs too)", () => {
    expect(isOwnAgentError({ context: { agentId: 'chat-1' } }, 'chat-1')).toBe(
      true,
    );
    expect(
      isOwnAgentError({ context: { agentId: 'lane-child' } }, 'chat-1'),
    ).toBe(false);
    expect(isOwnAgentError({ context: {} }, 'chat-1')).toBe(true);
  });

  it('announces a lane at most once per two seconds, then its newest change', () => {
    const announcer = new LaneAnnouncer(2000);
    expect(announcer.offer('a', 'Scout: Working', 0)).toBe('Scout: Working');
    expect(announcer.offer('a', 'Scout: Opening website', 500)).toBeUndefined();
    expect(announcer.offer('a', 'Scout: Reading page', 900)).toBeUndefined();
    // Another lane has its own gap.
    expect(announcer.offer('b', 'Writer: Queued', 900)).toBe('Writer: Queued');
    expect(announcer.nextAt()).toBe(2000);
    expect(announcer.due(1500)).toEqual([]);
    expect(announcer.due(2000)).toEqual(['Scout: Reading page']);
    expect(announcer.due(5000)).toEqual([]);
    // The same text again says nothing new.
    expect(announcer.offer('a', 'Scout: Reading page', 6000)).toBeUndefined();
    expect(announcer.offer('a', 'Scout: Done', 6000)).toBe('Scout: Done');
  });
});

describe('the sidebar', () => {
  const chat = (
    id: string,
    extra: Partial<ConversationSummary> = {},
  ): ConversationSummary => ({
    id,
    dotId: 'lead',
    ownerId: 'owner',
    title: `Chat ${id}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    empty: false,
    ...extra,
  });
  const chats = [
    chat('parent'),
    chat('child', {
      dotId: 'marketer',
      title: 'Lead → Marketer: post',
      handedBy: { threadId: 'parent', dotId: 'lead' },
      running: true,
    }),
    chat('grandchild', {
      dotId: 'engineer',
      handedBy: { threadId: 'child', dotId: 'marketer' },
    }),
    chat('orphan', { handedBy: { threadId: 'gone', dotId: 'lead' } }),
  ];

  it('nests teammates’ chats under the chat that handed the work over', () => {
    const tree = nestChats(chats);
    expect(tree.roots.map((item) => item.id)).toEqual(['parent', 'orphan']);
    expect(tree.children.get('parent')?.map((item) => item.id)).toEqual([
      'child',
    ]);
    expect(tree.children.get('child')?.map((item) => item.id)).toEqual([
      'grandchild',
    ]);
    expect(workRunning(chats[0], tree)).toBe(true);
    expect(workRunning(chats[3], tree)).toBe(false);
  });

  it('renders nested rows with the child Dot and a pulse on running work', () => {
    const html = renderToStaticMarkup(
      <ThreadList
        chats={chats}
        dots={dots}
        query=""
        onSelect={() => {}}
        onRename={async () => true}
        onDelete={async () => true}
        onExport={async () => {}}
      />,
    );
    expect(html).toContain('sb-chat-nested');
    expect(html).toContain('Hide 1 teammate chat of Chat parent');
    expect(html).toContain('sb-chat-pulse');
    // The teammate's chat names its Dot (its mini character sits in the row) and its running work.
    expect(html).toContain(
      'aria-label="Lead → Marketer: post, Marketer, work running"',
    );
    // Searching lists everything flat.
    const flat = renderToStaticMarkup(
      <ThreadList
        chats={chats}
        dots={dots}
        query="chat"
        onSelect={() => {}}
        onRename={async () => true}
        onDelete={async () => true}
        onExport={async () => {}}
      />,
    );
    expect(flat).not.toContain('sb-chat-nested');
  });

  it('reads each Dot’s live state from mission control', () => {
    const states = liveStates({
      dots: [
        { id: 'a', state: 'working' },
        { id: 'b', state: 'needs-input' },
        { id: 'c', state: 'idle' },
      ] as never,
    });
    expect([...states]).toEqual([
      ['a', 'working'],
      ['b', 'needs-input'],
    ]);
  });
});
