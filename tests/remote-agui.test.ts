import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { Hono } from 'hono';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import {
  agentEndpointAllowedHosts,
  checkAgentEndpoint,
  createAgentFetch,
} from '../src/server/agent-endpoint.js';
import { DotAgent } from '../src/server/dot-agent.js';
import { Platform } from '../src/server/platform.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { TurnRegistry } from '../src/server/turn-registry.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { Dot } from '../src/shared/types.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

const headerValue = () => ['Token', randomUUID(), randomUUID()].join(' ');

describe('agent endpoint checks', () => {
  it('refuses http, credentials, localhost and private addresses', () => {
    const none = new Set<string>();
    expect(checkAgentEndpoint('http://agent.example/ag-ui', none).allowed).toBe(
      false,
    );
    expect(
      checkAgentEndpoint('https://user:secret@agent.example/ag-ui', none)
        .allowed,
    ).toBe(false);
    expect(checkAgentEndpoint('https://localhost/ag-ui', none).allowed).toBe(
      false,
    );
    expect(checkAgentEndpoint('https://10.1.2.3/ag-ui', none).allowed).toBe(
      false,
    );
    expect(
      checkAgentEndpoint('https://169.254.169.254/latest', none).allowed,
    ).toBe(false);
    expect(
      checkAgentEndpoint('https://agent.example/ag-ui', none),
    ).toMatchObject({ allowed: true });
  });

  it('accepts an allow-listed host and still refuses a metadata address', () => {
    const allowed = agentEndpointAllowedHosts({
      AGENT_ENDPOINT_ALLOWED_HOSTS: ' Agents.Internal , 10.0.0.42:9000 ',
    });
    expect(
      checkAgentEndpoint('http://agents.internal:4200/ag-ui', allowed).allowed,
    ).toBe(true);
    expect(
      checkAgentEndpoint('https://10.0.0.42:9000/ag-ui', allowed).allowed,
    ).toBe(true);
    expect(
      checkAgentEndpoint('https://10.0.0.42:9001/ag-ui', allowed).allowed,
    ).toBe(false);
    const listedMetadata = agentEndpointAllowedHosts({
      AGENT_ENDPOINT_ALLOWED_HOSTS: '169.254.169.254',
    });
    expect(
      checkAgentEndpoint('https://169.254.169.254/latest', listedMetadata)
        .allowed,
    ).toBe(false);
  });

  it('refuses a wildcard or a URL in the allow list', () => {
    expect(() =>
      agentEndpointAllowedHosts({
        AGENT_ENDPOINT_ALLOWED_HOSTS: '*.internal',
      }),
    ).toThrow(/not a URL/);
    expect(() =>
      agentEndpointAllowedHosts({
        AGENT_ENDPOINT_ALLOWED_HOSTS: 'http://agents.internal/ag-ui',
      }),
    ).toThrow(/not a URL/);
  });

  it('refuses a redirect to a private address and does not dial it', async () => {
    const dialled: string[] = [];
    const fetchImpl = async (url: string) => {
      dialled.push(url);
      return new Response(null, {
        status: 302,
        headers: { location: 'http://10.9.8.7/latest' },
      });
    };
    const agentFetch = createAgentFetch({
      allowedHosts: new Set(['127.0.0.1']),
      fetchImpl,
    });
    await expect(
      agentFetch('http://127.0.0.1:9/ag-ui', { method: 'POST' }),
    ).rejects.toThrow(/10\.9\.8\.7/);
    expect(dialled).toEqual(['http://127.0.0.1:9/ag-ui']);
  });
});

function boot(allowed: ReadonlySet<string> = new Set()) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const config: PlatformConfig = {
    baseUrl: 'https://unused.invalid/v1',
    voiceName: 'marin',
    agentEndpointAllowedHosts: allowed,
  };
  const platform = new Platform(store, workspace, config);
  cleanups.push(async () => {
    await platform.stop();
    store.close();
    workspace.close();
  });
  const app = createApp({
    store,
    runner: new Runner(store, { mode: 'sample', baseUrl: '' }),
    config: { mode: 'sample', baseUrl: '' },
    platform,
  });
  return { app, workspace, store, config, dot: workspace.dots()[0]! };
}

const send = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('saving an agent endpoint', () => {
  it('stores the header encrypted and leaves it out of the response', async () => {
    const { app, workspace, dot } = boot(new Set(['127.0.0.1']));
    const header = headerValue();
    const dir = mkdtempSync(join(tmpdir(), 'agent-endpoint-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = new WorkspaceStore(join(dir, 'dots.sqlite'), 'owner');
    const space = file.spaces()[0]!;
    const created = file.createDot(
      space.id,
      'Remote',
      'Answers from outside.',
      true,
      true,
    );
    file.setAgentEndpoint(created.id, 'https://agent.example/ag-ui', header);
    expect(JSON.stringify(file.dot(created.id))).not.toContain(header);
    expect(file.openAgentAuth(created.id)).toBe(header);
    file.close();
    const db = new DatabaseSync(join(dir, 'dots.sqlite'));
    const row = db
      .prepare('SELECT agentAuth FROM dots WHERE id=?')
      .get(created.id) as { agentAuth: string };
    expect(row.agentAuth.startsWith('v1.')).toBe(true);
    expect(row.agentAuth).not.toContain(header);
    db.close();

    const logs: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation((...args) => {
      logs.push(args.map(String).join(' '));
    });
    const log = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.map(String).join(' '));
    });
    const saved = await app.request(
      '/api/dots',
      send('POST', {
        name: 'Scout',
        instructions: 'Finds things.',
        researchAllowed: true,
        memoryAllowed: true,
        spaceId: dot.spaceId,
        agentEndpoint: 'http://127.0.0.1:9/ag-ui',
        agentAuth: header,
      }),
    );
    expect(saved.status).toBe(201);
    const body = await saved.text();
    expect(body).not.toContain(header);
    expect(body).toContain('"agentAuthSet":true');
    const scout = JSON.parse(body) as Dot;
    expect(workspace.openAgentAuth(scout.id)).toBe(header);
    expect(JSON.stringify(workspace.dots())).not.toContain(header);
    expect(logs.join('\n')).not.toContain(header);
    error.mockRestore();
    log.mockRestore();
  });

  it('refuses a private https address and an http address that is not listed', async () => {
    const { app, dot } = boot();
    const base = {
      name: 'Scout',
      instructions: 'Finds things.',
      researchAllowed: true,
      memoryAllowed: true,
      spaceId: dot.spaceId,
    };
    const privateAddress = await app.request(
      '/api/dots',
      send('POST', { ...base, agentEndpoint: 'https://10.2.3.4/ag-ui' }),
    );
    expect(privateAddress.status).toBe(400);
    const httpAddress = await app.request(
      '/api/dots',
      send('POST', { ...base, agentEndpoint: 'http://agent.example/ag-ui' }),
    );
    expect(httpAddress.status).toBe(400);
    expect(await httpAddress.text()).not.toContain('agent.example/ag-ui?');
  });
});

