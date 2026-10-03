import { afterEach, expect, it, vi } from 'vitest';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { DotAgent } from '../src/server/dot-agent.js';
import { SqliteAgentRunner } from '../src/server/sqlite-runner.js';
import { runThreadTurn } from '../src/server/headless.js';
import { defaultLimits, NO_TIME_LIMIT_MS } from '../src/server/limits.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { completion } from './fixtures/model-stream.js';
import { FakeComputer, fakeTransport, page } from './fixtures/fake-computer.js';

const closers: Array<{ close(): void }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  closers.splice(0).forEach((closer) => closer.close());
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Request = Record<string, any>;

function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
  content?: string,
) {
  return completion(
    {
      role: 'assistant',
      ...(content ? { content } : {}),
      tool_calls: [
        {
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    'tool_calls',
  );
}
const text = (content: string) => completion({ role: 'assistant', content });
const createPage = (id = 'create-page') =>
  toolCall(id, 'create_space_page', { title: 'Notes', content: '# Notes' });

type Reply = (init: RequestInit | undefined) => Response | Promise<Response>;

/** Model requests are answered from a queue and recorded; computer requests go to the fake computer. */
function setup(
  options: {
    config?: Partial<PlatformConfig>;
    computer?: FakeComputer;
    replies?: Reply[];
  } = {},
) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const runner = new SqliteAgentRunner(':memory:');
  closers.push(store, workspace, runner);
  const dot = workspace.dots()[0];
  workspace.bindThread('thread', dot.id, 'TanStack');
  const fake = options.computer ?? new FakeComputer();
  const computerConfig = options.computer
    ? {
        computerSupervisorUrl: 'http://127.0.0.1:4312',
        computerSupervisorToken: 'supervisor-secret',
        computerToken: 'master-secret',
      }
    : {};
  if (options.computer)
    workspace.computers.patch(dot.id, {
      enabled: true,
      browser: true,
      files: true,
      shell: true,
    });
  const config: PlatformConfig = {
    apiKey: 'fixture',
    model: 'custom-model',
    baseUrl: 'https://unused.invalid/v1',
    voiceName: 'marin',
    ...computerConfig,
    ...options.config,
  };
  const agent = new DotAgent(store, workspace, config, dot.id);
  const requests: Request[] = [];
  const replies = [...(options.replies ?? [])];
  const computerFetch = fakeTransport(fake, dot.id);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (!String(input).startsWith('https://unused.invalid'))
      return computerFetch(input, init);
    requests.push(JSON.parse(String(init?.body)));
    const reply = replies.shift();
    if (!reply) throw new Error('Unexpected model request.');
    return reply(init);
  });
  const input: RunAgentInput = {
    threadId: 'thread',
    runId: 'run',
    state: {},
    context: [],
    messages: [{ id: 'user', role: 'user', content: 'Do the task.' }],
    tools: [],
    forwardedProps: {},
  };
  const run = (override: Partial<RunAgentInput> = {}) =>
    lastValueFrom(agent.run({ ...input, ...override }).pipe(toArray()));
  return {
    store,
    workspace,
    runner,
    dot,
    fake,
    config,
    agent,
    requests,
    input,
    run,
  };
}

const chunks = (events: BaseEvent[]) =>
  events.filter(
    (event) => event.type === EventType.TEXT_MESSAGE_CHUNK,
  ) as Array<BaseEvent & { messageId: string; delta: string }>;
const systemText = (request: Request) =>
  JSON.stringify(request.messages.filter((m: Request) => m.role === 'system'));

it('puts the line said before acting and the final answer in separate messages', async () => {
  const f = setup({
    replies: [
      () =>
        toolCall(
          'create-page',
          'create_space_page',
          { title: 'Notes', content: '# Notes' },
          'Let me create the page.',
        ),
      () => text('Created Notes.'),
    ],
  });
  const events = await f.run();
  const texts = chunks(events);
  expect(texts.map((chunk) => chunk.delta)).toEqual([
    'Let me create the page.',
    'Created Notes.',
  ]);
  const [first, second] = texts;
  expect(first.messageId).not.toBe(second.messageId);
  // The tool call stays attached to the message that introduced it.
  const start = events.find(
    (event) => event.type === EventType.TOOL_CALL_START,
  ) as BaseEvent & { parentMessageId: string };
  expect(start.parentMessageId).toBe(first.messageId);
});

it('keeps each tool call with the text that came right before it and starts a message for later text', async () => {
  const f = setup({
    replies: [
      () => toolCall('one', 'list_authorized_spaces', {}, 'First, the spaces.'),
      () => toolCall('two', 'list_authorized_spaces', {}, 'Now once more.'),
      () => toolCall('three', 'list_authorized_spaces', {}),
      () => text('All done.'),
    ],
  });
  const events = await f.run();
  const texts = chunks(events);
  expect(texts.map((chunk) => chunk.delta)).toEqual([
    'First, the spaces.',
    'Now once more.',
    'All done.',
  ]);
  expect(new Set(texts.map((chunk) => chunk.messageId)).size).toBe(3);
  const parents = Object.fromEntries(
    events
      .filter((event) => event.type === EventType.TOOL_CALL_START)
      .map((event) => {
        const start = event as BaseEvent & {
          toolCallId: string;
          parentMessageId: string;
        };
        return [start.toolCallId, start.parentMessageId];
      }),
  );
  expect(parents.one).toBe(texts[0].messageId);
  // A tool call without text of its own joins the message that is current.
  expect(parents.two).toBe(texts[1].messageId);
  expect(parents.three).toBe(texts[1].messageId);
});

