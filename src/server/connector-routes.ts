import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { validateConnectorConfig } from '../shared/connector-config.js';
import { connectorPresets } from '../shared/connector-presets.js';
import type { Connector, ConnectorConfig } from '../shared/types.js';
import type { ConnectorStore } from './connector-store.js';
import type { ConnectorRegistry } from './connectors.js';
import type { WorkspaceStore } from './workspace.js';

export interface ConnectorRoutesDeps {
  store: ConnectorStore;
  registry: ConnectorRegistry;
  workspace: Pick<WorkspaceStore, 'dot'>;
  allowStdio: boolean;
}

const MAX_GRANTS = 100;
const MAX_TOOLS = 500;
const PATCHABLE = new Set([
  'name',
  'transport',
  'url',
  'command',
  'args',
  'cwd',
  'headers',
  'env',
  'callTimeoutMs',
  'enabled',
  'presetId',
]);

const toolName = z.string().min(1).max(200);
const grantsBody = z
  .object({
    grants: z
      .array(
        z
          .object({
            connectorId: z.string().min(1).max(100),
            tools: z.union([z.literal('*'), z.array(toolName).max(MAX_TOOLS)]),
            overrides: z
              .record(toolName, z.enum(['allow', 'ask', 'deny']))
              .refine((all) => Object.keys(all).length <= MAX_TOOLS, {
                error: `at most ${MAX_TOOLS} overrides`,
              })
              .optional(),
          })
          .strict(),
      )
      .max(MAX_GRANTS),
  })
  .strict();

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A stored connector as the config the validator understands (null columns become absent keys). */
function configOf(connector: Connector): Record<string, unknown> {
  const config: Record<string, unknown> = {
    name: connector.name,
    transport: connector.transport,
    args: connector.args,
    headers: connector.headers,
    env: connector.env,
    callTimeoutMs: connector.callTimeoutMs,
    enabled: connector.enabled,
  };
  if (connector.url !== null) config.url = connector.url;
  if (connector.command !== null) config.command = connector.command;
  if (connector.cwd !== null) config.cwd = connector.cwd;
  if (connector.presetId !== null) config.presetId = connector.presetId;
  return config;
}

const invalidMessage = (error: z.ZodError) =>
  `Invalid request: ${error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ')}`.slice(0, 400);

