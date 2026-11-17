import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import { searchRoutes } from '../src/server/search-routes.js';
import {
  clampLimit,
  makeSnippet,
  parseTypes,
  visibleMessageText,
} from '../src/server/search.js';
import type { SearchResult } from '../src/shared/search.js';

const cleanup: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
afterEach(() => {
  vi.useRealTimers();
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
});

type Message = Record<string, unknown>;
interface FakeThread {
  id: string;
  updatedAt: number;
  messages: Message[];
}

/** A workspace plus a stand-in for the chat store, behind the real search route. */
function fixture(threads: FakeThread[] = []) {
  const ws = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => ws.close());
  const runner = {
    listThreads: () =>
      [...threads]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((thread) => ({
          id: thread.id,
          updatedAt: new Date(thread.updatedAt).toISOString(),
        })),
    getThreadMessages: (id: string) =>
      (threads.find((thread) => thread.id === id)?.messages ?? []) as never[],
  } as never;
  const app = new Hono().route('/api', searchRoutes(ws, runner));
  const search = async (query: string, extra = '') => {
    const response = await app.request(
      `/api/search?q=${encodeURIComponent(query)}${extra}`,
    );
    const body = (await response.json()) as {
      results?: SearchResult[];
      error?: string;
    };
    return { status: response.status, ...body };
  };
  const space = ws.spaces()[0]!.id;
  const dot = ws.dots()[0]!;
  const page = (title: string, content: string, at: number) => {
    vi.setSystemTime(at);
    return ws.pages.create(space, { title, content });
  };
  return { ws, app, search, space, dot, page, threads };
}

it('matches % and _ literally instead of as wildcards', async () => {
  const { search, page } = fixture();
  page('Sale', 'Save 100% today', 1);
  page('Plain', 'Save 100 today', 2);
  page('Snake', 'my_var and myXvar', 3);
  page('Slash', 'C:\\temp\\file', 4);
  expect((await search('100%')).results!.map((r) => r.title)).toEqual(['Sale']);
  expect((await search('my_var')).results!.map((r) => r.title)).toEqual([
    'Snake',
  ]);
  expect((await search('%')).results!.map((r) => r.title)).toEqual(['Sale']);
  expect((await search('_')).results!.map((r) => r.title)).toEqual(['Snake']);
  expect((await search('temp\\file')).results!.map((r) => r.title)).toEqual([
    'Slash',
  ]);
});

it('ignores case and returns nothing for an empty query', async () => {
  const { search, page } = fixture();
  page('Quarterly Plan', 'Budget notes', 1);
  expect((await search('quarterly PLAN')).results).toHaveLength(1);
  expect((await search('BUDGET')).results).toHaveLength(1);
  expect((await search('')).results).toEqual([]);
  expect((await search('   ')).results).toEqual([]);
  expect((await search('zebra')).results).toEqual([]);
});

it('lists title matches first, then content matches, newest first in each group', async () => {
  const { search, page, ws, dot } = fixture([
    {
      id: 'chat-old',
      updatedAt: 100,
      messages: [{ id: 'm1', role: 'user', content: 'tell me about falcon' }],
    },
    {
      id: 'chat-new',
      updatedAt: 900,
      messages: [{ id: 'm2', role: 'user', content: 'falcon again' }],
    },
  ]);
  ws.bindThread('chat-old', dot.id, 'Old falcon chat');
  ws.bindThread('chat-new', dot.id, 'Newest chat');
  page('Falcon notes', 'nothing', 300);
  page('Pelican', 'a falcon appears', 500);
  page('Falcon diary', 'falcon falcon', 700);
  const { results } = await search('falcon');
  expect(results!.map((r) => `${r.type}:${r.title}`)).toEqual([
    // Title matches, newest first.
    'page:Falcon diary',
    'page:Falcon notes',
    'chat:Old falcon chat',
    // Content matches, newest first. A title match is not listed twice.
    'message:Newest chat',
    'page:Pelican',
    'message:Old falcon chat',
  ]);
  expect(results![0]).toMatchObject({
    type: 'page',
    spaceId: ws.spaces()[0]!.id,
    updatedAt: 700,
  });
});