it('stores a split turn as separate assistant messages that replay and continue consistently', async () => {
  const f = setup({
    replies: [
      () =>
        toolCall(
          'create-page',
          'create_space_page',
          { title: 'Notes', content: '# Notes' },
          'Let me create the page.',
        ),
      () => text('Created Notes.'),
      () => text('Anything else?'),
    ],
  });
  const reply = await runThreadTurn(
    f.runner,
    f.agent,
    'thread',
    'Create a page called Notes.',
    new AbortController().signal,
  );
  // A scheduled task or a call reads the last message, which is the answer.
  expect(reply).toBe('Created Notes.');
  const stored = f.runner.getThreadMessages('thread');
  expect(
    stored.map((message) => [
      message.role,
      message.role === 'assistant' ? message.content : undefined,
      message.role === 'assistant' ? message.toolCalls?.length : undefined,
    ]),
  ).toEqual([
    ['user', undefined, undefined],
    ['assistant', 'Let me create the page.', 1],
    ['tool', undefined, undefined],
    ['assistant', 'Created Notes.', undefined],
  ]);
  // A reconnecting client is sent the same two messages.
  const replayed = await lastValueFrom(
    f.runner.connect({ threadId: 'thread' }).pipe(toArray()),
  );
  expect(
    new Set(
      replayed
        .filter((event) => event.type === EventType.TEXT_MESSAGE_START)
        .map((event) => (event as BaseEvent & { messageId: string }).messageId),
    ).size,
  ).toBe(2);
  // The next turn gives the model the history in order, with every tool call answered.
  const next = await runThreadTurn(
    f.runner,
    new DotAgent(f.store, f.workspace, f.config, f.dot.id),
    'thread',
    'Thanks.',
    new AbortController().signal,
  );
  expect(next).toBe('Anything else?');
  const history = f.requests[2].messages
    .filter((message: Request) => message.role !== 'system')
    .map((message: Request) => message.role);
  expect(history).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
});

it('spends the last allowed step on a summary, without tools', async () => {
  const f = setup({
    config: { limits: { ...defaultLimits, agentMaxSteps: 3 } },
    replies: [
      () => createPage('a'),
      () => createPage('b'),
      () => text('I created two pages; nothing is left.'),
    ],
  });
  const events = await f.run();
  expect(f.requests).toHaveLength(3);
  for (const index of [0, 1]) {
    expect(f.requests[index].tools?.length).toBeGreaterThan(0);
    expect(systemText(f.requests[index])).not.toContain(
      'allowed for this turn',
    );
  }
  expect(f.requests[2].tools ?? []).toEqual([]);
  expect(systemText(f.requests[2])).toContain(
    'You have used all the steps allowed for this turn',
  );
  expect(chunks(events).at(-1)?.delta).toBe(
    'I created two pages; nothing is left.',
  );
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
});

it('keeps tools when the limit is a single step, which leaves no step to spare', async () => {
  const f = setup({
    config: { limits: { ...defaultLimits, agentMaxSteps: 1 } },
    replies: [() => text('Hello.')],
  });
  await f.run();
  expect(f.requests[0].tools?.length).toBeGreaterThan(0);
});

it('asks for a summary when the turn time limit passes, then finishes normally', async () => {
  const f = setup({
    config: {
      limits: { ...defaultLimits, agentTurnMs: 60, agentGraceMs: 5000 },
    },
    replies: [
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return createPage();
      },
      () => text('I ran out of time after creating the page.'),
    ],
  });
  const events = await f.run();
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1].tools ?? []).toEqual([]);
  expect(systemText(f.requests[1])).toContain(
    'The time allowed for this turn has run out',
  );
  expect(chunks(events).at(-1)?.delta).toBe(
    'I ran out of time after creating the page.',
  );
  expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
    false,
  );
});

it('stops a turn that cannot summarize in time and says why instead of leaving a cut-off reply', async () => {
  const f = setup({
    config: {
      limits: { ...defaultLimits, agentTurnMs: 40, agentGraceMs: 40 },
    },
    replies: [
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            {
              once: true,
            },
          );
        }),
    ],
  });
  const events = await f.run();
  const notice = chunks(events).at(-1);
  expect(notice?.delta).toMatch(
    /stopped because this turn reached its time limit/,
  );
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
    false,
  );
});

it('records the time-limit notice as the final message of the turn, so a scheduled task reports it', async () => {
  const f = setup({
    config: {
      limits: { ...defaultLimits, agentTurnMs: 40, agentGraceMs: 40 },
    },
    replies: [
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    ],
  });
  const reply = await runThreadTurn(
    f.runner,
    f.agent,
    'thread',
    'Do the task.',
    new AbortController().signal,
  );
  expect(reply).toMatch(/stopped because this turn reached its time limit/);
  expect(f.runner.getThreadMessages('thread').at(-1)?.role).toBe('assistant');
});

