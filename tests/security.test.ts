import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPublicAddress, validateUrl } from '../src/browser/security.js';
import { createApp } from '../src/server/app.js';
import { ConnectorRegistry } from '../src/server/connectors.js';
import { DotAgent } from '../src/server/dot-agent.js';
import { runThreadTurn } from '../src/server/headless.js';
import { Platform } from '../src/server/platform.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { completion } from './fixtures/model-stream.js';
import { FakeComputer, fakeTransport } from './fixtures/fake-computer.js';
import { createMcpFixture } from './fixtures/mcp-server.js';
describe('browser network boundaries', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.0.1',
    '169.254.169.254',
    '0.0.0.0',
    '::1',
    '2001::1',
    '2001:100::1',
    '2002:7f00:1::',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '224.0.0.1',
  ])('rejects private or special address %s', (address) =>
    expect(isPublicAddress(address)).toBe(false),
  );
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])(
    'accepts public address %s',
    (address) => expect(isPublicAddress(address)).toBe(true),
  );
  it('rejects non-http URLs and embedded credentials', async () => {
    await expect(validateUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(
      validateUrl('https://user:pass@example.com'),
    ).rejects.toThrow();
    await expect(validateUrl('http://127.0.0.1')).rejects.toThrow();
  });
});

// Secrets the server holds or resolves must never reach a response, a webhook, a model request body,
// a stored conversation, the audit trail or a log line. Each value is planted where the server keeps it.
const PLANTED = {
  model: 'model-secret-XYZ',
  supervisor: 'supervisor-secret-QQQ',
  master: 'master-secret-RRR',
  connector: 'connector-secret-ABC',
  webhook: 'webhook-secret-SSS',
};
const WEBHOOK_URL = `https://hooks.example.test/notify/${PLANTED.webhook}`;

