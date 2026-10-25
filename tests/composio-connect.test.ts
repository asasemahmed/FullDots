import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getToolkit: vi.fn(),
  listConfigs: vi.fn(),
  createConfig: vi.fn(),
  initiate: vi.fn(),
  listAccounts: vi.fn(),
  deleteAccount: vi.fn(),
}));

vi.mock('@composio/core', () => ({
  Composio: class {
    constructor(_options: unknown) {}
    toolkits = { get: mocks.getToolkit };
    authConfigs = { list: mocks.listConfigs, create: mocks.createConfig };
    connectedAccounts = {
      initiate: mocks.initiate,
      list: mocks.listAccounts,
      delete: mocks.deleteAccount,
    };
    tools = { getRawComposioToolBySlug: vi.fn() };
  },
}));

import { createApp } from '../src/server/app.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const keyToolkit = {
  composioManagedAuthSchemes: [],
  authConfigDetails: [
    {
      mode: 'API_KEY',
      fields: {
        connectedAccountInitiation: {
          required: [
            {
              name: 'api_key',
              type: 'string',
              displayName: 'API key',
              description: 'From the vendor.',
              required: true,
              isSecret: true,
            },
          ],
          optional: [],
        },
      },
    },
  ],
};

function boot() {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const platform = new Platform(store, workspace, {
    baseUrl: 'https://unused.invalid/v1',
    voiceName: 'marin',
    composioApiKey: 'test-key',
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
  return { app, store, workspace };
}

const send = (method: string, body?: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function enable(app: ReturnType<typeof boot>['app']) {
  const response = await app.request(
    '/api/settings',
    send('PATCH', { composioAllowed: true }),
  );
  expect(response.status).toBe(200);
}

describe('Composio key connect', () => {
  it('sends the typed value to Composio and nowhere else', async () => {
    const secret = `fd-test-${randomUUID()}`;
    const { app, store, workspace } = boot();
    await enable(app);
    mocks.getToolkit.mockResolvedValue(keyToolkit);
    mocks.listConfigs.mockResolvedValue({ items: [] });
    mocks.createConfig.mockResolvedValue({ id: 'cfg_1' });
    mocks.initiate.mockResolvedValue({ id: 'acc_1', status: 'ACTIVE' });
    const logs: unknown[][] = [];
    const error = console.error;
    const log = console.log;
    console.error = (...args: unknown[]) => {
      logs.push(args);
    };
    console.log = (...args: unknown[]) => {
      logs.push(args);
    };
    try {
      const response = await app.request(
        '/api/composio/connect',
        send('POST', { toolkit: 'perplexityai', values: { api_key: secret } }),
      );
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body).toEqual({ connected: true });
      expect(mocks.initiate).toHaveBeenCalledWith(
        'owner',
        'cfg_1',
        expect.objectContaining({
          config: {
            authScheme: 'API_KEY',
            val: { api_key: secret, status: 'ACTIVE' },
          },
        }),
      );
      expect(mocks.createConfig).toHaveBeenCalledWith(
        'perplexityai',
        expect.objectContaining({
          type: 'use_custom_auth',
          authScheme: 'API_KEY',
          credentials: {},
        }),
      );
      const audit = workspace.computers.auditEntries('owner');
      expect(audit).toMatchObject([
        { tool: 'composio_connect', outcome: 'succeeded' },
      ]);
      const kept = JSON.stringify({
        body,
        logs,
        audit,
        settings: store.settings(),
        dots: workspace.dots(),
      });
      expect(kept).not.toContain(secret);
    } finally {
      console.error = error;
      console.log = log;
    }
  });

  it('returns a sanitised refusal and does not echo the value', async () => {
    const secret = `fd-test-${randomUUID()}`;
    const { app, workspace } = boot();
    await enable(app);
    mocks.getToolkit.mockResolvedValue(keyToolkit);
    mocks.listConfigs.mockResolvedValue({
      items: [
        {
          id: 'cfg_ready',
          status: 'ENABLED',
          authScheme: 'API_KEY',
          isComposioManaged: false,
        },
      ],
    });
    mocks.initiate.mockRejectedValue(
      Object.assign(new Error(`rejected ${secret}`), { status: 401 }),
    );
    const logs: unknown[][] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args);
    };
    try {
      const response = await app.request(
        '/api/composio/connect',
        send('POST', { toolkit: 'perplexityai', values: { api_key: secret } }),
      );
      const text = await response.text();
      expect(response.status).toBe(400);
      expect(text).toContain('Error (HTTP 401)');
      expect(text).not.toContain(secret);
      expect(JSON.stringify(logs)).not.toContain(secret);
      expect(mocks.createConfig).not.toHaveBeenCalled();
      expect(workspace.computers.auditEntries('owner')).toMatchObject([
        { tool: 'composio_connect', outcome: 'failed' },
      ]);
    } finally {
      console.error = error;
    }
  });

  it('does not create an account for a consent-screen app or while the switch is off', async () => {
    const { app } = boot();
    const off = await app.request(
      '/api/composio/connect',
      send('POST', { toolkit: 'gmail', values: { api_key: 'unused' } }),
    );
    expect(off.status).toBe(404);
    expect(mocks.initiate).not.toHaveBeenCalled();

    await enable(app);
    mocks.getToolkit.mockResolvedValue({
      composioManagedAuthSchemes: ['OAUTH2'],
      authConfigDetails: [{ mode: 'OAUTH2' }],
    });
    const consent = await app.request(
      '/api/composio/connect',
      send('POST', { toolkit: 'gmail', values: { api_key: 'unused' } }),
    );
    expect(consent.status).toBe(400);
    expect(await consent.json()).toEqual({
      error: 'This app does not connect with a key.',
    });
    expect(mocks.initiate).not.toHaveBeenCalled();
    expect(mocks.createConfig).not.toHaveBeenCalled();
  });

  it('lists the slug and status, and disconnects by id', async () => {
    const secret = `fd-test-${randomUUID()}`;
    const { app } = boot();
    await enable(app);
    mocks.listAccounts.mockResolvedValue({
      items: [
        {
          id: 'acc_1',
          status: 'ACTIVE',
          toolkit: { slug: 'perplexityai' },
          params: { api_key: secret },
          data: { api_key: secret },
          state: { val: { api_key: secret } },
        },
      ],
    });
    const listed = await app.request('/api/composio/accounts');
    const text = await listed.text();
    expect(listed.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      accounts: [{ id: 'acc_1', toolkit: 'perplexityai', status: 'ACTIVE' }],
    });
    expect(text).not.toContain(secret);

    mocks.deleteAccount.mockResolvedValue({
      id: 'acc_1',
      params: { api_key: secret },
    });
    const removed = await app.request('/api/composio/accounts/acc_1', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(await removed.json()).toEqual({ removed: true });
    expect(mocks.deleteAccount).toHaveBeenCalledWith('acc_1');
  });
});
