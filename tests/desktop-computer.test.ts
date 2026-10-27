import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ComputerStore } from '../src/server/computer-store.js';
import { ComputerService } from '../src/server/computer-service.js';
import { computerRoutes } from '../src/server/computer-routes.js';
import {
  computerInputs,
  computerPermissionsSchema,
} from '../src/shared/computer-types.js';
import { classify, intentHash, redactArgs } from '../src/server/approvals.js';
import { gateParse } from '../src/server/approval-gate.js';
import { emptyRules } from '../src/shared/rules.js';
import { computerTools } from '../src/server/computer-tools.js';
import { ModelProviderRegistry } from '../src/server/model-providers.js';
import { modelProviderRoutes } from '../src/server/model-provider-routes.js';
import { createFakeProvider } from './fixtures/fake-provider.js';

const stores: Array<{ close(): void }> = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
const valid = {
  desktop_screenshot: {},
  desktop_click: { x: 1279, y: 799 },
  desktop_drag: { from: { x: 0, y: 0 }, to: { x: 1279, y: 799 } },
  desktop_type: { text: 'Harmless fixture' },
  desktop_key: { keys: 'Control_L+s' },
  desktop_scroll: { x: 10, y: 10, dx: 0, dy: 400 },
} as const;
it('validates every desktop schema strictly and uses screenshot pixel bounds', () => {
  for (const action of Object.keys(valid) as Array<keyof typeof valid>) {
    expect(computerInputs[action].safeParse(valid[action]).success).toBe(true);
    expect(
      computerInputs[action].safeParse({ ...valid[action], unexpected: true })
        .success,
    ).toBe(false);
    expect(gateParse(action, valid[action])).toEqual(
      computerInputs[action].parse(valid[action]),
    );
  }
  for (const x of [-1, 1280, 1.5, Infinity, NaN])
    expect(computerInputs.desktop_click.safeParse({ x, y: 0 }).success).toBe(
      false,
    );
  expect(
    computerInputs.desktop_drag.safeParse({
      from: { x: 0, y: 0, extra: true },
      to: { x: 0, y: 0 },
    }).success,
  ).toBe(false);
  expect(
    computerInputs.desktop_type.safeParse({ text: 'x'.repeat(16001) }).success,
  ).toBe(false);
  expect(computerPermissionsSchema.partial().parse({ files: true })).toEqual({
    files: true,
  });
});
it('migrates the existing permissions table without rewriting values and preserves kind on unrelated updates', () => {
  const db = new DatabaseSync(':memory:');
  stores.push(db);
  db.exec(
    'CREATE TABLE computer_permissions(dotId TEXT PRIMARY KEY,value TEXT NOT NULL)',
  );
  db.prepare('INSERT INTO computer_permissions VALUES (?,?)').run(
    'fixture',
    JSON.stringify({
      enabled: true,
      browser: true,
      files: false,
      shell: false,
    }),
  );
  const store = new ComputerStore(db);
  expect(store.permissions('fixture')).toMatchObject({
    kind: 'browser',
    desktop: false,
    browser: true,
  });
  store.patch('fixture', { kind: 'desktop', desktop: true });
  store.patch('fixture', { files: true });
  expect(store.permissions('fixture')).toMatchObject({
    kind: 'desktop',
    desktop: true,
    files: true,
  });
  expect(new ComputerStore(db).permissions('fixture').kind).toBe('desktop');
});
it('gates every desktop input and always asks for typing outside off mode despite allow overrides', () => {
  for (const mode of ['sensitive', 'writes', 'off'] as const) {
    for (const tool of Object.keys(valid)) {
      const result = classify({ tool, args: {} }, mode);
      expect(result.gated).toBe(
        tool !== 'desktop_screenshot' && mode !== 'off',
      );
    }
    expect(
      classify(
        {
          tool: 'desktop_type',
          args: { text: 'fixture' },
          mcp: { readOnly: false, destructive: false, override: 'allow' },
        },
        mode,
        { ...emptyRules(), risky_clicks: 'allow', write_files: 'allow' },
      ).gated,
    ).toBe(mode !== 'off');
  }
  for (const tool of [
    'desktop_unknown',
    'computer_desktop_unknown',
    'computer_unknown',
  ])
    expect(classify({ tool, args: {} }, 'sensitive')).toMatchObject({
      level: 'sensitive',
      gated: true,
    });
  expect(
    redactArgs('desktop_type', { text: 'private fixture text' }),
  ).not.toContain('private fixture text');
  expect(intentHash({ tool: 'desktop_type', args: { text: 'one' } })).not.toBe(
    intentHash({ tool: 'desktop_type', args: { text: 'two' } }),
  );
});
it('preserves browser click, typing, key, read and write approval decisions', () => {
  const ordinary = { role: 'button', name: 'Continue' };
  const sensitive = { role: 'button', name: 'Send message' };
  for (const mode of ['sensitive', 'writes', 'off'] as const) {
    expect(
      classify({ tool: 'computer_click', args: {}, element: ordinary }, mode)
        .gated,
    ).toBe(false);
    expect(
      classify({ tool: 'computer_click', args: {}, element: sensitive }, mode)
        .gated,
    ).toBe(mode !== 'off');
    expect(
      classify(
        {
          tool: 'computer_type',
          args: { text: 'fixture', submit: false },
          element: sensitive,
        },
        mode,
      ).gated,
    ).toBe(false);
    expect(
      classify(
        {
          tool: 'computer_type',
          args: { text: 'fixture', submit: true },
          element: sensitive,
        },
        mode,
      ).gated,
    ).toBe(mode !== 'off');
    expect(
      classify({ tool: 'computer_key', args: { key: 'Tab' } }, mode).gated,
    ).toBe(false);
    for (const tool of [
      'computer_navigate',
      'computer_read',
      'computer_snapshot',
      'computer_screenshot',
      'computer_scroll',
      'computer_search',
    ])
      expect(classify({ tool, args: {} }, mode).gated).toBe(false);
    expect(
      classify({ tool: 'computer_files_write', args: {} }, mode).gated,
    ).toBe(mode === 'writes');
  }
});

