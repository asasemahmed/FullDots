// P9 message actions in the client: retry metadata and folding, the bubble toolbar, the pinned
// bar, earlier attempts in the transcript and the branch hint in the sidebar.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({ api: vi.fn() }));
import type { Message } from '@ag-ui/core';
import {
  foldRetries,
  lastOwnerMessageId,
  ownerText,
  retryMessage,
  retryOf,
} from '../src/client/message-actions/retries';
import { MessageActions } from '../src/client/message-actions/MessageActions';
import { PinnedBar } from '../src/client/message-actions/PinnedBar';
import { ChatTranscript } from '../src/client/ChatTranscript';
import { ThreadList } from '../src/client/ThreadList';
import type { ConversationSummary } from '../src/shared/types';
import { branchTitle } from '../src/shared/message-actions';

const user = (id: string, content: string, metadata?: object): Message =>
  ({ id, role: 'user', content, ...(metadata ? { metadata } : {}) }) as Message;
const reply = (id: string, content: string): Message => ({
  id,
  role: 'assistant',
  content,
});
const ids = (messages: Message[]) => messages.map((message) => message.id);

describe('retry', () => {
  it('sends the same text again with retryOf metadata pointing at the first message', () => {
    const original = user('q', 'Plan my trip');
    const first = retryMessage(original, 'r1');
    expect(first).toEqual({
      id: 'r1',
      role: 'user',
      content: 'Plan my trip',
      metadata: { retryOf: 'q' },
    });
    expect(retryOf(first)).toBe('q');
    // A retry of a retry still points at the owner's original message.
    expect(retryMessage(first, 'r2').metadata).toEqual({ retryOf: 'q' });
    expect(retryOf(reply('a', 'x'))).toBeUndefined();
  });

  it('folds earlier answers under the original message; nothing is lost', () => {
    const messages = [
      user('q0', 'Hi'),
      reply('a0', 'Hello'),
      user('q', 'Plan my trip'),
      reply('a1', 'First try'),
      user('r1', 'Plan my trip', { retryOf: 'q' }),
      reply('a2', 'Second try'),
      user('r2', 'Plan my trip', { retryOf: 'q' }),
      reply('a3', 'Third try'),
    ];
    const folded = foldRetries(messages);
    expect(ids(folded.messages)).toEqual(['q0', 'a0', 'q', 'a3']);
    expect(folded.earlier.get('q')?.map(ids)).toEqual([['a1'], ['a2']]);
    // Every message is either shown, folded, or a retry repeating its original.
    const accounted = [
      ...ids(folded.messages),
      ...[...folded.earlier.values()].flat(2).map((message) => message.id),
      'r1',
      'r2',
    ];
    expect(accounted.sort()).toEqual(ids(messages).sort());
  });

  it('shows a retry whose original is missing, and skips an empty attempt', () => {
    expect(
      ids(foldRetries([user('r', 'x', { retryOf: 'gone' })]).messages),
    ).toEqual(['r']);
    const folded = foldRetries([
      user('q', 'x'),
      user('r', 'x', { retryOf: 'q' }),
      reply('a', 'Answer'),
    ]);
    expect(ids(folded.messages)).toEqual(['q', 'a']);
    expect(folded.earlier.size).toBe(0);
  });

  it('puts Retry on the owner message the transcript shows last', () => {
    expect(
      lastOwnerMessageId([
        user('q', 'x'),
        reply('a', 'y'),
        user('r', 'x', { retryOf: 'q' }),
      ]),
    ).toBe('q');
    // A server-started turn (a scheduled task) is not the owner's message.
    expect(
      lastOwnerMessageId([
        user('q', 'x'),
        user('t', 'Daily check', { source: 'task' }),
      ]),
    ).toBe('q');
  });

  it('edits the text the owner typed, without the page line', () => {
    expect(
      ownerText('From [Trip](/#/spaces/s1/pages/p1):\n\nAdd a day in Rome'),
    ).toBe('Add a day in Rome');
    expect(ownerText('Plain')).toBe('Plain');
  });

  it('names a branch after its source within the title limit', () => {
    expect(branchTitle('Trip plan')).toBe('Branch of Trip plan');
    expect(branchTitle('x'.repeat(200))).toHaveLength(120);
  });
});

