import { Hono } from 'hono';
import {
  SpaceFileError,
  fileUpload,
  filePatch,
  cleanFileName,
} from './space-files.js';
import type { Platform } from './platform.js';
import { TEXT_KINDS, type SpaceFile } from '../shared/space-files.js';

/** Base64 of `bytes` bytes, so an upload can be refused before it is decoded. */
const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** `inline` for what the viewer shows, so a direct link opens it; downloads for everything else. */
function disposition(file: SpaceFile, forceDownload: boolean): string {
  const inline =
    !forceDownload && (TEXT_KINDS.includes(file.kind) || file.kind === 'image');
  const ascii = cleanFileName(file.name).replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`;
}

export function spaceFileRoutes(platform: Platform) {
  const files = () => platform.workspace.spaceFiles;
  const maxBytes = () => platform.config.limits?.spaceFileBytes ?? 10_485_760;
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof SpaceFileError)
      return c.json({ error: error.message }, error.status);
    throw error;
  });

  app.get('/spaces/:spaceId/files', (c) =>
    c.json(files().list(c.req.param('spaceId'))),
  );

  app.post('/spaces/:spaceId/files', async (c) => {
    const body = fileUpload.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json({ error: 'Send a name and the file as base64.' }, 400);
    const { contentBase64, name, parentId } = body.data;
    if (contentBase64.length > base64Length(maxBytes()))
      throw new SpaceFileError(
        `Files can be at most ${Math.floor(maxBytes() / 1024 / 1024)} MB. Raise SPACE_FILE_MAX_MB to allow more.`,
        413,
      );
    if (contentBase64.length % 4 !== 0 || !BASE64.test(contentBase64))
      return c.json({ error: 'The file content is not valid base64.' }, 400);
    return c.json(
      files().create(
        c.req.param('spaceId'),
        { name, parentId, data: Buffer.from(contentBase64, 'base64') },
        { maxBytes: maxBytes() },
      ),
      201,
    );
  });

  app.get('/spaces/:spaceId/files/:id', (c) =>
    c.json(files().get(c.req.param('spaceId'), c.req.param('id'))),
  );

  app.get('/spaces/:spaceId/files/:id/content', (c) => {
    const { file, data } = files().content(
      c.req.param('spaceId'),
      c.req.param('id'),
    );
    const text = TEXT_KINDS.includes(file.kind);
    return c.body(new Uint8Array(data), 200, {
      'Content-Type': text
        ? `${file.mediaType}; charset=utf-8`
        : file.mediaType,
      'Content-Disposition': disposition(file, c.req.query('download') === '1'),
      'Content-Length': String(data.byteLength),
      'Cache-Control': 'private, no-store',
      // A stored file never runs: scripts and plugins stay off when its address is opened directly.
      // A PDF is the exception, because the browser's viewer is a plugin and runs no file scripts.
      ...(file.kind === 'pdf'
        ? {}
        : {
            'Content-Security-Policy':
              "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
          }),
    });
  });

  app.patch('/spaces/:spaceId/files/:id', async (c) => {
    const patch = filePatch.safeParse(await c.req.json().catch(() => null));
    if (!patch.success)
      return c.json({ error: 'Send a new name or a new parent page.' }, 400);
    return c.json(
      files().update(c.req.param('spaceId'), c.req.param('id'), patch.data),
    );
  });

  app.delete('/spaces/:spaceId/files/:id', (c) => {
    if (!files().delete(c.req.param('spaceId'), c.req.param('id')))
      return c.json({ error: 'File not found in this Space.' }, 404);
    return c.json({ ok: true });
  });

  return app;
}
