import { createHash, randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Hono } from 'hono';
import { z } from 'zod';

/**
 * An in-process OAuth 2.1 authorization server plus a Bearer-gated MCP resource server at `/mcp`.
 * It is a Hono app: `fixture.fetch` is handed to the SDK as the `FetchLike`, so no socket is
 * ever opened. The origin is fictional (nothing listens on it).
 */
export interface OAuthFixtureOptions {
  /** Default `http://127.0.0.1:4010`. */
  origin?: string;
  /** `false` omits `registration_endpoint` from the metadata and 404s `/register`. Default true. */
  dcr?: boolean;
  /** Issue a `client_secret` at registration (client_secret_basic). Default false (public client). */
  clientSecret?: boolean;
  /** Issue a fresh refresh token on every refresh and invalidate the old one. */
  rotateOnRefresh?: boolean;
  /** The next refresh_token grant answers `invalid_grant` (once). */
  invalidGrantOnce?: boolean;
  /** Advertise `revocation_endpoint` (default true). */
  revocation?: boolean;
  /** What the MCP tool `echo_secret` returns. */
  secret?: string;
  /** `expires_in` of issued access tokens, seconds. Default 3600. */
  expiresIn?: number;
}

export interface FixtureRegistration {
  clientId: string;
  clientSecret: string | undefined;
  redirectUris: string[];
}

export interface FixtureAuthorizeRequest {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  resource: string | null;
  url: URL;
}

export interface FixtureTokenRequest {
  grantType: string;
  clientId: string | undefined;
  /** Whether the client authenticated with a secret (basic or post). */
  authenticated: boolean;
  params: Record<string, string>;
}

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('base64url');
const random = (prefix: string) =>
  `${prefix}-${randomBytes(18).toString('base64url')}`;

const text = (value: string) => ({
  content: [{ type: 'text' as const, text: value }],
});

