import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { connectorRoutes } from '../src/server/connector-routes.js';
import { ConnectorStore } from '../src/server/connector-store.js';
import {
  ConnectorRegistry,
  type ConnectorRegistryOptions,
} from '../src/server/connectors.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { ConnectorView } from '../src/shared/types.js';
import { createMcpFixture } from './fixtures/mcp-server.js';

const PLANTED = 'planted-secret-value-123';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup(
  options: { allowStdio?: boolean } & Partial<ConnectorRegistryOptions> = {},
) {
  const { allowStdio = false, ...registryOptions } = options;
  const db = new DatabaseSync(':memory:');
  const store = new ConnectorStore(db);
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const fixture = createMcpFixture();
  const registry = new ConnectorRegistry(store, {
    allowStdio,
    resultMaxChars: 20_000,
    env: { T: PLANTED },
    transport: (connector) => fixture.transport(connector),
    ...registryOptions,
  });
  cleanups.push(async () => {
    await registry.stop();
    await fixture.close();
    workspace.close();
    db.close();
  });
  const app = new Hono().route(
    '/api',
    connectorRoutes({ store, registry, workspace, allowStdio }),
  );
  const dot = workspace.createDot(
    workspace.spaces()[0].id,
    'Dot',
    '',
    true,
    true,
  );
  // Every response of this file passes through here: none may carry the resolved secret.
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body:
        body === undefined
          ? method === 'GET'
            ? undefined
            : '{}'
          : typeof body === 'string'
            ? body
            : JSON.stringify(body),
    });
    const text = await response.text();
    expect(text).not.toContain(PLANTED);
    return {
      status: response.status,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: JSON.parse(text) as any,
    };
  };
  return { app, store, registry, workspace, dot, call };
}

const http = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  transport: 'http',
  url: 'https://mcp.example.test/mcp',
  headers: { Authorization: { env: 'T' } },
  ...extra,
});

