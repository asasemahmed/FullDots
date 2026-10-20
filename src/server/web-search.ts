// Keyless web search through DuckDuckGo's HTML endpoint, a self-hosted
// SearXNG instance, or a Dot's own computer browser, plus page reading
// through the isolated read-only browser service.
import { z } from 'zod';
import {
  webSearchEngines,
  type BrowserSearchEngine,
} from './browser-search.js';
export {
  BROWSER_SEARCH_ENGINES,
  DEFAULT_SEARCH_ENGINES,
  ENGINE_LABELS,
  clearEngineBlocks,
  detectSearchBlock,
  findConsentButton,
  isEngineCoolingDown,
  isEngineHost,
  markEngineBlocked,
  orderSearchEngines,
  parseBrowserSearchResults,
  parseDisplayUrl,
  resetAllEngineBlocks,
  searchEngineUrl,
  searchInputSchema,
  webSearchEngines,
  type BrowserSearchEngine,
  type BrowserSearchResult,
  type SearchInput,
  type SearchPageInput,
  type SearchSnapshotElement,
} from './browser-search.js';

export type WebSearchProvider =
  'duckduckgo' | 'searxng' | 'browser' | 'disabled';
export interface WebConfig {
  webSearchProvider?: WebSearchProvider;
  /** Base address of a self-hosted SearXNG instance (WEB_SEARCH_PROVIDER=searxng, or fallback for browser). */
  searxngUrl?: string;
  /** Preferred browser search engine or fallback list (WEB_SEARCH_ENGINE). */
  webSearchEngines?: BrowserSearchEngine[];
  /** Optional browser search callback when running inside a Dot turn with a computer. */
  browserSearch?: (
    query: string,
    limit: number,
    signal?: AbortSignal,
  ) => Promise<SearchResult[]>;
  browserUrl?: string;
  browserSecret?: string;
}
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}
export interface WebSource {
  title: string;
  url: string;
  text: string;
  screenshot?: string;
}

export function webSearchProvider(value?: string): WebSearchProvider {
  if (!value) return 'duckduckgo';
  if (
    value === 'duckduckgo' ||
    value === 'searxng' ||
    value === 'browser' ||
    value === 'disabled'
  )
    return value;
  throw new Error(
    'WEB_SEARCH_PROVIDER must be duckduckgo, searxng, browser or disabled.',
  );
}

const searxngExample = 'for example http://searxng:8080';

/** Validates SEARXNG_URL: an http(s) base address without credentials, query or fragment. */
export function searxngUrl(value?: string): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  let url: URL | undefined;
  try {
    url = new URL(text);
  } catch {
    url = undefined;
  }
  if (!url || !['http:', 'https:'].includes(url.protocol))
    throw new Error(
      `SEARXNG_URL must be an http:// or https:// address, ${searxngExample}.`,
    );
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      `SEARXNG_URL must be a plain base address without credentials, query or fragment, ${searxngExample}.`,
    );
  return url.href.replace(/\/+$/, '');
}

/** Reads WEB_SEARCH_PROVIDER, optional WEB_SEARCH_ENGINE, and for SearXNG the required SEARXNG_URL. */
export function webSearchConfig(
  env: Record<string, string | undefined>,
): Pick<WebConfig, 'webSearchProvider' | 'searxngUrl' | 'webSearchEngines'> {
  const provider = webSearchProvider(env.WEB_SEARCH_PROVIDER);
  const engines = webSearchEngines(env.WEB_SEARCH_ENGINE);
  const withEngines = engines ? { webSearchEngines: engines } : {};
  if (provider === 'disabled' || provider === 'duckduckgo')
    return { webSearchProvider: provider, ...withEngines };
  const url = searxngUrl(env.SEARXNG_URL);
  if (provider === 'searxng' && !url)
    throw new Error(
      `WEB_SEARCH_PROVIDER=searxng needs SEARXNG_URL, the address of your SearXNG instance, ${searxngExample}.`,
    );
  return {
    webSearchProvider: provider,
    ...(url ? { searxngUrl: url } : {}),
    ...withEngines,
  };
}

