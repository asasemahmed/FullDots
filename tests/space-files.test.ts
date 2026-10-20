import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import { SpaceFileError, cleanFileName } from '../src/server/space-files.js';
import { readLimits } from '../src/server/limits.js';
import { typeOfName } from '../src/shared/space-files.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

function fixture(ownerToken?: string, env: Record<string, string> = {}) {
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
    limits: readLimits(env),
  });
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
    ownerToken,
  });
  return { ws, app, spaceId: ws.spaces()[0]!.id };
}
const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const upload = (name: string, text: string, parentId: string | null = null) =>
  json({
    name,
    contentBase64: Buffer.from(text).toString('base64'),
    parentId,
  });

describe('file types', () => {
  it('derives the media type from the name and keeps active formats as downloads', () => {
    expect(typeOfName('Report.CSV')).toEqual({
      mediaType: 'text/csv',
      kind: 'csv',
    });
    expect(typeOfName('notes.md').kind).toBe('markdown');
    expect(typeOfName('page.html').kind).toBe('html');
    expect(typeOfName('page.html').mediaType).toBe('text/html');
    expect(typeOfName('page.php').kind).toBe('download');
    expect(typeOfName('run.js').mediaType).toBe('application/octet-stream');
    expect(typeOfName('noextension').kind).toBe('download');
  });

  it('cleans names so they cannot carry a path', () => {
    expect(cleanFileName('  a/b\\c.txt ')).toBe('a b c.txt');
    expect(() => cleanFileName('..')).toThrow(SpaceFileError);
    expect(() => cleanFileName('   ')).toThrow(SpaceFileError);
    expect(() => cleanFileName('x'.repeat(201))).toThrow(SpaceFileError);
  });
});

