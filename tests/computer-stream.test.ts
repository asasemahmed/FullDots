import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ComputerService } from '../src/server/computer-service.js';
import { attachComputerStream } from '../src/server/computer-stream.js';
import { computerRoutes } from '../src/server/computer-routes.js';
import type { ComputerStreamMessage } from '../src/shared/computer-types.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve((server.address() as AddressInfo).port),
    ),
  );

/** A computer's `/stream` endpoint that records what it is sent and sends what the test says. */
async function fakeComputer() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const connections: {
    url: string;
    headers: Record<string, string | string[] | undefined>;
    socket: WebSocket;
    received: string[];
    closed: boolean;
  }[] = [];
  wss.on('connection', (socket, request) => {
    const entry = {
      url: request.url ?? '',
      headers: request.headers,
      socket,
      received: [] as string[],
      closed: false,
    };
    socket.on('message', (data) => entry.received.push(String(data)));
    socket.on('close', () => (entry.closed = true));
    connections.push(entry);
  });
  cleanup.push(() => {
    for (const client of wss.clients) client.terminate();
    wss.close();
  });
  return {
    port: (wss.address() as AddressInfo).port,
    connections,
  };
}

async function fixture(
  options: { running?: boolean; ownerToken?: string } = {},
) {
  const computer = await fakeComputer();
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => workspace.close());
  const id = workspace.dots()[0].id;
  workspace.computers.patch(id, { enabled: true, browser: true });
  const transport: typeof fetch = async (input) => {
    if (String(input).endsWith('/computers'))
      return Response.json({
        computers: [
          {
            botId: id,
            container: `opendots-computer-${id}`,
            status: options.running === false ? 'stopped' : 'running',
            port: computer.port,
            url: `http://127.0.0.1:${computer.port}`,
          },
        ],
      });
    return Response.json({});
  };
  const service = new ComputerService(
    workspace,
    {
      baseUrl: 'https://example.com',
      voiceName: 'voice',
      computerSupervisorUrl: 'http://127.0.0.1:4312',
      computerSupervisorToken: 'supervisor-secret',
      computerToken: 'master-secret',
    },
    () => false,
    transport,
  );
  const server = createServer((_request, response) => response.end('ok'));
  const gateway = attachComputerStream(server, {
    computers: service,
    ownerToken: options.ownerToken,
  });
  const port = await listen(server);
  cleanup.push(() => {
    gateway.close();
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${port}`;
  const address = (dot = id, ticket = service.streamTicket(id).ticket) =>
    `ws://127.0.0.1:${port}/api/dots/${dot}/computer/stream?ticket=${ticket}`;
  /** Opens the live screen the way the panel does, collecting everything it is told. */
  const watch = async (
    url = address(),
    headers: Record<string, string> = {},
  ) => {
    const socket = new WebSocket(url, {
      headers: { Origin: origin, ...headers },
    });
    const messages: ComputerStreamMessage[] = [];
    const raw: string[] = [];
    socket.on('message', (data) => {
      raw.push(String(data));
      messages.push(JSON.parse(String(data)));
    });
    const closed = new Promise<number>((resolve) =>
      socket.on('close', (code) => resolve(code)),
    );
    cleanup.push(() => socket.terminate());
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return { socket, messages, raw, closed };
  };
  return {
    id,
    workspace,
    service,
    computer,
    gateway,
    address,
    watch,
    origin,
    port,
  };
}

const until = async (check: () => unknown, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const frame = JSON.stringify({
  type: 'frame',
  data: Buffer.from('jpeg').toString('base64'),
  width: 1280,
  height: 800,
});

it('refuses a screen that has no valid one-time ticket, origin or host', async () => {
  const f = await fixture();
  const refused = (url: string, headers: Record<string, string> = {}) =>
    new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(url, { headers });
      socket.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0);
        socket.terminate();
      });
      socket.once('open', () => reject(new Error('Should not open.')));
      socket.once('error', () => undefined);
    });
  const ok = { Origin: f.origin };
  expect(await refused(f.address(f.id, 'nonsense'), ok)).toBe(401);
  expect(await refused(f.address(f.id, ''), ok)).toBe(401);
  // Cross-origin pages cannot open it even with a ticket.
  expect(await refused(f.address(), { Origin: 'https://evil.example' })).toBe(
    403,
  );
  expect(
    await refused(f.address(), { ...ok, 'Sec-Fetch-Site': 'cross-site' }),
  ).toBe(403);
  // A host the app would not serve is refused when no owner token guards the app.
  expect(await refused(f.address(), { ...ok, Host: 'evil.example' })).toBe(403);
  // A ticket is spent by one attempt, successful or not.
  const ticket = f.service.streamTicket(f.id).ticket;
  await f.watch(f.address(f.id, ticket));
  expect(await refused(f.address(f.id, ticket), ok)).toBe(401);
  // Another path is not a WebSocket endpoint at all.
  expect(await refused(`ws://127.0.0.1:${f.port}/api/state`, ok)).toBe(404);
  expect(f.computer.connections.length).toBeLessThanOrEqual(1);
});

