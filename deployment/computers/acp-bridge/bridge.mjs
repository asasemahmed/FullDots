import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { access, cp, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertCodexReadLimits,
  assertManagedSettings,
  assertPrivateEntry,
  assertPrivateStorage,
  codingEnvironment,
  codingPaths,
} from './storage.mjs';
import { hardenAdapter } from './harden-adapter.mjs';

const MAX_BYTES = 1024 * 1024;
const MAX_BACKLOG = 2 * MAX_BYTES;
const safeReasons = new Set([
  'Coding adapter installation failed.',
  'Coding adapter installation timed out.',
  'Coding storage must stay outside the computer Files root.',
  'Coding storage resolves inside the computer Files root.',
  'Coding adapter resolves inside the computer Files root.',
  'Coding managed settings are missing or unsafe.',
  'Codex read limits are missing or unsafe.',
  'Pinned adapter settings loader changed; review before installing.',
  'Unknown coding provider.',
]);
// Each coding agent is pinned to one exact version with its own reviewed lockfile folder and cache.
// Changing a version, a lockfile or the completion marker installs into a fresh cache.
const PROVIDERS = {
  claude: {
    version: '0.95.0',
    entry: '@agentclientprotocol/claude-agent-acp/dist/index.js',
    directory: 'claude-0.95.0',
    manifests: './adapter/',
    marker: '0.95.0-managed-v1',
  },
  codex: {
    version: '2.2.2',
    entry: '@agentclientprotocol/codex-acp/dist/index.js',
    directory: 'codex-2.2.2',
    manifests: './adapter-codex/',
    marker: 'codex-2.2.2-managed-v1',
  },
};

/** The request header naming the coding agent. A request without it keeps starting Claude Code. */
export const PROVIDER_HEADER = 'x-fulldots-coding-provider';

/** Only names listed in PROVIDERS are accepted; inherited names such as "constructor" are not. */
export function providerName(value) {
  return typeof value === 'string' && Object.hasOwn(PROVIDERS, value)
    ? value
    : undefined;
}

export function authenticated(headers, token, dotId) {
  const offered = Buffer.from(headers.get('x-openbot-computer-token') ?? '');
  const expected = Buffer.from(token?.trim() ?? '');
  return (
    expected.length >= 24 &&
    offered.length === expected.length &&
    timingSafeEqual(offered, expected) &&
    !!dotId &&
    headers.get('x-openbot-bot-id') === dotId
  );
}

function kill(child) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* The process may already have exited. */
  }
}

