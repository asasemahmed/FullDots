import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorAuthStore } from '../src/server/connector-auth-store.js';
import {
  ConnectorOAuthService,
  OAuthCallbackError,
  guardedFetch,
  hashState,
  type ConnectorOAuthOptions,
} from '../src/server/connector-oauth.js';
import {
  createOAuthFixture,
  type OAuthFixtureOptions,
} from './fixtures/oauth-server.js';

const PUBLIC_ORIGIN = 'http://localhost:5173';
const CALLBACK = `${PUBLIC_ORIGIN}/api/connectors/oauth/callback`;
const key = Buffer.alloc(32, 7);

const dbs: DatabaseSync[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of dbs.splice(0)) db.close();
});

function setup(
  fixtureOptions: OAuthFixtureOptions = {},
  serviceOptions: Partial<ConnectorOAuthOptions> = {},
) {
  const fixture = createOAuthFixture(fixtureOptions);
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  const store = new ConnectorAuthStore(db, key);
  const service = new ConnectorOAuthService({
    store,
    publicOrigin: PUBLIC_ORIGIN,
    baseFetch: fixture.fetch,
    ...serviceOptions,
  });
  const connector = { id: 'c1', url: fixture.mcpUrl };
  /** begin → approve in the "browser" → finish. */
  async function authorize() {
    const url = await service.begin(connector);
    if (!url) throw new Error('expected an authorization URL');
    const approved = await fixture.approve(url);
    const state = approved.state ?? '';
    await service.finish(hashState(state), approved.code ?? '');
    return { url, state, code: approved.code ?? '' };
  }
  return { fixture, store, service, connector, authorize, db };
}

function storedTokens(store: ConnectorAuthStore): OAuthTokens {
  return store.get('c1')?.tokens as OAuthTokens;
}

describe('begin', () => {
  it('registers once, stamps the issuer and builds a PKCE authorization URL', async () => {
    const { fixture, store, service, connector } = setup();
    const url = await service.begin(connector);
    expect(url).toBeInstanceOf(URL);
    const params = url!.searchParams;
    expect(url!.origin).toBe(fixture.origin);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(params.get('resource')).toBe(fixture.mcpUrl);
    expect(params.get('redirect_uri')).toBe(CALLBACK);
    expect(params.get('response_type')).toBe('code');
    expect(params.get('state')).toMatch(/^[\w-]{43}$/);
    expect(fixture.log.registrations).toHaveLength(1);
    expect(fixture.log.registrations[0]?.redirectUris).toEqual([CALLBACK]);

    const record = store.get('c1');
    expect(record?.clientInfo).toMatchObject({
      client_id: 'client-1',
      issuer: fixture.origin,
    });
    expect(record?.redirectUrl).toBe(CALLBACK);
    expect(record?.pending).toBe(true);

    // A second begin reuses the registration and replaces the pending flow.
    const again = await service.begin(connector);
    expect(fixture.log.registrations).toHaveLength(1);
    expect(again!.searchParams.get('state')).not.toBe(params.get('state'));
    expect(
      store.takePending(hashState(params.get('state') ?? '')),
    ).toBeUndefined();
  });

  it('registers as a public client named FullDots', async () => {
    const { fixture, service, connector } = setup();
    expect(service.redirectUrl()).toBe(CALLBACK);
    expect(service.clientMetadata()).toMatchObject({
      client_name: 'FullDots',
      redirect_uris: [CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    });
    await service.begin(connector);
    expect(fixture.log.registrations).toHaveLength(1);
  });

  it('names registration in the error when the server has no DCR', async () => {
    const { service, connector, fixture } = setup({ dcr: false });
    await expect(service.begin(connector)).rejects.toThrow(/registration/i);
    expect(fixture.log.registrations).toHaveLength(0);
  });

  it('refuses a connector without a URL', async () => {
    const { service } = setup();
    await expect(service.begin({ id: 'x', url: null })).rejects.toThrow(
      /no URL/,
    );
  });
});

describe('finish', () => {
  it('exchanges the code and stores tokens with the issuer stamp', async () => {
    const { fixture, store, service, authorize } = setup();
    expect(service.hasTokens('c1')).toBe(false);
    const { code } = await authorize();

    expect(service.hasTokens('c1')).toBe(true);
    const request = fixture.log.token[0];
    expect(request?.grantType).toBe('authorization_code');
    expect(request?.params.redirect_uri).toBe(CALLBACK);
    expect(request?.params.resource).toBe(fixture.mcpUrl);
    expect(request?.params.code).toBe(code);
    expect(request?.params.code_verifier).toMatch(/^[\w.~-]{43,128}$/);

    const tokens = storedTokens(store);
    expect(tokens.access_token).toMatch(/^at-/);
    expect(tokens.refresh_token).toMatch(/^rt-/);
    expect(tokens.issuer).toBe(fixture.origin);
    expect(store.get('c1')?.pending).toBe(false);
    expect(store.get('c1')?.expiresAt).toBeGreaterThan(Date.now());
  });

  it('rejects a second finish with the same state', async () => {
    const { service, authorize } = setup();
    const { state, code } = await authorize();
    const second = service.finish(hashState(state), code);
    await expect(second).rejects.toBeInstanceOf(OAuthCallbackError);
    await expect(second).rejects.toMatchObject({ code: 'expired' });
  });

  it('rejects an unknown state', async () => {
    const { service } = setup();
    await expect(
      service.finish(hashState('nope'), 'code'),
    ).rejects.toMatchObject({ code: 'expired' });
  });

  it('rejects an expired pending flow', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { fixture, service, connector } = setup({}, { pendingTtlMs: 1000 });
    const url = await service.begin(connector);
    const approved = await fixture.approve(url!);
    vi.setSystemTime(Date.now() + 2000);
    await expect(
      service.finish(hashState(approved.state ?? ''), approved.code ?? ''),
    ).rejects.toMatchObject({ code: 'expired' });
    expect(service.hasTokens('c1')).toBe(false);
  });

  it('fails with a short message that omits the code and verifier', async () => {
    const { fixture, service, connector } = setup();
    const url = await service.begin(connector);
    const approved = await fixture.approve(url!);
    const wrong = 'not-the-issued-code';
    const failure = await service
      .finish(hashState(approved.state ?? ''), wrong)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(OAuthCallbackError);
    const message = (failure as OAuthCallbackError).message;
    expect((failure as OAuthCallbackError).code).toBe('failed');
    expect(message.length).toBeLessThanOrEqual(200);
    expect(message).not.toContain(wrong);
    expect(message).not.toContain(
      fixture.log.token[0]?.params.code_verifier ?? 'unreachable',
    );
    expect(service.hasTokens('c1')).toBe(false);
  });

  it('authenticates with client_secret_basic when the server issues a secret', async () => {
    const { fixture, service, authorize } = setup({ clientSecret: true });
    await authorize();
    expect(fixture.log.token[0]?.authenticated).toBe(true);
    expect(service.hasTokens('c1')).toBe(true);
  });
});

