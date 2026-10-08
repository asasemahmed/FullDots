import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ChatTranscript,
  isInternalVoiceReceipt,
} from '../src/client/ChatTranscript';
import { ComputerAutoOpen } from '../src/client/chat-turns';
import { ComputerActivity } from '../src/client/ComputerActivity';
import { describeComputerSteps } from '../src/client/ComputerToolCard';
import type { Message } from '@ag-ui/core';
it('keeps call receipts between the anchored message and later conversation turns', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[
        { id: 'before', role: 'user', content: 'Before the call' },
        { id: 'after', role: 'assistant', content: 'Later message' },
      ]}
      calls={[
        {
          id: 'call',
          threadId: 'thread',
          status: 'ended',
          startedAt: 1000,
          endedAt: 6000,
          transcript: '',
          error: null,
          anchorMessageId: 'before',
        },
      ]}
    />,
  );
  expect(html.indexOf('Before the call')).toBeLessThan(
    html.indexOf('Call ended'),
  );
  expect(html.indexOf('Call ended')).toBeLessThan(
    html.indexOf('Later message'),
  );
});

const toolCall = (name: string, args: unknown = {}, id = name) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});
const toolResult = (toolCallId: string, content: unknown): Message => ({
  id: `result-${toolCallId}`,
  role: 'tool',
  toolCallId,
  content: typeof content === 'string' ? content : JSON.stringify(content),
});
const blocks = (html: string) =>
  (html.match(/class="chat-activity[ "]/g) ?? []).length;
const withoutResults = (messages: Message[]) =>
  messages.filter((message) => message.role !== 'tool');

it('renders a computer-only assistant message as one block between chat turns without printing tool JSON', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[
        { id: 'request', role: 'user', content: 'Open the website' },
        {
          id: 'tool-call',
          role: 'assistant',
          toolCalls: [
            toolCall('computer_navigate', { url: 'https://example.com' }),
          ],
        },
        { id: 'reply', role: 'assistant', content: 'Here is the summary' },
      ]}
      calls={[]}
    />,
  );
  expect(html.indexOf('Open the website')).toBeLessThan(
    html.indexOf('chat-activity'),
  );
  expect(html.indexOf('chat-activity')).toBeLessThan(
    html.indexOf('Here is the summary'),
  );
  expect(html).not.toContain('undefined');
  expect(html).not.toContain('computer_navigate');
});

it('renders many consecutive computer calls as one collapsed block', () => {
  const ids = Array.from({ length: 24 }, (_, index) => `step-${index}`);
  const messages: Message[] = [
    { id: 'request', role: 'user', content: 'Fill in the form' },
    {
      id: 'run',
      role: 'assistant',
      content: 'All done.',
      toolCalls: ids.map((id, index) =>
        toolCall(
          index % 2 ? 'computer_type' : 'computer_click',
          { ref: 'r', snapshotId: 1, text: 'Ahmed' },
          id,
        ),
      ),
    },
    ...ids.map((id) => toolResult(id, { action: 'ok' })),
  ];
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={withoutResults(messages)}
      allMessages={messages}
      calls={[]}
      dotName="Scout"
    />,
  );
  expect(blocks(html)).toBe(1);
  expect(html).toContain('Used the computer');
  expect(html).toContain('24 steps');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('chat-activity-steps');
  expect(html).not.toContain('Typing in browser');
  expect(html.indexOf('chat-activity')).toBeLessThan(html.indexOf('All done.'));
});

it('merges computer calls that a turn splits across consecutive assistant messages', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[
        { id: 'request', role: 'user', content: 'Look it up' },
        {
          id: 'first',
          role: 'assistant',
          content: 'Let me look.',
          toolCalls: [toolCall('computer_navigate', { url: 'https://a.test' })],
        },
        {
          id: 'second',
          role: 'assistant',
          toolCalls: [toolCall('computer_snapshot'), toolCall('computer_read')],
        },
        { id: 'third', role: 'assistant', content: 'Found it.' },
      ]}
      calls={[]}
    />,
  );
  expect(blocks(html)).toBe(1);
  expect(html).toContain('3 steps');
  // Earlier messages keep their text before their actions; the reply comes last.
  expect(html.indexOf('Let me look.')).toBeLessThan(
    html.indexOf('chat-activity'),
  );
  expect(html.indexOf('chat-activity')).toBeLessThan(html.indexOf('Found it.'));
});

