import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectorPresets } from '../src/shared/connector-presets.js';
import { connectorAuthRoutes } from '../src/server/connector-auth-routes.js';
import { ConnectorAuthStore } from '../src/server/connector-auth-store.js';
import { ConnectorOAuthService } from '../src/server/connector-oauth.js';
import { ConnectorStore } from '../src/server/connector-store.js';
import { ConnectorRegistry } from '../src/server/connectors.js';
import { createMcpFixture } from './fixtures/mcp-server.js';
import { createOAuthFixture } from './fixtures/oauth-server.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

const PUBLIC_ORIGIN = 'http://localhost:5173';
const CALLBACK = '/api/connectors/oauth/callback';
const key = Buffer.alloc(32, 9);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup(
  options: {
    dcr?: boolean;
    now?: () => number;
    presetId?: string;
    auth?: 'oauth' | 'none';
  } = {},
) {
  const fixture = createOAuthFixture({ dcr: options.dcr });
  const mcp = createMcpFixture();
  const db = new DatabaseSync(':memory:');
  const store = new ConnectorStore(db);
  const authStore = new ConnectorAuthStore(db, key);
  const oauth = new ConnectorOAuthService({
    store: authStore,
    publicOrigin: PUBLIC_ORIGIN,
    baseFetch: fixture.fetch,
    serverUrlFor: (id) => store.get(id)?.url,
  });
  const registry = new ConnectorRegistry(store, {
    allowStdio: false,
    resultMaxChars: 20_000,
    oauth,
    transport: (connector) => mcp.transport(connector),
  });
  cleanups.push(async () => {
    await registry.stop();
    await mcp.close();
    db.close();
  });
  const reload = vi.spyOn(registry, 'reload');
  const verifiers: string[] = [];
  const beginPending = authStore.beginPending.bind(authStore);
  vi.spyOn(authStore, 'beginPending').mockImplementation((...args) => {
    verifiers.push(args[2]);
    return beginPending(...args);
  });
  const connector = store.create({
    name: 'fx',
    transport: 'http',
    url: fixture.mcpUrl,
    auth: options.auth ?? 'oauth',
    ...(options.presetId ? { presetId: options.presetId } : {}),
  });
  const app = new Hono().route(
    '/api',
    connectorAuthRoutes({
      store,
      registry,
      oauth,
      auth: authStore,
      presets: connectorPresets,
      publicOrigin: PUBLIC_ORIGIN,
      now: options.now,
    }),
  );
  const post = (path: string) =>
    app.request(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  const callback = (query: Record<string, string>) =>
    app.request(`${CALLBACK}?${new URLSearchParams(query)}`);
  /** authorize → the "browser" approves → returns what the provider redirects with. */
  async function begin() {
    const response = await post(`/connectors/${connector.id}/authorize`);
    const body = (await response.json()) as { authorizationUrl: string };
    const approved = await fixture.approve(body.authorizationUrl);
    return { approved, authorizationUrl: body.authorizationUrl };
  }
  const tokens = () =>
    authStore.get(connector.id)?.tokens as OAuthTokens | undefined;
  return {
    app,
    fixture,
    store,
    authStore,
    registry,
    reload,
    verifiers,
    connector,
    post,
    callback,
    begin,
    tokens,
  };
}

const nonceOf = (csp: string) => /'nonce-([^']+)'/.exec(csp)?.[1];
const resultOf = (html: string) =>
  JSON.parse(
    /<script type="application\/json" id="result">(.*?)<\/script>/s.exec(
      html,
    )![1],
  ) as { type: string; ok: boolean; connectorId: string; message: string };

