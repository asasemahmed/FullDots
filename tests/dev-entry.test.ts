import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('../src/server/index.js');
  vi.resetModules();
});

it.each([undefined, 'production'])(
  'sets development mode before initializing the server (inherited mode: %s)',
  async (mode) => {
    const initialized = vi.fn();
    vi.doMock('../src/server/index.js', () => {
      initialized(process.env.NODE_ENV);
      return {};
    });
    vi.stubEnv('NODE_ENV', mode);
    await import('../src/server/dev.js');
    expect(initialized).toHaveBeenCalledExactlyOnceWith('development');
  },
);

it('uses the development entry without a POSIX-only environment assignment', () => {
  const { scripts } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  expect(scripts.dev).toContain('--watch src/server/dev.ts');
  expect(scripts.dev).not.toMatch(/\bNODE_ENV=/);
});