it('binds a ticket to its Dot and expires it', () => {
  vi.useFakeTimers();
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => workspace.close());
  const id = workspace.dots()[0].id;
  const service = new ComputerService(
    workspace,
    {
      baseUrl: 'https://example.com',
      voiceName: 'voice',
      computerSupervisorUrl: 'http://127.0.0.1:4312',
      computerSupervisorToken: 'supervisor-secret',
      computerToken: 'master-secret',
    },
    () => false,
  );
  // Browser access is off by default, so there is nothing to watch and no ticket to mint.
  expect(() => service.streamTicket(id)).toThrow(
    'Computer permission is disabled.',
  );
  workspace.computers.patch(id, { enabled: true, browser: true });
  const first = service.streamTicket(id);
  expect(service.redeemStreamTicket(first.ticket)).toBe(id);
  expect(service.redeemStreamTicket(first.ticket)).toBeUndefined();
  const second = service.streamTicket(id);
  vi.advanceTimersByTime(first.expiresInMs + 1);
  expect(service.redeemStreamTicket(second.ticket)).toBeUndefined();
  expect(() => service.streamTicket('missing')).toThrow('Dot not found.');
  // Unredeemed tickets are bounded.
  const tickets = Array.from(
    { length: 80 },
    () => service.streamTicket(id).ticket,
  );
  expect(service.redeemStreamTicket(tickets[0])).toBeUndefined();
  expect(service.redeemStreamTicket(tickets[79])).toBe(id);
});

