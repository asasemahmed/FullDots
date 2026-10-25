import { Hono } from 'hono';
import { channelInput, channelProvider } from '../../shared/channels.js';
import type { Platform } from '../platform.js';

export function channelRoutes(platform: Platform) {
  const routes = new Hono();
  routes.get('/channels', (c) => c.json(platform.channels.settings()));
  routes.put('/channels/:provider', async (c) => {
    const provider = channelProvider.safeParse(c.req.param('provider'));
    const input = channelInput.safeParse(await c.req.json().catch(() => null));
    if (!provider.success || !input.success)
      return c.json({ error: 'Enter valid channel settings.' }, 400);
    try {
      return c.json(
        await platform.channels.configure(provider.data, input.data),
      );
    } catch {
      return c.json(
        {
          error:
            'Choose a Dot, set the required tokens and list the owner accounts. A Telegram chat without a user list must be a private owner chat.',
        },
        400,
      );
    }
  });
  return routes;
}
