// dots.species and dots.gear: optional choices of penguin and accessory. Existing Dots keep NULL
// (the client derives their penguin from the id and they wear nothing).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Mascot, dotLook, dotSpecies, speciesFor } from '../src/client/Mascot';
import { createApp } from '../src/server/app.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { createFromTemplate } from '../src/server/teams/templates.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { TEAM_TEMPLATES } from '../src/shared/team-templates.js';
import { DOT_SPECIES, type Dot } from '../src/shared/types.js';

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

describe('Dot penguins', () => {
  it('leaves Dots without a species or gear unless they are chosen', () => {
    const { workspace, dot } = boot();
    expect('species' in dot).toBe(false);
    expect('gear' in dot).toBe(false);
    const chosen = workspace.createDot(
      dot.spaceId,
      'Scout',
      'Finds facts.',
      true,
      true,
      undefined,
      null,
      'sensitive',
      null,
      { species: 'adelie', gear: 'headphones' },
    );
    expect(chosen).toMatchObject({ species: 'adelie', gear: 'headphones' });
    expect(workspace.dot(chosen.id)).toMatchObject({
      species: 'adelie',
      gear: 'headphones',
    });
  });

  it('accepts a species and gear on create and update, clears them, and keeps them when omitted', async () => {
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
      send('POST', { ...base, species: 'chick', gear: 'scarf' }),
    );
    expect(created.status).toBe(201);
    const writer = (await created.json()) as Dot;
    expect(writer).toMatchObject({ species: 'chick', gear: 'scarf' });

    const kept = (await (
      await app.request(
        `/api/dots/${writer.id}`,
        send('PUT', { ...base, name: 'Writer 2' }),
      )
    ).json()) as Dot;
    expect(kept).toMatchObject({ species: 'chick', gear: 'scarf' });

    const changed = (await (
      await app.request(
        `/api/dots/${writer.id}`,
        send('PUT', { ...base, species: 'macaroni', gear: 'bow' }),
      )
    ).json()) as Dot;
    expect(changed).toMatchObject({ species: 'macaroni', gear: 'bow' });

    const cleared = (await (
      await app.request(
        `/api/dots/${writer.id}`,
        send('PUT', { ...base, species: null, gear: 'none' }),
      )
    ).json()) as Dot;
    expect(cleared.species).toBeUndefined();
    expect(cleared.gear).toBeUndefined();
  });

  it('rejects a species or gear outside the lists, including the retired ones', async () => {
    const { app, dot } = boot();
    const base = {
      name: 'Writer',
      instructions: 'Writes clearly.',
      researchAllowed: true,
      memoryAllowed: true,
      spaceId: dot.spaceId,
    };
    for (const look of [
      { species: 'gentoo' },
      { species: 'chinstrap' },
      { species: 'Emperor' },
      { species: 3 },
      { gear: 'crown' },
      { gear: '' },
    ]) {
      expect(
        (await app.request('/api/dots', send('POST', { ...base, ...look })))
          .status,
      ).toBe(400);
      expect(
        (
          await app.request(
            `/api/dots/${dot.id}`,
            send('PUT', { ...base, ...look }),
          )
        ).status,
      ).toBe(400);
    }
  });

  it('gives every template Dot its own penguin and gear', () => {
    const { workspace } = boot();
    for (const template of TEAM_TEMPLATES) {
      const { dots } = createFromTemplate(workspace, template);
      for (const made of dots) expect(DOT_SPECIES).toContain(made.species);
      // Leads wear nothing (stored as no gear); the rest of the team dresses for the job.
      expect(dots.filter((made) => made.gear).length).toBe(dots.length - 1);
    }
  });
});

describe('dots.species and dots.gear migration', () => {
  it('adds the columns to an old database and treats unknown values as unset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fulldots-look-'));
    const path = join(dir, 'old.sqlite');
    cleanups.push(() =>
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 }),
    );
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      INSERT INTO spaces VALUES ('space-1', 'Home', '', 1);
      INSERT INTO dots VALUES ('dot-old', 'space-1', 'Old Dot', 'Has been here a while.', 1, 0, 2);`);
    old.close();
    const workspace = new WorkspaceStore(path, 'owner');
    cleanups.push(() => workspace.close());
    const [dot] = workspace.dots();
    expect(dot.species).toBeUndefined();
    expect(dot.gear).toBeUndefined();
    workspace.close();
    cleanups.pop();

    // A value written by a later version that this one does not know reads as unset.
    const raw = new DatabaseSync(path);
    raw.exec(
      "UPDATE dots SET species='gentoo', gear='crown' WHERE id='dot-old'",
    );
    raw.close();
    const reopened = new WorkspaceStore(path, 'owner');
    cleanups.push(() => reopened.close());
    const [again] = reopened.dots();
    expect('species' in again).toBe(false);
    expect('gear' in again).toBe(false);
  });
});

describe('Mascot penguin', () => {
  it('derives a stable species from the id when none is chosen', () => {
    for (const id of ['a', 'dot-1', 'scout', 'x'.repeat(40)]) {
      expect(DOT_SPECIES).toContain(speciesFor(id));
      expect(speciesFor(id)).toBe(speciesFor(id));
      expect(dotSpecies({ id })).toBe(speciesFor(id));
    }
    expect(dotSpecies({ id: 'a', species: 'chick' })).toBe('chick');
    expect(
      new Set(Array.from({ length: 40 }, (_, i) => speciesFor(`dot-${i}`)))
        .size,
    ).toBe(DOT_SPECIES.length);
  });

  it('draws the chosen species and gear, else the derived species and no gear', () => {
    const chosen = renderToStaticMarkup(
      createElement(Mascot, {
        identity: 'dot-1',
        ...dotLook({ species: 'adelie', gear: 'glasses' }),
      }),
    );
    expect(chosen).toContain('fill="#fff"/>');
    expect(chosen).toContain('stroke="#262a38" stroke-width="2.4"');
    const plain = renderToStaticMarkup(
      createElement(Mascot, { identity: 'dot-1' }),
    );
    expect(plain).not.toContain('stroke="#262a38"');
    expect(dotLook(undefined)).toEqual({});
  });
});