function fixture() {
  const workspace = new WorkspaceStore(':memory:', 'desktop-owner');
  stores.push(workspace);
  const id = workspace.dots()[0].id;
  const requests: Array<{ path: string; body?: unknown }> = [];
  let running = true,
    images = false;
  const transport: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    requests.push({
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (path === '/computers')
      return Response.json({
        computers: running
          ? [
              {
                botId: id,
                container: `opendots-computer-${id}`,
                status: 'running',
                port: 43123,
              },
            ]
          : [],
      });
    if (path.endsWith('/ensure'))
      return Response.json({
        botId: id,
        container: `opendots-computer-${id}`,
        status: 'running',
        port: 43123,
      });
    if (path === '/control')
      return Response.json({
        holder: 'bot',
        requested: false,
        transitioning: false,
        resumeSnapshotRequired: false,
      });
    return Response.json({ action: path, text: 'fixture' });
  };
  const service = new ComputerService(
    workspace,
    {
      baseUrl: 'https://model.invalid',
      voiceName: 'fixture',
      computerSupervisorUrl: 'http://127.0.0.1:4312',
      computerSupervisorToken: 'fixture-supervisor',
      computerToken: 'fixture-master',
    },
    () => false,
    transport,
  );
  service.setModels({ hasModelImages: () => images });
  const policy = {
    enabled: true,
    browser: true,
    files: true,
    shell: false,
    desktop: true,
    kind: 'desktop' as const,
  };
  workspace.computers.patch(id, policy);
  return {
    workspace,
    id,
    requests,
    service,
    policy,
    stop() {
      running = false;
    },
    enableImages() {
      images = true;
    },
  };
}
it('refuses agent desktop actions without vision, desktop permission or desktop kind, while preserving browser actions', async () => {
  const f = fixture();
  for (const action of Object.keys(valid) as Array<keyof typeof valid>)
    await expect(
      f.service.action(f.id, action, valid[action], 'agent'),
    ).rejects.toThrow('Settings');
  expect(f.requests).toHaveLength(0);
  await expect(
    f.service.action(f.id, 'read', {}, 'agent'),
  ).resolves.toMatchObject({ text: 'fixture' });
  f.enableImages();
  f.workspace.computers.patch(f.id, { desktop: false });
  await expect(
    f.service.action(f.id, 'desktop_click', valid.desktop_click, 'agent'),
  ).rejects.toThrow('permission');
  f.workspace.computers.patch(f.id, { desktop: true, kind: 'browser' });
  await expect(
    f.service.action(f.id, 'desktop_click', valid.desktop_click, 'agent'),
  ).rejects.toThrow('Desktop computer');
});
it('owner routes enforce kind changes, strict input and preserve desktop selection when toggling a permission', async () => {
  const f = fixture();
  const app = computerRoutes(f.service);
  const update = (body: unknown) =>
    app.request(`/dots/${f.id}/computer/permissions`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect((await update({ kind: 'browser' })).status).toBe(409);
  expect((await update({ files: false })).status).toBe(200);
  expect(f.workspace.computers.permissions(f.id)).toMatchObject({
    kind: 'desktop',
    desktop: true,
    files: false,
  });
  expect((await update({ kind: 'unknown' })).status).toBe(400);
  f.stop();
  expect((await update({ kind: 'browser' })).status).toBe(200);
  expect(
    (await app.request(`/dots/${f.id}/computer/start`, { method: 'POST' }))
      .status,
  ).toBe(200);
  expect(
    f.requests.find((request) => request.path.endsWith('/ensure'))?.body,
  ).toEqual({ kind: 'browser' });
});
it('omits desktop tools when the approval middleware is absent and keeps browser tools in desktop mode', () => {
  const f = fixture();
  const signal = new AbortController().signal;
  expect(
    computerTools(f.service, f.id, () => {}, signal).map((tool) => tool.name),
  ).not.toContain('desktop_type');
  const names = computerTools(f.service, f.id, () => {}, signal, {
    desktopGate: true,
  }).map((tool) => tool.name);
  expect(names).toContain('desktop_type');
  expect(names).toContain('computer_navigate');
  expect(names).toContain('computer_search');
});
it('persists per-model images flags, defaults off and ignores malformed stored flags', () => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-models-'));
  const path = join(dir, 'workspace.sqlite');
  let workspace = new WorkspaceStore(path, 'desktop-owner');
  try {
    expect(workspace.modelProviders.getModelImages('env', 'fixture')).toBe(
      false,
    );
    workspace.modelProviders.setModelImages('env', 'fixture', true);
    workspace.close();
    workspace = new WorkspaceStore(path, 'desktop-owner');
    expect(workspace.modelProviders.getModelImages('env', 'fixture')).toBe(
      true,
    );
    const db = new DatabaseSync(path);
    db.prepare('UPDATE model_settings SET value=? WHERE key=?').run(
      JSON.stringify({ 'env:fixture': 'true' }),
      'modelImages',
    );
    db.close();
    expect(workspace.modelProviders.getModelImages('env', 'fixture')).toBe(
      false,
    );
  } finally {
    workspace.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('owner image settings routes accept only the flag and resolve the actual model/provider', async () => {
  const workspace = new WorkspaceStore(':memory:', 'desktop-owner');
  stores.push(workspace);
  const fake = createFakeProvider();
  const registry = new ModelProviderRegistry(workspace.modelProviders, {
    env: {
      apiKey: 'fixture',
      model: 'fake-small',
      baseUrl: 'https://model.invalid',
      voiceName: 'fixture',
    },
    fetch: fake.fetch,
  });
  const app = modelProviderRoutes({
    registry,
    store: workspace.modelProviders,
    usage: () => [],
  });
  const save = (body: unknown) =>
    app.request('/model-providers/images', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect(registry.hasModelImages()).toBe(false);
  expect(
    (await save({ providerId: 'env', model: 'fake-small', images: true }))
      .status,
  ).toBe(200);
  expect(registry.hasModelImages()).toBe(true);
  expect(registry.hasModelImages('deleted-provider', 'fake-small')).toBe(true);
  expect(
    (await save({ providerId: 'env', model: 'fake-small', images: 'true' }))
      .status,
  ).toBe(400);
  expect(
    (
      await save({
        providerId: 'env',
        model: 'fake-small',
        images: false,
        key: 'not-used',
      })
    ).status,
  ).toBe(400);
  expect(
    (await save({ providerId: 'missing', model: 'fake-small', images: true }))
      .status,
  ).toBe(400);
  expect(
    (await save({ providerId: 'env', model: 'fake-small', images: false }))
      .status,
  ).toBe(200);
  expect(registry.hasModelImages()).toBe(false);
});
