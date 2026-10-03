// Basic keyless web search through DuckDuckGo's HTML endpoint, plus page
// reading through the isolated read-only browser service.
import { z } from 'zod';

export type WebSearchProvider = 'duckduckgo' | 'disabled';
export interface WebConfig {
  webSearchProvider?: WebSearchProvider;
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
  if (value === 'duckduckgo' || value === 'disabled') return value;
  throw new Error('WEB_SEARCH_PROVIDER must be duckduckgo or disabled.');
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

function resultUrl(href: string): string | undefined {
  try {
    const url = new URL(decodeHtml(href), 'https://duckduckgo.com');
    // Some results are wrapped in a DuckDuckGo redirect.
    const target =
      url.hostname.endsWith('duckduckgo.com') && url.pathname === '/l/'
        ? url.searchParams.get('uddg')
        : url.href;
    if (!target) return undefined;
    const final = new URL(target);
    if (
      !['http:', 'https:'].includes(final.protocol) ||
      final.username ||
      final.password ||
      final.hostname.endsWith('duckduckgo.com')
    )
      return undefined;
    return final.href;
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

export async function searchWeb(
  query: string,
  signal?: AbortSignal,
  limit = 8,
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
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(`Web search returned HTTP ${response.status}.`);
  const html = await response.text();
  const results = parseResults(html, limit);
  if (!results.length && /anomaly|captcha/i.test(html))
    throw new Error(
      'Web search is temporarily rate limited. Wait a minute and retry.',
    );
  return results;
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
