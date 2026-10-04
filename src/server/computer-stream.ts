import { STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  WebSocket,
  WebSocketServer,
  type ClientOptions,
  type RawData,
} from 'ws';
import type { ComputerService } from './computer-service.js';
import type {
  ComputerStreamEndReason,
  ComputerStreamMessage,
} from '../shared/computer-types.js';
import { originAllowed } from './origins.js';

/**
 * The owner's live view of a Dot's computer.
 *
 * The computer streams Chrome's screencast over a WebSocket and takes input on the same socket, but
 * that socket is authenticated with a credential which must never reach a browser. This relays it:
 * the owner connects here, the server connects to the computer, and frames and input pass through.
 *
 * What the relay adds, in the order a connection meets it:
 * - the host and origin rules the HTTP API applies, plus a one-time ticket in place of the owner
 *   token, which a browser cannot put on an upgrade (see `ComputerService.streamTicket`);
 * - Browser permission, checked again every second so revoking it ends an open screen;
 * - one screen per Dot, the same rule the computer itself applies;
 * - validated, rate-limited input, so the computer never sees what the schema does not allow;
 * - bounded memory: a slow viewer drops frames rather than queueing them.
 */

const STREAM_PATH = /^\/api\/dots\/([^/]+)\/computer\/stream$/;
const DOT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A frame is a JPEG in base64. This is generous for the computer's 1280x800 cap. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** Control messages from the computer are short. Anything longer that is not a frame is dropped. */
const MAX_CONTROL_BYTES = 8 * 1024;
/** Unsent bytes at which a viewer is considered slow and frames start being replaced. */
const MAX_VIEWER_BACKLOG = 2 * 1024 * 1024;
const FRAME_PREFIX = '{"type":"frame"';
const PERMISSION_CHECK_MS = 1000;
const HEARTBEAT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 10_000;
/** Input is bursty (a drag, a held key) but never legitimately this fast for long. */
const INPUT_BURST = 400;
const INPUT_PER_SECOND = 400;
/** Texts the computer sends when the screen is no longer this viewer's, or the computer is gone. */
const SUPERSEDED_BY_COMPUTER = /now being watched somewhere else/;
const NO_LONGER_LIVE_BY_COMPUTER = /no longer live/;
const STOPPED_BY_COMPUTER = /^This computer stopped/;

export interface UpgradeServer {
  on(
    event: 'upgrade',
    listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): unknown;
}

export interface ComputerStreamOptions {
  computers: ComputerService;
  /** Set when the app requires an owner token, which relaxes the localhost-only host rule. */
  ownerToken?: string;
  /** The origin the app is served from, when it is not simply the request's own host. */
  origin?: string;
  /** Opens the connection to the computer. A seam for tests. */
  connect?: (url: string, options: ClientOptions) => WebSocket;
}

function text(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as Buffer).toString('utf8');
}

