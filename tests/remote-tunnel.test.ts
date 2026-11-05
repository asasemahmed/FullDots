import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { connect, createServer, type Server, type Socket } from 'node:net';
import {
  RemoteTunnel,
  TunnelError,
  effectiveSshConfig,
  type TunnelOptions,
} from '../src/server/remote-tunnel.js';
import {
  FIXED_OPTIONS,
  classifySsh,
  configuredForwards,
  sshArgs,
  timeoutOptions,
  validAlias,
  type SshChild,
  type SshSpawner,
} from '../src/server/remote-ssh.js';
import {
  fulldotsRelay,
  relayCommand,
  type RelayIO,
} from '../src/server/remote-relay.js';

const tunnels: RemoteTunnel[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const tunnel of tunnels.splice(0)) tunnel.stop();
  for (const server of servers.splice(0)) server.close();
});

/** A fake ssh process: what FullDots would spawn, with no network and no ssh. */
class FakeChild extends EventEmitter {
  pid: number | undefined = Math.floor(Math.random() * 10000) + 1;
  exitCode: number | null = null;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill() {
    this.killed = true;
    this.exit(255);
    return true;
  }
  exit(code: number) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.stdout.end();
    setImmediate(() => {
      this.emit('exit', code);
      this.emit('close', code);
    });
  }
}

type DockerList = {
  Names: string[];
  Image?: string;
  State: string;
  Labels: Record<string, string>;
  Ports: { IP: string; PrivatePort: number; PublicPort: number }[];
};

/** The server: Docker's answers, and which loopback port each real local test server stands for. */
interface FakeServer {
  containers: DockerList[];
  inspect: Record<string, unknown>;
  images: Record<string, string>;
  dialled: { port: number; host: string }[];
  /** A server port the relay may dial, standing in for a local test port. */
  map?: Record<number, number>;
  /** Holds Docker answers until resolved, to test opens given up while they are checked. */
  hold?: Promise<void>;
}

/** Runs the real relay in-process on the fake ssh process's stdio. */
function relayOn(child: FakeChild, server: FakeServer) {
  const io: RelayIO = {
    input: child.stdin,
    write: (data) => child.stdout.write(data),
    onDrain: (listener) => child.stdout.once('drain', listener),
    connect: (port, host) => {
      server.dialled.push({ port, host });
      return connect({
        port: server.map?.[port] ?? port,
        host,
      }) as unknown as ReturnType<RelayIO['connect']>;
    },
    docker: async (path) => {
      await server.hold;
      const url = new URL(`http://docker${path}`);
      if (url.pathname === '/containers/json') {
        const filters = JSON.parse(url.searchParams.get('filters') ?? '{}') as {
          label?: string[];
          name?: string[];
        };
        return server.containers.filter(
          (item) =>
            (filters.label ?? []).every((label) => {
              const [key, value] = label.split('=');
              return item.Labels[key!] === value;
            }) &&
            (filters.name ?? []).every((name) =>
              item.Names.includes(`/${name}`),
            ),
        );
      }
      const inspect = /^\/containers\/([^/]+)\/json$/.exec(url.pathname);
      if (inspect)
        return server.inspect[decodeURIComponent(inspect[1]!)] ?? null;
      const image = /^\/images\/([^/]+)\/json$/.exec(url.pathname);
      if (image) {
        const id = server.images[decodeURIComponent(image[1]!)];
        return id ? { Id: id } : null;
      }
      return null;
    },
    namespace: 'opendots',
    exit: () => child.exit(0),
  };
  void fulldotsRelay(io);
}

function spawner(behave: (child: FakeChild, args: readonly string[]) => void) {
  const calls: { file: string; args: readonly string[]; child: FakeChild }[] =
    [];
  const spawn: SshSpawner = (file, args) => {
    const child = new FakeChild();
    calls.push({ file, args, child });
    setImmediate(() => behave(child, args));
    return child as unknown as SshChild;
  };
  return { spawn, calls };
}

const options = (
  spawn: SshSpawner,
  extra: Partial<TunnelOptions> = {},
): TunnelOptions => ({
  spawn,
  effectiveConfig: async () => 'connecttimeout none\nserveraliveinterval 0\n',
  backoffMs: 5,
  maxBackoffMs: 40,
  readyMs: 500,
  requestMs: 1000,
  ...extra,
});