it('keeps blocks of different turns apart', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[
        { id: 'u1', role: 'user', content: 'First' },
        {
          id: 'a1',
          role: 'assistant',
          toolCalls: [toolCall('computer_navigate', {}, 'n1')],
        },
        { id: 'u2', role: 'user', content: 'Second' },
        {
          id: 'a2',
          role: 'assistant',
          toolCalls: [toolCall('computer_navigate', {}, 'n2')],
        },
      ]}
      calls={[]}
    />,
  );
  expect(blocks(html)).toBe(2);
});

it('renders the reply below the actions when one message holds both', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[
        { id: 'request', role: 'user', content: 'Check the site' },
        {
          id: 'run',
          role: 'assistant',
          content: 'The final answer is 42.',
          toolCalls: [
            toolCall('computer_navigate', { url: 'https://example.com' }),
            toolCall('computer_snapshot'),
          ],
        },
      ]}
      calls={[]}
    />,
  );
  expect(html.indexOf('chat-activity')).toBeGreaterThan(-1);
  expect(html.indexOf('chat-activity')).toBeLessThan(
    html.indexOf('The final answer is 42.'),
  );
});

it('keeps other tools rendering through renderTools, with the review card after the reply', () => {
  const seen: string[][] = [];
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[
        { id: 'request', role: 'user', content: 'Draft a page' },
        {
          id: 'run',
          role: 'assistant',
          content: 'Please review the draft.',
          toolCalls: [
            toolCall('computer_navigate'),
            toolCall('review_space_page', { title: 'Brief' }),
          ],
        },
      ]}
      calls={[]}
      renderTools={(message) => {
        seen.push(message.toolCalls?.map((call) => call.function.name) ?? []);
        return <section>Review card</section>;
      }}
    />,
  );
  expect(seen).toEqual([['review_space_page']]);
  expect(html.indexOf('chat-activity')).toBeLessThan(
    html.indexOf('Please review the draft.'),
  );
  expect(html.indexOf('Please review the draft.')).toBeLessThan(
    html.indexOf('Review card'),
  );
});

it('shows the working state and a live-view button only while the run is active', () => {
  const messages: Message[] = [
    { id: 'request', role: 'user', content: 'Go' },
    {
      id: 'run',
      role: 'assistant',
      toolCalls: [
        toolCall('computer_navigate', { url: 'https://example.com' }, 'a'),
        toolCall('computer_type', { ref: 'r', snapshotId: 1, text: 'x' }, 'b'),
      ],
    },
    toolResult('a', { url: 'https://example.com' }),
  ];
  const live = renderToStaticMarkup(
    <ChatTranscript
      messages={withoutResults(messages)}
      allMessages={messages}
      calls={[]}
      running
      onViewComputer={() => {}}
    />,
  );
  expect(live).toContain('Using the computer');
  expect(live).toContain('Typing in browser');
  expect(live).toContain('2 steps');
  expect(live).toContain('View live');
  const stopped = renderToStaticMarkup(
    <ChatTranscript
      messages={withoutResults(messages)}
      allMessages={messages}
      calls={[]}
    />,
  );
  expect(stopped).toContain('Used the computer');
  expect(stopped).toContain('stopped');
  expect(stopped).not.toContain('View live');
});

it('does not render screenshots or base64 in the transcript', () => {
  const base64 = 'iVBORw0KGgo'.repeat(500);
  const messages: Message[] = [
    { id: 'request', role: 'user', content: 'Look' },
    {
      id: 'run',
      role: 'assistant',
      toolCalls: [toolCall('computer_screenshot')],
    },
    toolResult('computer_screenshot', { base64, url: 'https://example.com' }),
  ];
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={withoutResults(messages)}
      allMessages={messages}
      calls={[]}
    />,
  );
  expect(html).not.toContain('<img');
  expect(html).not.toContain('iVBORw0KGgo');
});

