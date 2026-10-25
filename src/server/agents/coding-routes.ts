import { Hono } from 'hono';
import { z } from 'zod';
import type { Platform } from '../platform.js';

const settings = z.object({ enabled: z.boolean() }).strict();

export function codingRoutes(platform: Platform) {
  const app = new Hono();
  app.use('/dots/:id/coding-agents', async (c, next) => {
    if (!platform.workspace.dot(c.req.param('id')!))
      return c.json({ error: 'Dot not found.' }, 404);
    await next();
  });
  app.get('/dots/:id/coding-agents', (c) =>
    c.json({
      enabled: platform.store.codingSessions.enabled(c.req.param('id')),
    }),
  );
  app.put('/dots/:id/coding-agents', async (c) => {
    const parsed = settings.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Choose whether coding agents are enabled.' },
        400,
      );
    const id = c.req.param('id');
    const result = platform.store.codingSessions.configure(
      id,
      parsed.data.enabled,
    );
    if (!parsed.data.enabled) platform.turns.stop(id);
    return c.json(result);
  });
  return app;
}