export const browserResponse = z.object({
  title: z.string(),
  url: z.string().url(),
  text: z.string().min(1),
  screenshot: z.string().optional(),
});

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
function decodeHtml(value: string) {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
      if (code[0] === '#')
        return String.fromCodePoint(
          code[1].toLowerCase() === 'x'
            ? parseInt(code.slice(2), 16)
            : parseInt(code.slice(1), 10),
        );
      return entities[code.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

// A result link a Dot may open: http(s) without credentials.
function safeUrl(target: string, blockedHost?: string): string | undefined {
  try {
    const url = new URL(target);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      (blockedHost && url.hostname.endsWith(blockedHost))
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function resultUrl(href: string): string | undefined {
  try {
    const url = new URL(decodeHtml(href), 'https://duckduckgo.com');
    // Some results are wrapped in a DuckDuckGo redirect.
    const target =
      url.hostname.endsWith('duckduckgo.com') && url.pathname === '/l/'
        ? url.searchParams.get('uddg')
        : url.href;
    return target ? safeUrl(target, 'duckduckgo.com') : undefined;
  } catch {
    return undefined;
  }
}

export function parseResults(html: string, limit = 8): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  // Each result is a <div> whose class list contains the token "result".
  const starts = [...html.matchAll(/<div[^>]*\sclass="([^"]*)"/g)]
    .map((match) => ({
      index: match.index,
      classes: match[1].split(/\s+/),
    }))
    .filter(({ classes }) => classes.includes('result'));
  for (const [position, start] of starts.entries()) {
    if (start.classes.includes('result--ad')) continue;
    const block = html.slice(start.index, starts[position + 1]?.index);
    const link = block.match(
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/,
    );
    if (!link) continue;
    const url = resultUrl(link[1]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const snippet = block.match(
      /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/,
    );
    results.push({
      title: decodeHtml(link[2]) || url,
      url,
      snippet: snippet ? decodeHtml(snippet[1]) : '',
    });
    if (results.length >= limit) break;
  }
  return results;
}

const searxngResult = z.object({
  url: z.string(),
  title: z.string().optional(),
  content: z.string().optional(),
});
const searxngResponse = z.object({
  results: z.array(z.unknown()),
  unresponsive_engines: z.array(z.array(z.unknown())).optional().catch([]),
});

/** Turns a SearXNG JSON answer into results; throws when nothing came back because engines failed. */
export function parseSearxngResults(data: unknown, limit = 8): SearchResult[] {
  const parsed = searxngResponse.safeParse(data);
  if (!parsed.success)
    throw new Error(
      'SearXNG returned JSON without a results list. Check that SEARXNG_URL points at SearXNG itself.',
    );
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const item of parsed.data.results) {
    const result = searxngResult.safeParse(item);
    if (!result.success) continue;
    const url = safeUrl(result.data.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: decodeHtml(result.data.title ?? '').slice(0, 300) || url,
      url,
      snippet: decodeHtml(result.data.content ?? '').slice(0, 1000),
    });
    if (results.length >= limit) break;
  }
  const failed = (parsed.data.unresponsive_engines ?? [])
    .map(([engine, reason]) =>
      (typeof reason === 'string' && reason
        ? `${String(engine)} (${reason})`
        : String(engine)
      ).slice(0, 80),
    )
    .slice(0, 6);
  if (!results.length && failed.length)
    throw new Error(
      `SearXNG found nothing because its search engines did not answer: ${failed.join(', ')}. Try again later or enable other engines in its settings.yml.`,
    );
  return results;
}

const searchTimeoutMs = 15000;
/** Search answers larger than this are refused instead of read into memory. */
export const maxSearchResponseBytes = 2_000_000;

function searchSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(searchTimeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

class ResponseTooLarge extends Error {}

async function readLimited(response: Response, source: string) {
  const tooLarge = () =>
    new ResponseTooLarge(
      `${source} sent more than ${maxSearchResponseBytes / 1_000_000} MB; the search was stopped.`,
    );
  if (Number(response.headers.get('content-length')) > maxSearchResponseBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxSearchResponseBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const searxngHint =
  'Run a private SearXNG and set WEB_SEARCH_PROVIDER=searxng with SEARXNG_URL (see "Web search" in docs/SETUP.md).';

async function searchDuckDuckGo(
  query: string,
  signal: AbortSignal | undefined,
  limit: number,
): Promise<SearchResult[]> {
  const response = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
      Accept: 'text/html',
    },
    body: new URLSearchParams({ q: query }).toString(),
    signal: searchSignal(signal),
    redirect: 'error',
  });
  if (response.status === 403 || response.status === 429)
    throw new Error(
      `DuckDuckGo refused the search (HTTP ${response.status}): it is limiting this server's IP address. ${searxngHint}`,
    );
  if (!response.ok)
    throw new Error(`Web search returned HTTP ${response.status}.`);
  const html = await readLimited(response, 'DuckDuckGo');
  const results = parseResults(html, limit);
  if (!results.length && /anomaly|captcha/i.test(html))
    throw new Error(
      `DuckDuckGo is blocking searches from this server's IP address: it answered with its bot check instead of results. This is common on VPS and cloud servers, and waiting will not fix it. ${searxngHint}`,
    );
  return results;
}

async function searchSearxng(
  query: string,
  baseUrl: string | undefined,
  signal: AbortSignal | undefined,
  limit: number,
): Promise<SearchResult[]> {
  if (!baseUrl)
    throw new Error('Web search is set to SearXNG but SEARXNG_URL is not set.');
  const url = new URL(`${baseUrl}/search`);
  url.search = new URLSearchParams({ q: query, format: 'json' }).toString();
  let response: Response;
  let body = '';
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: searchSignal(signal),
      redirect: 'error',
    });
    if (response.ok) body = await readLimited(response, 'SearXNG');
    else await response.body?.cancel();
  } catch (error) {
    if (
      signal?.aborted ||
      !(error instanceof Error) ||
      error instanceof ResponseTooLarge
    )
      throw error;
    if (error.name === 'TimeoutError')
      throw new Error(
        `SearXNG at ${baseUrl} did not answer within ${searchTimeoutMs / 1000} seconds.`,
        { cause: error },
      );
    const reason =
      error.cause instanceof Error ? error.cause.message : error.message;
    throw new Error(
      `Could not reach SearXNG at ${baseUrl} (${reason}). Check SEARXNG_URL and that the searxng service is running.`,
      { cause: error },
    );
  }
  if (response.status === 403)
    throw new Error(
      'SearXNG refused the JSON API (HTTP 403). Add json to search.formats in its settings.yml.',
    );
  if (response.status === 429)
    throw new Error(
      'SearXNG rate limited this server (HTTP 429). Set server.limiter: false in its settings.yml for a private instance.',
    );
  if (!response.ok)
    throw new Error(`SearXNG returned HTTP ${response.status}.`);
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(
      'SearXNG did not answer with JSON. Check that SEARXNG_URL points at SearXNG itself.',
    );
  }
  return parseSearxngResults(data, limit);
}

