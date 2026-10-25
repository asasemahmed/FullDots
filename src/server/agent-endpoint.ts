// Endpoint checks and the redirecting fetch follow OpenBot (MIT): a stored agent
// address is a server-side request the owner chose, so every hop is checked, and
// an authorization header does not follow a redirect to a different host.
import { isLoopbackHost, isPrivateLiteral } from './connector-oauth.js';

/** Largest agent response, matching the default computer response cap. */
export const AGENT_MAX_BODY_BYTES = 4_000_000;

/** Ordinary redirect chains (https upgrade, a rename, a slash) and no further. */
const MAX_REDIRECTS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Cloud metadata addresses. Listing one in AGENT_ENDPOINT_ALLOWED_HOSTS does not
 * make it reachable: that list is for an agent the owner runs, not for credentials.
 */
const NEVER_ALLOWED = new Set(
  [
    '169.254.169.254',
    'metadata.google.internal',
    'metadata.goog',
    '169.254.170.2',
    '100.100.100.200',
    'fd00:ec2::254',
  ].map(spellHost),
);

function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

/** The host as `URL.hostname` will spell it, so an allow-list entry matches a dialled address. */
function spellHost(host: string): string {
  const wrapped = host.includes(':') ? `[${host}]` : host;
  return bareHost(new URL(`http://${wrapped}`).hostname);
}

export type EndpointVerdict =
  { allowed: true; url: string } | { allowed: false; reason: string };

export class EndpointNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EndpointNotAllowedError';
  }
}

/**
 * Hosts from `AGENT_ENDPOINT_ALLOWED_HOSTS`.
 * A host alone covers every port. A host with a port pins that port.
 * An entry that is a URL, or that contains `*`, is refused here so it cannot fail silently later.
 */
export function agentEndpointAllowedHosts(
  env: Readonly<Record<string, string | undefined>>,
): ReadonlySet<string> {
  const hosts = new Set<string>();
  for (const entry of (env.AGENT_ENDPOINT_ALLOWED_HOSTS ?? '').split(',')) {
    const host = entry.trim().toLowerCase();
    if (!host) continue;
    if (
      host.includes('/') ||
      host.includes('://') ||
      host.includes('*') ||
      host.includes('@') ||
      /\s/.test(host)
    )
      throw new Error(
        `AGENT_ENDPOINT_ALLOWED_HOSTS entry "${entry.trim()}" must be a host, optionally with a port, and not a URL.`,
      );
    hosts.add(normalizeAllowedHost(entry.trim(), host));
  }
  return hosts;
}

function normalizeAllowedHost(entry: string, host: string): string {
  const refusal = () =>
    new Error(
      `AGENT_ENDPOINT_ALLOWED_HOSTS entry "${entry}" must be a host, optionally with a port, and not a URL.`,
    );
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    const address = close === -1 ? host : host.slice(0, close + 1);
    const port = close === -1 ? '' : host.slice(close + 1);
    if (port && !/^:\d{1,5}$/.test(port)) throw refusal();
    if (port && Number(port.slice(1)) > 65535) throw refusal();
    let hostname: string;
    try {
      hostname = new URL(`http://${address}`).hostname;
    } catch {
      throw refusal();
    }
    return `${hostname}${port}`;
  }
  const colon = host.lastIndexOf(':');
  if (colon === -1) return host;
  const name = host.slice(0, colon);
  const port = host.slice(colon + 1);
  if (
    !name ||
    !/^\d{1,5}$/.test(port) ||
    Number(port) === 0 ||
    Number(port) > 65535
  )
    throw refusal();
  return `${name}:${port}`;
}

/** True when the owner named this host, or this host and port. */
export function hostIsListed(url: URL, allowed: ReadonlySet<string>): boolean {
  const hostname = url.hostname.toLowerCase();
  if (allowed.has(hostname)) return true;
  return !!url.port && allowed.has(`${hostname}:${url.port}`);
}

function hostOnly(url: URL): string {
  return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}

function neverAllowed(url: URL): boolean {
  return NEVER_ALLOWED.has(bareHost(url.hostname));
}

function localOrPrivate(url: URL): boolean {
  const host = bareHost(url.hostname);
  return isLoopbackHost(host) || isPrivateLiteral(host);
}

/**
 * Whether this address may be saved or dialled.
 * Public https addresses are allowed. http, localhost, and private or link-local
 * addresses are allowed only when the host is listed. Credentials in the URL and
 * cloud metadata addresses are never allowed.
 */
export function checkAgentEndpoint(
  raw: string,
  allowed: ReadonlySet<string> = new Set(),
): EndpointVerdict {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { allowed: false, reason: 'Enter an https address for the agent.' };
  }
  if (url.username || url.password)
    return {
      allowed: false,
      reason:
        'That address includes a username or password. Put the key in the authorization field.',
    };
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return { allowed: false, reason: 'Enter an https address for the agent.' };
  if (neverAllowed(url))
    return {
      allowed: false,
      reason: 'That address is not allowed for an agent.',
    };
  const listed = hostIsListed(url, allowed);
  if (url.protocol !== 'https:' && !listed)
    return { allowed: false, reason: 'Enter an https address for the agent.' };
  if (localOrPrivate(url) && !listed)
    return {
      allowed: false,
      reason: `That address (${hostOnly(url)}) is on this machine or a private network. List its host in AGENT_ENDPOINT_ALLOWED_HOSTS to allow it.`,
    };
  return { allowed: true, url: url.href };
}