it('sets no timer at all when the turn has no time limit', async () => {
  const delays: unknown[] = [];
  const original = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    handler: TimerHandler,
    delay?: number,
    ...args: unknown[]
  ) => {
    delays.push(delay);
    return original(handler as () => void, delay, ...args);
  }) as typeof setTimeout);
  const f = setup({
    config: {
      limits: {
        ...defaultLimits,
        agentTurnMs: NO_TIME_LIMIT_MS,
        agentGraceMs: 12_345,
      },
    },
    replies: [() => text('Hello.')],
  });
  await f.run();
  // Not the turn limit, and not the grace period that follows it.
  for (const delay of [NO_TIME_LIMIT_MS, 12_345, NO_TIME_LIMIT_MS + 12_345])
    expect(delays).not.toContain(delay);
});

it('teaches the model to work through the page it gets back, and offers the select tool', async () => {
  const computer = new FakeComputer();
  const f = setup({
    computer,
    replies: [() => text('Hello.')],
  });
  await f.run();
  const names = f.requests[0].tools.map((tool: Request) => tool.function.name);
  expect(names).toEqual(
    expect.arrayContaining(['computer_select', 'computer_snapshot']),
  );
  const prompt = systemText(f.requests[0]);
  for (const expected of [
    'plan briefly',
    'returns a fresh `page`',
    'instead of calling computer_snapshot again',
    'Use computer_select for dropdowns',
    'more than twice',
    'owner has taken control',
    'last one is kept for your summary',
    'what is left',
  ])
    expect(prompt).toContain(expected);
  // Without a computer the guidance is absent.
  const plain = setup({ replies: [() => text('Hello.')] });
  await plain.run();
  expect(systemText(plain.requests[0])).not.toContain('computer_select');
});

it('never sends a screenshot image to the model, now or from stored history', async () => {
  const computer = new FakeComputer();
  computer.pages['https://form.test/'] = page('Form', [
    { ref: 'e1', role: 'textbox', name: 'Name' },
  ]);
  const f = setup({
    computer,
    replies: [
      () => toolCall('nav', 'computer_navigate', { url: 'https://form.test/' }),
      () => toolCall('shot', 'computer_screenshot', {}),
      () => text('The form has a Name field.'),
    ],
  });
  const events = await f.run();
  expect(f.requests).toHaveLength(3);
  expect(JSON.stringify(f.requests)).not.toContain('iVBORw0KGgo');
  // The page that came back with the navigation is what the model works from.
  expect(JSON.stringify(f.requests[1])).toContain('\\"ref\\":\\"e1\\"');
  expect(JSON.stringify(f.requests[2])).toContain(
    'not included in this result',
  );
  const results = events.filter(
    (event) => event.type === EventType.TOOL_CALL_RESULT,
  ) as Array<BaseEvent & { content: string }>;
  expect(results).toHaveLength(2);
  expect(results.map((result) => result.content).join('')).not.toContain(
    'iVBORw0KGgo',
  );

  // A conversation saved before this change still holds an image; it is not sent again.
  const history = setup({ replies: [() => text('Hello.')] });
  await history.run({
    messages: [
      { id: 'u1', role: 'user', content: 'Look at it.' },
      {
        id: 'a1',
        role: 'assistant',
        toolCalls: [
          {
            id: 'old-shot',
            type: 'function',
            function: { name: 'computer_screenshot', arguments: '{}' },
          },
        ],
      },
      {
        id: 't1',
        role: 'tool',
        toolCallId: 'old-shot',
        content: JSON.stringify({
          base64: 'iVBORw0KGgo'.repeat(6000),
          width: 1280,
          url: 'https://form.test/',
        }),
      },
      { id: 'u2', role: 'user', content: 'And now?' },
    ],
  });
  const sent = JSON.stringify(history.requests[0]);
  expect(sent).not.toContain('iVBORw0KGgo');
  expect(sent).toContain('https://form.test/');
});

it('lets the model fill a form from the page each action returns, with no extra snapshots', async () => {
  const computer = new FakeComputer();
  computer.pages['https://form.test/'] = page('Form', [
    { ref: 'e1', role: 'textbox', name: 'Name' },
    { ref: 'e2', role: 'button', name: 'Submit' },
  ]);
  const f = setup({
    computer,
    replies: [
      () =>
        toolCall(
          'nav',
          'computer_navigate',
          { url: 'https://form.test/' },
          'Opening the form.',
        ),
      () =>
        toolCall('type', 'computer_type', {
          ref: 'e1',
          snapshotId: computer.snapshotId,
          text: 'Ada',
        }),
      () => text('Typed the name.'),
    ],
  });
  await f.run();
  // navigate + its page, then type + its page: the model never called computer_snapshot.
  expect(computer.calls).toEqual(['navigate', 'snapshot', 'type', 'snapshot']);
});
