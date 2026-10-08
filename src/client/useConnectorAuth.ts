// Browser authorization for OAuth connectors (CONNECTOR-AUTH-PLAN.md, 3.3).
//
// The sign-in runs in a popup. The popup MUST be opened synchronously inside
// the click handler, before anything is awaited, or the browser blocks it. The
// authorization URL then arrives from the server and is loaded into the popup.
// The callback page posts a message to this window; polling the connector is
// the fallback when no message arrives (blocked popup, mismatched origin).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, authHeaders } from './api';
import type { ConnectorView } from '../shared/types';

export const AUTH_MESSAGE_TYPE = 'fulldots:connector-auth';
export const POPUP_NAME = 'fulldots-connector-auth';
export const POPUP_FEATURES = 'popup=yes,width=600,height=760';
/** How often the connector is polled while waiting for the popup. */
export const POLL_INTERVAL_MS = 2000;
export const AUTH_TIMEOUT_MS = 10 * 60 * 1000;
/** How long after the popup closes we keep polling for a late result. */
export const CLOSED_GRACE_MS = 8000;

export interface AuthMessage {
  ok: boolean;
  message: string;
}

/**
 * The callback page's postMessage, if and only if it came from this origin, from
 * the popup we opened (when we have one), with the fixed type and for the
 * connector we are waiting on. Anything else is ignored.
 */
export function acceptAuthMessage(
  event: { origin: string; source: unknown; data: unknown },
  expected: { origin: string; connectorId: string; source?: unknown },
): AuthMessage | undefined {
  if (event.origin !== expected.origin) return undefined;
  if (expected.source != null && event.source !== expected.source)
    return undefined;
  const data = event.data;
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  if (record.type !== AUTH_MESSAGE_TYPE) return undefined;
  if (record.connectorId !== expected.connectorId) return undefined;
  return {
    ok: record.ok === true,
    message:
      typeof record.message === 'string' ? record.message.slice(0, 300) : '',
  };
}

/** Only http(s) URLs may become a link or a popup location. */
export function safeAuthUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export interface AuthorizeResponse {
  authorizationUrl?: string;
  authorized?: boolean;
}

/** A failed `POST /connectors/:id/authorize`; `hint` is 'token' when a token alternative exists. */
export class AuthorizeError extends Error {
  constructor(
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
}

/** Like `api()`, but keeps the `hint` of a 400 response. */
export async function authorizeRequest(id: string): Promise<AuthorizeResponse> {
  const response = await fetch(
    `/api/connectors/${encodeURIComponent(id)}/authorize`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: '{}',
    },
  );
  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
    hint?: string;
  } & AuthorizeResponse;
  if (!response.ok)
    throw new AuthorizeError(
      data.error ?? `Request failed (${response.status}).`,
      typeof data.hint === 'string' ? data.hint : undefined,
    );
  return data;
}

/** The slice of `Window` the flow needs from the popup. */
export interface PopupLike {
  closed: boolean;
  close(): void;
  location: { replace(url: string): void };
}

export interface AuthDeps {
  open(url: string, name: string, features: string): PopupLike | null;
  authorize(id: string): Promise<AuthorizeResponse>;
}

const defaultDeps: AuthDeps = {
  open: (url, name, features) => window.open(url, name, features),
  authorize: authorizeRequest,
};

/** Step 1, synchronous: the popup, opened blank inside the user's click. */
export function openAuthPopup(deps: AuthDeps = defaultDeps): PopupLike | null {
  return deps.open('', POPUP_NAME, POPUP_FEATURES);
}

export interface Navigated {
  id: string;
  /** `true`: a stored refresh sufficed and no sign-in is needed. */
  authorized: boolean;
  /** The sign-in URL (never shown as text; it carries `state`). */
  url?: string;
  /** The popup could not be used: show the link instead. */
  blocked: boolean;
}

/** Step 2: resolve the connector id, ask the server for the URL, load it in the popup. */
export async function navigateAuthPopup(
  popup: PopupLike | null,
  resolveId: () => string | Promise<string>,
  deps: AuthDeps = defaultDeps,
): Promise<Navigated> {
  try {
    const id = await resolveId();
    const response = await deps.authorize(id);
    if (response.authorized) {
      popup?.close();
      return { id, authorized: true, blocked: false };
    }
    const url = safeAuthUrl(response.authorizationUrl);
    if (!url)
      throw new AuthorizeError('The server did not return a sign-in page.');
    let blocked = !popup;
    if (popup) {
      try {
        popup.location.replace(url);
      } catch {
        blocked = true;
      }
    }
    return { id, authorized: false, url, blocked };
  } catch (error) {
    try {
      popup?.close();
    } catch {
      /* already gone */
    }
    throw error;
  }
}

/** Both steps; the popup is opened before the first await. */
export function beginAuthorization(
  resolveId: () => string | Promise<string>,
  deps: AuthDeps = defaultDeps,
): Promise<Navigated> {
  const popup = openAuthPopup(deps);
  return navigateAuthPopup(popup, resolveId, deps);
}

export type AuthPhase =
  'idle' | 'starting' | 'waiting' | 'finishing' | 'connected' | 'failed';

export interface AuthState {
  phase: AuthPhase;
  connectorId?: string;
  /** Why it failed. */
  message?: string;
  /** 'token': the server suggests the token alternative. */
  hint?: string;
  /** The sign-in URL, for the "open the sign-in page" link only. */
  link?: string;
  /** The pop-up was blocked. */
  blocked?: boolean;
}