it('relays frames out and validated input in, and keeps the computer credential on the server', async () => {
  const f = await fixture();
  const view = await f.watch();
  await until(() => f.computer.connections.length === 1);
  const upstream = f.computer.connections[0];
  const token = createHmac('sha256', 'master-secret')
    .update(`opendots-computer:${f.id}`)
    .digest('hex');
  const url = new URL(upstream.url, 'http://computer');
  expect(url.pathname).toBe('/stream');
  expect(url.searchParams.get('bot')).toBe(f.id);
  expect(url.searchParams.get('token')).toBe(token);
  expect(upstream.headers['x-openbot-bot-id']).toBe(f.id);

  upstream.socket.send(frame);
  await until(() => view.messages.length === 1);
  expect(view.messages[0]).toMatchObject({
    type: 'frame',
    width: 1280,
    height: 800,
  });

  view.socket.send(
    JSON.stringify({
      type: 'mouse',
      event: 'pressed',
      x: 10,
      y: 20,
      button: 'left',
      clickCount: 1,
    }),
  );
  view.socket.send(JSON.stringify({ type: 'text', text: 'hello' }));
  await until(() => upstream.received.length === 2);
  expect(upstream.received.map((m) => JSON.parse(m).type)).toEqual([
    'mouse',
    'text',
  ]);

  // Anything the schema does not describe stops here and the viewer is told once.
  view.socket.send(JSON.stringify({ type: 'exec', command: 'rm -rf /' }));
  view.socket.send(
    JSON.stringify({ type: 'mouse', event: 'moved', x: -5, y: 0 }),
  );
  view.socket.send(
    JSON.stringify({
      type: 'key',
      event: 'down',
      key: 'a',
      code: 'KeyA',
      extra: 1,
    }),
  );
  view.socket.send('not json');
  view.socket.send(Buffer.from([1, 2, 3]));
  await until(() => view.messages.some((m) => m.type === 'error'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(upstream.received).toHaveLength(2);

  // Errors from the computer are relayed, with its credentials removed.
  upstream.socket.send(
    JSON.stringify({ type: 'error', error: `Take control first (${token})` }),
  );
  await until(() =>
    view.messages.some(
      (m) => m.type === 'error' && m.error.includes('redacted'),
    ),
  );
  expect(view.raw.join('')).not.toContain(token);
  expect(view.raw.join('')).not.toContain('master-secret');
  expect(f.workspace.computers.audit(f.id)[0]).toMatchObject({
    action: 'stream',
    actor: 'owner',
    outcome: 'succeeded',
  });
});

it('shows a second viewer and ends the first, as the computer itself does', async () => {
  const f = await fixture();
  const first = await f.watch();
  await until(() => f.computer.connections.length === 1);
  const second = await f.watch();
  await until(() => first.messages.some((m) => m.type === 'ended'));
  expect(first.messages.at(-1)).toMatchObject({
    type: 'ended',
    reason: 'superseded',
  });
  expect(await first.closed).toBe(1000);
  await until(() => f.computer.connections.length === 2);
  await until(() => f.computer.connections[0].closed);
  // The first viewer's late close does not take the second one down.
  f.computer.connections[1].socket.send(frame);
  await until(() => second.messages.some((m) => m.type === 'frame'));
});

it('ends when the computer says the screen moved on, stopped, or went away', async () => {
  const f = await fixture();
  const taken = await f.watch();
  await until(() => f.computer.connections.length === 1);
  // The computer does not close a socket it supersedes; it only says so.
  f.computer.connections[0].socket.send(
    JSON.stringify({
      type: 'error',
      error:
        'This screen is now being watched somewhere else, so it stopped here.',
    }),
  );
  await until(() => taken.messages.some((m) => m.type === 'ended'));
  expect(taken.messages.at(-1)).toMatchObject({ reason: 'superseded' });
  await until(() => f.computer.connections[0].closed);

  const stopped = await f.watch();
  await until(() => f.computer.connections.length === 2);
  f.computer.connections[1].socket.close();
  await until(() => stopped.messages.some((m) => m.type === 'ended'));
  expect(stopped.messages.at(-1)).toMatchObject({ reason: 'stopped' });
});

it('ends an open screen the moment Browser access is revoked', async () => {
  const f = await fixture();
  const view = await f.watch();
  await until(() => f.computer.connections.length === 1);
  f.workspace.computers.patch(f.id, { browser: false });
  await until(() => view.messages.some((m) => m.type === 'ended'), 4000);
  expect(view.messages.at(-1)).toMatchObject({ reason: 'permission' });
  await until(() => f.computer.connections[0].closed);
});

it('says so when the computer is not running instead of leaving a blank screen', async () => {
  const f = await fixture({ running: false });
  const view = await f.watch();
  await until(() => view.messages.some((m) => m.type === 'ended'));
  expect(view.messages.at(-1)).toMatchObject({
    reason: 'unavailable',
    message: 'Start this Dot’s computer first.',
  });
  expect(f.computer.connections).toHaveLength(0);
  expect(f.workspace.computers.audit(f.id)[0]).toMatchObject({
    action: 'stream',
    outcome: 'failed',
  });
});

it('replaces frames for a slow viewer instead of queueing them', async () => {
  const f = await fixture();
  const view = await f.watch();
  await until(() => f.computer.connections.length === 1);
  view.socket.pause();
  const big = JSON.stringify({
    type: 'frame',
    data: 'A'.repeat(1_000_000),
    width: 1280,
    height: 800,
  });
  for (let i = 0; i < 40; i += 1) f.computer.connections[0].socket.send(big);
  await new Promise((resolve) => setTimeout(resolve, 300));
  view.socket.resume();
  await until(() => view.messages.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(view.messages.length).toBeLessThan(40);
  expect(view.messages.length).toBeGreaterThan(0);
});

it('closes every open screen when the server shuts down', async () => {
  const f = await fixture();
  const view = await f.watch();
  await until(() => f.computer.connections.length === 1);
  f.gateway.close();
  await until(() => view.messages.some((m) => m.type === 'ended'));
  expect(view.messages.at(-1)).toMatchObject({ reason: 'shutdown' });
  expect(await view.closed).toBe(1001);
});

it('mints a ticket over the API only while Browser access is on', async () => {
  const f = await fixture();
  const routes = computerRoutes(f.service);
  const ask = () =>
    routes.request(`/dots/${f.id}/computer/stream`, { method: 'POST' });
  const granted = await ask();
  expect(granted.status).toBe(200);
  const body = (await granted.json()) as {
    ticket: string;
    expiresInMs: number;
  };
  expect(f.service.redeemStreamTicket(body.ticket)).toBe(f.id);
  f.workspace.computers.patch(f.id, { browser: false });
  const denied = await ask();
  expect(denied.status).toBe(400);
  expect(await denied.json()).toEqual({
    error: 'Computer permission is disabled.',
  });
});
