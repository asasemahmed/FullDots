import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { connect } from 'node:net';
import {
  FRAME,
  FrameReader,
  frame,
  fulldotsRelay,
  relayCommand,
  type RelayIO,
  type RelaySocket,
} from '../src/server/remote-relay.js';
import { RemoteTunnel } from '../src/server/remote-tunnel.js';
import type { SshChild, SshSpawner } from '../src/server/remote-ssh.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A TCP socket the relay dials, whose writes report a full buffer until told otherwise. */
class FakeSocket extends EventEmitter implements RelaySocket {
  full = false;
  paused = false;
  resumes = 0;
  written: Buffer[] = [];
  write(data: Buffer) {
    this.written.push(data);
    return !this.full;
  }
  end() {
    this.emit('close');
  }
  destroy() {
    this.emit('close');
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
    this.resumes++;
  }
}

const computer = (owner: string, port: number) => ({
  Names: [`/opendots-computer-${owner}`],
  State: 'running',
  Labels: {
    'openbot.supervisor': 'true',
    'openbot.bot-id': owner,
    'openbot.namespace': 'opendots',
  },
  Ports: [{ IP: '127.0.0.1', PrivatePort: 4100, PublicPort: port }],
});

/** The relay alone, driven frame by frame. */
function relayAlone(
  options: {
    list?: unknown[];
    hold?: Promise<void>;
    idleMs?: number;
    channelFull?: () => boolean;
  } = {},
) {
  const input = new PassThrough();
  const frames: { type: number; id: number; payload: string }[] = [];
  const reader = new FrameReader();
  let text = true;
  const drains: (() => void)[] = [];
  const sockets: FakeSocket[] = [];
  const dialled: number[] = [];
  const exits: number[] = [];
  const io: RelayIO = {
    input,
    write: (data) => {
      const buffer = typeof data === 'string' ? Buffer.from(data) : data;
      if (text) text = false;
      else
        reader.push(buffer, (type, id, payload) =>
          frames.push({ type, id, payload: payload.toString() }),
        );
      return !(options.channelFull?.() ?? false);
    },
    onDrain: (listener) => drains.push(listener),
    connect: (port) => {
      dialled.push(port);
      const socket = new FakeSocket();
      sockets.push(socket);
      setImmediate(() => socket.emit('connect'));
      return socket;
    },
    docker: async () => {
      await options.hold;
      return options.list ?? [computer('dot-a', 32768)];
    },
    namespace: 'opendots',
    ...(options.idleMs ? { idleMs: options.idleMs } : {}),
    exit: (code) => exits.push(code),
  };
  void fulldotsRelay(io);
  cleanups.push(() => input.end());
  const sendFrame = (type: number, id: number, payload?: string | Buffer) =>
    input.write(frame(type, id, payload));
  return { input, frames, sockets, dialled, exits, drains, sendFrame };
}

