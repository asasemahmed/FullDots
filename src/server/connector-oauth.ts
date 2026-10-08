import { randomBytes } from 'node:crypto';
import {
  auth,
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Connector } from '../shared/types.js';
import {
  PENDING_TTL_MS,
  type ConnectorAuthClearScope,
  type ConnectorAuthStore,
} from './connector-auth-store.js';

export { hashState } from './connector-auth-store.js';

/** The subset of `ConnectorAuthStore` (connector-auth-store.ts) this service uses. */
export type ConnectorAuthStoreLike = Pick<
  ConnectorAuthStore,
  | 'get'
  | 'saveDiscovery'
  | 'saveClientInfo'
  | 'saveTokens'
  | 'beginPending'
  | 'takePending'
  | 'clear'
  | 'sweep'
  | 'hasTokens'
>;

/* ------------------------------------------------------------------ */
/* guardedFetch                                                        */
/* ------------------------------------------------------------------ */

export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export interface GuardedFetchOptions {
  /** The underlying fetch (default: global `fetch`); tests inject an in-process app here. */
  fetch?: FetchLike;
  /** Total time for the request including the body; `false` disables it (long-lived MCP streams). */
  timeoutMs?: number | false;
  /** Largest response body; `false` disables it (MCP tool results are not capped here). */
  maxBodyBytes?: number | false;
}

function bareHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/** Dotted quad for an IPv4 literal, or an IPv4-mapped IPv6 literal (`::ffff:a00:1`); else undefined. */
function ipv4Of(host: string): number[] | undefined {
  const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (dotted) return dotted.slice(1).map(Number);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const high = parseInt(mapped[1] ?? '0', 16);
    const low = parseInt(mapped[2] ?? '0', 16);
    return [high >> 8, high & 255, low >> 8, low & 255];
  }
  return undefined;
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') {
    return true;
  }
  return ipv4Of(host)?.[0] === 127;
}