export function connectorRoutes(deps: ConnectorRoutesDeps) {
  const { store, registry, workspace, allowStdio } = deps;
  const app = new Hono();

  // Every body goes through the registry's redaction: no resolved secret leaves this module.
  const send = (c: Context, body: unknown, status: 200 | 201 | 400 | 404) =>
    c.body(registry.redact(JSON.stringify(body)), status, {
      'Content-Type': 'application/json',
    });
  const fail = (
    c: Context,
    status: 400 | 404,
    error: string,
    errors: string[] = [error],
    warnings: string[] = [],
  ) => send(c, { error, errors, warnings }, status);
  const readBody = async (c: Context): Promise<unknown> =>
    c.req.json().catch(() => undefined);

  app.onError((error, c) => {
    if (error instanceof z.ZodError)
      return send(c, { error: invalidMessage(error) }, 400);
    return c.json(
      {
        error:
          'The connector request failed. Check the server configuration and try again.',
      },
      503,
    );
  });

  app.get('/connectors', (c) =>
    send(
      c,
      { connectors: registry.views(), presets: connectorPresets, allowStdio },
      200,
    ),
  );

  app.post('/connectors', async (c) => {
    const result = validateConnectorConfig(await readBody(c), { allowStdio });
    if (result.errors.length)
      return fail(c, 400, result.errors[0], result.errors, result.warnings);
    const config: ConnectorConfig = { ...result.config };
    if (config.cwd === '') delete config.cwd;
    let created: Connector;
    try {
      created = store.create(config);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'A connector with that name exists.'
      )
        return fail(c, 400, error.message, [error.message], result.warnings);
      throw error;
    }
    registry.invalidate(created.id);
    const view = registry.view(created.id);
    return send(
      c,
      result.warnings.length ? { ...view, warnings: result.warnings } : view,
      201,
    );
  });

  app.patch('/connectors/:id', async (c) => {
    const id = c.req.param('id');
    const existing = store.get(id);
    if (!existing) return fail(c, 404, 'Connector not found.');
    const patch = await readBody(c);
    if (!isObject(patch)) return fail(c, 400, 'Send a JSON object.');
    const keys = Object.keys(patch);
    const unknown = keys.filter((key) => !PATCHABLE.has(key));
    if (unknown.length)
      return fail(c, 400, `Unknown field: ${unknown[0].slice(0, 60)}.`);
    if ('transport' in patch && patch.transport !== existing.transport)
      return fail(c, 400, 'The transport of a connector cannot be changed.');
    if (!keys.length) return send(c, registry.view(id), 200);
    // Switching a connector off must work even when stdio is off, or the owner could not disable it.
    const enabledOnly = keys.length === 1 && keys[0] === 'enabled';
    const result = validateConnectorConfig(
      { ...configOf(existing), ...patch },
      { allowStdio: allowStdio || enabledOnly },
    );
    if (result.errors.length)
      return fail(c, 400, result.errors[0], result.errors, result.warnings);
    const changes: Record<string, unknown> = {};
    for (const key of keys) {
      const value = (result.config as unknown as Record<string, unknown>)[key];
      // The store reads an explicit null as "clear"; an empty string means the same here.
      changes[key] = key === 'cwd' && value === '' ? null : value;
    }
    try {
      store.update(id, changes as Partial<ConnectorConfig>);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'A connector with that name exists.'
      )
        return fail(c, 400, error.message, [error.message], result.warnings);
      throw error;
    }
    registry.invalidate(id);
    const view = registry.view(id);
    return send(
      c,
      !enabledOnly && result.warnings.length
        ? { ...view, warnings: result.warnings }
        : view,
      200,
    );
  });

  app.delete('/connectors/:id', (c) => {
    const id = c.req.param('id');
    if (!store.delete(id)) return fail(c, 404, 'Connector not found.');
    registry.invalidate(id);
    return send(c, { deleted: true }, 200);
  });

  app.post('/connectors/:id/reload', async (c) => {
    const id = c.req.param('id');
    if (!store.get(id)) return fail(c, 404, 'Connector not found.');
    await registry.reload(id);
    return send(c, registry.view(id), 200);
  });

  app.post('/connectors/:id/test', async (c) => {
    const id = c.req.param('id');
    if (!store.get(id)) return fail(c, 404, 'Connector not found.');
    return send(c, await registry.status(id), 200);
  });

  app.get('/dots/:id/connectors', (c) => {
    const id = c.req.param('id');
    if (!workspace.dot(id)) return fail(c, 404, 'Dot not found.');
    return send(c, { grants: store.grants(id) }, 200);
  });

  app.put('/dots/:id/connectors', async (c) => {
    const dotId = c.req.param('id');
    if (!workspace.dot(dotId)) return fail(c, 404, 'Dot not found.');
    const parsed = grantsBody.safeParse(await readBody(c));
    if (!parsed.success) return fail(c, 400, invalidMessage(parsed.error));
    const { grants } = parsed.data;
    const seen = new Set<string>();
    for (const grant of grants) {
      const connector = store.get(grant.connectorId);
      if (!connector) return fail(c, 400, 'Unknown connector in the grants.');
      if (seen.has(connector.id))
        return fail(c, 400, `${connector.name} is listed more than once.`);
      seen.add(connector.id);
      // Until the connector has connected there is no tool list to check against: accept the names.
      const cached = registry.toolsCached(connector.id);
      if (!cached.length) continue;
      const known = new Set(cached.map((tool) => tool.name));
      // A name the Dot already holds stays savable even if the server has since dropped the tool.
      for (const kept of store.grant(dotId, connector.id)?.tools ?? [])
        if (kept !== '*') known.add(kept);
      const named = [
        ...(grant.tools === '*' ? [] : grant.tools),
        ...Object.keys(grant.overrides ?? {}),
      ];
      const missing = named.find((name) => !known.has(name));
      if (missing !== undefined)
        return fail(
          c,
          400,
          `${connector.name} has no tool named ${missing.slice(0, 80)}.`,
        );
    }
    for (const current of store.grants(dotId))
      if (!seen.has(current.connectorId))
        store.revoke(dotId, current.connectorId);
    for (const grant of grants)
      store.setGrant(dotId, grant.connectorId, grant.tools, grant.overrides);
    return send(c, { grants: store.grants(dotId) }, 200);
  });

  return app;
}