it('caps the result count at the limit and at 50', async () => {
  const { search, page } = fixture();
  for (let index = 0; index < 60; index++) page(`Needle ${index}`, 'x', index);
  expect((await search('needle')).results).toHaveLength(20);
  expect((await search('needle', '&limit=5')).results).toHaveLength(5);
  expect((await search('needle', '&limit=500')).results).toHaveLength(50);
  expect((await search('needle', '&limit=0')).results).toHaveLength(1);
  expect((await search('needle', '&limit=abc')).results).toHaveLength(20);
  expect((await search('needle', '&limit=3')).results![0]!.title).toBe(
    'Needle 59',
  );
  expect(clampLimit(undefined)).toBe(20);
  expect(clampLimit('51')).toBe(50);
  expect(clampLimit('-4')).toBe(1);
});

it('filters by type and refuses unknown types', async () => {
  const { search, page, ws, dot } = fixture([
    {
      id: 'c1',
      updatedAt: 5,
      messages: [{ id: 'm1', role: 'assistant', content: 'comet mentioned' }],
    },
  ]);
  ws.bindThread('c1', dot.id, 'Comet chat');
  page('Comet page', 'body', 1);
  ws.createDot(dot.spaceId, 'Comet Dot', 'Watches the sky', true, true);
  ws.prompts.create({
    title: 'Comet prompt',
    body: 'Find comets',
    scope: 'global',
    dotId: null,
    teamId: null,
  });
  const types = async (extra: string) =>
    [...new Set((await search('comet', extra)).results!.map((r) => r.type))]
      .sort()
      .join(',');
  expect(await types('')).toBe('chat,dot,message,page,prompt');
  expect(await types('&types=page')).toBe('page');
  expect(await types('&types=dot,prompt')).toBe('dot,prompt');
  expect(await types('&types=chat,message')).toBe('chat,message');
  expect((await search('comet', '&types=page,teams')).status).toBe(400);
  expect((await search('comet', '&types=bogus')).status).toBe(400);
  expect(parseTypes('page, dot')).toEqual(['page', 'dot']);
  expect(parseTypes(undefined)).toHaveLength(6);
  expect(parseTypes('')).toHaveLength(6);
});

it('searches Dot names and instructions and saved prompts, not archived ones', async () => {
  const { search, ws, dot } = fixture();
  const owl = ws.createDot(
    dot.spaceId,
    'Owl',
    'Night watch editor',
    true,
    true,
  );
  const kept = ws.prompts.create({
    title: 'Edit pass',
    body: 'Edit this like a night editor',
    scope: 'global',
    dotId: null,
    teamId: null,
  });
  const gone = ws.prompts.create({
    title: 'Night draft',
    body: 'Old text',
    scope: 'dot',
    dotId: owl.id,
    teamId: null,
  });
  ws.prompts.archive(gone.id);
  const { results } = await search('night');
  expect(results!.map((r) => `${r.type}:${r.title}`).sort()).toEqual([
    'dot:Owl',
    'prompt:Edit pass',
  ]);
  const dotHit = results!.find((r) => r.type === 'dot')!;
  expect(dotHit).toMatchObject({ id: owl.id, dotId: owl.id });
  expect(dotHit.snippet).toContain('Night watch editor');
  expect(results!.find((r) => r.type === 'prompt')!.id).toBe(kept.id);
});

it('builds a snippet of about 120 characters around the first match', () => {
  const filler = 'lorem ipsum dolor sit amet '.repeat(30);
  const text = `${filler}the NEEDLE is here ${filler}`;
  const snippet = makeSnippet(text, 'needle');
  expect(snippet).toContain('NEEDLE');
  expect(snippet.startsWith('…')).toBe(true);
  expect(snippet.endsWith('…')).toBe(true);
  expect(snippet.length).toBeLessThanOrEqual(122);
  expect(snippet.length).toBeGreaterThan(100);
  // Short text is returned whole, with whitespace collapsed.
  expect(makeSnippet('one\n\n two   three', 'two')).toBe('one two three');
  // A match at the very start and at the very end.
  expect(makeSnippet(`needle ${filler}`, 'needle').startsWith('needle')).toBe(
    true,
  );
  const end = makeSnippet(`${filler}needle`, 'needle');
  expect(end.endsWith('needle')).toBe(true);
  expect(end.endsWith('…')).toBe(false);
  // No match: the start of the text.
  expect(makeSnippet(filler, 'zzz').startsWith('lorem')).toBe(true);
  expect(makeSnippet('   ', 'a')).toBe('');
  // Never split a surrogate pair at the end of a snippet.
  const emojiBoundary = makeSnippet(
    `${'a'.repeat(9)}🚀${'b'.repeat(10)}`,
    '',
    10,
  );
  expect(emojiBoundary).toBe(`${'a'.repeat(9)}…`);
  expect(/[\ud800-\udfff]/.test(emojiBoundary)).toBe(false);
});

