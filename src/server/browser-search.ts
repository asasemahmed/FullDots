// Search the web through a Dot's own browser: build search engine addresses,
// dismiss cookie banners on the engine's host, spot bot checks, rotate across
// engines when one is blocked, and read structured results from the snapshot
// and visible text without dumping the whole page into the model's context.
import { z } from 'zod';

export const BROWSER_SEARCH_ENGINES = [
  'duckduckgo',
  'brave',
  'bing',
  'startpage',
  'google',
] as const;

export type BrowserSearchEngine = (typeof BROWSER_SEARCH_ENGINES)[number];

export const DEFAULT_SEARCH_ENGINES: readonly BrowserSearchEngine[] =
  BROWSER_SEARCH_ENGINES;

export const ENGINE_LABELS: Record<BrowserSearchEngine, string> = {
  duckduckgo: 'DuckDuckGo',
  brave: 'Brave Search',
  bing: 'Bing',
  startpage: 'Startpage',
  google: 'Google',
};

export interface BrowserSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Element ref of the result link on the current page, when available. */
  ref?: string;
}

export interface SearchSnapshotElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
}

export interface SearchPageInput {
  engine: BrowserSearchEngine;
  url: string;
  title: string;
  elements: readonly SearchSnapshotElement[];
  text: string;
}

export const searchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(300),
    engine: z.enum(BROWSER_SEARCH_ENGINES).optional(),
    limit: z.number().int().min(1).max(10).optional(),
  })
  .strict();

export type SearchInput = z.infer<typeof searchInputSchema>;

const ENGINE_HOSTS: Record<BrowserSearchEngine, readonly string[]> = {
  duckduckgo: ['duckduckgo.com'],
  brave: ['search.brave.com', 'brave.com'],
  bing: ['bing.com'],
  startpage: ['startpage.com'],
  google: ['google.com'],
};

/** Domains that belong to search engines or their ad/support chrome, never organic results. */
const BLOCKED_RESULT_HOSTS = [
  'duckduckgo.com',
  'spreadprivacy.com',
  'brave.com',
  'bing.com',
  'microsoft.com',
  'live.com',
  'msn.com',
  'startpage.com',
  'google.com',
  'goo.gl',
  'gstatic.com',
  'googleapis.com',
  'googleusercontent.com',
  'googleadservices.com',
  'doubleclick.net',
];

const TITLE_LIMIT = 300;
const SNIPPET_LIMIT = 400;
/** How long a soft-blocked engine is skipped before trying it again when others exist. */
export const ENGINE_COOLDOWN_MS = 15 * 60 * 1000;

const blockedUntil = new Map<string, number>();

const blockKey = (dotId: string, engine: BrowserSearchEngine) =>
  `${dotId}:${engine}`;

export function markEngineBlocked(
  dotId: string,
  engine: BrowserSearchEngine,
  now = Date.now(),
) {
  blockedUntil.set(blockKey(dotId, engine), now + ENGINE_COOLDOWN_MS);
}

export function clearEngineBlocks(dotId: string, engine?: BrowserSearchEngine) {
  if (engine) {
    blockedUntil.delete(blockKey(dotId, engine));
    return;
  }
  for (const key of blockedUntil.keys())
    if (key.startsWith(`${dotId}:`)) blockedUntil.delete(key);
}

export function resetAllEngineBlocks() {
  blockedUntil.clear();
}

export function isEngineCoolingDown(
  dotId: string,
  engine: BrowserSearchEngine,
  now = Date.now(),
): boolean {
  const until = blockedUntil.get(blockKey(dotId, engine));
  if (!until) return false;
  if (until <= now) {
    blockedUntil.delete(blockKey(dotId, engine));
    return false;
  }
  return true;
}

/**
 * Parses `WEB_SEARCH_ENGINE`: one engine (placed first ahead of the default fallback order)
 * or a comma-separated list of engines in the exact fallback order to try.
 */
export function webSearchEngines(
  value?: string,
): BrowserSearchEngine[] | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const parts = text
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  if (!parts.length) return undefined;
  const chosen: BrowserSearchEngine[] = [];
  for (const part of parts) {
    if (!(BROWSER_SEARCH_ENGINES as readonly string[]).includes(part))
      throw new Error(
        'WEB_SEARCH_ENGINE must be one or more of duckduckgo, brave, bing, startpage or google.',
      );
    const engine = part as BrowserSearchEngine;
    if (!chosen.includes(engine)) chosen.push(engine);
  }
  if (chosen.length === 1) {
    for (const fallback of DEFAULT_SEARCH_ENGINES)
      if (!chosen.includes(fallback)) chosen.push(fallback);
  }
  return chosen;
}