/** Literal private, link-local, unspecified and carrier-grade-NAT addresses (never hostnames). */
function isPrivateLiteral(host: string): boolean {
  const v4 = ipv4Of(host);
  if (v4) {
    const [a = 0, b = 0] = v4;
    return (
      a === 0 ||
      a === 10 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (!host.includes(':')) return false;
  return host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
}

/** Throws unless the URL may be fetched on behalf of an OAuth connector. */
export function assertAllowedUrl(url: URL): void {
  const host = bareHost(url);
  const loopback = isLoopbackHost(host);
  if (url.protocol === 'https:') {
    if (!loopback && isPrivateLiteral(host)) {
      throw new Error(`Refused request to a private address (${url.origin})`);
    }
    return;
  }
  if (url.protocol === 'http:') {
    if (loopback) return;
    throw new Error(
      `Refused plain http request to ${url.origin}; only https is allowed (http is limited to localhost)`,
    );
  }
  throw new Error(`Refused request with unsupported scheme ${url.protocol}`);
}

async function capBody(response: Response, max: number): Promise<Response> {
  if (
    !response.body ||
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304
  ) {
    return response;
  }
  const tooLarge = () =>
    new Error(`Response body exceeds ${max} bytes; refused`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await response.body.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(Buffer.concat(chunks), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * A `fetch` for traffic whose URLs an MCP server operator chose (discovery, registration, token,
 * revocation, and the MCP transport itself): https always, http only for loopback, literal
 * private/link-local addresses refused, redirects never followed, optional timeout and body cap.
 * Hostnames are not resolved, so DNS-based access to private ranges is not blocked here.
 */
export function guardedFetch(options: GuardedFetchOptions = {}): FetchLike {
  const base: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs =
    options.timeoutMs === undefined
      ? DEFAULT_FETCH_TIMEOUT_MS
      : options.timeoutMs;
  const maxBytes =
    options.maxBodyBytes === undefined
      ? DEFAULT_MAX_BODY_BYTES
      : options.maxBodyBytes;
  return async (input, init) => {
    const url = new URL(String(input));
    assertAllowedUrl(url);
    const signals: AbortSignal[] = [];
    if (timeoutMs !== false) signals.push(AbortSignal.timeout(timeoutMs));
    if (init?.signal) signals.push(init.signal);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const response = await base(input, {
      ...init,
      redirect: 'manual',
      ...(signal ? { signal } : {}),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `Request to ${url.origin} was redirected (HTTP ${response.status}); redirects are not followed`,
      );
    }
    return maxBytes === false ? response : capBody(response, maxBytes);
  };
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export const OAUTH_CALLBACK_PATH = '/api/connectors/oauth/callback';
const SECRET_HISTORY = 6;
const ERROR_MAX = 200;

/** The part of a `Connector` the service needs. */
export type OAuthConnector = Pick<Connector, 'id' | 'url'>;

export type ConnectorOAuthMode = 'interactive' | 'transport';

export class OAuthCallbackError extends Error {
  constructor(
    readonly code: 'expired' | 'failed',
    message: string,
    /** The connector the request belonged to, when known (not for an expired or unknown state). */
    readonly connectorId?: string,
  ) {
    super(message);
    this.name = 'OAuthCallbackError';
  }
}

/** `OAuthDiscoveryState` plus the MCP server URL it was discovered for (extra key, round-trips as JSON). */
type StoredDiscovery = OAuthDiscoveryState & { serverUrl?: string };

export interface ConnectorOAuthOptions {
  store: ConnectorAuthStoreLike;
  /** `PlatformConfig.publicOrigin`; the redirect URL is built from it, never from a hardcoded port. */
  publicOrigin: string;
  /** Replaces the default guarded fetch for both `fetch` and `transportFetch` (test seam; unguarded). */
  fetch?: FetchLike;
  /** The underlying fetch the default guarded fetches wrap (tests inject an in-process app here). */
  baseFetch?: FetchLike;
  /** Resolves a connector's MCP URL for `finish`; falls back to the URL saved with the discovery state. */
  serverUrlFor?: (connectorId: string) => string | null | undefined;
  /** How long an authorization may stay pending (default: the store's 10 minutes). */
  pendingTtlMs?: number;
  softwareVersion?: string;
}

/** Interactive providers also expose the captured authorization URL. */
export interface InteractiveOAuthProvider extends OAuthClientProvider {
  readonly authorizationUrl: URL | undefined;
}

interface ProviderContext {
  store: ConnectorAuthStoreLike;
  connectorId: string;
  serverUrl: string | undefined;
  redirectUrl: string;
  clientMetadata: OAuthClientMetadata;
  pendingTtlMs: number;
  remember: (tokens: OAuthTokens | undefined) => void;
  /** Only `finish` sets this: the verifier taken from the pending row. */
  verifier?: string;
}

class ConnectorOAuthProvider implements InteractiveOAuthProvider {
  authorizationUrl: URL | undefined;
  private pendingState: string | undefined;

  constructor(
    private readonly ctx: ProviderContext,
    private readonly mode: ConnectorOAuthMode,
  ) {}

  get redirectUrl(): string {
    return this.ctx.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this.ctx.clientMetadata;
  }

  state(): string {
    this.pendingState = randomBytes(32).toString('base64url');
    return this.pendingState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.ctx.store.get(this.ctx.connectorId)?.clientInfo as
      OAuthClientInformationMixed | undefined;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.ctx.store.saveClientInfo(
      this.ctx.connectorId,
      info,
      this.ctx.redirectUrl,
    );
  }

  tokens(): OAuthTokens | undefined {
    const tokens = this.ctx.store.get(this.ctx.connectorId)?.tokens as
      OAuthTokens | undefined;
    this.ctx.remember(tokens);
    return tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.ctx.remember(tokens);
    this.ctx.store.saveTokens(this.ctx.connectorId, tokens);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (this.mode === 'transport') {
      throw new UnauthorizedError('Authorization required');
    }
    this.authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    if (this.mode === 'transport') return;
    if (this.pendingState === undefined) {
      throw new Error('Authorization state was not generated');
    }
    this.ctx.store.beginPending(
      this.ctx.connectorId,
      this.ctx.redirectUrl,
      codeVerifier,
      this.pendingState,
      this.ctx.pendingTtlMs,
    );
  }

  codeVerifier(): string {
    if (this.ctx.verifier === undefined) {
      throw new Error('No PKCE code verifier is available');
    }
    return this.ctx.verifier;
  }

  invalidateCredentials(scope: ConnectorAuthClearScope): void {
    this.ctx.store.clear(this.ctx.connectorId, scope);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.ctx.store.get(this.ctx.connectorId)?.discovery as
      OAuthDiscoveryState | undefined;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    const stored: StoredDiscovery = this.ctx.serverUrl
      ? { ...state, serverUrl: this.ctx.serverUrl }
      : state;
    this.ctx.store.saveDiscovery(this.ctx.connectorId, stored);
  }
}

export class ConnectorOAuthService {
  /** Strict: 20 s total, 1 MB body. For discovery, registration, token and revocation requests. */
  readonly fetch: FetchLike;
  /** Same URL and redirect rules, but no total timeout or body cap: MCP responses can be long streams. */
  readonly transportFetch: FetchLike;
  private readonly store: ConnectorAuthStoreLike;
  private readonly origin: string;
  private readonly pendingTtlMs: number;
  private readonly softwareVersion: string | undefined;
  private readonly serverUrlFor: ConnectorOAuthOptions['serverUrlFor'];
  private readonly secretCache = new Map<string, string[]>();

  constructor(options: ConnectorOAuthOptions) {
    this.store = options.store;
    this.origin = options.publicOrigin.replace(/\/+$/, '');
    this.pendingTtlMs = options.pendingTtlMs ?? PENDING_TTL_MS;
    this.softwareVersion = options.softwareVersion;
    this.serverUrlFor = options.serverUrlFor;
    this.fetch = options.fetch ?? guardedFetch({ fetch: options.baseFetch });
    this.transportFetch =
      options.fetch ??
      guardedFetch({
        fetch: options.baseFetch,
        timeoutMs: false,
        maxBodyBytes: false,
      });
  }

  redirectUrl(): string {
    return `${this.origin}${OAUTH_CALLBACK_PATH}`;
  }

  clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl()],
      client_name: 'FullDots',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      software_id: 'fulldots',
      ...(this.softwareVersion
        ? { software_version: this.softwareVersion }
        : {}),
    };
  }

  providerFor(
    connector: OAuthConnector,
    mode: 'interactive',
  ): InteractiveOAuthProvider;
  providerFor(
    connector: OAuthConnector,
    mode: ConnectorOAuthMode,
  ): OAuthClientProvider;
  providerFor(
    connector: OAuthConnector,
    mode: ConnectorOAuthMode,
  ): InteractiveOAuthProvider {
    return this.buildProvider(connector.id, connector.url ?? undefined, mode);
  }

  /**
   * Starts authorization. Returns the URL for the popup, or `undefined` when a stored refresh
   * token sufficed (the connector is authorized again without a browser).
   */
  async begin(connector: OAuthConnector): Promise<URL | undefined> {
    const serverUrl = connector.url;
    if (!serverUrl) throw new Error('This connector has no URL to authorize');
    this.store.sweep();
    const current = this.store.get(connector.id);
    if (current) {
      // A registration is bound to the redirect URL and to the server it was made for.
      const savedUrl = (current.discovery as StoredDiscovery | undefined)
        ?.serverUrl;
      if (savedUrl !== undefined && savedUrl !== serverUrl) {
        this.store.clear(connector.id, 'all');
      } else if (
        current.clientInfo !== undefined &&
        current.redirectUrl !== this.redirectUrl()
      ) {
        this.store.clear(connector.id, 'client');
      }
    }
    const provider = this.buildProvider(connector.id, serverUrl, 'interactive');
    const result = await auth(provider, { serverUrl, fetchFn: this.fetch });
    if (result === 'AUTHORIZED') return undefined;
    if (!provider.authorizationUrl) {
      throw new Error('The authorization server did not provide a sign-in URL');
    }
    return provider.authorizationUrl;
  }

  /** Completes the callback: exchanges `code` for tokens. Resolves to the connector id. */
  async finish(stateHash: string, code: string): Promise<string> {
    const pending = this.store.takePending(stateHash);
    if (!pending) {
      throw new OAuthCallbackError(
        'expired',
        'This authorization request expired or was already used. Start again from the connector.',
      );
    }
    const record = this.store.get(pending.connectorId);
    const discovery = record?.discovery as StoredDiscovery | undefined;
    const serverUrl =
      this.serverUrlFor?.(pending.connectorId) ??
      discovery?.serverUrl ??
      discovery?.resourceMetadata?.resource;
    if (!serverUrl) {
      throw new OAuthCallbackError(
        'failed',
        'The connector no longer has a server URL. Start again from the connector.',
        pending.connectorId,
      );
    }
    const provider = this.buildProvider(
      pending.connectorId,
      serverUrl,
      'interactive',
      pending.verifier,
    );
    let result;
    try {
      result = await auth(provider, {
        serverUrl,
        authorizationCode: code,
        fetchFn: this.fetch,
      });
    } catch (error) {
      throw new OAuthCallbackError(
        'failed',
        this.scrub(error, [code, pending.verifier]),
        pending.connectorId,
      );
    }
    if (result !== 'AUTHORIZED') {
      throw new OAuthCallbackError(
        'failed',
        'The authorization server did not return tokens.',
        pending.connectorId,
      );
    }
    return pending.connectorId;
  }

  /** Best-effort revoke (RFC 7009) then forget the tokens. The client registration is kept. */
  async disconnect(id: string): Promise<void> {
    const record = this.store.get(id);
    const discovery = record?.discovery as OAuthDiscoveryState | undefined;
    const endpoint = (
      discovery?.authorizationServerMetadata as
        { revocation_endpoint?: string } | undefined
    )?.revocation_endpoint;
    const tokens = record?.tokens as OAuthTokens | undefined;
    const clientInfo = record?.clientInfo as
      OAuthClientInformationMixed | undefined;
    if (endpoint && tokens && clientInfo) {
      this.remember(id, tokens);
      const attempts: Array<[string, string]> = [];
      if (tokens.refresh_token) {
        attempts.push([tokens.refresh_token, 'refresh_token']);
      }
      attempts.push([tokens.access_token, 'access_token']);
      for (const [token, hint] of attempts) {
        await this.revoke(endpoint, clientInfo, token, hint).catch(
          () => undefined,
        );
      }
    }
    this.store.clear(id, 'tokens');
    this.store.clear(id, 'verifier');
  }

  hasTokens(id: string): boolean {
    return this.store.hasTokens(id);
  }

  /** Plaintext access and refresh tokens seen so far, for `redact()`. */
  secrets(): string[] {
    return [...this.secretCache.values()].flat();
  }

  private buildProvider(
    connectorId: string,
    serverUrl: string | undefined,
    mode: ConnectorOAuthMode,
    verifier?: string,
  ): ConnectorOAuthProvider {
    return new ConnectorOAuthProvider(
      {
        store: this.store,
        connectorId,
        serverUrl,
        redirectUrl: this.redirectUrl(),
        clientMetadata: this.clientMetadata(),
        pendingTtlMs: this.pendingTtlMs,
        remember: (tokens) => this.remember(connectorId, tokens),
        verifier,
      },
      mode,
    );
  }

  private remember(id: string, tokens: OAuthTokens | undefined): void {
    if (!tokens) return;
    const known = this.secretCache.get(id) ?? [];
    const next = [tokens.refresh_token, tokens.access_token]
      .filter((value): value is string => !!value && !known.includes(value))
      .concat(known)
      .slice(0, SECRET_HISTORY);
    this.secretCache.set(id, next);
  }

  private async revoke(
    endpoint: string,
    client: OAuthClientInformationMixed,
    token: string,
    hint: string,
  ): Promise<void> {
    const headers = new Headers({
      'content-type': 'application/x-www-form-urlencoded',
    });
    const body = new URLSearchParams({ token, token_type_hint: hint });
    if ('client_secret' in client && client.client_secret) {
      headers.set(
        'authorization',
        `Basic ${Buffer.from(
          `${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`,
        ).toString('base64')}`,
      );
    } else {
      body.set('client_id', client.client_id);
    }
    const response = await this.fetch(endpoint, {
      method: 'POST',
      headers,
      body,
    });
    await response.body?.cancel().catch(() => undefined);
  }

  /** Error text safe for the callback page: known secrets removed, truncated. */
  private scrub(error: unknown, extra: string[]): string {
    let text = error instanceof Error ? error.message : String(error);
    for (const secret of [...this.secrets(), ...extra]) {
      if (secret) text = text.split(secret).join('[redacted]');
    }
    return text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX - 1)}…` : text;
  }
}