function sameCredentialScope(from: string, to: string): boolean {
  const left = new URL(from);
  const right = new URL(to);
  if (left.hostname !== right.hostname || left.port !== right.port)
    return false;
  return (
    left.protocol === right.protocol ||
    (left.protocol === 'http:' && right.protocol === 'https:')
  );
}

/** Drop the authorization header. A redirect to another host must not receive it. */
function withoutAuthorization(init: RequestInit | undefined): RequestInit {
  const kept = new Headers();
  for (const [name, value] of new Headers(init?.headers)) {
    if (
      name.toLowerCase() === 'content-type' ||
      name.toLowerCase() === 'accept'
    )
      kept.set(name, value);
  }
  const body = init?.body;
  if (body === undefined || body === null) return { ...init, headers: kept };
  if (typeof body !== 'string')
    throw new EndpointNotAllowedError(
      'The agent redirected to another host, and the request was not forwarded.',
    );
  return { ...init, headers: kept, body };
}

function capBody(response: Response, max: number): Response {
  if (!response.body || response.status === 204 || response.status === 304)
    return response;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    void response.body.cancel().catch(() => undefined);
    throw new EndpointNotAllowedError(
      'The agent response was too large and was stopped.',
    );
  }
  let total = 0;
  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > max)
          throw new EndpointNotAllowedError(
            'The agent response was too large and was stopped.',
          );
        controller.enqueue(chunk);
      },
    }),
  );
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export interface AgentFetchOptions {
  allowedHosts?: ReadonlySet<string>;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Whole-request time limit. The turn's own stop time. */
  timeoutMs?: number;
  maxBodyBytes?: number;
}

/**
 * `fetch` that checks the stored address and every redirect before dialling it.
 * Redirects are followed, up to three, because an https upgrade is normal.
 * The method and body stay a POST: an agent speaks AG-UI, not a browser navigation.
 */
export function createAgentFetch(options: AgentFetchOptions = {}) {
  const allowed = options.allowedHosts ?? new Set<string>();
  const doFetch = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBodyBytes ?? AGENT_MAX_BODY_BYTES;
  const check = (address: string) => checkAgentEndpoint(address, allowed);

  return async function agentFetch(url: string, init?: RequestInit) {
    const stored = check(url);
    if (!stored.allowed) throw new EndpointNotAllowedError(stored.reason);
    const origin = stored.url;
    let target = stored.url;
    let carried = init;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const signals: AbortSignal[] = [];
      if (options.timeoutMs)
        signals.push(AbortSignal.timeout(options.timeoutMs));
      if (carried?.signal) signals.push(carried.signal);
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      const response = await doFetch(target, {
        ...carried,
        redirect: 'manual',
        ...(signal ? { signal } : {}),
      });
      if (!REDIRECT_STATUSES.has(response.status))
        return capBody(response, maxBytes);
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) return response;
      const next = new URL(location, target).href;
      const verdict = check(next);
      if (!verdict.allowed)
        throw new EndpointNotAllowedError(
          `The agent redirected to ${hostOnly(new URL(next))}, and that address was refused. ${verdict.reason}`,
        );
      if (!sameCredentialScope(origin, verdict.url))
        carried = withoutAuthorization(carried);
      target = verdict.url;
    }
    throw new EndpointNotAllowedError(
      'The agent redirected too many times, so the connection was refused.',
    );
  };
}

/** Remove a saved header from text we might show or log. Short values are left alone. */
export function redactHeader(text: string, header: string | undefined): string {
  if (!header || header.length < 8) return text;
  return text.split(header).join('[redacted]');
}

export interface AgentEndpointBody {
  agentEndpoint?: string | null;
  agentAuth?: string | null;
}

export type PreparedEndpoint =
  | { unchanged: true }
  | { endpoint: string | null; auth: string | null | undefined }
  | { error: string };

/**
 * What to store. `unchanged` means the request did not mention an endpoint.
 * A blank authorization field keeps the saved header. Null clears it.
 * Clearing the endpoint clears the header too.
 */
export function prepareAgentEndpoint(
  current: string | null,
  body: AgentEndpointBody,
  allowed: ReadonlySet<string>,
): PreparedEndpoint {
  if (body.agentEndpoint === undefined && body.agentAuth === undefined)
    return { unchanged: true };
  const endpoint =
    body.agentEndpoint === undefined
      ? current
      : body.agentEndpoint === null || !body.agentEndpoint.trim()
        ? null
        : body.agentEndpoint.trim();
  if (!endpoint) {
    if (body.agentAuth)
      return {
        error: 'Set an agent endpoint before an authorization header.',
      };
    return { endpoint: null, auth: null };
  }
  const verdict = checkAgentEndpoint(endpoint, allowed);
  if (!verdict.allowed) return { error: verdict.reason };
  const auth =
    body.agentAuth === undefined || body.agentAuth === ''
      ? undefined
      : body.agentAuth;
  return { endpoint: verdict.url, auth };
}