it('opens the computer panel once per turn and never for loaded history', () => {
  const old: Message[] = [
    { id: 'u0', role: 'user', content: 'Earlier' },
    {
      id: 'a0',
      role: 'assistant',
      toolCalls: [toolCall('computer_navigate', {}, 'old')],
    },
  ];
  const tracker = new ComputerAutoOpen();
  // History loaded on page load: no turn has begun.
  expect(tracker.shouldOpen(old)).toBe(false);
  const turn: Message[] = [...old, { id: 'u1', role: 'user', content: 'Now' }];
  tracker.beginTurn(turn);
  expect(tracker.shouldOpen(turn)).toBe(false);
  const reply = {
    id: 'a1',
    role: 'assistant' as const,
    toolCalls: [toolCall('search_web', {}, 'search')],
  };
  expect(tracker.shouldOpen([...turn, reply])).toBe(false);
  reply.toolCalls.push(toolCall('computer_navigate', {}, 'new'));
  expect(tracker.shouldOpen([...turn, reply])).toBe(true);
  reply.toolCalls.push(toolCall('computer_click', {}, 'newer'));
  expect(tracker.shouldOpen([...turn, reply])).toBe(false);
  tracker.endTurn();
  const next: Message[] = [
    ...turn,
    reply,
    { id: 'u2', role: 'user', content: 'Again' },
  ];
  tracker.beginTurn(next);
  expect(tracker.shouldOpen(next)).toBe(false);
  expect(
    tracker.shouldOpen([
      ...next,
      {
        id: 'a2',
        role: 'assistant',
        toolCalls: [toolCall('computer_scroll', {}, 'again')],
      },
    ]),
  ).toBe(true);
});

it('hides only marked receipt prompts while retaining summaries and prior unmarked messages', () => {
  const messages: Message[] = [
    { id: 'legacy', role: 'user', content: 'Earlier unmarked receipt prompt' },
    {
      id: 'internal',
      role: 'user',
      content: 'Internal sync instructions',
      metadata: { opendotsSource: 'voice_receipt' },
    },
    {
      id: 'opendots:voice_receipt:durable',
      role: 'user',
      content: 'Persisted internal instructions without metadata',
    },
    {
      id: 'summary',
      role: 'assistant',
      content: 'Confirmed call summary',
      metadata: { opendotsSource: 'voice_receipt' },
    },
    {
      id: 'user',
      role: 'user',
      content: 'My next question',
      metadata: { opendotsSource: 'voice_compute' },
    },
  ];
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={messages.filter((message) => !isInternalVoiceReceipt(message))}
      calls={[]}
    />,
  );
  expect(html).not.toContain('Internal sync instructions');
  expect(html).not.toContain(
    'Persisted internal instructions without metadata',
  );
  expect(html).toContain('Earlier unmarked receipt prompt');
  expect(html).toContain('Confirmed call summary');
  expect(html).toContain('My next question');
});

it('renders a server-started turn as an event line instead of the owner bubble', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[
        {
          id: 'task-turn',
          role: 'user',
          content: 'Check the inbox',
          metadata: { source: 'task', ref: 't1' },
        },
      ]}
      calls={[]}
    />,
  );
  expect(html).toContain('chat-event');
  expect(html).toContain('Scheduled task');
  expect(html).toContain('Check the inbox');
  expect(html).not.toContain('chat-bubble user');
});

it('keeps a plain user message rendered as the owner bubble', () => {
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={[{ id: 'typed', role: 'user', content: 'Hello there' }]}
      calls={[]}
    />,
  );
  expect(html).toContain('chat-bubble user');
  expect(html).toContain('Hello there');
  expect(html).not.toContain('chat-event');
});

