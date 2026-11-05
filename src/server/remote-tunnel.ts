// One ssh process per server, kept open while the server is in use. It forwards no port at all
// (ClearAllForwardings): its only channel runs the relay in remote-relay.ts, and every TCP
// connection to the server travels as frames on that channel. FullDots opens one loopback port
// on this machine per owner (the supervisor, or one Dot); each leads to one fixed port on the
// server's loopback, which the relay checks against the server's Docker before every connection.
// Nothing is added while ssh runs, so a computer starting never restarts the tunnel, and it works
// the same with Windows OpenSSH, which has no connection sharing.
import { createServer, type Server, type Socket } from 'node:net';
import {
  classifySsh,
  configuredForwards,
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
import {
  FRAME,
  FrameReader,
  RELAY_CHUNK,
  RELAY_FAIL,
  RELAY_READY,
  frame,
  relayCommand,
} from './remote-relay.js';

/** Problems that retrying cannot fix. Retried only on an explicit check or after the longest backoff. */
export const LASTING = new Set<SshProblem>([
  'ssh_missing',
  'forwards_set',
  'host_key_unknown',
  'host_key_changed',
  'refused',
  'alias_unknown',
]);

export type TunnelState = 'idle' | 'starting' | 'up' | 'down' | 'stopped';

export interface TunnelOptions {
  settings?: SshSettings;
  spawn?: SshSpawner;
  /** `ssh -G` output for the alias, used for timeouts and to refuse aliases that forward ports. */
  effectiveConfig?: (alias: string) => Promise<string>;
  /** First restart delay; doubles up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** How long a caller waits for a tunnel that is starting or restarting. */
  readyMs?: number;
  /** How long one relay request or connection may take before the tunnel is considered broken. */
  requestMs?: number;
  /** What the relay checks containers against on the server. */
  namespace?: string;
  supervisorImage?: string;
  now?: () => number;
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

interface Stream {
  socket: Socket;
  opened: boolean;
}

/** `ssh -G` (prints the effective config, connects nowhere), killed if it hangs. */
export function effectiveSshConfig(
  settings: SshSettings,
  spawn: SshSpawner,
  timeoutMs = 5000,
) {
  return (alias: string) =>
    new Promise<string>((resolve) => {
      let out = '';
      let child: SshChild;
      try {
        child = spawn(settings.command ?? 'ssh', [
          ...(settings.configFile ? ['-F', settings.configFile] : []),
          '-G',
          '--',
          requireAlias(alias),
        ]);
      } catch {
        resolve('');
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        resolve(out);
      }, timeoutMs);
      timer.unref();
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      const done = () => {
        clearTimeout(timer);
        resolve(out);
      };
      child.on('error', done);
      child.once('close', done);
    });
}

/** The tunnel to one server. Started on demand; restarts with backoff while it is wanted. */
export class RemoteTunnel {
  state: TunnelState = 'idle';
  /** What the last failed start reported. */
  problem?: SshProblem;
  private child?: SshChild;
  private wanted = false;
  private attempts = 0;
  private upSince = 0;
  private lastAttempt = 0;
  private restartTimer?: NodeJS.Timeout;
  private waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private stderr = '';
  private text = '';
  private failLine = '';
  private spawnFailed = false;
  private framed = false;
  private reader = new FrameReader();
  private nextId = 1;
  private readonly streams = new Map<number, Stream>();
  private readonly opening = new Map<number, (error?: string) => void>();
  private readonly pending = new Map<number, (answer: unknown) => void>();
  private stdinBlocked = false;
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

  /** How many restarts in a row since the tunnel last stayed up. */
  get restarts() {
    return this.attempts;
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  private timer(fn: () => void, ms: number): NodeJS.Timeout {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  }

  /**
   * Resolves once ssh is logged in and the relay answers, or rejects with the reason. A problem
   * retrying cannot fix is reported at once without starting ssh again, unless `force` (an
   * explicit check by the owner) or the longest backoff has passed.
   */
  async ready(options: { force?: boolean } = {}): Promise<void> {
    if (this.state === 'stopped')
      throw new TunnelError('tunnel_down', 'The tunnel was stopped.');
    this.wanted = true;
    if (this.state === 'up') return;
    if (this.state === 'idle') void this.launch();
    else if (this.state === 'down' && !this.restartTimer) {
      if (
        this.problem &&
        LASTING.has(this.problem) &&
        !options.force &&
        this.now() - this.lastAttempt < (this.options.maxBackoffMs ?? 30_000)
      )
        throw this.failure();
      void this.launch();
    }
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
    for (const waiter of this.waiters.splice(0))
      if (error) waiter.reject(error);
      else waiter.resolve();
  }

  private async launch() {
    if (this.child || this.state === 'stopped') return;
    this.state = 'starting';
    this.lastAttempt = this.now();
    this.stderr = '';
    this.text = '';
    this.failLine = '';
    this.spawnFailed = false;
    this.framed = false;
    this.reader = new FrameReader();
    const effective = await (
      this.options.effectiveConfig ??
      effectiveSshConfig(this.settings, this.spawn)
    )(this.alias).catch(() => '');
    // Stopped while ssh -G ran: a stopped tunnel never comes back.
    if ((this.state as TunnelState) === 'stopped') return;
    if (!this.wanted) {
      this.state = 'idle';
      return;
    }
    if (configuredForwards(effective).length) {
      this.fail('forwards_set');
      return;
    }
    let child: SshChild;
    try {
      child = this.spawn(
        this.settings.command ?? 'ssh',
        sshArgs(this.alias, this.settings, {
          timeouts: timeoutOptions(effective),
          extra: ['-T'],
          remote: remoteCommand([
            'sh',
            '-c',
            relayCommand({
              namespace: this.options.namespace ?? 'opendots',
              supervisorImage:
                this.options.supervisorImage ??
                'opendots-supervisor:b6932d3-desktop1',
            }),
          ]),
        }),
      );
    } catch {
      this.fail('ssh_missing');
      return;
    }
    this.child = child;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (this.child === child) this.exited();
    };
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.stdout?.on('data', (chunk: Buffer) => this.read(chunk));
    child.stdin?.on('error', () => undefined);
    child.stdin?.on('drain', () => this.unblock());
    // A program that cannot be started emits 'error' and may never emit 'exit'.
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'EACCES' || !child.pid)
        this.spawnFailed = true;
      finish();
    });
    child.once('exit', finish);
    child.once('close', finish);
  }

  /** A start that failed before ssh ran. */
  private fail(problem: SshProblem) {
    this.problem = problem;
    this.state = 'down';
    this.options.log?.(`Tunnel to ${this.alias} did not start (${problem}).`);
    this.settle(this.failure());
  }

  private read(chunk: Buffer) {
    if (this.framed) return this.frames(chunk);
    this.text += chunk.toString('latin1');
    for (;;) {
      const newline = this.text.indexOf('\n');
      if (newline < 0) break;
      const line = this.text.slice(0, newline).replace(/\r$/, '');
      this.text = this.text.slice(newline + 1);
      if (line === RELAY_READY) {
        this.framed = true;
        this.state = 'up';
        this.problem = undefined;
        this.upSince = this.now();
        this.settle();
        const rest = Buffer.from(this.text, 'latin1');
        this.text = '';
        if (rest.length) this.frames(rest);
        return;
      }
      if (line.startsWith(RELAY_FAIL)) this.failLine = line.slice(0, 400);
    }
    if (this.text.length > 100_000) this.child?.kill();
  }

  private frames(chunk: Buffer) {
    try {
      this.reader.push(chunk, (type, id, payload) =>
        this.onFrame(type, id, payload),
      );
    } catch {
      this.child?.kill();
    }
  }

  private onFrame(type: number, id: number, payload: Buffer) {
    const stream = this.streams.get(id);
    switch (type) {
      case FRAME.OPENED:
        if (stream) stream.opened = true;
        this.opening.get(id)?.();
        return;
      case FRAME.FAIL:
        this.opening.get(id)?.(payload.toString('utf8').slice(0, 200));
        return;
      case FRAME.DATA:
        if (stream && !stream.socket.write(payload)) {
          this.send(FRAME.PAUSE, id);
          stream.socket.once('drain', () => this.send(FRAME.RESUME, id));
        }
        return;
      case FRAME.CLOSE:
        if (stream) {
          this.streams.delete(id);
          stream.socket.end();
        }
        return;
      case FRAME.PAUSE:
        stream?.socket.pause();
        return;
      case FRAME.RESUME:
        if (stream && !this.stdinBlocked) stream.socket.resume();
        return;
      case FRAME.RES: {
        const resolve = this.pending.get(id);
        if (!resolve) return;
        this.pending.delete(id);
        try {
          resolve(JSON.parse(payload.toString('utf8')));
        } catch {
          resolve({ error: 'bad answer' });
        }
        return;
      }
    }
  }

  private send(type: number, id: number, payload?: Buffer | string) {
    const stdin = this.child?.stdin;
    if (!stdin || this.state !== 'up') return false;
    const ok = stdin.write(frame(type, id, payload));
    if (!ok && !this.stdinBlocked) {
      this.stdinBlocked = true;
      for (const stream of this.streams.values())
        if (stream.opened) stream.socket.pause();
    }
    return ok;
  }

  private unblock() {
    if (!this.stdinBlocked) return;
    this.stdinBlocked = false;
    for (const stream of this.streams.values())
      if (stream.opened) stream.socket.resume();
  }

  private exited() {
    const wasUp = this.state === 'up';
    this.child = undefined;
    for (const stream of this.streams.values()) stream.socket.destroy();
    this.streams.clear();
    for (const open of this.opening.values()) open('tunnel closed');
    this.opening.clear();
    for (const resolve of this.pending.values())
      resolve({ error: 'tunnel closed' });
    this.pending.clear();
    this.stdinBlocked = false;
    if (this.state === 'stopped') return;
    // Only the kind of failure is kept, never what ssh or the server printed.
    this.problem = wasUp
      ? 'unreachable'
      : this.spawnFailed
        ? 'ssh_missing'
        : this.failLine.startsWith(`${RELAY_FAIL} image`)
          ? 'image_missing'
          : this.failLine.startsWith(`${RELAY_FAIL} docker`)
            ? (() => {
                const problem = classifySsh(this.failLine);
                return ['docker_missing', 'docker_denied'].includes(problem)
                  ? problem
                  : 'docker_down';
              })()
            : classifySsh(this.stderr);
    this.state = 'down';
    if (wasUp && this.now() - this.upSince > 30_000) this.attempts = 0;
    this.options.log?.(
      `Tunnel to ${this.alias} ${wasUp ? 'dropped' : 'did not start'} (${this.problem}).`,
    );
    if (!wasUp) this.settle(this.failure());
    if (!this.wanted || (!wasUp && LASTING.has(this.problem))) return;
    const delay = Math.min(
      this.options.maxBackoffMs ?? 30_000,
      (this.options.backoffMs ?? 1000) * 2 ** this.attempts,
    );
    this.attempts++;
    this.restartTimer = this.timer(() => {
      this.restartTimer = undefined;
      if (this.wanted && this.state === 'down') void this.launch();
    }, delay);
  }

  /** One question for the relay on the server ("inspect" a container, an "image" id). */
  async request(verb: 'inspect' | 'image', arg: string): Promise<unknown> {
    await this.ready();
    const id = this.nextId++;
    const answer = new Promise<unknown>((resolve, reject) => {
      const timer = this.timer(() => {
        if (!this.pending.delete(id)) return;
        // A relay that stops answering means a broken connection: start over.
        this.child?.kill();
        reject(
          new TunnelError(
            'unreachable',
            `${this.alias} stopped answering over ssh. FullDots keeps trying to reconnect.`,
          ),
        );
      }, this.options.requestMs ?? 10_000);
      this.pending.set(id, (value) => {
        clearTimeout(timer);
        const error =
          value && typeof value === 'object'
            ? (value as { error?: unknown }).error
            : undefined;
        if (error === 'tunnel closed') reject(this.failure());
        else resolve(value);
      });
    });
    if (!this.send(FRAME.REQ, id, JSON.stringify({ verb, arg })) && !this.child)
      this.pending.get(id)?.({ error: 'tunnel closed' });
    return answer;
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
    const server = createServer((client) =>
      this.relay(client, owner, remotePort),
    );
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

  /** One local connection, carried to the relay as a stream it checks before it connects. */
  private relay(client: Socket, owner: string, remotePort: number) {
    client.on('error', () => undefined);
    client.pause();
    if (this.state !== 'up') {
      // Fail at once: a caller must not wait on a tunnel that is down.
      client.destroy();
      if (
        this.wanted &&
        this.state === 'down' &&
        !this.restartTimer &&
        !(this.problem && LASTING.has(this.problem))
      )
        void this.launch();
      return;
    }
    const id = this.nextId++;
    const stream: Stream = { socket: client, opened: false };
    this.streams.set(id, stream);
    const timer = this.timer(() => {
      this.opening.get(id)?.('timed out');
    }, this.options.requestMs ?? 10_000);
    this.opening.set(id, (error) => {
      clearTimeout(timer);
      this.opening.delete(id);
      if (error) {
        this.streams.delete(id);
        client.destroy();
        return;
      }
      client.on('data', (data: Buffer) => {
        for (let at = 0; at < data.length; at += RELAY_CHUNK)
          this.send(FRAME.DATA, id, data.subarray(at, at + RELAY_CHUNK));
      });
      if (!this.stdinBlocked) client.resume();
    });
    client.on('close', () => {
      if (!this.streams.delete(id)) return;
      this.opening.get(id)?.('closed');
      this.send(FRAME.CLOSE, id);
    });
    this.send(FRAME.OPEN, id, JSON.stringify({ port: remotePort, owner }));
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
    this.exited();
    this.settle(new TunnelError('tunnel_down', 'The tunnel was stopped.'));
  }
}