describe('connector CRUD', () => {
  it('lists connectors, presets and the stdio switch', async () => {
    const { call } = setup();
    const { status, body } = await call('GET', '/connectors');
    expect(status).toBe(200);
    expect(body.connectors).toEqual([]);
    expect(Array.isArray(body.presets)).toBe(true);
    expect(body.presets.map((p: { id: string }) => p.id)).toContain('github');
    expect(body.allowStdio).toBe(false);
  });

  it('creates an http connector with an env reference and never shows the value', async () => {
    const { call } = setup();
    const created = await call('POST', '/connectors', http('github'));
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('github');
    expect(created.body.headers).toEqual({
      Authorization: { env: 'T', set: true },
    });
    expect(created.body.warnings).toBeUndefined();
    const list = await call('GET', '/connectors');
    expect(list.body.connectors).toHaveLength(1);
    expect(list.body.connectors[0].id).toBe(created.body.id);
  });

  it('shows an env reference whose variable is unset as set: false', async () => {
    const { call } = setup();
    const created = await call(
      'POST',
      '/connectors',
      http('notset', { headers: { Authorization: { env: 'NOT_DEFINED' } } }),
    );
    expect(created.status).toBe(201);
    expect(created.body.headers.Authorization).toEqual({
      env: 'NOT_DEFINED',
      set: false,
    });
    expect(created.body.status.state).toBe('missing_env');
  });

  it('rejects a literal Authorization header with the list of errors', async () => {
    const { call, store } = setup();
    const { status, body } = await call(
      'POST',
      '/connectors',
      http('bad', { headers: { Authorization: { literal: 'Bearer abc' } } }),
    );
    expect(status).toBe(400);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatch(/Authorization must reference/);
    expect(body.error).toBe(body.errors[0]);
    expect(body.warnings).toEqual([]);
    expect(store.list()).toEqual([]);
  });

  it('accepts a credential-looking literal under a plain name with a warning', async () => {
    const { call } = setup();
    const { status, body } = await call(
      'POST',
      '/connectors',
      http('warned', {
        headers: { 'X-Client': { literal: 'abcdefghij0123456789ABCDEFGH' } },
      }),
    );
    expect(status).toBe(201);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toMatch(/X-Client looks like a credential/);
    expect(body.name).toBe('warned');
    expect(body.status).toBeDefined();
  });

  it('rejects stdio when it is off and accepts it when on', async () => {
    const off = setup();
    const refused = await off.call('POST', '/connectors', {
      name: 'proc',
      transport: 'stdio',
      command: 'node',
      args: [],
      env: {},
    });
    expect(refused.status).toBe(400);
    expect(refused.body.errors[0]).toMatch(/stdio connectors are off/);
    const on = setup({ allowStdio: true });
    const created = await on.call('POST', '/connectors', {
      name: 'proc',
      transport: 'stdio',
      command: 'node',
      args: ['x.js'],
      env: {},
    });
    expect(created.status).toBe(201);
    expect(created.body.command).toBe('node');
  });

  it('rejects malformed JSON, unknown fields and duplicate names with 400', async () => {
    const { call } = setup();
    expect((await call('POST', '/connectors', 'not json')).status).toBe(400);
    const extra = await call('POST', '/connectors', http('x', { nope: 1 }));
    expect(extra.status).toBe(400);
    expect(extra.body.errors.length).toBeGreaterThan(0);
    expect((await call('POST', '/connectors', http('dup'))).status).toBe(201);
    const dup = await call('POST', '/connectors', http('dup'));
    expect(dup.status).toBe(400);
    expect(dup.body.error).toBe('A connector with that name exists.');
  });

  it('patches enabled alone, even for a stdio connector while stdio is off', async () => {
    const { call, store } = setup();
    const row = store.create({
      name: 'proc',
      transport: 'stdio',
      command: 'node',
      args: [],
    });
    const off = await call('PATCH', `/connectors/${row.id}`, {
      enabled: false,
    });
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);
    expect(off.body.status.state).toBe('disabled');
    expect(store.get(row.id)?.enabled).toBe(false);
    // Editing the rest of a stdio connector is still refused while stdio is off.
    const edit = await call('PATCH', `/connectors/${row.id}`, {
      transport: 'stdio',
      command: 'deno',
    });
    expect(edit.status).toBe(400);
    expect(edit.body.errors[0]).toMatch(/stdio connectors are off/);
    expect(store.get(row.id)?.command).toBe('node');
  });

  it('refuses a transport change', async () => {
    const { call, store } = setup({ allowStdio: true });
    const created = await call('POST', '/connectors', http('github'));
    const { status, body } = await call(
      'PATCH',
      `/connectors/${created.body.id}`,
      { transport: 'stdio', command: 'node' },
    );
    expect(status).toBe(400);
    expect(body.error).toBe('The transport of a connector cannot be changed.');
    expect(store.get(created.body.id)?.transport).toBe('http');
  });

  it('validates the merged config and stores the edit', async () => {
    const { call, store } = setup();
    const created = await call('POST', '/connectors', http('github'));
    const id = created.body.id;
    const edited = await call('PATCH', `/connectors/${id}`, {
      name: 'github2',
      transport: 'http',
      url: 'https://other.example.test/mcp',
      headers: { Authorization: { env: 'T' }, 'X-Mode': { literal: 'fast' } },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.name).toBe('github2');
    expect(edited.body.url).toBe('https://other.example.test/mcp');
    expect(edited.body.headers['X-Mode']).toEqual({ literal: 'fast' });
    expect(store.get(id)?.name).toBe('github2');
    const bad = await call('PATCH', `/connectors/${id}`, { url: 'ftp://x' });
    expect(bad.status).toBe(400);
    const literal = await call('PATCH', `/connectors/${id}`, {
      headers: { Authorization: { literal: 'x' } },
    });
    expect(literal.status).toBe(400);
    const unknown = await call('PATCH', `/connectors/${id}`, { id: 'other' });
    expect(unknown.status).toBe(400);
    expect(store.get(id)?.name).toBe('github2');
  });

  it("treats cwd '' as clearing the cwd", async () => {
    const { call, store } = setup({ allowStdio: true });
    const created = await call('POST', '/connectors', {
      name: 'proc',
      transport: 'stdio',
      command: 'node',
      args: [],
      cwd: '/srv/work',
      env: {},
    });
    expect(created.body.cwd).toBe('/srv/work');
    const { status, body } = await call(
      'PATCH',
      `/connectors/${created.body.id}`,
      {
        name: 'proc',
        transport: 'stdio',
        command: 'node',
        args: [],
        cwd: '',
        env: {},
      },
    );
    expect(status).toBe(200);
    expect(body.cwd).toBeNull();
    expect(store.get(created.body.id)?.cwd).toBeNull();
  });

  it('deletes a connector, then 404s', async () => {
    const { call, store } = setup();
    const created = await call('POST', '/connectors', http('github'));
    const id = created.body.id;
    const deleted = await call('DELETE', `/connectors/${id}`);
    expect(deleted).toEqual({ status: 200, body: { deleted: true } });
    expect(store.get(id)).toBeUndefined();
    expect((await call('DELETE', `/connectors/${id}`)).status).toBe(404);
    expect((await call('PATCH', `/connectors/${id}`, {})).status).toBe(404);
    expect((await call('POST', `/connectors/${id}/reload`)).status).toBe(404);
    expect((await call('POST', `/connectors/${id}/test`)).status).toBe(404);
    expect((await call('GET', '/connectors')).body.connectors).toEqual([]);
  });

  it('reload returns the view and test returns the status', async () => {
    const { call } = setup();
    const created = await call('POST', '/connectors', http('github'));
    const id = created.body.id;
    const reloaded = await call('POST', `/connectors/${id}/reload`);
    expect(reloaded.status).toBe(200);
    const view = reloaded.body as ConnectorView;
    expect(view.id).toBe(id);
    expect(view.status.state).toBe('connected');
    expect(view.status.tools.map((tool) => tool.name)).toContain('get_issue');
    const tested = await call('POST', `/connectors/${id}/test`);
    expect(tested.status).toBe(200);
    expect(tested.body.state).toBe('connected');
    expect(tested.body.tools.length).toBeGreaterThan(0);
    expect(tested.body.id).toBeUndefined();
  });

  it('redacts a secret that a connection error carries', async () => {
    const { call } = setup({
      transport: () => {
        throw new Error(`refused for token ${PLANTED}`);
      },
    });
    const created = await call('POST', '/connectors', http('leaky'));
    const id = created.body.id;
    const tested = await call('POST', `/connectors/${id}/test`);
    expect(tested.body.state).toBe('error');
    expect(tested.body.error).toContain('[redacted]');
    const reloaded = await call('POST', `/connectors/${id}/reload`);
    expect(reloaded.body.status.error).toContain('[redacted]');
    const list = await call('GET', '/connectors');
    expect(list.body.connectors[0].status.error).toContain('[redacted]');
  });
});

