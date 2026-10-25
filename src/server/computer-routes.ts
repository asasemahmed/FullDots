import { Hono } from 'hono';
import { z } from 'zod';
import type { ComputerService } from './computer-service.js';
import type { ComputerAction } from '../shared/computer-types.js';
import { ComputerError } from './computer-errors.js';
import { ComputerConflictError } from './computer-conflict.js';
export function computerRoutes(
  computers: ComputerService,
  options: { onRelease?: (dotId: string) => void } = {},
) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof ComputerError) {
      return c.json({ error: error.message }, error.status);
    }
    if (error instanceof ComputerConflictError) {
      return c.json({ error: error.message }, 409);
    }
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Invalid computer request.' }, 400);
    }
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && error.name === 'SyntaxError')
    ) {
      return c.json({ error: 'Invalid JSON request.' }, 400);
    }
    console.error(error instanceof Error ? error.name : 'Error');
    return c.json({ error: 'The computer service failed.' }, 503);
  });
  app.get('/dots/:id/computer', async (c) =>
    c.json(await computers.status(c.req.param('id'))),
  );
  app.patch('/dots/:id/computer/permissions', async (c) =>
    c.json(await computers.permissions(c.req.param('id'), await c.req.json())),
  );
  app.post('/dots/:id/computer/start', async (c) =>
    c.json(await computers.start(c.req.param('id'))),
  );
  app.post('/dots/:id/computer/stop', async (c) =>
    c.json(await computers.stop(c.req.param('id'))),
  );
  app.post('/dots/:id/computer/take', async (c) =>
    c.json(await computers.control(c.req.param('id'), 'take')),
  );
  app.post('/dots/:id/computer/release', async (c) => {
    const control = await computers.control(c.req.param('id'), 'release');
    // A waiting handoff is done once the owner hands the computer back; the Dot resumes.
    options.onRelease?.(c.req.param('id'));
    return c.json(control);
  });
  // Mints a one-time ticket for the live-screen WebSocket; see computer-stream.ts.
  app.post('/dots/:id/computer/stream', (c) =>
    c.json(computers.streamTicket(c.req.param('id'))),
  );
  app.post('/dots/:id/computer/actions', async (c) => {
    const body = z
      .object({ action: z.string(), input: z.unknown() })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await computers.action(
        c.req.param('id'),
        body.action as ComputerAction,
        body.input,
        'owner',
        c.req.raw.signal,
      ),
    );
  });
  return app;
}