function tunnelFor(spawn: SshSpawner, extra: Partial<TunnelOptions> = {}) {
  const tunnel = new RemoteTunnel('my-vps', options(spawn, extra));
  tunnels.push(tunnel);
  return tunnel;
}

/** A TCP echo server on this machine's loopback, standing for a port on the server's loopback. */
async function echoServer(): Promise<number> {
  const server = createServer((socket) => socket.pipe(socket));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

function computerOn(owner: string, port: number, ip = '127.0.0.1'): DockerList {
  return {
    Names: [`/opendots-computer-${owner}`],
    State: 'running',
    Labels: {
      'openbot.supervisor': 'true',
      'openbot.bot-id': owner,
      'openbot.namespace': 'opendots',
    },
    Ports: [{ IP: ip, PrivatePort: 4100, PublicPort: port }],
  };
}

/** Writes through a bridge and resolves with what came back, or 'closed'. */
function roundTrip(port: number, text: string) {
  return new Promise<string>((resolve) => {
    const socket: Socket = connect(port, '127.0.0.1');
    let got = '';
    socket.on('data', (data) => {
      got += data.toString();
      if (got.length >= text.length) {
        socket.end();
        resolve(got);
      }
    });
    socket.on('error', () => resolve('closed'));
    socket.on('close', () => resolve(got || 'closed'));
    socket.write(text);
  });
}

describe('ssh arguments', () => {
  it('refuses aliases that could be read as options or hold other characters', () => {
    for (const bad of [
      '-oProxyCommand=calc',
      '-p',
      'a b',
      'host;rm',
      'h$(x)',
      '',
      'a'.repeat(101),
      'user@host',
    ])
      expect(validAlias(bad)).toBe(false);
    for (const good of ['my-vps', 'vps.example', 'dots_1', 'A9'])
      expect(validAlias(good)).toBe(true);
    expect(() => sshArgs('-oProxyCommand=calc', {})).toThrow();
  });

  it('always starts with the fixed options and puts the alias after --', () => {
    const args = sshArgs(
      'my-vps',
      { configFile: '/tmp/test_config' },
      { extra: ['-T'], remote: 'true' },
    );
    expect(args.slice(0, 2)).toEqual(['-F', '/tmp/test_config']);
    expect(args.slice(2, 2 + FIXED_OPTIONS.length)).toEqual([...FIXED_OPTIONS]);
    for (const option of [
      'BatchMode=yes',
      'StrictHostKeyChecking=yes',
      'ControlMaster=no',
      'ControlPath=none',
      'ForwardAgent=no',
      'ForwardX11=no',
      'PermitLocalCommand=no',
      'ClearAllForwardings=yes',
      'StdinNull=no',
      'SessionType=default',
      'Tunnel=no',
      'RemoteCommand=none',
      '-a',
      '-x',
    ])
      expect(args).toContain(option);
    const dashdash = args.indexOf('--');
    expect(args[dashdash + 1]).toBe('my-vps');
    expect(args.slice(dashdash + 2)).toEqual(['true']);
    expect(args.indexOf('-T')).toBeLessThan(dashdash);
  });

  it('fills in timeouts only where the alias leaves ssh defaults', () => {
    expect(
      timeoutOptions(
        'connecttimeout none\nserveraliveinterval 0\nserveralivecountmax 3',
      ),
    ).toEqual([
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
    ]);
    expect(
      timeoutOptions(
        'connecttimeout 30\nserveraliveinterval 60\nserveralivecountmax 5',
      ),
    ).toEqual([]);
  });

  it('finds forwards an alias sets', () => {
    expect(
      configuredForwards('user dots\nlocalforward 8080 [127.0.0.1]:80\n'),
    ).toEqual(['localforward']);
    expect(
      configuredForwards('dynamicforward 1080\nremoteforward 9 x:9'),
    ).toHaveLength(2);
    expect(configuredForwards('user dots\nclearallforwardings no')).toEqual([]);
  });

  it('classifies what ssh reports without keeping its text', () => {
    expect(classifySsh('Host key verification failed.')).toBe(
      'host_key_unknown',
    );
    expect(
      classifySsh('No ED25519 host key is known for [127.0.0.1]:22022'),
    ).toBe('host_key_unknown');
    expect(classifySsh('dots@1.2.3.4: Permission denied (publickey).')).toBe(
      'refused',
    );
    expect(
      classifySsh('ssh: Could not resolve hostname nope: Name or service'),
    ).toBe('alias_unknown');
    expect(
      classifySsh(
        'permission denied while trying to connect to the Docker daemon socket',
      ),
    ).toBe('docker_denied');
  });
});

describe('the relay command on the server', () => {
  it('forwards no port and runs the relay locked down, without logging traffic', () => {
    const command = relayCommand({
      namespace: 'opendots',
      supervisorImage: 'opendots-supervisor:b6932d3-desktop1',
    });
    for (const part of [
      '--rm -i',
      '--log-driver none',
      '--network host',
      '--cap-drop ALL',
      'no-new-privileges:true',
      '--read-only',
      '--user 65534:65534',
      '--memory 256m',
      '--pids-limit 64',
      '--entrypoint sh opendots-supervisor:b6932d3-desktop1',
    ])
      expect(command).toContain(part);
    expect(command).not.toMatch(/ -p /);
    const source = Buffer.from(
      command.trim().split(' ').at(-1)!,
      'base64',
    ).toString('utf8');
    expect(source).toContain('fulldotsRelay');
    expect(source).toContain("{ unix: '/var/run/docker.sock' }");
    // The relay source compiles on its own (top-level await, as Bun runs it).
    const AsyncFunction = Object.getPrototypeOf(async () => undefined)
      .constructor as new (body: string) => unknown;
    expect(() => new AsyncFunction(source)).not.toThrow();
  });

  it('starts the tunnel with -T, the relay and no forward at all', async () => {
    const fake = spawner((child) => child.stdout.write('FULLDOTS-READY\n'));
    const tunnel = tunnelFor(fake.spawn);
    await tunnel.ready();
    const { args } = fake.calls[0]!;
    expect(args).toContain('-T');
    expect(args).toContain('ClearAllForwardings=yes');
    expect(args).not.toContain('-D');
    expect(args).not.toContain('-L');
    expect(args[args.indexOf('--') + 1]).toBe('my-vps');
    expect(args.at(-1)).toContain('docker run --rm -i');
  });
});

describe('connections through the relay', () => {
  it('carries a connection to the Dot’s own published port and nothing else', async () => {
    const port = await echoServer();
    const other = await echoServer();
    const server: FakeServer = {
      containers: [computerOn('dot-a', port), computerOn('dot-b', other)],
      inspect: {},
      images: {},
      dialled: [],
    };
    const fake = spawner((child) => relayOn(child, server));
    const tunnel = tunnelFor(fake.spawn);
    await tunnel.ready();
    const mine = await tunnel.bridge('dot-a', port);
    expect(await roundTrip(mine, 'hello through ssh')).toBe(
      'hello through ssh',
    );
    // dot-a's bridge pointed at dot-b's port: refused on the server, nothing dialled.
    const dialled = server.dialled.length;
    const wrong = await tunnel.bridge('dot-b', port);
    expect(await roundTrip(wrong, 'x')).toBe('closed');
    // A port no managed container publishes (the server's own services, metadata, anything else).
    const stray = await tunnel.bridge('dot-a', 22);
    expect(await roundTrip(stray, 'x')).toBe('closed');
    const supervisorWrongPort = await tunnel.bridge('supervisor', port);
    expect(await roundTrip(supervisorWrongPort, 'x')).toBe('closed');
    expect(server.dialled).toHaveLength(dialled);
    expect(server.dialled.every((entry) => entry.host === '127.0.0.1')).toBe(
      true,
    );
  });

  it('refuses a computer that also publishes on a public address', async () => {
    const port = await echoServer();
    const computer = computerOn('dot-a', port);
    computer.Ports.push({
      IP: '0.0.0.0',
      PrivatePort: 4100,
      PublicPort: port + 1,
    });
    const server: FakeServer = {
      containers: [computer],
      inspect: {},
      images: {},
      dialled: [],
    };
    const fake = spawner((child) => relayOn(child, server));
    const tunnel = tunnelFor(fake.spawn);
    const bridge = await tunnel.bridge('dot-a', port);
    await tunnel.ready();
    expect(await roundTrip(bridge, 'x')).toBe('closed');
    expect(server.dialled).toEqual([]);
  });

  it('carries large transfers in both directions', async () => {
    const port = await echoServer();
    const server: FakeServer = {
      containers: [computerOn('dot-a', port)],
      inspect: {},
      images: {},
      dialled: [],
    };
    const fake = spawner((child) => relayOn(child, server));
    const tunnel = tunnelFor(fake.spawn);
    await tunnel.ready();
    const bridge = await tunnel.bridge('dot-a', port);
    const big = 'z'.repeat(3 * 1024 * 1024);
    expect((await roundTrip(bridge, big)).length).toBe(big.length);
  });

  it('answers inspect without the container’s environment', async () => {
    const server: FakeServer = {
      containers: [],
      inspect: {
        'opendots-computer-dot-a': {
          Name: '/opendots-computer-dot-a',
          Config: {
            Image: 'img',
            Labels: { a: 'b' },
            Env: ['COMPUTER_TOKEN=very-secret-token'],
          },
          State: { Running: true },
          HostConfig: {
            CapDrop: ['ALL'],
            Memory: 1,
            PidsLimit: 1,
            NetworkMode: 'bridge',
          },
          Mounts: [{ Type: 'volume', Source: 's', Destination: '/workspace' }],
        },
      },
      images: { 'opendots-computer:b6932d3-acp5': 'sha256:1' },
      dialled: [],
    };
    const fake = spawner((child) => relayOn(child, server));
    const tunnel = tunnelFor(fake.spawn);
    const answer = await tunnel.request('inspect', 'opendots-computer-dot-a');
    expect(JSON.stringify(answer)).not.toContain('very-secret-token');
    expect(answer).toMatchObject({
      facts: { image: 'img', running: true, capDrop: ['ALL'] },
    });
    expect(
      await tunnel.request('image', 'opendots-computer:b6932d3-acp5'),
    ).toEqual({ id: 'sha256:1' });
    expect(await tunnel.request('image', 'missing:tag')).toEqual({ id: null });
    expect(await tunnel.request('inspect', '../etc')).toEqual({
      error: 'refused',
    });
  });
});

describe('tunnel lifecycle', () => {
  it('restarts with growing backoff when ssh drops, and stops for good on stop', async () => {
    const fake = spawner((child) => child.stdout.write('FULLDOTS-READY\n'));
    const tunnel = tunnelFor(fake.spawn);
    await tunnel.ready();
    for (let drop = 0; drop < 3; drop++) {
      fake.calls.at(-1)!.child.kill();
      await new Promise((resolve) => setTimeout(resolve, 5));
      await tunnel.ready();
    }
    expect(fake.calls).toHaveLength(4);
    expect(tunnel.restarts).toBe(3);
    tunnel.stop();
    expect(fake.calls.at(-1)!.child.killed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fake.calls).toHaveLength(4);
    await expect(tunnel.ready()).rejects.toThrow('stopped');
  });

  it('never comes back when stopped while it is starting', async () => {
    const fake = spawner((child) => child.stdout.write('FULLDOTS-READY\n'));
    let release = () => undefined as void;
    const tunnel = tunnelFor(fake.spawn, {
      effectiveConfig: () =>
        new Promise<string>((resolve) => {
          release = () => resolve('');
        }),
    });
    const waiting = tunnel.ready().catch((error: unknown) => error);
    tunnel.stop();
    release();
    expect(await waiting).toBeInstanceOf(TunnelError);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.calls).toHaveLength(0);
    expect(tunnel.state).toBe('stopped');
  });

  it('does not relaunch ssh for an unknown host key until a check or the longest backoff', async () => {
    let now = 1_000_000;
    const fake = spawner((child) => {
      child.stderr.write(
        'No ED25519 host key is known for [127.0.0.1]:22 and you have requested strict checking.\r\nHost key verification failed.\r\n',
      );
      child.exit(255);
    });
    const tunnel = tunnelFor(fake.spawn, { now: () => now });
    const error = await tunnel.ready().catch((caught: unknown) => caught);
    expect((error as TunnelError).problem).toBe('host_key_unknown');
    expect((error as Error).message).toContain('ssh my-vps true');
    expect((error as Error).message).not.toContain('No ED25519');
    // Polls and connections while the problem stands start nothing.
    await expect(tunnel.ready()).rejects.toThrow('host key');
    const bridge = await tunnel.bridge('dot-a', 32768);
    expect(await roundTrip(bridge, 'x')).toBe('closed');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fake.calls).toHaveLength(1);
    // An explicit check tries again.
    await expect(tunnel.ready({ force: true })).rejects.toThrow('host key');
    expect(fake.calls).toHaveLength(2);
    // So does the next use after the longest backoff.
    now += 41;
    await expect(tunnel.ready()).rejects.toThrow('host key');
    expect(fake.calls).toHaveLength(3);
  });

  it('reports a missing ssh program instead of starting forever', async () => {
    const spawn: SshSpawner = () => {
      const child = new FakeChild();
      child.pid = undefined;
      setImmediate(() => {
        const error = Object.assign(new Error('spawn ssh ENOENT'), {
          code: 'ENOENT',
        });
        child.emit('error', error);
      });
      return child as unknown as SshChild;
    };
    const tunnel = tunnelFor(spawn);
    const error = await tunnel.ready().catch((caught: unknown) => caught);
    expect((error as TunnelError).problem).toBe('ssh_missing');
    expect((error as Error).message).toContain('COMPUTER_SSH_COMMAND');
    expect(tunnel.state).toBe('down');
  });

  it('reports a spawn that throws as a missing ssh program', async () => {
    const tunnel = tunnelFor(() => {
      throw new Error('EACCES');
    });
    await expect(tunnel.ready()).rejects.toMatchObject({
      problem: 'ssh_missing',
    });
  });

  it('refuses an alias that forwards ports, before ssh runs', async () => {
    const fake = spawner(() => undefined);
    const tunnel = tunnelFor(fake.spawn, {
      effectiveConfig: async () =>
        'user dots\nlocalforward 5432 [127.0.0.1]:5432\n',
    });
    await expect(tunnel.ready()).rejects.toMatchObject({
      problem: 'forwards_set',
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('says why the server cannot run the relay', async () => {
    for (const [line, problem] of [
      [
        'FULLDOTS-FAIL docker permission denied while trying to connect to the Docker daemon socket',
        'docker_denied',
      ],
      ['FULLDOTS-FAIL docker sh: docker: not found', 'docker_missing'],
      [
        'FULLDOTS-FAIL docker Cannot connect to the Docker daemon',
        'docker_down',
      ],
      ['FULLDOTS-FAIL image', 'image_missing'],
    ] as const) {
      const fake = spawner((child) => {
        child.stdout.write(`${line}\n`);
        child.exit(3);
      });
      const tunnel = tunnelFor(fake.spawn);
      await expect(tunnel.ready()).rejects.toMatchObject({ problem });
      tunnel.stop();
    }
  });

  it('gives each owner its own local port and records who owns it', async () => {
    const fake = spawner((child) => child.stdout.write('FULLDOTS-READY\n'));
    const tunnel = tunnelFor(fake.spawn);
    const a = await tunnel.bridge('dot-a', 32768);
    const b = await tunnel.bridge('dot-b', 32768);
    expect(a).not.toBe(b);
    expect(tunnel.bridgeAt(a)).toEqual({ owner: 'dot-a', remotePort: 32768 });
    expect(tunnel.bridgeAt(b)).toEqual({ owner: 'dot-b', remotePort: 32768 });
    const moved = await tunnel.bridge('dot-a', 32800);
    expect(tunnel.bridgeAt(a)).toBeUndefined();
    expect(tunnel.bridgeAt(moved)?.owner).toBe('dot-a');
    tunnel.release('dot-b');
    expect(tunnel.bridgeAt(b)).toBeUndefined();
  });

  it('kills ssh -G when it hangs', async () => {
    const child = new FakeChild();
    const read = effectiveSshConfig({}, () => child as unknown as SshChild, 20);
    expect(await read('my-vps')).toBe('');
    expect(child.killed).toBe(true);
  });
});
