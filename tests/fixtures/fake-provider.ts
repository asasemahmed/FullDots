import { Hono } from 'hono';
import { completion } from './model-stream.js';

/** A model-list body in one of the shapes real providers return. */
export type FakeListShape =
  'openai' | 'array' | 'gemini' | 'anthropic' | 'openrouter';

export interface RecordedRequest {
  method: string;
  /** Path including any base path, e.g. `/v1/chat/completions`. */
  path: string;
  search: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** Parsed JSON body, the raw text when it is not JSON, undefined without a body. */
  body: unknown;
}

export interface FakeProviderOptions {
  /** Keys the provider accepts (as `Authorization: Bearer` or `x-api-key`); any key when omitted. */
  keys?: string[];
  models?: string[];
  shape?: FakeListShape;
}

export interface FakeProvider {
  app: Hono;
  /** An in-process `fetch`: inject it into `ModelProviderRegistry` / `providerFetch`. */
  fetch: typeof fetch;
  requests: RecordedRequest[];
  chats(): RecordedRequest[];
  listings(): RecordedRequest[];
  state: {
    shape: FakeListShape;
    models: string[];
    /** Replaces the model-list body entirely. */
    modelsBody?: unknown;
    /** Forces the model-list endpoint to answer with this status and an error body. */
    modelsStatus?: number;
    /** Message of the error body used with modelsStatus. */
    modelsError?: string;
    /** Answer every chat request with 429. */
    rateLimit: boolean;
    /** Text echoed in the 401 body (to prove redaction). */
    echoKeyInErrors: boolean;
    /** The OpenRouter-style /key check answers 401. */
    keyExpired: boolean;
  };
}

const MODEL_DEFAULTS = ['fake-small', 'fake-large'];

function listBody(shape: FakeListShape, models: string[]): unknown {
  switch (shape) {
    case 'array':
      return [
        ...models.map((id) => ({
          id,
          type: 'chat',
          display_name: id,
          context_length: 8192,
        })),
        { id: 'fake-image', type: 'image' },
        { id: 'fake-embed', type: 'embedding' },
      ];
    case 'gemini':
      return {
        object: 'list',
        data: models.map((id) => ({
          id: `models/${id}`,
          object: 'model',
          owned_by: 'google',
        })),
      };
    case 'anthropic':
      return {
        data: models.map((id) => ({
          type: 'model',
          id,
          display_name: `Display ${id}`,
        })),
        has_more: false,
      };
    case 'openrouter':
      return {
        data: models.map((id) => ({
          id,
          name: `Name of ${id}`,
          context_length: 32000,
          supported_parameters: ['tools', 'max_tokens'],
        })),
      };
    default:
      return {
        object: 'list',
        data: models.map((id) => ({ id, object: 'model', owned_by: 'fake' })),
      };
  }
}

/**
 * An in-process OpenAI-compatible provider. It answers on any base path: `GET <base>/models`
 * (switchable shape) and `POST <base>/chat/completions` (a short streamed completion), records
 * every request, answers 401 for an unknown key and 429 on demand.
 */
export function createFakeProvider(
  options: FakeProviderOptions = {},
): FakeProvider {
  const requests: RecordedRequest[] = [];
  const state: FakeProvider['state'] = {
    shape: options.shape ?? 'openai',
    models: options.models ?? [...MODEL_DEFAULTS],
    rateLimit: false,
    echoKeyInErrors: false,
    keyExpired: false,
  };
  const app = new Hono();
  app.all('*', async (c) => {
    const url = new URL(c.req.url);
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    let body: unknown;
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const text = await c.req.text();
      try {
        body = text ? (JSON.parse(text) as unknown) : undefined;
      } catch {
        body = text;
      }
    }
    requests.push({
      method: c.req.method,
      path: url.pathname,
      search: url.search,
      headers,
      body,
    });
    const presented =
      headers['x-api-key'] ?? headers.authorization?.replace(/^Bearer /i, '');
    if (options.keys && (!presented || !options.keys.includes(presented))) {
      return c.json(
        {
          error: {
            message: state.echoKeyInErrors
              ? `Invalid API key: ${presented ?? ''}`
              : 'Invalid API key',
          },
        },
        401,
      );
    }
    // OpenRouter-style key check: 401 when the test marks the key expired.
    if (url.pathname.endsWith('/key') && c.req.method === 'GET') {
      if (state.keyExpired)
        return c.json({ error: { message: 'API key expired.' } }, 401);
      return c.json({ data: { label: 'fake' } });
    }
    if (url.pathname.endsWith('/models') && c.req.method === 'GET') {
      if (state.modelsStatus)
        return c.json(
          { error: { message: state.modelsError ?? 'models unavailable' } },
          state.modelsStatus as 500,
        );
      return c.json(
        (state.modelsBody ?? listBody(state.shape, state.models)) as object,
      );
    }
    if (url.pathname.endsWith('/chat/completions') && c.req.method === 'POST') {
      if (state.rateLimit)
        return c.json({ error: { message: 'Rate limit reached' } }, 429);
      return completion({ content: 'ok' });
    }
    return c.json({ error: { message: 'not found' } }, 404);
  });
  return {
    app,
    fetch: ((input, init) =>
      app.fetch(new Request(input, init))) as typeof fetch,
    requests,
    chats: () =>
      requests.filter((request) => request.path.endsWith('/chat/completions')),
    listings: () =>
      requests.filter((request) => request.path.endsWith('/models')),
    state,
  };
}
