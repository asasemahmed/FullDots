// One ssh process per server, kept open while the server is in use. It carries:
// - a dynamic (SOCKS) forward bound to 127.0.0.1 on this machine, which FullDots alone dials: each
//   computer and the supervisor gets its own local port here, and each port opens exactly one fixed
//   address on the server's loopback, so a port maps to one Dot's container and nothing else;
// - a small read-only helper on the server's shell (stdin/stdout) that reports Docker, image and
//   container facts for the safety checks. It reads one fixed verb and one checked name per line.
// No forward is added or removed while ssh runs, so a computer starting never restarts the tunnel
// and works the same with Windows OpenSSH, which has no connection sharing.
import { createServer, connect, type Server, type Socket } from 'node:net';
import {
  classifySsh,
  remoteCommand,
  requireAlias,
  sshArgs,
  sshProblemMessage,
  spawnSsh,
  timeoutOptions,
  type SshChild,
  type SshProblem,
  type SshSettings,
  type SshSpawner,
} from './remote-ssh.js';

/** Names and tags the helper accepts. Checked here and again on the server. */
const SAFE_WORD = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
const READY = 'FULLDOTS-READY';
const DONE = 'FULLDOTS-DONE';

/**
 * The helper that runs on the server for as long as the tunnel is open. It prints READY once ssh
 * is logged in, then answers one request per line. Container facts leave out the environment,
 * which holds the computer's credential.
 */
const INSPECT_FORMAT =
  '{"image":{{json .Config.Image}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}},' +
  '"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},' +
  '"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},' +
  '"memory":{{json .HostConfig.Memory}},"pidsLimit":{{json .HostConfig.PidsLimit}},' +
  '"privileged":{{json .HostConfig.Privileged}},"networkMode":{{json .HostConfig.NetworkMode}},' +
  '"portBindings":{{json .HostConfig.PortBindings}},"ports":{{json .NetworkSettings.Ports}}}';

export const HELPER_SCRIPT = [
  `F='${INSPECT_FORMAT}'`,
  `echo ${READY}`,
  'while read -r verb arg; do',
  '  case "$arg" in ""|-*|*[!A-Za-z0-9_.:/-]*) verb=bad ;; esac',
  '  case "$verb" in',
  `    docker) out=$(docker version --format '{{.Server.Version}}' 2>&1); code=$?; printf '%s' "$out" | head -c 400 | tr '\n' ' '; echo; echo "EXIT $code" ;;`,
  `    image) docker image inspect --format '{{.Id}}' -- "$arg" 2>/dev/null || echo MISSING ;;`,
  '    inspect) docker inspect --type container --format "$F" -- "$arg" 2>/dev/null || echo MISSING ;;',
  '    *) echo BAD ;;',
  '  esac',
  `  echo ${DONE}`,
  'done',
].join('\n');

/** Problems that retrying cannot fix: the next use tries again, nothing retries on its own. */
const LASTING = new Set<SshProblem>([
  'host_key_unknown',
  'host_key_changed',
  'refused',
  'alias_unknown',
]);

export type TunnelState = 'idle' | 'starting' | 'up' | 'down' | 'stopped';

export interface TunnelOptions {
  settings?: SshSettings;
  spawn?: SshSpawner;
  /** `ssh -G` output for the alias, used to fill in timeouts the alias leaves unset. */
  effectiveConfig?: (alias: string) => Promise<string>;
  /** A free port on 127.0.0.1 for ssh's SOCKS listener. */
  freePort?: () => Promise<number>;
  /** Opens a TCP connection on this machine. A seam for tests. */
  dial?: (port: number) => Socket;
  /** First restart delay; doubles up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** How long a caller waits for a tunnel that is starting or restarting. */
  readyMs?: number;
  /** How long one helper request may take before the tunnel is considered broken. */
  requestMs?: number;
  log?: (message: string) => void;
}

export class TunnelError extends Error {
  constructor(
    readonly problem: SshProblem | 'tunnel_down',
    message: string,
  ) {
    super(message);
    this.name = 'TunnelError';
  }
}

interface Bridge {
  server: Server;
  port: number;
  owner: string;
  remotePort: number;
}

const freeLoopbackPort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });

export function effectiveSshConfig(settings: SshSettings, spawn: SshSpawner) {
  return (alias: string) =>
    new Promise<string>((resolve) => {
      let out = '';
      const child = spawn(settings.command ?? 'ssh', [
        ...(settings.configFile ? ['-F', settings.configFile] : []),
        '-G',
        '--',
        requireAlias(alias),
      ]);
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      child.on('error', () => resolve(''));
      child.once('exit', () => resolve(out));
    });
}

/** The tunnel to one server. Started on demand; restarts with backoff while it is wanted. */
export class RemoteTunnel {
  state: TunnelState = 'idle';
  /** What the last failed start reported. */
  problem?: SshProblem;
  private child?: SshChild;
  private socksPort?: number;
  private wanted = false;
  private attempts = 0;
  private upSince = 0;
  private restartTimer?: NodeJS.Timeout;
  private waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private stderr = '';
  private stdoutBuffer = '';
  private lines: string[] = [];
  private lineWaiter?: () => void;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly bridges = new Map<string, Bridge>();
  private readonly byPort = new Map<number, Bridge>();
  private readonly spawn: SshSpawner;
  private readonly settings: SshSettings;

