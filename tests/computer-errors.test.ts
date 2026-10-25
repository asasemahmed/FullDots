import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { computerRoutes } from '../src/server/computer-routes.js';
import { ComputerService } from '../src/server/computer-service.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ComputerError } from '../src/server/computer-errors.js';
import { ComputerConflictError } from '../src/server/computer-conflict.js';
import type { PlatformConfig } from '../src/server/platform-config.js';

const stores: WorkspaceStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

function createTestApp(options?: {
  config?: Partial<PlatformConfig>;
  transport?: typeof fetch;
  onRelease?: (dotId: string) => void;
}) {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  stores.push(workspace);
  const dot = workspace.dots()[0];
  const config: PlatformConfig = {
    baseUrl: 'https://example.com',
    voiceName: 'voice',
    computerSupervisorUrl: 'http://127.0.0.1:4312',
    computerSupervisorToken: 'supervisor-secret',
    computerToken: 'master-secret',
    ...options?.config,
  };
  const computers = new ComputerService(
    workspace,
    config,
    () => false,
    options?.transport ?? (async () => Response.json({})),
    1000,
  );
  const app = new Hono().route(
    '/api',
    computerRoutes(computers, { onRelease: options?.onRelease }),
  );

  const request = async (
    path: string,
    init?: {
      method?: string;
      body?: unknown;
      rawBody?: string;
      headers?: Record<string, string>;
    },
  ) => {
    const headers: Record<string, string> = {
      ...(init?.headers ?? {}),
    };
    let body: string | undefined;
    if (init?.rawBody !== undefined) {
      body = init.rawBody;
      headers['Content-Type'] ??= 'application/json';
    } else if (init?.body !== undefined) {
      body = JSON.stringify(init.body);
      headers['Content-Type'] ??= 'application/json';
    }
    const response = await app.request(`/api${path}`, {
      method: init?.method ?? (body ? 'POST' : 'GET'),
      headers,
      body,
    });
    return {
      status: response.status,
      body: (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null,
    };
  };

  return { workspace, dot, computers, app, request, config };
}

describe('computer errors', () => {
  it('instantiates ComputerError with status and message', () => {
    const err = new ComputerError(404, 'Dot not found.');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ComputerError');
    expect(err.status).toBe(404);
    expect(err.message).toBe('Dot not found.');
  });

  it('preserves error cause in ComputerError', () => {
    const cause = new Error('network down');
    const err = new ComputerError(502, 'Computer service is unavailable.', {
      cause,
    });
    expect(err.cause).toBe(cause);
  });
});

describe('computer routes error handling', () => {
  it('returns 400 for zod validation errors on action requests', async () => {
    const { dot, request } = createTestApp();
    const res = await request(`/dots/${dot.id}/computer/actions`, {
      body: { notAnAction: true },
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid computer request.' });
  });

  it('returns 400 for JSON parse errors', async () => {
    const { dot, request } = createTestApp();
    const res = await request(`/dots/${dot.id}/computer/actions`, {
      rawBody: '{ malformed json',
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid JSON request.' });
  });

  it('returns 400 for unknown computer actions', async () => {
    const { dot, request } = createTestApp();
    const res = await request(`/dots/${dot.id}/computer/actions`, {
      body: { action: 'nonexistent_action', input: {} },
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Unknown computer action.' });
  });

  it('returns 403 when computer permissions are disabled', async () => {
    const { dot, request } = createTestApp();
    // Default permissions have browser, files, shell disabled and enabled=false
    const res = await request(`/dots/${dot.id}/computer/actions`, {
      body: { action: 'read', input: {} },
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Computer permission is disabled.' });
  });

  it('returns 403 when requesting a stream ticket with browser permission disabled', async () => {
    const { dot, request } = createTestApp();
    const res = await request(`/dots/${dot.id}/computer/stream`, {
      method: 'POST',
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Computer permission is disabled.' });
  });

  it('returns 404 when the Dot does not exist', async () => {
    const { request } = createTestApp();
    const res = await request('/dots/nonexistent-dot-id/computer');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Dot not found.' });
  });

  it('returns 409 when taking control of a stopped computer', async () => {
    const { workspace, dot, request } = createTestApp({
      transport: async (input) => {
        const url = String(input);
        if (url.endsWith('/computers')) {
          return Response.json({
            computers: [
              {
                botId: dot.id,
                container: `opendots-computer-${dot.id}`,
                status: 'stopped',
              },
            ],
          });
        }
        return Response.json({});
      },
    });
    workspace.computers.patch(dot.id, { enabled: true, browser: true });
    const res = await request(`/dots/${dot.id}/computer/take`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Start this Dot’s computer first.' });
  });

  it('returns 409 when releasing control without an active control request', async () => {
    const { workspace, dot, request } = createTestApp({
      transport: async (input) => {
        const url = String(input);
        if (url.endsWith('/computers')) {
          return Response.json({
            computers: [
              {
                botId: dot.id,
                container: `opendots-computer-${dot.id}`,
                status: 'running',
                url: `http://opendots-computer-${dot.id}:4100`,
              },
            ],
          });
        }
        if (url.endsWith('/control')) {
          return Response.json({
            holder: 'human',
            requested: false,
            transitioning: false,
            resumeSnapshotRequired: false,
          });
        }
        return Response.json({});
      },
    });
    workspace.computers.patch(dot.id, { enabled: true, browser: true });
    const res = await request(`/dots/${dot.id}/computer/release`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'There is no active control request.' });
  });

  it('returns 409 for ComputerConflictError', async () => {
    const { workspace, dot, request } = createTestApp({
      transport: async (input) => {
        const url = String(input);
        if (url.endsWith('/computers')) {
          return Response.json({
            computers: [
              {
                botId: dot.id,
                container: `opendots-computer-${dot.id}`,
                status: 'running',
                url: `http://opendots-computer-${dot.id}:4100`,
              },
            ],
          });
        }
        if (url.endsWith('/read')) {
          return Response.json({ humanHasControl: true }, { status: 409 });
        }
        return Response.json({});
      },
    });
    workspace.computers.patch(dot.id, { enabled: true, browser: true });
    const res = await request(`/dots/${dot.id}/computer/actions`, {
      body: { action: 'read', input: {} },
    });
    expect(res.status).toBe(409);
    expect(res.body?.error).toContain('owner currently has control');
  });

  it('maps direct ComputerConflictError to status 409', async () => {
    const { dot, computers, app } = createTestApp();
    vi.spyOn(computers, 'action').mockRejectedValue(
      new ComputerConflictError('stale_ref'),
    );
    const res = await app.request(`/api/dots/${dot.id}/computer/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'read', input: {} }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('out of date');
  });

  it('returns 502 when supervisor reports an invalid endpoint', async () => {
    const { workspace, dot, request } = createTestApp({
      transport: async (input) => {
        const url = String(input);
        if (url.endsWith('/computers')) {
          return Response.json({
            computers: [
              {
                botId: dot.id,
                container: `opendots-computer-${dot.id}`,
                status: 'running',
                url: 'http://malicious-host.com:4100',
              },
            ],
          });
        }
        return Response.json({});
      },
    });
    workspace.computers.patch(dot.id, { enabled: true, browser: true });
    const res = await request(`/dots/${dot.id}/computer/take`, {
      method: 'POST',
    });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: 'Computer endpoint is not bound to this Dot.',
    });
  });

  it('returns 502 when supervisor is unreachable or returns an empty response', async () => {
    const { workspace, dot, request } = createTestApp({
      transport: async (input) => {
        const url = String(input);
        if (url.endsWith('/ensure')) {
          return new Response(null);
        }
        return Response.json({});
      },
    });
    workspace.computers.patch(dot.id, { enabled: true });
    const res = await request(`/dots/${dot.id}/computer/start`, {
      method: 'POST',
    });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: 'Computer service returned an empty response.',
    });
  });

  it('returns 503 when computer service is not configured', async () => {
    const { dot, request } = createTestApp({
      config: {
        computerSupervisorUrl: '',
        computerSupervisorToken: '',
        computerToken: '',
      },
    });
    const res = await request(`/dots/${dot.id}/computer/stop`, {
      method: 'POST',
    });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Computer service is not configured.' });
  });

  it('returns 503 without leaking raw messages on unknown errors, logging only error name', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const { dot, computers, app } = createTestApp();
    const secretMessage =
      'Secret token: abc-123-super-secret-key at internal-db:5432';

    // Mock computers.start to throw an unexpected plain Error with sensitive message
    vi.spyOn(computers, 'start').mockRejectedValue(new Error(secretMessage));

    const response = await app.request(`/api/dots/${dot.id}/computer/start`, {
      method: 'POST',
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(body).toEqual({ error: 'The computer service failed.' });
    expect(body.error).not.toContain('secret');
    expect(body.error).not.toContain('token');

    // Verify console.error was called with the error name only, never the secret message
    expect(consoleError).toHaveBeenCalledWith('Error');
    const allLogged = consoleError.mock.calls.flat().join(' ');
    expect(allLogged).not.toContain(secretMessage);
    expect(allLogged).not.toContain('abc-123');
  });

  it('calls onRelease callback when releasing control', async () => {
    const onRelease = vi.fn();
    const { workspace, dot, request } = createTestApp({
      onRelease,
      transport: async (input) => {
        const url = String(input);
        if (url.endsWith('/computers')) {
          return Response.json({
            computers: [
              {
                botId: dot.id,
                container: `opendots-computer-${dot.id}`,
                status: 'running',
                url: `http://opendots-computer-${dot.id}:4100`,
              },
            ],
          });
        }
        if (url.endsWith('/control')) {
          return Response.json({
            holder: 'human',
            requested: false,
            transitioning: false,
            resumeSnapshotRequired: false,
            request: { id: 'req-1', status: 'taken' },
          });
        }
        if (url.endsWith('/control/release')) {
          return Response.json({
            holder: 'bot',
            requested: false,
            transitioning: false,
            resumeSnapshotRequired: false,
          });
        }
        return Response.json({});
      },
    });
    workspace.computers.patch(dot.id, { enabled: true, browser: true });
    const res = await request(`/dots/${dot.id}/computer/release`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(onRelease).toHaveBeenCalledWith(dot.id);
  });
});