describe('relay streams', () => {
  it('never dials an open FullDots gave up on while it was being checked', async () => {
    let release = () => undefined as void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const relay = relayAlone({ hold });
    relay.sendFrame(
      FRAME.OPEN,
      7,
      JSON.stringify({ port: 32768, owner: 'dot-a' }),
    );
    await wait(10);
    relay.sendFrame(FRAME.CLOSE, 7);
    await wait(10);
    release();
    await wait(30);
    expect(relay.dialled).toEqual([]);
    expect(relay.frames.filter((item) => item.id === 7)).toEqual([]);
  });

  it('sends one PAUSE per backlog and one RESUME when it drains', async () => {
    const relay = relayAlone();
    relay.sendFrame(
      FRAME.OPEN,
      1,
      JSON.stringify({ port: 32768, owner: 'dot-a' }),
    );
    await wait(20);
    const socket = relay.sockets[0]!;
    socket.full = true;
    for (let i = 0; i < 5; i++) relay.sendFrame(FRAME.DATA, 1, 'chunk');
    await wait(20);
    expect(
      relay.frames.filter((item) => item.type === FRAME.PAUSE),
    ).toHaveLength(1);
    socket.full = false;
    socket.emit('drain');
    socket.emit('drain');
    await wait(10);
    expect(
      relay.frames.filter((item) => item.type === FRAME.RESUME),
    ).toHaveLength(1);
  });

  it('keeps a stream FullDots paused when its own channel drains', async () => {
    let full = false;
    const relay = relayAlone({ channelFull: () => full });
    relay.sendFrame(
      FRAME.OPEN,
      1,
      JSON.stringify({ port: 32768, owner: 'dot-a' }),
    );
    await wait(20);
    const socket = relay.sockets[0]!;
    relay.sendFrame(FRAME.PAUSE, 1);
    await wait(10);
    expect(socket.paused).toBe(true);
    full = true;
    socket.emit('data', Buffer.from('x'));
    full = false;
    for (const drain of relay.drains.splice(0)) drain();
    expect(socket.paused).toBe(true);
    relay.sendFrame(FRAME.RESUME, 1);
    await wait(10);
    expect(socket.paused).toBe(false);
  });

  it('finds the supervisor by name and label, whatever image it was rebuilt from', async () => {
    const relay = relayAlone({
      list: [
        {
          Names: ['/fulldots-computer-supervisor'],
          Image: 'sha256:rebuilt',
          State: 'running',
          Labels: { 'fulldots.remote-supervisor': 'true' },
          Ports: [{ IP: '127.0.0.1', PrivatePort: 4300, PublicPort: 4312 }],
        },
      ],
    });
    relay.sendFrame(
      FRAME.OPEN,
      3,
      JSON.stringify({ port: 4312, owner: 'supervisor' }),
    );
    await wait(30);
    expect(relay.dialled).toEqual([4312]);
    expect(
      relay.frames.some((item) => item.type === FRAME.OPENED && item.id === 3),
    ).toBe(true);
  });

  it('refuses a container named like the supervisor without its label', async () => {
    const relay = relayAlone({
      list: [
        {
          Names: ['/fulldots-computer-supervisor'],
          State: 'running',
          Labels: {},
          Ports: [{ IP: '127.0.0.1', PrivatePort: 4300, PublicPort: 4312 }],
        },
      ],
    });
    relay.sendFrame(
      FRAME.OPEN,
      3,
      JSON.stringify({ port: 4312, owner: 'supervisor' }),
    );
    await wait(30);
    expect(relay.dialled).toEqual([]);
    expect(relay.frames.find((item) => item.id === 3)?.type).toBe(FRAME.FAIL);
  });

  it('leaves after a minute without frames, and stays while heartbeats come', async () => {
    const quiet = relayAlone({ idleMs: 80 });
    const busy = relayAlone({ idleMs: 80 });
    const pings = setInterval(() => busy.sendFrame(FRAME.PING, 0), 20);
    cleanups.push(() => clearInterval(pings));
    await wait(250);
    expect(quiet.exits).toEqual([1]);
    expect(busy.exits).toEqual([]);
  });
});

describe('relay command', () => {
  it('refuses a namespace that could change the server’s shell command', () => {
    expect(() =>
      relayCommand({ namespace: "x'; rm -rf / #", supervisorImage: 'img:tag' }),
    ).toThrow('Invalid computer namespace');
    expect(() =>
      relayCommand({ namespace: 'ok-ns', supervisorImage: "img'; id #" }),
    ).not.toThrow();
    expect(
      relayCommand({ namespace: 'ok-ns', supervisorImage: "img'; id #" }),
    ).toContain(`'img'\\''; id #'`);
  });
});

/** A fake ssh process that runs a hand-driven relay: the test plays the server. */
class FakeChild extends EventEmitter {
  pid = 99;
  exitCode: number | null = null;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill() {
    this.exitCode = 255;
    this.stdout.end();
    setImmediate(() => this.emit('exit', 255));
    return true;
  }
}

