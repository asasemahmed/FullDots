import '../src/server/privacy.js';
import { afterEach, expect, it, vi } from 'vitest';
import { slack } from '@copilotkit/channels-slack';
import type { IngressSink } from '@copilotkit/channels-core';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { createFakeProvider } from './fixtures/fake-provider.js';

afterEach(() => vi.restoreAllMocks());

it('starts a direct Slack adapter and carries a Dot reply without Intelligence', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const fake = createFakeProvider();
  vi.spyOn(globalThis, 'fetch').mockImplementation(fake.fetch);
  const platform = new Platform(store, workspace, {
    apiKey: 'fixture',
    model: 'fake-small',
    baseUrl: 'https://fixture.invalid/v1',
    voiceName: 'fixture',
  });
  const adapter = slack({
    botToken: ['xox', 'b', 'fixture'].join('-'),
    appToken: ['xap', 'p', 'fixture'].join('-'),
    assistant: false,
  });
  const handlers = new Map<string, (input: never) => Promise<void>>();
  vi.spyOn(adapter.app, 'init').mockResolvedValue(undefined);
  vi.spyOn(adapter.app, 'start').mockResolvedValue(undefined as never);
  vi.spyOn(adapter.app, 'stop').mockResolvedValue(undefined);
  vi.spyOn(adapter.app, 'event').mockImplementation((name, ...callbacks) => {
    handlers.set(
      String(name),
      callbacks.at(-1) as (input: never) => Promise<void>,
    );
  });
  vi.spyOn(adapter.client.auth, 'test').mockResolvedValue({
    ok: true,
    user_id: 'BOT',
    team_id: 'WORKSPACE',
  });
  const posted = vi
    .spyOn(adapter.client.chat, 'postMessage')
    .mockResolvedValue({ ok: true, ts: '2.0001' });
  let threadId = '';
  const sink: IngressSink = {
    async onTurn(turn) {
      expect(turn.actor).toMatchObject({ kind: 'human', id: 'OWNER' });
      const thread = await platform.createConversation(
        workspace.dots()[0].id,
        'Slack spike',
      );
      threadId = thread.id;
      const reply = await platform.turn(
        thread.id,
        turn.userText,
        AbortSignal.timeout(10000),
      );
      await adapter.post(turn.replyTarget, [
        {
          type: 'section',
          props: { children: [{ type: 'text', props: { value: reply } }] },
        },
      ]);
    },
    onInteraction() {},
    onWelcome() {},
    onCommand() {},
    onThreadStarted() {},
    onReaction() {},
    async onModalSubmit() {},
    onModalClose() {},
  };
  try {
    await adapter.start(sink);
    await handlers.get('app_mention')!({
      event: {
        type: 'app_mention',
        channel: 'CHANNEL',
        user: 'OWNER',
        text: '<@BOT> Hello',
        ts: '1.0001',
      },
      body: { team_id: 'WORKSPACE', event_id: 'fixture-event' },
      client: adapter.client,
    } as never);
    expect(posted).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'CHANNEL', thread_ts: '1.0001' }),
    );
    expect(JSON.stringify(posted.mock.calls)).toContain('ok');
    expect(platform.runner.getThreadMessages(threadId)).toContainEqual(
      expect.objectContaining({ role: 'assistant', content: 'ok' }),
    );
    expect(fake.chats()).toHaveLength(1);
  } finally {
    await adapter.stop();
    await platform.stop();
    workspace.close();
    store.close();
  }
});
