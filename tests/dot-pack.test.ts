// Dot packs: a Dot exports to a small file and an import creates a new Dot from it. These tests use
// only in-memory databases. Secret-looking values are built at run time, so no literal in this file
// matches a real key pattern.
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import {
  exportDotPack,
  importDotPack,
  parseDotPack,
} from '../src/server/dot-pack.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  DOT_PACK_KIND,
  DOT_PACK_MAX_PROMPTS,
  DOT_PACK_VERSION,
} from '../src/shared/dot-pack.js';
import type { Dot } from '../src/shared/types.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Built at run time: an OpenAI-style key shape, never written out in full here.
const FAKE_KEY = ['sk-', 'proj', 'Q7w8E9r0T1y2U3i4O5p6'].join('');

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
  return { app, workspace, space: workspace.spaces()[0]! };
}

/** A Dot with every exportable field set, plus fields that must never travel. */
function richDot(workspace: WorkspaceStore, spaceId: string): Dot {
  const dot = workspace.createDot(
    spaceId,
    'Market Scout',
    'Track prices and summarise them for the owner.',
    false,
    true,
    undefined,
    'vendor/model-x',
    'off',
    null,
    { color: 'mint', species: 'adelie', gear: 'scarf' },
  );
  workspace.rules.set(dot.id, { send_messages: 'ask', publish: 'never' });
  workspace.prompts.create({
    title: 'Weekly digest',
    body: 'Summarise the week.',
    scope: 'dot',
    dotId: dot.id,
    teamId: null,
  });
  workspace.prompts.create({
    title: 'For everyone',
    body: 'Shared text.',
    scope: 'global',
    dotId: null,
    teamId: null,
  });
  workspace.computers.patch(dot.id, {
    enabled: true,
    browser: true,
    files: true,
    shell: true,
  });
  return workspace.dot(dot.id)!;
}

const send = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const LISTED_FIELDS = [
  'kind',
  'version',
  'name',
  'instructions',
  'color',
  'species',
  'gear',
  'approvalMode',
  'researchAllowed',
  'memoryAllowed',
  'rules',
  'prompts',
].sort();

