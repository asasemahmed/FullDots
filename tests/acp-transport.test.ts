import { afterEach, expect, it, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { WebSocketServer, createWebSocketStream } from 'ws';
import type { AddressInfo } from 'node:net';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import {
  connectCodingBridge,
  runAcp,
} from '../src/server/agents/acp-client.js';
import { fakeCodingAgent } from './fixtures/fake-coding-agent.js';

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
async function server() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  cleanup.push(() => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  });
  const target = {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/acp`,
    headers: {
      'x-openbot-computer-token': 'fixture-per-dot-token',
      'x-openbot-bot-id': 'dot-a',
    },
  };
  return { wss, target };
}

it('runs the real WebSocket framing against an SDK fake and sends credentials only in headers', async () => {
  const { wss, target } = await server();
  const fake = fakeCodingAgent();
  const received = vi.fn();
  wss.on('connection', (ws, request) => {
    received(request.url, request.headers);
    ws.send(JSON.stringify({ bridgeReady: true }));
    const duplex = createWebSocketStream(ws);
    const connection = fake.app.connect(
      ndJsonStream(
        Writable.toWeb(duplex) as WritableStream<Uint8Array>,
        Readable.toWeb(duplex) as ReadableStream<Uint8Array>,
      ),
    );
    cleanup.push(() => connection.close());
  });
  const abort = new AbortController();
  const bridge = await connectCodingBridge(target, abort.signal);
  try {
    await expect(
      runAcp({
        target: bridge.stream,
        provider: 'claude',
        task: 'Task',
        signal: abort.signal,
        session: () => {},
        update: () => {},
        permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      }),
    ).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(received.mock.calls[0][0]).toBe('/acp');
    expect(received.mock.calls[0][1]).toMatchObject(target.headers);
  } finally {
    bridge.close();
  }
  await vi.waitFor(() => expect(wss.clients.size).toBe(0));
});

it('refuses malformed bridge readiness and closes the socket', async () => {
  const { wss, target } = await server();
  wss.on('connection', (ws) => ws.send('{broken'));
  await expect(
    connectCodingBridge(target, new AbortController().signal),
  ).rejects.toThrow('unavailable');
  await vi.waitFor(() => expect(wss.clients.size).toBe(0));
});

it('cancels a connection waiting for adapter installation', async () => {
  const { wss, target } = await server();
  const abort = new AbortController();
  const opening = connectCodingBridge(target, abort.signal);
  const failed = expect(opening).rejects.toThrow();
  await vi.waitFor(() => expect(wss.clients.size).toBe(1));
  abort.abort();
  await failed;
  await vi.waitFor(() => expect(wss.clients.size).toBe(0));
});

it('bounds an unfinished NDJSON line even when each WebSocket frame is below the limit', async () => {
  const { wss, target } = await server();
  wss.on('connection', (ws) => ws.send(JSON.stringify({ bridgeReady: true })));
  const bridge = await connectCodingBridge(
    target,
    new AbortController().signal,
  );
  const reader = bridge.stream.readable.getReader();
  try {
    const reading = expect(reader.read()).rejects.toThrow();
    const peer = [...wss.clients][0];
    peer.send('x'.repeat(600_000));
    peer.send('x'.repeat(600_000));
    await reading;
  } finally {
    reader.releaseLock();
    bridge.close();
  }
});
