import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import type {
  ChannelNode,
  IngressSink,
  IncomingTurn,
} from '@copilotkit/channels-core';
import type { AdapterFactory } from '../../src/server/channels/adapters.js';
import type { ChannelProvider } from '../../src/shared/channels.js';

export function fakeChannels() {
  const sinks = new Map<ChannelProvider, IngressSink>();
  const posts: {
    provider: ChannelProvider;
    target: unknown;
    nodes: ChannelNode[];
  }[] = [];
  const post = vi.fn(
    async (
      provider: ChannelProvider,
      target: unknown,
      nodes: ChannelNode[],
    ) => {
      posts.push({ provider, target, nodes });
      return { id: randomUUID() };
    },
  );
  const stop = vi.fn(async () => {});
  const factory: AdapterFactory = async (config) => ({
    platform: config.provider,
    async start(sink) {
      sinks.set(config.provider, sink);
    },
    stop,
    post: (target, nodes) => post(config.provider, target, nodes),
  });
  return { factory, sinks, posts, post, stop };
}
export function channelTurn(
  provider: ChannelProvider = 'slack',
  patch: Partial<IncomingTurn> = {},
): IncomingTurn {
  const actor = {
    id: provider === 'slack' ? 'U123' : '111',
    kind: 'human' as const,
  };
  const key = provider === 'slack' ? 'channel:root' : '111:dm';
  return {
    actor,
    platform: provider,
    conversationKey: key,
    replyTarget:
      provider === 'slack'
        ? { channel: 'CHANNEL', threadTs: 'root' }
        : { chatId: '111' },
    userText: 'Hello',
    eventId: randomUUID(),
    operation: {
      kind: 'created',
      logicalMessageId: randomUUID(),
      revisionId: '1',
      mentioned: true,
    },
    identityContext: {
      tenant: { id: 'T123' },
      installation: { id: 'fixture' },
      conversation: { id: key, kind: 'direct' },
      trigger: 'message',
      event: {},
      raw: {},
    },
    ...patch,
  };
}
export function buttonIds(nodes: unknown): string[] {
  if (Array.isArray(nodes)) return nodes.flatMap(buttonIds);
  if (!nodes || typeof nodes !== 'object') return [];
  const node = nodes as {
    type?: string;
    props?: { onClick?: { id: string }; children?: unknown };
  };
  return node.type === 'button' && node.props?.onClick?.id
    ? [node.props.onClick.id]
    : buttonIds(node.props?.children);
}
