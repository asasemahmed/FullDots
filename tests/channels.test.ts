import '../src/server/privacy.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import { ChannelStore } from '../src/server/channels/store.js';
import { splitReply } from '../src/server/channels/messages.js';
import { artifactLinks } from '../src/server/channels/artifacts.js';
import type { ChannelProvider } from '../src/shared/channels.js';
import { createFakeProvider } from './fixtures/fake-provider.js';
import { completion } from './fixtures/model-stream.js';
import {
  fakeChannels,
  channelTurn,
  buttonIds,
} from './fixtures/fake-channel.js';

const closers: (() => Promise<void>)[] = [],
  dirs: string[] = [];

it.each(['slack', 'telegram'] as const)(
  'sends only the desktop typing count to %s',
  async (provider) => {
    const f = fixture();
    await f.enable(provider);
    const frame = channelTurn(provider);
    await f.receive(provider, frame);
    const thread = f.platform.channels.store.thread(
      provider,
      1,
      frame.conversationKey,
    )!;
    const text = 'printf fixture-preview\n\techo done';
    const row = f.platform.approvals.request({
      dotId: f.dotId,
      threadId: thread.id,
      toolCallId: randomUUID(),
      tool: 'desktop_type',
      argsHash: 'fixture-intent',
      summary: text,
      argsRedacted: 'type [hidden] on desktop',
      argsPreview: text,
    });
    await f.platform.channels.tick();
    const sent = JSON.stringify(f.transport.posts);
    expect(sent).toContain(
      `type ${text.length} characters on the desktop. Open FullDots to see the text.`,
    );
    expect(sent).not.toContain('fixture-preview');
    expect(sent).not.toContain('argsPreview');
    expect(f.workspace.approvals.get(row.id)).not.toHaveProperty('argsPreview');
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(
      'fixture-preview',
    );
  },
);
beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    const target = resolve(dir);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith('fulldots-channels-')
    )
      throw new Error('Unexpected cleanup path');
    rmSync(target, { recursive: true, force: true, maxRetries: 5 });
  }
});
function temporary() {
  const dir = mkdtempSync(join(tmpdir(), 'fulldots-channels-'));
  dirs.push(dir);
  return join(dir, 'test.sqlite');
}
function fixture(path = ':memory:') {
  const store = new Store(path),
    workspace = new WorkspaceStore(path, 'owner');
  const fake = createFakeProvider();
  vi.spyOn(globalThis, 'fetch').mockImplementation(fake.fetch);
  const config = {
    apiKey: 'fixture',
    model: 'fake-small',
    baseUrl: 'https://fixture.invalid/v1',
    voiceName: 'fixture',
    publicOrigin: 'https://fulldots.example',
  };
  const platform = new Platform(store, workspace, config, path);
  const transport = fakeChannels();
  platform.channels.setTransportFactory(transport.factory);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await platform.stop();
    workspace.close();
    store.close();
  };
  closers.push(close);
  const botToken = ['bot', 'fixture', randomUUID()].join('-'),
    appToken = ['app', 'fixture', randomUUID()].join('-');
  const dotId = workspace.dots()[0].id;
  const input = {
    enabled: true,
    dotId,
    ownerUserIds: ['U123'],
    workspaceId: 'T123',
    chatId: '',
    botToken,
    appToken,
  };
  const enable = async (provider: ChannelProvider = 'slack') => {
    await platform.channels.configure(provider, {
      ...input,
      ownerUserIds: provider === 'slack' ? ['U123'] : ['111'],
    });
    await platform.channels.start();
    await vi.waitFor(() =>
      expect(
        platform.channels.settings().find((item) => item.provider === provider)
          ?.status,
      ).toBe('connected'),
    );
  };
  const receive = async (
    provider: ChannelProvider = 'slack',
    event = channelTurn(provider),
  ) => {
    await transport.sinks.get(provider)!.onTurn(event);
    await platform.channels.tick();
  };
  const approval = async (
    provider: ChannelProvider = 'slack',
    delivered = true,
  ) => {
    const frame = channelTurn(provider);
    await receive(provider, frame);
    const thread = platform.channels.store.thread(
      provider,
      1,
      frame.conversationKey,
    )!;
    vi.spyOn(platform.resumes, 'enqueue').mockImplementation((marker) =>
      workspace.resumes.add(marker),
    );
    const row = platform.approvals.request({
      dotId,
      threadId: thread.id,
      toolCallId: randomUUID(),
      tool: 'computer_exec',
      argsHash: 'exact-intent',
      summary: 'Run the chosen command',
      argsRedacted: '{"command":"echo fixture"}',
    });
    await platform.channels.tick();
    const ids = delivered
      ? transport.posts.flatMap((post) => buttonIds(post.nodes))
      : platform.channels.store.db
          .prepare('SELECT id FROM channel_actions ORDER BY rowid')
          .all()
          .map((item) => String(item.id));
    expect(ids).toHaveLength(2);
    const click = (
      id = ids[0],
      patch: Partial<ReturnType<typeof channelTurn>> = {},
    ) =>
      transport.sinks.get(provider)!.onInteraction({ ...frame, id, ...patch });
    return { row, ids, click, frame, thread };
  };
  return {
    store,
    workspace,
    platform,
    fake,
    transport,
    dotId,
    input,
    enable,
    receive,
    approval,
    botToken,
    appToken,
    close,
  };
}

