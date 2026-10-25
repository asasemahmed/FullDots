/*
 * Read-only search of the public MCP registry. Source: mcp-registry/docs/reference/api
 * (official-registry-api.md, openapi.yaml, generic-registry-api.md).
 *
 * Base URL: https://registry.modelcontextprotocol.io (the staging host is not used).
 * List: GET /v0.1/servers with these query parameters:
 *   search   case-insensitive substring of the server NAME only, not its description
 *   version  "latest" returns the latest version of each server, so no server repeats
 *   limit    integer page size
 *   cursor   opaque; take it from metadata.nextCursor and send it back unchanged
 * Response: { servers: [{ server: ServerDetail, _meta }], metadata: { nextCursor, count } }
 * ServerDetail: name, description, version and title (optional), repository { url, source },
 *   remotes [{ type: "streamable-http" | "sse", url }],
 *   packages [{ registryType, identifier, version, transport: { type: "stdio" | ... } }].
 * Everything else (websiteUrl, icons, _meta, ...) is dropped here.
 */
import { z } from 'zod';
import type {
  RegistrySearchResult,
  RegistryServer,
} from '../shared/registry.js';

const REGISTRY_ORIGIN = 'https://registry.modelcontextprotocol.io';
const PAGE_SIZE = 20;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1024 * 1024;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 200;

/** A registry failure the owner can read. The route shows it as a 502. */
export class RegistryError extends Error {}

const serverSchema = z.object({
  name: z.string().min(1).max(200),
  title: z.string().max(200).nullish(),
  description: z.string().max(2000),
  version: z.string().min(1).max(255),
  // Live entries can carry an empty repository object, so its URL is optional here.
  repository: z.object({ url: z.string().max(2048).nullish() }).nullish(),
  remotes: z
    .array(z.object({ type: z.string().max(40), url: z.string().max(2048) }))
    .max(50)
    .nullish(),
  packages: z
    .array(
      z.object({
        registryType: z.string().max(40),
        transport: z.object({ type: z.string().max(40) }),
      }),
    )
    .max(50)
    .nullish(),
});

const responseSchema = z.object({
  servers: z.array(z.object({ server: serverSchema })),
  metadata: z.object({ nextCursor: z.string().max(1000).nullish() }).nullish(),
});

type ServerEntry = z.infer<typeof serverSchema>;

function httpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function normalise(entry: ServerEntry): RegistryServer {
  const repository = entry.repository?.url
    ? httpUrl(entry.repository.url)
    : undefined;
  return {
    name: entry.name,
    ...(entry.title ? { title: entry.title } : {}),
    description: entry.description,
    version: entry.version,
    ...(repository ? { repository: { url: repository } } : {}),
    remotes: (entry.remotes ?? []).map((remote) => ({
      type: remote.type,
      url: remote.url,
    })),
    packages: (entry.packages ?? []).map((item) => ({
      registryType: item.registryType,
      transport: item.transport.type,
    })),
  };
}

const isTimeout = (error: unknown) =>
  error instanceof Error &&
  (error.name === 'TimeoutError' || error.name === 'AbortError');

const tooLarge = () =>
  new RegistryError('The MCP registry sent an answer that is too large.');

async function fetchJson(url: URL): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      // Only the registry is asked. A redirect is refused rather than followed.
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new RegistryError(
      isTimeout(error)
        ? 'The MCP registry did not answer in time.'
        : 'The MCP registry could not be reached.',
    );
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new RegistryError(
      'The MCP registry tried to redirect, which is refused.',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new RegistryError(
      `The MCP registry answered with status ${response.status}.`,
    );
  }
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > MAX_BYTES) throw tooLarge();

  const reader = response.body?.getReader();
  if (!reader)
    throw new RegistryError('The MCP registry sent an empty answer.');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError(
      isTimeout(error)
        ? 'The MCP registry did not answer in time.'
        : 'The MCP registry could not be reached.',
    );
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new RegistryError(
      'The MCP registry sent an answer FullDots could not read.',
    );
  }
}

const cache = new Map<string, { at: number; result: RegistrySearchResult }>();

function remember(key: string, result: RegistrySearchResult, at: number) {
  cache.delete(key);
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at, result });
}

/** Forget every cached search. Tests use it; the server never needs it. */
export function clearRegistryCache() {
  cache.clear();
}

/**
 * Search the public registry by server name. Results are cached for 24 hours per
 * query and cursor. Throws RegistryError when the registry cannot give a usable answer.
 */
export async function searchRegistry(
  query: string,
  cursor?: string,
): Promise<RegistrySearchResult> {
  const key = `${query}\n${cursor ?? ''}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.result;
  if (hit) cache.delete(key);

  const url = new URL('/v0.1/servers', REGISTRY_ORIGIN);
  url.searchParams.set('search', query);
  url.searchParams.set('version', 'latest');
  url.searchParams.set('limit', String(PAGE_SIZE));
  if (cursor) url.searchParams.set('cursor', cursor);

  const parsed = responseSchema.safeParse(await fetchJson(url));
  if (!parsed.success)
    throw new RegistryError(
      'The MCP registry sent an answer FullDots could not read.',
    );
  const result: RegistrySearchResult = {
    servers: parsed.data.servers.map((item) => normalise(item.server)),
  };
  const next = parsed.data.metadata?.nextCursor;
  if (next) result.nextCursor = next;
  remember(key, result, now);
  return result;
}
