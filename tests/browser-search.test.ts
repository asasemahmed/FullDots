import { afterEach, describe, expect, it } from 'vitest';
import {
  clearEngineBlocks,
  DEFAULT_SEARCH_ENGINES,
  detectSearchBlock,
  ENGINE_COOLDOWN_MS,
  findConsentButton,
  isEngineCoolingDown,
  isEngineHost,
  markEngineBlocked,
  orderSearchEngines,
  parseBrowserSearchResults,
  parseDisplayUrl,
  resetAllEngineBlocks,
  searchEngineUrl,
  webSearchEngines,
} from '../src/server/browser-search.js';
import {
  bingBrowserPage,
  braveBrowserPage,
  duckDuckGoBrowserPage,
  googleBrowserPage,
  googleConsentPage,
  startpageBrowserPage,
} from './fixtures/web-search.js';

afterEach(() => {
  resetAllEngineBlocks();
});

describe('search engine configuration and ordering', () => {
  it('parses single engines with fallbacks and custom lists', () => {
    expect(webSearchEngines()).toBeUndefined();
    expect(webSearchEngines('  ')).toBeUndefined();
    expect(webSearchEngines('brave')).toEqual([
      'brave',
      'duckduckgo',
      'bing',
      'startpage',
      'google',
    ]);
    expect(webSearchEngines('brave, duckduckgo, google, brave')).toEqual([
      'brave',
      'duckduckgo',
      'google',
    ]);
    expect(() => webSearchEngines('brave, altavista')).toThrow(
      'WEB_SEARCH_ENGINE must be one or more of duckduckgo, brave, bing, startpage or google.',
    );
  });

  it('builds search URLs with encoded queries', () => {
    expect(searchEngineUrl('duckduckgo', 'full dots')).toBe(
      'https://duckduckgo.com/?q=full%20dots',
    );
    expect(searchEngineUrl('brave', 'a+b')).toBe(
      'https://search.brave.com/search?q=a%2Bb',
    );
  });

  it('orders preferred engines first and pushes blocked engines to the back until cool-down expires', () => {
    const configured = webSearchEngines('duckduckgo,brave,bing');
    expect(orderSearchEngines('dot-1', configured, 'bing')).toEqual([
      'bing',
      'duckduckgo',
      'brave',
    ]);

    const t0 = 1_000_000;
    markEngineBlocked('dot-1', 'duckduckgo', t0);
    expect(isEngineCoolingDown('dot-1', 'duckduckgo', t0 + 1000)).toBe(true);
    expect(
      orderSearchEngines('dot-1', configured, undefined, t0 + 1000),
    ).toEqual(['brave', 'bing', 'duckduckgo']);
    // Another Dot's order is unaffected.
    expect(
      orderSearchEngines('dot-2', configured, undefined, t0 + 1000),
    ).toEqual(['duckduckgo', 'brave', 'bing']);
    // Cool-down expires after ENGINE_COOLDOWN_MS.
    expect(
      orderSearchEngines(
        'dot-1',
        configured,
        undefined,
        t0 + ENGINE_COOLDOWN_MS + 1,
      ),
    ).toEqual(['duckduckgo', 'brave', 'bing']);

    markEngineBlocked('dot-1', 'brave', t0);
    clearEngineBlocks('dot-1', 'brave');
    expect(isEngineCoolingDown('dot-1', 'brave', t0 + 100)).toBe(false);
    expect(orderSearchEngines('dot-1')).toEqual([...DEFAULT_SEARCH_ENGINES]);
  });
});

