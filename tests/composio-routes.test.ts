import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { Dot, WorkspaceState } from '../src/shared/types.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function boot(composioApiKey?: string) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const platform = new Platform(store, workspace, {
    baseUrl: 'https://unused.invalid/v1',
    voiceName: 'marin',
    ...(composioApiKey ? { composioApiKey } : {}),
  });
  const runner = new Runner(store, { mode: 'sample', baseUrl: '' });
  cleanups.push(async () => {
    await platform.stop();
    store.close();
    workspace.close();
  });
  const app = createApp({
    store,
    runner,
    config: { mode: 'sample', baseUrl: '' },
    platform,
  });
  return { app, store, workspace, runner, dot: workspace.dots()[0]! };
}

const send = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('Composio routes', () => {
  it('hides the setup flag without a key and shows it with one', async () => {
    const off = boot();
    const hidden = (await (
      await off.app.request('/api/workspace')
    ).json()) as WorkspaceState;
    expect(hidden.setup.composio).toBe(false);
    expect(hidden.dots[0]).toMatchObject({
      composioAllowed: false,
      composioToolkits: [],
    });

    const on = boot('test-key');
    const shown = (await (
      await on.app.request('/api/workspace')
    ).json()) as WorkspaceState;
    expect(shown.setup.composio).toBe(true);
  });

  it('stores the per-Dot switch and allow-list, and leaves the session off the response', async () => {
    const { app, workspace, dot } = boot('test-key');
    const base = {
      name: 'Writer',
      instructions: 'Writes clearly.',
      researchAllowed: true,
      memoryAllowed: true,
      spaceId: dot.spaceId,
    };
    const created = await app.request(
      '/api/dots',
      send('POST', {
        ...base,
        composioAllowed: true,
        composioToolkits: ['google_calendar', 'gmail'],
      }),
    );
    expect(created.status).toBe(201);
    const writer = (await created.json()) as Dot;
    expect(writer.composioAllowed).toBe(true);
    expect(writer.composioToolkits).toEqual(['gmail', 'google_calendar']);

    const kept = (await (
      await app.request(
        `/api/dots/${writer.id}`,
        send('PUT', { ...base, name: 'Writer 2' }),
      )
    ).json()) as Dot;
    expect(kept.composioAllowed).toBe(true);
    expect(kept.composioToolkits).toEqual(['gmail', 'google_calendar']);

    workspace.composio.saveSession(writer.id, 'ses_secret', 'hash');
    const body = await (await app.request('/api/workspace')).text();
    expect(body).not.toContain('ses_secret');
    expect(body).not.toContain('composioSessionId');

    const rejected = await app.request(
      '/api/dots',
      send('POST', { ...base, composioToolkits: ['Not A Slug'] }),
    );
    expect(rejected.status).toBe(400);
  });

  it('saves the workspace switch and stops work only when it changes', async () => {
    const { app, runner } = boot('test-key');
    const abort = vi.spyOn(runner, 'abortAll');
    const first = await app.request(
      '/api/settings',
      send('PATCH', { composioAllowed: true }),
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ composioAllowed: true });
    expect(abort).toHaveBeenCalledOnce();

    abort.mockClear();
    const same = await app.request(
      '/api/settings',
      send('PATCH', { composioAllowed: true }),
    );
    expect(same.status).toBe(200);
    expect(abort).not.toHaveBeenCalled();

    const off = await app.request(
      '/api/settings',
      send('PATCH', { composioAllowed: false }),
    );
    expect(await off.json()).toMatchObject({ composioAllowed: false });
    expect(abort).toHaveBeenCalledOnce();
  });
});
