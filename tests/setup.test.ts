import { expect, it } from 'vitest';
import {
  setupStatus,
  type PlatformConfig,
} from '../src/server/platform-config.js';
const config: PlatformConfig = {
  apiKey: 'fixture',
  model: 'fixture',
  baseUrl: 'https://example.com',
  voiceName: 'marin',
};
it('requires only model setup and disables voice when it is absent', () => {
  expect(setupStatus(config)).toMatchObject({ missing: [], model: true });
  expect(
    setupStatus({
      ...config,
      apiKey: '',
      voiceKey: 'fixture',
      voiceModel: 'fixture',
    }),
  ).toMatchObject({ missing: ['OPENAI_API_KEY'], voice: false });
});
it('reports web search and the page reader from configuration', () => {
  expect(setupStatus(config)).toMatchObject({ search: true, browser: false });
  expect(
    setupStatus({
      ...config,
      webSearchProvider: 'disabled',
      browserUrl: 'http://127.0.0.1:4311',
      browserSecret: 'secret',
    }),
  ).toMatchObject({ search: false, browser: true });
});
