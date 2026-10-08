import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { ConnectorPreset } from '../shared/connector-presets.js';
import type { ConnectorAuthStore } from './connector-auth-store.js';
import {
  ConnectorOAuthService,
  OAuthCallbackError,
  hashState,
} from './connector-oauth.js';
import type { ConnectorStore } from './connector-store.js';
import type { ConnectorRegistry } from './connectors.js';
import { renderCallbackPage } from './oauth-callback-page.js';

export interface ConnectorAuthRoutesDeps {
  store: ConnectorStore;
  registry: ConnectorRegistry;
  oauth: ConnectorOAuthService;
  auth: Pick<ConnectorAuthStore, 'takePending'>;
  presets: ConnectorPreset[];
  /** `PlatformConfig.publicOrigin`: the only postMessage target and the only link on the page. */
  publicOrigin: string;
  /** Test seam for the rate limiter. */
  now?: () => number;
}

/** What `begin` generates: 32 random bytes as base64url. */
const STATE_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const MAX_CODE_CHARS = 4096;
const MESSAGE_MAX = 200;
const RATE_PER_MINUTE = 30;

const EXPIRED = 'This sign-in link has expired or was already used.';
const FAILED = 'Authorization failed. Start again from the connector.';

/** In-memory token bucket: `perMinute` requests, refilled continuously. */
function rateLimiter(perMinute: number, now: () => number) {
  let tokens = perMinute;
  let last = now();
  return () => {
    const at = now();
    tokens = Math.min(perMinute, tokens + ((at - last) / 60_000) * perMinute);
    last = at;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

const clip = (text: string) =>
  text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX - 1)}…` : text;

export function connectorAuthRoutes(deps: ConnectorAuthRoutesDeps) {
  const { store, registry, oauth, auth, presets } = deps;
  const appOrigin = new URL(deps.publicOrigin).origin;
  const allow = rateLimiter(RATE_PER_MINUTE, deps.now ?? Date.now);
  const app = new Hono();

  // Every JSON body goes through the registry's redaction, like connector-routes.ts.
  const send = (c: Context, body: unknown, status: 200 | 400 | 404) =>
    c.body(registry.redact(JSON.stringify(body)), status, {
      'Content-Type': 'application/json',
    });
  const fail = (
    c: Context,
    status: 400 | 404,
    error: string,
    extra: Record<string, unknown> = {},
  ) => send(c, { error, ...extra }, status);

  app.post('/connectors/:id/authorize', async (c) => {
    const id = c.req.param('id');
    const connector = store.get(id);
    if (!connector) return fail(c, 404, 'Connector not found.');
    if (connector.auth !== 'oauth')
      return fail(c, 400, 'This connector does not use browser authorization.');
    try {
      const url = await oauth.begin(connector);
      if (url) return send(c, { authorizationUrl: url.href }, 200);
      // A stored refresh token sufficed: connect with it now.
      const status = await registry.reload(id);
      return send(c, { authorized: true, status }, 200);
    } catch (error) {
      const preset = presets.find((item) => item.id === connector.presetId);
      const message =
        error instanceof Error && error.message
          ? error.message
          : 'The server could not start authorization.';
      return fail(
        c,
        400,
        clip(message),
        preset?.tokenEnv ? { hint: 'token' } : {},
      );
    }
  });

  app.post('/connectors/:id/disconnect', async (c) => {
    const id = c.req.param('id');
    if (!store.get(id)) return fail(c, 404, 'Connector not found.');
    await oauth.disconnect(id);
    registry.invalidate(id);
    return send(c, registry.view(id), 200);
  });

  // Registered here, before any catch-all. The provider redirects the owner's browser to it.
  // Never log the query, state, code or any URL from this handler.
  app.get('/connectors/oauth/callback', async (c) => {
    const nonce = randomBytes(16).toString('base64');
    const headers = {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    };
    const page = (
      ok: boolean,
      connectorId: string,
      message: string,
    ): Response =>
      c.body(
        renderCallbackPage({
          nonce,
          ok,
          connectorId,
          connectorName: (connectorId && store.get(connectorId)?.name) || '',
          message: registry.redact(message),
          appOrigin,
        }),
        200,
        headers,
      );

    if (!allow())
      return c.text('Too many requests. Try again in a minute.', 429, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });

    const state = c.req.query('state') ?? '';
    if (!STATE_FORMAT.test(state)) return page(false, '', EXPIRED);
    const stateHash = hashState(state);
    const providerError = c.req.query('error');
    const code = c.req.query('code') ?? '';

    if (providerError !== undefined || !code || code.length > MAX_CODE_CHARS) {
      // Use up the pending row so this state cannot be replayed.
      const pending = auth.takePending(stateHash);
      if (!pending) return page(false, '', EXPIRED);
      const description = c.req.query('error_description');
      const message =
        providerError !== undefined
          ? clip(
              description
                ? `${providerError}: ${description}`
                : providerError || FAILED,
            )
          : FAILED;
      return page(false, pending.connectorId, message);
    }

    try {
      const connectorId = await oauth.finish(stateHash, code);
      void registry.reload(connectorId).catch(() => undefined);
      return page(true, connectorId, '');
    } catch (error) {
      if (error instanceof OAuthCallbackError && error.code === 'failed')
        return page(
          false,
          error.connectorId ?? '',
          clip(error.message) || FAILED,
        );
      return page(false, '', EXPIRED);
    }
  });

  return app;
}