describe('space files', () => {
  it('stores a file and returns it byte for byte', async () => {
    const { app, spaceId } = fixture();
    const created = await app.request(
      `/api/spaces/${spaceId}/files`,
      upload('results.csv', 'name,price\nmilk,2\nbread,3\n'),
    );
    expect(created.status).toBe(201);
    const file = await created.json();
    expect(file).toMatchObject({
      name: 'results.csv',
      mediaType: 'text/csv',
      kind: 'csv',
      size: 26,
      parentId: null,
    });
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file).not.toHaveProperty('data');
    const content = await app.request(
      `/api/spaces/${spaceId}/files/${file.id}/content`,
    );
    expect(await content.text()).toBe('name,price\nmilk,2\nbread,3\n');
    expect(content.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    const listed = await (
      await app.request(`/api/spaces/${spaceId}/files`)
    ).json();
    expect(listed.map((item: { name: string }) => item.name)).toEqual([
      'results.csv',
    ]);
    expect(JSON.stringify(listed)).not.toContain('milk');
  });

  it('names a clash instead of replacing the file', async () => {
    const { app, spaceId } = fixture();
    const post = (name: string) =>
      app.request(`/api/spaces/${spaceId}/files`, upload(name, 'x'));
    expect((await (await post('a.txt')).json()).name).toBe('a.txt');
    expect((await (await post('A.TXT')).json()).name).toBe('A (2).TXT');
    expect((await (await post('a.txt')).json()).name).toBe('a (3).txt');
  });

  it('refuses files over the limit, bad base64 and unknown input', async () => {
    const { app, spaceId } = fixture(undefined, { SPACE_FILE_MAX_MB: '1' });
    const big = await app.request(
      `/api/spaces/${spaceId}/files`,
      upload('big.txt', 'x'.repeat(1024 * 1024 + 1)),
    );
    expect(big.status).toBe(413);
    expect((await big.json()).error).toMatch(/at most 1 MB/);
    // Far over the limit, the request is refused before it is read, with the same message.
    const huge = await app.request(
      `/api/spaces/${spaceId}/files`,
      upload('huge.txt', 'x'.repeat(3 * 1024 * 1024)),
    );
    expect(huge.status).toBe(413);
    expect((await huge.json()).error).toMatch(/at most 1 MB/);
    const edge = await app.request(
      `/api/spaces/${spaceId}/files`,
      upload('ok.txt', 'x'.repeat(1024 * 1024)),
    );
    expect(edge.status).toBe(201);
    const bad = await app.request(
      `/api/spaces/${spaceId}/files`,
      json({ name: 'a.txt', contentBase64: 'not base64!' }),
    );
    expect(bad.status).toBe(400);
    const extra = await app.request(
      `/api/spaces/${spaceId}/files`,
      json({ name: 'a.txt', contentBase64: '', mediaType: 'text/html' }),
    );
    expect(extra.status).toBe(400);
    expect(
      (await app.request(`/api/spaces/nope/files`, upload('a.txt', 'x')))
        .status,
    ).toBe(404);
  });

  it('serves nothing active: sandbox for text and images, attachment for the rest', async () => {
    const { app, spaceId } = fixture();
    const make = async (name: string) =>
      (
        await (
          await app.request(
            `/api/spaces/${spaceId}/files`,
            upload(name, '<script>alert(1)</script>'),
          )
        ).json()
      ).id as string;
    const svg = await app.request(
      `/api/spaces/${spaceId}/files/${await make('x.svg')}/content`,
    );
    expect(svg.headers.get('content-security-policy')).toContain('sandbox');
    expect(svg.headers.get('x-content-type-options')).toBe('nosniff');
    const html = await app.request(
      `/api/spaces/${spaceId}/files/${await make('page.html')}/content`,
    );
    // HTML opened directly is plain text with the sandbox policy: only the viewer's frame renders it.
    expect(html.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(html.headers.get('content-security-policy')).toContain('sandbox');
    const php = await app.request(
      `/api/spaces/${spaceId}/files/${await make('run.php')}/content`,
    );
    expect(php.headers.get('content-type')).toBe('application/octet-stream');
    expect(php.headers.get('content-disposition')).toMatch(/^attachment/);
    const forced = await app.request(
      `/api/spaces/${spaceId}/files/${await make('n.txt')}/content?download=1`,
    );
    expect(forced.headers.get('content-disposition')).toMatch(/^attachment/);
  });

  it('keeps files under pages, moves them up when the page goes and refuses a foreign page', async () => {
    const { app, ws, spaceId } = fixture();
    const outer = ws.pages.create(spaceId, { title: 'Reports' });
    const inner = ws.pages.create(spaceId, {
      title: 'Week 41',
      parentId: outer.id,
    });
    const file = await (
      await app.request(
        `/api/spaces/${spaceId}/files`,
        upload('data.csv', 'a', inner.id),
      )
    ).json();
    expect(file.parentId).toBe(inner.id);
    ws.pages.delete(spaceId, inner.id);
    expect(ws.spaceFiles.get(spaceId, file.id).parentId).toBe(outer.id);
    const moved = await app.request(
      `/api/spaces/${spaceId}/files/${file.id}`,
      json({ parentId: null, name: 'final.csv' }, 'PATCH'),
    );
    expect(await moved.json()).toMatchObject({
      parentId: null,
      name: 'final.csv',
    });
    const elsewhere = await app.request(
      `/api/spaces/${spaceId}/files/${file.id}`,
      json({ parentId: 'no-such-page' }, 'PATCH'),
    );
    expect(elsewhere.status).toBe(400);
  });

  it('deletes a file and says so for one that is gone', async () => {
    const { app, spaceId } = fixture();
    const file = await (
      await app.request(`/api/spaces/${spaceId}/files`, upload('a.txt', 'x'))
    ).json();
    const url = `/api/spaces/${spaceId}/files/${file.id}`;
    const remove = () => app.request(url, json({}, 'DELETE'));
    expect((await remove()).status).toBe(200);
    expect((await remove()).status).toBe(404);
    expect((await app.request(`${url}/content`)).status).toBe(404);
  });

  it('needs the owner token when one is set', async () => {
    const { app, spaceId } = fixture('t'.repeat(24));
    expect((await app.request(`/api/spaces/${spaceId}/files`)).status).toBe(
      401,
    );
    expect(
      (
        await app.request(`/api/spaces/${spaceId}/files`, {
          headers: { Authorization: `Bearer ${'t'.repeat(24)}` },
        })
      ).status,
    ).toBe(200);
  });

  it('forgets the chat a file came from when that chat is deleted', () => {
    const { ws, spaceId } = fixture();
    const dot = ws.dots()[0]!;
    const thread = ws.bindThread('thread-1', dot.id, 'Search');
    const file = ws.spaceFiles.create(
      spaceId,
      { name: 'a.txt', data: Buffer.from('x') },
      { maxBytes: 1000, sourceThreadId: thread.id },
    );
    expect(ws.spaceFiles.get(spaceId, file.id).sourceThreadId).toBe(thread.id);
    ws.deleteThread(thread.id);
    expect(ws.spaceFiles.get(spaceId, file.id).sourceThreadId).toBeNull();
  });
});
