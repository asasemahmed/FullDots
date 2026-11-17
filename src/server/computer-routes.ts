import { Hono } from 'hono';
import { z } from 'zod';
import type { ComputerService } from './computer-service.js';
import type { ComputerAction } from '../shared/computer-types.js';
import {
  REMOTE_SETUP_STEPS,
  type RemoteComputersStatus,
} from '../shared/remote-computer-types.js';
import { remoteCommand, validAlias } from './remote-ssh.js';
import { supervisorEnv, supervisorRunWords } from './remote-setup.js';

const aliasField = z.string().max(100).refine(validAlias, 'Invalid ssh alias.');
import { ComputerError } from './computer-errors.js';
import {
  ComputerActionError,
  ComputerConflictError,
} from './computer-conflict.js';
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
    // The computer refused the action. Its reason is already redacted and capped, and the owner
    // needs it to see what went wrong.
    if (error instanceof ComputerActionError) {
      return c.json({ error: error.message }, 502);
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
  const requireRemote = () => {
    const remote = computers.remoteComputers;
    if (!remote)
      throw new ComputerError(
        503,
        'Computers on your server are not available here.',
      );
    return remote;
  };
  // Where computers run, and "Set up this server". See docs/REMOTE-COMPUTERS.md.
  app.get('/computers/remote', (c) => {
    const remote = computers.remoteComputers;
    const setup = computers.remoteSetup;
    const defaults = remote?.defaults() ?? { where: 'local' as const };
    const job = setup?.lastJob();
    const status: RemoteComputersStatus = {
      enabled: !!remote && !!setup?.enabled,
      canBuild: !!remote && !!setup?.canBuild,
      where: defaults.where,
      ...(defaults.alias ? { alias: defaults.alias } : {}),
      servers: remote?.open() ?? [],
      ...(job ? { job } : {}),
    };
    return c.json(status);
  });
  app.put('/computers/remote', async (c) => {
    const body = z
      .object({
        where: z.enum(['local', 'remote']),
        alias: aliasField.optional(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(await computers.setDefaults(body.where, body.alias));
  });
  // An explicit check: it retries problems that do not retry on their own, and stops the tunnel
  // again afterwards when nothing uses that server.
  app.post('/computers/remote/check', async (c) => {
    const { alias } = z
      .object({ alias: aliasField })
      .strict()
      .parse(await c.req.json());
    const remote = requireRemote();
    try {
      return c.json(
        (await remote.serverCheck(alias, { force: true })) ?? {
          alias,
          check: 'ready',
          message: `ssh, Docker, the images and the supervisor on ${alias} are ready.`,
        },
      );
    } finally {
      remote.pruneIdle();
    }
  });
  // The supervisor settings (both tokens), shown to the owner once per set of tokens, for a
  // supervisor started by hand. See docs/REMOTE-COMPUTERS.md.
  app.post('/computers/remote/tokens/reveal', async (c) => {
    const { alias } = z
      .object({ alias: aliasField })
      .strict()
      .parse(await c.req.json());
    const remote = requireRemote();
    let secrets;
    try {
      secrets = remote.store.revealOnce(alias);
    } catch (error) {
      throw new ComputerError(
        409,
        error instanceof Error ? error.message : 'Could not show the settings.',
      );
    }
    c.header('Cache-Control', 'no-store');
    return c.json({
      alias,
      envFile: supervisorEnv(secrets, remote.namespace),
      command: `ssh ${alias} ${remoteCommand(supervisorRunWords(remote.store.serverId(alias)))} < supervisor.env`,
    });
  });
  // Tokens the owner already uses on a supervisor they started by hand.
  app.put('/computers/remote/tokens', async (c) => {
    const body = z
      .object({
        alias: aliasField,
        supervisorToken: z.string().max(256),
        computerToken: z.string().max(256),
      })
      .strict()
      .parse(await c.req.json());
    const remote = requireRemote();
    try {
      remote.store.importTokens(body.alias, {
        supervisorToken: body.supervisorToken,
        computerToken: body.computerToken,
      });
    } catch (error) {
      throw new ComputerError(
        400,
        error instanceof Error ? error.message : 'Invalid tokens.',
      );
    }
    remote.forget(body.alias);
    return c.json({ saved: true });
  });
  // New tokens. The supervisor must be started again with them; computers are replaced on their
  // next start and keep their files.
  app.post('/computers/remote/tokens/reset', async (c) => {
    const { alias } = z
      .object({ alias: aliasField })
      .strict()
      .parse(await c.req.json());
    const remote = requireRemote();
    remote.store.reset(alias);
    remote.forget(alias);
    return c.json({ reset: true });
  });
  app.get('/computers/remote/setup', async (c) => {
    const alias = aliasField.parse(c.req.query('alias'));
    const setup = computers.remoteSetup;
    if (!setup?.enabled)
      throw new ComputerError(
        503,
        'Setting up a server is not available here.',
      );
    const job = setup.lastJob();
    return c.json({ plans: await setup.plans(alias), ...(job ? { job } : {}) });
  });
  app.post('/computers/remote/setup/:step', async (c) => {
    const step = z.enum(REMOTE_SETUP_STEPS).parse(c.req.param('step'));
    const body = z
      .object({
        alias: aliasField,
        approve: z.array(z.string().max(2000)).max(10),
      })
      .strict()
      .parse(await c.req.json());
    const setup = computers.remoteSetup;
    if (!setup?.enabled)
      throw new ComputerError(
        503,
        'Setting up a server is not available here.',
      );
    try {
      return c.json(await setup.start(body.alias, step, body.approve));
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Setup failed.' },
        409,
      );
    }
  });
  app.put('/dots/:id/computer/server', async (c) => {
    const body = z
      .object({ alias: aliasField.nullable() })
      .strict()
      .parse(await c.req.json());
    const moved = await computers.moveServer(c.req.param('id'), body.alias);
    return c.json({
      ...moved,
      status: await computers.status(c.req.param('id')),
    });
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