/** Orders engines for one search: an explicit choice first, then ready engines, then cooling-down ones. */
export function orderSearchEngines(
  dotId: string,
  configured: readonly BrowserSearchEngine[] = DEFAULT_SEARCH_ENGINES,
  preferred?: BrowserSearchEngine,
  now = Date.now(),
): BrowserSearchEngine[] {
  const base = configured.length
    ? [...configured]
    : [...DEFAULT_SEARCH_ENGINES];
  const ready = base.filter(
    (engine) =>
      engine !== preferred && !isEngineCoolingDown(dotId, engine, now),
  );
  const cooling = base.filter(
    (engine) => engine !== preferred && isEngineCoolingDown(dotId, engine, now),
  );
  return preferred ? [preferred, ...ready, ...cooling] : [...ready, ...cooling];
}

export function searchEngineUrl(
  engine: BrowserSearchEngine,
  query: string,
): string {
  const encoded = encodeURIComponent(query.trim());
  switch (engine) {
    case 'duckduckgo':
      return `https://duckduckgo.com/?q=${encoded}`;
    case 'brave':
      return `https://search.brave.com/search?q=${encoded}`;
    case 'bing':
      return `https://www.bing.com/search?q=${encoded}`;
    case 'startpage':
      return `https://www.startpage.com/sp/search?query=${encoded}`;
    case 'google':
      return `https://www.google.com/search?q=${encoded}`;
  }
}

export function isEngineHost(
  engine: BrowserSearchEngine,
  pageUrl: string,
): boolean {
  try {
    const host = new URL(pageUrl).hostname.toLowerCase();
    return ENGINE_HOSTS[engine].some(
      (allowed) => host === allowed || host.endsWith(`.${allowed}`),
    );
  } catch {
    return false;
  }
}

const normalize = (value: string) =>
  value.replace(/\s+/g, ' ').trim().toLowerCase();

const clip = (value: string, max: number) =>
  value.replace(/\s+/g, ' ').trim().slice(0, max);

const REJECT_CONSENT =
  /^(reject all|reject all cookies|reject|decline|decline all|only necessary|necessary only|use necessary cookies only|essential only|essential cookies only|do not accept|refuse all|alle ablehnen|tout refuser|rechazar todo)$/i;

const ACCEPT_CONSENT =
  /^(accept all|accept all cookies|accept cookies|accept|allow all|allow all cookies|i agree|agree|got it|alle akzeptieren|tout accepter|aceptar todo)$/i;

const NEVER_AUTO_CLICK =
  /human|robot|verify|captcha|challenge|sign in|log in|login|subscribe|buy|pay|delete/i;

/**
 * Finds a cookie or consent button on the search engine's own page, preferring "Reject all"
 * or "Only necessary" over "Accept all", and never touching human verification controls.
 */
export function findConsentButton(
  engine: BrowserSearchEngine,
  snapshot: { url: string; elements: readonly SearchSnapshotElement[] },
): SearchSnapshotElement | undefined {
  if (!isEngineHost(engine, snapshot.url)) return undefined;
  const candidates = snapshot.elements.filter(
    (element) =>
      (element.role === 'button' || element.role === 'link') &&
      !element.disabled &&
      element.name.trim() &&
      !NEVER_AUTO_CLICK.test(element.name),
  );
  return (
    candidates.find((element) =>
      REJECT_CONSENT.test(normalize(element.name)),
    ) ??
    candidates.find((element) => ACCEPT_CONSENT.test(normalize(element.name)))
  );
}

const ENGINE_BLOCK_PATTERNS: Record<BrowserSearchEngine, RegExp> = {
  duckduckgo:
    /unfortunately,\s*bots use duckduckgo|confirm this search was made by a human|select all squares containing a duck|anomaly-modal|anomaly\.js/i,
  brave:
    /too many requests|verify you are human|automated queries|rate limit exceeded|pow captcha/i,
  bing: /verify you are a human|solve the challenge below|one more step[\s\S]{0,80}human/i,
  startpage:
    /sorry, we have detected unusual traffic|blocked your ip|automated requests/i,
  google:
    /unusual traffic from your computer network|systems have detected unusual traffic|about this page[\s\S]{0,120}automated requests/i,
};

