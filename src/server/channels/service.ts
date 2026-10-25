import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  ChannelNode,
  IngressSink,
  IncomingTurn,
  InteractionEvent,
} from '@copilotkit/channels-core';
import type { Platform } from '../platform.js';
import {
  channelInput,
  type ChannelInput,
  type ChannelProvider,
  type ChannelSettings,
} from '../../shared/channels.js';
import { ChannelStore, type ChannelThread } from './store.js';
import {
  makeAdapter,
  type AdapterFactory,
  type ChannelAdapter,
} from './adapters.js';
import { buttons, section, safeFailure, splitReply } from './messages.js';
import { artifactLinks } from './artifacts.js';
import { isDotBusy } from '../turn-registry.js';
type IngressEventBase = Pick<
  IncomingTurn,
  'actor' | 'identityContext' | 'replyTarget' | 'conversationKey'
> & { platform?: string };

const actionBinding = z.object({
  provider: z.enum(['slack', 'telegram']),
  revision: z.number(),
  threadId: z.string(),
  dotId: z.string(),
  approvalId: z.string(),
  argsHash: z.string().nullable(),
  tool: z.string(),
  toolCallId: z.string(),
  decision: z.enum(['approve', 'deny']),
});
interface RunningChannel {
  revision: number;
  adapter: ChannelAdapter;
  status: 'connecting' | 'connected' | 'failed';
  failure: string | null;
}
function destination(
  provider: ChannelProvider,
  target: unknown,
): string | undefined {
  if (provider === 'slack') {
    const parsed = z
      .object({ channel: z.string(), threadTs: z.string().optional() })
      .safeParse(target);
    return parsed.success
      ? JSON.stringify([parsed.data.channel, parsed.data.threadTs ?? ''])
      : undefined;
  }
  const parsed = z
    .object({
      chatId: z.union([z.string(), z.number()]),
      messageThreadId: z.number().optional(),
    })
    .safeParse(target);
  return parsed.success
    ? JSON.stringify([
        String(parsed.data.chatId),
        parsed.data.messageThreadId ?? null,
      ])
    : undefined;
}
export class ChannelService {
  readonly store: ChannelStore;
  private factory: AdapterFactory = makeAdapter;
  private runtimes = new Map<ChannelProvider, RunningChannel>();
  private failures = new Map<ChannelProvider, string>();
  private queues = new Map<ChannelProvider, Promise<void>>();
  private controllers = new Map<
    string,
    { provider: ChannelProvider; abort: AbortController }
  >();
  private unsubscribe: (() => void)[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private started = false;
  private closed = false;
  private draining = false;
  constructor(
    private platform: Platform,
    path: string,
  ) {
    this.store = new ChannelStore(path);
  }
  setTransportFactory(factory: AdapterFactory) {
    if (this.started)
      throw new Error('Channel transports are already started.');
    this.factory = factory;
  }
  settings(): ChannelSettings[] {
    return (['slack', 'telegram'] as const).map((provider) => ({
      ...this.store.settings(provider),
      status:
        this.runtimes.get(provider)?.status ??
        (this.failures.has(provider) ? 'failed' : 'disabled'),
      failure:
        this.runtimes.get(provider)?.failure ??
        this.failures.get(provider) ??
        null,
    }));
  }
  async configure(provider: ChannelProvider, input: ChannelInput) {
    const parsed = channelInput.parse(input);
    const current = this.store.credentials(provider);
    const token =
      parsed.botToken === undefined ? current.botToken : parsed.botToken;
    const app =
      parsed.appToken === undefined ? current.appToken : parsed.appToken;
    if (
      parsed.enabled &&
      (!this.platform.workspace.dot(parsed.dotId) ||
        !token ||
        (provider === 'slack' &&
          (!app || !parsed.workspaceId || !parsed.ownerUserIds.length)) ||
        (provider === 'telegram' &&
          (!parsed.ownerUserIds.every((id) => /^\d+$/.test(id)) ||
            (!parsed.ownerUserIds.length &&
              !/^[1-9]\d*$/.test(parsed.chatId)))))
    )
      throw new Error(
        'Choose a Dot, set the tokens and list the owner accounts. A Telegram chat without a user list must be a private owner chat.',
      );
    this.store.configure(provider, parsed);
    this.failures.delete(provider);
    await this.disconnect(provider);
    if (this.started && parsed.enabled) void this.connect(provider);
    return this.settings().find((item) => item.provider === provider)!;
  }
  async start() {
    if (this.started) return;
    this.started = true;
    this.unsubscribe.push(
      this.platform.events.subscribe('turn.finished', (event) => {
        if (this.closed) return;
        const thread = this.store.byThread(event.threadId);
        if (!thread || !this.current(thread)) return;
        const runs = this.platform.runner.runsAfter(event.threadId, 0);
        const run = runs.find((item) =>
          item.events.some(
            (item) => 'runId' in item && item.runId === event.runId,
          ),
        );
        const ids = new Set(
          run?.events.flatMap((item) => [
            ...('messageId' in item && typeof item.messageId === 'string'
              ? [item.messageId]
              : []),
            ...('toolCallId' in item && typeof item.toolCallId === 'string'
              ? [item.toolCallId]
              : []),
          ]) ?? [],
        );
        let text = this.platform.runner
          .getThreadMessages(event.threadId)
          .filter(
            (item) =>
              ids.has(item.id) &&
              item.role === 'assistant' &&
              typeof item.content === 'string',
          )
          .map((item) => item.content)
          .join('\n\n');
        if (event.status === 'stopped')
          text +=
            '\nStopped. Review completed work in FullDots before retrying.';
        if (!text.trim())
          text =
            event.status === 'failed'
              ? 'The turn failed. Check FullDots before trying again.'
              : 'The turn finished. See FullDots for its results.';
        const origin = this.platform.config.publicOrigin;
        if (origin) {
          const links = artifactLinks(
            this.platform.runner.getThreadMessages(event.threadId),
            ids,
            origin,
          );
          if (links.length)
            text += `\n\nSaved in FullDots:\n${links.join('\n')}`;
          text += `\n\nFullDots: ${origin.replace(/\/$/, '')}/#/dots/${thread.dotId}/threads/${thread.id}`;
        }
        this.enqueueText(thread, text, `run:${event.runId}`);
        void this.tick();
      }),
    );
    for (const setting of this.settings())
      if (setting.enabled) void this.connect(setting.provider);
    this.timer = setInterval(() => {
      void this.tick();
    }, 1000);
    this.timer.unref();
  }
  private current(thread: ChannelThread) {
    const setting = this.store.settings(thread.provider);
    return (
      setting.enabled &&
      setting.revision === thread.revision &&
      setting.dotId === thread.dotId
    );
  }
  private redact(provider: ChannelProvider, text: string) {
    for (const token of Object.values(this.store.credentials(provider)))
      if (token) text = text.replaceAll(token, '[redacted]');
    return this.platform.models.redact(text);
  }
  private enqueueText(thread: ChannelThread, text: string, id: string) {
    splitReply(this.redact(thread.provider, text)).forEach((part, index) =>
      this.store.enqueue(
        thread.id,
        [
          section(
            thread.provider === 'slack'
              ? part
                  .replaceAll('&', '&amp;')
                  .replaceAll('<', '&lt;')
                  .replaceAll('>', '&gt;')
              : part,
          ),
        ],
        `${id}:${index}`,
      ),
    );
  }
  private ignored(provider: ChannelProvider) {
    if (!this.closed)
      console.info(
        `Ignored ${provider} events: ${this.store.ignored(provider)}`,
      );
  }
  private allowed(provider: ChannelProvider, event: IngressEventBase) {
    const config = this.store.settings(provider);
    if (
      !config.enabled ||
      !destination(provider, event.replyTarget) ||
      (event.platform !== undefined && event.platform !== provider) ||
      event.actor.kind !== 'human'
    )
      return false;
    if (provider === 'slack')
      return (
        config.workspaceId === event.identityContext.tenant.id &&
        config.ownerUserIds.includes(event.actor.id)
      );
    const target = z
      .object({ chatId: z.union([z.number(), z.string()]) })
      .safeParse(event.replyTarget);
    return (
      target.success &&
      (!config.chatId || String(target.data.chatId) === config.chatId) &&
      (config.ownerUserIds.includes(event.actor.id) ||
        (!config.ownerUserIds.length &&
          config.chatId === event.actor.id &&
          String(target.data.chatId) === event.actor.id))
    );
  }
  private async connect(provider: ChannelProvider) {
    const config = this.store.settings(provider),
      credentials = this.store.credentials(provider);
    if (this.closed) return;
    if (!credentials.botToken) {
      this.failures.set(
        provider,
        'The saved token is unavailable. Set it again in Channels.',
      );
      return;
    }
    let runtime: RunningChannel | undefined;
    const failed = (reason: string) => {
      if (
        this.closed ||
        this.store.settings(provider).revision !== config.revision
      )
        return;
      this.failures.set(provider, `Connection or delivery failed: ${reason}`);
      if (runtime) {
        runtime.failure = `Connection or delivery failed: ${reason}`;
        runtime.status = 'failed';
      }
      console.error(`${provider} channel failed: ${reason}`);
    };
    try {
      const adapter = await this.factory(
        config,
        { botToken: credentials.botToken, appToken: credentials.appToken },
        () => this.ignored(provider),
        failed,
      );
      runtime = {
        adapter,
        revision: config.revision,
        status: 'connecting',
        failure: null,
      };
      if (
        this.closed ||
        this.store.settings(provider).revision !== config.revision
      ) {
        await adapter.stop().catch(() => {});
        return;
      }
      this.runtimes.set(provider, runtime);
      const serial = (task: () => Promise<void>) => {
        const next = (this.queues.get(provider) ?? Promise.resolve())
          .then(task)
          .catch((error) => failed(safeFailure(error)));
        this.queues.set(provider, next);
        return next;
      };
      const sink: IngressSink = {
        onTurn: (event) =>
          serial(async () => {
            if (
              !this.closed &&
              this.store.settings(provider).revision === config.revision
            )
              await this.receive(provider, event);
          }),
        onInteraction: async (event) => {
          if (
            this.closed ||
            this.store.settings(provider).revision !== config.revision
          )
            return;
          await this.interact(provider, event).catch((error) =>
            failed(safeFailure(error)),
          );
        },
        onCommand: async (event) => {
          if (
            this.closed ||
            this.store.settings(provider).revision !== config.revision
          )
            return;
          if (!this.allowed(provider, event)) {
            this.ignored(provider);
            return;
          }
          if (
            event.command.replace(/^\//, '').split('@')[0].toLowerCase() ===
            'stop'
          )
            this.platform.turns.stop(config.dotId);
        },
        onWelcome() {},
        onThreadStarted() {},
        onReaction() {},
        async onModalSubmit() {},
        onModalClose() {},
      };
      await adapter.start(sink);
      if (this.closed || this.runtimes.get(provider) !== runtime) {
        await adapter.stop().catch(() => {});
        return;
      }
      if (runtime.status !== 'failed') runtime.status = 'connected';
      await this.tick();
    } catch (error) {
      failed(safeFailure(error));
      if (runtime) await runtime.adapter.stop().catch(() => {});
    }
  }
  async receive(provider: ChannelProvider, event: IncomingTurn) {
    if (this.closed) return;
    if (
      !this.allowed(provider, event) ||
      event.operation.kind !== 'created' ||
      !event.userText.trim() ||
      event.userText.length > 32000
    ) {
      this.ignored(provider);
      return;
    }
    const config = this.store.settings(provider);
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          event.conversationKey,
          event.eventId ?? event.operation.logicalMessageId,
          event.operation.revisionId,
        ]),
      )
      .digest('hex');
    if (!this.store.accept(provider, config.revision, key)) return;
    if (
      this.platform.store.settings().paused ||
      this.platform.workspace.dot(config.dotId)?.paused
    ) {
      const runtime = this.runtimes.get(provider);
      if (runtime?.status === 'connected')
        await runtime.adapter.post(event.replyTarget, [
          section(
            'FullDots or this Dot is paused. Resume it in FullDots before sending a new message.',
          ),
        ]);
      return;
    }
    let thread = this.store.thread(
      provider,
      config.revision,
      event.conversationKey,
    );
    if (
      thread &&
      destination(provider, thread.target) !==
        destination(provider, event.replyTarget)
    ) {
      this.ignored(provider);
      return;
    }
    if (!thread) {
      const created = await this.platform.createConversation(
        config.dotId,
        `${provider === 'slack' ? 'Slack' : 'Telegram'}: ${event.userText.slice(0, 70)}`,
      );
      thread = {
        id: created.id,
        provider,
        revision: config.revision,
        conversationKey: event.conversationKey,
        target: event.replyTarget,
        dotId: config.dotId,
      };
      this.store.bind(thread);
    }
    const abort = new AbortController();
    if (this.closed || !this.current(thread)) return;
    this.controllers.set(thread.id, { provider, abort });
    try {
      await this.platform.turnAs(
        thread.id,
        thread.dotId,
        event.userText,
        abort.signal,
      );
    } catch (error) {
      console.error(`${provider} channel turn failed: ${safeFailure(error)}`);
      if (!this.closed && isDotBusy(error))
        this.enqueueText(
          thread,
          'This Dot is busy with another turn. Wait for it to finish or stop it in FullDots, then send a new message.',
          `busy:${key}`,
        );
    } finally {
      this.controllers.delete(thread.id);
      await this.tick();
    }
  }
  async interact(provider: ChannelProvider, event: InteractionEvent) {
    if (this.closed) return;
    if (!this.allowed(provider, event)) {
      this.ignored(provider);
      return;
    }
    const snapshot = await this.store.get(event.id);
    const bound = actionBinding.safeParse(snapshot?.props);
    if (!snapshot || !bound.success) return;
    const data = bound.data,
      settings = this.store.settings(provider);
    const thread = this.store.byThread(data.threadId);
    if (
      !thread ||
      !this.current(thread) ||
      destination(provider, thread.target) !==
        destination(provider, event.replyTarget) ||
      data.provider !== provider ||
      data.revision !== settings.revision ||
      data.dotId !== settings.dotId ||
      snapshot.conversationKey !== event.conversationKey
    )
      return;
    const approval = this.platform.workspace.approvals.get(data.approvalId);
    if (
      !approval ||
      approval.status !== 'pending' ||
      approval.expiresAt <= Date.now() ||
      approval.threadId !== data.threadId ||
      approval.dotId !== data.dotId ||
      approval.argsHash !== data.argsHash ||
      approval.tool !== data.tool ||
      approval.toolCallId !== data.toolCallId
    )
      return;
    if (!(await this.store.consume(event.id))) return;
    if (
      this.closed ||
      !this.allowed(provider, event) ||
      this.store.settings(provider).revision !== data.revision ||
      this.platform.workspace.approvals.get(approval.id)?.status !== 'pending'
    )
      return;
    this.platform.approvals.decide(approval.id, data.decision);
  }
  async tick() {
    if (this.closed || !this.started || this.draining) return;
    this.draining = true;
    try {
      for (const approval of this.platform.workspace.approvals.list({
        status: 'pending',
        limit: 1000,
      })) {
        const thread = this.store.byThread(approval.threadId);
        if (
          !thread ||
          !this.current(thread) ||
          this.store.hasApproval(approval.id)
        )
          continue;
        const ids: string[] = [];
        for (const decision of ['approve', 'deny'] as const) {
          const id = `ck:${randomUUID().replaceAll('-', '')}`;
          ids.push(id);
          await this.store.put(
            id,
            {
              conversationKey: thread.conversationKey,
              path: [],
              platform: thread.provider,
              props: {
                provider: thread.provider,
                revision: thread.revision,
                dotId: thread.dotId,
                threadId: thread.id,
                approvalId: approval.id,
                argsHash: approval.argsHash,
                tool: approval.tool,
                toolCallId: approval.toolCallId,
                decision,
              },
            },
            Math.max(1, approval.expiresAt - Date.now()),
          );
        }
        this.enqueueText(
          thread,
          `Approval needed: ${approval.summary}\nTool: ${approval.tool}\nArguments: ${approval.argsRedacted}`,
          `approval:${approval.id}:details`,
        );
        this.store.enqueue(
          thread.id,
          buttons(ids[0], ids[1]),
          `approval:${approval.id}:buttons`,
        );
        this.store.markApproval(approval.id);
      }
      for (let round = 0; round < 25; round++) {
        const pending = this.store.pending();
        if (!pending.length) break;
        let sent = false;
        for (const item of pending) {
          const thread = this.store.byThread(item.threadId);
          if (!thread || !this.current(thread)) {
            this.store.sent(item.id);
            continue;
          }
          const runtime = this.runtimes.get(thread.provider);
          if (
            !runtime ||
            runtime.status !== 'connected' ||
            runtime.revision !== thread.revision
          )
            continue;
          try {
            await runtime.adapter.post(
              thread.target,
              item.nodes as ChannelNode[],
            );
            if (!this.closed) this.store.sent(item.id);
            sent = true;
          } catch (error) {
            if (!this.closed) this.store.retry(item.id, item.attempts);
            runtime.failure = `Delivery failed: ${safeFailure(error)}. Replies retry up to five times; check this conversation in FullDots.`;
            console.error(
              `${thread.provider} channel delivery failed: ${safeFailure(error)}`,
            );
          }
        }
        if (!sent || this.closed) break;
      }
    } catch (error) {
      if (!this.closed)
        console.error(`Channel delivery failed: ${safeFailure(error)}`);
    } finally {
      this.draining = false;
    }
  }
  private async disconnect(provider: ChannelProvider) {
    const runtime = this.runtimes.get(provider);
    this.runtimes.delete(provider);
    for (const entry of this.controllers.values())
      if (entry.provider === provider) entry.abort.abort();
    if (runtime)
      await runtime.adapter
        .stop()
        .catch((error) =>
          console.error(`Channel stop failed: ${safeFailure(error)}`),
        );
  }
  async stop() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.unsubscribe.forEach((unsubscribe) => unsubscribe());
    await Promise.all(
      (['slack', 'telegram'] as const).map((provider) =>
        this.disconnect(provider),
      ),
    );
    await Promise.all(this.queues.values());
    while (this.draining)
      await new Promise((resolve) => setTimeout(resolve, 10));
    this.store.close();
  }
}