it.each(['slack', 'telegram'] as const)(
  'allows listed human owners and continues one %s conversation',
  async (provider) => {
    const f = fixture();
    await f.enable(provider);
    await f.receive(provider);
    await f.receive(provider);
    expect(f.fake.chats()).toHaveLength(2);
    expect(f.workspace.conversations()).toHaveLength(1);
    expect(JSON.stringify(f.transport.posts)).toContain('ok');
  },
);
it.each(['slack', 'telegram'] as const)(
  'ignores strangers and bots on %s without logging their text',
  async (provider) => {
    const f = fixture();
    await f.enable(provider);
    const frame = channelTurn(provider);
    await f.receive(provider, {
      ...frame,
      userText: 'private stranger text',
      actor: { id: 'stranger', kind: 'human' },
    });
    await f.receive(provider, {
      ...frame,
      actor: { ...frame.actor, kind: 'bot' },
    });
    expect(f.fake.chats()).toHaveLength(0);
    expect(f.workspace.conversations()).toHaveLength(0);
    expect(f.transport.posts).toHaveLength(0);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(
      'private stranger text',
    );
  },
);
it('refuses a different Slack workspace and a Telegram group without a user list', async () => {
  const f = fixture();
  await f.enable();
  const frame = channelTurn();
  await f.receive('slack', {
    ...frame,
    identityContext: { ...frame.identityContext, tenant: { id: 'OTHER' } },
  });
  expect(f.fake.chats()).toHaveLength(0);
  await expect(
    f.platform.channels.configure('telegram', {
      ...f.input,
      ownerUserIds: [],
      chatId: '-123',
    }),
  ).rejects.toThrow('private owner chat');
});
it('accepts a Telegram private owner chat id and refuses other chats', async () => {
  const f = fixture();
  await f.platform.channels.configure('telegram', {
    ...f.input,
    ownerUserIds: [],
    chatId: '111',
  });
  await f.platform.channels.start();
  await vi.waitFor(() => expect(f.transport.sinks.has('telegram')).toBe(true));
  await f.receive('telegram');
  await f.receive(
    'telegram',
    channelTurn('telegram', { replyTarget: { chatId: '-111' } }),
  );
  expect(f.fake.chats()).toHaveLength(1);
});
it.each(['slack', 'telegram'] as const)(
  'binds %s buttons to one approval and refuses replay, wrong user and conversation',
  async (provider) => {
    const f = fixture();
    await f.enable(provider);
    const a = await f.approval(provider);
    const decide = vi.spyOn(f.platform.approvals, 'decide');
    await a.click(a.ids[0], { actor: { id: 'stranger', kind: 'human' } });
    await a.click(a.ids[0], { conversationKey: 'another conversation' });
    await a.click(a.ids[0], {
      replyTarget:
        provider === 'slack'
          ? { channel: 'OTHER', threadTs: 'root' }
          : { chatId: '222' },
    });
    expect(decide).not.toHaveBeenCalled();
    await a.click();
    await a.click();
    await a.click(a.ids[1]);
    expect(decide).toHaveBeenCalledExactlyOnceWith(a.row.id, 'approve');
    expect(f.workspace.resumes.all()).toHaveLength(1);
  },
);
it('denies from the Deny button and resolves simultaneous clicks once', async () => {
  const f = fixture();
  await f.enable();
  const a = await f.approval();
  const decide = vi.spyOn(f.platform.approvals, 'decide');
  await Promise.all([a.click(a.ids[1]), a.click(a.ids[0])]);
  expect(decide).toHaveBeenCalledExactlyOnceWith(a.row.id, 'deny');
});
it('refuses buttons and late transport events after the owner changes channel settings', async () => {
  const f = fixture();
  await f.enable();
  const a = await f.approval();
  const old = f.transport.sinks.get('slack')!;
  await f.platform.channels.configure('slack', { ...f.input, enabled: false });
  const decide = vi.spyOn(f.platform.approvals, 'decide');
  await old.onInteraction({ ...a.frame, id: a.ids[0] });
  await old.onTurn(channelTurn());
  expect(decide).not.toHaveBeenCalled();
  expect(f.fake.chats()).toHaveLength(1);
});
it('preserves blank secret fields and clears only explicitly removed tokens', async () => {
  const f = fixture();
  await f.enable();
  const { botToken: _bot, appToken: _app, ...fields } = f.input;
  void _bot;
  void _app;
  await f.platform.channels.configure('slack', { ...fields, enabled: false });
  expect(f.platform.channels.store.credentials('slack')).toEqual({
    botToken: f.botToken,
    appToken: f.appToken,
  });
  await f.platform.channels.configure('slack', {
    ...fields,
    enabled: false,
    botToken: null,
    appToken: null,
  });
  expect(f.platform.channels.settings()[0]).toMatchObject({
    enabled: false,
    botTokenSet: false,
    appTokenSet: false,
  });
});
it('retries delivery without running the Dot again or sending buttons before their approval details', async () => {
  const f = fixture();
  await f.enable();
  f.transport.post.mockRejectedValueOnce(new Error('fixture failure'));
  const a = await f.approval('slack', false);
  expect(f.fake.chats()).toHaveLength(1);
  expect(
    f.transport.posts.flatMap((post) => buttonIds(post.nodes)),
  ).toHaveLength(0);
  f.platform.channels.store.db
    .prepare('UPDATE channel_outbox SET nextAt=0')
    .run();
  await f.platform.channels.tick();
  expect(f.fake.chats()).toHaveLength(1);
  expect(f.transport.posts.flatMap((post) => buttonIds(post.nodes))).toEqual(
    a.ids,
  );
});
it.each(['denied', 'changed-intent', 'expired'] as const)(
  'refuses a %s approval',
  async (reason) => {
    const f = fixture();
    await f.enable();
    const a = await f.approval();
    if (reason === 'denied') f.platform.approvals.decide(a.row.id, 'deny');
    // Approvals use a different in-memory database; changing the snapshot models an altered binding.
    if (reason === 'changed-intent') {
      const snapshot = await f.platform.channels.store.get(a.ids[0]);
      await f.platform.channels.store.put(a.ids[0], {
        ...snapshot!,
        props: { ...(snapshot!.props as object), argsHash: 'different-intent' },
      });
    }
    if (reason === 'expired') {
      const snapshot = await f.platform.channels.store.get(a.ids[0]);
      await f.platform.channels.store.put(a.ids[0], snapshot!, -1);
    }
    const decide = vi.spyOn(f.platform.approvals, 'decide');
    await a.click();
    expect(decide).not.toHaveBeenCalled();
  },
);
it('does not resolve approvals from a text yes', async () => {
  const f = fixture();
  await f.enable();
  const a = await f.approval();
  const decide = vi.spyOn(f.platform.approvals, 'decide');
  await f.receive('slack', channelTurn('slack', { userText: 'yes' }));
  expect(decide).not.toHaveBeenCalled();
  expect(f.workspace.approvals.get(a.row.id)?.status).toBe('pending');
});
it('carries a model approval through the existing gate and resume queue back to the channel', async () => {
  const f = fixture();
  let calls = 0;
  vi.mocked(globalThis.fetch).mockImplementation(async () => {
    calls++;
    return calls === 1
      ? completion(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'fixture-approval',
                type: 'function',
                function: {
                  name: 'request_approval',
                  arguments: JSON.stringify({
                    summary: 'Review the proposed work',
                  }),
                },
              },
            ],
          },
          'tool_calls',
        )
      : completion({
          role: 'assistant',
          content:
            calls === 2 ? 'Waiting for approval.' : 'Decision acknowledged.',
        });
  });
  await f.enable();
  const frame = channelTurn();
  await f.receive('slack', frame);
  const [row] = f.workspace.approvals.list({ status: 'pending' });
  expect(row.summary).toBe('Review the proposed work');
  const ids = f.transport.posts.flatMap((post) => buttonIds(post.nodes));
  expect(ids).toHaveLength(2);
  const decide = vi.spyOn(f.platform.approvals, 'decide');
  await f.transport.sinks.get('slack')!.onInteraction({ ...frame, id: ids[0] });
  await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3));
  await vi.waitFor(() => expect(f.workspace.resumes.all()).toHaveLength(0));
  await f.platform.channels.tick();
  expect(decide).toHaveBeenCalledExactlyOnceWith(row.id, 'approve');
  expect(f.workspace.approvals.get(row.id)?.status).not.toBe('pending');
  expect(JSON.stringify(f.transport.posts)).toContain('Decision acknowledged.');
});
it('adds a FullDots link when a Dot saves a file during the channel turn', async () => {
  const f = fixture(temporary());
  let calls = 0;
  vi.mocked(globalThis.fetch).mockImplementation(async () =>
    ++calls === 1
      ? completion(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'fixture-file',
                type: 'function',
                function: {
                  name: 'save_space_file',
                  arguments: JSON.stringify({
                    name: 'result.csv',
                    content: 'name,value\nfixture,1',
                  }),
                },
              },
            ],
          },
          'tool_calls',
        )
      : completion({ role: 'assistant', content: 'Saved the result.' }),
  );
  await f.enable();
  await f.receive();
  const output = JSON.stringify(f.transport.posts);
  expect(output).toContain('Saved in FullDots:');
  expect(output).toContain('https://fulldots.example/#/spaces/');
  expect(output).toContain('/files/');
});
it('uses the shared stop control only for an authorized owner', async () => {
  const f = fixture();
  await f.enable();
  const stop = vi.spyOn(f.platform.turns, 'stop');
  const frame = channelTurn();
  await f.transport.sinks
    .get('slack')!
    .onCommand({ ...frame, command: '/stop', text: '' });
  expect(stop).toHaveBeenCalledExactlyOnceWith(f.dotId);
  await f.transport.sinks.get('slack')!.onCommand({
    ...frame,
    command: '/stop',
    text: '',
    actor: { id: 'stranger', kind: 'human' },
  });
  expect(stop).toHaveBeenCalledOnce();
});
it('does not start a second turn while the Dot is busy with app work', async () => {
  const f = fixture();
  await f.enable();
  const release = f.platform.turns.acquire(
    f.dotId,
    'app-thread',
    'chat',
    () => {},
  );
  try {
    await f.receive();
    expect(f.fake.chats()).toHaveLength(0);
    expect(JSON.stringify(f.transport.posts)).toContain('busy');
  } finally {
    release();
  }
});
it('aborts active channel work when the owner disables the channel', async () => {
  const f = fixture();
  await f.enable();
  let active: AbortSignal | undefined;
  vi.spyOn(f.platform, 'turnAs').mockImplementation(
    async (_thread, _dot, _prompt, signal) => {
      active = signal;
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return 'Stopped';
    },
  );
  const work = f.transport.sinks.get('slack')!.onTurn(channelTurn());
  await vi.waitFor(() => expect(active).toBeDefined());
  await f.platform.channels.configure('slack', { ...f.input, enabled: false });
  await work;
  expect(active!.aborted).toBe(true);
});
it.each(['global', 'dot'] as const)(
  'blocks turns while %s pause is active',
  async (kind) => {
    const f = fixture();
    await f.enable();
    if (kind === 'global') f.store.updateSettings({ paused: true });
    else f.workspace.setDotPaused(f.dotId, true);
    await f.receive();
    expect(f.fake.chats()).toHaveLength(0);
    expect(JSON.stringify(f.transport.posts)).toContain('paused');
  },
);
it('deduplicates a provider retry without repeating model or tool work', async () => {
  const f = fixture();
  await f.enable();
  const frame = channelTurn();
  await f.receive('slack', frame);
  await f.receive('slack', frame);
  expect(f.fake.chats()).toHaveLength(1);
});
it('keeps action snapshots and channel conversations valid after restart', async () => {
  const path = temporary();
  const f = fixture(path);
  await f.enable();
  const a = await f.approval();
  await f.close();
  const next = fixture(path);
  vi.spyOn(next.platform.resumes, 'enqueue').mockImplementation((marker) =>
    next.workspace.resumes.add(marker),
  );
  await next.platform.channels.start();
  await vi.waitFor(() => expect(next.transport.sinks.has('slack')).toBe(true));
  await next.transport.sinks
    .get('slack')!
    .onInteraction({ ...a.frame, id: a.ids[0] });
  expect(next.workspace.approvals.get(a.row.id)?.status).toBe('approved');
  expect(next.workspace.resumes.all()).toHaveLength(1);
  await next.receive();
  expect(next.workspace.conversations()).toHaveLength(1);
});
it('encrypts tokens at rest, masks settings and redacts transport failures', async () => {
  const f = fixture();
  await f.enable();
  const row = JSON.stringify(
    f.platform.channels.store.db
      .prepare('SELECT * FROM channel_settings')
      .all(),
  );
  expect(row).not.toContain(f.botToken);
  expect(row).not.toContain(f.appToken);
  const publicValue = JSON.stringify(f.platform.channels.settings());
  expect(publicValue).not.toContain(f.botToken);
  expect(publicValue).toContain('botTokenSet');
  f.transport.post.mockRejectedValue(new Error(f.botToken));
  await f.receive();
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
    f.botToken,
  );
});
it('reports a safe failed connection status without returning or logging the token', async () => {
  const f = fixture();
  f.platform.channels.setTransportFactory(async () => {
    throw new Error(f.botToken);
  });
  await f.platform.channels.configure('slack', f.input);
  await f.platform.channels.start();
  await vi.waitFor(() =>
    expect(f.platform.channels.settings()[0].status).toBe('failed'),
  );
  expect(JSON.stringify(f.platform.channels.settings())).not.toContain(
    f.botToken,
  );
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
    f.botToken,
  );
});
it('removes channel credentials if model output echoes them', async () => {
  const f = fixture();
  vi.mocked(globalThis.fetch).mockImplementation(async () =>
    completion({ content: f.botToken }),
  );
  await f.enable();
  await f.receive();
  expect(JSON.stringify(f.transport.posts)).not.toContain(f.botToken);
  expect(JSON.stringify(f.transport.posts)).toContain('[redacted]');
});
it('consumes a durable ActionStore entry atomically', async () => {
  const store = new ChannelStore(':memory:');
  try {
    await store.put('button', { conversationKey: 'thread', path: [] });
    const results = await Promise.all([
      store.consume('button'),
      store.consume('button'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  } finally {
    store.close();
  }
});
it('requires owner authentication and origin checks on settings routes and never returns tokens', async () => {
  const f = fixture();
  const config = {
    mode: 'sample' as const,
    baseUrl: 'https://fixture.invalid',
    voiceName: 'fixture',
  };
  const app = createApp({
    store: f.store,
    platform: f.platform,
    runner: new Runner(f.store, config),
    config,
    ownerToken: 'fixture-owner',
    origin: 'https://fulldots.example',
  });
  expect((await app.request('/api/channels')).status).toBe(401);
  const headers = {
    Authorization: 'Bearer fixture-owner',
    'Content-Type': 'application/json',
  };
  expect(
    (
      await app.request('/api/channels/slack', {
        method: 'PUT',
        headers: { ...headers, Origin: 'https://other.example' },
        body: JSON.stringify(f.input),
      })
    ).status,
  ).toBe(403);
  const response = await app.request('/api/channels/slack', {
    method: 'PUT',
    headers,
    body: JSON.stringify(f.input),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).not.toHaveProperty('botToken');
  expect(JSON.stringify(body)).not.toContain(f.botToken);
  const bad = await app.request('/api/channels/slack', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ ...f.input, botToken: f.botToken.repeat(1000) }),
  });
  expect(bad.status).toBe(400);
  expect(await bad.text()).not.toContain(f.botToken);
});
it('splits long Unicode replies conservatively for both renderers without losing text', () => {
  const text = '<&>😀'.repeat(3000);
  const parts = splitReply(text);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.join('')).toBe(text);
  expect(parts.every((part) => part.length <= 2400)).toBe(true);
});
it('only promotes local page and file links from this run', () => {
  const messages = [
    {
      id: 'page',
      role: 'tool' as const,
      toolCallId: 'call-page',
      content: JSON.stringify({ url: '/#/spaces/s/pages/p' }),
    },
    {
      id: 'file',
      role: 'tool' as const,
      toolCallId: 'call-file',
      content: JSON.stringify({ file: { url: '/#/spaces/s/files/f' } }),
    },
    {
      id: 'remote',
      role: 'tool' as const,
      toolCallId: 'call-remote',
      content: JSON.stringify({
        url: 'https://other.example/#/spaces/s/pages/p',
      }),
    },
  ];
  expect(
    artifactLinks(
      messages,
      new Set(['page', 'file', 'remote']),
      'https://fulldots.example',
    ),
  ).toEqual([
    'https://fulldots.example/#/spaces/s/pages/p',
    'https://fulldots.example/#/spaces/s/files/f',
  ]);
});
