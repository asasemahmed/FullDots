import { Hono } from 'hono';
import { DOT_PACK_MAX_CHARS } from '../shared/dot-pack.js';
import {
  DotPackError,
  dotPackFileName,
  exportDotPack,
  importDotPack,
  parseDotPack,
} from './dot-pack.js';
import type { WorkspaceStore } from './workspace.js';

/** Dot packs: export a Dot as a file, and import a file as a new Dot. */
export function dotPackRoutes(workspace: WorkspaceStore) {
  const app = new Hono();

  app.get('/dots/:id/pack', (c) => {
    const dot = workspace.dot(c.req.param('id'));
    if (!dot) return c.json({ error: 'Dot not found.' }, 404);
    const file = dotPackFileName(dot.name);
    return c.body(JSON.stringify(exportDotPack(workspace, dot), null, 2), 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${file}"`,
      'Cache-Control': 'no-store',
    });
  });

  app.post('/dots/import-pack', async (c) => {
    // Refuse a declared oversize body before reading it.
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > DOT_PACK_MAX_CHARS)
      return c.json(
        { error: 'This pack is too large. A Dot pack is at most 200 KB.' },
        413,
      );
    try {
      const pack = parseDotPack(await c.req.text());
      const result = importDotPack(workspace, pack);
      return c.json(result, 201);
    } catch (error) {
      if (error instanceof DotPackError)
        return c.json({ error: error.message }, error.status);
      throw error;
    }
  });

  return app;
}
