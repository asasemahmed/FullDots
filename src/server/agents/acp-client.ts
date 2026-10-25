import { Readable, Writable } from 'node:stream';
import { WebSocket, createWebSocketStream } from 'ws';
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentApp,
  type Stream,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';

export const codingProviders = {
  claude: { label: 'Claude Code', cwd: '/workspace', mode: 'default' },
} as const;
export type CodingProvider = keyof typeof codingProviders;

export function authenticationRequired(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === -32000 &&
    'message' in error &&
    typeof error.message === 'string' &&
    /Authentication required/i.test(error.message)
  );
}

export interface AcpRunOptions {
  target: Stream | AgentApp;
  provider: CodingProvider;
  task: string;
  signal: AbortSignal;
  permission: (
    request: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>;
  update: (notification: SessionNotification) => void;
  session: (id: string) => void;
}

export async function runAcp(options: AcpRunOptions) {
  let sessionId: string | undefined;
  const app = client({ name: 'fulldots-coding-worker' })
    .onRequest(methods.client.session.requestPermission, async ({ params }) => {
      if (params.sessionId === sessionId && !options.signal.aborted) {
        try {
          return await options.permission(params);
        } catch {
          /* Approval failures never grant access. */
        }
      }
      return { outcome: { outcome: 'cancelled' } };
    })
    .onNotification(methods.client.session.update, ({ params }) => {
      if (params.sessionId === sessionId) options.update(params);
    });
  const connection =
    'readable' in options.target
      ? app.connect(options.target)
      : app.connect(options.target);
  const cancel = () => {
    if (sessionId) {
      void connection.agent
        .notify(methods.agent.session.cancel, { sessionId })
        .catch(() => undefined);
      // Give the notification a chance to reach the adapter before closing its pipe.
      const timer = setTimeout(() => connection.close(), 100);
      timer.unref();
    } else connection.close();
  };
  options.signal.addEventListener('abort', cancel, { once: true });
  try {
    options.signal.throwIfAborted();
    const config = codingProviders[options.provider];
    const initialized = await connection.agent.request(
      methods.agent.initialize,
      {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'FullDots', version: '2.0.0' },
      },
    );
    if (initialized.protocolVersion !== PROTOCOL_VERSION)
      throw new Error('Unsupported coding protocol version.');
    const session = await connection.agent.request(methods.agent.session.new, {
      cwd: config.cwd,
      mcpServers: [],
    });
    sessionId = session.sessionId;
    options.session(sessionId);
    options.signal.throwIfAborted();
    await connection.agent.request(methods.agent.session.setMode, {
      sessionId,
      modeId: config.mode,
    });
    return await connection.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: 'text', text: options.task }],
    });
  } finally {
    options.signal.removeEventListener('abort', cancel);
    if (options.signal.aborted && sessionId) {
      await connection.agent
        .notify(methods.agent.session.cancel, { sessionId })
        .catch(() => undefined);
    }
    connection.close();
  }
}

/** Ready is a bridge control frame; all following frames are the adapter's NDJSON byte stream. */
export async function connectCodingBridge(
  target: { url: string; headers: Record<string, string> },
  signal: AbortSignal,
): Promise<{ stream: Stream; close: () => void }> {
  signal.throwIfAborted();
  const socket = new WebSocket(target.url, {
    headers: target.headers,
    maxPayload: 1024 * 1024,
    followRedirects: false,
    perMessageDeflate: false,
    handshakeTimeout: 10_000,
  });
  socket.on('error', () => undefined);
  const abort = () => socket.terminate();
  signal.addEventListener('abort', abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail(), 180_000);
      const fail = () => {
        cleanup();
        reject(new Error('Coding bridge is unavailable.'));
      };
      const ready = (data: Buffer) => {
        try {
          if (JSON.parse(data.toString()).bridgeReady !== true) return fail();
          cleanup();
          resolve();
        } catch {
          fail();
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('message', ready);
        socket.off('close', fail);
        socket.off('error', fail);
      };
      socket.once('message', ready);
      socket.once('close', fail);
      socket.once('error', fail);
      if (signal.aborted) fail();
    });
    signal.throwIfAborted();
    signal.removeEventListener('abort', abort);
    const duplex = createWebSocketStream(socket);
    // NDJSON parsing is bounded even if a peer sends a never-ending line across many frames.
    const stream = ndJsonStream(
      Writable.toWeb(duplex) as WritableStream<Uint8Array>,
      Readable.toWeb(duplex) as ReadableStream<Uint8Array>,
      { maxMessageBytes: 1024 * 1024 },
    );
    return {
      stream,
      close: () => {
        signal.removeEventListener('abort', abort);
        socket.terminate();
      },
    };
  } catch (error) {
    signal.removeEventListener('abort', abort);
    socket.terminate();
    throw error;
  }
}