describe('cookie consent dismissal', () => {
  it('verifies the search engine host and consent subdomains', () => {
    expect(
      isEngineHost('duckduckgo', 'https://html.duckduckgo.com/html/?q=test'),
    ).toBe(true);
    expect(
      isEngineHost(
        'google',
        'https://consent.google.com/m?continue=https://www.google.com/search',
      ),
    ).toBe(true);
    expect(isEngineHost('google', 'https://evil-google.com/search')).toBe(
      false,
    );
    expect(isEngineHost('brave', 'https://example.org/')).toBe(false);
  });

  it('prefers Reject all / essential-only buttons and refuses non-engine hosts or risky buttons', () => {
    expect(
      findConsentButton('google', {
        url: 'https://consent.google.com/m',
        elements: googleConsentPage.elements,
      }),
    ).toEqual({
      ref: 'g2',
      role: 'button',
      name: 'Reject all',
    });

    // Falls back to Accept all when no reject option exists.
    expect(
      findConsentButton('bing', {
        url: 'https://www.bing.com/search?q=test',
        elements: [{ ref: 'b1', role: 'button', name: 'Accept all' }],
      }),
    ).toEqual({
      ref: 'b1',
      role: 'button',
      name: 'Accept all',
    });

    // Refuses to click on a non-engine host.
    expect(
      findConsentButton('google', {
        url: 'https://phishing.example.com/',
        elements: googleConsentPage.elements,
      }),
    ).toBeUndefined();

    // Never clicks verification, login, or payment buttons even if they contain accept/agree words.
    expect(
      findConsentButton('google', {
        url: 'https://www.google.com/search?q=test',
        elements: [
          { ref: 'x1', role: 'button', name: 'Accept human verification' },
          { ref: 'x2', role: 'button', name: 'Agree and sign in' },
          { ref: 'x3', role: 'button', name: 'Accept & pay' },
        ],
      }),
    ).toBeUndefined();
  });
});

describe('bot check detection', () => {
  it('detects soft bot blocks across all supported engines', () => {
    expect(
      detectSearchBlock(
        'duckduckgo',
        {
          url: 'https://duckduckgo.com/?q=test',
          title: 'DuckDuckGo',
          elements: [],
        },
        'Unfortunately, bots use DuckDuckGo too. Please complete the following challenge.',
      ),
    ).toMatch(/DuckDuckGo is asking for a human verification check/);

    expect(
      detectSearchBlock(
        'brave',
        {
          url: 'https://search.brave.com/search?q=test',
          title: 'Captcha - Brave Search',
          elements: [],
        },
        'Please verify you are a human.',
      ),
    ).toMatch(/Brave Search is asking for a human verification check/);

    expect(
      detectSearchBlock(
        'google',
        {
          url: 'https://www.google.com/sorry/index?continue=x',
          title: 'Sorry...',
          elements: [],
        },
        'Our systems have detected unusual traffic from your computer network.',
      ),
    ).toMatch(/Google is asking for a human verification check/);

    expect(
      detectSearchBlock(
        'duckduckgo',
        {
          url: 'https://duckduckgo.com/?q=test',
          title: duckDuckGoBrowserPage.title,
          elements: duckDuckGoBrowserPage.elements,
        },
        duckDuckGoBrowserPage.text,
      ),
    ).toBeUndefined();
  });
});

