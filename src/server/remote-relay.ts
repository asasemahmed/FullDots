// The relay FullDots runs on the owner's server, inside the ssh session it keeps open. It replaces
// an ssh port forward, which would be an open proxy on this machine's loopback: the only thing it
// will connect to is 127.0.0.1 (or ::1) on a port that, at that moment, a managed computer of the
// named Dot publishes there for its API, or the supervisor's own 127.0.0.1:4312. It checks that
// with the server's Docker before every connection. Every other request is refused.
//
// It runs in a throwaway container of the pinned supervisor image (`--network host`, so it can
// reach the server's loopback; the Docker socket, so it can check; all capabilities dropped,
// read-only, an unprivileged user). It speaks a small framed protocol on stdin and stdout, so one
// ssh process carries every connection, and it works with Windows OpenSSH, which cannot share
// connections. `fulldotsRelay` is sent to the server as its own source text, so it must use only
// its argument and the language's globals.

/** Frame types. A frame is: type (1 byte), stream id (4 bytes), length (4 bytes), payload. */
export const FRAME = {
  OPEN: 2,
  OPENED: 3,
  FAIL: 4,
  DATA: 5,
  CLOSE: 6,
  REQ: 7,
  RES: 8,
  PAUSE: 9,
  RESUME: 10,
} as const;
export const RELAY_READY = 'FULLDOTS-READY';
/** Printed by the server's shell before the relay starts, when it cannot start. */
export const RELAY_FAIL = 'FULLDOTS-FAIL';
export const RELAY_HEADER = 9;
export const RELAY_CHUNK = 64 * 1024;
const MAX_FRAME = 1024 * 1024;

export function frame(type: number, id: number, payload?: Buffer | string) {
  const body =
    payload === undefined
      ? Buffer.alloc(0)
      : typeof payload === 'string'
        ? Buffer.from(payload, 'utf8')
        : payload;
  const head = Buffer.alloc(RELAY_HEADER);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(id >>> 0, 1);
  head.writeUInt32BE(body.length, 5);
  return Buffer.concat([head, body]);
}

/** Splits a byte stream into frames. Throws on a frame no peer of ours would send. */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);
  push(
    chunk: Buffer,
    each: (type: number, id: number, payload: Buffer) => void,
  ) {
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : chunk;
    while (this.buffer.length >= RELAY_HEADER) {
      const length = this.buffer.readUInt32BE(5);
      if (length > MAX_FRAME) throw new Error('Relay frame too large.');
      if (this.buffer.length < RELAY_HEADER + length) return;
      const type = this.buffer.readUInt8(0);
      const id = this.buffer.readUInt32BE(1);
      const payload = this.buffer.subarray(RELAY_HEADER, RELAY_HEADER + length);
      this.buffer = this.buffer.subarray(RELAY_HEADER + length);
      each(type, id, payload);
    }
  }
}

