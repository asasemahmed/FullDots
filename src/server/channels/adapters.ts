import type { IngressSink, PlatformAdapter } from '@copilotkit/channels-core';
import type { ChannelSettings } from '../../shared/channels.js';
import { safeFailure } from './messages.js';

export type ChannelAdapter = Pick<
  PlatformAdapter,
  'platform' | 'start' | 'stop' | 'post'
>;
export type AdapterFactory = (
  settings: ChannelSettings,
  credentials: { botToken: string; appToken?: string },
  refused: () => void,
  failed: (reason: string) => void,
) => Promise<ChannelAdapter>;

export const makeAdapter: AdapterFactory = async (
  settings,
  credentials,
  refused,
  failed,
) => {
  if (settings.provider === 'slack') {
    const { slack } = await import('@copilotkit/channels-slack');
    const adapter = slack({
      botToken: credentials.botToken,
      appToken: credentials.appToken!,
      assistant: false,
      streaming: 'legacy',
    });
    // Bolt shares this logger with its receiver. Never let provider errors reach console verbatim.
    for (const method of ['debug', 'info', 'warn', 'error'] as const)
      adapter.app.logger[method] = () => {
        if (method === 'error') failed('Error');
      };
    adapter.app.error(async () => failed('Error'));
    adapter.app.use(async ({ body, next }) => {
      const data = body as unknown as {
        team_id?: string;
        team?: { id?: string };
        event?: { user?: string; bot_id?: string; subtype?: string };
        user?: { id?: string };
        user_id?: string;
      };
      const workspace = data.team_id ?? data.team?.id;
      const actor = data.event?.user ?? data.user?.id ?? data.user_id;
      if (
        workspace !== settings.workspaceId ||
        !actor ||
        !settings.ownerUserIds.includes(actor) ||
        data.event?.bot_id ||
        data.event?.subtype
      ) {
        refused();
        return;
      }
      await next();
    });
    const start = adapter.start.bind(adapter);
    adapter.start = async (sink: IngressSink) => {
      await start(sink);
      // A token for a different workspace must not become an active channel.
      const auth = await adapter.client.auth.test();
      if (auth.team_id !== settings.workspaceId) {
        await adapter.stop();
        throw new Error('Wrong workspace');
      }
    };
    return adapter;
  }
  const { telegram } = await import('@copilotkit/channels-telegram');
  const adapter = telegram({ token: credentials.botToken, mode: 'polling' });
  // Listener catches may log API errors themselves. Strip their request payloads first.
  adapter.bot.api.config.use(async (previous, method, payload, signal) => {
    try {
      const result = await previous(method, payload, signal);
      if (!result.ok) throw new Error('Provider request failed');
      return result;
    } catch (error) {
      // A cause would reintroduce tokens and message bodies when SDK listeners log this error.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(safeFailure(error));
    }
  });
  adapter.bot.use(async (ctx, next) => {
    const actor = ctx.from;
    const chat = ctx.chat;
    const owner =
      actor &&
      !actor.is_bot &&
      (settings.ownerUserIds.includes(String(actor.id)) ||
        (!settings.ownerUserIds.length &&
          chat?.type === 'private' &&
          String(actor.id) === settings.chatId));
    if (
      !owner ||
      !chat ||
      (settings.chatId && String(chat.id) !== settings.chatId)
    ) {
      refused();
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    await next();
  });
  // The SDK's default polling handlers log raw errors. Replace the public grammY hooks.
  const catchErrors = adapter.bot.catch.bind(adapter.bot);
  adapter.bot.catch = () =>
    catchErrors((error) => failed(safeFailure(error.error)));
  const poll = adapter.bot.start.bind(adapter.bot);
  adapter.bot.start = async (options) => {
    try {
      await poll(options);
    } catch (error) {
      failed(safeFailure(error));
    }
  };
  return adapter;
};
