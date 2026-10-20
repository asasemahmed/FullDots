import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  maxSearchResponseBytes,
  parseResults,
  parseSearxngResults,
  searchWeb,
  searxngUrl,
  webSearchConfig,
  webSearchProvider,
  type WebConfig,
} from '../src/server/web-search.js';
import {
  duckDuckGoAnomalyPage,
  searxngAllEnginesFailed,
  searxngAnswer,
} from './fixtures/web-search.js';

afterEach(() => vi.unstubAllGlobals());

const html = `
<div class="result results_links results_links_deep result--ad"><a rel="nofollow" class="result__a" href="https://ads.example/">Ad</a></div>
<div class="result results_links results_links_deep web-result "><div class="links_main links_deep result__body">
<a rel="nofollow" class="result__a" href="https://www.th-deg.de/en/postgraduate">Postgraduate Studies | DIT</a>
<a class="result__snippet" href="https://www.th-deg.de/en/postgraduate"><b>Master</b> Degrees at DIT &amp; more&#x27;s</a>
</div></div>
<div class="result results_links web-result "><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpage&amp;rut=x">Wrapped</a></div>
<div class="result results_links web-result "><a rel="nofollow" class="result__a" href="javascript:alert(1)">Bad</a></div>`;

const searxng: WebConfig = {
  webSearchProvider: 'searxng',
  searxngUrl: 'http://searxng:8080',
};

