import { expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Readable, Writable } from 'node:stream';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import {
  authenticationRequired,
  runAcp,
} from '../src/server/agents/acp-client.js';
import { fakeCodingAgent } from './fixtures/fake-coding-agent.js';

it('initializes an in-process agent, selects default mode, streams text, and closes', async () => {
  const fake = fakeCodingAgent();
  const update = vi.fn();
  const session = vi.fn();
  const response = await runAcp({
    target: fake.app,
    provider: 'claude',
    task: 'Make a change',
    signal: new AbortController().signal,
    permission: async () => ({ outcome: { outcome: 'cancelled' } }),
    update,
    session,
  });
  expect(fake.state).toMatchObject({
    initialized: true,
    mode: 'default',
    prompted: true,
  });
  expect(session).toHaveBeenCalledWith('fixture-session');
  expect(update.mock.calls[0][0].update.content.text).toContain('Working');
  expect(response.stopReason).toBe('end_turn');
  expect(fake.state.sessionMeta).toMatchObject({
    claudeCode: {
      options: { settingSources: [], allowDangerouslySkipPermissions: false },
    },
  });
});

it.each(['acceptEdits', 'plan', 'auto', 'bypassPermissions'])(
  'cancels a worker that reports current mode %s',
  async (modeUpdate) => {
    const fake = fakeCodingAgent({ modeUpdate, waitForCancel: true });
    await expect(
      runAcp({
        target: fake.app,
        provider: 'claude',
        task: 'Task',
        signal: new AbortController().signal,
        permission: async () => ({ outcome: { outcome: 'cancelled' } }),
        update: () => {},
        session: () => {},
      }),
    ).rejects.toThrow('left default permission mode');
    expect(fake.state.cancelled).toBe(1);
  },
);

it('refuses a session that starts outside default mode before sending a prompt', async () => {
  const fake = fakeCodingAgent({ initialMode: 'acceptEdits' });
  await expect(
    runAcp({
      target: fake.app,
      provider: 'claude',
      task: 'Task',
      signal: new AbortController().signal,
      permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      update: () => {},
      session: () => {},
    }),
  ).rejects.toThrow('left default permission mode');
  expect(fake.state.prompted).toBe(false);
  expect(fake.state.cancelled).toBe(1);
});

it.each(['new', 'prompt'] as const)(
  'recognizes authentication required from session/%s',
  async (authAt) => {
    const fake = fakeCodingAgent({ authAt });
    await expect(
      runAcp({
        target: fake.app,
        provider: 'claude',
        task: 'Task',
        signal: new AbortController().signal,
        permission: async () => ({ outcome: { outcome: 'cancelled' } }),
        update: () => {},
        session: () => {},
      }),
    ).rejects.toSatisfy(authenticationRequired);
    expect(
      authenticationRequired({ code: -32000, message: 'Other failure' }),
    ).toBe(false);
  },
);

it('remembers a non-default mode notification sent before session/new returns', async () => {
  const fake = fakeCodingAgent({ earlyModeUpdate: 'acceptEdits' });
  await expect(
    runAcp({
      target: fake.app,
      provider: 'claude',
      task: 'Task',
      signal: new AbortController().signal,
      permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      update: () => {},
      session: () => {},
    }),
  ).rejects.toThrow('left default permission mode');
  expect(fake.state.prompted).toBe(false);
  expect(fake.state.cancelled).toBe(1);
});

it('cancels the protocol session before closing on abort', async () => {
  const fake = fakeCodingAgent({ waitForCancel: true });
  const abort = new AbortController();
  const running = runAcp({
    target: fake.app,
    provider: 'claude',
    task: 'Task',
    signal: abort.signal,
    permission: async () => ({ outcome: { outcome: 'cancelled' } }),
    update: () => {},
    session: () => {},
  });
  await vi.waitFor(() => expect(fake.state.prompted).toBe(true));
  abort.abort();
  await running.catch(() => undefined);
  expect(fake.state.cancelled).toBeGreaterThan(0);
});