describe('Dot grants', () => {
  it('replaces all grants of a Dot and round-trips them', async () => {
    const { call, dot } = setup();
    const a = (await call('POST', '/connectors', http('alpha'))).body.id;
    const b = (await call('POST', '/connectors', http('beta'))).body.id;
    const empty = await call('GET', `/dots/${dot.id}/connectors`);
    expect(empty).toEqual({ status: 200, body: { grants: [] } });
    const put = await call('PUT', `/dots/${dot.id}/connectors`, {
      grants: [
        { connectorId: a, tools: '*' },
        {
          connectorId: b,
          tools: ['get_issue', 'create_issue'],
          overrides: { create_issue: 'ask' },
        },
      ],
    });
    expect(put.status).toBe(200);
    const expected = [
      { dotId: dot.id, connectorId: a, tools: '*', overrides: {} },
      {
        dotId: dot.id,
        connectorId: b,
        tools: ['get_issue', 'create_issue'],
        overrides: { create_issue: 'ask' },
      },
    ].sort((x, y) => x.connectorId.localeCompare(y.connectorId));
    expect(put.body.grants).toEqual(expected);
    expect((await call('GET', `/dots/${dot.id}/connectors`)).body).toEqual({
      grants: expected,
    });
    // A later PUT replaces everything: unlisted connectors are revoked.
    const replaced = await call('PUT', `/dots/${dot.id}/connectors`, {
      grants: [{ connectorId: b, tools: '*' }],
    });
    expect(replaced.body.grants).toEqual([
      { dotId: dot.id, connectorId: b, tools: '*', overrides: {} },
    ]);
    const cleared = await call('PUT', `/dots/${dot.id}/connectors`, {
      grants: [],
    });
    expect(cleared.body).toEqual({ grants: [] });
  });

  it('rejects an unknown connector, a duplicate and malformed bodies', async () => {
    const { call, dot } = setup();
    const a = (await call('POST', '/connectors', http('alpha'))).body.id;
    const unknown = await call('PUT', `/dots/${dot.id}/connectors`, {
      grants: [{ connectorId: 'nope', tools: '*' }],
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/Unknown connector/);
    const dup = await call('PUT', `/dots/${dot.id}/connectors`, {
      grants: [
        { connectorId: a, tools: '*' },
        { connectorId: a, tools: [] },
      ],
    });
    expect(dup.status).toBe(400);
    for (const body of [
      { grants: [{ connectorId: a, tools: 'all' }] },
      { grants: [{ connectorId: a, tools: '*', extra: 1 }] },
      { grants: [{ connectorId: a, tools: '*', overrides: { x: 'maybe' } }] },
      { grants: [], extra: true },
      { grants: 'x' },
      'not json',
    ]) {
      const bad = await call('PUT', `/dots/${dot.id}/connectors`, body);
      expect(bad.status).toBe(400);
      expect(typeof bad.body.error).toBe('string');
    }
    const tooMany = await call('PUT', `/dots/${dot.id}/connectors`, {
      grants: Array.from({ length: 101 }, () => ({
        connectorId: a,
        tools: '*',
      })),
    });
    expect(tooMany.status).toBe(400);
    const tooManyTools = await call('PUT', `/dots/${dot.id}/connectors`, {
      grants: [
        {
          connectorId: a,
          tools: Array.from({ length: 501 }, (_, index) => `t${index}`),
        },
      ],
    });
    expect(tooManyTools.status).toBe(400);
    expect(
      (await call('GET', `/dots/${dot.id}/connectors`)).body.grants,
    ).toEqual([]);
  });

  it('accepts any tool name until the tool list is cached, then checks names and override keys', async () => {
    const { call, dot } = setup();
    const id = (await call('POST', '/connectors', http('alpha'))).body.id;
    const url = `/dots/${dot.id}/connectors`;
    const early = await call('PUT', url, {
      grants: [{ connectorId: id, tools: ['whatever'] }],
    });
    expect(early.status).toBe(200);
    expect((await call('POST', `/connectors/${id}/test`)).body.state).toBe(
      'connected',
    );
    const unknownTool = await call('PUT', url, {
      grants: [{ connectorId: id, tools: ['get_issue', 'nope'] }],
    });
    expect(unknownTool.status).toBe(400);
    expect(unknownTool.body.error).toMatch(/no tool named nope/);
    const unknownOverride = await call('PUT', url, {
      grants: [{ connectorId: id, tools: '*', overrides: { missing: 'deny' } }],
    });
    expect(unknownOverride.status).toBe(400);
    // The failed PUTs changed nothing.
    expect((await call('GET', url)).body.grants[0].tools).toEqual(['whatever']);
    // A name the Dot already holds can still be saved again.
    const kept = await call('PUT', url, {
      grants: [{ connectorId: id, tools: ['whatever'] }],
    });
    expect(kept.status).toBe(200);
    const valid = await call('PUT', url, {
      grants: [
        {
          connectorId: id,
          tools: ['get_issue', 'delete_repo'],
          overrides: { delete_repo: 'deny' },
        },
      ],
    });
    expect(valid.status).toBe(200);
    expect(valid.body.grants[0].overrides).toEqual({ delete_repo: 'deny' });
  });

  it('404s for an unknown Dot', async () => {
    const { call } = setup();
    const id = (await call('POST', '/connectors', http('alpha'))).body.id;
    const get = await call('GET', '/dots/missing/connectors');
    expect(get.status).toBe(404);
    const put = await call('PUT', '/dots/missing/connectors', {
      grants: [{ connectorId: id, tools: '*' }],
    });
    expect(put.status).toBe(404);
    expect(put.body.error).toBe('Dot not found.');
  });

  it('deleting a connector drops its grants', async () => {
    const { call, dot } = setup();
    const id = (await call('POST', '/connectors', http('alpha'))).body.id;
    await call('PUT', `/dots/${dot.id}/connectors`, {
      grants: [{ connectorId: id, tools: '*' }],
    });
    await call('DELETE', `/connectors/${id}`);
    expect((await call('GET', `/dots/${dot.id}/connectors`)).body).toEqual({
      grants: [],
    });
  });
});
