import { createHash, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  computerInputSchemas,
  computerStreamInputSchema,
  type ComputerInputLimits,
  type ComputerInputs,
  computerPermissionsSchema,
  type ComputerPermissions,
  replayEnabled,
  type ComputerAction,
  type ComputerControl,
  type ComputerStatus,
  type ComputerStreamTicket,
} from '../shared/computer-types.js';
import type { WorkspaceStore } from './workspace.js';
import type { HandoffStore } from './handoff-store.js';
import { defaultLimits } from './limits.js';
import type { PlatformConfig } from './platform-config.js';
import {
  ComputerActionError,
  ComputerConflictError,
  classifyConflict,
  failureReason,
} from './computer-conflict.js';
import { ComputerError } from './computer-errors.js';
export { ComputerConflictError } from './computer-conflict.js';
export { ComputerError } from './computer-errors.js';
import { liveFrames, type LiveFrames } from './computer-frames.js';
import { keyframeFromPng } from './frame-image.js';
import {
  removeCommand,
  UnsafeComputerError,
  type DotTarget,
  type RemoteComputers,
} from './remote-computers.js';
import { validAlias } from './remote-ssh.js';
import type { RemoteSetup } from './remote-setup.js';
import type {
  ComputerMoveResult,
  ComputerWhere,
} from '../shared/remote-computer-types.js';
const stateSchema = z.object({
  botId: z.string(),
  container: z.string(),
  status: z.string(),
  port: z.number().int().min(1024).max(65535).optional(),
  url: z.string().optional(),
});
const controlSchema = z.object({
  revision: z.number().int().nonnegative().optional(),
  holder: z.enum(['bot', 'human']),
  requested: z.boolean(),
  transitioning: z.boolean(),
  resumeSnapshotRequired: z.boolean(),
  request: z.object({ id: z.string(), status: z.string() }).optional(),
});
/** How long a live-screen ticket may wait before it is used. It works once. */
const STREAM_TICKET_TTL_MS = 20_000;
/** Bounds the unredeemed tickets, which only the authenticated owner can create. */
const MAX_STREAM_TICKETS = 64;
const hashTicket = (ticket: string) =>
  createHash('sha256').update(ticket).digest('hex');
export interface ComputerStreamTarget {
  /** The computer's own WebSocket address. It carries a credential, so it never leaves the server. */
  url: string;
  /** Strips this computer's credentials from text that came back from it. */
  redact: (text: string) => string;
}
/** Which tool call of which conversation a browser step belongs to, for the replay. */
export interface ReplayContext {
  threadId: string;
  toolCallId: string;
}
/** Steps that change the page, so a picture of the screen after them is worth keeping. */
const REPLAY_ACTIONS = new Set<string>([
  'navigate',
  'search',
  'click',
  'type',
  'select',
  'key',
  'scroll',
  'desktop_click',
  'desktop_drag',
  'desktop_type',
  'desktop_key',
  'desktop_scroll',
]);
/** A live-screen frame at most this old stands in for a screenshot. */
const LIVE_FRAME_MS = 1000;
const REPLAY_FRAME_WIDTH = 1024;
const REPLAY_FRAME_QUALITY = 60;
/** The page a step ended on, from the result the agent layer built. */
function pageOf(result: unknown): { url: string; title: string } {
  const record =
    result && typeof result === 'object'
      ? (result as Record<string, unknown>)
      : {};
  const page =
    record.page && typeof record.page === 'object'
      ? (record.page as Record<string, unknown>)
      : {};
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  return {
    url: text(page.url) || text(record.url),
    title: text(page.title) || text(record.title),
  };
}
/** Lets other work run between the slow parts of making a keyframe. */
const yieldToEvents = () =>
  new Promise<void>((resolve) => setImmediate(resolve));
/** One call to the computer inside a {@link ComputerService.session}. */
export type ComputerSessionCall = (
  action: ComputerAction,
  input?: unknown,
) => Promise<unknown>;
const permissionKind = (
  action: string,
  desktop = false,
): 'browser' | 'desktop' | 'files' | 'shell' =>
  action === 'exec'
    ? 'shell'
    : action.startsWith('files_')
      ? 'files'
      : action.startsWith('desktop_') ||
          (desktop && action.startsWith('human_'))
        ? 'desktop'
        : 'browser';