export interface ConnectorAuthController {
  state: AuthState;
  /** Call from a click handler. `resolveId` may create the connector first. */
  start(resolveId: () => string | Promise<string>): void;
  /** Stop waiting and close the sign-in window. */
  cancel(): void;
  reset(): void;
}

interface Session {
  id?: string;
  popup: PopupLike | null;
  stopped: boolean;
  finishing: boolean;
  stop(): void;
}

export const IDLE: AuthState = { phase: 'idle' };

export function useConnectorAuth(options: {
  /** The refreshed view after a successful (or finished) authorization. */
  onConnected: (view: ConnectorView) => void;
  deps?: AuthDeps;
}): ConnectorAuthController {
  const [state, setState] = useState<AuthState>(IDLE);
  const mounted = useRef(true);
  const session = useRef<Session | undefined>(undefined);
  const latest = useRef(options);
  latest.current = options;

  const update = useCallback((next: AuthState) => {
    if (mounted.current) setState(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      // Leave the popup open: the owner may still be signing in.
      mounted.current = false;
      session.current?.stop();
      session.current = undefined;
    };
  }, []);

  const fail = useCallback(
    (current: Session, message: string, hint?: string) => {
      current.stop();
      if (session.current === current) session.current = undefined;
      update({
        phase: 'failed',
        ...(current.id ? { connectorId: current.id } : {}),
        message,
        ...(hint ? { hint } : {}),
      });
    },
    [update],
  );

  const finish = useCallback(
    async (current: Session) => {
      if (current.finishing || current.stopped) return;
      current.finishing = true;
      const id = current.id!;
      current.stop();
      update({ phase: 'finishing', connectorId: id });
      try {
        const view = await api<ConnectorView>(
          `/connectors/${encodeURIComponent(id)}/reload`,
          'POST',
          {},
        );
        if (mounted.current) latest.current.onConnected(view);
        if (view.status.state === 'connected') {
          update({ phase: 'connected', connectorId: id });
        } else {
          update({
            phase: 'failed',
            connectorId: id,
            message:
              view.status.state === 'error' && view.status.error
                ? view.status.error
                : 'Signed in, but the connector did not connect. Try again.',
          });
        }
      } catch (error) {
        update({
          phase: 'failed',
          connectorId: id,
          message:
            error instanceof Error
              ? error.message
              : 'Could not finish sign-in.',
        });
      } finally {
        if (session.current === current) session.current = undefined;
      }
    },
    [update],
  );

  const watch = useCallback(
    (current: Session) => {
      const id = current.id!;
      const origin = window.location.origin;
      const startedAt = Date.now();
      let closedAt = 0;
      let tick = 0;
      let polling = false;
      const onMessage = (event: MessageEvent) => {
        const accepted = acceptAuthMessage(event, {
          origin,
          connectorId: id,
          source: current.popup ?? undefined,
        });
        if (!accepted) return;
        if (accepted.ok) void finish(current);
        else fail(current, accepted.message || 'Authorization failed.');
      };
      window.addEventListener('message', onMessage);
      const timer = window.setInterval(() => {
        if (current.stopped) return;
        tick += 1;
        if (Date.now() - startedAt > AUTH_TIMEOUT_MS) {
          try {
            current.popup?.close();
          } catch {
            /* already gone */
          }
          fail(current, 'Timed out. Try again.');
          return;
        }
        if (!closedAt && current.popup?.closed) closedAt = Date.now();
        if (closedAt && Date.now() - closedAt > CLOSED_GRACE_MS) {
          fail(current, 'The sign-in window was closed before finishing.');
          return;
        }
        // Every 2 s; every second once the window is gone, to catch the result sooner.
        if (!closedAt && tick % Math.round(POLL_INTERVAL_MS / 1000) !== 0)
          return;
        if (polling) return;
        polling = true;
        void api<ConnectorView>(`/connectors/${encodeURIComponent(id)}`)
          .then((view) => {
            if (!current.stopped && view.status.state === 'connected')
              void finish(current);
          })
          .catch(() => {})
          .finally(() => {
            polling = false;
          });
      }, 1000);
      current.stop = () => {
        current.stopped = true;
        window.removeEventListener('message', onMessage);
        window.clearInterval(timer);
      };
    },
    [fail, finish],
  );

  const start = useCallback(
    (resolveId: () => string | Promise<string>) => {
      if (session.current) return;
      const deps = latest.current.deps ?? defaultDeps;
      // Synchronous, before any await: this is what keeps the popup unblocked.
      const popup = openAuthPopup(deps);
      const current: Session = {
        popup,
        stopped: false,
        finishing: false,
        stop() {
          current.stopped = true;
        },
      };
      session.current = current;
      update({ phase: 'starting' });
      void navigateAuthPopup(popup, resolveId, deps).then(
        (result) => {
          if (current.stopped) return;
          current.id = result.id;
          if (result.authorized) {
            void finish(current);
            return;
          }
          update({
            phase: 'waiting',
            connectorId: result.id,
            ...(result.url ? { link: result.url } : {}),
            blocked: result.blocked,
          });
          watch(current);
        },
        (error: unknown) => {
          if (current.stopped) return;
          fail(
            current,
            error instanceof Error ? error.message : 'Could not start sign-in.',
            error instanceof AuthorizeError ? error.hint : undefined,
          );
        },
      );
    },
    [fail, finish, update, watch],
  );

  const cancel = useCallback(() => {
    const current = session.current;
    if (current) {
      current.stop();
      try {
        current.popup?.close();
      } catch {
        /* already gone */
      }
    }
    session.current = undefined;
    update(IDLE);
  }, [update]);

  const reset = useCallback(() => {
    if (session.current) return;
    update(IDLE);
  }, [update]);

  return { state, start, cancel, reset };
}
