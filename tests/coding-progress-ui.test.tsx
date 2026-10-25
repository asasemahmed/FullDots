import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventType } from '@ag-ui/core';
import type { AbstractAgent, AgentSubscriber } from '@ag-ui/client';
import {
  CodingProgress,
  useCodingProgress,
} from '../src/client/CodingProgress';

const roots: ReactTestRenderer[] = [];
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  vi.unstubAllGlobals();
});

function fakeAgent() {
  const subscribers: AgentSubscriber[] = [];
  const unsubscribe = vi.fn();
  const agent: Pick<AbstractAgent, 'subscribe'> = {
    subscribe(subscriber) {
      subscribers.push(subscriber);
      return { unsubscribe };
    },
  };
  return { agent, subscribers, unsubscribe };
}

function Harness({
  agent,
  threadId,
}: {
  agent: Pick<AbstractAgent, 'subscribe'>;
  threadId: string;
}) {
  return <CodingProgress progress={useCodingProgress(agent, threadId)} />;
}

const context = {
  agent: undefined as never,
  state: {},
  messages: [],
  input: {
    threadId: 'thread',
    runId: 'run',
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
  },
};
async function emit(
  subscriber: AgentSubscriber,
  value: unknown,
  name = 'coding_agent_progress',
) {
  await act(async () => {
    await subscriber.onCustomEvent?.({
      ...context,
      event: { type: EventType.CUSTOM, name, value },
    });
  });
}
async function fixture() {
  const f = fakeAgent();
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(<Harness agent={f.agent} threadId="thread-a" />);
  });
  roots.push(root);
  return {
    ...f,
    root,
    progress: () => root.root.findByType(CodingProgress).props.progress,
  };
}

it('updates one tool card per session instead of creating assistant bubbles', async () => {
  const f = await fixture();
  for (const text of ['one', 'onetwo', 'onetwothree', 'onetwothreefour'])
    await emit(f.subscribers[0], {
      codingSessionId: 'session',
      text,
      status: 'running',
    });
  expect(f.progress()).toHaveLength(1);
  expect(f.progress()[0].text).toBe('onetwothreefour');
  expect(f.root.root.findAllByType('details')).toHaveLength(1);
  expect(f.root.root.findByType('section').props['aria-label']).toBe(
    'Coding worker progress',
  );
  expect(
    f.root.root.findAll((node) => node.props.className === 'chat-bubble'),
  ).toHaveLength(0);
});

it('ignores other event names and rejects oversized or invalid snapshots', async () => {
  const f = await fixture();
  const good = { codingSessionId: 'session', text: 'text', status: 'running' };
  await emit(f.subscribers[0], good, 'unrelated');
  await emit(f.subscribers[0], { ...good, text: 'x'.repeat(40001) });
  await emit(f.subscribers[0], { ...good, status: 'unsafe' });
  await emit(f.subscribers[0], { ...good, codingSessionId: 'x'.repeat(201) });
  expect(f.progress()).toEqual([]);
});

it('bounds the list and replaces an existing session snapshot in place', async () => {
  const f = await fixture();
  for (let n = 0; n < 12; n++)
    await emit(f.subscribers[0], {
      codingSessionId: `s-${n}`,
      text: 'initial',
      status: 'completed',
    });
  await emit(f.subscribers[0], {
    codingSessionId: 's-7',
    text: 'new',
    status: 'completed',
  });
  expect(f.progress()).toHaveLength(10);
  expect(f.progress()[0].codingSessionId).toBe('s-2');
  expect(
    f
      .progress()
      .filter(
        (item: { codingSessionId: string }) => item.codingSessionId === 's-7',
      ),
  ).toEqual([{ codingSessionId: 's-7', text: 'new', status: 'completed' }]);
});

it('drops old conversation events and unsubscribes when switching threads', async () => {
  const f = await fixture();
  const old = f.subscribers[0];
  await emit(old, {
    codingSessionId: 'old',
    text: 'old thread',
    status: 'running',
  });
  await act(async () =>
    f.root.update(<Harness agent={f.agent} threadId="thread-b" />),
  );
  expect(f.unsubscribe).toHaveBeenCalledOnce();
  expect(f.progress()).toEqual([]);
  await emit(old, { codingSessionId: 'old', text: 'late', status: 'running' });
  expect(f.progress()).toEqual([]);
  await emit(f.subscribers[1], {
    codingSessionId: 'new',
    text: 'new thread',
    status: 'running',
  });
  expect(f.progress()[0].codingSessionId).toBe('new');
});

it('settles incomplete progress when the parent run ends without a final snapshot', async () => {
  const f = await fixture();
  await emit(f.subscribers[0], {
    codingSessionId: 'running',
    text: 'work',
    status: 'running',
  });
  await emit(f.subscribers[0], {
    codingSessionId: 'done',
    text: 'done',
    status: 'completed',
  });
  await act(async () => {
    await f.subscribers[0].onRunFailed?.({
      ...context,
      error: new Error('Fixture failure'),
    });
  });
  expect(f.progress().map((item: { status: string }) => item.status)).toEqual([
    'failed',
    'completed',
  ]);
  await act(async () => {
    await f.subscribers[0].onRunFinalized?.(context);
  });
  expect(f.progress().map((item: { status: string }) => item.status)).toEqual([
    'failed',
    'completed',
  ]);
});

it('escapes worker text in the progress details', () => {
  const html = renderToStaticMarkup(
    <CodingProgress
      progress={[
        {
          codingSessionId: 's',
          text: '<script>fixture()</script>',
          status: 'running',
        },
      ]}
    />,
  );
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).toContain('Coding worker');
});