describe('refresh', () => {
  it('begin() refreshes silently and returns undefined', async () => {
    const { fixture, store, service, connector, authorize } = setup();
    await authorize();
    const before = storedTokens(store);
    fixture.expireAccessTokens();

    await expect(service.begin(connector)).resolves.toBeUndefined();

    const grants = fixture.log.token.map((entry) => entry.grantType);
    expect(grants).toEqual(['authorization_code', 'refresh_token']);
    const after = storedTokens(store);
    expect(after.access_token).not.toBe(before.access_token);
    expect(after.refresh_token).toBe(before.refresh_token);
    expect(after.issuer).toBe(fixture.origin);
    expect(fixture.log.registrations).toHaveLength(1);
    expect(store.get('c1')?.pending).toBe(false);
    expect(service.secrets()).toEqual(
      expect.arrayContaining([
        before.access_token,
        after.access_token,
        before.refresh_token ?? '',
      ]),
    );
  });

  it('stores a rotated refresh token and refreshes again with it', async () => {
    const { store, service, connector, authorize } = setup({
      rotateOnRefresh: true,
    });
    await authorize();
    const first = storedTokens(store);
    await service.begin(connector);
    const second = storedTokens(store);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    await expect(service.begin(connector)).resolves.toBeUndefined();
    const third = storedTokens(store);
    expect(third.refresh_token).not.toBe(second.refresh_token);
    expect(service.secrets()).toEqual(
      expect.arrayContaining([
        first.refresh_token ?? '',
        second.refresh_token ?? '',
        third.refresh_token ?? '',
      ]),
    );
  });

  it('clears tokens on invalid_grant and returns a new authorization URL', async () => {
    const { fixture, store, service, connector, authorize } = setup();
    await authorize();
    fixture.failNextRefresh();

    const url = await service.begin(connector);

    expect(url).toBeInstanceOf(URL);
    expect(service.hasTokens('c1')).toBe(false);
    expect(store.get('c1')?.tokens).toBeUndefined();
    expect(store.get('c1')?.clientInfo).toBeDefined();
    expect(fixture.log.registrations).toHaveLength(1);
    expect(store.get('c1')?.pending).toBe(true);
  });
});

