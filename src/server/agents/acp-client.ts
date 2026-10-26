import { Readable, Writable } from 'node:stream';
import { WebSocket, createWebSocketStream } from 'ws';
import {
  bridgeReasons,
  type CodingProviderId,
  CodingBridgeError,
  CodingModeError,
  unsafePermissionOption,
} from './acp-policy.js';
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

/**
 * `mode` is the only permission mode the app ever selects. It must be the one that asks before
 * changes: Claude Code's `default`, and Codex's `read-only` (read-only sandbox, the owner approves
 * edits and escalations). Codex's other presets edit the workspace or review actions by themselves.
 * `mustReport` means the worker has to list that mode in `session/new`; if it does not, the app
 * cannot confirm an ask-first mode and stops before sending a prompt.
 */
export const codingProviders = {
  claude: {
    label: 'Claude Code',
    cwd: '/workspace',
    mode: 'default',
    mustReport: false,
  },
  codex: {
    label: 'Codex',
    cwd: '/workspace',
    mode: 'read-only',
    mustReport: true,
  },
} as const satisfies Record<
  CodingProviderId,
  { label: string; cwd: string; mode: string; mustReport: boolean }
>;
export type CodingProvider = CodingProviderId;

/** Tells the computer bridge which coding agent to start. Absent means Claude Code. */
export const codingProviderHeader = 'x-fulldots-coding-provider';

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
    modes: readonly string[],
    signal: AbortSignal,
  ) => Promise<RequestPermissionResponse>;
  update: (notification: SessionNotification) => void;
  session: (id: string) => void;
}

export async function runAcp(options: AcpRunOptions) {
  const config = codingProviders[options.provider];
  let sessionId: string | undefined;
  let modes: string[] = [];
  let modeError: CodingModeError | undefined;
  let cancelling: Promise<void> | undefined;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  const app = client({ name: 'fulldots-coding-worker' })
    .onRequest(
      methods.client.session.requestPermission,
      async ({ params, signal }) => {
        if (
          params.sessionId === sessionId &&
          !options.signal.aborted &&
          !modeError
        ) {
          try {
            const result = await options.permission(params, modes, signal);
            const outcome = result.outcome;
            if (outcome.outcome === 'selected') {
              const option = params.options.find(
                (item) => item.optionId === outcome.optionId,
              );
              if (
                !option ||
                !['allow_once', 'reject_once'].includes(option.kind) ||
                unsafePermissionOption(option.optionId, modes) ||
                modeError
              )
                return { outcome: { outcome: 'cancelled' } };
            }
            return result;
          } catch {
            /* Approval failures never grant access. */
          }
        }
        return { outcome: { outcome: 'cancelled' } };
      },
    )
    .onNotification(methods.client.session.update, ({ params }) => {
      if (
        !sessionId &&
        params.update.sessionUpdate === 'current_mode_update' &&
        params.update.currentModeId !== config.mode
      ) {
        modeError = new CodingModeError();
        return;
      }
      if (params.sessionId === sessionId) {
        if (
          params.update.sessionUpdate === 'current_mode_update' &&
          params.update.currentModeId !== config.mode
        ) {
          modeError = new CodingModeError();
          cancel();
          return;
        }
        if (!modeError) options.update(params);
      }
    });
  const connection =
    'readable' in options.target
      ? app.connect(options.target)
      : app.connect(options.target);
  const cancel = () => {
    if (sessionId) {
      cancelling ??= connection.agent
        .notify(methods.agent.session.cancel, { sessionId })
        .catch(() => undefined);
      // Give the notification a chance to reach the adapter before closing its pipe.
      cancelTimer ??= setTimeout(() => connection.close(), 100);
      cancelTimer.unref();
    } else connection.close();
  };
  options.signal.addEventListener('abort', cancel, { once: true });
  try {
    options.signal.throwIfAborted();
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
      // Claude Code's session options. Codex takes no per-session settings from the app.
      ...(options.provider === 'claude'
        ? {
            _meta: {
              claudeCode: {
                options: {
                  settingSources: [],
                  allowDangerouslySkipPermissions: false,
                  extraArgs: { 'strict-mcp-config': '' },
                },
              },
            },
          }
        : {}),
    });
    sessionId = session.sessionId;
    modes = session.modes?.availableModes.map((mode) => mode.id) ?? [];
    options.session(sessionId);
    // Claude Code starts in `default`. Codex may start in another preset, so the app selects the
    // ask-first one below, but only if the worker lists it.
    const startsWrong =
      options.provider === 'claude' &&
      !!session.modes &&
      session.modes.currentModeId !== config.mode;
    const cannotConfirm = config.mustReport && !modes.includes(config.mode);
    if (modeError || startsWrong || cannotConfirm) {
      modeError ??= new CodingModeError();
      cancel();
      throw modeError;
    }
    options.signal.throwIfAborted();
    await connection.agent.request(methods.agent.session.setMode, {
      sessionId,
      modeId: config.mode,
    });
    if (modeError) throw modeError;
    const response = await connection.agent.request(
      methods.agent.session.prompt,
      {
        sessionId,
        prompt: [{ type: 'text', text: options.task }],
      },
    );
    if (modeError) throw modeError;
    return response;
  } catch (error) {
    throw modeError ?? error;
  } finally {
    options.signal.removeEventListener('abort', cancel);
    await cancelling;
    clearTimeout(cancelTimer);
    connection.close();
  }
}

/** Ready is a bridge control frame; all following frames are the adapter's NDJSON byte stream. */
export async function connectCodingBridge(
  target: { url: string; headers: Record<string, string> },
  signal: AbortSignal,
  provider: CodingProvider = 'claude',
): Promise<{ stream: Stream; close: () => void }> {
  signal.throwIfAborted();
  const socket = new WebSocket(target.url, {
    headers: { ...target.headers, [codingProviderHeader]: provider },
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
      const timer = setTimeout(() => fail(), 190_000);
      const fail = (reason?: unknown) => {
        cleanup();
        const message =
          typeof reason === 'string' && bridgeReasons.has(reason)
            ? reason
            : 'Coding bridge is unavailable.';
        reject(new CodingBridgeError(message));
      };
      const closed = (_code: number, reason: Buffer) =>
        fail(reason.toString('utf8'));
      const refused = (
        _request: unknown,
        response: import('node:http').IncomingMessage,
      ) => {
        response.resume();
        cleanup();
        reject(
          new CodingBridgeError(
            response.statusCode === 409
              ? 'A coding task is already running for this Dot.'
              : 'Coding bridge is unavailable.',
          ),
        );
      };
      const ready = (data: Buffer) => {
        try {
          const frame = JSON.parse(data.toString());
          if (frame.bridgeReady !== true) return fail();
          // An older computer image ignores the provider header and always starts Claude Code.
          if ((frame.provider ?? 'claude') !== provider) {
            cleanup();
            reject(
              new CodingBridgeError(
                `${codingProviders[provider].label} is not available in this computer image. Rebuild the computer image and restart the computer.`,
              ),
            );
            return;
          }
          cleanup();
          resolve();
        } catch {
          fail();
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('message', ready);
        socket.off('close', closed);
        socket.off('error', fail);
        socket.off('unexpected-response', refused);
      };
      socket.once('message', ready);
      socket.once('close', closed);
      socket.once('error', fail);
      socket.once('unexpected-response', refused);
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
