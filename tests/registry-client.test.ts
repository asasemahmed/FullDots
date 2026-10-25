import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RegistryError,
  clearRegistryCache,
  searchRegistry,
} from '../src/server/registry-client.js';

// The registry is never contacted: fetch is replaced in every test.
const entry = (server: Record<string, unknown> = {}) => ({
  server: {
    name: 'io.github.example/weather',
    title: 'Weather',
    description: 'Forecasts for a city',
    version: '1.2.0',
    repository: {
      url: 'https://github.com/example/weather',
      source: 'github',
      id: 'repo-1',
    },
    remotes: [{ type: 'streamable-http', url: 'https://weather.example/mcp' }],
    packages: [
      {
        registryType: 'npm',
        identifier: '@example/weather',
        version: '1.2.0',
        transport: { type: 'stdio' },
        environmentVariables: [{ name: 'API_KEY', isSecret: true }],
      },
    ],
    websiteUrl: 'https://weather.example',
    icons: [{ src: 'https://weather.example/icon.png' }],
    _meta: { 'io.modelcontextprotocol.registry/publisher-provided': {} },
    ...server,
  },
  _meta: {
    'io.modelcontextprotocol.registry/official': { status: 'active' },
  },
});

const answer = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  clearRegistryCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('searchRegistry', () => {
  it('parses a valid answer and keeps only the fields FullDots shows', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      answer({
        servers: [entry()],
        metadata: { count: 1, nextCursor: 'page-2' },
      }),
    );
    const result = await searchRegistry('weather');
    expect(result).toEqual({
      servers: [
        {
          name: 'io.github.example/weather',
          title: 'Weather',
          description: 'Forecasts for a city',
          version: '1.2.0',
          repository: { url: 'https://github.com/example/weather' },
          remotes: [
            { type: 'streamable-http', url: 'https://weather.example/mcp' },
          ],
          packages: [
            {
              registryType: 'npm',
              transport: 'stdio',
              identifier: '@example/weather',
              version: '1.2.0',
              envNames: ['API_KEY'],
            },
          ],
        },
      ],
      nextCursor: 'page-2',
    });
    expect(result.servers[0]).not.toHaveProperty('websiteUrl');
    expect(result.servers[0]).not.toHaveProperty('icons');
    expect(result.servers[0]).not.toHaveProperty('_meta');
  });

  it('sends only the search text and fixed paging values, with no credentials', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => answer({ servers: [] }));
    await searchRegistry('weather');
    const url = new URL(String(spy.mock.calls[0]?.[0]));
    expect(url.origin).toBe('https://registry.modelcontextprotocol.io');
    expect(url.pathname).toBe('/v0.1/servers');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      search: 'weather',
      version: 'latest',
      limit: '20',
    });
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'manual' });
    expect(init.headers).toEqual({ Accept: 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('passes the cursor back unchanged for the next page', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => answer({ servers: [] }));
    await searchRegistry('weather', 'page-2');
    const url = new URL(String(spy.mock.calls[0]?.[0]));
    expect(url.searchParams.get('cursor')).toBe('page-2');
  });

  it('drops a repository address that is not http or https', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      answer({
        servers: [entry({ repository: { url: 'javascript:alert(1)' } })],
      }),
    );
    const result = await searchRegistry('weather');
    expect(result.servers[0]).not.toHaveProperty('repository');
  });

  it('accepts an entry whose repository object has no address, as the live registry sends', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      answer({ servers: [entry({ repository: {} })] }),
    );
    const result = await searchRegistry('empty-repo');
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]).not.toHaveProperty('repository');
  });

  it('keeps a package without a version or env vars, leaving those out', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      answer({
        servers: [
          entry({
            packages: [{ registryType: 'oci', transport: { type: 'stdio' } }],
          }),
        ],
      }),
    );
    const result = await searchRegistry('no-version');
    expect(result.servers[0]?.packages).toEqual([
      { registryType: 'oci', transport: 'stdio', envNames: [] },
    ]);
  });

  it('rejects an answer it cannot read', async () => {
    const bad = [
      {},
      { servers: [{ server: { name: 'no-version' } }] },
      { servers: [entry({ remotes: [{ type: 'sse' }] })] },
    ];
    for (const body of bad) {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        answer(body),
      );
      await expect(
        searchRegistry(`bad-${JSON.stringify(body).length}`),
      ).rejects.toBeInstanceOf(RegistryError);
      vi.restoreAllMocks();
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('not json', { status: 200 }),
    );
    await expect(searchRegistry('text')).rejects.toThrow('could not read');
  });

  it('reports a timeout in plain words', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new DOMException('The operation timed out.', 'TimeoutError'),
    );
    await expect(searchRegistry('slow')).rejects.toThrow(
      'did not answer in time',
    );
  });

  it('reports an unreachable registry in plain words', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed'),
    );
    await expect(searchRegistry('offline')).rejects.toThrow(
      'could not be reached',
    );
  });

  it('refuses a redirect instead of following it', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://elsewhere.example/' },
        }),
    );
    await expect(searchRegistry('moved')).rejects.toThrow('redirect');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refuses an answer over 1 MB, whether declared or streamed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-length': String(2 * 1024 * 1024) },
        }),
    );
    await expect(searchRegistry('declared')).rejects.toThrow('too large');

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(600_000));
              controller.enqueue(new Uint8Array(600_000));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    );
    await expect(searchRegistry('streamed')).rejects.toThrow('too large');
  });

  it('answers a repeat search from the cache for 24 hours, then asks again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2026-10-25T08:00:00Z').getTime();
    vi.setSystemTime(start);
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => answer({ servers: [entry()] }));

    await searchRegistry('weather');
    await searchRegistry('weather');
    expect(spy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(start + 23 * 60 * 60 * 1000);
    await searchRegistry('weather');
    expect(spy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(start + 25 * 60 * 60 * 1000);
    await searchRegistry('weather');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('keeps at most 200 searches in the cache', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => answer({ servers: [] }));
    for (let i = 0; i <= 200; i++) await searchRegistry(`q${i}`);
    expect(spy).toHaveBeenCalledTimes(201);

    await searchRegistry('q200');
    expect(spy).toHaveBeenCalledTimes(201);
    await searchRegistry('q0');
    expect(spy).toHaveBeenCalledTimes(202);
  });
});
