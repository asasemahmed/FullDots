import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ComputerService } from '../src/server/computer-service.js';
import { ComputerError } from '../src/server/computer-errors.js';
import { RemoteStore } from '../src/server/remote-store.js';
import {
  REMOTE_IMAGES,
  RemoteComputers,
  removeCommand,
  unsafeReason,
  type ContainerFacts,
} from '../src/server/remote-computers.js';
import {
  RemoteTunnel,
  TunnelError,
  type TunnelOptions,
} from '../src/server/remote-tunnel.js';
import {
  classifySsh,
  sshArgs,
  timeoutOptions,
  validAlias,
  type SshChild,
  type SshSpawner,
} from '../src/server/remote-ssh.js';
import { RemoteSetup, contextTar } from '../src/server/remote-setup.js';

const stores: WorkspaceStore[] = [];
const tunnels: RemoteTunnel[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const tunnel of tunnels.splice(0)) tunnel.stop();
});

/** A fake ssh process: what FullDots would spawn, with no network and no ssh. */
class FakeChild extends EventEmitter {
  pid = Math.floor(Math.random() * 10000) + 1;
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
    setImmediate(() => this.emit('exit', code));
  }
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

const tunnelOptions = (spawn: SshSpawner): TunnelOptions => ({
  spawn,
  effectiveConfig: async () => 'connecttimeout none\nserveraliveinterval 0\n',
  freePort: async () => 47000,
  backoffMs: 5,
  maxBackoffMs: 40,
  readyMs: 500,
});

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

  it('always puts batch mode and strict host keys first and the alias after --', () => {
    const args = sshArgs(
      'my-vps',
      { configFile: '/tmp/test_config' },
      { extra: ['-T'], remote: 'true' },
    );
    expect(args.slice(0, 6)).toEqual([
      '-F',
      '/tmp/test_config',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
    ]);
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

describe('tunnel', () => {
  it('starts one ssh with a loopback SOCKS forward and the fixed options', async () => {
    const fake = spawner((child) => child.stdout.write('FULLDOTS-READY\n'));
    const tunnel = new RemoteTunnel('my-vps', tunnelOptions(fake.spawn));
    tunnels.push(tunnel);
    await tunnel.ready();
    expect(fake.calls).toHaveLength(1);
    const { args } = fake.calls[0]!;
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('StrictHostKeyChecking=yes');
    expect(args).toContain('ConnectTimeout=10');
    expect(args).toContain('ExitOnForwardFailure=yes');
    expect(args[args.indexOf('-D') + 1]).toBe('127.0.0.1:47000');
    const dashdash = args.indexOf('--');
    expect(args[dashdash + 1]).toBe('my-vps');
    expect(args.filter((arg) => arg === 'my-vps')).toHaveLength(1);
    expect(tunnel.state).toBe('up');
  });

  it('restarts with growing backoff when ssh drops, and stops for good on stop', async () => {
    const fake = spawner((child) => child.stdout.write('FULLDOTS-READY\n'));
    const tunnel = new RemoteTunnel('my-vps', tunnelOptions(fake.spawn));
    tunnels.push(tunnel);
    await tunnel.ready();
    const started: number[] = [];
    for (let drop = 0; drop < 3; drop++) {
      fake.calls.at(-1)!.child.kill();
      const before = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 5));
      await tunnel.ready();
      started.push(Date.now() - before);
    }
    expect(fake.calls).toHaveLength(4);
    expect(tunnel.restarts).toBe(3);
    tunnel.stop();
    expect(fake.calls.at(-1)!.child.killed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fake.calls).toHaveLength(4);
    await expect(tunnel.ready()).rejects.toThrow('stopped');
  });

  it('refuses an unknown host key and does not retry on its own', async () => {
    const fake = spawner((child) => {
      child.stderr.write(
        'No ED25519 host key is known for [127.0.0.1]:22 and you have requested strict checking.\r\nHost key verification failed.\r\n',
      );
      child.exit(255);
    });
    const tunnel = new RemoteTunnel('my-vps', tunnelOptions(fake.spawn));
    tunnels.push(tunnel);
    const error = await tunnel.ready().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TunnelError);
    expect((error as TunnelError).problem).toBe('host_key_unknown');
    expect((error as Error).message).toContain('ssh my-vps true');
    expect((error as Error).message).not.toContain('No ED25519');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fake.calls).toHaveLength(1);
  });

  it('gives each owner its own local port and records who owns it', async () => {
    const fake = spawner((child) => child.stdout.write('FULLDOTS-READY\n'));
    const tunnel = new RemoteTunnel('my-vps', tunnelOptions(fake.spawn));
    tunnels.push(tunnel);
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

  it('closes a connection at once when the tunnel is down', async () => {
    const fake = spawner((child) => {
      child.stderr.write(
        'ssh: connect to host x port 22: Connection refused\n',
      );
      child.exit(255);
    });
    const tunnel = new RemoteTunnel('my-vps', {
      ...tunnelOptions(fake.spawn),
      backoffMs: 10_000,
    });
    tunnels.push(tunnel);
    await tunnel.ready().catch(() => undefined);
    const port = await tunnel.bridge('dot-a', 32768);
    const started = Date.now();
    await expect(fetch(`http://127.0.0.1:${port}/control`)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('server secrets', () => {
  it('stores both tokens sealed and opens them only with the key', () => {
    const db = new DatabaseSync(':memory:');
    const key = randomBytes(32);
    const store = new RemoteStore(db, key);
    const secrets = store.secrets('my-vps');
    expect(secrets.supervisorToken).toMatch(/^[0-9a-f]{64}$/);
    const row = db
      .prepare('SELECT * FROM remote_computer_servers')
      .get() as Record<string, string>;
    expect(JSON.stringify(row)).not.toContain(secrets.supervisorToken);
    expect(JSON.stringify(row)).not.toContain(secrets.computerToken);
    expect(store.secrets('my-vps')).toEqual(secrets);
    expect(() =>
      new RemoteStore(db, randomBytes(32)).secrets('my-vps'),
    ).toThrow('could not be decrypted');
  });
});

describe('unsafe computers', () => {
  const safe: ContainerFacts = {
    image: REMOTE_IMAGES.browser,
    labels: {
      'openbot.supervisor': 'true',
      'openbot.namespace': 'opendots',
      'openbot.bot-id': 'dot-a',
      'fulldots.computer.kind': 'browser',
    },
    running: true,
    capDrop: ['ALL'],
    securityOpt: ['no-new-privileges:true'],
    memory: 2147483648,
    pidsLimit: 512,
    privileged: false,
    networkMode: 'bridge',
    portBindings: { '4100/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
    ports: { '4100/tcp': [{ HostIp: '127.0.0.1', HostPort: '32768' }] },
  };
  const expected = {
    image: REMOTE_IMAGES.browser,
    kind: 'browser' as const,
    namespace: 'opendots',
    dotId: 'dot-a',
  };
  it('accepts the hardened container the supervisor makes', () => {
    expect(unsafeReason(safe, expected)).toBeUndefined();
  });
  it.each([
    [
      { portBindings: { '4100/tcp': [{ HostIp: '0.0.0.0', HostPort: '' }] } },
      'publishes a port on 0.0.0.0',
    ],
    [
      { ports: { '4100/tcp': [{ HostIp: '', HostPort: '1' }] } },
      'every address',
    ],
    [{ image: 'opendots-computer:latest' }, 'instead of'],
    [{ capDrop: [] }, 'capabilities'],
    [{ securityOpt: [] }, 'new privileges'],
    [{ memory: 0 }, 'memory'],
    [{ pidsLimit: 0 }, 'process limit'],
    [{ privileged: true }, 'privileged'],
    [{ networkMode: 'host' }, 'network'],
    [{ labels: { ...safe.labels, 'openbot.bot-id': 'dot-b' } }, 'another Dot'],
    [{ labels: {} }, 'not created by'],
  ])('refuses %j', (patch, reason) => {
    expect(unsafeReason({ ...safe, ...patch }, expected)).toContain(reason);
  });
});

/** A tunnel stand-in for the service tests: answers helper requests from a table. */
class FakeTunnel {
  state: RemoteTunnel['state'] = 'up';
  problem?: RemoteTunnel['problem'];
  fail?: TunnelError;
  answers = new Map<string, string[]>();
  ports = new Map<number, { owner: string; remotePort: number }>();
  next = 41000;
  readyCalls = 0;
  constructor(readonly alias: string) {}
  async ready() {
    this.readyCalls++;
    if (this.fail) throw this.fail;
  }
  async request(verb: string, arg = 'x') {
    if (this.fail) throw this.fail;
    return this.answers.get(`${verb} ${arg}`) ?? ['MISSING'];
  }
  async bridge(owner: string, remotePort: number) {
    for (const [port, entry] of this.ports)
      if (entry.owner === owner && entry.remotePort === remotePort) return port;
    for (const [port, entry] of this.ports)
      if (entry.owner === owner) this.ports.delete(port);
    const port = this.next++;
    this.ports.set(port, { owner, remotePort });
    return port;
  }
  bridgeAt(port: number) {
    return this.ports.get(port);
  }
  release(owner: string) {
    for (const [port, entry] of this.ports)
      if (entry.owner === owner) this.ports.delete(port);
  }
  stop() {
    this.state = 'stopped';
  }
}

const facts = (dotId: string, kind: 'browser' | 'desktop' = 'browser') =>
  JSON.stringify({
    image: REMOTE_IMAGES[kind],
    labels: {
      'openbot.supervisor': 'true',
      'openbot.namespace': 'opendots',
      'openbot.bot-id': dotId,
      'fulldots.computer.kind': kind,
    },
    running: true,
    health: 'healthy',
    capDrop: ['ALL'],
    securityOpt: ['no-new-privileges:true'],
    memory: 1,
    pidsLimit: 1,
    privileged: false,
    networkMode: 'bridge',
    portBindings: { '4100/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
    ports: { '4100/tcp': [{ HostIp: '127.0.0.1', HostPort: '32768' }] },
  });

function readyServer(tunnel: FakeTunnel) {
  tunnel.answers.set('docker x', ['28.0.4', 'EXIT 0']);
  for (const image of Object.values(REMOTE_IMAGES))
    tunnel.answers.set(`image ${image}`, ['sha256:abc']);
  tunnel.answers.set('inspect fulldots-computer-supervisor', [
    JSON.stringify({
      image: REMOTE_IMAGES.supervisor,
      running: true,
      portBindings: { '4300/tcp': [{ HostIp: '127.0.0.1', HostPort: '4312' }] },
      ports: { '4300/tcp': [{ HostIp: '127.0.0.1', HostPort: '4312' }] },
    }),
  ]);
}

function remoteFixture(options: { local?: boolean } = {}) {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  stores.push(workspace);
  const id = workspace.dots()[0]!.id;
  const store = new RemoteStore(new DatabaseSync(':memory:'), randomBytes(32));
  const fakes = new Map<string, FakeTunnel>();
  const remote = new RemoteComputers({
    store,
    computers: workspace.computers,
    tunnel: (alias) => {
      const fake = fakes.get(alias) ?? new FakeTunnel(alias);
      fakes.set(alias, fake);
      return fake as unknown as RemoteTunnel;
    },
  });
  const calls: string[] = [];
  let computers: {
    botId: string;
    container: string;
    status: string;
    port?: number;
    url?: string;
  }[] = [];
  let control: () => Response = () =>
    Response.json({
      holder: 'bot',
      requested: false,
      transitioning: false,
      resumeSnapshotRequired: false,
    });
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(
      `${url.port} ${url.pathname} ${String((init?.headers as Record<string, string>)?.Authorization ?? '')}`,
    );
    if (url.pathname === '/computers') return Response.json({ computers });
    if (url.pathname.endsWith('/ensure')) {
      const state = {
        botId: id,
        container: `opendots-computer-${id}`,
        status: 'running',
        port: 32768,
        url: 'http://127.0.0.1:32768',
      };
      computers = [state];
      return Response.json(state);
    }
    if (url.pathname === '/control') return control();
    return Response.json({
      ok: true,
      echoed: String(
        (init?.headers as Record<string, string>)?.Authorization ?? '',
      ),
    });
  };
  const service = new ComputerService(
    workspace,
    {
      baseUrl: 'https://example.com',
      voiceName: 'voice',
      ...(options.local
        ? {
            computerSupervisorUrl: 'http://127.0.0.1:4312',
            computerSupervisorToken: 'local-supervisor-secret',
            computerToken: 'local-master-secret',
          }
        : {}),
    },
    () => false,
    transport,
    1000,
  );
  service.setRemote(remote);
  workspace.computers.patch(id, {
    enabled: true,
    browser: true,
    files: true,
    shell: true,
  });
  const fake = (alias: string) => {
    remote.tunnel(alias);
    return fakes.get(alias)!;
  };
  return {
    workspace,
    id,
    store,
    remote,
    service,
    calls,
    fake,
    setComputers: (list: typeof computers) => {
      computers = list;
    },
    setControl: (fn: () => Response) => {
      control = fn;
    },
  };
}

describe('computers on the owner’s server', () => {
  it('reports the first failing check, in order', async () => {
    const f = remoteFixture();
    f.store.setDefaults('remote', undefined);
    expect((await f.service.status(f.id)).remote?.check).toBe('alias_not_set');

    f.store.setDefaults('remote', 'my-vps');
    const tunnel = f.fake('my-vps');
    tunnel.fail = new TunnelError(
      'host_key_unknown',
      'ssh does not know the host key of my-vps.',
    );
    f.remote.forget();
    let status = await f.service.status(f.id);
    expect(status.remote?.check).toBe('ssh_failed');
    expect(status.remote?.message).toContain('host key');

    tunnel.fail = undefined;
    tunnel.answers.set('docker x', [
      'permission denied while trying to connect to the Docker daemon socket',
      'EXIT 1',
    ]);
    f.remote.forget();
    status = await f.service.status(f.id);
    expect(status.remote?.check).toBe('docker_unreachable');
    expect(status.remote?.message).toContain('docker group');

    tunnel.answers.set('docker x', ['28.0.4', 'EXIT 0']);
    f.remote.forget();
    expect((await f.service.status(f.id)).remote?.check).toBe('images_missing');

    for (const image of Object.values(REMOTE_IMAGES))
      tunnel.answers.set(`image ${image}`, ['sha256:abc']);
    f.remote.forget();
    expect((await f.service.status(f.id)).remote?.check).toBe(
      'supervisor_not_running',
    );

    readyServer(tunnel);
    f.remote.forget();
    status = await f.service.status(f.id);
    expect(status.remote?.check).toBe('computer_stopped');
    expect(status.state).toBe('stopped');

    f.setComputers([
      {
        botId: f.id,
        container: `opendots-computer-${f.id}`,
        status: 'running',
        port: 32768,
        url: 'http://127.0.0.1:32768',
      },
    ]);
    tunnel.answers.set(`inspect opendots-computer-${f.id}`, [
      facts(f.id).replace('"privileged":false', '"privileged":true'),
    ]);
    status = await f.service.status(f.id);
    expect(status.remote?.check).toBe('computer_unsafe');
    expect(status.remote?.command).toBe(
      `ssh my-vps docker rm -f opendots-computer-${f.id}`,
    );

    tunnel.answers.set(`inspect opendots-computer-${f.id}`, [facts(f.id)]);
    f.setControl(() => new Response('starting', { status: 503 }));
    expect((await f.service.status(f.id)).remote?.check).toBe('not_ready');

    f.setControl(() =>
      Response.json({
        holder: 'bot',
        requested: false,
        transitioning: false,
        resumeSnapshotRequired: false,
      }),
    );
    status = await f.service.status(f.id);
    expect(status.remote?.check).toBe('ready');
    expect(status.state).toBe('running');
    expect(status.server).toEqual({
      where: 'remote',
      alias: 'my-vps',
      own: false,
    });
  });

  it('refuses an unsafe computer before every use and never repairs it', async () => {
    const f = remoteFixture();
    f.store.setDefaults('remote', 'my-vps');
    const tunnel = f.fake('my-vps');
    readyServer(tunnel);
    f.setComputers([
      {
        botId: f.id,
        container: `opendots-computer-${f.id}`,
        status: 'running',
        port: 32768,
        url: 'http://127.0.0.1:32768',
      },
    ]);
    tunnel.answers.set(`inspect opendots-computer-${f.id}`, [facts(f.id)]);
    await f.service.action(f.id, 'read', {});
    tunnel.answers.set(`inspect opendots-computer-${f.id}`, [
      facts(f.id).replace(
        '"HostIp":"127.0.0.1","HostPort":""',
        '"HostIp":"0.0.0.0","HostPort":""',
      ),
    ]);
    const before = f.calls.length;
    await expect(f.service.action(f.id, 'read', {})).rejects.toThrow(
      /will not use this computer on my-vps: it publishes a port on 0\.0\.0\.0/,
    );
    // Only the supervisor listing was asked; nothing reached the computer and nothing was removed.
    expect(
      f.calls.slice(before).every((call) => call.includes(' /computers ')),
    ).toBe(true);
  });

  it('never falls back to this machine when the server is unreachable', async () => {
    const f = remoteFixture({ local: true });
    f.store.setDefaults('remote', 'my-vps');
    const tunnel = f.fake('my-vps');
    tunnel.fail = new TunnelError(
      'unreachable',
      'my-vps did not answer over ssh. FullDots keeps trying to reconnect.',
    );
    const error = await f.service
      .action(f.id, 'read', {}, 'agent')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ComputerError);
    expect((error as ComputerError).status).toBe(503);
    expect((error as Error).message).toContain('my-vps did not answer');
    expect(f.calls).toEqual([]);
    await expect(f.service.start(f.id)).rejects.toThrow(
      'my-vps did not answer',
    );
    expect(f.calls).toEqual([]);
  });

  it('uses the server’s own tokens and never shows them', async () => {
    const f = remoteFixture({ local: true });
    f.store.setDefaults('remote', 'my-vps');
    readyServer(f.fake('my-vps'));
    const secrets = f.store.secrets('my-vps');
    f.setComputers([
      {
        botId: f.id,
        container: `opendots-computer-${f.id}`,
        status: 'running',
        port: 32768,
        url: 'http://127.0.0.1:32768',
      },
    ]);
    f.fake('my-vps').answers.set(`inspect opendots-computer-${f.id}`, [
      facts(f.id),
    ]);
    const status = await f.service.status(f.id);
    expect(
      f.calls.some((call) =>
        call.includes(`Bearer ${secrets.supervisorToken}`),
      ),
    ).toBe(true);
    expect(
      f.calls.some((call) => call.includes('local-supervisor-secret')),
    ).toBe(false);
    const result = await f.service.action(f.id, 'read', {});
    const shown = JSON.stringify({
      status,
      result,
      defaults: f.remote.defaults(),
    });
    expect(shown).not.toContain(secrets.supervisorToken);
    expect(shown).not.toContain(secrets.computerToken);
  });

  it('binds each tunnel port to one Dot and refuses another Dot’s port', async () => {
    const f = remoteFixture();
    f.store.setDefaults('remote', 'my-vps');
    const tunnel = f.fake('my-vps');
    readyServer(tunnel);
    const other = f.workspace.createDot(
      f.workspace.spaces()[0]!.id,
      'Other',
      '',
      false,
      false,
    );
    tunnel.answers.set(`inspect opendots-computer-${f.id}`, [facts(f.id)]);
    tunnel.answers.set(`inspect opendots-computer-${other.id}`, [
      facts(other.id),
    ]);
    const mine = await f.remote.origin(
      'my-vps',
      f.id,
      { port: 32768 },
      'browser',
    );
    const theirs = await f.remote.origin(
      'my-vps',
      other.id,
      { port: 32768 },
      'browser',
    );
    expect(mine).not.toBe(theirs);
    const minePort = Number(new URL(mine).port);
    expect(f.remote.ownsPort('my-vps', f.id, minePort)).toBe(true);
    expect(f.remote.ownsPort('my-vps', other.id, minePort)).toBe(false);
    // A bridge that somehow answers for another Dot is refused.
    tunnel.bridge = async () => minePort;
    await expect(
      f.remote.origin('my-vps', other.id, { port: 32999 }, 'browser'),
    ).rejects.toThrow('not bound to this Dot');
    // Only the server's loopback is accepted from the supervisor.
    await expect(
      f.remote.origin(
        'my-vps',
        f.id,
        { port: 32768, url: 'http://10.0.0.5:32768' },
        'browser',
      ),
    ).rejects.toThrow('not bound');
  });

  it('moves a Dot only when nothing is left on the old server', async () => {
    const f = remoteFixture();
    f.store.setDefaults('remote', 'old-vps');
    const old = f.fake('old-vps');
    readyServer(old);
    f.setComputers([
      { botId: f.id, container: `opendots-computer-${f.id}`, status: 'exited' },
    ]);
    await expect(f.service.moveServer(f.id, 'new-vps')).rejects.toThrow(
      `ssh old-vps docker rm -f opendots-computer-${f.id}`,
    );
    expect(f.workspace.computers.server(f.id)).toBeUndefined();

    f.setComputers([]);
    expect(await f.service.moveServer(f.id, 'new-vps')).toEqual({
      moved: true,
    });
    expect(f.workspace.computers.server(f.id)).toBe('new-vps');

    // The old server is down: the move goes ahead and says what may be left there.
    f.fake('new-vps').fail = new TunnelError(
      'unreachable',
      'new-vps did not answer over ssh.',
    );
    const moved = await f.service.moveServer(f.id, null);
    expect(moved.moved).toBe(true);
    expect(moved.leftover).toEqual([
      `ssh new-vps docker rm -f opendots-computer-${f.id}`,
    ]);
    expect(f.workspace.computers.server(f.id)).toBeUndefined();
    await expect(
      f.service.moveServer(f.id, '-oProxyCommand=x'),
    ).rejects.toThrow('ssh config');
  });

  it('stops the tunnels no Dot uses any more', async () => {
    const f = remoteFixture();
    f.store.setDefaults('remote', 'old-vps');
    const old = f.fake('old-vps');
    readyServer(old);
    f.setComputers([]);
    await f.service.setDefaults('local');
    expect(old.state).toBe('stopped');
    expect(f.remote.open()).toEqual([]);
  });

  it('shows the removal command for a computer on this machine too', () => {
    expect(removeCommand({ where: 'local' }, 'opendots', 'dot-a')).toBe(
      'docker rm -f opendots-computer-dot-a',
    );
  });
});

describe('server setup', () => {
  function setupFixture(
    onRun: (args: readonly string[], stdin: string, child: FakeChild) => void,
  ) {
    const store = new RemoteStore(
      new DatabaseSync(':memory:'),
      randomBytes(32),
    );
    const fake = spawner((child, args) => {
      if (args.includes('-G')) {
        child.stdout.write('connecttimeout none\nserveraliveinterval 0\n');
        child.exit(0);
        return;
      }
      let stdin = '';
      child.stdin.on(
        'data',
        (chunk: Buffer) => (stdin += chunk.toString('latin1')),
      );
      child.stdin.on('end', () => onRun(args, stdin, child));
    });
    const remote = new RemoteComputers({
      store,
      computers: { server: () => undefined },
      spawn: fake.spawn,
      tunnel: (alias) => {
        const tunnel = new FakeTunnel(alias);
        return tunnel as unknown as RemoteTunnel;
      },
    });
    const setup = new RemoteSetup({
      remote,
      enabled: true,
      fetch: async () => Response.json({ status: 'ok' }),
      sleep: async () => undefined,
    });
    return { store, setup, fake };
  }

  it('runs nothing until the exact commands are approved', async () => {
    const { setup, fake } = setupFixture((_, __, child) => child.exit(0));
    const plans = await setup.plans('my-vps');
    expect(plans.map((plan) => plan.step)).toEqual([
      'check-alias',
      'check-docker',
      'build-images',
      'start-supervisor',
    ]);
    for (const plan of plans)
      for (const command of plan.commands) {
        expect(command).toContain('BatchMode=yes');
        expect(command).toContain('StrictHostKeyChecking=yes');
        expect(command).toMatch(/ -- my-vps /);
      }
    await expect(
      setup.start('my-vps', 'check-alias', ['ssh my-vps true']),
    ).rejects.toThrow('do not match');
    await expect(
      setup.start('-oProxyCommand=x', 'check-alias', []),
    ).rejects.toThrow();
    expect(fake.calls.filter((call) => !call.args.includes('-G'))).toHaveLength(
      0,
    );
    const job = await setup.start('my-vps', 'check-alias', plans[0]!.commands);
    expect((await setup.settled(job.id, 2000))?.state).toBe('done');
  });

  it('sends the tokens on stdin only and keeps them out of the output', async () => {
    const { store, setup } = setupFixture((args, stdin, child) => {
      // A server that echoes what it got must still not leak a token into the job output.
      child.stdout.write(`args=${args.join(' ')}\nstdin=${stdin}\n`);
      child.exit(0);
    });
    const plans = await setup.plans('my-vps');
    const start = plans.find((plan) => plan.step === 'start-supervisor')!;
    expect(start.commands[1]).toContain('127.0.0.1:4312:4300');
    expect(start.commands[1]).toContain('--env-file /dev/stdin');
    const job = await setup.start('my-vps', 'start-supervisor', start.commands);
    const done = await setup.settled(job.id, 5000);
    expect(done?.state).toBe('done');
    const { supervisorToken, computerToken } = store.secrets('my-vps');
    expect(done?.output).toContain('SUPERVISOR_TOKEN=[redacted]');
    expect(done?.output).not.toContain(supervisorToken);
    expect(done?.output).not.toContain(computerToken);
    expect(start.commands.join(' ')).not.toContain(supervisorToken);
  });

  it('packs only the build context as a tar', () => {
    const tar = contextTar(process.cwd());
    expect(tar.length % 512).toBe(0);
    const names: string[] = [];
    for (let offset = 0; offset + 512 <= tar.length;) {
      const name = tar
        .subarray(offset, offset + 100)
        .toString('utf8')
        .replace(/\0.*$/s, '');
      if (!name) break;
      names.push(name);
      const size =
        parseInt(
          tar.subarray(offset + 124, offset + 136).toString('ascii'),
          8,
        ) || 0;
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    expect(names).toContain('deployment/computers/supervisor.Dockerfile');
    expect(names).toContain('deployment/computers/desktop/worker.sh');
    expect(names.every((name) => name.startsWith('deployment/'))).toBe(true);
  });
});

describe('pinned images', () => {
  it('builds the same tags and OpenBot revision as compose.computers.yml', async () => {
    const { readFileSync } = await import('node:fs');
    const compose = readFileSync('compose.computers.yml', 'utf8');
    for (const tag of Object.values(REMOTE_IMAGES))
      expect(compose).toContain(tag);
    const { OPENBOT_CONTEXT } =
      await import('../src/server/remote-computers.js');
    expect(compose).toContain(OPENBOT_CONTEXT);
  });
});

describe('computer tools for a Dot on a server', () => {
  it('counts computers as configured when they run on the owner’s server', () => {
    const f = remoteFixture();
    expect(f.service.configured).toBe(false);
    f.store.setDefaults('remote', 'my-vps');
    expect(f.service.configured).toBe(true);
    expect(f.service.configuredFor(f.id)).toBe(true);
    f.store.setDefaults('local', undefined);
    f.workspace.computers.setServer(f.id, 'own-vps');
    expect(f.service.configured).toBe(true);
    expect(f.service.target(f.id)).toEqual({
      where: 'remote',
      alias: 'own-vps',
    });
  });
});
