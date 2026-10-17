// One conversation as a downloadable Markdown file, for the owner's own records.
//
// It is built from the stored message list rather than from what the browser happens to be
// showing, so any conversation in the sidebar can be exported, open or not, and a tool result
// body is never copied.
import { Hono } from 'hono';
import type { Platform } from './platform.js';
import { exportConversationMarkdown } from './conversation-export.js';

/** A header value is a byte string, so only the ASCII form may sit in `filename`. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Mounted under /api, behind the owner and origin checks like every other route. */
export function exportRoutes(platform: Platform) {
  const app = new Hono();
  app.get('/conversations/:id/export.md', (c) => {
    const id = c.req.param('id');
    let thread;
    try {
      thread = platform.workspace.requireThread(id);
    } catch {
      return c.json({ error: 'Conversation not found.' }, 404);
    }
    const names = new Map(
      platform.workspace.dots().map((dot) => [dot.id, dot.name]),
    );
    const members = platform.workspace.threadMembers(id).map((dotId) => ({
      id: dotId,
      name: names.get(dotId) ?? 'Dot',
    }));
    // A reply that is still streaming is not stored yet, so this is the last stored change.
    const activity = platform.runner
      .listThreads()
      .find((entry) => entry.id === id)?.updatedAt;
    const { markdown, filename } = exportConversationMarkdown({
      conversation: {
        id: thread.id,
        title: thread.title,
        dotId: thread.dotId,
        createdAt: thread.createdAt,
        updatedAt: activity ? Date.parse(activity) : null,
      },
      members,
      authors: platform.runner.authors(id),
      messages: platform.runner.getThreadMessages(id),
    });
    return new Response(markdown, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': contentDisposition(filename),
      },
    });
  });
  return app;
}