describe('disconnect', () => {
  it('revokes at the server, clears tokens and keeps the registration', async () => {
    const { fixture, store, service, authorize } = setup();
    await authorize();
    const tokens = storedTokens(store);

    await service.disconnect('c1');

    expect(fixture.log.revoked.map((entry) => entry.token)).toEqual([
      tokens.refresh_token,
      tokens.access_token,
    ]);
    expect(fixture.log.revoked[0]?.hint).toBe('refresh_token');
    expect(fixture.log.revoked[0]?.clientId).toBe('client-1');
    expect(fixture.accessTokens()).toEqual([]);
    expect(service.hasTokens('c1')).toBe(false);
    const record = store.get('c1');
    expect(record?.clientInfo).toMatchObject({ client_id: 'client-1' });
    expect(record?.discovery).toBeDefined();

    // Re-connecting reuses the registration.
    await authorize();
    expect(fixture.log.registrations).toHaveLength(1);
  });

  it('still clears tokens when the server has no revocation endpoint', async () => {
    const { fixture, service, authorize } = setup({ revocation: false });
    await authorize();
    await service.disconnect('c1');
    expect(fixture.log.revoked).toHaveLength(0);
    expect(service.hasTokens('c1')).toBe(false);
  });

  it('ignores a failing revocation call', async () => {
    const { service, authorize, store } = setup();
    await authorize();
    const failing = new ConnectorOAuthService({
      store,
      publicOrigin: PUBLIC_ORIGIN,
      baseFetch: () => Promise.reject(new Error('network down')),
    });
    await expect(failing.disconnect('c1')).resolves.toBeUndefined();
    expect(service.hasTokens('c1')).toBe(false);
  });

  it('also drops a pending authorization', async () => {
    const { store, service, connector } = setup();
    await service.begin(connector);
    expect(store.get('c1')?.pending).toBe(true);
    await service.disconnect('c1');
    expect(store.get('c1')?.pending).toBe(false);
  });
});

describe('re-registration', () => {
  it('registers again when the public origin changes', async () => {
    const { fixture, store, connector, authorize } = setup();
    await authorize();
    expect(fixture.log.registrations).toHaveLength(1);

    const moved = new ConnectorOAuthService({
      store,
      publicOrigin: 'https://dots.example.com/',
      baseFetch: fixture.fetch,
    });
    const url = await moved.begin(connector);

    // The refresh token belongs to the old registration only, so a browser flow follows.
    const newRedirect =
      'https://dots.example.com/api/connectors/oauth/callback';
    expect(fixture.log.registrations).toHaveLength(2);
    expect(fixture.log.registrations[1]?.redirectUris).toEqual([newRedirect]);
    expect(url?.searchParams.get('redirect_uri')).toBe(newRedirect);
    expect(url?.searchParams.get('client_id')).toBe('client-2');
    expect(store.get('c1')?.redirectUrl).toBe(newRedirect);
  });

  it('clears everything when the connector URL changes', async () => {
    const { fixture, store, service, authorize } = setup();
    await authorize();
    const moved = { id: 'c1', url: `${fixture.mcpUrl}/` };
    await service.begin(moved);
    expect(fixture.log.registrations).toHaveLength(2);
    expect(store.get('c1')?.tokens).toBeUndefined();
  });
});

