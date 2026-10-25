import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { setupStatus } from '../src/server/platform-config.js';
import type { PlatformConfig } from '../src/server/platform-config.js';

const sdk = vi.hoisted(() => {
  const create = vi.fn();
  const use = vi.fn();
  const constructed: unknown[] = [];
  class Composio {
    sessions = { create, use };
    constructor(options: unknown) {
      constructed.push(options);
    }
  }
  return { create, use, constructed, Composio };
});

vi.mock('@composio/core', () => ({ Composio: sdk.Composio }));

const config: PlatformConfig = {
  baseUrl: 'https://unused.invalid/v1',
  voiceName: 'marin',
  composioApiKey: 'test-key',
};

const closers: WorkspaceStore[] = [];
afterEach(() => {
  closers.splice(0).forEach((workspace) => workspace.close());
});
beforeEach(() => {
  sdk.create.mockReset();
  sdk.use.mockReset();
  sdk.create.mockResolvedValue({ sessionId: 'ses_1' });
  sdk.use.mockResolvedValue({ sessionId: 'ses_1' });
});

function dotWith(
  policy: { allowed: boolean; toolkits: string[] } = {
    allowed: true,
    toolkits: ['gmail'],
  },
) {
  const workspace = new WorkspaceStore(':memory:', 'owner-1');
  closers.push(workspace);
  const dot = workspace.dots()[0]!;
  workspace.composio.savePolicy(dot.id, policy);
  return { workspace, dot };
}

async function sessionApi() {
  vi.resetModules();
  return import('../src/server/composio.js');
}

async function turnApi() {
  vi.resetModules();
  return import('../src/server/composio-tools.js');
}

describe('Composio sessions', () => {
  it('hides the feature and builds nothing when the key is missing', async () => {
    const before = sdk.constructed.length;
    const { composioToolsForTurn } = await turnApi();
    const { workspace, dot } = dotWith();
    const tools = await composioToolsForTurn({
      config: { ...config, composioApiKey: undefined },
      workspace,
      settings: { composioAllowed: true },
      dotId: dot.id,
      ownerId: workspace.ownerId,
      check: () => {},
    });
    expect(tools).toEqual([]);
    expect(sdk.constructed).toHaveLength(before);
    expect(sdk.create).not.toHaveBeenCalled();
    expect(
      setupStatus({ baseUrl: config.baseUrl, voiceName: 'marin' }).composio,
    ).toBe(false);
    expect(setupStatus(config).composio).toBe(true);
  });

  it('loads nothing while either switch is off', async () => {
    const { composioToolsForTurn } = await turnApi();
    const { workspace, dot } = dotWith();
    const base = {
      config,
      workspace,
      dotId: dot.id,
      ownerId: workspace.ownerId,
      check: () => {},
    };
    expect(
      await composioToolsForTurn({
        ...base,
        settings: { composioAllowed: false },
      }),
    ).toEqual([]);
    workspace.composio.savePolicy(dot.id, {
      allowed: false,
      toolkits: ['gmail'],
    });
    expect(
      await composioToolsForTurn({
        ...base,
        settings: { composioAllowed: true },
      }),
    ).toEqual([]);
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it('passes the allow-list, reuses a session, and creates a new one when the policy changes', async () => {
    const signal = new AbortController().signal;
    const { workspace, dot } = dotWith({
      allowed: true,
      toolkits: ['google_calendar', 'gmail'],
    });
    const { composioSession, composioPolicyHash } = await sessionApi();
    expect(composioPolicyHash(['slack', 'gmail'])).toBe(
      composioPolicyHash(['gmail', 'slack']),
    );
    expect(composioPolicyHash(['gmail'])).not.toBe(composioPolicyHash([]));

    await composioSession(config, workspace, dot.id, workspace.ownerId, signal);
    expect(sdk.constructed).toContainEqual({
      apiKey: 'test-key',
      logLevel: 'silent',
    });
    expect(sdk.create).toHaveBeenCalledWith(
      'owner-1',
      {
        instant: false,
        manageConnections: true,
        sandbox: { enable: false },
        sessionPreset: 'direct_tools',
        toolkits: ['gmail', 'google_calendar'],
      },
      { signal },
    );
    expect(workspace.composio.get(dot.id)?.sessionId).toBe('ses_1');

    await composioSession(config, workspace, dot.id, workspace.ownerId, signal);
    expect(sdk.use).toHaveBeenCalledWith('ses_1', undefined, { signal });
    expect(sdk.create).toHaveBeenCalledTimes(1);

    sdk.create.mockResolvedValue({ sessionId: 'ses_2' });
    workspace.composio.savePolicy(dot.id, {
      allowed: true,
      toolkits: ['slack'],
    });
    await composioSession(config, workspace, dot.id, workspace.ownerId, signal);
    expect(sdk.create).toHaveBeenCalledTimes(2);
    expect(workspace.composio.get(dot.id)?.sessionId).toBe('ses_2');
  });

  it('omits the toolkit filter when the allow-list is blank', async () => {
    const { workspace, dot } = dotWith({ allowed: true, toolkits: [] });
    const { composioSession } = await sessionApi();
    await composioSession(config, workspace, dot.id, workspace.ownerId);
    const sent = sdk.create.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('toolkits');
    expect(sent.sessionPreset).toBe('direct_tools');
  });

  it('logs a sanitised session failure and offers no tools', async () => {
    sdk.create.mockRejectedValue(new Error('sk-live-secret'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { composioToolsForTurn } = await turnApi();
      const { workspace, dot } = dotWith();
      const tools = await composioToolsForTurn({
        config,
        workspace,
        settings: { composioAllowed: true },
        dotId: dot.id,
        ownerId: workspace.ownerId,
        check: () => {},
      });
      expect(tools).toEqual([]);
      expect(error.mock.calls.join(' ')).toContain(
        'Composio session failed: Error.',
      );
      expect(error.mock.calls.join(' ')).not.toContain('sk-live');
    } finally {
      error.mockRestore();
    }
  });
});
