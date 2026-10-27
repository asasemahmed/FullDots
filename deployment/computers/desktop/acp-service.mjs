import { withAcpBridge } from '/app/acp-bridge/bridge.mjs';
import {
  prepareCodingStorage,
  assertManagedSettings,
  assertCodexReadLimits,
} from '/app/acp-bridge/storage.mjs';
import { unlink } from 'node:fs/promises';
await prepareCodingStorage();
await assertManagedSettings();
await assertCodexReadLimits();
process.umask(0o077);
await unlink('/profiles/.coding/desktop-acp.sock').catch((error) => {
  if (error.code !== 'ENOENT') throw error;
});
Bun.serve(
  withAcpBridge({
    unix: '/profiles/.coding/desktop-acp.sock',
    websocket: { open() {}, message() {}, close() {} },
    fetch(request) {
      return new Response(null, {
        status: new URL(request.url).pathname === '/health' ? 204 : 404,
      });
    },
  }),
);