describe('providers', () => {
  it('transport mode refuses interactive authorization and never touches the pending flow', async () => {
    const { fixture, store, service, connector } = setup();
    const url = await service.begin(connector);
    const state = url!.searchParams.get('state') ?? '';

    const client = new Client({ name: 'test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(connector.url),
      {
        authProvider: service.providerFor(connector, 'transport'),
        fetch: service.transportFetch,
      },
    );
    await expect(client.connect(transport)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await client.close().catch(() => undefined);

    expect(fixture.log.registrations).toHaveLength(1);
    expect(store.get('c1')?.pending).toBe(true);
    // The interactive flow started earlier is still completable.
    const approved = await fixture.approve(url!);
    await expect(
      service.finish(hashState(state), approved.code ?? ''),
    ).resolves.toBe('c1');
  });

  it('interactive provider captures the URL and state is 32 random bytes', async () => {
    const { service, connector } = setup();
    const provider = service.providerFor(connector, 'interactive');
    const first = provider.state?.() as string;
    const second = service.providerFor(connector, 'interactive').state?.();
    expect(first).toMatch(/^[\w-]{43}$/);
    expect(second).not.toBe(first);
    expect(provider.redirectUrl).toBe(CALLBACK);
  });

  it('a connected transport lists tools, calls them and survives a 401 by refreshing', async () => {
    const { fixture, store, service, connector, authorize } = setup({
      secret: 'tool-result',
    });
    await authorize();
    const client = new Client({ name: 'test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(connector.url),
      {
        authProvider: service.providerFor(connector, 'transport'),
        fetch: service.transportFetch,
      },
    );
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'echo_secret',
        'get_issue',
      ]);

      const before = storedTokens(store).access_token;
      fixture.unauthorizedAfter(0);
      const result = await client.callTool({ name: 'echo_secret' });
      expect(result.content).toEqual([{ type: 'text', text: 'tool-result' }]);
      expect(fixture.log.mcpRejected).toBe(1);
      expect(fixture.log.token.map((entry) => entry.grantType)).toContain(
        'refresh_token',
      );
      expect(storedTokens(store).access_token).not.toBe(before);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it('a revoked refresh token surfaces as UnauthorizedError from the transport', async () => {
    const { fixture, service, connector, authorize } = setup();
    await authorize();
    const client = new Client({ name: 'test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(connector.url),
      {
        authProvider: service.providerFor(connector, 'transport'),
        fetch: service.transportFetch,
      },
    );
    try {
      await client.connect(transport);
      fixture.expireAccessTokens();
      fixture.revokeRefreshTokens();
      await expect(client.listTools()).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
      expect(service.hasTokens('c1')).toBe(false);
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

describe('secrets', () => {
  it('returns the access and refresh tokens', async () => {
    const { store, service, authorize } = setup();
    expect(service.secrets()).toEqual([]);
    await authorize();
    const tokens = storedTokens(store);
    expect(service.secrets()).toEqual(
      expect.arrayContaining([tokens.access_token, tokens.refresh_token ?? '']),
    );
  });
});

describe('guardedFetch', () => {
  const ok = () => vi.fn(async () => new Response('ok'));

  it.each([
    'http://10.0.0.1/',
    'https://10.0.0.1/',
    'https://192.168.1.5/x',
    'https://172.20.0.1/',
    'https://169.254.169.254/latest/meta-data',
    'https://[fd00::1]/',
    'https://[fe80::1]/',
    'https://[::ffff:10.0.0.1]/',
    'https://0.0.0.0/',
    'http://example.com/',
    'ftp://example.com/',
    'file:///etc/passwd',
  ])('rejects %s without calling the network', async (target) => {
    const base = ok();
    await expect(guardedFetch({ fetch: base })(target)).rejects.toThrow(
      /refused/i,
    );
    expect(base).not.toHaveBeenCalled();
  });

  it.each([
    'http://127.0.0.1:8080/mcp',
    'http://localhost:3000/',
    'http://[::1]:3000/',
    'https://example.com/mcp',
    'https://mcp.linear.app/mcp',
  ])('allows %s', async (target) => {
    const base = ok();
    const response = await guardedFetch({ fetch: base })(target);
    expect(await response.text()).toBe('ok');
    expect(base).toHaveBeenCalledOnce();
    expect(base.mock.calls[0]).toMatchObject([target, { redirect: 'manual' }]);
  });

  it('treats a redirect as an error, without echoing the location', async () => {
    const base = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/?secret=1' },
        }),
    );
    const failure = await guardedFetch({ fetch: base })(
      'https://example.com/start?x=1',
    ).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toMatch(/redirect/i);
    expect(failure?.message).not.toContain('169.254');
    expect(failure?.message).not.toContain('x=1');
  });

  it('caps the response body at 1 MB unless disabled', async () => {
    const big = () =>
      vi.fn(async () => new Response('x'.repeat(1024 * 1024 + 1)));
    await expect(
      guardedFetch({ fetch: big() })('https://example.com/'),
    ).rejects.toThrow(/exceeds/);
    const response = await guardedFetch({ fetch: big(), maxBodyBytes: false })(
      'https://example.com/',
    );
    expect((await response.text()).length).toBe(1024 * 1024 + 1);
    const small = await guardedFetch({
      fetch: vi.fn(async () => Response.json({ a: 1 })),
    })('https://example.com/');
    expect(await small.json()).toEqual({ a: 1 });
  });

  it('times out', async () => {
    const hang = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          );
        }),
    );
    await expect(
      guardedFetch({ fetch: hang, timeoutMs: 20 })('https://example.com/'),
    ).rejects.toThrow();
  });

  it('is the default fetch of the service and guards discovery', async () => {
    const { service } = setup();
    await expect(service.fetch('https://10.0.0.1/')).rejects.toThrow(
      /refused/i,
    );
    await expect(service.transportFetch('https://10.0.0.1/')).rejects.toThrow(
      /refused/i,
    );
  });
});