const GENERIC_BLOCK_PATTERN =
  /verify you are (a )?human|i'?m not a robot|complete the (security check|captcha)|unusual traffic from your computer|confirm this search was made by a human|select all (images|squares)/i;

/**
 * Detects a bot check or rate-limit page on a search engine when the container itself did not
 * already attach a widget `challenge`.
 */
export function detectSearchBlock(
  engine: BrowserSearchEngine,
  snapshot: {
    url: string;
    title: string;
    elements: readonly SearchSnapshotElement[];
  },
  text: string,
): string | undefined {
  const combined = [
    snapshot.title,
    text,
    ...snapshot.elements.map((element) => element.name),
  ].join('\n');
  const googleSorry =
    engine === 'google' && /\/sorry(\/|$|\?)/i.test(snapshot.url);
  if (
    googleSorry ||
    ENGINE_BLOCK_PATTERNS[engine].test(combined) ||
    GENERIC_BLOCK_PATTERN.test(combined)
  )
    return `${ENGINE_LABELS[engine]} is asking for a human verification check in the browser.`;
  return undefined;
}

function isBlockedResultHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.startsWith('[') ||
    !host.includes('.')
  )
    return true;
  return BLOCKED_RESULT_HOSTS.some(
    (blocked) => host === blocked || host.endsWith(`.${blocked}`),
  );
}

function unwrapSearchRedirect(raw: string): string {
  try {
    const parsed = new URL(raw, 'https://duckduckgo.com');
    if (
      (parsed.hostname === 'duckduckgo.com' ||
        parsed.hostname.endsWith('.duckduckgo.com')) &&
      parsed.pathname === '/l/'
    ) {
      const target = parsed.searchParams.get('uddg');
      if (target) return target;
    }
  } catch {
    // Not a wrapped redirect.
  }
  return raw;
}