describe('POST /connectors/:id/authorize', () => {
  it('404 for an unknown connector, 400 for one that is not oauth', async () => {
    const { post } = setup();
    const missing = await post('/connectors/nope/authorize');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Connector not found.' });

    const plain = setup({ auth: 'none' });
    const response = await plain.post(
      `/connectors/${plain.connector.id}/authorize`,
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /browser authorization/i,
    );
  });

  it('200 with the provider URL', async () => {
    const { post, connector, fixture } = setup();
    const response = await post(`/connectors/${connector.id}/authorize`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorizationUrl: string };
    const url = new URL(body.authorizationUrl);
    expect(url.origin).toBe(fixture.origin);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(
      `${PUBLIC_ORIGIN}${CALLBACK}`,
    );
  });

  it('answers { authorized: true, status } when a refresh sufficed', async () => {
    const { begin, callback, post, connector, fixture, registry } = setup();
    const { approved } = await begin();
    await callback({ code: approved.code!, state: approved.state! });
    fixture.expireAccessTokens();
    const response = await post(`/connectors/${connector.id}/authorize`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      authorized?: boolean;
      authorizationUrl?: string;
      status: { state: string };
    };
    expect(body.authorizationUrl).toBeUndefined();
    expect(body.authorized).toBe(true);
    expect(body.status.state).toBe(registry.view(connector.id)!.status.state);
  });

  it('400 with a token hint when registration fails and the preset has a token', async () => {
    const withHint = setup({ dcr: false, presetId: 'linear' });
    const response = await withHint.post(
      `/connectors/${withHint.connector.id}/authorize`,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; hint?: string };
    expect(body.error.length).toBeGreaterThan(0);
    expect(body.error.length).toBeLessThanOrEqual(200);
    expect(body.hint).toBe('token');

    const without = setup({ dcr: false });
    const plain = await without.post(
      `/connectors/${without.connector.id}/authorize`,
    );
    expect(plain.status).toBe(400);
    expect(((await plain.json()) as { hint?: string }).hint).toBeUndefined();
  });
});

