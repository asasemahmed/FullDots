import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function fixture() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => {
    store.close();
    workspace.close();
  });
  const config = { baseUrl: 'https://example.com', voiceName: 'fixture' };
  const platform = new Platform(store, workspace, config);
  const app = createApp({
    store,
    platform,
    runner: new Runner(store, { ...config, mode: 'sample' }),
    config: { ...config, mode: 'sample' },
    ownerToken: 'fixture-owner-token',
    origin: 'http://localhost',
  });
  const id = workspace.dots()[0].id;
  const path = `/api/dots/${id}/coding-agents`;
  const request = (body: unknown) => ({
    method: 'PUT',
    headers: {
      Authorization: 'Bearer fixture-owner-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { app, store, workspace, platform, id, path, request };
}

it('requires owner authentication and the same origin for coding settings', async () => {
  const f = fixture();
  expect((await f.app.request(f.path)).status).toBe(401);
  expect(
    (
      await f.app.request(f.path, {
        ...f.request({ enabled: true }),
        headers: {
          ...f.request({}).headers,
          Origin: 'https://another.example',
        },
      })
    ).status,
  ).toBe(403);
  expect(f.store.codingSessions.enabled(f.id)).toBe(false);
});

it('defaults off, persists per-Dot opt-in, and stops active work when disabled', async () => {
  const f = fixture();
  const headers = f.request({}).headers;
  expect(await (await f.app.request(f.path, { headers })).json()).toEqual({
    enabled: false,
    provider: 'claude',
  });
  expect(
    await (await f.app.request(f.path, f.request({ enabled: true }))).json(),
  ).toEqual({ enabled: true, provider: 'claude' });
  expect(f.store.codingSessions.enabled(f.id)).toBe(true);
  const stop = vi.spyOn(f.platform.turns, 'stop');
  expect(
    await (await f.app.request(f.path, f.request({ enabled: false }))).json(),
  ).toEqual({ enabled: false, provider: 'claude' });
  expect(stop).toHaveBeenCalledWith(f.id);
});

it('rejects unknown Dots and arbitrary settings without making changes', async () => {
  const f = fixture();
  expect(
    (
      await f.app.request(
        '/api/dots/missing/coding-agents',
        f.request({ enabled: true }),
      )
    ).status,
  ).toBe(404);
  for (const body of [
    null,
    {},
    { enabled: 'true' },
    { enabled: true, command: 'untrusted' },
    { enabled: true, provider: 'gemini' },
    { enabled: true, provider: 'constructor' },
    { enabled: true, provider: null },
  ])
    expect((await f.app.request(f.path, f.request(body))).status).toBe(400);
  expect(f.store.codingSessions.enabled(f.id)).toBe(false);
});

it('saves the chosen coding agent, keeps it when a save leaves it out, and reads it back', async () => {
  const f = fixture();
  const headers = f.request({}).headers;
  expect(
    await (
      await f.app.request(
        f.path,
        f.request({ enabled: true, provider: 'codex' }),
      )
    ).json(),
  ).toEqual({ enabled: true, provider: 'codex' });
  expect(f.store.codingSessions.provider(f.id)).toBe('codex');
  expect(
    await (await f.app.request(f.path, f.request({ enabled: false }))).json(),
  ).toEqual({ enabled: false, provider: 'codex' });
  expect(await (await f.app.request(f.path, { headers })).json()).toEqual({
    enabled: false,
    provider: 'codex',
  });
  await f.app.request(f.path, f.request({ enabled: true, provider: 'claude' }));
  expect(f.store.codingSessions.provider(f.id)).toBe('claude');
});