/** A TCP socket as the relay uses it (node:net in Bun on the server, or a test double). */
export interface RelaySocket {
  write(data: Buffer): boolean;
  end(): void;
  destroy(): void;
  pause(): void;
  resume(): void;
  on(event: 'data', listener: (data: Buffer) => void): unknown;
  on(event: 'drain' | 'close' | 'connect', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface RelayIO {
  input: {
    on(event: 'data', listener: (data: Buffer) => void): unknown;
    on(event: 'end', listener: () => void): unknown;
  };
  /** Writes to the ssh channel; false means wait for `onDrain`. */
  write(data: Buffer | string): boolean;
  onDrain(listener: () => void): void;
  /** Connects to a loopback address of the server. Nothing else is ever dialled. */
  connect(port: number, host: '127.0.0.1' | '::1'): RelaySocket;
  /** GET on the server's Docker API; null for 404. */
  docker(path: string): Promise<unknown>;
  namespace: string;
  supervisorImage: string;
  exit(code: number): void;
}

/** The relay itself. Self-contained: it is sent to the server as `fulldotsRelay.toString()`. */
export async function fulldotsRelay(io: RelayIO): Promise<void> {
  const T = {
    OPEN: 2,
    OPENED: 3,
    FAIL: 4,
    DATA: 5,
    CLOSE: 6,
    REQ: 7,
    RES: 8,
    PAUSE: 9,
    RESUME: 10,
  };
  const SUPERVISOR = 'fulldots-computer-supervisor';
  const SUPERVISOR_PORT = 4312;
  const LOOPBACK = ['127.0.0.1', '::1'];
  const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
  const IMAGE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
  const send = (type: number, id: number, payload?: Buffer | string) => {
    const body =
      payload === undefined
        ? Buffer.alloc(0)
        : typeof payload === 'string'
          ? Buffer.from(payload, 'utf8')
          : payload;
    const head = Buffer.alloc(9);
    head.writeUInt8(type, 0);
    head.writeUInt32BE(id >>> 0, 1);
    head.writeUInt32BE(body.length, 5);
    return io.write(Buffer.concat([head, body]));
  };
  const streams = new Map<number, RelaySocket>();
  let blocked = false;
  const flowed = (ok: boolean) => {
    if (ok || blocked) return;
    blocked = true;
    for (const socket of streams.values()) socket.pause();
    io.onDrain(() => {
      blocked = false;
      for (const socket of streams.values()) socket.resume();
    });
  };
  type Port = { IP?: string; PrivatePort?: number; PublicPort?: number };
  type Listed = {
    Names?: string[];
    Image?: string;
    State?: string;
    Labels?: Record<string, string>;
    Ports?: Port[];
  };
  const published = (ports: Port[] | undefined) =>
    (ports ?? []).filter((port) => port.PublicPort);
  /** The loopback address this port may be reached on for this owner, or a reason it may not. */
  const allowed = async (
    owner: string,
    port: number,
  ): Promise<{ host: '127.0.0.1' | '::1' } | { reason: string }> => {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return { reason: 'invalid port' };
    if (owner === 'supervisor') {
      if (port !== SUPERVISOR_PORT)
        return { reason: 'not the supervisor port' };
      const list = (await io.docker(
        `/containers/json?filters=${encodeURIComponent(JSON.stringify({ name: [SUPERVISOR] }))}`,
      )) as Listed[] | null;
      const found = (list ?? []).find((item) =>
        (item.Names ?? []).includes(`/${SUPERVISOR}`),
      );
      if (!found || found.State !== 'running')
        return { reason: 'the supervisor is not running' };
      if (found.Image !== io.supervisorImage)
        return { reason: 'the supervisor runs another image' };
      const ports = published(found.Ports);
      if (ports.some((item) => !LOOPBACK.includes(item.IP ?? '')))
        return { reason: 'the supervisor publishes a public port' };
      const hit = ports.find(
        (item) => item.PrivatePort === 4300 && item.PublicPort === port,
      );
      return hit
        ? { host: hit.IP === '::1' ? '::1' : '127.0.0.1' }
        : { reason: 'the supervisor does not publish that port' };
    }
    if (!NAME.test(owner)) return { reason: 'invalid owner' };
    const list = (await io.docker(
      `/containers/json?filters=${encodeURIComponent(
        JSON.stringify({
          label: ['openbot.supervisor=true', `openbot.bot-id=${owner}`],
        }),
      )}`,
    )) as Listed[] | null;
    const mine = (list ?? []).filter(
      (item) =>
        (item.Labels?.['openbot.namespace'] ?? 'openbot') === io.namespace &&
        (item.Names ?? []).includes(`/${io.namespace}-computer-${owner}`),
    );
    if (mine.length !== 1)
      return { reason: 'no running computer for that Dot' };
    const computer = mine[0]!;
    if (computer.State !== 'running')
      return { reason: 'the computer is not running' };
    const ports = published(computer.Ports);
    if (ports.some((item) => !LOOPBACK.includes(item.IP ?? '')))
      return { reason: 'the computer publishes a public port' };
    const hit = ports.find(
      (item) => item.PrivatePort === 4100 && item.PublicPort === port,
    );
    return hit
      ? { host: hit.IP === '::1' ? '::1' : '127.0.0.1' }
      : { reason: 'that port is not this Dot’s computer' };
  };
  const facts = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return null;
    const info = raw as {
      Name?: string;
      Config?: { Image?: string; Labels?: Record<string, string> };
      State?: { Running?: boolean; Health?: { Status?: string } };
      HostConfig?: Record<string, unknown>;
      NetworkSettings?: { Ports?: unknown };
      Mounts?: { Type?: string; Source?: string; Destination?: string }[];
    };
    const host = info.HostConfig ?? {};
    // Never the environment: it holds the computer's credential.
    return {
      name: info.Name,
      image: info.Config?.Image,
      labels: info.Config?.Labels ?? {},
      running: info.State?.Running === true,
      health: info.State?.Health?.Status ?? null,
      capDrop: host.CapDrop ?? null,
      capAdd: host.CapAdd ?? null,
      securityOpt: host.SecurityOpt ?? null,
      memory: host.Memory ?? 0,
      pidsLimit: host.PidsLimit ?? null,
      privileged: host.Privileged === true,
      networkMode: host.NetworkMode ?? '',
      pidMode: host.PidMode ?? '',
      ipcMode: host.IpcMode ?? '',
      usernsMode: host.UsernsMode ?? '',
      devices: host.Devices ?? null,
      runtime: host.Runtime ?? '',
      portBindings: host.PortBindings ?? null,
      ports: info.NetworkSettings?.Ports ?? null,
      mounts: (info.Mounts ?? []).map((mount) => ({
        type: mount.Type,
        source: mount.Source,
        destination: mount.Destination,
      })),
    };
  };
  const answer = async (id: number, payload: Buffer) => {
    let result: unknown;
    try {
      const request = JSON.parse(payload.toString('utf8')) as {
        verb?: string;
        arg?: string;
      };
      const arg = String(request.arg ?? '');
      if (request.verb === 'inspect' && NAME.test(arg))
        result = {
          facts: facts(
            await io.docker(`/containers/${encodeURIComponent(arg)}/json`),
          ),
        };
      else if (request.verb === 'image' && IMAGE.test(arg)) {
        const image = (await io.docker(
          `/images/${encodeURIComponent(arg)}/json`,
        )) as {
          Id?: string;
        } | null;
        result = { id: image?.Id ?? null };
      } else result = { error: 'refused' };
    } catch {
      result = { error: 'docker' };
    }
    flowed(send(T.RES, id, JSON.stringify(result)));
  };
  const open = async (id: number, payload: Buffer) => {
    let request: { port?: number; owner?: string };
    try {
      request = JSON.parse(payload.toString('utf8'));
    } catch {
      flowed(send(T.FAIL, id, 'bad request'));
      return;
    }
    let verdict: { host: '127.0.0.1' | '::1' } | { reason: string };
    try {
      verdict = await allowed(
        String(request.owner ?? ''),
        Number(request.port),
      );
    } catch {
      verdict = { reason: 'docker did not answer' };
    }
    if ('reason' in verdict) {
      flowed(send(T.FAIL, id, verdict.reason));
      return;
    }
    const socket = io.connect(Number(request.port), verdict.host);
    streams.set(id, socket);
    let opened = false;
    socket.on('connect', () => {
      opened = true;
      flowed(send(T.OPENED, id));
    });
    socket.on('data', (data: Buffer) => {
      for (let at = 0; at < data.length; at += 65536)
        flowed(send(T.DATA, id, data.subarray(at, at + 65536)));
    });
    socket.on('drain', () => flowed(send(T.RESUME, id)));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (!streams.has(id)) return;
      streams.delete(id);
      flowed(
        opened ? send(T.CLOSE, id) : send(T.FAIL, id, 'connection refused'),
      );
    });
    if (blocked) socket.pause();
  };
  let buffer: Buffer = Buffer.alloc(0);
  io.input.on('data', (chunk: Buffer) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (buffer.length >= 9) {
      const length = buffer.readUInt32BE(5);
      if (length > 1024 * 1024) return io.exit(2);
      if (buffer.length < 9 + length) return;
      const type = buffer.readUInt8(0);
      const id = buffer.readUInt32BE(1);
      const payload = Buffer.from(buffer.subarray(9, 9 + length));
      buffer = buffer.subarray(9 + length);
      const socket = streams.get(id);
      if (type === T.OPEN) void open(id, payload);
      else if (type === T.REQ) void answer(id, payload);
      else if (type === T.DATA && socket) {
        if (!socket.write(payload)) flowed(send(T.PAUSE, id));
      } else if (type === T.CLOSE && socket) {
        streams.delete(id);
        socket.end();
      } else if (type === T.PAUSE && socket) socket.pause();
      else if (type === T.RESUME && socket && !blocked) socket.resume();
    }
  });
  // The session ended (FullDots stopped or ssh died): close everything and leave.
  io.input.on('end', () => {
    for (const socket of streams.values()) socket.destroy();
    streams.clear();
    io.exit(0);
  });
  io.write('FULLDOTS-READY\n');
}

