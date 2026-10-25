import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectorRoutes } from '../src/server/connector-routes.js';
import { ConnectorStore } from '../src/server/connector-store.js';
import { ConnectorRegistry } from '../src/server/connectors.js';
import { clearRegistryCache } from '../src/server/registry-client.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const cleanups: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  clearRegistryCache();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// No connector is configured here, so the registry never opens a transport.
function setup(options: { registrySearch?: boolean } = {}) {
  const db = new DatabaseSync(':memory:');
  const store = new ConnectorStore(db);
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const registry = new ConnectorRegistry(store, {
    allowStdio: false,
    resultMaxChars: 20_000,
    env: {},
    transport: () => {
      throw new Error('No transport in this test.');
    },
  });
  cleanups.push(async () => {
    await registry.stop();
    workspace.close();
    db.close();
  });
  const app = new Hono().route(
    '/api',
    connectorRoutes({
      store,
      registry,
      workspace,
      connectorAuth: workspace.connectorAuth,
      allowStdio: false,
      ...options,
    }),
  );
  const search = async (query: string) => {
    const response = await app.request(
      `/api/connectors/registry/search${query}`,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: response.status, body: (await response.json()) as any };
  };
  return { app, search };
}

const serverEntry = {
  server: {
    name: 'io.github.example/notes',
    title: 'Notes',
    description: 'Read and write notes',
    version: '0.4.1',
    repository: { url: 'https://github.com/example/notes', source: 'github' },
    remotes: [{ type: 'sse', url: 'https://notes.example/sse' }],
    websiteUrl: 'https://notes.example',
  },
  _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
};

const answer = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('GET /api/connectors/registry/search', () => {
  it('answers 403 and contacts nobody while the setting is off', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const { search } = setup();
    const { status, body } = await search('?q=notes');
    expect(status).toBe(403);
    expect(body.error).toContain('CONNECTORS_REGISTRY_SEARCH=true');
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports the setting on the connectors list', async () => {
    const off = setup();
    expect((await off.app.request('/api/connectors')).status).toBe(200);
    const offBody = await (await off.app.request('/api/connectors')).json();
    expect(offBody.registrySearch).toBe(false);

    const on = setup({ registrySearch: true });
    const onBody = await (await on.app.request('/api/connectors')).json();
    expect(onBody.registrySearch).toBe(true);
  });

  it('answers 400 for an empty, blank, missing or too long search', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => answer({ servers: [] }));
    const { search } = setup({ registrySearch: true });
    for (const query of ['?q=', '?q=%20%20%20', '', `?q=${'a'.repeat(101)}`]) {
      const { status, body } = await search(query);
      expect(status).toBe(400);
      expect(body.error).toBe('Enter a search of 1 to 100 characters.');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('accepts a 100 character search', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      answer({ servers: [] }),
    );
    const { search } = setup({ registrySearch: true });
    const { status } = await search(`?q=${'a'.repeat(100)}`);
    expect(status).toBe(200);
  });

  it('answers 200 with the normalised servers and the next cursor', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      answer({
        servers: [serverEntry],
        metadata: { nextCursor: 'io.github.example/notes:0.4.1' },
      }),
    );
    const { search } = setup({ registrySearch: true });
    const { status, body } = await search('?q=notes');
    expect(status).toBe(200);
    expect(body).toEqual({
      servers: [
        {
          name: 'io.github.example/notes',
          title: 'Notes',
          description: 'Read and write notes',
          version: '0.4.1',
          repository: { url: 'https://github.com/example/notes' },
          remotes: [{ type: 'sse', url: 'https://notes.example/sse' }],
          packages: [],
        },
      ],
      nextCursor: 'io.github.example/notes:0.4.1',
    });
    expect(body.servers[0]).not.toHaveProperty('websiteUrl');
    const url = new URL(String(spy.mock.calls[0]?.[0]));
    expect(url.searchParams.get('search')).toBe('notes');
  });

  it('passes a cursor on to the registry', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => answer({ servers: [] }));
    const { search } = setup({ registrySearch: true });
    await search('?q=notes&cursor=page-2');
    const url = new URL(String(spy.mock.calls[0]?.[0]));
    expect(url.searchParams.get('cursor')).toBe('page-2');
  });

  it('answers 502 with a short message when the registry cannot be reached', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed'),
    );
    const { search } = setup({ registrySearch: true });
    const { status, body } = await search('?q=offline');
    expect(status).toBe(502);
    expect(body.error).toBe('The MCP registry could not be reached.');
  });

  it('answers 502 when the registry does not answer in time', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new DOMException('timed out', 'TimeoutError'),
    );
    const { search } = setup({ registrySearch: true });
    const { status, body } = await search('?q=slow');
    expect(status).toBe(502);
    expect(body.error).toBe('The MCP registry did not answer in time.');
  });

  it('answers 502 for an answer FullDots cannot read', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      answer({ unexpected: true }),
    );
    const { search } = setup({ registrySearch: true });
    const { status } = await search('?q=odd');
    expect(status).toBe(502);
  });
});