/** Owner actions that can safely be repeated after a fresh snapshot. */
const OWNER_REFRESHABLE = new Set<ComputerAction>([
  'navigate',
  'key',
  'scroll',
  'read',
  'screenshot',
  'desktop_screenshot',
  'desktop_key',
  'desktop_scroll',
]);
export class ComputerService {
  private readonly inputLimits: ComputerInputLimits;
  private readonly responseBytes: number;
  private readonly replayFrames: number;
  /** Keyframes still being made; see {@link framesSettled}. */
  private readonly pendingFrames = new Set<Promise<void>>();
  /** Where recent live-screen frames are found. Replaceable in tests. */
  liveFrames: LiveFrames = liveFrames;
  private readonly streamTickets = new Map<
    string,
    { dotId: string; expires: number }
  >();
  /**
   * Where waiting owner handoffs are read from. The platform attaches it with {@link setHandoffs};
   * a workspace that exposes its own `handoffs` store is used when none was attached.
   */
  private handoffs?: Pick<HandoffStore, 'waitingFor'>;
  private models?: {
    hasModelImages: (
      providerId?: string | null,
      model?: string | null,
    ) => boolean;
  };
  /** Computers on the owner's own server; set by the server entry. */
  private remote?: RemoteComputers;
  private setup?: RemoteSetup;
  readonly inputs: ComputerInputs;
  readonly streamInput: ReturnType<typeof computerStreamInputSchema>;
  constructor(
    private workspace: WorkspaceStore,
    private config: PlatformConfig,
    private paused: () => boolean,
    private transport: typeof fetch = fetch,
    private deadlineMs = (config.limits ?? defaultLimits).computerRequestMs,
  ) {
    const limits = config.limits ?? defaultLimits;
    this.inputLimits = {
      execMaxMs: limits.execMaxMs,
      commandChars: limits.commandChars,
      fileChars: limits.fileChars,
      typeChars: limits.typeChars,
    };
    this.responseBytes = limits.computerResponseBytes;
    this.replayFrames = limits.computerReplayFrames;
    this.inputs = computerInputSchemas(this.inputLimits);
    this.streamInput = computerStreamInputSchema(this.inputLimits);
  }
  setRemote(remote: RemoteComputers | undefined, setup?: RemoteSetup) {
    this.remote = remote;
    this.setup = setup;
    remote?.setUsage(() => this.aliasesInUse());
  }
  get remoteComputers() {
    return this.remote;
  }
  /** "Set up this server", where FullDots can run ssh for the owner. */
  get remoteSetup() {
    return this.setup;
  }
  /** Where this Dot's computer runs. Without remote support, always this machine. */
  target(id: string): DotTarget {
    return this.remote?.target(id) ?? { where: 'local' };
  }
  /** Whether this Dot's computer can be reached at all: this machine's settings, or a server alias. */
  configuredFor(id: string): boolean {
    const target = this.target(id);
    return target.where === 'remote'
      ? validAlias(target.alias)
      : this.localConfigured;
  }
  private requireConfigured(id: string) {
    if (this.configuredFor(id)) return;
    throw new ComputerError(
      503,
      this.target(id).where === 'remote'
        ? 'No server is set for this Dot’s computer. Type the ssh alias of your server in Settings → Computers.'
        : 'Computer service is not configured.',
    );
  }
  setHandoffs(store: Pick<HandoffStore, 'waitingFor'> | undefined) {
    this.handoffs = store;
  }
  setModels(
    models:
      | {
          hasModelImages: (
            providerId?: string | null,
            model?: string | null,
          ) => boolean;
        }
      | undefined,
  ) {
    this.models = models;
  }
  hasModelImagesForDot(id: string): boolean {
    const dot = this.workspace.dot(id);
    return (
      this.models?.hasModelImages(dot?.modelProviderId, dot?.model) ?? false
    );
  }
  policy(id: string): ComputerPermissions {
    return this.workspace.computers.permissions(id);
  }
  async desktopControl(
    id: string,
    signal?: AbortSignal,
  ): Promise<ComputerControl> {
    this.allowed(id, 'desktop', 'agent');
    const url = await this.running(id, signal);
    return this.readControl(url, id, signal);
  }
  /** The largest live-screen input message worth reading: a paste, with JSON escaping. */
  get streamInputBytes() {
    return Math.max(64 * 1024, this.inputLimits.typeChars * 6 + 1024);
  }
  /**
   * Whether any Dot can have a computer: this machine's supervisor is configured, or computers run
   * on the owner's server. Each Dot is still checked on its own (see {@link configuredFor}).
   */
  get configured() {
    if (this.localConfigured) return true;
    const remote = this.remote;
    if (!remote) return false;
    const defaults = remote.defaults();
    if (defaults.where === 'remote' && validAlias(defaults.alias)) return true;
    return this.workspace
      .dots()
      .some((dot) => !!this.workspace.computers.server(dot.id));
  }
  /** Whether this machine's supervisor is configured. */
  private get localConfigured() {
    return !!(
      this.config.computerSupervisorUrl?.trim() &&
      this.config.computerSupervisorToken?.trim() &&
      this.config.computerToken?.trim()
    );
  }
  private token(id: string) {
    const target = this.target(id);
    const master =
      target.where === 'remote' && target.alias && this.remote
        ? this.remote.secrets(target.alias).computerToken
        : this.config.computerToken!.trim();
    return createHmac('sha256', master)
      .update(`opendots-computer:${id}`)
      .digest('hex');
  }
  private requireDot(id: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || !this.workspace.dot(id))
      throw new ComputerError(404, 'Dot not found.');
  }
  private allowed(
    id: string,
    kind: 'browser' | 'desktop' | 'files' | 'shell' | undefined,
    actor: 'agent' | 'owner',
  ) {
    this.requireDot(id);
    this.requireConfigured(id);
    const policy = this.workspace.computers.permissions(id);
    const computerKind = policy.kind ?? 'browser';
    if (!policy.enabled)
      throw new ComputerError(403, 'Computer permission is disabled.');
    if (kind === 'desktop') {
      if (computerKind !== 'desktop')
        throw new ComputerError(
          403,
          'Desktop computer is not enabled for this Dot.',
        );
      if (!policy.desktop)
        throw new ComputerError(403, 'Desktop permission is disabled.');
      if (actor === 'agent') {
        const hasImages = this.hasModelImagesForDot(id);
        if (!hasImages)
          throw new ComputerError(
            403,
            'Desktop computer requires a model with vision enabled. Turn on Images for your model in Settings → Models.',
          );
      }
    } else if (kind === 'browser') {
      if (!policy.browser)
        throw new ComputerError(403, 'Computer permission is disabled.');
    } else if (kind && !policy[kind]) {
      throw new ComputerError(403, 'Computer permission is disabled.');
    }
    if (actor === 'agent' && this.paused())
      throw new ComputerError(403, 'Agents are paused.');
    if (actor === 'agent' && this.workspace.dot(id)?.paused)
      throw new ComputerError(403, 'This Dot is paused.');
  }
  private async json(
    url: string,
    token: string,
    body: unknown | undefined,
    signal?: AbortSignal,
    dotId?: string,
    actor?: 'owner' | 'agent',
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.deadlineMs);
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    try {
      const response = await this.transport(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(dotId ? { 'x-openbot-bot-id': dotId } : {}),
          ...(actor ? { 'x-fulldots-computer-actor': actor } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: combined,
      });
      if (response.status === 409)
        throw new ComputerConflictError(await classifyConflict(response));
      if (!response.ok) {
        const reason = await failureReason(response);
        throw new ComputerActionError(
          response.status,
          reason && this.redact(reason, token),
        );
      }
      if (!response.body)
        throw new ComputerError(
          502,
          'Computer service returned an empty response.',
        );
      const reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > this.responseBytes) {
          await reader.cancel();
          throw new ComputerError(
            502,
            'Computer response exceeded its size limit.',
          );
        }
        chunks.push(value);
      }
      return JSON.parse(
        this.redact(Buffer.concat(chunks).toString('utf8'), token),
      );
    } catch (error) {
      // A call that failed because the tunnel to the owner's server is down says so.
      const down = signal?.aborted ? undefined : this.remoteDown(url);
      if (down) throw new ComputerError(503, down, { cause: error });
      if (combined.aborted)
        throw new ComputerError(
          502,
          'Computer request was cancelled or timed out.',
          {
            cause: error,
          },
        );
      if (
        error instanceof ComputerConflictError ||
        error instanceof ComputerError ||
        (error instanceof Error &&
          /^Computer (service returned|response exceeded)/.test(error.message))
      )
        throw error;
      throw new ComputerError(
        502,
        'Computer service is unavailable or returned an invalid response.',
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  /** A clear reason when a call failed because the tunnel to the owner's server is down. */
  private remoteDown(url: string): string | undefined {
    if (!this.remote) return undefined;
    try {
      return this.remote.downAt(Number(new URL(url).port));
    } catch {
      return undefined;
    }
  }
  /** Every infrastructure secret, local and for each of the owner's servers. */
  private secrets(token?: string): string[] {
    return [
      token,
      this.config.computerToken?.trim(),
      this.config.computerSupervisorToken?.trim(),
      ...(this.remote?.allSecrets() ?? []),
    ].filter((secret): secret is string => !!secret);
  }
  /** Infrastructure secrets must never leave the gateway even if an upstream response reflects one. */
  private redact(text: string, token: string) {
    for (const secret of this.secrets(token))
      if (secret) text = text.split(secret).join('[redacted]');
    return text;
  }
  /**
   * One call to the supervisor that holds this Dot's computer: this machine's, or the one on the
   * owner's server through its tunnel. A server that cannot be reached is an error; there is no
   * fallback to this machine's Docker.
   */
  private async supervisor(
    id: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ) {
    const target = this.target(id);
    if (target.where === 'remote') {
      if (!this.remote)
        throw new ComputerError(
          503,
          'Computers on your server are not available here.',
        );
      const origin = await this.remote.supervisorOrigin(target.alias);
      return this.json(
        `${origin}${path}`,
        this.remote.secrets(target.alias!).supervisorToken,
        body,
        signal,
      );
    }
    if (!this.localConfigured)
      throw new ComputerError(503, 'Computer service is not configured.');
    return this.json(
      `${this.config.computerSupervisorUrl!.replace(/\/$/, '')}${path}`,
      this.config.computerSupervisorToken!.trim(),
      body,
      signal,
    );
  }
  private async endpoint(id: string, raw: unknown): Promise<string> {
    const target = this.target(id);
    if (target.where !== 'remote') return this.localEndpoint(id, raw);
    const state = stateSchema.parse(raw);
    const ns = this.config.computerNamespace ?? 'opendots';
    if (state.botId !== id || state.container !== `${ns}-computer-${id}`)
      throw new ComputerError(502, 'Computer identity mismatch.');
    if (!this.remote)
      throw new ComputerError(
        503,
        'Computers on your server are not available here.',
      );
    return this.remote.origin(
      target.alias!,
      id,
      state,
      this.policy(id).kind === 'desktop' ? 'desktop' : 'browser',
    );
  }
  private localEndpoint(id: string, raw: unknown) {
    const state = stateSchema.parse(raw);
    const ns = this.config.computerNamespace ?? 'opendots';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(ns))
      throw new ComputerError(503, 'Invalid computer namespace.');
    const expected = `${ns}-computer-${id}`;
    if (state.botId !== id || state.container !== expected)
      throw new ComputerError(502, 'Computer identity mismatch.');
    const url = new URL(
      state.url ??
        (state.port
          ? `http://127.0.0.1:${state.port}`
          : `http://${expected}:4100`),
    );
    const network =
      url.hostname === expected.toLowerCase() && url.port === '4100';
    const local =
      url.hostname === '127.0.0.1' &&
      !!state.port &&
      url.port === String(state.port) &&
      new URL(this.config.computerSupervisorUrl!).hostname === '127.0.0.1';
    if (
      url.protocol !== 'http:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      (!network && !local)
    )
      throw new ComputerError(
        502,
        'Computer endpoint is not bound to this Dot.',
      );
    return url.origin;
  }
  private async existing(id: string, signal?: AbortSignal) {
    const listing = z
      .object({ computers: z.array(stateSchema) })
      .parse(await this.supervisor(id, '/computers', undefined, signal));
    return listing.computers.find((c) => c.botId === id);
  }
  private async running(id: string, signal?: AbortSignal) {
    const state = await this.existing(id, signal);
    if (!state || state.status !== 'running')
      throw new ComputerError(409, 'Start this Dot’s computer first.');
    return this.endpoint(id, state);
  }
  async status(id: string): Promise<ComputerStatus> {
    this.requireDot(id);
    const target = this.target(id);
    const base: Omit<ComputerStatus, 'state'> = {
      configured: this.configuredFor(id),
      server:
        target.where === 'remote'
          ? {
              where: 'remote',
              ...(target.alias ? { alias: target.alias } : {}),
              own: !!this.workspace.computers.server(id),
            }
          : { where: 'local', own: false },
      permissions: this.workspace.computers.permissions(id),
      audit: this.workspace.computers.audit(id),
      limits: this.inputLimits,
    };
    const waiting = (
      this.handoffs ??
      (this.workspace as { handoffs?: Pick<HandoffStore, 'waitingFor'> })
        .handoffs
    )?.waitingFor(id);
    if (waiting)
      Object.assign(base, {
        handoff: {
          id: waiting.id,
          kind: waiting.kind,
          reason: waiting.reason,
          createdAt: waiting.createdAt,
        },
      });
    if (target.where === 'remote') return this.remoteStatus(id, target, base);
    if (!this.localConfigured) return { ...base, state: 'not_configured' };
    try {
      const state = await this.existing(id);
      if (!state || state.status !== 'running')
        return { ...base, state: 'stopped' };
      const url = await this.endpoint(id, state);
      const control = controlSchema.parse(
        await this.json(
          `${url}/control`,
          this.token(id),
          undefined,
          undefined,
          id,
        ),
      );
      return { ...base, state: 'running', control };
    } catch {
      return {
        ...base,
        state: 'unavailable',
        error:
          'Computer service is unavailable. Check the supervisor configuration and connection.',
      };
    }
  }
  /**
   * A computer on the owner's server, checked in the order of the guide: the alias, ssh, Docker,
   * the images, the supervisor, then this Dot's computer (stopped, unsafe, not ready yet).
   */
  private async remoteStatus(
    id: string,
    target: Extract<DotTarget, { where: 'remote' }>,
    base: Omit<ComputerStatus, 'state'>,
  ): Promise<ComputerStatus> {
    const alias = target.alias;
    const failed = this.remote
      ? await this.remote.serverCheck(alias)
      : {
          check: 'ssh_failed' as const,
          message: 'Computers on your server are not available here.',
        };
    if (failed)
      return {
        ...base,
        state:
          failed.check === 'alias_not_set' ? 'not_configured' : 'unavailable',
        error: failed.message,
        remote: failed,
      };
    const at = (
      check: NonNullable<ComputerStatus['remote']>['check'],
      message: string,
      command?: string,
    ) => ({
      ...(alias ? { alias } : {}),
      check,
      message,
      ...(command ? { command } : {}),
    });
    let url: string;
    try {
      const state = await this.existing(id);
      if (!state || state.status !== 'running')
        return {
          ...base,
          state: 'stopped',
          remote: at(
            'computer_stopped',
            `This Dot’s computer on ${alias} is stopped. Press Start to turn it on.`,
          ),
        };
      url = await this.endpoint(id, state);
    } catch (error) {
      if (error instanceof ComputerError && error.status === 409)
        return {
          ...base,
          state: 'stopped',
          remote: at(
            'computer_stopped',
            `This Dot’s computer on ${alias} is stopped. Press Start to turn it on.`,
          ),
        };
      const message =
        error instanceof ComputerError
          ? error.message
          : 'The server did not answer.';
      const unsafe = error instanceof UnsafeComputerError;
      return {
        ...base,
        state: 'unavailable',
        error: message,
        remote: unsafe
          ? at(
              'computer_unsafe',
              message,
              removeCommand(
                target,
                this.config.computerNamespace ?? 'opendots',
                id,
              ),
            )
          : at('supervisor_not_running', message),
      };
    }
    try {
      const control = controlSchema.parse(
        await this.json(
          `${url}/control`,
          this.token(id),
          undefined,
          undefined,
          id,
        ),
      );
      return {
        ...base,
        state: 'running',
        control,
        remote: at('ready', `This Dot’s computer runs on ${alias}.`),
      };
    } catch {
      const kind = this.policy(id).kind === 'desktop' ? 'desktop' : 'browser';
      const message = `The ${kind} on ${alias} is not ready yet. Wait a moment; if it stays like this, Stop and Start the computer.`;
      return {
        ...base,
        state: 'unavailable',
        error: message,
        remote: at('not_ready', message),
      };
    }
  }
  private async audited<T>(
    id: string,
    action: string,
    actor: 'owner' | 'agent',
    fn: () => Promise<T>,
  ): Promise<T> {
    this.requireDot(id);
    const receipt = this.workspace.computers.begin(id, action, actor);
    try {
      const result = await fn();
      this.workspace.computers.finish(receipt, 'succeeded');
      return result;
    } catch (error) {
      this.workspace.computers.finish(receipt, 'failed');
      throw error;
    }
  }
  async permissions(id: string, input: unknown) {
    const patch = computerPermissionsSchema.partial().parse(input);
    if (patch.kind !== undefined) {
      const current = this.workspace.computers.permissions(id);
      if (patch.kind !== (current.kind ?? 'browser')) {
        const state = await this.existing(id);
        if (state && state.status === 'running')
          throw new ComputerError(
            409,
            'Stop this Dot’s computer before changing its kind.',
          );
      }
    }
    await this.audited(id, 'permissions', 'owner', async () =>
      this.workspace.computers.patch(id, patch),
    );
    return this.status(id);
  }
  async start(id: string) {
    await this.audited(id, 'start', 'owner', async () => {
      this.allowed(id, undefined, 'owner');
      const policy = this.workspace.computers.permissions(id);
      await this.endpoint(
        id,
        await this.supervisor(id, `/computers/${id}/ensure`, {
          kind: policy.kind ?? 'browser',
        }),
      );
    });
    return this.status(id);
  }
  async stop(id: string) {
    await this.audited(id, 'stop', 'owner', async () => {
      this.requireConfigured(id);
      await this.supervisor(id, `/computers/${id}/stop`, {});
    });
    return this.status(id);
  }
  async control(id: string, verb: 'take' | 'release') {
    await this.audited(id, verb, 'owner', async () => {
      this.requireConfigured(id);
      const policy = this.workspace.computers.permissions(id);
      const screenKind = policy.kind === 'desktop' ? 'desktop' : 'browser';
      if (verb === 'take') this.allowed(id, screenKind, 'owner');
      const url = await this.running(id);
      if (verb === 'take') this.allowed(id, screenKind, 'owner');
      let control: ComputerControl = controlSchema.parse(
        await this.json(
          `${url}/control`,
          this.token(id),
          undefined,
          undefined,
          id,
        ),
      );
      if (verb === 'take' && !control.request)
        control = controlSchema.parse(
          await this.json(
            `${url}/control/request`,
            this.token(id),
            { reason: 'Owner requested control.' },
            undefined,
            id,
          ),
        );
      if (
        verb === 'take' &&
        control.request &&
        !['waiting', 'taken'].includes(control.request.status)
      )
        control = controlSchema.parse(
          await this.json(
            `${url}/control/request`,
            this.token(id),
            { reason: 'Owner requested control.' },
            undefined,
            id,
          ),
        );
      if (!control.request)
        throw new ComputerError(409, 'There is no active control request.');
      await this.json(
        `${url}/control/${verb}`,
        this.token(id),
        { requestId: control.request.id },
        undefined,
        id,
      );
    });
    return this.status(id);
  }
  private readControl(
    url: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<ComputerControl> {
    return this.json(
      `${url}/control`,
      this.token(id),
      undefined,
      signal,
      id,
    ).then((raw) => controlSchema.parse(raw));
  }
  /**
   * Asks the owner to take the wheel. From then on the computer refuses the Dot's own actions with an
   * owner-control conflict until the owner takes and releases control or the request is cancelled.
   * Asking again returns the request that is already active.
   */
  async requestOwnerControl(
    id: string,
    reason: string,
    actor: 'agent' | 'owner' = 'agent',
  ): Promise<ComputerControl> {
    return this.audited(id, 'request_control', actor, async () => {
      const policy = this.workspace.computers.permissions(id);
      const screenKind = policy.kind === 'desktop' ? 'desktop' : 'browser';
      this.allowed(id, screenKind, actor);
      const url = await this.running(id);
      this.allowed(id, screenKind, actor);
      return controlSchema.parse(
        await this.json(
          `${url}/control/request`,
          this.token(id),
          { reason: reason.slice(0, 500) },
          undefined,
          id,
        ),
      );
    });
  }
  /**
   * Withdraws a request for the owner. A waiting request is cancelled, which reopens the computer to
   * the Dot. If the owner had already taken control, the cancelled request is then released so the
   * wheel returns to the Dot. A conflict that is not an owner-control one means the request is no
   * longer active, which is the state we wanted, so it is not an error.
   */
  async cancelOwnerControl(id: string): Promise<ComputerControl> {
    return this.audited(id, 'cancel_control', 'owner', async () => {
      this.requireConfigured(id);
      const url = await this.running(id);
      const settle = async (verb: 'cancel' | 'release', requestId: string) => {
        try {
          await this.json(
            `${url}/control/${verb}`,
            this.token(id),
            { requestId },
            undefined,
            id,
          );
        } catch (error) {
          if (
            !(error instanceof ComputerConflictError) ||
            error.kind !== 'other'
          )
            throw error;
        }
      };
      let control = await this.readControl(url, id);
      if (
        control.request &&
        ['waiting', 'taken'].includes(control.request.status)
      ) {
        await settle('cancel', control.request.id);
        control = await this.readControl(url, id);
      }
      if (control.holder === 'human' && control.request) {
        await settle('release', control.request.id);
        control = await this.readControl(url, id);
      }
      return control;
    });
  }
  async action(
    id: string,
    action: ComputerAction,
    input: unknown,
    actor: 'owner' | 'agent' = 'owner',
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!Object.hasOwn(this.inputs, action))
      throw new ComputerError(400, 'Unknown computer action.');
    const parsed = this.inputs[action].parse(input);
    return this.session(id, action, actor, signal, async (call) => {
      try {
        return await call(action, parsed);
      } catch (error) {
        // After a handback the computer wants a fresh look at the page before anything else. The
        // owner's own navigation, keys and scrolling do not depend on old refs, so refresh and go again.
        if (
          actor !== 'owner' ||
          !(error instanceof ComputerConflictError) ||
          error.kind !== 'snapshot_required' ||
          !OWNER_REFRESHABLE.has(action)
        )
          throw error;
        await call('snapshot', {});
        return call(action, parsed);
      }
    });
  }
  /**
   * Runs one or more computer calls as a single audited action.
   *
   * `label` is what the audit trail records and decides which permission applies. Every call made
   * through `call` must need that same permission. A compound action such as choosing a dropdown option
   * uses several calls but is still one thing the owner sees: permissions are re-checked before and
   * after each call and cancel the work in flight as soon as the owner revokes them.
   *
   * With `replay`, a page-changing step is also kept for the conversation's replay. Its picture is
   * taken through this same session, after the step, without holding up what comes next; see
   * {@link keepReplayStep}.
   */
  async session<T>(
    id: string,
    label: ComputerAction | 'select' | 'search',
    actor: 'owner' | 'agent',
    signal: AbortSignal | undefined,
    body: (call: ComputerSessionCall) => Promise<T>,
    replay?: ReplayContext,
  ): Promise<T> {
    return this.audited(id, label, actor, async () => {
      if (actor === 'agent' && label.startsWith('human_'))
        throw new ComputerError(403, 'Human controls are owner-only.');
      const desktop = this.policy(id).kind === 'desktop';
      const kind = permissionKind(label, desktop);
      this.allowed(id, kind, actor);
      const cancellation = new AbortController();
      const activeSignal = signal
        ? AbortSignal.any([signal, cancellation.signal])
        : cancellation.signal;
      const watcher = setInterval(() => {
        try {
          this.allowed(id, kind, actor);
        } catch {
          cancellation.abort();
        }
      }, 50);
      try {
        let url: string | undefined;
        const call: ComputerSessionCall = async (action, input) => {
          if (!Object.hasOwn(this.inputs, action))
            throw new ComputerError(400, 'Unknown computer action.');
          if (permissionKind(action, desktop) !== kind)
            throw new ComputerError(
              403,
              'That call needs a different permission.',
            );
          const parsed = this.inputs[action].parse(input ?? {});
          url ??= await this.running(id, activeSignal);
          this.allowed(id, kind, actor);
          activeSignal.throwIfAborted();
          const path = action
            .replace(/^files_/, 'files/')
            .replace(/^human_/, 'human/')
            .replace(/^desktop_/, 'desktop/');
          const result = await this.json(
            `${url}/${path}`,
            this.token(id),
            ['read', 'screenshot', 'desktop_screenshot'].includes(action)
              ? undefined
              : parsed,
            activeSignal,
            id,
            actor,
          );
          this.allowed(id, kind, actor);
          if (action === 'exec' && result && typeof result === 'object') {
            const copy = { ...result } as Record<string, unknown>;
            delete copy.command;
            return copy;
          }
          return result;
        };
        let result: T;
        try {
          result = await body(call);
        } catch (error) {
          if (replay) this.keepReplayStep(id, label, replay, undefined);
          throw error;
        }
        if (replay) this.keepReplayStep(id, label, replay, result, call);
        return result;
      } finally {
        clearInterval(watcher);
      }
    });
  }
  /**
   * Records a step for the replay and, when it can, a small picture of the screen after it.
   *
   * The step row is written at once. The picture is a recent live-screen frame when the owner is
   * watching, otherwise a screenshot taken through the step's own `call`: it is part of the same
   * audited action, so the activity list still shows one entry. Taking and shrinking it runs in the
   * background; a failure only means the step has no picture.
   */
  private keepReplayStep(
    id: string,
    label: string,
    context: ReplayContext,
    result: unknown,
    call?: ComputerSessionCall,
  ) {
    try {
      if (
        !REPLAY_ACTIONS.has(label) ||
        this.replayFrames <= 0 ||
        !replayEnabled(this.workspace.computers.permissions(id))
      )
        return;
      const failed =
        result === undefined ||
        (!!result &&
          typeof result === 'object' &&
          typeof (result as { error?: unknown }).error === 'string');
      const live = call
        ? this.liveFrames.recent(id, LIVE_FRAME_MS, (text) =>
            this.redact(text, this.token(id)),
          )
        : undefined;
      const stepId = this.workspace.frames.add(
        {
          dotId: id,
          threadId: context.threadId,
          toolCallId: context.toolCallId,
          action: label,
          ...pageOf(result),
          outcome: failed ? 'failed' : 'succeeded',
          ...(live ? { jpeg: live } : {}),
        },
        this.replayFrames,
      );
      if (live || !call) return;
      const capture = (async () => {
        const policy = this.workspace.computers.permissions(id);
        const shotAction =
          policy.kind === 'desktop' ? 'desktop_screenshot' : 'screenshot';
        const shot = await call(shotAction as ComputerAction);
        const base64 =
          shot && typeof shot === 'object'
            ? (shot as { base64?: unknown }).base64
            : undefined;
        if (typeof base64 !== 'string') return;
        await yieldToEvents();
        const bytes = Buffer.from(base64, 'base64');
        const jpeg =
          shotAction === 'desktop_screenshot' &&
          bytes[0] === 0xff &&
          bytes[1] === 0xd8
            ? bytes
            : keyframeFromPng(bytes, REPLAY_FRAME_WIDTH, REPLAY_FRAME_QUALITY);
        this.workspace.frames.attach(stepId, jpeg);
      })().catch((error: unknown) => {
        // Names the failure only: messages from the computer are already generic.
        console.error(
          'Replay frame was not kept:',
          error instanceof Error ? error.message : 'unknown error',
        );
      });
      this.pendingFrames.add(capture);
      void capture.finally(() => this.pendingFrames.delete(capture));
    } catch (error) {
      console.error(
        'Replay step was not kept:',
        error instanceof Error ? error.message : 'unknown error',
      );
    }
  }
  /** Resolves once every keyframe started so far is stored or given up. */
  async framesSettled() {
    while (this.pendingFrames.size) await Promise.all(this.pendingFrames);
  }
  /** Where computers run for a Dot that has no server of its own. */
  private defaultTarget(): DotTarget {
    const defaults = this.remote?.defaults();
    return defaults?.where === 'remote'
      ? { where: 'remote', alias: defaults.alias }
      : { where: 'local' };
  }
  private reachable(target: DotTarget) {
    return target.where === 'remote'
      ? validAlias(target.alias)
      : this.localConfigured;
  }
  private same(a: DotTarget, b: DotTarget) {
    if (a.where === 'local' || b.where === 'local') return a.where === b.where;
    return a.alias === b.alias;
  }
  /** The Dot ids of the computers a supervisor holds. */
  private async listAt(target: DotTarget): Promise<string[]> {
    const listing = z.object({ computers: z.array(stateSchema) });
    if (target.where === 'remote') {
      if (!this.remote) return [];
      const origin = await this.remote.supervisorOrigin(target.alias);
      return listing
        .parse(
          await this.json(
            `${origin}/computers`,
            this.remote.secrets(target.alias!).supervisorToken,
            undefined,
          ),
        )
        .computers.map((computer) => computer.botId);
    }
    return listing
      .parse(
        await this.json(
          `${this.config.computerSupervisorUrl!.replace(/\/$/, '')}/computers`,
          this.config.computerSupervisorToken!.trim(),
          undefined,
        ),
      )
      .computers.map((computer) => computer.botId);
  }
  private where(target: DotTarget) {
    return target.where === 'remote'
      ? (target.alias ?? 'your server')
      : 'this machine';
  }
  /**
   * Checks that no computer of these Dots is left where they used to run. A computer that still
   * exists there blocks the move, with the command that removes it; FullDots never removes it
   * itself. A server that cannot be reached does not block: the commands come back as leftovers.
   */
  private async leaving(before: DotTarget, dotIds: string[]) {
    const ns = this.config.computerNamespace ?? 'opendots';
    if (!dotIds.length || !this.reachable(before)) return undefined;
    let held: string[];
    try {
      held = (await this.listAt(before)).filter((id) => dotIds.includes(id));
    } catch {
      return dotIds.map((id) => removeCommand(before, ns, id));
    }
    if (held.length)
      throw new ComputerError(
        409,
        `Remove the computer on ${this.where(before)} first. FullDots does not remove it for you; its files stay in their volumes. Run: ${held.map((id) => removeCommand(before, ns, id)).join(' ; ')}`,
      );
    return undefined;
  }
  /** Keeps only the tunnels a Dot or the default still uses. */
  /** The aliases the default or any Dot uses. */
  private aliasesInUse(): Set<string> {
    const inUse = new Set<string>();
    const defaults = this.remote?.defaults();
    if (defaults?.where === 'remote' && defaults.alias)
      inUse.add(defaults.alias);
    for (const dot of this.workspace.dots()) {
      const own = this.workspace.computers.server(dot.id);
      if (own) inUse.add(own);
    }
    return inUse;
  }
  private pruneTunnels() {
    this.remote?.prune(this.aliasesInUse());
  }
  private requireAliasInput(alias: string | null | undefined) {
    if (alias !== null && alias !== undefined && !validAlias(alias))
      throw new ComputerError(
        400,
        'Use the name of a Host from your ssh config: letters, digits, dot, dash and underscore, not starting with a dash.',
      );
  }
  /** Gives a Dot its own server alias, or puts it back on the default with null. */
  async moveServer(
    id: string,
    alias: string | null,
  ): Promise<ComputerMoveResult> {
    this.requireDot(id);
    if (!this.remote)
      throw new ComputerError(
        503,
        'Computers on your server are not available here.',
      );
    this.requireAliasInput(alias);
    if ((this.workspace.computers.server(id) ?? null) === alias)
      return { moved: false };
    const before = this.target(id);
    const after: DotTarget =
      alias !== null ? { where: 'remote', alias } : this.defaultTarget();
    const leftover = this.same(before, after)
      ? undefined
      : await this.leaving(before, [id]);
    await this.audited(id, 'server', 'owner', async () =>
      this.workspace.computers.setServer(id, alias ?? undefined),
    );
    if (before.where === 'remote' && before.alias)
      this.remote.release(before.alias, id);
    this.pruneTunnels();
    return { moved: true, ...(leftover ? { leftover } : {}) };
  }
  /** Changes where computers run by default, for every Dot without its own server. */
  async setDefaults(
    where: ComputerWhere,
    alias?: string,
  ): Promise<ComputerMoveResult> {
    if (!this.remote)
      throw new ComputerError(
        503,
        'Computers on your server are not available here.',
      );
    this.requireAliasInput(alias);
    if (where === 'remote' && !alias)
      throw new ComputerError(400, 'Type the ssh alias of your server.');
    const before = this.defaultTarget();
    const after: DotTarget = where === 'remote' ? { where, alias } : { where };
    const users = this.workspace
      .dots()
      .map((dot) => dot.id)
      .filter((id) => !this.workspace.computers.server(id));
    const leftover = this.same(before, after)
      ? undefined
      : await this.leaving(before, users);
    this.remote.setDefaults(where, alias);
    if (before.where === 'remote' && before.alias && !this.same(before, after))
      for (const id of users) this.remote.release(before.alias, id);
    this.pruneTunnels();
    return { moved: true, ...(leftover ? { leftover } : {}) };
  }
  /**
   * A one-time ticket for opening the live screen.
   *
   * Browsers cannot send an Authorization header on a WebSocket upgrade, and the owner token must not
   * travel in a URL. The ticket is the substitute: it is random, bound to one Dot, valid for seconds,
   * and only an authenticated request can mint it.
   */
  streamTicket(id: string): ComputerStreamTicket {
    const policy = this.workspace.computers.permissions(id);
    const screenKind = policy.kind === 'desktop' ? 'desktop' : 'browser';
    this.allowed(id, screenKind, 'owner');
    const now = Date.now();
    for (const [key, entry] of this.streamTickets)
      if (entry.expires <= now) this.streamTickets.delete(key);
    while (this.streamTickets.size >= MAX_STREAM_TICKETS) {
      const oldest = this.streamTickets.keys().next();
      if (oldest.done) break;
      this.streamTickets.delete(oldest.value);
    }
    const ticket = randomBytes(32).toString('base64url');
    this.streamTickets.set(hashTicket(ticket), {
      dotId: id,
      expires: now + STREAM_TICKET_TTL_MS,
    });
    return { ticket, expiresInMs: STREAM_TICKET_TTL_MS };
  }
  /** The Dot a ticket was minted for. Consumes the ticket whether or not it is still valid. */
  redeemStreamTicket(ticket: string): string | undefined {
    const key = hashTicket(ticket);
    const entry = this.streamTickets.get(key);
    this.streamTickets.delete(key);
    return entry && entry.expires > Date.now() ? entry.dotId : undefined;
  }
  /** Whether the owner may still watch this Dot's screen. Asked repeatedly while a screen is open. */
  streamAllowed(id: string): boolean {
    const policy = this.workspace.computers.permissions(id);
    const screenKind = policy.kind === 'desktop' ? 'desktop' : 'browser';
    try {
      this.allowed(id, screenKind, 'owner');
      return true;
    } catch {
      return false;
    }
  }
  /** A server-only coding connection; the master credential never enters the computer. */
  async codingTarget(id: string, signal?: AbortSignal) {
    this.allowed(id, undefined, 'agent');
    const origin = await this.running(id, signal);
    const control = controlSchema.parse(
      await this.json(
        `${origin}/control`,
        this.token(id),
        undefined,
        signal,
        id,
      ),
    );
    if (control.holder === 'human' || control.requested)
      throw new Error('The owner has control of this Dot’s computer.');
    this.allowed(id, undefined, 'agent');
    signal?.throwIfAborted();
    const token = this.token(id);
    return {
      url: `ws://${new URL(origin).host}/acp`,
      headers: {
        'x-openbot-computer-token': token,
        'x-openbot-bot-id': id,
      },
      redact: (text: string) => this.redact(text, token),
    };
  }
  /** Where to connect for this Dot's live screen. Audited like any other owner action. */
  async openStream(
    id: string,
    signal?: AbortSignal,
  ): Promise<ComputerStreamTarget> {
    return this.audited(id, 'stream', 'owner', async () => {
      const policy = this.workspace.computers.permissions(id);
      const screenKind = policy.kind === 'desktop' ? 'desktop' : 'browser';
      this.allowed(id, screenKind, 'owner');
      const origin = await this.running(id, signal);
      this.allowed(id, screenKind, 'owner');
      signal?.throwIfAborted();
      const token = this.token(id);
      const secrets = this.secrets(token);
      return {
        url: `ws://${new URL(origin).host}/stream?bot=${encodeURIComponent(id)}&token=${token}`,
        redact: (text) =>
          secrets.reduce(
            (all, secret) => all.split(secret).join('[redacted]'),
            text,
          ),
      };
    });
  }
}