describe('planted secrets', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  const savedEnv = process.env.T;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedEnv === undefined) delete process.env.T;
    else process.env.T = savedEnv;
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it('never appear in a response, a webhook, a model request, the stored thread, the audit trail or a log', async () => {
    process.env.T = PLANTED.connector;
    const logs = (['error', 'log', 'warn', 'info', 'debug'] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => {}),
    );

    const store = new Store(':memory:');
    const workspace = new WorkspaceStore(':memory:', 'owner');
    const dot = workspace.dots()[0];
    const fake = new FakeComputer();
    workspace.computers.patch(dot.id, {
      enabled: true,
      browser: true,
      files: true,
      shell: true,
    });
    const webhooks: string[] = [];
    const modelRequests: Array<{ body: string; authorization: string }> = [];
    const replies = [
      () =>
        completion(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'echo',
                type: 'function',
                function: { name: 'mcp__github__echo_secret', arguments: '{}' },
              },
            ],
          },
          'tool_calls',
        ),
      () =>
        completion({ role: 'assistant', content: 'The connector answered.' }),
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === WEBHOOK_URL) {
        webhooks.push(String(init?.body));
        return new Response('ok');
      }
      if (url.startsWith('https://unused.invalid')) {
        modelRequests.push({
          body: String(init?.body),
          authorization: new Headers(init?.headers).get('authorization') ?? '',
        });
        const reply = replies.shift();
        if (!reply) throw new Error('Unexpected model request.');
        return reply();
      }
      return fakeTransport(fake, dot.id)(input, init);
    });

    const config: PlatformConfig = {
      apiKey: PLANTED.model,
      model: 'custom-model',
      baseUrl: 'https://unused.invalid/v1',
      voiceName: 'marin',
      computerSupervisorUrl: 'http://127.0.0.1:4312',
      computerSupervisorToken: PLANTED.supervisor,
      computerToken: PLANTED.master,
      notifyWebhookUrl: WEBHOOK_URL,
    };
    const platform = new Platform(store, workspace, config);
    const research = { mode: 'live' as const, baseUrl: config.baseUrl };
    const app = createApp({
      store,
      runner: new Runner(store, research),
      config: research,
      platform,
    });
    const fixture = createMcpFixture({ secret: PLANTED.connector });
    // A registry that reaches the in-process MCP server, reading the same stored connector row.
    const registry = new ConnectorRegistry(workspace.connectors, {
      allowStdio: false,
      resultMaxChars: 20_000,
      transport: (connector) => fixture.transport(connector),
    });
    cleanups.push(async () => {
      await registry.stop();
      await fixture.close();
      await platform.stop();
      store.close();
      workspace.close();
    });

    // The connector keeps its token in the environment, the row only names the variable.
    const connector = workspace.connectors.create({
      name: 'github',
      transport: 'http',
      url: 'https://mcp.example.test/mcp',
      headers: { Authorization: { env: 'T' } },
    });
    workspace.connectors.setGrant(dot.id, connector.id, '*');
    expect((await registry.status(connector.id)).state).toBe('connected');
    workspace.bindThread('thread', dot.id, 'Secrets');
    workspace.bindThread('waiting', dot.id, 'Waiting');

    // A turn in which the connector hands the model its own secret back: it must arrive redacted.
    const reply = await runThreadTurn(
      platform.runner,
      new DotAgent(store, workspace, config, dot.id, {
        ...platform.services(),
        connectors: registry,
      }),
      'thread',
      'Ask the connector.',
      new AbortController().signal,
    );
    expect(reply).toBe('The connector answered.');
    expect(modelRequests).toHaveLength(2);
    expect(modelRequests[1].body).toContain('[redacted]');
    // The planted model key is really in use (as the bearer token), just not anywhere it can leak from.
    expect(modelRequests[0].authorization).toContain(PLANTED.model);

    // A pending approval and a waiting handoff, which both notify the webhook.
    const approval = platform.approvals.request({
      threadId: 'thread',
      dotId: dot.id,
      toolCallId: 'call-1',
      tool: 'computer_exec',
      argsHash: 'hash-1',
      summary: 'Scout wants to run a shell command',
      argsRedacted: '{"command":"rm -rf build"}',
    });
    const handoff = await platform.handoffs.start({
      dotId: dot.id,
      threadId: 'waiting',
      kind: 'credential',
      reason: 'Sign in to the shop.',
    });
    await vi.waitFor(() => expect(webhooks).toHaveLength(2));
    expect(webhooks.map((body) => JSON.parse(body))).toEqual([
      expect.objectContaining({ title: 'Approval needed' }),
      expect.objectContaining({ url: expect.any(String) }),
    ]);

    const observed: Record<string, string> = {};
    for (const path of [
      '/api/state',
      '/api/workspace',
      '/api/connectors',
      `/api/dots/${dot.id}/connectors`,
      '/api/approvals',
      `/api/approvals/${approval.id}`,
      '/api/handoffs',
      `/api/dots/${dot.id}/computer`,
    ]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
      observed[path] = await response.text();
    }
    // The routes really returned what the secrets belong to.
    expect(
      JSON.parse(observed['/api/connectors']).connectors[0].headers,
    ).toEqual({ Authorization: { env: 'T', set: true } });
    expect(JSON.parse(observed['/api/approvals']).approvals).toHaveLength(1);
    expect(JSON.parse(observed['/api/handoffs']).handoffs[0].id).toBe(
      handoff.id,
    );
    expect(JSON.parse(observed[`/api/dots/${dot.id}/computer`]).state).toBe(
      'running',
    );

    const everything: Record<string, string> = {
      ...observed,
      webhooks: webhooks.join('\n'),
      'model request bodies': modelRequests.map((r) => r.body).join('\n'),
      'stored thread': JSON.stringify(
        platform.runner.getThreadMessages('thread'),
      ),
      'audit trail': JSON.stringify(workspace.computers.audit(dot.id)),
      'log lines': JSON.stringify(logs.flatMap((log) => log.mock.calls)),
    };
    for (const [secret, value] of Object.entries(PLANTED))
      for (const [where, content] of Object.entries(everything))
        expect(content.includes(value), `${secret} secret in ${where}`).toBe(
          false,
        );
  });
});
