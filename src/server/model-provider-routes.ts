import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  modelPreset,
  modelPresets,
  type ModelPreset,
} from '../shared/model-presets.js';
import type {
  ModelProviderPatch,
  ModelProviderStore,
} from './model-provider-store.js';
import {
  ModelProviderError,
  type ModelProviderRegistry,
} from './model-providers.js';

export interface ModelProviderRoutesDeps {
  /**
   * Views, the effective default model, tests, model lists and redaction. The base-URL rules
   * (https unless loopback, no private literals, no credentials/query/hash, 500 chars) live in
   * `registry.checkBaseUrl`, which is built on `isLoopbackHost`/`isPrivateLiteral`.
   */
  registry: Pick<
    ModelProviderRegistry,
    | 'list'
    | 'get'
    | 'checkBaseUrl'
    | 'defaultModel'
    | 'setDefaultModel'
    | 'models'
    | 'test'
    | 'redact'
  >;
  store: Pick<ModelProviderStore, 'create' | 'update' | 'delete'>;
  /**
   * Names of the Dots that reference this provider (`dots.modelProviderId`), plus `'default model'`
   * when the saved default model points at it. Empty when nothing uses it.
   */
  usage: (providerId: string) => string[];
  now?: () => number;
}

/** Least time between two connection tests of the same provider (plan section 6.8). */
export const TEST_INTERVAL_MS = 2000;

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,99}$/;
// Same character set as a Dot's model id (workspace-routes.ts), but never empty here.
const MODEL_ID = /^[\w.:/@+-]+$/;

const keyBody = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('stored'),
      value: z
        .string()
        .trim()
        .min(8, { error: 'The API key must be at least 8 characters.' })
        .max(4000, { error: 'The API key can be at most 4000 characters.' })
        .regex(/^\S+$/, { error: 'The API key must not contain spaces.' }),
    })
    .strict(),
  z
    .object({
      kind: z.literal('env'),
      envName: z.string().regex(ENV_NAME, {
        error:
          'Use an environment variable name such as GROQ_API_KEY (capital letters, digits and underscores).',
      }),
    })
    .strict(),
  z.object({ kind: z.literal('none') }).strict(),
]);