it('denies permissions for a different session without asking the owner', async () => {
  const fake = fakeCodingAgent({
    permission: true,
    wrongPermissionSession: true,
  });
  const permission = vi.fn();
  await runAcp({
    target: fake.app,
    provider: 'claude',
    task: 'Task',
    signal: new AbortController().signal,
    permission,
    update: () => {},
    session: () => {},
  });
  expect(permission).not.toHaveBeenCalled();
  expect(fake.state.outcome?.outcome.outcome).toBe('cancelled');
});

it('frames split NDJSON messages over real byte streams against an SDK agent', async () => {
  const fake = fakeCodingAgent();
  const toAgent = new PassThrough();
  const toClient = new PassThrough();
  const writable = (stream: PassThrough) =>
    Writable.toWeb(stream) as WritableStream<Uint8Array>;
  const readable = (stream: PassThrough) =>
    Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  const connection = fake.app.connect(
    ndJsonStream(writable(toClient), readable(toAgent)),
  );
  const original = toClient.write.bind(toClient);
  toClient.write = ((chunk: Buffer) => {
    const data = Buffer.from(chunk);
    original(data.subarray(0, 7));
    return original(data.subarray(7));
  }) as typeof toClient.write;
  try {
    const response = await runAcp({
      target: ndJsonStream(writable(toAgent), readable(toClient)),
      provider: 'claude',
      task: 'Task',
      signal: new AbortController().signal,
      permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      update: () => {},
      session: () => {},
    });
    expect(response.stopReason).toBe('end_turn');
  } finally {
    connection.close();
    toAgent.destroy();
    toClient.destroy();
  }
});

const codexModes = [
  'read-only',
  'workspace-write',
  'agent',
  'agent-full-access',
];

it('selects Codex read-only mode and sends no Claude Code session options', async () => {
  const fake = fakeCodingAgent({ initialMode: 'agent', modes: codexModes });
  const response = await runAcp({
    target: fake.app,
    provider: 'codex',
    task: 'Make a change',
    signal: new AbortController().signal,
    permission: async () => ({ outcome: { outcome: 'cancelled' } }),
    update: () => {},
    session: () => {},
  });
  expect(response.stopReason).toBe('end_turn');
  expect(fake.state.mode).toBe('read-only');
  expect(fake.state.sessionMeta).toBeUndefined();
});

it('never prompts Codex when it does not list the ask-first mode', async () => {
  const fake = fakeCodingAgent({ modes: ['agent', 'agent-full-access'] });
  await expect(
    runAcp({
      target: fake.app,
      provider: 'codex',
      task: 'Task',
      signal: new AbortController().signal,
      permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      update: () => {},
      session: () => {},
    }),
  ).rejects.toThrow('left default permission mode');
  expect(fake.state.prompted).toBe(false);
  expect(fake.state.mode).toBe('');
});

it.each(['agent', 'workspace-write', 'agent-full-access'])(
  'cancels Codex when it reports mode %s',
  async (modeUpdate) => {
    const fake = fakeCodingAgent({
      initialMode: 'read-only',
      modes: codexModes,
      modeUpdate,
      waitForCancel: true,
    });
    await expect(
      runAcp({
        target: fake.app,
        provider: 'codex',
        task: 'Task',
        signal: new AbortController().signal,
        permission: async () => ({ outcome: { outcome: 'cancelled' } }),
        update: () => {},
        session: () => {},
      }),
    ).rejects.toThrow('left default permission mode');
    expect(fake.state.cancelled).toBe(1);
  },
);

it('still refuses a Claude Code session that starts outside default when Codex presets exist', async () => {
  const fake = fakeCodingAgent({ initialMode: 'read-only' });
  await expect(
    runAcp({
      target: fake.app,
      provider: 'claude',
      task: 'Task',
      signal: new AbortController().signal,
      permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      update: () => {},
      session: () => {},
    }),
  ).rejects.toThrow('left default permission mode');
  expect(fake.state.prompted).toBe(false);
});