function eventsOf(text: string) {
  return [
    { type: EventType.RUN_STARTED, threadId: 'thread', runId: 'run' },
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: 'm',
      role: 'assistant',
    },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm', delta: text },
    { type: EventType.TEXT_MESSAGE_END, messageId: 'm' },
    { type: EventType.RUN_FINISHED, threadId: 'thread', runId: 'run' },
  ];
}

function sse(events: object[]) {
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('a remote turn', () => {
  it('answers from an in-process AG-UI server and keeps the header out of events', async () => {
    const header = headerValue();
    const seen: string[] = [];
    let sentTools: unknown;
    const remote = new Hono();
    remote.post('/ag-ui', async (c) => {
      seen.push(c.req.header('authorization') ?? '');
      sentTools = ((await c.req.json()) as { tools?: unknown }).tools;
      return sse(eventsOf('Hello from the agent.'));
    });
    const { workspace, store, config, dot } = boot(new Set(['127.0.0.1']));
    const endpoint = checkAgentEndpoint(
      'http://127.0.0.1:9/ag-ui',
      new Set(['127.0.0.1']),
    );
    if (!endpoint.allowed) throw new Error(endpoint.reason);
    workspace.setAgentEndpoint(dot.id, endpoint.url, header);
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.map(String).join(' '));
    });
    const agent = new DotAgent(
      store,
      workspace,
      {
        ...config,
        agentFetch: async (url, init) => remote.fetch(new Request(url, init)),
      },
      dot.id,
    );
    workspace.bindThread('thread', dot.id, 'Remote');
    const input: RunAgentInput = {
      threadId: 'thread',
      runId: 'run',
      state: {},
      messages: [{ id: 'u', role: 'user', content: 'Hello' }],
      tools: [
        { name: 'delegate_to_dot', description: 'hand off', parameters: {} },
      ],
      context: [],
      forwardedProps: {},
    };
    const events = await lastValueFrom(agent.run(input).pipe(toArray()));
    const rendered = JSON.stringify(events);
    expect(rendered).toContain('Hello from the agent.');
    expect(rendered).not.toContain(header);
    expect(rendered).not.toContain('delegate_to_dot');
    expect(sentTools).toEqual([]);
    expect(seen).toEqual([header]);
    expect(logs.join('\n')).not.toContain(header);
    expect(JSON.stringify(workspace.dots())).not.toContain(header);
  });

  it('stops the request when the Dot is paused', async () => {
    let aborted = false;
    let seen = false;
    const remote = new Hono();
    remote.post('/ag-ui', (c) => {
      seen = true;
      return new Promise<Response>((resolve) => {
        const timer = setTimeout(() => {
          resolve(sse(eventsOf('too late')));
        }, 20_000);
        c.req.raw.signal.addEventListener('abort', () => {
          aborted = true;
          clearTimeout(timer);
          resolve(new Response(null, { status: 499 }));
        });
      });
    });
    const turns = new TurnRegistry();
    const { workspace, store, config, dot } = boot(new Set(['127.0.0.1']));
    workspace.setAgentEndpoint(dot.id, 'http://127.0.0.1:9/ag-ui', null);
    workspace.bindThread('thread', dot.id, 'Remote');
    const agent = new DotAgent(
      store,
      workspace,
      {
        ...config,
        agentFetch: async (url, init) => remote.fetch(new Request(url, init)),
      },
      dot.id,
      { turns },
    );
    const input: RunAgentInput = {
      threadId: 'thread',
      runId: 'run',
      state: {},
      messages: [{ id: 'u', role: 'user', content: 'Hello' }],
      tools: [],
      context: [],
      forwardedProps: {},
    };
    const done = new Promise<string>((resolve) => {
      const chunks: string[] = [];
      agent.run(input).subscribe({
        next: (event) => chunks.push(JSON.stringify(event)),
        error: () => resolve(chunks.join('\n')),
        complete: () => resolve(chunks.join('\n')),
      });
    });
    await vi.waitFor(() => expect(seen).toBe(true));
    workspace.setDotPaused(dot.id, true);
    expect(turns.stop(dot.id)).toBe(true);
    const text = await done;
    expect(aborted).toBe(true);
    expect(text).not.toContain('too late');
  });
});
