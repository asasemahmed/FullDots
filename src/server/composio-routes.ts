import { Hono } from 'hono';
import { z } from 'zod';
import { composioClient } from './composio.js';
import {
  ConnectRefusal,
  connectWithFields,
  disconnectApp,
  listConnectedApps,
  type FieldConnectClient,
} from './composio-fields.js';
import { safeFailure } from './composio-tools.js';
import type { Platform } from './platform.js';

const connectBody = z
  .object({
    toolkit: z.string().regex(/^[a-z0-9_]{1,64}$/),
    values: z.record(
      z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      z.string().min(1).max(4000),
    ),
  })
  .strict();

const accountId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);

function clientFor(platform: Platform): FieldConnectClient | undefined {
  const key = platform.config.composioApiKey;
  if (!key || !platform.store.settings().composioAllowed) return undefined;
  return composioClient(key) as unknown as FieldConnectClient;
}

function refusal(error: unknown): string {
  return error instanceof ConnectRefusal
    ? error.message
    : `Composio did not accept the key. It reported ${safeFailure(error)}.`;
}

export function composioRoutes(platform: Platform): Hono {
  const app = new Hono();

  app.post('/composio/connect', async (c) => {
    const client = clientFor(platform);
    if (!client) return c.json({ error: 'Connected apps are off.' }, 404);
    const parsed = connectBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || Object.keys(parsed.data.values).length > 8)
      return c.json({ error: 'The connection form was not valid.' }, 400);
    try {
      await connectWithFields(
        client,
        platform.workspace.ownerId,
        parsed.data.toolkit,
        parsed.data.values,
      );
      platform.workspace.computers.record({
        dotId: 'owner',
        threadId: null,
        tool: 'composio_connect',
        actor: 'owner',
        outcome: 'succeeded',
      });
      return c.json({ connected: true });
    } catch (error) {
      platform.workspace.computers.record({
        dotId: 'owner',
        threadId: null,
        tool: 'composio_connect',
        actor: 'owner',
        outcome: 'failed',
      });
      const sentence = refusal(error);
      console.error(`Composio connect failed: ${sentence}`);
      return c.json({ error: sentence }, 400);
    }
  });

  app.get('/composio/accounts', async (c) => {
    const client = clientFor(platform);
    if (!client) return c.json({ error: 'Connected apps are off.' }, 404);
    try {
      const accounts = await listConnectedApps(
        client,
        platform.workspace.ownerId,
      );
      return c.json({ accounts });
    } catch (error) {
      console.error(`Composio accounts failed: ${safeFailure(error)}.`);
      return c.json({ error: 'Could not load connected apps.' }, 502);
    }
  });

  app.delete('/composio/accounts/:id', async (c) => {
    const client = clientFor(platform);
    if (!client) return c.json({ error: 'Connected apps are off.' }, 404);
    const id = accountId.safeParse(c.req.param('id'));
    if (!id.success)
      return c.json({ error: 'That connected app was not found.' }, 404);
    try {
      await disconnectApp(client, id.data);
      platform.workspace.computers.record({
        dotId: 'owner',
        threadId: null,
        tool: 'composio_disconnect',
        actor: 'owner',
        outcome: 'succeeded',
      });
      return c.json({ removed: true });
    } catch (error) {
      const sentence =
        error instanceof ConnectRefusal
          ? error.message
          : `Could not disconnect that app. Composio reported ${safeFailure(error)}.`;
      console.error(`Composio disconnect failed: ${sentence}`);
      return c.json({ error: sentence }, 400);
    }
  });

  return app;
}