function refuse(socket: Duplex, status: number, error: string) {
  const body = JSON.stringify({ error });
  socket.on('error', () => undefined);
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\n` +
      'Connection: close\r\nContent-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

export function attachComputerStream(
  server: UpgradeServer,
  options: ComputerStreamOptions,
) {
  const { computers } = options;
  const connect =
    options.connect ??
    ((url: string, clientOptions: ClientOptions) =>
      new WebSocket(url, clientOptions));
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: computers.streamInputBytes,
    perMessageDeflate: false,
    clientTracking: false,
  });
  /** Open screens by Dot. A second viewer replaces the first rather than sharing the cast. */
  const live = new Map<string, { end: Ending }>();
  type Ending = (
    reason: ComputerStreamEndReason,
    message: string,
    code?: number,
  ) => void;

  /** The same host and origin rules as the HTTP API (see app.ts). */
  function admitted(
    request: IncomingMessage,
    socket: Duplex,
  ): string | undefined {
    let host: URL;
    try {
      host = new URL(`http://${request.headers.host ?? ''}`);
    } catch {
      return 'Unrecognized host.';
    }
    const allowedHosts = new Set([
      'localhost',
      '127.0.0.1',
      '[::1]',
      ...(options.origin ? [new URL(options.origin).hostname] : []),
    ]);
    if (!options.ownerToken && !allowedHosts.has(host.hostname))
      return 'Unrecognized host.';
    const scheme = 'encrypted' in socket && socket.encrypted ? 'https' : 'http';
    const expectedOrigin = options.origin ?? `${scheme}://${host.host}`;
    const origin = request.headers.origin;
    if (origin && !originAllowed(origin, expectedOrigin))
      return 'Cross-origin requests are not allowed.';
    if (request.headers['sec-fetch-site'] === 'cross-site')
      return 'Cross-site requests are not allowed.';
    return undefined;
  }

  server.on('upgrade', (request, socket, head) => {
    // Anything that is not the live screen has no WebSocket handler in this server.
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      return refuse(socket, 400, 'Bad request.');
    }
    const match = STREAM_PATH.exec(url.pathname);
    if (!match) return refuse(socket, 404, 'Not found.');
    const refusal = admitted(request, socket);
    if (refusal) return refuse(socket, 403, refusal);
    let dotId: string;
    try {
      dotId = decodeURIComponent(match[1]);
    } catch {
      return refuse(socket, 400, 'Bad request.');
    }
    // A ticket is consumed by being looked at, so a refused request cannot be retried with it.
    const ticket = url.searchParams.get('ticket') ?? '';
    const ticketDot = ticket ? computers.redeemStreamTicket(ticket) : undefined;
    if (!DOT_ID.test(dotId) || !ticketDot || ticketDot !== dotId)
      return refuse(socket, 401, 'Open the live screen again.');
    wss.handleUpgrade(request, socket, head, (client) => relay(client, dotId));
  });

  function relay(client: WebSocket, dotId: string) {
    const abort = new AbortController();
    const timers = new Set<ReturnType<typeof setInterval>>();
    let upstream: WebSocket | undefined;
    let redact = (value: string) => value;
    let closed = false;
    let clientAlive = true;
    let upstreamAlive = true;
    let lastUpstreamError = '';
    let waitingFrame: string | undefined;
    let flushTimer: ReturnType<typeof setInterval> | undefined;
    let tokens = INPUT_BURST;
    let refilled = Date.now();
    let lastNotice = 0;

    const send = (message: ComputerStreamMessage | string) => {
      if (client.readyState !== WebSocket.OPEN) return;
      try {
        client.send(
          typeof message === 'string' ? message : JSON.stringify(message),
        );
      } catch {
        // The viewer is gone; its close event finishes the teardown.
      }
    };
    /** Tells the viewer, at most once a second, why input did nothing. */
    const notice = (error: string) => {
      const now = Date.now();
      if (now - lastNotice < 1000) return;
      lastNotice = now;
      send({ type: 'error', error });
    };

    const end: Ending = (reason, message, code = 1000) => {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearInterval(timer);
      timers.clear();
      if (flushTimer) clearInterval(flushTimer);
      abort.abort();
      if (live.get(dotId)?.end === end) live.delete(dotId);
      if (client.readyState === WebSocket.OPEN) {
        send({ type: 'ended', reason, message });
        client.close(code);
      }
      upstream?.terminate();
    };

    const previous = live.get(dotId);
    live.set(dotId, { end });
    previous?.end(
      'superseded',
      'This screen is now being watched somewhere else, so it stopped here.',
    );

    client.on('error', () => end('unavailable', 'The connection failed.'));
    client.on('close', () => end('unavailable', 'The connection closed.'));
    client.on('pong', () => {
      clientAlive = true;
    });

    const deliver = (frame: string) => {
      if (client.bufferedAmount > MAX_VIEWER_BACKLOG) {
        // The newest frame is the only one worth sending once the viewer catches up.
        waitingFrame = frame;
        flushTimer ??= setInterval(() => {
          if (client.bufferedAmount <= MAX_VIEWER_BACKLOG / 2 && waitingFrame) {
            const next = waitingFrame;
            waitingFrame = undefined;
            send(next);
          }
          if (!waitingFrame && flushTimer) {
            clearInterval(flushTimer);
            flushTimer = undefined;
          }
        }, 50);
        return;
      }
      waitingFrame = undefined;
      send(frame);
    };

    client.on('message', (data, isBinary) => {
      if (isBinary || upstream?.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      tokens = Math.min(
        INPUT_BURST,
        tokens + ((now - refilled) / 1000) * INPUT_PER_SECOND,
      );
      refilled = now;
      if (tokens < 1) return notice('Input is arriving too fast.');
      tokens -= 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text(data));
      } catch {
        return notice('Input is not JSON.');
      }
      const input = computers.streamInput.safeParse(parsed);
      if (!input.success) return notice('That input was not understood.');
      // Re-serialized from the parsed value, so only the schema's fields go any further.
      upstream.send(JSON.stringify(input.data));
    });

    timers.add(
      setInterval(() => {
        if (!computers.streamAllowed(dotId))
          end('permission', 'Browser access for this computer was turned off.');
      }, PERMISSION_CHECK_MS),
    );
    timers.add(
      setInterval(() => {
        if (!clientAlive || (upstream && !upstreamAlive))
          return end('unavailable', 'The connection was lost.');
        clientAlive = false;
        upstreamAlive = false;
        if (client.readyState === WebSocket.OPEN) client.ping();
        if (upstream?.readyState === WebSocket.OPEN) upstream.ping();
      }, HEARTBEAT_MS),
    );

    void (async () => {
      let target;
      try {
        target = await computers.openStream(dotId, abort.signal);
      } catch (error) {
        if (closed) return;
        const known =
          error instanceof Error && error.name !== 'ZodError'
            ? error.message
            : 'The live screen could not be started.';
        return end('unavailable', known);
      }
      if (closed) return;
      redact = target.redact;
      const socket = connect(target.url, {
        headers: { 'x-openbot-bot-id': dotId },
        handshakeTimeout: CONNECT_TIMEOUT_MS,
        maxPayload: MAX_FRAME_BYTES,
        perMessageDeflate: false,
        followRedirects: false,
      });
      upstream = socket;
      socket.on('pong', () => {
        upstreamAlive = true;
      });
      socket.on('message', (data, isBinary) => {
        if (isBinary) return;
        const body = text(data);
        if (body.startsWith(FRAME_PREFIX)) return deliver(body);
        if (body.length > MAX_CONTROL_BYTES) return;
        let message: unknown;
        try {
          message = JSON.parse(body);
        } catch {
          return;
        }
        if (
          typeof message !== 'object' ||
          message === null ||
          (message as { type?: unknown }).type !== 'error' ||
          typeof (message as { error?: unknown }).error !== 'string'
        )
          return;
        const error = redact((message as { error: string }).error).slice(
          0,
          300,
        );
        // The computer does not close a socket it supersedes; it only says so.
        if (
          SUPERSEDED_BY_COMPUTER.test(error) ||
          NO_LONGER_LIVE_BY_COMPUTER.test(error)
        )
          return end('superseded', error);
        if (STOPPED_BY_COMPUTER.test(error)) return end('stopped', error);
        lastUpstreamError = error;
        send({ type: 'error', error });
      });
      socket.on('error', (error) => {
        if (closed) return;
        // Names the failure, never its text: it can carry the address, and the address carries a key.
        console.error(
          'Computer screen failed:',
          (error as NodeJS.ErrnoException).code ?? 'connection error',
        );
        end('unavailable', 'The computer’s screen could not be reached.');
      });
      socket.on('close', () =>
        end('stopped', lastUpstreamError || 'The computer’s screen ended.'),
      );
    })();
  }

  return {
    /** Ends every open screen. The HTTP server cannot finish closing while any socket is open. */
    close() {
      for (const { end } of [...live.values()])
        end('shutdown', 'FullDots is shutting down.', 1001);
      wss.close();
    },
  };
}
