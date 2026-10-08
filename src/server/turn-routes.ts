import { Hono } from 'hono';
import type { TurnRegistry } from './turn-registry.js';
import type { WorkspaceStore } from './workspace.js';
export function turnRoutes(registry: TurnRegistry, workspace: WorkspaceStore) {
  const app = new Hono();
  app.post('/dots/:id/turn/stop', (c) => {
    const id = c.req.param('id');
    if (!workspace.dot(id)) return c.json({ error: 'Dot not found.' }, 404);
    return c.json({ stopped: registry.stop(id) });
  });
  return app;
}
