import './privacy.js';
import { webSearchConfig } from './web-search.js';
import { readIntegrationSettings, readLimits } from './limits.js';
import { createShutdown } from './shutdown.js';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Store } from './store.js';
import { createApp } from './app.js';
import { attachComputerStream, type UpgradeServer } from './computer-stream.js';
import { WorkspaceStore } from './workspace.js';
import { loadConnectorKey } from './connector-crypto.js';
import { Platform } from './platform.js';
import { DockerSetup, dockerSetupEnabled } from './docker-setup.js';
import type { PlatformConfig } from './platform-config.js';
import { TurnRegistry } from './turn-registry.js';
import { createBackgroundRunner } from './task-executor.js';
import { wakeOnWork } from './live-wiring.js';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4310);
const ownerToken = process.env.OWNER_TOKEN;
if (
  !['127.0.0.1', '::1', 'localhost'].includes(host) &&
  (!ownerToken || ownerToken.length < 24)
)
  throw new Error(
    'External binding requires an OWNER_TOKEN of at least 24 characters.',
  );
const appOrigin =
  process.env.APP_ORIGIN ??
  (process.env.NODE_ENV === 'development'
    ? 'http://127.0.0.1:5173'
    : undefined);
const database = process.env.DATABASE_PATH ?? 'data/opendots.sqlite';
const store = new Store(database);
// Fails fast on a malformed CONNECTOR_SECRET_KEY; otherwise reads or creates data/connector.key.
const connectorKey = loadConnectorKey({
  env: process.env,
  databasePath: database,
});
const workspace = new WorkspaceStore(
  database,
  process.env.OWNER_ID ?? 'opendots-owner',
  { connectorKey },
);
const config: PlatformConfig = {
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL,
  baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  ...webSearchConfig(process.env),
  browserUrl: process.env.BROWSER_URL,
  browserSecret: process.env.BROWSER_SECRET,
  computerSupervisorUrl: process.env.COMPUTER_SUPERVISOR_URL,
  computerSupervisorToken: process.env.COMPUTER_SUPERVISOR_TOKEN,
  computerToken: process.env.COMPUTER_TOKEN,
  computerNamespace: process.env.COMPUTER_NAMESPACE,
  voiceKey: process.env.VOICE_API_KEY,
  voiceModel: process.env.VOICE_MODEL,
  voiceName: process.env.VOICE_NAME ?? 'marin',
  ownerToken,
  limits: readLimits(),
  ...readIntegrationSettings(),
  publicOrigin: appOrigin ?? `http://${host}:${port}`,
};
// One registry for every turn source, so the scheduler skips busy and waiting work.
const turns = new TurnRegistry();
const platform = new Platform(store, workspace, config, database, turns);
const researchConfig = {
  mode: 'live' as const,
  apiKey: config.apiKey,
  model: config.model,
  baseUrl: config.baseUrl,
  models: platform.models,
  webSearchProvider: config.webSearchProvider,
  searxngUrl: config.searxngUrl,
  browserUrl: config.browserUrl,
  browserSecret: config.browserSecret,
};
const runner = createBackgroundRunner(platform, researchConfig);
wakeOnWork(platform.events, turns, runner);
const dockerSetup = new DockerSetup({
  config,
  enabled: dockerSetupEnabled({ host }),
});
platform.dockerSetup = dockerSetup;
const app = createApp({
  store,
  runner,
  config: researchConfig,
  ownerToken,
  origin: appOrigin,
  platform,
  dockerSetup,
});
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; frame-src blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
  );
  await next();
});
app.get('/api/*', (c) => c.json({ error: 'Not found.' }, 404));
app.use('/*', serveStatic({ root: './dist/client' }));
app.get('*', serveStatic({ path: './dist/client/index.html' }));
const report = (operation: string, error: unknown) =>
  console.error(
    `${operation}:`,
    error instanceof Error ? error.message : 'Unknown error',
  );
const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`FullDots listening on http://${host}:${info.port}`);
  runner.start();
  void platform.start().catch((error) => report('Startup failed', error));
});
// `serve` builds a plain HTTP server unless it is given another factory, and none is.
const streams = attachComputerStream(server as unknown as UpgradeServer, {
  computers: platform.computers,
  ownerToken,
  origin: appOrigin,
});
const shutdown = createShutdown({
  stopRunner: () => runner.stop(),
  stopPlatform: () => platform.stop(),
  closeServer: () => {
    // An open live screen or event feed would keep the server from finishing its close.
    platform.events.close();
    streams.close();
    return new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  },
  exit: (code) => process.exit(code),
  report,
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