async function scripted(
  extra: { requestMs?: number; heartbeatMs?: number } = {},
) {
  const child = new FakeChild();
  const seen: { type: number; id: number }[] = [];
  const reader = new FrameReader();
  child.stdin.on('data', (chunk: Buffer) =>
    reader.push(chunk, (type, id) => seen.push({ type, id })),
  );
  const spawn: SshSpawner = () => {
    setImmediate(() => child.stdout.write('FULLDOTS-READY\n'));
    return child as unknown as SshChild;
  };
  const tunnel = new RemoteTunnel('my-vps', {
    spawn,
    effectiveConfig: async () => '',
    readyMs: 500,
    requestMs: extra.requestMs ?? 1000,
    heartbeatMs: extra.heartbeatMs ?? 60_000,
  });
  cleanups.push(() => tunnel.stop());
  await tunnel.ready();
  return { tunnel, child, seen };
}

describe('tunnel streams', () => {
  it('sends CLOSE for an open that timed out or that the caller left before it opened', async () => {
    const { tunnel, seen } = await scripted({ requestMs: 50 });
    const port = await tunnel.bridge('dot-a', 32768);
    const timedOut = connect(port, '127.0.0.1');
    timedOut.on('error', () => undefined);
    await wait(120);
    const left = connect(port, '127.0.0.1');
    left.on('error', () => undefined);
    await wait(20);
    left.destroy();
    await wait(30);
    const opens = seen
      .filter((item) => item.type === FRAME.OPEN)
      .map((item) => item.id);
    const closes = seen
      .filter((item) => item.type === FRAME.CLOSE)
      .map((item) => item.id);
    expect(opens).toHaveLength(2);
    expect(closes.sort()).toEqual([...opens].sort());
    timedOut.destroy();
  });

  it('does not let the global unblock resume a stream the relay paused', async () => {
    const { tunnel, child } = await scripted();
    const port = await tunnel.bridge('dot-a', 32768);
    const client = connect(port, '127.0.0.1');
    client.on('error', () => undefined);
    await wait(30);
    child.stdout.write(frame(FRAME.OPENED, 1));
    await wait(10);
    child.stdout.write(frame(FRAME.PAUSE, 1));
    await wait(10);
    const internals = tunnel as unknown as {
      streams: Map<
        number,
        { socket: { isPaused(): boolean }; paused: boolean }
      >;
      stdinBlocked: boolean;
      unblock(): void;
    };
    const stream = internals.streams.get(1)!;
    expect(stream.paused).toBe(true);
    internals.stdinBlocked = true;
    internals.unblock();
    expect(stream.socket.isPaused()).toBe(true);
    child.stdout.write(frame(FRAME.RESUME, 1));
    await wait(10);
    expect(stream.socket.isPaused()).toBe(false);
    client.destroy();
  });

  it('sends a heartbeat while the tunnel is up', async () => {
    const { seen } = await scripted({ heartbeatMs: 20 });
    await wait(90);
    expect(
      seen.filter((item) => item.type === FRAME.PING).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('waits ten minutes before retrying a refused login unasked', async () => {
    let now = 5_000_000;
    let spawns = 0;
    const spawn: SshSpawner = () => {
      spawns++;
      const child = new FakeChild();
      setImmediate(() => {
        child.stderr.write('dots@1.2.3.4: Permission denied (publickey).\n');
        child.kill();
      });
      return child as unknown as SshChild;
    };
    const tunnel = new RemoteTunnel('my-vps', {
      spawn,
      effectiveConfig: async () => '',
      maxBackoffMs: 30_000,
      readyMs: 500,
      now: () => now,
    });
    cleanups.push(() => tunnel.stop());
    await expect(tunnel.ready()).rejects.toMatchObject({ problem: 'refused' });
    now += 31_000;
    await expect(tunnel.ready()).rejects.toMatchObject({ problem: 'refused' });
    expect(spawns).toBe(1);
    now += 600_000;
    await expect(tunnel.ready()).rejects.toMatchObject({ problem: 'refused' });
    expect(spawns).toBe(2);
    await expect(tunnel.ready({ force: true })).rejects.toMatchObject({
      problem: 'refused',
    });
    expect(spawns).toBe(3);
  });
});