function validateResultUrl(candidate: string): string | undefined {
  try {
    const parsed = new URL(unwrapSearchRedirect(candidate));
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      isBlockedResultHost(parsed.hostname)
    )
      return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

const DOMAIN_HEAD =
  /^(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?:\/[^\s›>]*)?$/i;
const PATH_SEGMENT = /^[A-Za-z0-9._~:@!$&'()*+,;=%-]+$/;

/**
 * Turns a visible address or breadcrumb (such as `https://example.org/docs`,
 * `www.example.org/docs` or `example.org › docs › setup`) into a safe `http(s)` URL.
 * Truncated addresses (`…` or `...`) are refused so a broken address is never guessed.
 */
export function parseDisplayUrl(raw: string): string | undefined {
  const trimmed = raw
    .trim()
    .replace(/^[·|—–\-(\s]+|[·|—–\-)\s]+$/g, '')
    .trim();
  if (!trimmed || trimmed.includes('…') || trimmed.includes('...'))
    return undefined;
  if (/^\/\/duckduckgo\.com\/l\/\?/i.test(trimmed))
    return validateResultUrl(`https:${trimmed}`);

  if (trimmed.includes('›') || /\s>\s/.test(trimmed)) {
    const parts = trimmed
      .split(/\s*(?:›|>)\s*/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length < 2) return undefined;
    const [head, ...rest] = parts;
    if (!DOMAIN_HEAD.test(head)) return undefined;
    if (!rest.every((segment) => PATH_SEGMENT.test(segment))) return undefined;
    const withScheme = /^https?:\/\//i.test(head) ? head : `https://${head}`;
    return validateResultUrl(
      `${withScheme.replace(/\/+$/, '')}/${rest.join('/')}`,
    );
  }

  if (/\s/.test(trimmed)) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return validateResultUrl(trimmed);
  if (DOMAIN_HEAD.test(trimmed)) return validateResultUrl(`https://${trimmed}`);
  return undefined;
}

function isTruncatedDisplayUrl(raw: string): boolean {
  const trimmed = raw
    .trim()
    .replace(/^[·|—–\-(\s]+|[·|—–\-)\s]+$/g, '')
    .trim();
  if (!trimmed || (!trimmed.includes('…') && !trimmed.includes('...')))
    return false;
  if (trimmed.includes('›') || /\s>\s/.test(trimmed)) {
    const parts = trimmed
      .split(/\s*(?:›|>)\s*/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length < 2) return false;
    const head = parts[0].replace(/(?:…|\.\.\.)+$/, '');
    return DOMAIN_HEAD.test(head);
  }
  if (/\s/.test(trimmed)) return false;
  const withoutEllipsis = trimmed.replace(/(?:…|\.\.\.)/g, 'x');
  return (
    /^https?:\/\//i.test(withoutEllipsis) || DOMAIN_HEAD.test(withoutEllipsis)
  );
}

/**
 * Splits a compound link name when the browser merged a result's title and its visible
 * address into a single accessible name (for example on Google or Brave).
 */
function splitCompoundLink(
  name: string,
): { title: string; url: string; truncatedUrl?: boolean } | undefined {
  const flat = name.replace(/\s+/g, ' ').trim();
  // Trailing http(s) URL after title text.
  const trailingHttp = /^(.*\S)\s+(https?:\/\/\S+)$/i.exec(flat);
  if (trailingHttp) {
    const url = parseDisplayUrl(trailingHttp[2]);
    const truncated = !url && isTruncatedDisplayUrl(trailingHttp[2]);
    const title = trailingHttp[1].replace(/[·|—–-]+$/, '').trim();
    if (
      (url || truncated) &&
      title &&
      !parseDisplayUrl(title) &&
      !isTruncatedDisplayUrl(title)
    )
      return {
        title,
        url: url ?? '',
        ...(truncated ? { truncatedUrl: true } : {}),
      };
  }
  // Leading http(s) URL before title text.
  const leadingHttp = /^(https?:\/\/\S+)\s+(\S.*)$/i.exec(flat);
  if (leadingHttp) {
    const url = parseDisplayUrl(leadingHttp[1]);
    const truncated = !url && isTruncatedDisplayUrl(leadingHttp[1]);
    const title = leadingHttp[2].replace(/^[·|—–-]+/, '').trim();
    if (
      (url || truncated) &&
      title &&
      !parseDisplayUrl(title) &&
      !isTruncatedDisplayUrl(title)
    )
      return {
        title,
        url: url ?? '',
        ...(truncated ? { truncatedUrl: true } : {}),
      };
  }
  // Trailing breadcrumb URL (e.g. `Title https://example.org › docs` or `Title example.org › ... › docs`).
  const trailingBreadcrumb =
    /^(.*\S)\s+((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,24}(?:\s*›\s*(?:[A-Za-z0-9._~:@!$&'()*+,;=%-]+|…))+)$/i.exec(
      flat,
    );
  if (trailingBreadcrumb) {
    const url = parseDisplayUrl(trailingBreadcrumb[2]);
    const truncated = !url && isTruncatedDisplayUrl(trailingBreadcrumb[2]);
    const title = trailingBreadcrumb[1].replace(/[·|—–-]+$/, '').trim();
    if (
      (url || truncated) &&
      title &&
      !parseDisplayUrl(title) &&
      !isTruncatedDisplayUrl(title)
    )
      return {
        title,
        url: url ?? '',
        ...(truncated ? { truncatedUrl: true } : {}),
      };
  }
  // Leading breadcrumb URL (e.g. `github.com › owner › repo Title of the page`).
  const leadingBreadcrumb =
    /^((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,24}(?:\s*›\s*(?:[A-Za-z0-9._~:@!$&'()*+,;=%-]+|…))+)\s+(\S.*)$/i.exec(
      flat,
    );
  if (leadingBreadcrumb) {
    const url = parseDisplayUrl(leadingBreadcrumb[1]);
    const truncated = !url && isTruncatedDisplayUrl(leadingBreadcrumb[1]);
    const title = leadingBreadcrumb[2].replace(/^[·|—–-]+/, '').trim();
    if (
      (url || truncated) &&
      title &&
      !parseDisplayUrl(title) &&
      !isTruncatedDisplayUrl(title)
    )
      return {
        title,
        url: url ?? '',
        ...(truncated ? { truncatedUrl: true } : {}),
      };
  }
  return undefined;
}

const NOISE_LINK_NAMES =
  /^(skip to (main )?content|accessibility help|all|web|images|videos|news|maps|shopping|books|flights|finance|more|tools|search tools|settings|quick settings|privacy|privacy policy|terms|terms of service|feedback|send feedback|help|about|sign in|log in|duckduckgo|brave|brave search|bing|microsoft bing|startpage|google|next|next page|previous|previous page|more results|all regions|any time|past hour|past 24 hours|past week|past month|past year|safesearch|copilot|chat|ai|summarizer|anonymous view|visit in anonymous view)$/i;

const AD_LABEL = /^(ad|ads|sponsored|anzeige|gesponsert|annonces?)$/i;

function isNoiseName(name: string): boolean {
  const clean = name.replace(/\s+/g, ' ').trim();
  if (!clean || clean.length <= 1) return true;
  if (NOISE_LINK_NAMES.test(clean)) return true;
  if (/^(page \d+|\d+)$/i.test(clean)) return true;
  return false;
}

function isAdMarker(text: string): boolean {
  const clean = text.replace(/\s+/g, ' ').trim();
  return (
    AD_LABEL.test(clean) ||
    /^(ad|sponsored)\s*[·•—–-]/i.test(clean) ||
    /[·•—–-]\s*(ad|sponsored)$/i.test(clean)
  );
}

function cleanLines(text: string, pageTitle: string): string[] {
  const titleNorm = normalize(pageTitle);
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(
      (line) =>
        line.length > 0 && !isNoiseName(line) && normalize(line) !== titleNorm,
    );
}

/**
 * Finds the URL and snippet associated with `title` in the visible page text.
 */
function matchInText(
  title: string,
  lines: readonly string[],
  knownUrl: string | undefined,
  otherTitles: ReadonlySet<string>,
): { url?: string; snippet: string; ad?: boolean; truncatedUrl?: boolean } {
  const target = normalize(title);
  if (!target) return { url: knownUrl, snippet: '' };
  const idx = lines.findIndex((line) => {
    const norm = normalize(line);
    return norm === target || (target.length >= 12 && norm.includes(target));
  });
  if (idx === -1) return { url: knownUrl, snippet: '' };

  if (idx > 0 && isAdMarker(lines[idx - 1]))
    return { url: knownUrl, snippet: '', ad: true };
  if (idx > 1 && isAdMarker(lines[idx - 2]))
    return { url: knownUrl, snippet: '', ad: true };

  let url = knownUrl || undefined;
  let truncatedUrl = false;
  let snippetStart = idx + 1;
  if (!url && idx > 0) {
    const before = parseDisplayUrl(lines[idx - 1]);
    if (before) url = before;
    else if (isTruncatedDisplayUrl(lines[idx - 1])) truncatedUrl = true;
  }
  if (idx + 1 < lines.length) {
    const after = parseDisplayUrl(lines[idx + 1]);
    if (after) {
      url ??= after;
      snippetStart = idx + 2;
    } else if (isTruncatedDisplayUrl(lines[idx + 1])) {
      truncatedUrl = true;
      snippetStart = idx + 2;
    }
  }

  const snippetParts: string[] = [];
  for (
    let cursor = snippetStart;
    cursor < lines.length && snippetParts.length < 2;
    cursor++
  ) {
    const line = lines[cursor];
    if (isAdMarker(line)) break;
    if (parseDisplayUrl(line) || isTruncatedDisplayUrl(line)) break;
    if (otherTitles.has(normalize(line))) break;
    snippetParts.push(line);
  }
  return {
    url,
    snippet: clip(snippetParts.join(' '), SNIPPET_LIMIT),
    ...(truncatedUrl ? { truncatedUrl: true } : {}),
  };
}

/**
 * Extracts structured organic search results from a browser snapshot and page text.
 */
export function parseBrowserSearchResults(
  input: SearchPageInput,
  limit = 8,
): BrowserSearchResult[] {
  const results: BrowserSearchResult[] = [];
  const seenUrls = new Set<string>();
  const lines = cleanLines(input.text, input.title);
  const links = input.elements.filter(
    (element) =>
      element.role === 'link' &&
      !element.disabled &&
      element.name.trim().length > 0 &&
      !isNoiseName(element.name),
  );

  const linkUrls = links.map((link) => parseDisplayUrl(link.name));
  const compoundLinks = links.map((link) => splitCompoundLink(link.name));
  const isSnippetLink = (index: number): boolean => {
    if (index < 2) return false;
    // Preceded by [Title, URL] and not followed by its own URL link.
    return Boolean(
      !linkUrls[index - 2] &&
      !compoundLinks[index - 2] &&
      linkUrls[index - 1] &&
      !linkUrls[index] &&
      !compoundLinks[index] &&
      !linkUrls[index + 1] &&
      !isAdMarker(links[index].name),
    );
  };
  const candidateTitles = new Set<string>();
  for (let i = 0; i < links.length; i++) {
    if (compoundLinks[i])
      candidateTitles.add(normalize(compoundLinks[i]!.title));
    else if (!linkUrls[i] && !isSnippetLink(i))
      candidateTitles.add(normalize(links[i].name));
  }

  const pushResult = (
    title: string,
    url: string | undefined,
    snippet: string,
    ref?: string,
    allowEmptyUrl = false,
  ) => {
    const cleanUrl = url ?? '';
    if (!cleanUrl && (!allowEmptyUrl || !ref)) return false;
    const dedupeKey = cleanUrl || `ref:${ref}`;
    if (seenUrls.has(dedupeKey)) return false;
    const cleanTitle = clip(title, TITLE_LIMIT) || cleanUrl;
    if (!cleanTitle || isAdMarker(cleanTitle)) return false;
    seenUrls.add(dedupeKey);
    results.push({
      title: cleanTitle,
      url: cleanUrl,
      snippet: clip(snippet, SNIPPET_LIMIT),
      ...(ref ? { ref } : {}),
    });
    return true;
  };

  let skipNextAsAd = false;
  for (let i = 0; i < links.length && results.length < limit; i++) {
    const current = links[i];
    if (isAdMarker(current.name)) {
      skipNextAsAd = true;
      continue;
    }
    if (skipNextAsAd) {
      skipNextAsAd = false;
      if (linkUrls[i + 1]) i += 1;
      continue;
    }

    // 1. Compound link containing both title and visible URL/breadcrumb.
    const compound = compoundLinks[i];
    if (compound) {
      const fromText = matchInText(
        compound.title,
        lines,
        compound.url || undefined,
        candidateTitles,
      );
      if (!fromText.ad)
        pushResult(
          compound.title,
          fromText.url ?? compound.url,
          fromText.snippet,
          current.ref,
          Boolean(compound.truncatedUrl || fromText.truncatedUrl),
        );
      continue;
    }

    // 2. URL link followed by a title link (e.g. Startpage, modern DuckDuckGo, Brave).
    const currentUrl = linkUrls[i];
    if (currentUrl) {
      const next = links[i + 1];
      if (
        next &&
        !linkUrls[i + 1] &&
        !compoundLinks[i + 1] &&
        !isAdMarker(next.name)
      ) {
        const fromText = matchInText(
          next.name,
          lines,
          currentUrl,
          candidateTitles,
        );
        if (!fromText.ad)
          pushResult(next.name, currentUrl, fromText.snippet, next.ref);
        i += 1;
      }
      continue;
    }

    // 3. Title link followed by a URL link (e.g. DuckDuckGo HTML, where snippet may also be a 3rd link).
    const nextUrl = linkUrls[i + 1];
    if (nextUrl) {
      const fromText = matchInText(
        current.name,
        lines,
        nextUrl,
        candidateTitles,
      );
      if (fromText.ad) {
        i += isSnippetLink(i + 2) ? 2 : 1;
        continue;
      }
      let snippet = fromText.snippet;
      if (isSnippetLink(i + 2)) {
        snippet = links[i + 2].name;
        i += 2;
      } else {
        i += 1;
      }
      pushResult(current.name, nextUrl, snippet, current.ref);
      continue;
    }

    // 4. Title link whose URL and snippet sit next to it in the visible page text (e.g. Bing, Google).
    const fromText = matchInText(
      current.name,
      lines,
      undefined,
      candidateTitles,
    );
    if (!fromText.ad && (fromText.url || fromText.truncatedUrl))
      pushResult(
        current.name,
        fromText.url,
        fromText.snippet,
        current.ref,
        Boolean(fromText.truncatedUrl),
      );
  }

  // 5. Fallback to visible text blocks when the snapshot had no usable result links.
  if (results.length === 0) {
    for (let i = 0; i < lines.length && results.length < limit; i++) {
      const url = parseDisplayUrl(lines[i]);
      if (!url || seenUrls.has(url)) continue;
      if (
        (i > 0 && isAdMarker(lines[i - 1])) ||
        (i > 1 && isAdMarker(lines[i - 2]))
      )
        continue;
      const prevLine =
        i > 0 && !parseDisplayUrl(lines[i - 1]) ? lines[i - 1] : '';
      const nextLine =
        i + 1 < lines.length && !parseDisplayUrl(lines[i + 1])
          ? lines[i + 1]
          : '';
      const title = prevLine && prevLine.length <= 140 ? prevLine : nextLine;
      if (!title || isAdMarker(title)) continue;
      const snippetLine =
        title === prevLine
          ? nextLine
          : lines[i + 2] && !parseDisplayUrl(lines[i + 2])
            ? lines[i + 2]
            : '';
      pushResult(title, url, snippetLine);
    }
  }

  return results;
}
