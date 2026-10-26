import { expect, it, vi } from 'vitest';
import process from 'node:process';
import {
  authenticated,
  providerName,
  withAcpBridge,
} from '../deployment/computers/acp-bridge/bridge.mjs';
import { addCodingBridge } from '../deployment/computers/acp-bridge/patch.mjs';

const { Headers, Request, Response } = globalThis;

const token = 'fixture-computer-token-long-enough';
it('requires both the existing credential and the exact Dot identity', () => {
  const headers = new Headers({
    'x-openbot-computer-token': token,
    'x-openbot-bot-id': 'dot-a',
  });
  expect(authenticated(headers, token, 'dot-a')).toBe(true);
  expect(authenticated(headers, `  ${token}\n`, 'dot-a')).toBe(true);
  expect(authenticated(headers, token, 'dot-b')).toBe(false);
  expect(authenticated(headers, `${token}-wrong`, 'dot-a')).toBe(false);
  expect(authenticated(new Headers(), token, 'dot-a')).toBe(false);
  expect(
    authenticated(
      new Headers({ authorization: `Bearer ${token}` }),
      token,
      'dot-a',
    ),
  ).toBe(false);
  expect(authenticated(headers, '', 'dot-a')).toBe(false);
});

it('preserves the existing HTTP and screen handlers', async () => {
  const upstream = {
    fetch: vi.fn(() => new Response('health')),
    websocket: { open: vi.fn(), message: vi.fn(), close: vi.fn() },
  };
  const bridge = withAcpBridge(upstream);
  expect(bridge.websocket.maxPayloadLength).toBe(1024 * 1024);
  const socket = { data: { botId: 'dot-a' } };
  expect(
    await (
      await bridge.fetch(new Request('http://localhost/health'), {})
    ).text(),
  ).toBe('health');
  bridge.websocket.open(socket);
  bridge.websocket.message(socket, 'screen input');
  bridge.websocket.close(socket, 1000, 'closed');
  expect(upstream.websocket.open).toHaveBeenCalledWith(socket);
  expect(upstream.websocket.message).toHaveBeenCalledWith(
    socket,
    'screen input',
  );
  expect(upstream.websocket.close).toHaveBeenCalledWith(socket, 1000, 'closed');
  expect(
    bridge.fetch(new Request(`http://localhost/acp?token=${token}`), {}).status,
  ).toBe(401);
});

it('patches only a recognized pinned computer server and fails closed on drift', () => {
  const source =
    'serve<StreamData>({\n  fetch() {}\n  },\n});\n\ntype ActionBody = {';
  const patched = addCodingBridge(source);
  expect(patched).toContain('serve<StreamData>(withAcpBridge({');
  expect(patched).toContain('}));\n\ntype ActionBody');
  expect(() => addCodingBridge('different upstream')).toThrow(
    'Pinned computer server changed',
  );
  expect(() => addCodingBridge(source + source)).toThrow(
    'Pinned computer server changed',
  );
});

it('kills a worker immediately on oversized input without waiting for a close handshake', () => {
  const bridge = withAcpBridge({ websocket: {}, fetch: vi.fn() });
  const close = vi.fn();
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const socket = {
    data: {
      acp: true,
      child: { pid: 12345, stdin: { writable: true, writableLength: 0 } },
    },
    close,
  };
  try {
    bridge.websocket.message(socket, 'x'.repeat(1024 * 1024 + 1));
    expect(kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
    expect(socket.data.closed).toBe(true);
    expect(close).toHaveBeenCalledWith(1008, 'Invalid coding input.');
  } finally {
    kill.mockRestore();
  }
});

function acpRequest(provider) {
  const headers = new Headers({
    'x-openbot-computer-token': token,
    'x-openbot-bot-id': 'dot-a',
  });
  if (provider !== undefined)
    headers.set('x-fulldots-coding-provider', provider);
  return new Request('http://localhost/acp', { headers });
}

it('accepts only listed coding agents and refuses everything else', () => {
  expect(providerName('claude')).toBe('claude');
  expect(providerName('codex')).toBe('codex');
  for (const name of [
    'gemini',
    'Codex',
    '',
    'constructor',
    '__proto__',
    'toString',
    undefined,
    null,
    42,
  ])
    expect(providerName(name)).toBeUndefined();
});

it('starts the coding agent named in the request and defaults to Claude Code', () => {
  vi.stubEnv('COMPUTER_TOKEN', token);
  vi.stubEnv('COMPUTER_BOT_ID', 'dot-a');
  try {
    for (const [header, expected] of [
      [undefined, 'claude'],
      ['claude', 'claude'],
      ['codex', 'codex'],
    ]) {
      const upgrade = vi.fn(() => true);
      withAcpBridge({ websocket: {}, fetch: vi.fn() }).fetch(
        acpRequest(header),
        { upgrade },
      );
      expect(upgrade).toHaveBeenCalledOnce();
      expect(upgrade.mock.calls[0][1].data).toMatchObject({
        acp: true,
        provider: expected,
      });
    }
  } finally {
    vi.unstubAllEnvs();
  }
});

it('refuses an unknown coding agent before any upgrade, install or process', async () => {
  vi.stubEnv('COMPUTER_TOKEN', token);
  vi.stubEnv('COMPUTER_BOT_ID', 'dot-a');
  try {
    for (const name of ['gemini', 'constructor', '../codex']) {
      const upgrade = vi.fn(() => true);
      const response = withAcpBridge({ websocket: {}, fetch: vi.fn() }).fetch(
        acpRequest(name),
        { upgrade },
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Unknown coding provider.');
      expect(upgrade).not.toHaveBeenCalled();
    }
  } finally {
    vi.unstubAllEnvs();
  }
});

it('closes a session whose stored agent name is not listed', async () => {
  const bridge = withAcpBridge({ websocket: {}, fetch: vi.fn() });
  const socket = {
    data: { acp: true, provider: 'constructor' },
    close: vi.fn(),
    send: vi.fn(),
  };
  await bridge.websocket.open(socket);
  expect(socket.close).toHaveBeenCalledWith(1011, 'Unknown coding provider.');
  expect(socket.send).not.toHaveBeenCalled();
  expect(socket.data.child).toBeUndefined();
});