describe('display URL normalization', () => {
  it('normalizes full URLs, domain paths, breadcrumbs, and DuckDuckGo redirects', () => {
    expect(parseDisplayUrl('https://www.th-deg.de/en/postgraduate')).toBe(
      'https://www.th-deg.de/en/postgraduate',
    );
    expect(parseDisplayUrl('github.com/asasemahmed/FullDots')).toBe(
      'https://github.com/asasemahmed/FullDots',
    );
    expect(parseDisplayUrl('docs.fulldots.dev › setup › computers')).toBe(
      'https://docs.fulldots.dev/setup/computers',
    );
    expect(
      parseDisplayUrl(
        'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fguide&rut=123',
      ),
    ).toBe('https://example.org/guide');
  });

  it('unwraps redirects only on DuckDuckGo itself, not a look-alike host', () => {
    expect(
      parseDisplayUrl(
        'https://links.duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa',
      ),
    ).toBe('https://example.org/a');
    expect(
      parseDisplayUrl(
        'https://evilduckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa',
      ),
    ).not.toBe('https://example.org/a');
  });

  it('parses a long breadcrumb of truncated segments without backtracking', () => {
    const page = (text: string) => ({
      engine: 'duckduckgo' as const,
      url: 'https://duckduckgo.com/?q=x',
      title: 'Search',
      text,
      elements: [],
    });
    const started = performance.now();
    parseBrowserSearchResults(
      page(`Title example.org${' › ...'.repeat(4000)} !`),
    );
    parseBrowserSearchResults(page(`example.org${' › ...'.repeat(4000)}!`));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('rejects truncated URLs, engine internal URLs, credentials, and plain text', () => {
    expect(
      parseDisplayUrl('https://example.org › docs › ... › guide'),
    ).toBeUndefined();
    expect(parseDisplayUrl('https://example.org/path/…')).toBeUndefined();
    expect(parseDisplayUrl('https://duckduckgo.com/?q=test')).toBeUndefined();
    expect(
      parseDisplayUrl('https://search.brave.com/search?q=test'),
    ).toBeUndefined();
    expect(parseDisplayUrl('https://user:pass@example.org/')).toBeUndefined();
    expect(parseDisplayUrl('javascript:alert(1)')).toBeUndefined();
    expect(
      parseDisplayUrl('Run AI coworkers on your own server.'),
    ).toBeUndefined();
  });
});

describe('browser search result extraction', () => {
  it('extracts DuckDuckGo results, skipping Sponsored ads and navigation noise', () => {
    const results = parseBrowserSearchResults({
      engine: 'duckduckgo',
      url: 'https://duckduckgo.com/?q=fulldots',
      title: duckDuckGoBrowserPage.title,
      elements: duckDuckGoBrowserPage.elements,
      text: duckDuckGoBrowserPage.text,
    });
    expect(results).toEqual([
      {
        title: 'FullDots: self-hosted & local-first AI coworkers',
        url: 'https://github.com/asasemahmed/FullDots',
        snippet:
          'Run AI coworkers on your own server with persistent computers.',
        ref: 'e6',
      },
      {
        title: 'Postgraduate Studies | DIT',
        url: 'https://www.th-deg.de/en/postgraduate',
        snippet: 'Master Degrees at Deggendorf Institute of Technology.',
        ref: 'e9',
      },
    ]);
  });

  it('extracts Brave Search compound links and pairs them with page text snippets', () => {
    const results = parseBrowserSearchResults({
      engine: 'brave',
      url: 'https://search.brave.com/search?q=fulldots',
      title: braveBrowserPage.title,
      elements: braveBrowserPage.elements,
      text: braveBrowserPage.text,
    });
    expect(results).toEqual([
      {
        title: 'FullDots - Self-hosted AI coworkers',
        url: 'https://github.com/asasemahmed/FullDots',
        snippet:
          'Open-source platform for local-first AI coworkers and persistent computers.',
        ref: 'b4',
      },
      {
        title: 'Setting up Dot computers',
        url: 'https://docs.fulldots.dev/setup/computers',
        snippet:
          'Step-by-step guide to running isolated containers for each Dot.',
        ref: 'b5',
      },
    ]);
  });

  it('extracts Startpage [URL, Title] link pairs and snippets', () => {
    const results = parseBrowserSearchResults({
      engine: 'startpage',
      url: 'https://www.startpage.com/sp/search?query=fulldots',
      title: startpageBrowserPage.title,
      elements: startpageBrowserPage.elements,
      text: startpageBrowserPage.text,
    });
    expect(results).toEqual([
      {
        title: 'FullDots Repository',
        url: 'https://github.com/asasemahmed/FullDots',
        snippet:
          'Self-hosted AI coworkers with persistent computers and approval gates.',
        ref: 's3',
      },
    ]);
  });

  it('extracts Bing title links paired with visible URLs and snippets in page text', () => {
    const results = parseBrowserSearchResults({
      engine: 'bing',
      url: 'https://www.bing.com/search?q=fulldots',
      title: bingBrowserPage.title,
      elements: bingBrowserPage.elements,
      text: bingBrowserPage.text,
    });
    expect(results).toEqual([
      {
        title: 'FullDots on GitHub',
        url: 'https://github.com/asasemahmed/FullDots',
        snippet:
          'Local-first AI coworkers with their own browser and terminal.',
        ref: 'm2',
      },
    ]);
  });

  it('keeps click refs for truncated breadcrumbs without guessing their URL', () => {
    const results = parseBrowserSearchResults({
      engine: 'google',
      url: 'https://www.google.com/search?q=fulldots',
      title: googleBrowserPage.title,
      elements: googleBrowserPage.elements,
      text: googleBrowserPage.text,
    });
    expect(results).toEqual([
      {
        title: 'Truncated Result Title',
        url: '',
        snippet: 'Should not guess a truncated breadcrumb.',
        ref: 'g10',
      },
      {
        title: 'FullDots Documentation',
        url: 'https://docs.fulldots.dev/guide/search',
        snippet: 'Configure web search with the Dot browser or SearXNG.',
        ref: 'g11',
      },
    ]);
  });
});