describe('MessageActions', () => {
  const noop = () => {};
  const handlers = {
    onEdit: noop,
    onRetry: noop,
    onBranch: noop,
    onPin: noop,
    onCopy: noop,
  };

  it('offers Edit, Retry, Branch, Pin and Copy on the last owner message', () => {
    const html = renderToStaticMarkup(
      <MessageActions role="user" pinned={false} canRetry {...handlers} />,
    );
    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-label="Message actions"');
    const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(labels).toEqual([
      'Message actions',
      'Edit and resend',
      'Retry',
      'Branch from here',
      'Pin message',
      'Copy text',
    ]);
    // Tooltips, and one tab stop for the whole toolbar.
    expect(html).toContain(
      'title="Start a new chat with the history up to this message"',
    );
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(4);
    expect(html).toContain('aria-pressed="false"');
  });

  it('offers Branch, Pin and Copy on a Dot reply, and shows a pin as pressed', () => {
    const html = renderToStaticMarkup(
      <MessageActions role="assistant" pinned canRetry {...handlers} />,
    );
    expect(html).not.toContain('Edit and resend');
    expect(html).not.toContain('aria-label="Retry"');
    expect(html).toContain('aria-label="Branch from here"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('title="Unpin from the top of the chat"');
  });

  it('keeps Retry focusable but marked unavailable while a reply streams', () => {
    const html = renderToStaticMarkup(
      <MessageActions
        role="user"
        pinned={false}
        canRetry
        retryBlocked="Wait for the reply to finish"
        {...handlers}
      />,
    );
    expect(html).toMatch(/aria-label="Retry"[^>]*aria-disabled="true"/);
    expect(html).toContain('title="Wait for the reply to finish"');
    // Not on an earlier owner message.
    expect(
      renderToStaticMarkup(
        <MessageActions role="user" pinned={false} {...handlers} />,
      ),
    ).not.toContain('aria-label="Retry"');
  });
});

describe('PinnedBar', () => {
  it('renders nothing without pins', () => {
    expect(
      renderToStaticMarkup(
        <PinnedBar pins={[]} onJump={() => {}} onUnpin={() => {}} />,
      ),
    ).toBe('');
  });

  it('is collapsed to a count and the newest pin, with the full list behind it', () => {
    const html = renderToStaticMarkup(
      <PinnedBar
        dotName="Scout"
        pins={[
          { messageId: 'a', text: 'Book the hotel', role: 'user' },
          { messageId: 'b', text: 'Here are three flights', role: 'assistant' },
        ]}
        onJump={() => {}}
        onUnpin={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Pinned messages"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('2 pinned');
    expect(html).toMatch(
      /pinned-preview[^>]*>.*Scout:.*Here are three flights/,
    );
    expect(html).toMatch(/<ul class="pinned-list" id="[^"]+" hidden="">/);
    expect(html).toContain('aria-label="Unpin: Book the hotel"');
  });
});

describe('transcript', () => {
  it('gives every text bubble its actions and folds an earlier attempt', () => {
    const html = renderToStaticMarkup(
      <ChatTranscript
        calls={[]}
        messages={[
          user('q', 'Plan my trip'),
          reply('a1', 'First try'),
          user('r1', 'Plan my trip', { retryOf: 'q' }),
          reply('a2', 'Second try'),
        ]}
        bubbleActions={(bubble) => (
          <span className="probe">{`${bubble.role}:${bubble.messageId}`}</span>
        )}
      />,
    );
    expect(html.match(/Plan my trip/g)).toHaveLength(1);
    expect(html).toContain('data-message-id="q"');
    expect(html).toContain('data-message-id="a2"');
    expect(html).toContain('user:q');
    expect(html).toContain('assistant:a2');
    expect(html).toMatch(
      /<details class="earlier-attempts">.*Earlier attempt.*First try.*<\/details>.*Second try/s,
    );
    // The folded answer keeps its actions (branch or pin an earlier attempt).
    expect(html).toContain('assistant:a1');
  });
});

describe('sidebar', () => {
  it('marks a branch with an icon and the chat it came from', () => {
    const chat = (
      id: string,
      title: string,
      extra: Partial<ConversationSummary> = {},
    ): ConversationSummary => ({
      id,
      dotId: 'dot-1',
      ownerId: 'owner',
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      empty: false,
      ...extra,
    });
    const html = renderToStaticMarkup(
      <ThreadList
        chats={[
          chat('source', 'Trip plan'),
          chat('branch', 'Branch of Trip plan', {
            branchedFrom: { threadId: 'source', messageId: 'm1' },
          }),
        ]}
        dots={[]}
        query=""
        onSelect={() => {}}
        onRename={async () => true}
        onDelete={async () => true}
        onExport={async () => {}}
      />,
    );
    expect(html).toContain('sb-chat-branch');
    expect(html).toContain('from Trip plan');
    expect(html).toContain(
      'aria-label="Branch of Trip plan, branch of Trip plan"',
    );
    expect(html.match(/sb-chat-branch/g)).toHaveLength(1);
  });
});
