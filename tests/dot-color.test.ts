// dots.color: an optional palette name. Existing Dots keep NULL (the client derives their palette from
// the id, as before); the Dot routes accept one of DOT_COLORS or null.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { DOT_COLORS, type Dot } from '../src/shared/types.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function boot() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const platform = new Platform(store, workspace, {
    baseUrl: 'https://unused.invalid/v1',
    voiceName: 'marin',
  });
  cleanups.push(async () => {
    await platform.stop();
    store.close();
    workspace.close();
  });
  const research = { mode: 'sample' as const, baseUrl: '' };
  const app = createApp({
    store,
    runner: new Runner(store, research),
    config: research,
    platform,
  });
  return { app, workspace, dot: workspace.dots()[0] };
}

const send = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('Dot colours', () => {
  it('offers the nine palettes', () => {
    expect(DOT_COLORS).toEqual([
      'indigo',
      'mint',
      'coral',
      'lilac',
      'amber',
      'sky',
      'rose',
      'moss',
      'ink',
    ]);
  });

  it('leaves existing and new Dots without a colour unless one is chosen', () => {
    const { workspace, dot } = boot();
    expect(dot.color).toBeUndefined();
    expect('color' in dot).toBe(false);
    const chosen = workspace.createDot(
      dot.spaceId,
      'Painter',
      'Paints things carefully.',
      true,
      true,
      undefined,
      null,
      'sensitive',
      null,
      { color: 'coral' },
    );
    expect(chosen.color).toBe('coral');
    expect(workspace.dot(chosen.id)?.color).toBe('coral');
  });

  it('accepts a palette on create and update, clears it with null, and keeps it when omitted', async () => {
    const { app, dot } = boot();
    const base = {
      name: 'Writer',
      instructions: 'Writes clearly.',
      researchAllowed: true,
      memoryAllowed: true,
      spaceId: dot.spaceId,
    };
    const created = await app.request(
      '/api/dots',
      send('POST', { ...base, color: 'mint' }),
    );
    expect(created.status).toBe(201);
    const writer = (await created.json()) as Dot;
    expect(writer.color).toBe('mint');

    const kept = await app.request(
      `/api/dots/${writer.id}`,
      send('PUT', { ...base, name: 'Writer 2' }),
    );
    expect(((await kept.json()) as Dot).color).toBe('mint');

    const changed = await app.request(
      `/api/dots/${writer.id}`,
      send('PUT', { ...base, color: 'moss' }),
    );
    expect(((await changed.json()) as Dot).color).toBe('moss');

    const cleared = await app.request(
      `/api/dots/${writer.id}`,
      send('PUT', { ...base, color: null }),
    );
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as Dot).color).toBeUndefined();
  });

  it('rejects a colour outside the palette list', async () => {
    const { app, dot } = boot();
    const base = {
      name: 'Writer',
      instructions: 'Writes clearly.',
      researchAllowed: true,
      memoryAllowed: true,
      spaceId: dot.spaceId,
    };
    for (const color of ['purple', '', '#ff0000', 3, 'INDIGO']) {
      expect(
        (await app.request('/api/dots', send('POST', { ...base, color })))
          .status,
      ).toBe(400);
      expect(
        (
          await app.request(
            `/api/dots/${dot.id}`,
            send('PUT', { ...base, color }),
          )
        ).status,
      ).toBe(400);
    }
    expect((await app.request('/api/workspace')).status).toBe(200);
  });
});

describe('dots.color migration', () => {
  it('adds the column to an old database and keeps every Dot as it was', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fulldots-color-'));
    const path = join(dir, 'old.sqlite');
    cleanups.push(() =>
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 }),
    );
    // The first released schema: no colour, model or approval columns.
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      INSERT INTO spaces VALUES ('space-1', 'Home', '', 1);
      INSERT INTO dots VALUES ('dot-old', 'space-1', 'Old Dot', 'Has been here a while.', 1, 0, 2);
      INSERT INTO dots VALUES ('dot-older', 'space-1', 'Older Dot', 'Has been here longer.', 0, 1, 1);`);
    old.close();

    const workspace = new WorkspaceStore(path, 'owner');
    cleanups.push(() => workspace.close());
    const dots = workspace.dots();
    expect(dots.map((dot) => [dot.id, dot.name, dot.color])).toEqual([
      ['dot-older', 'Older Dot', undefined],
      ['dot-old', 'Old Dot', undefined],
    ]);
    expect(dots[1]).toMatchObject({
      researchAllowed: true,
      memoryAllowed: false,
      spaceIds: ['space-1'],
    });
    const updated = workspace.updateDot('dot-old', {
      name: 'Old Dot',
      instructions: 'Has been here a while.',
      researchAllowed: true,
      memoryAllowed: false,
      color: 'amber',
    });
    expect(updated.color).toBe('amber');
    workspace.close();
    cleanups.pop();

    // Reopening runs the migration again without touching the rows.
    const reopened = new WorkspaceStore(path, 'owner');
    cleanups.push(() => reopened.close());
    expect(reopened.dots().map((dot) => [dot.id, dot.color])).toEqual([
      ['dot-older', undefined],
      ['dot-old', 'amber'],
    ]);
  });
});