export function withAcpBridge(upstream) {
  const workspace = process.env.WORKSPACE_DIR || '/workspace';
  const profiles = process.env.PROFILES_DIR || '/profiles';
  const installs = new Map();
  let active;

  function runtime(name) {
    const id = providerName(name);
    if (!id) throw new Error('Unknown coding provider.');
    const provider = PROVIDERS[id];
    const paths = codingPaths(workspace, profiles, provider.directory);
    return { id, provider, paths, env: codingEnvironment(paths, id) };
  }

  function end(socket, code, reason) {
    if (socket.data.closed) return;
    socket.data.closed = true;
    kill(socket.data.child);
    if (active === socket.data) active = undefined;
    socket.close(code, reason);
  }

  async function install(name) {
    if (installs.has(name)) return installs.get(name);
    const { id, provider, paths, env } = runtime(name);
    const { cache } = paths;
    const installing = (async () => {
      await assertPrivateStorage(paths);
      try {
        if (
          (await readFile(join(cache, '.complete'), 'utf8')) === provider.marker
        )
          return;
      } catch {
        /* Install only complete caches. */
      }
      const staging = `${cache}.installing`;
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      const manifests = fileURLToPath(
        new URL(provider.manifests, import.meta.url),
      );
      for (const file of ['package.json', 'package-lock.json'])
        await cp(join(manifests, file), join(staging, file));
      await new Promise((resolve, reject) => {
        const child = spawn(
          'npm',
          [
            'ci',
            '--prefix',
            staging,
            '--omit=dev',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
          ],
          {
            cwd: paths.root,
            env,
            stdio: 'ignore',
            detached: true,
          },
        );
        const timeout = setTimeout(() => {
          kill(child);
          reject(new Error('Coding adapter installation timed out.'));
        }, 180_000);
        child.once('error', () => {
          clearTimeout(timeout);
          reject(new Error('Coding adapter installation failed.'));
        });
        child.once('exit', (code) => {
          clearTimeout(timeout);
          code === 0
            ? resolve()
            : reject(new Error('Coding adapter installation failed.'));
        });
      });
      await access(join(staging, 'node_modules', provider.entry));
      await hardenAdapter(staging, id);
      await Bun.write(join(staging, '.complete'), provider.marker);
      await rm(cache, { recursive: true, force: true });
      await rename(staging, cache);
    })();
    installs.set(name, installing);
    try {
      await installing;
    } finally {
      installs.delete(name);
    }
  }

  const bridge = {
    async open(socket) {
      try {
        const { id, provider, paths, env } = runtime(
          socket.data.provider ?? 'claude',
        );
        const { cache } = paths;
        await assertPrivateStorage(paths);
        if (id === 'codex') await assertCodexReadLimits();
        await assertManagedSettings();
        await install(id);
        if (socket.data.closed) return;
        await assertPrivateEntry(
          paths,
          join(cache, 'node_modules', provider.entry),
        );
        const child = spawn(
          'node',
          [join(cache, 'node_modules', provider.entry)],
          {
            cwd: workspace,
            env,
            stdio: ['pipe', 'pipe', 'ignore'],
            detached: true,
          },
        );
        socket.data.child = child;
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (data) => {
          if (socket.data.closed) return;
          if (socket.getBufferedAmount() > MAX_BACKLOG)
            end(socket, 1011, 'Coding connection is too slow.');
          else socket.send(data);
        });
        child.stdin.on('error', () =>
          end(socket, 1011, 'Coding worker stopped.'),
        );
        child.once('error', () =>
          end(socket, 1011, 'Coding worker could not start.'),
        );
        child.once('exit', () => end(socket, 1000, 'Coding worker stopped.'));
        socket.send(JSON.stringify({ bridgeReady: true, provider: id }));
      } catch (error) {
        end(
          socket,
          1011,
          error instanceof Error && safeReasons.has(error.message)
            ? error.message
            : 'Coding adapter installation failed.',
        );
      }
    },
    message(socket, message) {
      if (
        Buffer.byteLength(message) > MAX_BYTES ||
        !socket.data.child?.stdin.writable ||
        socket.data.child.stdin.writableLength > MAX_BACKLOG
      ) {
        end(socket, 1008, 'Invalid coding input.');
        return;
      }
      socket.data.child.stdin.write(message);
    },
    close(socket) {
      socket.data.closed = true;
      kill(socket.data.child);
      if (active === socket.data) active = undefined;
    },
  };

  return {
    ...upstream,
    websocket: {
      ...upstream.websocket,
      maxPayloadLength: MAX_BYTES,
      open(socket) {
        return socket.data.acp
          ? bridge.open(socket)
          : upstream.websocket.open(socket);
      },
      message(socket, message) {
        return socket.data.acp
          ? bridge.message(socket, message)
          : upstream.websocket.message(socket, message);
      },
      close(socket, code, reason) {
        return socket.data.acp
          ? bridge.close(socket)
          : upstream.websocket.close(socket, code, reason);
      },
    },
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname !== '/acp') return upstream.fetch(request, server);
      if (
        url.search ||
        !authenticated(
          request.headers,
          process.env.COMPUTER_TOKEN,
          process.env.COMPUTER_BOT_ID,
        )
      )
        return new Response('Unauthorized', { status: 401 });
      if (active)
        return new Response('A coding session is already active.', {
          status: 409,
        });
      // Refused before the upgrade, so an unknown name never reaches the installer or a process.
      const provider = providerName(
        request.headers.get(PROVIDER_HEADER) ?? 'claude',
      );
      if (!provider)
        return new Response('Unknown coding provider.', { status: 400 });
      const data = { acp: true, closed: false, provider };
      if (!server.upgrade(request, { data }))
        return new Response('Expected WebSocket upgrade.', { status: 400 });
      active = data;
    },
  };
}