const extraBody = z
  .object({
    anthropicWorkspaceId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const nameBody = z.string().trim().min(1).max(60);
// Length and shape are judged by registry.checkBaseUrl; this only bounds the input.
const urlBody = z.string().trim().min(1).max(2000);

const createBody = z
  .object({
    presetId: z.string().min(1).max(40),
    name: nameBody.optional(),
    baseUrl: urlBody.optional(),
    key: keyBody.optional(),
    extra: extraBody.optional(),
  })
  .strict();

const patchBody = z
  .object({
    name: nameBody.optional(),
    baseUrl: urlBody.optional(),
    key: keyBody.optional(),
    extra: extraBody.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const defaultBody = z
  .object({
    providerId: z.string().min(1).max(100),
    model: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(MODEL_ID, { error: 'That model id has unsupported characters.' }),
  })
  .strict();

const invalidMessage = (error: z.ZodError) =>
  `Invalid request: ${error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ')}`.slice(0, 400);

type Status = 200 | 201 | 400 | 404 | 409 | 429 | 503;

export function modelProviderRoutes(deps: ModelProviderRoutesDeps) {
  const { registry, store, usage } = deps;
  const now = deps.now ?? Date.now;
  const lastTest = new Map<string, number>();
  const app = new Hono();

  // Every body goes through the registry's redaction: no resolvable key leaves this module.
  const send = (c: Context, body: unknown, status: Status) =>
    c.body(registry.redact(JSON.stringify(body)), status, {
      'Content-Type': 'application/json',
    });
  const fail = (c: Context, status: 400 | 404 | 429, error: string) =>
    send(c, { error }, status);
  const readBody = (c: Context): Promise<unknown> =>
    c.req.json().catch(() => undefined);

  app.onError((error, c) => {
    if (error instanceof z.ZodError)
      return send(c, { error: invalidMessage(error) }, 400);
    if (error instanceof ModelProviderError)
      return send(c, { error: error.message }, 400);
    return send(
      c,
      {
        error:
          'The model provider request failed. Check the server configuration and try again.',
      },
      503,
    );
  });

  const nameTaken = (name: string, exceptId?: string) =>
    registry
      .list()
      .some(
        (provider) =>
          provider.id !== exceptId &&
          provider.name.toLowerCase() === name.toLowerCase(),
      );
  const nameConflict = (c: Context) =>
    fail(c, 400, 'A provider with that name already exists.');

  /** The provider with `id`, or the response to return (404 unknown, 400 for the `.env` one). */
  const editable = (c: Context, id: string) => {
    const view = registry.get(id);
    if (!view) return { response: fail(c, 404, 'Provider not found.') };
    if (view.builtIn)
      return {
        response: fail(
          c,
          400,
          'The default provider comes from the server environment (.env). Edit it there.',
        ),
      };
    return { view };
  };

  /** Normalised base URL, or a thrown 400. Trailing slashes are dropped. */
  const baseUrlOf = (preset: ModelPreset, raw: string): string => {
    const problem = registry.checkBaseUrl(preset.id, raw);
    if (problem) throw new ModelProviderError(problem, 'no-provider');
    return new URL(raw).href.replace(/\/+$/, '');
  };
  const checkExtra = (
    preset: ModelPreset,
    extra: z.infer<typeof extraBody> | undefined,
  ) => {
    for (const key of Object.keys(extra ?? {}))
      if (!preset.extraFields?.some((field) => field.id === key))
        throw new ModelProviderError(
          `${preset.name} has no ${key} setting.`,
          'no-provider',
        );
  };

  app.get('/model-providers', (c) =>
    send(
      c,
      {
        providers: registry.list(),
        presets: modelPresets,
        defaultModel: registry.defaultModel(),
      },
      200,
    ),
  );

  app.post('/model-providers', async (c) => {
    const body = createBody.parse(await readBody(c));
    const preset = modelPreset(body.presetId);
    if (!preset) return fail(c, 400, 'Unknown provider preset.');
    const rawUrl = body.baseUrl ?? preset.baseUrl;
    if (!rawUrl) return fail(c, 400, 'A custom provider needs a base URL.');
    const baseUrl = baseUrlOf(preset, rawUrl);
    const name = body.name ?? preset.name;
    if (nameTaken(name)) return nameConflict(c);
    checkExtra(preset, body.extra);
    const created = store.create({
      presetId: preset.id,
      name,
      baseUrl,
      key: body.key ?? { kind: 'none' },
      extra: body.extra ?? {},
    });
    const view = registry.get(created.id);
    if (!view) return fail(c, 404, 'Provider not found.');
    return send(c, view, 201);
  });

  app.put('/model-providers/default', async (c) => {
    const body = defaultBody.parse(await readBody(c));
    if (!registry.get(body.providerId))
      return fail(c, 400, 'That provider does not exist.');
    registry.setDefaultModel({
      providerId: body.providerId,
      model: body.model,
    });
    return send(c, { defaultModel: registry.defaultModel() }, 200);
  });

  app.patch('/model-providers/:id', async (c) => {
    const id = c.req.param('id');
    const found = editable(c, id);
    if (!found.view) return found.response;
    const body = patchBody.parse(await readBody(c));
    const preset = modelPreset(found.view.presetId);
    if (!preset) return fail(c, 400, 'Unknown provider preset.');
    const changes: ModelProviderPatch = {};
    if (body.name !== undefined) {
      if (nameTaken(body.name, id)) return nameConflict(c);
      changes.name = body.name;
    }
    if (body.baseUrl !== undefined)
      changes.baseUrl = baseUrlOf(preset, body.baseUrl);
    if (body.key !== undefined) changes.key = body.key;
    if (body.extra !== undefined) {
      checkExtra(preset, body.extra);
      changes.extra = body.extra;
    }
    if (body.enabled !== undefined) changes.enabled = body.enabled;
    if (Object.keys(changes).length) store.update(id, changes);
    const view = registry.get(id);
    return view ? send(c, view, 200) : fail(c, 404, 'Provider not found.');
  });

  app.delete('/model-providers/:id', (c) => {
    const id = c.req.param('id');
    const found = editable(c, id);
    if (!found.view) return found.response;
    const dots = usage(id);
    if (dots.length)
      return send(
        c,
        {
          error:
            `${found.view.name} is still in use by ${dots.join(', ')}. Switch them to another provider first.`.slice(
              0,
              400,
            ),
          dots,
        },
        409,
      );
    store.delete(id);
    return c.body(null, 204);
  });

  app.post('/model-providers/:id/test', async (c) => {
    const id = c.req.param('id');
    if (!registry.get(id)) return fail(c, 404, 'Provider not found.');
    const at = now();
    const last = lastTest.get(id);
    if (last !== undefined && at - last < TEST_INTERVAL_MS)
      return fail(c, 429, 'Wait a moment before testing this provider again.');
    lastTest.set(id, at);
    return send(c, await registry.test(id), 200);
  });

  app.get('/model-providers/:id/models', async (c) => {
    const id = c.req.param('id');
    if (!registry.get(id)) return fail(c, 404, 'Provider not found.');
    const refresh = ['1', 'true'].includes(c.req.query('refresh') ?? '');
    return send(c, await registry.models(id, { refresh }), 200);
  });

  return app;
}