function stubFetch(response: () => Response | Promise<Response>) {
  const fetch = vi.fn(async () => response());
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

it('parses organic results, unwraps redirects, and skips ads and unsafe links', () => {
  expect(parseResults(html)).toEqual([
    {
      title: 'Postgraduate Studies | DIT',
      url: 'https://www.th-deg.de/en/postgraduate',
      snippet: "Master Degrees at DIT & more's",
    },
    { title: 'Wrapped', url: 'https://example.org/page', snippet: '' },
  ]);
});

it('defaults to DuckDuckGo and rejects unknown providers', () => {
  expect(webSearchProvider()).toBe('duckduckgo');
  expect(webSearchProvider('disabled')).toBe('disabled');
  expect(webSearchProvider('searxng')).toBe('searxng');
  expect(webSearchProvider('browser')).toBe('browser');
  expect(() => webSearchProvider('parallel')).toThrow(
    'duckduckgo, searxng, browser or disabled',
  );
});

describe('SearXNG configuration', () => {
  it('accepts http(s) base addresses and drops trailing slashes', () => {
    expect(searxngUrl('http://searxng:8080')).toBe('http://searxng:8080');
    expect(searxngUrl(' https://search.example.com/searx/ ')).toBe(
      'https://search.example.com/searx',
    );
    expect(searxngUrl('')).toBeUndefined();
    expect(searxngUrl()).toBeUndefined();
  });

  it('rejects other schemes, credentials, queries and fragments', () => {
    for (const value of [
      'searxng:8080',
      'ftp://searxng',
      'not a url',
      'file:///etc/passwd',
    ])
      expect(() => searxngUrl(value), value).toThrow(
        'SEARXNG_URL must be an http:// or https:// address',
      );
    for (const value of [
      'http://user:pass@searxng:8080',
      'http://searxng:8080/?format=json',
      'http://searxng:8080/#top',
    ])
      expect(() => searxngUrl(value), value).toThrow('plain base address');
  });

  it('requires SEARXNG_URL only for the searxng provider', () => {
    expect(webSearchConfig({})).toEqual({ webSearchProvider: 'duckduckgo' });
    expect(
      webSearchConfig({ WEB_SEARCH_PROVIDER: 'disabled', SEARXNG_URL: 'x' }),
    ).toEqual({ webSearchProvider: 'disabled' });
    expect(
      webSearchConfig({
        WEB_SEARCH_PROVIDER: 'searxng',
        SEARXNG_URL: 'http://searxng:8080/',
      }),
    ).toEqual(searxng);
    expect(() => webSearchConfig({ WEB_SEARCH_PROVIDER: 'searxng' })).toThrow(
      'WEB_SEARCH_PROVIDER=searxng needs SEARXNG_URL',
    );
    expect(
      webSearchConfig({
        WEB_SEARCH_PROVIDER: 'browser',
        WEB_SEARCH_ENGINE: 'brave, startpage',
      }),
    ).toEqual({
      webSearchProvider: 'browser',
      webSearchEngines: ['brave', 'startpage'],
    });
  });
});

describe('SearXNG results', () => {
  it('keeps safe, unique results in the shared shape', () => {
    expect(parseSearxngResults(searxngAnswer)).toEqual([
      {
        title: 'FullDots: self-hosted & local-first AI coworkers',
        url: 'https://github.com/asasemahmed/FullDots',
        snippet: 'Run AI coworkers on your own server. No telemetry.',
      },
      {
        title: 'https://docs.example.org/setup',
        url: 'https://docs.example.org/setup',
        snippet: 'Setup guide.',
      },
    ]);
    expect(parseSearxngResults(searxngAnswer, 1)).toHaveLength(1);
  });

  it('caps long titles and snippets', () => {
    const [result] = parseSearxngResults({
      results: [
        {
          url: 'https://example.org/',
          title: 't'.repeat(1000),
          content: 'c'.repeat(5000),
        },
      ],
    });
    expect(result.title).toHaveLength(300);
    expect(result.snippet).toHaveLength(1000);
  });

  it('names the engines that failed when nothing came back', () => {
    expect(() => parseSearxngResults(searxngAllEnginesFailed)).toThrow(
      'its search engines did not answer: google (CAPTCHA), duckduckgo (too many requests), brave (timeout)',
    );
    expect(parseSearxngResults({ results: [] })).toEqual([]);
  });

  it('rejects answers that are not SearXNG results', () => {
    expect(() => parseSearxngResults({ hello: 'world' })).toThrow(
      'without a results list',
    );
  });
});

describe('searchWeb with SearXNG', () => {
  it('queries the JSON API without redirects and returns results', async () => {
    const fetch = stubFetch(() => Response.json(searxngAnswer));
    const results = await searchWeb('fulldots self hosted', searxng);
    expect(results.map((result) => result.url)).toEqual([
      'https://github.com/asasemahmed/FullDots',
      'https://docs.example.org/setup',
    ]);
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe(
      'http://searxng:8080/search?q=fulldots+self+hosted&format=json',
    );
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('explains a disabled JSON format, the limiter and other errors', async () => {
    stubFetch(() => new Response('Forbidden', { status: 403 }));
    await expect(searchWeb('q', searxng)).rejects.toThrow(
      'Add json to search.formats',
    );
    stubFetch(() => new Response('Too Many Requests', { status: 429 }));
    await expect(searchWeb('q', searxng)).rejects.toThrow(
      'server.limiter: false',
    );
    stubFetch(() => new Response('oops', { status: 500 }));
    await expect(searchWeb('q', searxng)).rejects.toThrow(
      'SearXNG returned HTTP 500.',
    );
    stubFetch(() => new Response('<html>Not SearXNG</html>'));
    await expect(searchWeb('q', searxng)).rejects.toThrow(
      'did not answer with JSON',
    );
  });

  it('says when SearXNG cannot be reached or is too slow', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed', {
        cause: new Error('getaddrinfo ENOTFOUND searxng'),
      });
    });
    await expect(searchWeb('q', searxng)).rejects.toThrow(
      'Could not reach SearXNG at http://searxng:8080 (getaddrinfo ENOTFOUND searxng)',
    );
    stubFetch(() => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    await expect(searchWeb('q', searxng)).rejects.toThrow(
      'did not answer within 15 seconds',
    );
  });

  it('passes the caller’s cancellation through unchanged', async () => {
    const controller = new AbortController();
    const reason = new Error('Turn stopped.');
    stubFetch(() => {
      controller.abort(reason);
      throw reason;
    });
    await expect(searchWeb('q', searxng, controller.signal)).rejects.toBe(
      reason,
    );
  });

  it('stops reading answers above the size cap', async () => {
    const chunk = new Uint8Array(256 * 1024).fill(32);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        sent += chunk.byteLength;
        stream.enqueue(chunk);
      },
    });
    stubFetch(() => new Response(body));
    await expect(searchWeb('q', searxng)).rejects.toThrow(
      'SearXNG sent more than 2 MB',
    );
    expect(sent).toBeLessThan(maxSearchResponseBytes + 2 * chunk.byteLength);

    stubFetch(
      () =>
        new Response('{}', {
          headers: { 'Content-Length': String(maxSearchResponseBytes + 1) },
        }),
    );
    await expect(searchWeb('q', searxng)).rejects.toThrow('more than 2 MB');
  });

  it('refuses to search without an address', async () => {
    const fetch = stubFetch(() => Response.json(searxngAnswer));
    await expect(
      searchWeb('q', { webSearchProvider: 'searxng' }),
    ).rejects.toThrow('SEARXNG_URL is not set');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('searchWeb with DuckDuckGo', () => {
  it('blames the server address on the bot check and points to SearXNG', async () => {
    stubFetch(() => new Response(duckDuckGoAnomalyPage, { status: 202 }));
    const error = await searchWeb('q', {}).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "blocking searches from this server's IP address",
    );
    expect((error as Error).message).toContain('WEB_SEARCH_PROVIDER=searxng');
    expect((error as Error).message).not.toMatch(/wait a minute/i);
  });

  it('points to SearXNG when DuckDuckGo refuses outright', async () => {
    stubFetch(() => new Response('', { status: 403 }));
    await expect(
      searchWeb('q', { webSearchProvider: 'duckduckgo' }),
    ).rejects.toThrow(/HTTP 403.*WEB_SEARCH_PROVIDER=searxng/);
  });

  it('returns parsed results and caps the page size', async () => {
    stubFetch(() => new Response(html));
    expect(await searchWeb('q', {})).toHaveLength(2);
    stubFetch(() => new Response('x'.repeat(maxSearchResponseBytes + 1)));
    await expect(searchWeb('q', {})).rejects.toThrow(
      'DuckDuckGo sent more than 2 MB',
    );
  });

  it('does not search when turned off', async () => {
    const fetch = stubFetch(() => new Response(html));
    await expect(
      searchWeb('q', { webSearchProvider: 'disabled' }),
    ).rejects.toThrow('turned off');
    expect(fetch).not.toHaveBeenCalled();
  });
});
