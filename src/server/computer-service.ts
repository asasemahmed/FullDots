import { createHash, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  computerInputSchemas,
  computerStreamInputSchema,
  type ComputerInputLimits,
  type ComputerInputs,
  computerPermissionsSchema,
  type ComputerAction,
  type ComputerControl,
  type ComputerStatus,
  type ComputerStreamTicket,
} from '../shared/computer-types.js';
import type { WorkspaceStore } from './workspace.js';
import { defaultLimits } from './limits.js';
import type { PlatformConfig } from './platform-config.js';
import {
  ComputerConflictError,
  classifyConflict,
} from './computer-conflict.js';
export { ComputerConflictError } from './computer-conflict.js';
const stateSchema = z.object({
  botId: z.string(),
  container: z.string(),
  status: z.string(),
  port: z.number().int().min(1024).max(65535).optional(),
  url: z.string().optional(),
});
const controlSchema = z.object({
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
/** One call to the computer inside a {@link ComputerService.session}. */
export type ComputerSessionCall = (
  action: ComputerAction,
  input?: unknown,
) => Promise<unknown>;
const permissionKind = (action: string) =>
  action === 'exec'
    ? 'shell'
    : action.startsWith('files_')
      ? 'files'
      : 'browser';
/** Owner actions that can safely be repeated after a fresh snapshot. */
const OWNER_REFRESHABLE = new Set<ComputerAction>([
  'navigate',
  'key',
  'scroll',
  'read',
  'screenshot',
]);
export class ComputerService {
  private readonly inputLimits: ComputerInputLimits;
  private readonly responseBytes: number;
  private readonly streamTickets = new Map<
    string,
    { dotId: string; expires: number }
  >();
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
    this.inputs = computerInputSchemas(this.inputLimits);
    this.streamInput = computerStreamInputSchema(this.inputLimits);
  }
  /** The largest live-screen input message worth reading: a paste, with JSON escaping. */
  get streamInputBytes() {
    return Math.max(64 * 1024, this.inputLimits.typeChars * 6 + 1024);
  }
  get configured() {
    return !!(
      this.config.computerSupervisorUrl?.trim() &&
      this.config.computerSupervisorToken?.trim() &&
      this.config.computerToken?.trim()
    );
  }
  private token(id: string) {
    return createHmac('sha256', this.config.computerToken!.trim())
      .update(`opendots-computer:${id}`)
      .digest('hex');
  }
  private requireDot(id: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || !this.workspace.dot(id))
      throw new Error('Dot not found.');
  }
  private allowed(
    id: string,
    kind: 'browser' | 'files' | 'shell' | undefined,
    actor: 'agent' | 'owner',
  ) {
    this.requireDot(id);
    if (!this.configured)
      throw new Error('Computer service is not configured.');
    const policy = this.workspace.computers.permissions(id);
    if (!policy.enabled || (kind && !policy[kind]))
      throw new Error('Computer permission is disabled.');
    if (actor === 'agent' && this.paused())
      throw new Error('Agents are paused.');
  }
  private async json(
    url: string,
    token: string,
    body: unknown | undefined,
    signal?: AbortSignal,
    dotId?: string,
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
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: combined,
      });
      if (response.status === 409)
        throw new ComputerConflictError(await classifyConflict(response));
      if (!response.ok)
        throw new Error(`Computer service returned HTTP ${response.status}.`);
      if (!response.body)
        throw new Error('Computer service returned an empty response.');
      const reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > this.responseBytes) {
          await reader.cancel();
          throw new Error('Computer response exceeded its size limit.');
        }
        chunks.push(value);
      }
      // Infrastructure secrets must never leave the gateway even if an upstream response reflects one.
      let text = Buffer.concat(chunks).toString('utf8');
      for (const secret of [
        token,
        this.config.computerToken?.trim(),
        this.config.computerSupervisorToken?.trim(),
      ])
        if (secret) text = text.split(secret).join('[redacted]');
      return JSON.parse(text);
    } catch (error) {
      if (combined.aborted)
        throw new Error('Computer request was cancelled or timed out.', {
          cause: error,
        });
      if (
        error instanceof ComputerConflictError ||
        (error instanceof Error &&
          /^Computer (service returned|response exceeded)/.test(error.message))
      )
        throw error;
      throw new Error(
        'Computer service is unavailable or returned an invalid response.',
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  private supervisor(path: string, body?: unknown, signal?: AbortSignal) {
    return this.json(
      `${this.config.computerSupervisorUrl!.replace(/\/$/, '')}${path}`,
      this.config.computerSupervisorToken!.trim(),
      body,
      signal,
    );
  }
  private endpoint(id: string, raw: unknown) {
    const state = stateSchema.parse(raw);
    const ns = this.config.computerNamespace ?? 'opendots';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(ns))
      throw new Error('Invalid computer namespace.');
    const expected = `${ns}-computer-${id}`;
    if (state.botId !== id || state.container !== expected)
      throw new Error('Computer identity mismatch.');
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
      throw new Error('Computer endpoint is not bound to this Dot.');
    return url.origin;
  }
  private async existing(id: string, signal?: AbortSignal) {
    const listing = z
      .object({ computers: z.array(stateSchema) })
      .parse(await this.supervisor('/computers', undefined, signal));
    return listing.computers.find((c) => c.botId === id);
  }
  private async running(id: string, signal?: AbortSignal) {
    const state = await this.existing(id, signal);
    if (!state || state.status !== 'running')
      throw new Error('Start this Dot’s computer first.');
    return this.endpoint(id, state);
  }
  async status(id: string): Promise<ComputerStatus> {
    this.requireDot(id);
    const base = {
      configured: this.configured,
      permissions: this.workspace.computers.permissions(id),
      audit: this.workspace.computers.audit(id),
      limits: this.inputLimits,
    };
    if (!this.configured) return { ...base, state: 'not_configured' };
    try {
      const state = await this.existing(id);
      if (!state || state.status !== 'running')
        return { ...base, state: 'stopped' };
      const url = this.endpoint(id, state);
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
    await this.audited(id, 'permissions', 'owner', async () =>
      this.workspace.computers.patch(id, patch),
    );
    return this.status(id);
  }
  async start(id: string) {
    await this.audited(id, 'start', 'owner', async () => {
      this.allowed(id, undefined, 'owner');
      this.endpoint(id, await this.supervisor(`/computers/${id}/ensure`, {}));
    });
    return this.status(id);
  }
  async stop(id: string) {
    await this.audited(id, 'stop', 'owner', async () => {
      if (!this.configured)
        throw new Error('Computer service is not configured.');
      await this.supervisor(`/computers/${id}/stop`, {});
    });
    return this.status(id);
  }
  async control(id: string, verb: 'take' | 'release') {
    await this.audited(id, verb, 'owner', async () => {
      if (!this.configured)
        throw new Error('Computer service is not configured.');
      if (verb === 'take') this.allowed(id, 'browser', 'owner');
      const url = await this.running(id);
      if (verb === 'take') this.allowed(id, 'browser', 'owner');
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
        throw new Error('There is no active control request.');
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
  async action(
    id: string,
    action: ComputerAction,
    input: unknown,
    actor: 'owner' | 'agent' = 'owner',
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!Object.hasOwn(this.inputs, action))
      throw new Error('Unknown computer action.');
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
   */
  async session<T>(
    id: string,
    label: ComputerAction | 'select',
    actor: 'owner' | 'agent',
    signal: AbortSignal | undefined,
    body: (call: ComputerSessionCall) => Promise<T>,
  ): Promise<T> {
    return this.audited(id, label, actor, async () => {
      if (actor === 'agent' && label.startsWith('human_'))
        throw new Error('Human controls are owner-only.');
      const kind = permissionKind(label);
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
            throw new Error('Unknown computer action.');
          if (permissionKind(action) !== kind)
            throw new Error('That call needs a different permission.');
          const parsed = this.inputs[action].parse(input ?? {});
          url ??= await this.running(id, activeSignal);
          this.allowed(id, kind, actor);
          activeSignal.throwIfAborted();
          const path = action
            .replace(/^files_/, 'files/')
            .replace(/^human_/, 'human/');
          const result = await this.json(
            `${url}/${path}`,
            this.token(id),
            ['read', 'screenshot'].includes(action) ? undefined : parsed,
            activeSignal,
            id,
          );
          this.allowed(id, kind, actor);
          if (action === 'exec' && result && typeof result === 'object') {
            const copy = { ...result } as Record<string, unknown>;
            delete copy.command;
            return copy;
          }
          return result;
        };
        return await body(call);
      } finally {
        clearInterval(watcher);
      }
    });
  }
  /**
   * A one-time ticket for opening the live screen.
   *
   * Browsers cannot send an Authorization header on a WebSocket upgrade, and the owner token must not
   * travel in a URL. The ticket is the substitute: it is random, bound to one Dot, valid for seconds,
   * and only an authenticated request can mint it.
   */
  streamTicket(id: string): ComputerStreamTicket {
    this.allowed(id, 'browser', 'owner');
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
    try {
      this.allowed(id, 'browser', 'owner');
      return true;
    } catch {
      return false;
    }
  }
  /** Where to connect for this Dot's live screen. Audited like any other owner action. */
  async openStream(
    id: string,
    signal?: AbortSignal,
  ): Promise<ComputerStreamTarget> {
    return this.audited(id, 'stream', 'owner', async () => {
      this.allowed(id, 'browser', 'owner');
      const origin = await this.running(id, signal);
      this.allowed(id, 'browser', 'owner');
      signal?.throwIfAborted();
      const token = this.token(id);
      const secrets = [
        token,
        this.config.computerToken?.trim(),
        this.config.computerSupervisorToken?.trim(),
      ].filter((secret): secret is string => !!secret);
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
