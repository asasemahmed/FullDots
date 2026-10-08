import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { DotBusyError, TurnRegistry } from '../src/server/turn-registry.js';
import { turnRoutes } from '../src/server/turn-routes.js';
import { WorkspaceStore } from '../src/server/workspace.js';

describe('TurnRegistry', () => {
  it('rejects a second turn on the same Dot', () => {
    const registry = new TurnRegistry();
    registry.acquire('dot-1', 'thread-1', 'chat', () => {});
    expect(() =>
      registry.acquire('dot-1', 'thread-2', 'task', () => {}),
    ).toThrow(DotBusyError);
    expect(() =>
      registry.acquire('dot-1', 'thread-2', 'task', () => {}),
    ).toThrow(/busy with/);
  });

  it('lets different Dots run concurrently', () => {
    const registry = new TurnRegistry();
    registry.acquire('dot-1', 'thread-1', 'chat', () => {});
    expect(() =>
      registry.acquire('dot-2', 'thread-2', 'chat', () => {}),
    ).not.toThrow();
    expect(registry.running()).toHaveLength(2);
  });

  it('releases once and frees the Dot; onRelease fires once per release', () => {
    const registry = new TurnRegistry();
    const released = vi.fn();
    registry.onRelease(released);
    const release = registry.acquire('dot-1', 'thread-1', 'chat', () => {});
    release();
    release();
    expect(released).toHaveBeenCalledTimes(1);
    expect(released).toHaveBeenCalledWith('dot-1');
    expect(registry.isDotBusy('dot-1')).toBe(false);
    const again = registry.acquire('dot-1', 'thread-3', 'chat', () => {});
    again();
    expect(released).toHaveBeenCalledTimes(2);
  });

  it('a stale release never frees a newer turn', () => {
    const registry = new TurnRegistry();
    const first = registry.acquire('dot-1', 'thread-1', 'chat', () => {});
    first();
    registry.acquire('dot-1', 'thread-2', 'chat', () => {});
    first();
    expect(registry.isDotBusy('dot-1')).toBe(true);
  });

  it('stop() calls the turn stop and returns true; false when idle', () => {
    const registry = new TurnRegistry();
    const stop = vi.fn();
    expect(registry.stop('dot-1')).toBe(false);
    registry.acquire('dot-1', 'thread-1', 'chat', stop);
    expect(registry.stop('dot-1')).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(registry.stop('dot-2')).toBe(false);
  });

  it('isThreadRunning reflects the running threads', () => {
    const registry = new TurnRegistry();
    expect(registry.isThreadRunning('thread-1')).toBe(false);
    const release = registry.acquire('dot-1', 'thread-1', 'chat', () => {});
    expect(registry.isThreadRunning('thread-1')).toBe(true);
    expect(registry.isThreadRunning('thread-2')).toBe(false);
    release();
    expect(registry.isThreadRunning('thread-1')).toBe(false);
  });

  it('exclusions lists running threads, busy Dots, pending-approval threads and waiting-handoff Dots', () => {
    const registry = new TurnRegistry({
      pendingApprovalThreads: () => ['thread-approval'],
      waitingHandoffDots: () => ['dot-handoff'],
    });
    registry.acquire('dot-1', 'thread-1', 'chat', () => {});
    const { threadIds, dotIds } = registry.exclusions();
    expect([...threadIds].sort()).toEqual(['thread-1', 'thread-approval']);
    expect([...dotIds].sort()).toEqual(['dot-1', 'dot-handoff']);
  });

  it('setLookups replaces the lookups and de-duplicates', () => {
    const registry = new TurnRegistry();
    registry.acquire('dot-1', 'thread-1', 'chat', () => {});
    expect(registry.exclusions()).toEqual({
      threadIds: ['thread-1'],
      dotIds: ['dot-1'],
    });
    registry.setLookups({
      pendingApprovalThreads: () => ['thread-1', 'thread-2'],
      waitingHandoffDots: () => ['dot-1'],
    });
    const { threadIds, dotIds } = registry.exclusions();
    expect([...threadIds].sort()).toEqual(['thread-1', 'thread-2']);
    expect(dotIds).toEqual(['dot-1']);
  });

  it('a throwing lookup does not throw from exclusions()', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const registry = new TurnRegistry({
      pendingApprovalThreads: () => {
        throw new Error('database is locked');
      },
    });
    registry.acquire('dot-1', 'thread-1', 'chat', () => {});
    expect(registry.exclusions()).toEqual({
      threadIds: ['thread-1'],
      dotIds: ['dot-1'],
    });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('turn stop route', () => {
  function fixture() {
    const workspace = new WorkspaceStore(':memory:', 'owner');
    const registry = new TurnRegistry();
    const app = new Hono().route('/api', turnRoutes(registry, workspace));
    const dot = workspace.createDot(
      workspace.spaces()[0].id,
      'Dot',
      '',
      true,
      true,
    );
    return { app, registry, dot };
  }
  const post = (app: Hono, id: string) =>
    app.request(`/api/dots/${id}/turn/stop`, { method: 'POST' });

  it('404s for an unknown Dot', async () => {
    const { app } = fixture();
    const response = await post(app, 'missing');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Dot not found.' });
  });

  it('reports stopped:false when the Dot is idle', async () => {
    const { app, dot } = fixture();
    const response = await post(app, dot.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopped: false });
  });

  it('stops a running turn', async () => {
    const { app, registry, dot } = fixture();
    const stop = vi.fn();
    registry.acquire(dot.id, 'thread-1', 'chat', stop);
    const response = await post(app, dot.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopped: true });
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

// The turn lock wired through a real Platform (concurrent turns, RUN_ERROR, spike 3) is tested in
// tests/integration-turns.test.ts.
