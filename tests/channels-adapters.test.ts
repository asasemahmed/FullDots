import { afterEach, expect, it, vi } from 'vitest';
import type { TelegramAdapter } from '@copilotkit/channels-telegram';
import type { SlackAdapter } from '@copilotkit/channels-slack';
import type { IngressSink, IncomingTurn } from '@copilotkit/channels-core';
import { makeAdapter } from '../src/server/channels/adapters.js';
import { ChannelStore } from '../src/server/channels/store.js';
import { buttons } from '../src/server/channels/messages.js';

afterEach(() => vi.restoreAllMocks());
function settings(provider: 'slack' | 'telegram') {
  const store = new ChannelStore(':memory:');
  const config = {
    ...store.settings(provider),
    enabled: true,
    workspaceId: 'T123',
    ownerUserIds: provider === 'slack' ? ['U123'] : ['111'],
  };
  store.close();
  return config;
}
function sink() {
  return {
    onTurn: vi.fn<(event: IncomingTurn) => void>(),
    onInteraction: vi.fn(),
    onCommand: vi.fn(),
    onWelcome() {},
    onThreadStarted() {},
    onReaction() {},
    async onModalSubmit() {},
    onModalClose() {},
  } satisfies IngressSink;
}
it('decodes Telegram owner messages and native buttons while rejecting strangers before the SDK listener', async () => {
  const refused = vi.fn();
  const adapter = (await makeAdapter(
    settings('telegram'),
    { botToken: ['123', 'fixture'].join(':') },
    refused,
    vi.fn(),
  )) as TelegramAdapter;
  const me = {
    id: 999,
    is_bot: true as const,
    first_name: 'Fixture',
    username: 'fixture_bot',
  };
  vi.spyOn(adapter.bot.api, 'getMe').mockResolvedValue(me as never);
  vi.spyOn(adapter.bot, 'start').mockResolvedValue(undefined);
  vi.spyOn(adapter.bot.api, 'answerCallbackQuery').mockResolvedValue(true);
  const send = vi
    .spyOn(adapter.bot.api, 'sendMessage')
    .mockResolvedValue({ message_id: 20, chat: { id: 111 } } as never);
  await adapter.bot.init();
  const target = sink();
  await adapter.start(target);
  const owner = { id: 111, is_bot: false, first_name: 'Owner' };
  const chat = { id: 111, type: 'private' as const, first_name: 'Owner' };
  const message = { message_id: 10, date: 1, chat, from: owner, text: 'Hello' };
  await adapter.bot.handleUpdate({ update_id: 1, message });
  expect(target.onTurn).toHaveBeenCalledWith(
    expect.objectContaining({
      userText: 'Hello',
      actor: expect.objectContaining({ id: '111', kind: 'human' }),
    }),
  );
  const turn = target.onTurn.mock.calls[0][0];
  await adapter.post(turn.replyTarget, buttons('ck:approve', 'ck:deny'));
  expect(JSON.stringify(send.mock.calls)).toContain('callback_data');
  await adapter.bot.handleUpdate({
    update_id: 2,
    callback_query: {
      id: 'click',
      chat_instance: 'chat',
      from: owner,
      data: 'ck:approve',
      message,
    },
  });
  expect(target.onInteraction).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'ck:approve',
      conversationKey: turn.conversationKey,
    }),
  );
  await adapter.bot.handleUpdate({
    update_id: 3,
    message: { ...message, from: { ...owner, id: 222 } },
  });
  expect(refused).toHaveBeenCalledTimes(1);
  expect(target.onTurn).toHaveBeenCalledTimes(1);
});
it('checks the actual Slack event workspace and human owner before dispatch', async () => {
  const refused = vi.fn();
  const adapter = (await makeAdapter(
    settings('slack'),
    {
      botToken: ['xox', 'b', 'fixture'].join('-'),
      appToken: ['xap', 'p', 'fixture'].join('-'),
    },
    refused,
    vi.fn(),
  )) as SlackAdapter;
  const middleware = (
    adapter.app as unknown as {
      middleware: ((args: unknown) => Promise<void>)[];
    }
  ).middleware;
  const guard = middleware.at(-1)!;
  const next = vi.fn();
  await guard({ body: { team_id: 'OTHER', event: { user: 'U123' } }, next });
  await guard({ body: { team_id: 'T123', event: { user: 'OTHER' } }, next });
  await guard({
    body: { team_id: 'T123', event: { user: 'U123', bot_id: 'BOT' } },
    next,
  });
  expect(next).not.toHaveBeenCalled();
  expect(refused).toHaveBeenCalledTimes(3);
  await guard({ body: { team: { id: 'T123' }, user: { id: 'U123' } }, next });
  expect(next).toHaveBeenCalledOnce();
});
