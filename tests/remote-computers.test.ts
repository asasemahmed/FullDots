import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ComputerService } from '../src/server/computer-service.js';
import { ComputerError } from '../src/server/computer-errors.js';
import { RemoteStore } from '../src/server/remote-store.js';
import {
  REMOTE_IMAGES,
  RemoteComputers,
  SERVER_ID_LABEL,
  removeCommand,
  supervisorUnsafeReason,
  unsafeReason,
  type ContainerFacts,
} from '../src/server/remote-computers.js';
import { TunnelError, type RemoteTunnel } from '../src/server/remote-tunnel.js';
import type { SshChild, SshSpawner } from '../src/server/remote-ssh.js';
import { RemoteSetup, contextTar } from '../src/server/remote-setup.js';

const stores: WorkspaceStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

/** A fake ssh process for the set-up steps: no network and no ssh. */
class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill() {
    this.exit(255);
    return true;
  }
  /** Ends like a real process: 'exit' first, then 'close' once the output streams end. */
  exit(code: number) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    setImmediate(() => {
      this.emit('exit', code);
      setImmediate(() => {
        this.stdout.end();
        this.stderr.end();
        this.emit('close', code);
      });
    });
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

describe('server secrets', () => {
  it('stores both tokens sealed and opens them only with the key', () => {
    const db = new DatabaseSync(':memory:');
    const store = new RemoteStore(db, randomBytes(32));
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

  it('shows the supervisor settings once per set of tokens', () => {
    const store = new RemoteStore(
      new DatabaseSync(':memory:'),
      randomBytes(32),
    );
    const first = store.revealOnce('my-vps');
    expect(() => store.revealOnce('my-vps')).toThrow('already shown');
    const fresh = store.reset('my-vps');
    expect(fresh.supervisorToken).not.toBe(first.supervisorToken);
    expect(store.revealOnce('my-vps')).toEqual(fresh);
  });

  it('takes the owner’s own tokens only when they are long and plain', () => {
    const store = new RemoteStore(
      new DatabaseSync(':memory:'),
      randomBytes(32),
    );
    expect(() =>
      store.importTokens('my-vps', {
        supervisorToken: 'short',
        computerToken: 'x'.repeat(40),
      }),
    ).toThrow('32 to 256');
    expect(() =>
      store.importTokens('my-vps', {
        supervisorToken: `${'a'.repeat(40)}\nPORT=1`,
        computerToken: 'x'.repeat(40),
      }),
    ).toThrow();
    store.importTokens('my-vps', {
      supervisorToken: 'a'.repeat(40),
      computerToken: 'b'.repeat(40),
    });
    expect(store.secrets('my-vps').supervisorToken).toBe('a'.repeat(40));
  });

  it('gives each alias its own server id and finds the alias from it', () => {
    const store = new RemoteStore(
      new DatabaseSync(':memory:'),
      randomBytes(32),
    );
    const a = store.serverId('vps-a');
    const b = store.serverId('vps-b');
    expect(a).not.toBe(b);
    expect(store.serverId('vps-a')).toBe(a);
    expect(store.aliasForServerId(b)).toBe('vps-b');
    store.reset('vps-a');
    expect(store.serverId('vps-a')).toBe(a);
  });
});

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
  capAdd: null,
  securityOpt: ['no-new-privileges:true'],
  memory: 2147483648,
  pidsLimit: 512,
  privileged: false,
  networkMode: 'bridge',
  pidMode: '',
  ipcMode: 'private',
  usernsMode: '',
  devices: [],
  runtime: 'runc',
  portBindings: { '4100/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
  ports: { '4100/tcp': [{ HostIp: '127.0.0.1', HostPort: '32768' }] },
  mounts: [
    {
      type: 'volume',
      source: '/var/lib/docker/volumes/opendots-profile-dot-a/_data',
      destination: '/profiles',
    },
    {
      type: 'volume',
      source: '/var/lib/docker/volumes/opendots-workspace-dot-a/_data',
      destination: '/workspace',
    },
  ],
};

describe('unsafe computers', () => {
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
    [{ capDrop: [] }, 'drop all capabilities'],
    [{ capAdd: ['NET_ADMIN'] }, 'adds capabilities'],
    [{ securityOpt: [] }, 'new privileges'],
    [
      { securityOpt: ['no-new-privileges:true', 'seccomp=unconfined'] },
      'security profile',
    ],
    [
      { securityOpt: ['no-new-privileges:true', 'apparmor=unconfined'] },
      'security profile',
    ],
    [{ memory: 0 }, 'memory'],
    [{ pidsLimit: 0 }, 'process limit'],
    [{ privileged: true }, 'privileged'],
    [{ networkMode: 'host' }, 'host network'],
    [{ networkMode: 'container:abc' }, 'network'],
    [{ networkMode: 'my-net' }, 'network'],
    [{ pidMode: 'host' }, 'process namespace'],
    [{ ipcMode: 'host' }, 'IPC'],
    [{ usernsMode: 'host' }, 'user namespace'],
    [{ devices: [{ PathOnHost: '/dev/kvm' }] }, 'devices'],
    [{ runtime: 'nvidia' }, 'runtime'],
    [
      {
        mounts: [{ type: 'bind', source: '/etc', destination: '/host-etc' }],
      },
      'mounts /etc',
    ],
    [
      {
        mounts: [
          {
            type: 'bind',
            source: '/var/run/docker.sock',
            destination: '/var/run/docker.sock',
          },
        ],
      },
      'docker.sock',
    ],
    [
      { mounts: [{ type: 'volume', source: 'x', destination: '/root' }] },
      'mount',
    ],
    [{ labels: { ...safe.labels, 'openbot.bot-id': 'dot-b' } }, 'another Dot'],
    [{ labels: {} }, 'not created by'],
  ])('refuses %j', (patch, reason) => {
    expect(unsafeReason({ ...safe, ...patch }, expected)).toContain(reason);
  });

  const supervisor: ContainerFacts = {
    ...safe,
    image: REMOTE_IMAGES.supervisor,
    labels: { [SERVER_ID_LABEL]: 'abc' },
    portBindings: { '4300/tcp': [{ HostIp: '127.0.0.1', HostPort: '4312' }] },
    ports: { '4300/tcp': [{ HostIp: '127.0.0.1', HostPort: '4312' }] },
    mounts: [
      {
        type: 'bind',
        source: '/var/run/docker.sock',
        destination: '/var/run/docker.sock',
      },
    ],
  };
  it('accepts the supervisor the setup step starts', () => {
    expect(supervisorUnsafeReason(supervisor)).toBeUndefined();
  });
  it.each([
    [{ networkMode: 'host' }, 'host network'],
    [
      { ports: { '4300/tcp': [{ HostIp: '0.0.0.0', HostPort: '4312' }] } },
      '0.0.0.0',
    ],
    [
      {
        portBindings: {
          '4300/tcp': [{ HostIp: '127.0.0.1', HostPort: '4399' }],
        },
        ports: { '4300/tcp': [{ HostIp: '127.0.0.1', HostPort: '4399' }] },
      },
      'not published on 127.0.0.1:4312',
    ],
    [{ image: 'someone/supervisor:latest' }, 'instead of'],
    [{ capAdd: ['SYS_ADMIN'] }, 'adds capabilities'],
    [
      {
        mounts: [
          ...(supervisor.mounts as object[]),
          { type: 'bind', source: '/', destination: '/host' },
        ],
      },
      'mounts /',
    ],
    [{ memory: 0 }, 'memory'],
  ])('refuses a supervisor with %j', (patch, reason) => {
    expect(supervisorUnsafeReason({ ...supervisor, ...patch })).toContain(
      reason,
    );
  });
});

