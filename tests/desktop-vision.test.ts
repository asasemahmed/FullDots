import { afterEach, expect, it } from 'vitest';
import { chat, defineChatMiddleware } from '@tanstack/ai';
import { DesktopVision } from '../src/server/computer-desktop-vision.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ModelProviderRegistry } from '../src/server/model-providers.js';
import { createFakeProvider } from './fixtures/fake-provider.js';
import type { ComputerControl } from '../src/shared/computer-types.js';

const stores: WorkspaceStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
const picture = (value = 1) => ({
  base64: Buffer.from([255, 216, 1, value, 255, 217]).toString('base64'),
  width: 1280,
  height: 800,
  scale: 1,
  capturedAt: new Date().toISOString(),
});
function fixture() {
  let enabled = true;
  const control: ComputerControl = {
    holder: 'bot',
    requested: false,
    transitioning: false,
    resumeSnapshotRequired: false,
    revision: 0,
  };
  const vision = new DesktopVision({
    enabled: () => enabled,
    check() {},
    control: async () => structuredClone(control),
  });
  return {
    control,
    vision,
    disable() {
      enabled = false;
    },
  };
}
it('refuses capture while image input is off or the owner holds or requests control', async () => {
  const f = fixture();
  let captures = 0;
  const capture = async () => {
    captures++;
    return picture();
  };
  f.disable();
  await expect(f.vision.capture(capture)).rejects.toThrow('Settings > Models');
  const owner = fixture();
  owner.control.holder = 'human';
  await expect(owner.vision.capture(capture)).rejects.toThrow('owner');
  owner.control.holder = 'bot';
  owner.control.requested = true;
  await expect(owner.vision.capture(capture)).rejects.toThrow('owner');
  expect(captures).toBe(0);
});
it('discards capture after takeover and release during the capture, and after failed capture', async () => {
  const f = fixture();
  await expect(
    f.vision.capture(async () => {
      f.control.revision = 2;
      return picture();
    }),
  ).rejects.toThrow('control changed');
  await expect(
    f.vision.capture(async () => {
      throw new Error('Fixture failure');
    }),
  ).rejects.toThrow('Fixture failure');
});
it('validates screenshot size, scaling and JPEG bytes', async () => {
  const f = fixture();
  for (const value of [
    { ...picture(), width: 640 },
    { ...picture(), scale: 2 },
    { ...picture(), base64: 'invalid' },
  ])
    await expect(f.vision.capture(async () => value)).rejects.toThrow(
      'invalid screenshot',
    );
});

async function providerFixture(
  f: ReturnType<typeof fixture>,
  takeBeforeSend = false,
) {
  const store = new WorkspaceStore(':memory:', 'desktop-owner');
  stores.push(store);
  const fake = createFakeProvider();
  const registry = new ModelProviderRegistry(store.modelProviders, {
    env: {
      apiKey: 'fixture',
      model: 'fake-model',
      baseUrl: 'https://model.invalid/v1',
      voiceName: 'fixture',
    },
    fetch: fake.fetch,
  });
  const resolved = registry.resolve();
  const adapter = registry.adapterFor({
    ...resolved,
    fetch: f.vision.wrapFetch(resolved.fetch as typeof fetch),
  });
  const canonical = [
    { role: 'user' as const, content: 'Inspect this desktop.' },
  ];
  const middleware = [f.vision.middleware()];
  if (takeBeforeSend)
    middleware.push(
      defineChatMiddleware({
        name: 'fixture-take-control',
        onConfig(context) {
          if (context.phase === 'beforeModel') {
            f.control.holder = 'human';
            f.control.revision = 1;
          }
        },
      }),
    );
  for await (const event of chat({
    adapter,
    messages: canonical,
    middleware,
    threadId: 'desktop-fixture',
    runId: 'desktop-run',
  }))
    void event;
  return {
    request: fake.chats()[0].body as {
      messages: Array<{ role: string; content: unknown }>;
    },
    canonical,
  };
}
const imageUrls = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(imageUrls);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (record.type === 'image_url')
    return [String((record.image_url as { url: string }).url)];
  return Object.values(record).flatMap(imageUrls);
};
it('sends only the latest image through the actual provider adapter without changing canonical history or tool results', async () => {
  const f = fixture();
  const first = await f.vision.capture(async () => picture(1));
  expect(JSON.stringify(first)).not.toContain(picture(1).base64);
  await f.vision.capture(async () => picture(2));
  const result = await providerFixture(f);
  expect(imageUrls(result.request)).toEqual([
    `data:image/jpeg;base64,${picture(2).base64}`,
  ]);
  expect(imageUrls(result.canonical)).toEqual([]);
  expect(result.canonical).toHaveLength(1);
});
it('removes the provider image when the owner takes control after model configuration but before sending', async () => {
  const f = fixture();
  await f.vision.capture(async () => picture());
  const result = await providerFixture(f, true);
  expect(imageUrls(result.request)).toEqual([]);
  expect(JSON.stringify(result.request)).not.toContain(picture().base64);
});
it('honors image flag revocation and does not carry images into a new turn', async () => {
  const f = fixture();
  await f.vision.capture(async () => picture());
  f.disable();
  expect(imageUrls((await providerFixture(f)).request)).toEqual([]);
  expect(imageUrls((await providerFixture(fixture())).request)).toEqual([]);
});