describe('GET /connectors/oauth/callback', () => {
  it('completes the flow: page ok, tokens stored, connector reloaded, nothing leaks', async () => {
    const { begin, callback, tokens, reload, connector, verifiers } = setup();
    const { approved } = await begin();
    const response = await callback({
      code: approved.code!,
      state: approved.state!,
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(resultOf(html)).toEqual({
      type: 'fulldots:connector-auth',
      ok: true,
      connectorId: connector.id,
      message: '',
    });
    expect(html).toContain('Connected. You can close this window.');
    expect(tokens()?.access_token).toBeTruthy();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledWith(connector.id));

    const headers = response.headers;
    expect(headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(headers.get('cache-control')).toBe('no-store');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(headers.get('x-frame-options')).toBe('DENY');

    // Planted-secret check: no token, verifier, state or code in the body.
    const planted = [
      tokens()!.access_token,
      tokens()!.refresh_token,
      ...verifiers,
      approved.state,
      approved.code,
    ];
    expect(planted.every(Boolean)).toBe(true);
    for (const secret of planted) expect(html).not.toContain(secret!);
  });

  it('sets a per-response nonce CSP that matches the script, and posts only to publicOrigin', async () => {
    const { begin, callback, app } = setup();
    const { approved } = await begin();
    const response = await callback({
      code: approved.code!,
      state: approved.state!,
    });
    const csp = response.headers.get('content-security-policy')!;
    const nonce = nonceOf(csp)!;
    expect(csp).toBe(
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    );
    const html = await response.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
    // Every executable script carries the nonce; the only other one is inert JSON.
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
    expect(scripts).toHaveLength(2);
    expect(scripts.filter((attrs) => !attrs.includes('nonce'))).toEqual([
      ' type="application/json" id="result"',
    ]);
    expect(html).toContain(`data-app-origin="${PUBLIC_ORIGIN}"`);
    expect(html).toContain('postMessage(result, target)');
    expect(html).not.toContain("'*'");
    expect(html).not.toContain('"*"');
    // A second response gets a different nonce.
    const again = await app.request(`${CALLBACK}?state=${'a'.repeat(43)}`);
    expect(nonceOf(again.headers.get('content-security-policy')!)).not.toBe(
      nonce,
    );
  });

  it('unknown or malformed state shows the generic page and changes nothing', async () => {
    const { callback, reload, tokens } = setup();
    const queries: Record<string, string>[] = [
      { code: 'x', state: 'A'.repeat(43) },
      { code: 'x', state: 'short' },
      { code: 'x' },
      {},
    ];
    for (const query of queries) {
      const response = await callback(query);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(
        'This sign-in link has expired or was already used.',
      );
      expect(resultOf(html)).toMatchObject({ ok: false, connectorId: '' });
    }
    expect(reload).not.toHaveBeenCalled();
    expect(tokens()).toBeUndefined();
  });

  it('a reused state gets the generic page', async () => {
    const { begin, callback, reload } = setup();
    const { approved } = await begin();
    const query = { code: approved.code!, state: approved.state! };
    expect(resultOf(await (await callback(query)).text()).ok).toBe(true);
    const second = await (await callback(query)).text();
    expect(resultOf(second).ok).toBe(false);
    expect(second).toContain('expired or was already used');
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('a wrong code fails with a scrubbed message', async () => {
    const { begin, callback, tokens } = setup();
    const { approved } = await begin();
    const response = await callback({
      code: 'not-the-code',
      state: approved.state!,
    });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(resultOf(html).ok).toBe(false);
    expect(html).not.toContain(approved.code!);
    expect(tokens()).toBeUndefined();
  });

  it('escapes provider errors and uses the pending state up', async () => {
    const { begin, callback, authStore, connector } = setup();
    const { approved } = await begin();
    const description = '<script>alert(1)</script>"&';
    const query = {
      error: 'access_denied',
      error_description: description,
      state: approved.state!,
    };
    const response = await callback(query);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('access_denied');
    // The JSON block cannot be closed by provider text either.
    const json = /id="result">(.*?)<\/script>/s.exec(html)![1];
    expect(json).not.toContain('<');
    expect(resultOf(html)).toMatchObject({
      ok: false,
      connectorId: connector.id,
    });
    expect(resultOf(html).message).toContain('<script>alert(1)</script>');
    // The same state cannot be replayed with a code.
    const replay = await callback({
      code: approved.code!,
      state: approved.state!,
    });
    expect(resultOf(await replay.text()).ok).toBe(false);
    expect(authStore.hasTokens(connector.id)).toBe(false);
  });

  it('truncates a long provider description to 200 characters', async () => {
    const { begin, callback } = setup();
    const { approved } = await begin();
    const html = await (
      await callback({
        error: 'server_error',
        error_description: 'x'.repeat(5000),
        state: approved.state!,
      })
    ).text();
    expect(resultOf(html).message.length).toBeLessThanOrEqual(200);
  });

  it('answers 429 after 30 requests in a minute', async () => {
    const { callback } = setup({ now: () => 1_000 });
    for (let i = 0; i < 30; i += 1)
      expect((await callback({ state: 'A'.repeat(43) })).status).toBe(200);
    const limited = await callback({ state: 'A'.repeat(43) });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('content-type')).toContain('text/plain');
    expect(await limited.text()).toMatch(/too many/i);
  });

  it('refills the bucket as time passes', async () => {
    let at = 0;
    const { callback } = setup({ now: () => at });
    for (let i = 0; i < 30; i += 1) await callback({});
    expect((await callback({})).status).toBe(429);
    at = 60_000;
    expect((await callback({})).status).toBe(200);
  });
});

describe('POST /connectors/:id/disconnect', () => {
  it('forgets the tokens and the connector goes back to needs_auth', async () => {
    const { begin, callback, post, connector, registry, authStore, fixture } =
      setup();
    const { approved } = await begin();
    await callback({ code: approved.code!, state: approved.state! });
    expect(authStore.hasTokens(connector.id)).toBe(true);
    await vi.waitFor(async () =>
      expect((await registry.status(connector.id)).state).toBe('connected'),
    );
    const secret = (authStore.get(connector.id)!.tokens as OAuthTokens)
      .access_token;

    const response = await post(`/connectors/${connector.id}/disconnect`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(secret);
    const view = JSON.parse(text) as {
      id: string;
      status: { state: string; authorized?: boolean };
    };
    expect(view.id).toBe(connector.id);
    expect(view.status.state).toBe('needs_auth');
    expect(authStore.hasTokens(connector.id)).toBe(false);
    expect(fixture.mcpUrl).toBeTruthy();
  });

  it('404 for an unknown connector', async () => {
    const { post } = setup();
    expect((await post('/connectors/nope/disconnect')).status).toBe(404);
  });
});