/** A tunnel stand-in for the service tests: answers relay requests from a table. */
class FakeTunnel {
  state: RemoteTunnel['state'] = 'up';
  problem?: RemoteTunnel['problem'];
  fail?: TunnelError;
  answers = new Map<string, unknown>();
  ports = new Map<number, { owner: string; remotePort: number }>();
  next = 41000;
  forced = 0;
  constructor(readonly alias: string) {}
  async ready(options: { force?: boolean } = {}) {
    if (options.force) this.forced++;
    if (this.fail) throw this.fail;
  }
  async request(verb: string, arg: string) {
    if (this.fail) throw this.fail;
    return (
      this.answers.get(`${verb} ${arg}`) ??
      (verb === 'image' ? { id: null } : { facts: null })
    );
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

const computerFacts = (
  dotId: string,
  kind: 'browser' | 'desktop' = 'browser',
  port = 32768,
): ContainerFacts => ({
  ...safe,
  image: REMOTE_IMAGES[kind],
  labels: {
    'openbot.supervisor': 'true',
    'openbot.namespace': 'opendots',
    'openbot.bot-id': dotId,
    'fulldots.computer.kind': kind,
  },
  ports: { '4100/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] },
  mounts: [
    { type: 'volume', source: `p-${dotId}`, destination: '/profiles' },
    { type: 'volume', source: `w-${dotId}`, destination: '/workspace' },
  ],
});

function readyServer(tunnel: FakeTunnel, store: RemoteStore) {
  tunnel.fail = undefined;
  for (const image of [REMOTE_IMAGES.browser, REMOTE_IMAGES.desktop])
    tunnel.answers.set(`image ${image}`, { id: 'sha256:abc' });
  tunnel.answers.set('inspect fulldots-computer-supervisor', {
    facts: {
      ...safe,
      image: REMOTE_IMAGES.supervisor,
      labels: { [SERVER_ID_LABEL]: store.serverId(tunnel.alias) },
      portBindings: { '4300/tcp': [{ HostIp: '127.0.0.1', HostPort: '4312' }] },
      ports: { '4300/tcp': [{ HostIp: '127.0.0.1', HostPort: '4312' }] },
      mounts: [
        {
          type: 'bind',
          source: '/var/run/docker.sock',
          destination: '/var/run/docker.sock',
        },
      ],
    },
  });
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
      const fake =
        fakes.get(alias)?.state === 'stopped' || !fakes.get(alias)
          ? new FakeTunnel(alias)
          : fakes.get(alias)!;
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
    return Response.json({ ok: true });
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
  const running = () => [
    {
      botId: id,
      container: `opendots-computer-${id}`,
      status: 'running',
      port: 32768,
      url: 'http://127.0.0.1:32768',
    },
  ];
  return {
    workspace,
    id,
    store,
    remote,
    service,
    calls,
    fake,
    running,
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
    const step = async (fail: TunnelError | undefined) => {
      tunnel.fail = fail;
      f.remote.forget();
      return f.service.status(f.id);
    };
    let status = await step(
      new TunnelError(
        'host_key_unknown',
        'ssh does not know the host key of my-vps.',
      ),
    );
    expect(status.remote?.check).toBe('ssh_failed');
    expect(status.remote?.message).toContain('host key');
    status = await step(
      new TunnelError('ssh_missing', 'FullDots could not start ssh.'),
    );
    expect(status.remote?.check).toBe('ssh_failed');
    status = await step(
      new TunnelError(
        'docker_denied',
        'The ssh user on my-vps cannot use Docker. Add it to the docker group',
      ),
    );
    expect(status.remote?.check).toBe('docker_unreachable');
    expect(status.remote?.message).toContain('docker group');
    status = await step(
      new TunnelError(
        'image_missing',
        'The computer images are not on my-vps yet.',
      ),
    );
    expect(status.remote?.check).toBe('images_missing');
    expect((await step(undefined)).remote?.check).toBe('images_missing');

    for (const image of [REMOTE_IMAGES.browser, REMOTE_IMAGES.desktop])
      tunnel.answers.set(`image ${image}`, { id: 'sha256:abc' });
    expect((await step(undefined)).remote?.check).toBe(
      'supervisor_not_running',
    );

    readyServer(tunnel, f.store);
    status = await step(undefined);
    expect(status.remote?.check).toBe('computer_stopped');
    expect(status.state).toBe('stopped');

    f.setComputers(f.running());
    tunnel.answers.set(`inspect opendots-computer-${f.id}`, {
      facts: { ...computerFacts(f.id), privileged: true },
    });
    status = await f.service.status(f.id);
    expect(status.remote?.check).toBe('computer_unsafe');
    expect(status.remote?.command).toBe(
      `ssh my-vps docker rm -f opendots-computer-${f.id}`,
    );

    tunnel.answers.set(`inspect opendots-computer-${f.id}`, {
      facts: computerFacts(f.id),
    });
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

  it('refuses a supervisor that is unsafe or was started for another alias', async () => {
    const f = remoteFixture();
    f.store.setDefaults('remote', 'my-vps');
    const tunnel = f.fake('my-vps');
    readyServer(tunnel, f.store);
    const good = (
      tunnel.answers.get('inspect fulldots-computer-supervisor') as {
        facts: ContainerFacts;
      }
    ).facts;
    tunnel.answers.set('inspect fulldots-computer-supervisor', {
      facts: { ...good, networkMode: 'host' },
    });
    let check = await f.remote.serverCheck('my-vps', { force: true });
    expect(check?.check).toBe('supervisor_not_running');
    expect(check?.message).toContain('host network');

    const other = f.store.serverId('other-alias');
    tunnel.answers.set('inspect fulldots-computer-supervisor', {
      facts: { ...good, labels: { [SERVER_ID_LABEL]: other } },
    });
    check = await f.remote.serverCheck('my-vps', { force: true });
    expect(check?.message).toContain(
      'my-vps and other-alias are the same server',
    );

    tunnel.answers.set('inspect fulldots-computer-supervisor', {
      facts: { ...good, labels: {} },
    });
    check = await f.remote.serverCheck('my-vps', { force: true });
    expect(check?.message).toContain('not started by FullDots for this alias');
    expect(tunnel.forced).toBe(3);
  });

  it('refuses an unsafe computer before every use and never repairs it', async () => {
    const f = remoteFixture();
    f.store.setDefaults('remote', 'my-vps');
    const tunnel = f.fake('my-vps');
    readyServer(tunnel, f.store);
    f.setComputers(f.running());
    tunnel.answers.set(`inspect opendots-computer-${f.id}`, {
      facts: computerFacts(f.id),
    });
    await f.service.action(f.id, 'read', {});
    tunnel.answers.set(`inspect opendots-computer-${f.id}`, {
      facts: {
        ...computerFacts(f.id),
        mounts: [
          { type: 'bind', source: '/var/run/docker.sock', destination: '/x' },
        ],
      },
    });
    const before = f.calls.length;
    await expect(f.service.action(f.id, 'read', {})).rejects.toThrow(
      /will not use this computer on my-vps: it mounts \/var\/run\/docker\.sock/,
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
    readyServer(f.fake('my-vps'), f.store);
    const secrets = f.store.secrets('my-vps');
    f.setComputers(f.running());
    f.fake('my-vps').answers.set(`inspect opendots-computer-${f.id}`, {
      facts: computerFacts(f.id),
    });
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

  it('binds each tunnel port to one Dot and the port its container publishes', async () => {
    const f = remoteFixture();
    f.store.setDefaults('remote', 'my-vps');
    const tunnel = f.fake('my-vps');
    readyServer(tunnel, f.store);
    const other = f.workspace.createDot(
      f.workspace.spaces()[0]!.id,
      'Other',
      '',
      false,
      false,
    );
    tunnel.answers.set(`inspect opendots-computer-${f.id}`, {
      facts: computerFacts(f.id),
    });
    tunnel.answers.set(`inspect opendots-computer-${other.id}`, {
      facts: computerFacts(other.id, 'browser', 32769),
    });
    const mine = await f.remote.origin(
      'my-vps',
      f.id,
      { port: 32768 },
      'browser',
    );
    const theirs = await f.remote.origin(
      'my-vps',
      other.id,
      { port: 32769 },
      'browser',
    );
    expect(mine).not.toBe(theirs);
    const minePort = Number(new URL(mine).port);
    expect(f.remote.ownsPort('my-vps', f.id, minePort, 32768)).toBe(true);
    expect(f.remote.ownsPort('my-vps', f.id, minePort, 32769)).toBe(false);
    expect(f.remote.ownsPort('my-vps', other.id, minePort, 32768)).toBe(false);
    // The supervisor names a port this Dot's container does not publish: refused.
    await expect(
      f.remote.origin('my-vps', f.id, { port: 32769 }, 'browser'),
    ).rejects.toThrow('not bound to this Dot');
    // A bridge that leads somewhere else than the checked port is refused.
    tunnel.bridge = async () => minePort;
    await expect(
      f.remote.origin('my-vps', other.id, { port: 32769 }, 'browser'),
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
    readyServer(f.fake('old-vps'), f.store);
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
    readyServer(old, f.store);
    f.setComputers([]);
    await f.service.setDefaults('local');
    expect(old.state).toBe('stopped');
    expect(f.remote.open()).toEqual([]);
  });

  it('stops a tunnel opened only for a check once the check is done', async () => {
    const f = remoteFixture();
    f.store.setDefaults('remote', 'my-vps');
    const checked = f.fake('other-vps');
    readyServer(checked, f.store);
    await f.remote.serverCheck('other-vps', { force: true });
    f.remote.pruneIdle();
    expect(checked.state).toBe('stopped');
    expect(f.remote.open()).not.toContain('other-vps');
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
    options: { canBuild?: boolean; key?: Buffer; db?: DatabaseSync } = {},
  ) {
    const db = options.db ?? new DatabaseSync(':memory:');
    const store = new RemoteStore(db, options.key ?? randomBytes(32));
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
    const tunnels: FakeTunnel[] = [];
    const remote = new RemoteComputers({
      store,
      computers: { server: () => undefined },
      spawn: fake.spawn,
      tunnel: (alias) => {
        const tunnel = new FakeTunnel(alias);
        tunnels.push(tunnel);
        return tunnel as unknown as RemoteTunnel;
      },
    });
    const setup = new RemoteSetup({
      remote,
      enabled: { ssh: true, build: options.canBuild ?? true },
      fetch: async () => Response.json({ status: 'ok' }),
      sleep: async () => undefined,
    });
    return { store, setup, fake, remote, tunnels, db };
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
        expect(command).toContain('ClearAllForwardings=yes');
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

  it('never runs two steps at once, even when both are asked for together', async () => {
    const { setup } = setupFixture((_, __, child) =>
      setTimeout(() => child.exit(0), 30),
    );
    const plans = await setup.plans('my-vps');
    const [first, second] = await Promise.allSettled([
      setup.start('my-vps', 'check-alias', plans[0]!.commands),
      setup.start('my-vps', 'check-docker', plans[1]!.commands),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect((second as PromiseRejectedResult).reason.message).toContain(
      'still running',
    );
  });

  it('sends the tokens on stdin only and keeps them out of the output', async () => {
    const { store, setup } = setupFixture((args, stdin, child) => {
      // A server that echoes what it got must still not leak a token into the job output.
      child.stdout.write(`args=${args.join(' ')}\nstdin=${stdin}\n`);
      child.exit(0);
    });
    const plans = await setup.plans('my-vps');
    const start = plans.find((plan) => plan.step === 'start-supervisor')!;
    expect(start.commands[2]).toContain('127.0.0.1:4312:4300');
    expect(start.commands[2]).toContain('--env-file /dev/stdin');
    expect(start.commands[2]).toContain(
      `${SERVER_ID_LABEL}=${store.serverId('my-vps')}`,
    );
    const job = await setup.start('my-vps', 'start-supervisor', start.commands);
    const done = await setup.settled(job.id, 5000);
    expect(done?.state).toBe('done');
    const { supervisorToken, computerToken } = store.secrets('my-vps');
    expect(done?.output).toContain('SUPERVISOR_TOKEN=[redacted]');
    expect(done?.output).not.toContain(supervisorToken);
    expect(done?.output).not.toContain(computerToken);
    expect(start.commands.join(' ')).not.toContain(supervisorToken);
  });

  it('keeps the whole output of a command that ends before its output does', async () => {
    const { setup } = setupFixture((_, __, child) => {
      child.exitCode = 0;
      child.emit('exit', 0);
      setImmediate(() => {
        child.stdout.write('28.0.4\n');
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);
      });
    });
    const plans = await setup.plans('my-vps');
    const job = await setup.start('my-vps', 'check-docker', plans[1]!.commands);
    expect((await setup.settled(job.id, 2000))?.message).toBe(
      'Docker 28.0.4 answers on my-vps.',
    );
  });

  it('never leaves part of a token in the output tail', async () => {
    const { store, setup } = setupFixture((_, stdin, child) => {
      child.stdout.write(`${'x'.repeat(3990)}\n${stdin}`);
      child.exit(0);
    });
    const { supervisorToken } = store.secrets('my-vps');
    const plans = await setup.plans('my-vps');
    const start = plans.find((plan) => plan.step === 'start-supervisor')!;
    const done = await setup.settled(
      (await setup.start('my-vps', 'start-supervisor', start.commands)).id,
      5000,
    );
    for (let cut = 8; cut < supervisorToken.length; cut += 8)
      expect(done?.output).not.toContain(supervisorToken.slice(cut));
    expect(done?.output.length).toBeLessThanOrEqual(4000);
  });

  it('builds only from a checkout, but starts the supervisor without one', async () => {
    const { setup } = setupFixture((_, __, child) => child.exit(0), {
      canBuild: false,
    });
    const plans = await setup.plans('my-vps');
    const build = plans.find((plan) => plan.step === 'build-images')!;
    expect(build.unavailable).toBe(true);
    await expect(
      setup.start('my-vps', 'build-images', build.commands),
    ).rejects.toThrow('checkout');
    const start = plans.find((plan) => plan.step === 'start-supervisor')!;
    const job = await setup.start('my-vps', 'start-supervisor', start.commands);
    expect((await setup.settled(job.id, 5000))?.state).toBe('done');
  });

  it('replaces tokens that no longer decrypt when it starts the supervisor, and says so', async () => {
    const db = new DatabaseSync(':memory:');
    const old = new RemoteStore(db, randomBytes(32));
    old.secrets('my-vps');
    const { store, setup } = setupFixture((_, __, child) => child.exit(0), {
      db,
    });
    expect(() => store.secrets('my-vps')).toThrow('could not be decrypted');
    const plans = await setup.plans('my-vps');
    const start = plans.find((plan) => plan.step === 'start-supervisor')!;
    const done = await setup.settled(
      (await setup.start('my-vps', 'start-supervisor', start.commands)).id,
      5000,
    );
    expect(done?.state).toBe('done');
    expect(done?.message).toContain('FullDots made new ones');
    expect(store.secrets('my-vps').supervisorToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses to start the supervisor on a server another alias already set up', async () => {
    let otherId = '';
    const { store, setup } = setupFixture((args, _, child) => {
      if (args.at(-1)?.includes('docker inspect'))
        child.stdout.write(`${otherId}\n`);
      child.exit(0);
    });
    otherId = store.serverId('first-alias');
    const plans = await setup.plans('second-alias');
    const start = plans.find((plan) => plan.step === 'start-supervisor')!;
    const done = await setup.settled(
      (await setup.start('second-alias', 'start-supervisor', start.commands))
        .id,
      5000,
    );
    expect(done?.state).toBe('failed');
    expect(done?.message).toContain(
      'second-alias is the same server as first-alias',
    );
    expect(done?.output).not.toContain('docker run');
  });

  it('stops the tunnel a setup step opened when nothing uses that server', async () => {
    const { setup, tunnels } = setupFixture((_, __, child) => child.exit(0));
    const plans = await setup.plans('my-vps');
    const start = plans.find((plan) => plan.step === 'start-supervisor')!;
    await setup.settled(
      (await setup.start('my-vps', 'start-supervisor', start.commands)).id,
      5000,
    );
    expect(tunnels.length).toBeGreaterThan(0);
    expect(tunnels.every((tunnel) => tunnel.state === 'stopped')).toBe(true);
  });

  it('packs only the build context as a tar, without following links', () => {
    const root = mkdtempSync(join(tmpdir(), 'fulldots-tar-'));
    try {
      mkdirSync(join(root, 'deployment', 'computers', 'desktop'), {
        recursive: true,
      });
      writeFileSync(
        join(root, 'deployment', 'computers', 'supervisor.Dockerfile'),
        'FROM x\n',
      );
      writeFileSync(
        join(root, 'deployment', 'computers', 'desktop', 'worker.sh'),
        'echo\n',
      );
      writeFileSync(join(root, 'secret.txt'), 'do not send');
      let linked = true;
      try {
        symlinkSync(
          join(root, 'secret.txt'),
          join(root, 'deployment', 'computers', 'link.txt'),
          'file',
        );
      } catch {
        linked = false; // Windows without the symlink privilege: the rest still holds.
      }
      const tar = contextTar(root);
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
      if (linked) expect(names).not.toContain('deployment/computers/link.txt');
      expect(tar.toString('latin1')).not.toContain('do not send');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('packs the real build context of this checkout', () => {
    const tar = contextTar(process.cwd()).toString('latin1');
    expect(tar).toContain('deployment/computers/computer.Dockerfile');
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