/** How the relay starts inside its container on the server (Bun, in the pinned supervisor image). */
const BOOTSTRAP = `const __name = (target) => target;
const net = await import('node:net');
const io = {
  input: process.stdin,
  write: (data) => process.stdout.write(data),
  onDrain: (listener) => process.stdout.once('drain', listener),
  connect: (port, host) => net.connect({ port, host }),
  docker: async (path) => {
    const response = await fetch('http://docker' + path, { unix: '/var/run/docker.sock' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('docker ' + response.status);
    return response.json();
  },
  namespace: process.env.FULLDOTS_NAMESPACE,
  supervisorImage: process.env.FULLDOTS_SUPERVISOR_IMAGE,
  exit: (code) => process.exit(code),
};
await (${fulldotsRelay.toString()})(io);
`;

/**
 * The command for the server's shell. It checks Docker and the supervisor image first and says
 * why on one line when either is missing; then it replaces itself with the relay container. The
 * relay's source travels as base64 in an argument, so no quoting can change it.
 */
export function relayCommand(options: {
  namespace: string;
  supervisorImage: string;
}): string {
  const source = Buffer.from(BOOTSTRAP, 'utf8').toString('base64');
  return [
    `out=$(docker version --format '{{.Server.Version}}' 2>&1) || { printf '${RELAY_FAIL} docker %s\\n' "$(printf '%s' "$out" | head -c 300 | tr '\\n' ' ')"; exit 3; }`,
    `docker image inspect ${options.supervisorImage} >/dev/null 2>&1 || { echo '${RELAY_FAIL} image'; exit 4; }`,
    `gid=$(stat -c %g /var/run/docker.sock) || { echo '${RELAY_FAIL} docker no socket'; exit 3; }`,
    [
      'exec docker run --rm -i --log-driver none --label fulldots.remote-relay=true',
      '--network host --cap-drop ALL --security-opt no-new-privileges:true --read-only',
      '--tmpfs /tmp:size=16m --memory 256m --pids-limit 64 --user 65534:65534 --group-add "$gid"',
      '-v /var/run/docker.sock:/var/run/docker.sock',
      `-e HOME=/tmp -e FULLDOTS_NAMESPACE=${options.namespace} -e FULLDOTS_SUPERVISOR_IMAGE=${options.supervisorImage}`,
      `--entrypoint sh ${options.supervisorImage}`,
      `-c 'exec bun -e "$(printf %s "$0" | base64 -d)"' ${source}`,
    ].join(' '),
  ].join('\n');
}