export async function searchWeb(
  query: string,
  config: WebConfig,
  signal?: AbortSignal,
  limit = 8,
): Promise<SearchResult[]> {
  const provider = config.webSearchProvider ?? 'duckduckgo';
  if (provider === 'disabled')
    throw new Error('Web search is turned off (WEB_SEARCH_PROVIDER=disabled).');
  if (provider === 'browser') {
    if (config.browserSearch) return config.browserSearch(query, limit, signal);
    if (config.searxngUrl)
      return searchSearxng(query, config.searxngUrl, signal, limit);
    return searchDuckDuckGo(query, signal, limit);
  }
  return provider === 'searxng'
    ? searchSearxng(query, config.searxngUrl, signal, limit)
    : searchDuckDuckGo(query, signal, limit);
}

export async function readPage(
  url: string,
  config: WebConfig,
  signal?: AbortSignal,
): Promise<WebSource> {
  if (!config.browserUrl || !config.browserSecret)
    throw new Error(
      'Page reading is not configured: set BROWSER_URL and BROWSER_SECRET and run the browser service.',
    );
  const response = await fetch(
    `${config.browserUrl.replace(/\/$/, '')}/browse`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.browserSecret}`,
      },
      body: JSON.stringify({ url }),
      signal,
    },
  );
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const message = z.object({ error: z.string() }).safeParse(data);
    throw new Error(
      `Browser failed (${response.status}): ${message.success ? message.data.error : 'Could not read the source.'} Redirects, private addresses, and JavaScript-only pages are not supported.`,
    );
  }
  const parsed = browserResponse.safeParse(await response.json());
  if (!parsed.success)
    throw new Error('Browser returned an invalid or empty source response.');
  return { ...parsed.data, text: parsed.data.text.slice(0, 24000) };
}