  constructor(
    readonly alias: string,
    private readonly options: TunnelOptions = {},
  ) {
    requireAlias(alias);
    this.spawn = options.spawn ?? spawnSsh;
    this.settings = options.settings ?? {};
  }

  /** The pid of the ssh process FullDots started, if one runs. */
  get pid() {
    return this.child?.pid;
  }

  private timer(fn: () => void, ms: number): NodeJS.Timeout {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  }

  /** Resolves once ssh is logged in and the forward is listening, or rejects with the reason. */
  async ready(): Promise<void> {
    if (this.state === 'stopped')
      throw new TunnelError('tunnel_down', 'The tunnel was stopped.');
    this.wanted = true;
    if (this.state === 'up') return;
    if (this.state === 'idle' || (this.state === 'down' && !this.restartTimer))
      void this.launch();
    const waitMs = this.options.readyMs ?? 12_000;
    await new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject };
      this.waiters.push(entry);
      this.timer(() => {
        const index = this.waiters.indexOf(entry);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        reject(this.failure());
      }, waitMs);
    });
  }

  private failure(): TunnelError {
    const problem = this.problem ?? 'unreachable';
    return new TunnelError(
      problem,
      this.wanted && !LASTING.has(problem)
        ? `${sshProblemMessage(problem, this.alias)} FullDots keeps trying to reconnect.`
        : sshProblemMessage(problem, this.alias),
    );
  }

  private settle(error?: Error) {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters)
      if (error) waiter.reject(error);
      else waiter.resolve();
  }

  private async launch() {
    if (this.child || this.state === 'stopped') return;
    this.state = 'starting';
    this.stderr = '';
    this.stdoutBuffer = '';
    this.lines = [];
    let child: SshChild;
    try {
      const effective = await (
        this.options.effectiveConfig ??
        effectiveSshConfig(this.settings, this.spawn)
      )(this.alias);
      const port = await (this.options.freePort ?? freeLoopbackPort)();
      if (!this.wanted) {
        this.state = 'idle';
        return;
      }
      this.socksPort = port;
      child = this.spawn(
        this.settings.command ?? 'ssh',
        sshArgs(this.alias, this.settings, {
          timeouts: timeoutOptions(effective),
          extra: [
            '-T',
            '-o',
            'ExitOnForwardFailure=yes',
            '-D',
            `127.0.0.1:${port}`,
          ],
          remote: remoteCommand(['sh', '-c', HELPER_SCRIPT]),
        }),
      );
    } catch {
      this.exited();
      return;
    }
    this.child = child;
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.stdout?.on('data', (chunk: Buffer) => this.read(chunk));
    child.on('error', () => undefined);
    child.stdin?.on('error', () => undefined);
    child.once('exit', () => {
      if (this.child === child) this.exited();
    });
  }

  private read(chunk: Buffer) {
    this.stdoutBuffer += chunk.toString('utf8');
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (this.state === 'starting' && line === READY) {
        this.state = 'up';
        this.problem = undefined;
        this.upSince = Date.now();
        this.settle();
        continue;
      }
      this.lines.push(line);
      this.lineWaiter?.();
    }
    if (this.stdoutBuffer.length > 1_000_000) this.child?.kill();
  }

  private exited() {
    const wasUp = this.state === 'up';
    this.child = undefined;
    this.lineWaiter?.();
    if (this.state === 'stopped') return;
    // Only the kind of failure is kept, never what ssh printed.
    this.problem = wasUp
      ? 'unreachable'
      : /address already in use|cannot listen|could not request local forwarding/i.test(
            this.stderr,
          )
        ? 'failed'
        : classifySsh(this.stderr);
    this.state = 'down';
    if (wasUp && Date.now() - this.upSince > 30_000) this.attempts = 0;
    const portTaken =
      !wasUp &&
      /address already in use|cannot listen/i.test(this.stderr) &&
      this.attempts < 3;
    this.options.log?.(
      `Tunnel to ${this.alias} ${wasUp ? 'dropped' : 'did not start'} (${this.problem}).`,
    );
    if (!wasUp && !portTaken) this.settle(this.failure());
    if (!this.wanted || (!wasUp && LASTING.has(this.problem))) return;
    const delay = portTaken
      ? 0
      : Math.min(
          this.options.maxBackoffMs ?? 30_000,
          (this.options.backoffMs ?? 1000) * 2 ** this.attempts,
        );
    this.attempts++;
    this.restartTimer = this.timer(() => {
      this.restartTimer = undefined;
      if (this.wanted && this.state === 'down') void this.launch();
    }, delay);
  }

  /** The delay before the next restart, for tests and status. */
  get restarts() {
    return this.attempts;
  }

  /** One request to the helper on the server. Requests run one at a time. */
  request(verb: 'docker' | 'image' | 'inspect', arg = '-'): Promise<string[]> {
    if (verb !== 'docker' && !SAFE_WORD.test(arg))
      return Promise.reject(new Error('Unsafe name.'));
    const run = async () => {
      await this.ready();
      const child = this.child;
      if (!child?.stdin) throw this.failure();
      this.lines = [];
      child.stdin.write(`${verb} ${verb === 'docker' ? 'x' : arg}\n`);
      const deadline = Date.now() + (this.options.requestMs ?? 10_000);
      const out: string[] = [];
      for (;;) {
        while (this.lines.length) {
          const line = this.lines.shift()!;
          if (line === DONE) return out;
          out.push(line);
        }
        if (this.child !== child) throw this.failure();
        const left = deadline - Date.now();
        if (left <= 0) {
          // A helper that stops answering means a broken connection: start over.
          child.kill();
          throw new TunnelError(
            'unreachable',
            `${this.alias} stopped answering over ssh. FullDots keeps trying to reconnect.`,
          );
        }
        await new Promise<void>((resolve) => {
          const timer = this.timer(resolve, Math.min(left, 250));
          this.lineWaiter = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.lineWaiter = undefined;
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /**
   * A port on this machine's loopback that reaches `127.0.0.1:remotePort` on the server, for one
   * owner (a Dot id, or "supervisor"). An owner has one bridge; a new remote port replaces it.
   */
  async bridge(owner: string, remotePort: number): Promise<number> {
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535)
      throw new Error('Invalid remote port.');
    const key = `${owner}\u0000${remotePort}`;
    const existing = this.bridges.get(key);
    if (existing) return existing.port;
    for (const [other, bridge] of this.bridges)
      if (bridge.owner === owner) this.close(other, bridge);
    const server = createServer((client) => this.relay(client, remotePort));
    server.on('error', () => undefined);
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    const bridge = { server, port, owner, remotePort };
    this.bridges.set(key, bridge);
    this.byPort.set(port, bridge);
    return port;
  }

  /** Who a local bridge port belongs to, and where it leads. */
  bridgeAt(port: number): { owner: string; remotePort: number } | undefined {
    const bridge = this.byPort.get(port);
    return bridge && { owner: bridge.owner, remotePort: bridge.remotePort };
  }

  /** Closes the bridges of one owner, e.g. when a Dot moves away from this server. */
  release(owner: string) {
    for (const [key, bridge] of this.bridges)
      if (bridge.owner === owner) this.close(key, bridge);
  }

  private close(key: string, bridge: Bridge) {
    this.bridges.delete(key);
    this.byPort.delete(bridge.port);
    bridge.server.close();
  }

  /** Opens one connection through ssh's SOCKS forward to a fixed loopback port on the server. */
  private relay(client: Socket, remotePort: number) {
    client.on('error', () => undefined);
    client.pause();
    if (this.state !== 'up' || !this.socksPort) {
      // Fail at once: a caller must not wait on a tunnel that is down.
      client.destroy();
      if (this.wanted && this.state === 'down' && !this.restartTimer)
        void this.launch();
      return;
    }
    const upstream = (
      this.options.dial ?? ((port) => connect(port, '127.0.0.1'))
    )(this.socksPort);
    upstream.setNoDelay(true);
    client.setNoDelay(true);
    let stage: 'greeting' | 'connect' | 'open' = 'greeting';
    let buffer = Buffer.alloc(0);
    const fail = () => {
      upstream.destroy();
      client.destroy();
    };
    const handshake = this.timer(fail, 10_000);
    upstream.on('error', fail);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    upstream.on('connect', () => upstream.write(Buffer.from([5, 1, 0])));
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        if (buffer[0] !== 5 || buffer[1] !== 0) return fail();
        buffer = buffer.subarray(2);
        stage = 'connect';
        upstream.write(
          Buffer.from([
            5,
            1,
            0,
            1,
            127,
            0,
            0,
            1,
            remotePort >> 8,
            remotePort & 255,
          ]),
        );
      }
      if (stage === 'connect') {
        if (buffer.length < 10) return;
        if (buffer[0] !== 5 || buffer[1] !== 0 || buffer[3] !== 1)
          return fail();
        const rest = buffer.subarray(10);
        stage = 'open';
        clearTimeout(handshake);
        upstream.off('data', onData);
        if (rest.length) client.write(rest);
        upstream.pipe(client);
        client.pipe(upstream);
        client.resume();
      }
    };
    upstream.on('data', onData);
  }

  /** Ends the tunnel for good: kills only the ssh process this tunnel started and closes its ports. */
  stop() {
    this.wanted = false;
    this.state = 'stopped';
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    for (const [key, bridge] of this.bridges) this.close(key, bridge);
    const child = this.child;
    this.child = undefined;
    child?.stdin?.end();
    child?.kill();
    this.settle(new TunnelError('tunnel_down', 'The tunnel was stopped.'));
  }
}
