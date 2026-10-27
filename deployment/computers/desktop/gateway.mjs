import http from 'node:http';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, opendir } from 'node:fs/promises';

const token = process.env.COMPUTER_TOKEN?.trim();
const bot = process.env.COMPUTER_BOT_ID;
if (
  !token ||
  token.length < 24 ||
  !bot ||
  !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(bot)
)
  throw new Error('Desktop computer credentials are missing or invalid.');
const workerSocket = '/tmp/fulldots-desktop.sock';
const codingSocket = '/profiles/.coding/desktop-acp.sock';
const internal = 'desktop-internal-transport-only-0000';
const MAX_BODY = 1024 * 1024;
let revision = 0;

function get(path, socketPath = workerSocket) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        headers: {
          authorization: `Bearer ${internal}`,
          'x-openbot-bot-id': bot,
        },
        timeout: 3000,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY * 6) {
            res.destroy();
            reject(new Error('Desktop response too large.'));
          } else chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () =>
      req.destroy(new Error('Desktop service timed out.')),
    );
    req.end();
  });
}

/** Only workspace entries are relaxed for the desktop UID; descriptors prevent symlink traversal. */
async function sharedWorkspace(path, depth = 0) {
  if (depth > 64)
    throw new Error('The computer workspace has too many directory levels.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (info.uid === 0 && (info.isDirectory() || info.isFile()))
      await handle.chmod(info.mode | (info.isDirectory() ? 0o777 : 0o666));
    if (info.isDirectory()) {
      const entries = await opendir(`/proc/self/fd/${handle.fd}`);
      for await (const entry of entries) {
        if (!entry.isDirectory() && !entry.isFile()) continue;
        try {
          await sharedWorkspace(
            `/proc/self/fd/${handle.fd}/${entry.name}`,
            depth + 1,
          );
        } catch (error) {
          if (!['ENOENT', 'ELOOP'].includes(error.code)) throw error;
        }
      }
    }
  } finally {
    await handle.close();
  }
}

const coding = spawn('bun', ['/opt/fulldots-desktop/acp-service.mjs'], {
  stdio: ['ignore', 'ignore', 'ignore'],
});
coding.once('error', () => process.exit(1));
coding.once('exit', () => process.exit(1));
for (let attempt = 0; ; attempt++) {
  try {
    if ((await get('/health', codingSocket)).status === 204) break;
  } catch {
    /* The private bridge validates storage and managed settings before binding. */
  }
  if (attempt >= 120) throw new Error('Private coding service did not start.');
  await new Promise((resolve) => setTimeout(resolve, 250));
}
await sharedWorkspace('/workspace');
// Older profile volumes have no desktop directory. Never relax the private coding tree.
const mask = process.umask(0);
try {
  await mkdir('/profiles/desktop-browser', { mode: 0o777 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
} finally {
  process.umask(mask);
}

function target(request) {
  const url = new URL(request.url, 'http://computer');
  const offered =
    request.headers['x-openbot-computer-token'] ??
    request.headers.authorization?.replace(/^Bearer /, '') ??
    url.searchParams.get('token') ??
    '';
  const a = Buffer.from(String(offered)),
    b = Buffer.from(token);
  if (
    url.pathname !== '/health' &&
    (a.length !== b.length || !timingSafeEqual(a, b))
  )
    return;
  if (
    url.pathname !== '/health' &&
    (request.headers['x-openbot-bot-id'] ?? url.searchParams.get('bot')) !== bot
  )
    return;
  const acp = url.pathname === '/acp';
  const headers = { ...request.headers };
  if (!acp) {
    headers.authorization = `Bearer ${internal}`;
    headers['x-openbot-computer-token'] = internal;
    if (url.searchParams.has('token')) url.searchParams.set('token', internal);
  }
  return {
    socketPath: acp ? codingSocket : workerSocket,
    path: url.pathname + url.search,
    method: request.method,
    headers,
  };
}
const reply = (response, status, message) => {
  if (response.writableEnded || response.destroyed) return;
  if (!response.headersSent)
    response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: message }));
};
const server = http.createServer(async (request, response) => {
  const options = target(request);
  if (!options) return reply(response, 401, 'Not authorised.');
  const path = new URL(request.url, 'http://computer').pathname;
  const guarded = path === '/control' || path === '/desktop/screenshot';
  if (request.method === 'POST' && path.startsWith('/control/')) revision++;
  const initialRevision = revision;
  const upstream = http.request(options, (res) => {
    if (!guarded) {
      response.writeHead(res.statusCode, res.headers);
      res.pipe(response);
      return;
    }
    let size = 0;
    const chunks = [];
    res.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY * 6) {
        res.destroy();
        reply(response, 502, 'Desktop response too large.');
      } else chunks.push(chunk);
    });
    res.on('end', () => {
      if (response.writableEnded) return;
      if (initialRevision !== revision)
        return reply(response, 409, 'Computer control changed.');
      const body = Buffer.concat(chunks);
      if (path === '/control' && res.statusCode === 200) {
        try {
          const value = JSON.parse(body.toString('utf8'));
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ...value, revision }));
        } catch {
          reply(response, 502, 'Invalid desktop control response.');
        }
      } else {
        response.writeHead(res.statusCode, res.headers);
        response.end(body);
      }
    });
    res.on('error', () => reply(response, 502, 'Desktop response ended.'));
  });
  upstream.on('error', () =>
    reply(response, 503, 'The desktop is starting or unavailable.'),
  );
  let received = 0;
  request.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_BODY) {
      request.unpipe(upstream);
      upstream.destroy();
      reply(response, 413, 'Computer request too large.');
    }
  });
  request.on('aborted', () => upstream.destroy());
  response.on('close', () => {
    if (!response.writableFinished) upstream.destroy();
  });
  request.pipe(upstream);
});
server.on('upgrade', (request, socket, head) => {
  const options = target(request);
  if (!options) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  const upstream = http.request(options);
  upstream.on('upgrade', (response, peer, rest) => {
    socket.write(
      `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`,
    );
    for (let i = 0; i < response.rawHeaders.length; i += 2)
      socket.write(
        `${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`,
      );
    socket.write('\r\n');
    if (rest.length) socket.write(rest);
    if (head.length) peer.write(head);
    socket.pipe(peer).pipe(socket);
    socket.on('close', () => peer.destroy());
    peer.on('close', () => socket.destroy());
    peer.on('error', () => socket.destroy());
    socket.on('error', () => peer.destroy());
  });
  upstream.on('response', (response) => {
    response.resume();
    socket.end(
      `HTTP/1.1 ${response.statusCode} Refused\r\nConnection: close\r\n\r\n`,
    );
  });
  upstream.on('error', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.end();
});
server.listen(4100, '0.0.0.0');
let wasReady = false;
let failures = 0;
setInterval(async () => {
  try {
    if ((await get('/health')).status !== 200) throw new Error('Not ready');
    wasReady = true;
    failures = 0;
  } catch {
    if (wasReady && ++failures >= 3) process.exit(1);
  }
}, 3000).unref();
process.once('SIGTERM', () => {
  coding.kill();
  server.close();
  process.exit(0);
});