describe('exporting a Dot', () => {
  it('contains exactly the listed fields and nothing else', () => {
    const { workspace, space } = boot();
    const dot = richDot(workspace, space.id);
    const pack = exportDotPack(workspace, dot);
    expect(Object.keys(pack).sort()).toEqual(LISTED_FIELDS);
    expect(pack).toMatchObject({
      kind: DOT_PACK_KIND,
      version: DOT_PACK_VERSION,
      name: 'Market Scout',
      color: 'mint',
      species: 'adelie',
      gear: 'scarf',
      approvalMode: 'off',
      researchAllowed: false,
      memoryAllowed: true,
    });
  });

  it('carries only the rules that are set, and only this Dot’s prompts', () => {
    const { workspace, space } = boot();
    const dot = richDot(workspace, space.id);
    const pack = exportDotPack(workspace, dot);
    expect(pack.rules).toEqual({ send_messages: 'ask', publish: 'never' });
    expect(pack.prompts).toEqual([
      { title: 'Weekly digest', body: 'Summarise the week.' },
    ]);
  });

  it('leaves out ids, the model, Composio, computer access, notes and memories', () => {
    const { workspace, space } = boot();
    const dot = richDot(workspace, space.id);
    workspace.composio.savePolicy(dot.id, {
      allowed: true,
      toolkits: ['gmail'],
    });
    workspace.notes.put(dot.id, 'Private owner note about budgets.');
    const text = JSON.stringify(exportDotPack(workspace, dot));
    for (const forbidden of [
      dot.id,
      space.id,
      'vendor/model-x',
      'gmail',
      'Private owner note',
      'computer',
      'composio',
      'spaceIds',
      'createdAt',
    ])
      expect(text).not.toContain(forbidden);
  });

  it('replaces secrets in the role and the name with [redacted]', () => {
    const { workspace, space } = boot();
    const dot = workspace.createDot(
      space.id,
      'Helper',
      `Use this key when calling the API: ${FAKE_KEY}. Keep answers short.`,
      true,
      true,
    );
    const pack = exportDotPack(workspace, workspace.dot(dot.id)!);
    expect(JSON.stringify(pack)).not.toContain(FAKE_KEY);
    expect(pack.instructions).toContain('[redacted]');
    expect(pack.instructions).toContain('Keep answers short.');
  });

  it('serves the pack as a download named after the Dot', async () => {
    const { app, workspace, space } = boot();
    const dot = richDot(workspace, space.id);
    const response = await app.request(`/api/dots/${dot.id}/pack`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="market-scout.dot-pack.json"',
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(LISTED_FIELDS);
  });

  it('answers 404 for a Dot that does not exist', async () => {
    const { app } = boot();
    const response = await app.request('/api/dots/no-such-dot/pack');
    expect(response.status).toBe(404);
  });
});

describe('importing a Dot pack', () => {
  it('creates a new Dot and never overwrites one', () => {
    const { workspace, space } = boot();
    const source = richDot(workspace, space.id);
    const pack = parseDotPack(JSON.stringify(exportDotPack(workspace, source)));
    const before = workspace.dots().length;
    const { dot } = importDotPack(workspace, pack);
    expect(dot.id).not.toBe(source.id);
    expect(workspace.dots().length).toBe(before + 1);
    expect(workspace.dot(source.id)).toMatchObject({
      name: 'Market Scout',
      approvalMode: 'off',
    });
    importDotPack(workspace, pack);
    expect(workspace.dots().length).toBe(before + 2);
  });

  it('restores the look, the switches, the rules and the prompts on the new Dot', () => {
    const { workspace, space } = boot();
    const source = richDot(workspace, space.id);
    const pack = parseDotPack(JSON.stringify(exportDotPack(workspace, source)));
    const { dot } = importDotPack(workspace, pack);
    expect(dot).toMatchObject({
      name: 'Market Scout',
      instructions: 'Track prices and summarise them for the owner.',
      color: 'mint',
      species: 'adelie',
      gear: 'scarf',
      researchAllowed: false,
      memoryAllowed: true,
    });
    expect(workspace.rules.get(dot.id)).toMatchObject({
      send_messages: 'ask',
      publish: 'never',
    });
    expect(workspace.prompts.list(dot.id).map((p) => p.title)).toContain(
      'Weekly digest',
    );
  });

  it('turns "off" into "sensitive", and keeps the stricter "writes"', () => {
    const { workspace } = boot();
    const off = parseDotPack(
      JSON.stringify({ ...minimalPack(), approvalMode: 'off' }),
    );
    expect(importDotPack(workspace, off).dot.approvalMode).toBe('sensitive');
    const writes = parseDotPack(
      JSON.stringify({ ...minimalPack(), approvalMode: 'writes' }),
    );
    expect(importDotPack(workspace, writes).dot.approvalMode).toBe('writes');
  });

  it('gives the new Dot no connector grants, no Composio access and no computer access', () => {
    const { workspace, space } = boot();
    const source = richDot(workspace, space.id);
    workspace.computers.patch(source.id, { enabled: true, shell: true });
    workspace.composio.savePolicy(source.id, {
      allowed: true,
      toolkits: ['gmail'],
    });
    const pack = parseDotPack(JSON.stringify(exportDotPack(workspace, source)));
    const { dot } = importDotPack(workspace, pack);
    expect(workspace.connectors.grants(dot.id)).toEqual([]);
    expect(workspace.dot(dot.id)?.composioAllowed ?? false).toBe(false);
    expect(workspace.dot(dot.id)?.composioToolkits ?? []).toEqual([]);
    expect(workspace.computers.permissions(dot.id)).toEqual({
      kind: 'browser',
      desktop: false,
      enabled: false,
      browser: false,
      files: false,
      shell: false,
    });
  });

  it('replaces secrets in the role on the way in, and counts them', () => {
    const { workspace } = boot();
    const pack = parseDotPack(
      JSON.stringify({
        ...minimalPack(),
        instructions: `Call the service with ${FAKE_KEY} and report back.`,
      }),
    );
    const { dot, hidden } = importDotPack(workspace, pack);
    expect(dot.instructions).not.toContain(FAKE_KEY);
    expect(dot.instructions).toContain('[redacted]');
    expect(hidden).toBeGreaterThanOrEqual(1);
  });

  it('refuses a locked rule set to allow, and creates nothing', () => {
    const { workspace } = boot();
    const pack = parseDotPack(
      JSON.stringify({ ...minimalPack(), rules: { spend_money: 'allow' } }),
    );
    const before = workspace.dots().length;
    expect(() => importDotPack(workspace, pack)).toThrow(
      'Spend money can only be Inherit, Ask me first or Never.',
    );
    expect(workspace.dots().length).toBe(before);
  });

  it('round-trips through a file to another install with the same content', () => {
    const first = boot();
    const source = richDot(first.workspace, first.space.id);
    const file = JSON.stringify(exportDotPack(first.workspace, source));
    const second = boot();
    const { dot } = importDotPack(second.workspace, parseDotPack(file));
    // The source Dot was on "off"; the copy starts on "sensitive", the rule for every pack.
    expect(exportDotPack(second.workspace, dot)).toEqual({
      ...JSON.parse(file),
      approvalMode: 'sensitive',
    });
  });
});

describe('refusing a bad pack', () => {
  it('refuses an unknown field and names it', () => {
    expect(() =>
      parseDotPack(JSON.stringify({ ...minimalPack(), apiKey: 'x' })),
    ).toThrow('a field FullDots does not know: apiKey');
  });

  it('refuses a file that is not a Dot pack', () => {
    expect(() =>
      parseDotPack(
        JSON.stringify({ ...minimalPack(), kind: 'something-else' }),
      ),
    ).toThrow('This file is not a FullDots Dot pack.');
  });

  it('refuses a pack version this FullDots does not read', () => {
    expect(() =>
      parseDotPack(JSON.stringify({ ...minimalPack(), version: 2 })),
    ).toThrow('This pack version is not supported.');
  });

  it('refuses text over the limits, with the limit in the message', () => {
    expect(() =>
      parseDotPack(
        JSON.stringify({ ...minimalPack(), instructions: 'x'.repeat(2001) }),
      ),
    ).toThrow('The role is at most 2,000 characters.');
    expect(() =>
      parseDotPack(JSON.stringify({ ...minimalPack(), name: 'n'.repeat(41) })),
    ).toThrow('The name is at most 40 characters.');
  });

  it('refuses more prompts than a pack holds', () => {
    const prompts = Array.from(
      { length: DOT_PACK_MAX_PROMPTS + 1 },
      (_, i) => ({
        title: `Prompt ${i}`,
        body: 'Text.',
      }),
    );
    expect(() =>
      parseDotPack(JSON.stringify({ ...minimalPack(), prompts })),
    ).toThrow(`A pack holds at most ${DOT_PACK_MAX_PROMPTS} prompts.`);
  });

  it('refuses a rule for a category this FullDots does not know, or a rule value it does not know', () => {
    expect(() =>
      parseDotPack(
        JSON.stringify({ ...minimalPack(), rules: { teleport: 'ask' } }),
      ),
    ).toThrow();
    expect(() =>
      parseDotPack(
        JSON.stringify({ ...minimalPack(), rules: { publish: 'sometimes' } }),
      ),
    ).toThrow();
  });

  it('refuses a file that is not JSON', () => {
    expect(() => parseDotPack('{ not json')).toThrow(
      'This file is not valid JSON.',
    );
  });

  it('refuses a file over 200 KB before parsing it', () => {
    const huge = `{"pad":"${'a'.repeat(200_001)}"}`;
    expect(() => parseDotPack(huge)).toThrow('too large');
  });

  it('answers the import route with 400 for a bad pack and creates nothing', async () => {
    const { app, workspace } = boot();
    const before = workspace.dots().length;
    const response = await app.request(
      '/api/dots/import-pack',
      send('POST', { ...minimalPack(), kind: 'nope' }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      'not a FullDots Dot pack',
    );
    expect(workspace.dots().length).toBe(before);
  });

  it('answers 413 when the request declares an oversize body', async () => {
    const { app } = boot();
    const response = await app.request('/api/dots/import-pack', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '300000',
      },
      body: '{}',
    });
    expect(response.status).toBe(413);
  });

  it('imports through the route and returns the new Dot', async () => {
    const { app, workspace } = boot();
    const response = await app.request(
      '/api/dots/import-pack',
      send('POST', minimalPack()),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { dot: Dot; hidden: number };
    expect(body.dot.name).toBe('Research helper');
    expect(workspace.dot(body.dot.id)).toBeDefined();
  });
});

/** A small valid pack. Tests change one field at a time. */
function minimalPack() {
  return {
    kind: DOT_PACK_KIND,
    version: DOT_PACK_VERSION,
    name: 'Research helper',
    instructions: 'Find sources and summarise them.',
  };
}
