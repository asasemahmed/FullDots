import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@ag-ui/core';
import {
  ReplayView,
  type ReplayViewProps,
} from '../src/client/computer-panel/ReplayView';
import {
  mergeReplay,
  nextIndex,
  replayTurns,
  stepText,
  transcriptReplaySteps,
  type ReplayEntry,
} from '../src/client/computer-panel/replay-model';
import { takeOverHere } from '../src/client/computer-panel/take-over';
import {
  PanelView,
  type PanelActions,
} from '../src/client/computer-panel/PanelView';
import { ApprovalCard } from '../src/client/ApprovalCard';
import type { ComputerStatus, ReplayStep } from '../src/shared/computer-types';
import type { Dot } from '../src/shared/types';

// The API module reads the session token the moment it loads, and there is no browser here.
vi.hoisted(() => {
  Object.assign(globalThis, {
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
});

const entry = (over: Partial<ReplayEntry> = {}): ReplayEntry => ({
  toolCallId: 'call-1',
  action: 'navigate',
  label: 'Opening website',
  detail: 'example.com',
  url: 'https://example.com/',
  title: 'Example',
  state: 'done',
  message: '',
  turn: 1,
  ...over,
});
const replay = (over: Partial<ReplayViewProps> = {}) =>
  renderToStaticMarkup(
    <ReplayView
      dotName="Scout"
      entries={[
        entry(),
        entry({
          toolCallId: 'call-2',
          action: 'click',
          label: 'Clicking in browser',
          detail: 'button “Save”',
          state: 'failed',
          message: 'That element reference was out of date.',
        }),
      ]}
      hasThread
      onJumpToLive={() => {}}
      {...over}
    />,
  );

describe('replay view', () => {
  it('is a slider over the steps that works without any pictures', () => {
    const html = replay();
    expect(html).toContain('role="slider"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-valuemin="1"');
    expect(html).toContain('aria-valuemax="2"');
    // The latest step first.
    expect(html).toContain('aria-valuenow="2"');
    expect(html).toContain(
      'aria-valuetext="Step 2 of 2: Clicking in browser, button “Save”"',
    );
    expect(html).toContain('No picture was kept for this step.');
    expect(html).not.toContain('<img');
    expect(html).toContain('Did not work');
    expect(html).toContain('That element reference was out of date.');
    expect(html).toContain('Jump to live');
    expect(html).toContain('aria-label="Previous step"');
    expect(html).toMatch(/aria-label="Next step"[^>]*disabled/);
  });

  it('shows the address, title and picture of the chosen step', () => {
    const html = replay({
      index: 0,
      entries: [entry({ frameId: 'frame-1' }), entry({ toolCallId: 'call-2' })],
      frameUrl: (id) => (id === 'frame-1' ? 'blob:frame-1' : undefined),
    });
    expect(html).toContain('aria-valuenow="1"');
    expect(html).toContain('src="blob:frame-1"');
    expect(html).toContain(
      'alt="The screen after step 1: Opening website, example.com"',
    );
    expect(html).toContain('Example');
    expect(html).toContain('example.com');
    expect(html).toContain('Done');
    expect(html).toMatch(/aria-label="Previous step"[^>]*disabled/);
  });

  it('waits for a kept picture instead of saying there is none', () => {
    const html = replay({
      entries: [entry({ frameId: 'frame-1' })],
      frameUrl: () => undefined,
    });
    expect(html).toContain('Loading the picture…');
  });

  it('says what is missing when there is nothing to replay', () => {
    expect(replay({ hasThread: false })).toContain(
      'Open a conversation with Scout',
    );
    const none = replay({ entries: [] });
    expect(none).toContain(
      'Scout has not used the browser in this conversation yet.',
    );
    expect(none).not.toContain('role="slider"');
    expect(none).toContain('Jump to live');
    expect(replay({ entries: [], loading: true })).toContain(
      'Loading the steps…',
    );
  });

  it('offers the turns of the conversation, latest first chosen', () => {
    const html = replay({
      entries: [entry(), entry({ toolCallId: 'call-2', turn: 2 })],
    });
    expect(html).toContain('Latest request (2)');
    expect(html).toContain('Request 1');
    expect(html).toContain('Whole conversation');
    expect(html).toContain('aria-valuemax="1"');
    expect(
      replay({
        turn: 0,
        entries: [entry(), entry({ toolCallId: 'call-2', turn: 2 })],
      }),
    ).toContain('aria-valuemax="2"');
  });

  it('says when pictures are off and links to settings', () => {
    const html = replay({ replayOn: false, onOpenSettings: () => {} });
    expect(html).toContain('Pictures of new steps are off for Scout.');
    expect(html).toContain('Settings');
    expect(replay({ replayOn: true })).not.toContain('Pictures of new steps');
  });

  it('moves with the arrow keys, Page keys, Home and End', () => {
    expect(nextIndex('ArrowRight', 0, 3)).toBe(1);
    expect(nextIndex('ArrowUp', 2, 3)).toBe(2);
    expect(nextIndex('ArrowLeft', 0, 3)).toBe(0);
    expect(nextIndex('ArrowDown', 2, 3)).toBe(1);
    expect(nextIndex('Home', 2, 3)).toBe(0);
    expect(nextIndex('End', 0, 3)).toBe(2);
    expect(nextIndex('PageUp', 0, 10)).toBe(5);
    expect(nextIndex('PageDown', 3, 10)).toBe(0);
    expect(nextIndex('a', 0, 3)).toBeUndefined();
    expect(nextIndex('End', 0, 0)).toBeUndefined();
    expect(stepText(entry(), 0, 3)).toBe(
      'Step 1 of 3: Opening website, example.com',
    );
  });
});

describe('replay steps', () => {
  const call = (id: string, name: string, args: unknown) => ({
    id,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  });
  const messages: Message[] = [
    { id: 'u1', role: 'user', content: 'Open the form' },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      toolCalls: [
        call('nav', 'computer_navigate', { url: 'https://form.test/' }),
        call('search', 'computer_search', { query: 'fulldots' }),
        call('files', 'computer_files_list', {}),
        call('web', 'search_web', { query: 'x' }),
      ],
    },
    {
      id: 't1',
      role: 'tool',
      toolCallId: 'nav',
      content: JSON.stringify({
        url: 'https://form.test/',
        page: { url: 'https://form.test/', title: 'Form', elements: [] },
      }),
    },
    {
      id: 't1b',
      role: 'tool',
      toolCallId: 'search',
      content: JSON.stringify({
        action: 'search',
        query: 'fulldots',
        url: 'https://duckduckgo.com/?q=fulldots',
        title: 'fulldots at DuckDuckGo',
        results: [],
      }),
    },
    { id: 'u2', role: 'user', content: 'Fill it in' },
    {
      id: 'a2',
      role: 'assistant',
      content: '',
      toolCalls: [
        call('type', 'computer_type', {
          ref: 'e1',
          snapshotId: 1,
          text: 'Ada',
        }),
      ],
    },
    {
      id: 't2',
      role: 'tool',
      toolCallId: 'type',
      content: JSON.stringify({
        error: 'Nothing was typed.',
        page: { url: 'https://form.test/', title: 'Form' },
      }),
    },
  ];

  it('come from the chat’s browser tool calls, numbered by request', () => {
    const steps = transcriptReplaySteps(messages);
    expect(steps).toEqual([
      expect.objectContaining({
        toolCallId: 'nav',
        action: 'navigate',
        label: 'Opening website',
        detail: 'form.test',
        url: 'https://form.test/',
        title: 'Form',
        state: 'done',
        turn: 1,
      }),
      expect.objectContaining({
        toolCallId: 'search',
        action: 'search',
        label: 'Searching the web',
        detail: '“fulldots”',
        url: 'https://duckduckgo.com/?q=fulldots',
        title: 'fulldots at DuckDuckGo',
        state: 'done',
        turn: 1,
      }),
      expect.objectContaining({
        toolCallId: 'type',
        action: 'type',
        state: 'failed',
        message: 'Nothing was typed.',
        turn: 2,
      }),
    ]);
    expect(replayTurns(steps)).toEqual([1, 2]);
  });

  it('take pictures from the server by tool call and add steps only it knows', () => {
    const server: ReplayStep[] = [
      {
        id: 'frame-nav',
        toolCallId: 'nav',
        createdAt: 10,
        action: 'navigate',
        url: 'https://form.test/',
        title: 'Form',
        outcome: 'succeeded',
        hasFrame: true,
      },
      {
        id: 'row-type',
        toolCallId: 'type',
        createdAt: 20,
        action: 'type',
        url: '',
        title: '',
        outcome: 'failed',
        hasFrame: false,
      },
      {
        id: 'frame-old',
        toolCallId: 'older',
        createdAt: 5,
        action: 'scroll',
        url: 'https://elsewhere.test/a',
        title: '',
        outcome: 'succeeded',
        hasFrame: true,
      },
    ];
    const merged = mergeReplay(transcriptReplaySteps(messages), server);
    expect(merged.map((step) => [step.toolCallId, step.frameId])).toEqual([
      ['nav', 'frame-nav'],
      ['search', undefined],
      ['type', undefined],
      ['older', 'frame-old'],
    ]);
    expect(merged[3]).toMatchObject({
      label: 'Scrolling page',
      detail: 'elsewhere.test/a',
      state: 'done',
      turn: 0,
    });
    // Without a transcript the server's steps stand on their own, oldest first.
    expect(mergeReplay([], server).map((step) => step.toolCallId)).toEqual([
      'older',
      'nav',
      'type',
    ]);
  });
});

describe('take over', () => {
  it('opens the computer, then requests control, in one click', async () => {
    const order: string[] = [];
    const open = vi.fn(() => order.push('open'));
    const take = vi.fn(async (dotId: string) => {
      order.push(`take ${dotId}`);
    });
    await takeOverHere({ dotId: 'dot-1', open, take });
    expect(order).toEqual(['open', 'take dot-1']);
  });

  it('still shows the computer when control could not be taken', async () => {
    const open = vi.fn();
    await expect(
      takeOverHere({
        dotId: 'dot-1',
        open,
        take: async () => {
          throw new Error('Start this Dot’s computer first.');
        },
      }),
    ).rejects.toThrow('Start this Dot’s computer first.');
    expect(open).toHaveBeenCalledOnce();
  });

  it('puts "Take over here" on the chat’s handoff card', () => {
    const result = {
      status: 'handoff' as const,
      handoffId: 'h1',
      kind: 'credential' as const,
      reason: 'Sign in to GitHub',
    };
    const html = renderToStaticMarkup(
      <ApprovalCard
        result={result}
        onViewComputer={() => {}}
        onTakeOver={async () => {}}
      />,
    );
    expect(html).toContain('Take over here');
    expect(html).toContain('Open live computer');
    expect(html.indexOf('Open live computer')).toBeLessThan(
      html.indexOf('Take over here'),
    );
    expect(
      renderToStaticMarkup(
        <ApprovalCard result={result} onViewComputer={() => {}} />,
      ),
    ).not.toContain('Take over here');
  });
});

describe('panel tabs', () => {
  const dot: Dot = {
    id: 'dot-1',
    spaceId: 'space',
    spaceIds: ['space'],
    name: 'Scout',
    instructions: '',
    researchAllowed: true,
    memoryAllowed: true,
    createdAt: 0,
  };
  const status: ComputerStatus = {
    configured: true,
    state: 'running',
    permissions: { enabled: true, browser: true, files: false, shell: false },
    audit: [],
    control: {
      holder: 'bot',
      requested: false,
      transitioning: false,
      resumeSnapshotRequired: false,
    },
  };
  const actions = new Proxy({}, { get: () => vi.fn() }) as PanelActions;
  const panel = (over: Partial<Parameters<typeof PanelView>[0]> = {}) =>
    renderToStaticMarkup(
      <PanelView
        dot={dot}
        status={status}
        loadFailed={false}
        error=""
        onDismissError={() => {}}
        busy={false}
        stream={{ phase: 'connecting' }}
        streamKey={0}
        snapshotError=""
        optimistic={{}}
        notes={{}}
        actions={actions}
        {...over}
      />,
    );

  it('offers Live and Replay, live first', () => {
    const html = panel();
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Live/);
    expect(html).toMatch(/role="tab"[^>]*aria-selected="false"[^>]*>Replay/);
    expect(html).toContain('computer-screen-live');
  });

  it('shows the replay with the live screen kept but hidden', () => {
    const html = panel({ initialView: 'replay', threadId: 'thread' });
    expect(html).toContain('Scout has not used the browser');
    expect(html).toMatch(/class="cp-live"[^>]*hidden/);
    expect(panel({ initialView: 'replay' })).toContain(
      'Open a conversation with Scout',
    );
  });
});