it('finds message text but never tool arguments or hidden content', async () => {
  const hiddenWord = 'zebrasecret';
  const { search, ws, dot } = fixture([
    {
      id: 't1',
      updatedAt: 10,
      messages: [
        { id: 'u1', role: 'user', content: 'Please check the okapi report' },
        {
          id: 'a1',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Looking at the okapi numbers now.' },
          ],
          toolCalls: [
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: 'search',
                arguments: JSON.stringify({ query: `${hiddenWord} okapi` }),
              },
            },
          ],
        },
        {
          id: 'tool1',
          role: 'tool',
          toolCallId: 'call-1',
          content: `${hiddenWord} result`,
        },
        { id: 'sys1', role: 'system', content: `${hiddenWord} system` },
        { id: 'dev1', role: 'developer', content: `${hiddenWord} developer` },
        {
          id: 'opendots:voice_receipt:1',
          role: 'user',
          content: `${hiddenWord} receipt`,
        },
        {
          id: 'u2',
          role: 'user',
          content: `${hiddenWord} scheduled run`,
          metadata: { source: 'task', ref: 'task-1' },
        },
        {
          id: 'u3',
          role: 'user',
          content: `${hiddenWord} receipt by metadata`,
          metadata: { opendotsSource: 'voice_receipt' },
        },
        {
          id: 'a2',
          role: 'assistant',
          content: [
            { type: 'binary', mimeType: 'image/png', data: hiddenWord },
          ],
        },
      ],
    },
  ]);
  ws.bindThread('t1', dot.id, 'Zoo');
  expect((await search(hiddenWord)).results).toEqual([]);
  const { results } = await search('okapi');
  expect(results).toEqual([
    expect.objectContaining({
      type: 'message',
      id: 'a1',
      title: 'Zoo',
      threadId: 't1',
      dotId: dot.id,
      snippet: 'Looking at the okapi numbers now.',
      updatedAt: 10,
    }),
    expect.objectContaining({
      type: 'message',
      id: 'u1',
      snippet: 'Please check the okapi report',
    }),
  ]);
  expect(visibleMessageText({ id: 'x', role: 'tool', content: 'a' })).toBe(
    undefined,
  );
  expect(visibleMessageText({ role: 'user', content: 'no id' })).toBe(
    undefined,
  );
  expect(visibleMessageText(null)).toBe(undefined);
});

it('returns at most two matching messages per chat and skips empty chats', async () => {
  const many = Array.from({ length: 5 }, (_, index) => ({
    id: `m${index}`,
    role: 'user',
    content: `walrus number ${index}`,
  }));
  const { search, ws, dot } = fixture([
    { id: 'busy', updatedAt: 50, messages: many },
  ]);
  ws.bindThread('busy', dot.id, 'Busy chat');
  // Never written in, never linked: a placeholder nobody should be sent to.
  ws.bindThread('blank', dot.id, 'Walrus placeholder');
  const { results } = await search('walrus');
  expect(results!.map((r) => r.id)).toEqual(['m4', 'm3']);
});

it('is owner only and mounted with the app', async () => {
  const store = new Store(':memory:');
  const ws = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => {
    store.close();
    ws.close();
  });
  const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
  const platform = new Platform(store, ws, {
    baseUrl: config.baseUrl,
    voiceName: 'marin',
  });
  cleanup.push(() => void platform.stop());
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
    ownerToken: 'owner-secret',
  });
  ws.pages.create(ws.spaces()[0]!.id, { title: 'Findable page' });
  expect((await app.request('/api/search?q=findable')).status).toBe(401);
  const authed = await app.request('/api/search?q=findable', {
    headers: { Authorization: 'Bearer owner-secret' },
  });
  expect(authed.status).toBe(200);
  const body = (await authed.json()) as { results: SearchResult[] };
  expect(body.results.map((r) => r.title)).toEqual(['Findable page']);
  const tooLong = await app.request(`/api/search?q=${'a'.repeat(201)}`, {
    headers: { Authorization: 'Bearer owner-secret' },
  });
  expect(tooLong.status).toBe(400);
});