it('draws the approval card after the activity block of the call it paused', () => {
  const messages: Message[] = [
    { id: 'request', role: 'user', content: 'Clean up' },
    {
      id: 'run',
      role: 'assistant',
      content: 'I need your approval first.',
      toolCalls: [toolCall('computer_exec', { command: 'rm -rf build' })],
    },
    toolResult('computer_exec', {
      status: 'pending_approval',
      approvalId: 'a1',
      summary: 'Delete the folder',
      exact: 'rm -rf build',
    }),
  ];
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={withoutResults(messages)}
      allMessages={messages}
      calls={[]}
      onDecide={async () => {}}
    />,
  );
  expect(blocks(html)).toBe(1);
  expect(html.indexOf('chat-activity')).toBeLessThan(
    html.indexOf('approval-card'),
  );
  expect(html).toMatch(/Dot(&#x27;|&apos;|')s description/);
  expect(html).toContain('Delete the folder');
  expect(html).toContain('Exact action');
  expect(html).toContain('rm -rf build</pre>');
  expect(html).toContain('>Approve<');
  expect(html).toContain('>Deny<');
  expect(html).toContain('Waiting for you');
});

it('shows the status of an approval from its live row', () => {
  const messages: Message[] = [
    { id: 'request', role: 'user', content: 'Clean up' },
    {
      id: 'run',
      role: 'assistant',
      toolCalls: [toolCall('request_approval', {}, 'ask')],
    },
    toolResult('ask', {
      status: 'pending_approval',
      approvalId: 'a2',
      summary: 'Send the email',
      exact: '',
      advisory: true,
    }),
  ];
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={withoutResults(messages)}
      allMessages={messages}
      calls={[]}
      onDecide={async () => {}}
      approvals={
        new Map([
          [
            'a2',
            {
              id: 'a2',
              threadId: 't',
              dotId: 'd',
              toolCallId: 'ask',
              tool: 'request_approval',
              argsHash: null,
              summary: 'Send the email',
              argsRedacted: '',
              status: 'denied',
              note: 'Not today',
              createdAt: 1,
              expiresAt: 2,
              decidedAt: 1,
              consumedAt: null,
            },
          ],
        ])
      }
    />,
  );
  expect(blocks(html)).toBe(0);
  expect(html).toContain('>Advisory<');
  expect(html).toContain('Denied');
  expect(html).toContain('Not today');
  expect(html).not.toContain('>Approve<');
});

it('renders a handoff result as a card with an Open live computer button', () => {
  const messages: Message[] = [
    { id: 'request', role: 'user', content: 'Sign in' },
    {
      id: 'run',
      role: 'assistant',
      toolCalls: [toolCall('computer_type', { ref: 'r1', text: 'x' })],
    },
    toolResult('computer_type', {
      status: 'handoff',
      handoffId: 'h1',
      kind: 'credential',
      reason: 'Enter your password',
    }),
  ];
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={withoutResults(messages)}
      allMessages={messages}
      calls={[]}
      onViewComputer={() => {}}
    />,
  );
  expect(html).toContain('Your turn on the computer');
  expect(html).toContain('Enter your password');
  expect(html).toContain('never paste it into the chat');
  expect(html).toContain('Open live computer');
});

it('folds connector tool calls into the activity block with a connector label', () => {
  const messages: Message[] = [
    { id: 'request', role: 'user', content: 'Check the issue' },
    {
      id: 'run',
      role: 'assistant',
      content: 'Done.',
      toolCalls: [
        toolCall('mcp__github__get_issue', { number: 4 }, 'issue'),
        toolCall('computer_snapshot', {}, 'snap'),
      ],
    },
    toolResult('issue', { content: 'Issue 4: crash on start' }),
    toolResult('snap', { elements: [] }),
  ];
  const html = renderToStaticMarkup(
    <ChatTranscript
      messages={withoutResults(messages)}
      allMessages={messages}
      calls={[]}
    />,
  );
  expect(blocks(html)).toBe(1);
  expect(html).toContain('Used the computer');
  expect(html).toContain('2 steps');
  const open = renderToStaticMarkup(
    <ComputerActivity
      steps={describeComputerSteps(
        [
          {
            id: 'issue',
            name: 'mcp__github__get_issue',
            arguments: '{"number":4}',
          },
        ],
        new Map([['issue', JSON.stringify({ content: 'Issue 4: crash' })]]),
        false,
      )}
      live={false}
      dotName="Scout"
      defaultExpanded
    />,
  );
  expect(open).toContain('Using github');
  expect(open).toContain('Issue 4: crash');
});