export function createOAuthFixture(options: OAuthFixtureOptions = {}) {
  const origin = (options.origin ?? 'http://127.0.0.1:4010').replace(
    /\/+$/,
    '',
  );
  const mcpUrl = `${origin}/mcp`;
  const dcr = options.dcr ?? true;
  const expiresIn = options.expiresIn ?? 3600;
  const rotateOnRefresh = options.rotateOnRefresh ?? false;
  let invalidGrantOnce = options.invalidGrantOnce ?? false;

  const clients = new Map<string, FixtureRegistration>();
  const codes = new Map<
    string,
    {
      clientId: string;
      redirectUri: string;
      challenge: string;
      resource: string;
    }
  >();
  const accessTokens = new Map<string, string>();
  const refreshTokens = new Map<string, string>();
  let unauthorizedIn: number | undefined;

  const log = {
    registrations: [] as FixtureRegistration[],
    authorize: [] as FixtureAuthorizeRequest[],
    token: [] as FixtureTokenRequest[],
    revoked: [] as Array<{
      token: string;
      hint: string | undefined;
      clientId: string | undefined;
    }>,
    /** Number of `/mcp` requests that carried a valid token. */
    mcpAuthorized: 0,
    /** Number of `/mcp` requests answered 401. */
    mcpRejected: 0,
  };

  const oauthError = (error: string, description: string, status = 400) =>
    Response.json({ error, error_description: description }, { status });

  function issue(clientId: string, refreshToken?: string) {
    const access = random('at');
    accessTokens.set(access, clientId);
    let refresh = refreshToken;
    if (refresh === undefined) {
      refresh = random('rt');
      refreshTokens.set(refresh, clientId);
    }
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refresh,
    };
  }

  function buildServer(): McpServer {
    const server = new McpServer({ name: 'oauth-fixture', version: '1.0.0' });
    server.registerTool(
      'get_issue',
      {
        description: 'Read one issue.',
        inputSchema: { number: z.number() },
        annotations: { readOnlyHint: true },
      },
      async ({ number }) => text(JSON.stringify({ number, title: 'Bug' })),
    );
    server.registerTool(
      'echo_secret',
      {
        description: 'Return the secret the fixture was given.',
        annotations: { readOnlyHint: true },
      },
      async () => text(options.secret ?? ''),
    );
    return server;
  }

  const app = new Hono();

  app.get('/.well-known/oauth-protected-resource', (c) =>
    c.json(resourceMetadata()),
  );
  app.get('/.well-known/oauth-protected-resource/mcp', (c) =>
    c.json(resourceMetadata()),
  );
  function resourceMetadata() {
    return {
      resource: mcpUrl,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
    };
  }

  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      ...(dcr ? { registration_endpoint: `${origin}/register` } : {}),
      ...(options.revocation === false
        ? {}
        : { revocation_endpoint: `${origin}/revoke` }),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: [
        'none',
        'client_secret_basic',
        'client_secret_post',
      ],
    }),
  );

  app.post('/register', async (c) => {
    if (!dcr) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json()) as {
      redirect_uris?: string[];
      client_name?: string;
    };
    if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
      return oauthError('invalid_redirect_uri', 'redirect_uris is required');
    }
    const registration: FixtureRegistration = {
      clientId: `client-${clients.size + 1}`,
      clientSecret: options.clientSecret ? random('secret') : undefined,
      redirectUris: body.redirect_uris,
    };
    clients.set(registration.clientId, registration);
    log.registrations.push(registration);
    return c.json(
      {
        client_id: registration.clientId,
        ...(registration.clientSecret
          ? { client_secret: registration.clientSecret }
          : {}),
        client_name: body.client_name,
        redirect_uris: registration.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: registration.clientSecret
          ? 'client_secret_basic'
          : 'none',
      },
      201,
    );
  });

  app.get('/authorize', (c) => {
    const url = new URL(c.req.url);
    const q = url.searchParams;
    const clientId = q.get('client_id') ?? '';
    const redirectUri = q.get('redirect_uri') ?? '';
    log.authorize.push({
      clientId,
      redirectUri,
      state: q.get('state'),
      codeChallenge: q.get('code_challenge'),
      codeChallengeMethod: q.get('code_challenge_method'),
      resource: q.get('resource'),
      url,
    });
    const client = clients.get(clientId);
    if (!client) return c.text('unknown client_id', 400);
    if (!client.redirectUris.includes(redirectUri)) {
      return c.text('redirect_uri is not registered', 400);
    }
    if (q.get('response_type') !== 'code')
      return c.text('response_type must be code', 400);
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
      return c.text('PKCE S256 is required', 400);
    }
    const target = new URL(redirectUri);
    const resource = q.get('resource') ?? '';
    if (resource !== mcpUrl) {
      target.searchParams.set('error', 'invalid_target');
    } else {
      const code = random('code');
      codes.set(code, {
        clientId,
        redirectUri,
        challenge: q.get('code_challenge') ?? '',
        resource,
      });
      target.searchParams.set('code', code);
    }
    const state = q.get('state');
    if (state) target.searchParams.set('state', state);
    return c.redirect(target.toString(), 302);
  });

  app.post('/token', async (c) => {
    const params = Object.fromEntries(
      new URLSearchParams(await c.req.text()),
    ) as Record<string, string>;
    let clientId = params.client_id;
    let presentedSecret = params.client_secret;
    const basic = /^Basic (.+)$/i.exec(c.req.header('authorization') ?? '');
    if (basic?.[1]) {
      const [id, secret] = Buffer.from(basic[1], 'base64')
        .toString()
        .split(':');
      clientId = decodeURIComponent(id ?? '');
      presentedSecret = decodeURIComponent(secret ?? '');
    }
    const client = clientId ? clients.get(clientId) : undefined;
    log.token.push({
      grantType: params.grant_type ?? '',
      clientId,
      authenticated: presentedSecret !== undefined,
      params,
    });
    if (!client || !clientId)
      return oauthError('invalid_client', 'Unknown client', 401);
    if (client.clientSecret && presentedSecret !== client.clientSecret) {
      return oauthError('invalid_client', 'Bad client secret', 401);
    }

    if (params.grant_type === 'authorization_code') {
      const grant = codes.get(params.code ?? '');
      if (!grant) return oauthError('invalid_grant', 'Unknown or used code');
      codes.delete(params.code ?? '');
      if (grant.clientId !== clientId)
        return oauthError('invalid_grant', 'Code belongs to another client');
      if (params.redirect_uri !== grant.redirectUri) {
        return oauthError('invalid_grant', 'redirect_uri mismatch');
      }
      if (
        !params.code_verifier ||
        sha256(params.code_verifier) !== grant.challenge
      ) {
        return oauthError('invalid_grant', 'PKCE verification failed');
      }
      if (params.resource !== grant.resource) {
        return oauthError('invalid_target', 'resource mismatch');
      }
      return c.json(issue(clientId));
    }

    if (params.grant_type === 'refresh_token') {
      if (invalidGrantOnce) {
        invalidGrantOnce = false;
        return oauthError('invalid_grant', 'Refresh token rejected');
      }
      const owner = refreshTokens.get(params.refresh_token ?? '');
      if (owner !== clientId)
        return oauthError('invalid_grant', 'Unknown refresh token');
      if (params.resource !== mcpUrl)
        return oauthError('invalid_target', 'resource mismatch');
      if (rotateOnRefresh) {
        refreshTokens.delete(params.refresh_token ?? '');
        return c.json(issue(clientId));
      }
      return c.json(issue(clientId, params.refresh_token));
    }

    return oauthError('unsupported_grant_type', 'Unsupported grant_type');
  });

  app.post('/revoke', async (c) => {
    const params = Object.fromEntries(new URLSearchParams(await c.req.text()));
    const token = params.token ?? '';
    log.revoked.push({
      token,
      hint: params.token_type_hint,
      clientId: params.client_id,
    });
    accessTokens.delete(token);
    refreshTokens.delete(token);
    return c.body(null, 200);
  });

  app.all('/mcp', async (c) => {
    const bearer = /^Bearer (.+)$/i.exec(
      c.req.header('authorization') ?? '',
    )?.[1];
    const valid = bearer !== undefined && accessTokens.has(bearer);
    let reject = !valid;
    if (valid && unauthorizedIn !== undefined) {
      if (unauthorizedIn === 0) {
        unauthorizedIn = undefined;
        accessTokens.clear();
        reject = true;
      } else {
        unauthorizedIn -= 1;
      }
    }
    if (reject) {
      log.mcpRejected += 1;
      return new Response(JSON.stringify({ error: 'invalid_token' }), {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'www-authenticate': `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        },
      });
    }
    log.mcpAuthorized += 1;
    const server = buildServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  const fixtureFetch: FetchLike = (url, init) =>
    Promise.resolve(app.fetch(new Request(url, init)));

  return {
    app,
    origin,
    /** The MCP endpoint (also the RFC 8707 resource). */
    mcpUrl,
    /** Hand this to the SDK / `guardedFetch({ fetch })`. */
    fetch: fixtureFetch,
    log,
    clients,
    /** Currently valid access tokens. */
    accessTokens: () => [...accessTokens.keys()],
    refreshTokens: () => [...refreshTokens.keys()],
    /**
     * After `n` more authorized `/mcp` requests, the next one is answered 401 and every issued
     * access token stops working, so the client has to refresh (or re-authorize).
     */
    unauthorizedAfter(n: number) {
      unauthorizedIn = n;
    },
    /** Make every issued access token invalid right now. */
    expireAccessTokens() {
      accessTokens.clear();
    },
    /** Make every issued refresh token invalid right now. */
    revokeRefreshTokens() {
      refreshTokens.clear();
    },
    /** The next refresh_token grant answers `invalid_grant`. */
    failNextRefresh() {
      invalidGrantOnce = true;
    },
    /**
     * Plays the browser: GET the authorization URL without following the redirect and read the
     * Location header. Returns the code and state the provider would send to the callback.
     */
    async approve(authorizationUrl: URL | string) {
      const response = await fixtureFetch(String(authorizationUrl), {
        redirect: 'manual',
      });
      const location = response.headers.get('location');
      if (response.status !== 302 || !location) {
        throw new Error(`authorize answered ${response.status}`);
      }
      const target = new URL(location);
      return {
        location: target,
        code: target.searchParams.get('code'),
        state: target.searchParams.get('state'),
        error: target.searchParams.get('error'),
      };
    },
  };
}

export type OAuthFixture = ReturnType<typeof createOAuthFixture>;
