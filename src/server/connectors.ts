import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { connectorValueView } from '../shared/connector-config.js';
import type {
  Connector,
  ConnectorStatus,
  ConnectorToolInfo,
  ConnectorValue,
  ConnectorView,
} from '../shared/types.js';
import { withoutBinary } from './computer-agent.js';
import type { ConnectorStore } from './connector-store.js';
import { mcpToolName } from './mcp-tools.js';

export interface ResolvedConnectorValues {
  headers: Record<string, string>;
  /** stdio only: the resolved connector env plus the few process variables a child needs to start. */
  env: Record<string, string>;
}

export interface ConnectorRegistryOptions {
  env?: Record<string, string | undefined>; // default process.env
  allowStdio: boolean;
  resultMaxChars: number;
  /** Test seam: build the MCP transport for a connector (default: StreamableHTTP / Stdio by transport). */
  transport?: (
    connector: Connector,
    resolved: ResolvedConnectorValues,
  ) => Transport;
  listTtlMs?: number; // default 60_000
  log?: (line: string) => void;
}

export interface McpCallOutcome {
  connector: string;
  tool: string;
  untrusted: true;
  content: string;
  isError?: true;
  truncated?: true;
}

const BACKOFF_SECONDS = [1, 2, 5, 15, 60];
const INHERITED_ENV = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
];
const MAX_LIST_PAGES = 100;
const MIN_SECRET_LENGTH = 8;
const STDIO_OFF = 'stdio connectors are off on this server.';
const MAX_TOOL_NAME = 64;
const HASH_CHARS = 6;

/**
 * `name` unless another tool of the connector already took it (`get.issue` and `get_issue` both sanitize
 * to `get_issue`); then `_` plus six hex characters of the SHA-256 of the raw tool name, within 64 characters.
 */
function uniqueToolName(
  name: string,
  rawName: string,
  taken: Set<string>,
): string {
  if (!taken.has(name)) return name;
  for (let attempt = 0; ; attempt++) {
    const hash = createHash('sha256')
      .update(attempt ? `${rawName}\0${attempt}` : rawName)
      .digest('hex')
      .slice(0, HASH_CHARS);
    const room = MAX_TOOL_NAME - HASH_CHARS - 1;
    const candidate = `${name.slice(0, room)}_${hash}`;
    if (!taken.has(candidate)) return candidate;
  }
}

interface Cache {
  tools: ConnectorToolInfo[];
  at: number;
}

/** Per-connector runtime state. An entry that was reset (`invalidate`, `reload`) is `dead` and ignored. */
interface Entry {
  status: ConnectorStatus;
  client?: Client;
  cache?: Cache;
  connecting?: Promise<void>;
  refreshing?: Promise<void>;
  timer?: NodeJS.Timeout;
  attempt: number;
  dead: boolean;
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class ConnectorRegistry {
  private entries = new Map<string, Entry>();
  private started = false;
  private stopped = false;
  private ttlMs: number;

  constructor(
    private store: ConnectorStore,
    private options: ConnectorRegistryOptions,
  ) {
    this.ttlMs = options.listTtlMs ?? 60_000;
  }

  private get env(): Record<string, string | undefined> {
    return this.options.env ?? process.env;
  }

  /** Schedules a connect for every enabled connector and returns immediately. */
  async start(): Promise<void> {
    this.started = true;
    this.stopped = false;
    for (const connector of this.store.list())
      if (connector.enabled) this.connectInBackground(connector.id);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    const closing: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      entry.dead = true;
      this.clearTimer(entry);
      closing.push(this.dropClient(entry));
    }
    this.entries.clear();
    await Promise.all(closing);
  }

  views(): ConnectorView[] {
    return this.store.list().map((connector) => this.toView(connector));
  }

  view(id: string): ConnectorView | undefined {
    const connector = this.store.get(id);
    return connector ? this.toView(connector) : undefined;
  }

  /** Connects if needed, refreshes the tool list when its TTL has expired, and returns the status. */
  async status(id: string): Promise<ConnectorView['status']> {
    const connector = this.store.get(id);
    if (!connector)
      return { state: 'error', error: 'Connector not found.', tools: [] };
    const entry = await this.ensure(connector);
    if (this.expired(entry) && this.statusOf(connector).state === 'connected')
      await this.refresh(connector, entry);
    return this.statusOf(connector);
  }

  /** Tools from the cache; `[]` unless the connector is connected. Refreshes a stale cache in the background. */
  toolsCached(id: string): ConnectorToolInfo[] {
    const connector = this.store.get(id);
    if (!connector || this.staticStatus(connector)) return [];
    const entry = this.entries.get(id);
    if (!entry || entry.dead || entry.status.state !== 'connected') return [];
    if (this.expired(entry)) void this.refresh(connector, entry);
    return entry.cache?.tools ?? [];
  }

  async call(
    id: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<McpCallOutcome> {
    const connector = this.store.get(id);
    const base = {
      connector: connector?.name ?? id,
      tool,
      untrusted: true as const,
    };
    const failed = (message: string): McpCallOutcome => ({
      ...base,
      isError: true,
      content: `Error: ${this.redact(message)}`,
    });
    if (!connector) return failed('Connector not found.');
    const timeout = AbortSignal.timeout(connector.callTimeoutMs);
    try {
      const entry = await this.ensure(connector);
      const client = entry.client;
      const status = this.statusOf(connector);
      if (!client || status.state !== 'connected')
        return failed(this.unavailable(connector, status));
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const result = (await client.callTool(
        {
          name: tool,
          arguments:
            args && typeof args === 'object' && !Array.isArray(args)
              ? (args as Record<string, unknown>)
              : {},
        },
        undefined,
        { signal: combined, timeout: connector.callTimeoutMs },
      )) as {
        content?: unknown;
        structuredContent?: unknown;
        isError?: boolean;
      };
      return this.outcome(base, result);
    } catch (error) {
      if (timeout.aborted || this.isTimeout(error))
        return failed(
          `The call to ${tool} timed out after ${connector.callTimeoutMs} ms.`,
        );
      if (signal?.aborted) return failed('The call was cancelled.');
      // A failure that is not an MCP error means the connection itself is suspect: reconnect in the background.
      if (!(error instanceof McpError)) this.broken(connector, error);
      return failed(messageOf(error));
    }
  }

  /** Closes the connection, reconnects and refreshes the tool list. */
  async reload(id: string): Promise<ConnectorView['status']> {
    await this.reset(id);
    return this.status(id);
  }

  /** After update or delete: closes the client and drops the cache. Reconnects in the background when started. */
  invalidate(id: string): void {
    void this.reset(id).then(() => {
      if (this.started && this.store.get(id)?.enabled)
        this.connectInBackground(id);
    });
  }

  /** Resolved values of env references (>= 8 chars), their `Bearer ` variants, and a scheme's token part. */
  secrets(): string[] {
    const found = new Set<string>();
    const add = (value: string | undefined) => {
      if (value && value.length >= MIN_SECRET_LENGTH) found.add(value);
    };
    for (const connector of this.store.list())
      for (const record of [connector.headers, connector.env])
        for (const value of Object.values(record)) {
          if (!('env' in value)) continue; // literals are not secrets
          const resolved = this.resolveValue(value);
          if (!resolved) continue;
          add(resolved);
          const space = resolved.indexOf(' ');
          if (space < 0) add(`Bearer ${resolved}`);
          else add(resolved.slice(space + 1).trim());
        }
    return [...found].sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    return this.secrets().reduce(
      (all, secret) => all.split(secret).join('[redacted]'),
      text,
    );
  }

  // --- views and status -------------------------------------------------------------------------

  private toView(connector: Connector): ConnectorView {
    const show = (record: Record<string, ConnectorValue>) =>
      Object.fromEntries(
        Object.entries(record).map(([name, value]) => [
          name,
          connectorValueView(value, this.env),
        ]),
      );
    const status = this.statusOf(connector);
    return {
      ...connector,
      headers: show(connector.headers),
      env: show(connector.env),
      status: {
        ...status,
        error:
          status.error === undefined ? undefined : this.redact(status.error),
        tools: [...status.tools],
      },
    };
  }

  private statusOf(connector: Connector): ConnectorStatus {
    const fixed = this.staticStatus(connector);
    if (fixed) return fixed;
    const entry = this.entries.get(connector.id);
    return entry && !entry.dead
      ? entry.status
      : { state: 'connecting', tools: [] };
  }

  /** States decided by the stored row and the environment alone, before any connection is tried. */
  private staticStatus(connector: Connector): ConnectorStatus | undefined {
    if (!connector.enabled) return { state: 'disabled', tools: [] };
    if (connector.transport === 'stdio' && !this.options.allowStdio)
      return { state: 'error', error: STDIO_OFF, tools: [] };
    const missing = this.missing(connector);
    if (missing.length) return { state: 'missing_env', missing, tools: [] };
    return undefined;
  }

  private unavailable(connector: Connector, status: ConnectorStatus): string {
    if (status.error) return status.error;
    if (status.state === 'missing_env')
      return `Missing environment variables: ${(status.missing ?? []).join(', ')}.`;
    return `The ${connector.name} connector is ${status.state === 'disabled' ? 'disabled' : 'not connected'}.`;
  }

  // --- values -----------------------------------------------------------------------------------

  private resolveValue(value: ConnectorValue): string | undefined {
    if ('literal' in value) return value.literal;
    return this.env[value.env]?.trim() || undefined;
  }

  private missing(connector: Connector): string[] {
    const record =
      connector.transport === 'http' ? connector.headers : connector.env;
    return [
      ...new Set(
        Object.values(record).flatMap((value) =>
          'env' in value && !this.resolveValue(value) ? [value.env] : [],
        ),
      ),
    ];
  }

  private resolve(connector: Connector): ResolvedConnectorValues {
    const resolve = (record: Record<string, ConnectorValue>) =>
      Object.fromEntries(
        Object.entries(record).flatMap(([name, value]) => {
          const resolved = this.resolveValue(value);
          return resolved === undefined ? [] : [[name, resolved]];
        }),
      );
    const headers = resolve(connector.headers);
    for (const name of Object.keys(headers))
      if (/^authorization$/i.test(name) && !/\s/.test(headers[name]))
        headers[name] = `Bearer ${headers[name]}`;
    const env: Record<string, string> = {};
    if (connector.transport === 'stdio') {
      for (const name of INHERITED_ENV) {
        const inherited = process.env[name];
        if (inherited !== undefined) env[name] = inherited;
      }
      Object.assign(env, resolve(connector.env));
    }
    return { headers, env };
  }

  private defaultTransport(
    connector: Connector,
    resolved: ResolvedConnectorValues,
  ): Transport {
    if (connector.transport === 'http') {
      if (!connector.url) throw new Error('This connector has no URL.');
      return new StreamableHTTPClientTransport(new URL(connector.url), {
        requestInit: { headers: resolved.headers },
      });
    }
    if (!connector.command) throw new Error('This connector has no command.');
    return new StdioClientTransport({
      command: connector.command,
      args: connector.args,
      cwd: connector.cwd ?? undefined,
      env: resolved.env,
      stderr: 'pipe',
    });
  }

  // --- connection lifecycle ---------------------------------------------------------------------

  private entryFor(id: string): Entry {
    let entry = this.entries.get(id);
    if (!entry || entry.dead) {
      entry = {
        status: { state: 'connecting', tools: [] },
        attempt: 0,
        dead: false,
      };
      this.entries.set(id, entry);
    }
    return entry;
  }

  /** Makes sure a connection attempt has been made for a connector that is allowed to connect. Never throws. */
  private async ensure(connector: Connector): Promise<Entry> {
    const entry = this.entryFor(connector.id);
    const fixed = this.staticStatus(connector);
    if (fixed) {
      this.clearTimer(entry);
      await this.dropClient(entry);
      entry.cache = undefined;
      entry.status = fixed;
      return entry;
    }
    if (entry.client && entry.status.state === 'connected') return entry;
    this.clearTimer(entry);
    entry.connecting ??= this.connect(connector, entry).finally(() => {
      entry.connecting = undefined;
    });
    await entry.connecting;
    return entry;
  }

  private connectInBackground(id: string) {
    const connector = this.store.get(id);
    if (connector) void this.ensure(connector).catch(() => undefined);
  }

  /** Resolves when the attempt is over; failures are recorded in the status, never thrown. */
  private async connect(connector: Connector, entry: Entry): Promise<void> {
    entry.status = { state: 'connecting', tools: [] };
    let client: Client | undefined;
    try {
      const resolved = this.resolve(connector);
      const transport = (
        this.options.transport ?? this.defaultTransport.bind(this)
      )(connector, resolved);
      this.watchStderr(connector, transport);
      client = new Client({ name: 'fulldots', version: '0.1.0' });
      const connected = client;
      connected.onclose = () => this.closed(connector, entry, connected);
      connected.onerror = (error) =>
        this.log(`connector ${connector.name}: ${messageOf(error)}`);
      await connected.connect(transport);
      const tools = await this.listAll(connected, connector);
      if (entry.dead) {
        await this.closeClient(connected);
        return;
      }
      entry.client = connected;
      if (this.reject(connector, entry, tools)) return;
      entry.attempt = 0;
      entry.cache = { tools, at: Date.now() };
      entry.status = { state: 'connected', tools, connectedAt: Date.now() };
    } catch (error) {
      if (client) await this.closeClient(client);
      if (entry.dead) return;
      entry.client = undefined;
      entry.cache = undefined;
      entry.status = {
        state: 'error',
        error: this.redact(messageOf(error)),
        tools: [],
      };
      this.log(`connector ${connector.name} failed: ${entry.status.error}`);
      this.scheduleReconnect(connector.id, entry);
    }
  }

  /** Refuses a tool list whose names clash with a connector that is already connected. */
  private reject(
    connector: Connector,
    entry: Entry,
    tools: ConnectorToolInfo[],
  ): boolean {
    const names = new Set(tools.map((tool) => tool.toolName));
    for (const other of this.store.list()) {
      if (other.id === connector.id) continue;
      const theirs = this.entries.get(other.id);
      if (!theirs || theirs.dead || theirs.status.state !== 'connected')
        continue;
      if (!theirs.cache?.tools.some((tool) => names.has(tool.toolName)))
        continue;
      void this.dropClient(entry);
      entry.cache = undefined;
      entry.status = {
        state: 'error',
        error: `Tool name collision with ${other.name}`,
        tools: [],
      };
      this.log(`connector ${connector.name}: ${entry.status.error}`);
      return true;
    }
    return false;
  }

  private async listAll(
    client: Client,
    connector: Connector,
  ): Promise<ConnectorToolInfo[]> {
    if (!client.getServerCapabilities()?.tools) return [];
    const tools: ConnectorToolInfo[] = [];
    const seen = new Set<string>();
    const rawNames = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const listed = await client.listTools(cursor ? { cursor } : undefined);
      for (const tool of listed.tools) {
        if (rawNames.has(tool.name)) continue;
        rawNames.add(tool.name);
        const toolName = uniqueToolName(
          mcpToolName(connector.name, tool.name),
          tool.name,
          seen,
        );
        seen.add(toolName);
        tools.push({
          name: tool.name,
          toolName,
          description: tool.description ?? tool.title ?? '',
          readOnly: tool.annotations?.readOnlyHint === true,
          destructive: tool.annotations?.destructiveHint === true,
          inputSchema: (tool.inputSchema as
            Record<string, unknown> | undefined) ?? {
            type: 'object',
            properties: {},
          },
        });
      }
      cursor = listed.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  private expired(entry: Entry): boolean {
    return (
      !entry.dead && !!entry.cache && Date.now() - entry.cache.at > this.ttlMs
    );
  }

  private refresh(connector: Connector, entry: Entry): Promise<void> {
    entry.refreshing ??= (async () => {
      const client = entry.client;
      if (!client || entry.dead) return;
      try {
        const tools = await this.listAll(client, connector);
        if (entry.dead || entry.client !== client) return;
        if (this.reject(connector, entry, tools)) return;
        entry.cache = { tools, at: Date.now() };
        entry.status = { ...entry.status, tools };
      } catch (error) {
        if (!entry.dead && entry.client === client)
          this.broken(connector, error);
      }
    })().finally(() => {
      entry.refreshing = undefined;
    });
    return entry.refreshing;
  }

  /** The transport reported that the connection is gone. */
  private closed(connector: Connector, entry: Entry, client: Client) {
    if (entry.dead || entry.client !== client) return;
    entry.client = undefined;
    entry.cache = undefined;
    entry.status = { state: 'error', error: 'Connection closed.', tools: [] };
    this.log(`connector ${connector.name}: connection closed`);
    this.scheduleReconnect(connector.id, entry);
  }

  /** A call or refresh failed in a way that suggests the connection is unusable. */
  private broken(connector: Connector, error: unknown) {
    const entry = this.entries.get(connector.id);
    if (!entry || entry.dead || !entry.client) return;
    void this.dropClient(entry);
    entry.cache = undefined;
    entry.status = {
      state: 'error',
      error: this.redact(messageOf(error)),
      tools: [],
    };
    this.log(`connector ${connector.name} lost: ${entry.status.error}`);
    this.scheduleReconnect(connector.id, entry);
  }

  private scheduleReconnect(id: string, entry: Entry) {
    if (this.stopped || entry.dead || entry.timer) return;
    const seconds =
      BACKOFF_SECONDS[Math.min(entry.attempt, BACKOFF_SECONDS.length - 1)];
    entry.attempt++;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.stopped || entry.dead) return;
      this.connectInBackground(id);
    }, seconds * 1000);
    entry.timer.unref();
  }

  private clearTimer(entry: Entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  /** Detaches the client first so its `onclose` is ignored, then closes it. */
  private async dropClient(entry: Entry): Promise<void> {
    const client = entry.client;
    entry.client = undefined;
    if (client) await this.closeClient(client);
  }

  private async closeClient(client: Client): Promise<void> {
    try {
      await client.close();
    } catch {
      // Already closed or never opened.
    }
  }

  private async reset(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.dead = true;
    this.clearTimer(entry);
    this.entries.delete(id);
    await this.dropClient(entry);
  }

  /** stdio servers write diagnostics to stderr; drain it so the pipe never fills, and log it redacted. */
  private watchStderr(connector: Connector, transport: Transport) {
    const stderr = (transport as { stderr?: NodeJS.ReadableStream | null })
      .stderr;
    if (!stderr || typeof stderr.on !== 'function') return;
    stderr.on('data', (chunk: Buffer | string) => {
      const text = this.redact(String(chunk)).trim().slice(0, 500);
      if (text) this.log(`connector ${connector.name} stderr: ${text}`);
    });
  }

  private log(line: string) {
    this.options.log?.(this.redact(line));
  }

  // --- results ----------------------------------------------------------------------------------

  private isTimeout(error: unknown) {
    return error instanceof McpError && error.code === ErrorCode.RequestTimeout;
  }

  private outcome(
    base: Pick<McpCallOutcome, 'connector' | 'tool' | 'untrusted'>,
    result: {
      content?: unknown;
      structuredContent?: unknown;
      isError?: boolean;
    },
  ): McpCallOutcome {
    const texts: string[] = [];
    const parts = Array.isArray(result.content) ? result.content : [];
    for (const part of parts as Record<string, unknown>[]) {
      if (part?.type === 'text') texts.push(String(part.text ?? ''));
      else if (part?.type === 'image') texts.push('[image omitted]');
      else if (part?.type === 'audio') texts.push('[audio omitted]');
      else {
        const resource = part?.resource as { text?: unknown } | undefined;
        texts.push(
          typeof resource?.text === 'string'
            ? resource.text
            : '[resource omitted]',
        );
      }
    }
    if (result.structuredContent !== undefined) {
      const json = JSON.stringify(result.structuredContent);
      const duplicated = texts.some((text) => {
        try {
          return JSON.stringify(JSON.parse(text)) === json;
        } catch {
          return text.includes(json);
        }
      });
      if (!duplicated) texts.push(json);
    }
    const clean = this.redact(String(withoutBinary(texts.join('\n'))));
    const max = this.options.resultMaxChars;
    const truncated = clean.length > max;
    return {
      ...base,
      content: truncated
        ? `${clean.slice(0, max)}… [truncated: ${clean.length - max} more characters]`
        : clean,
      ...(result.isError === true ? { isError: true as const } : {}),
      ...(truncated ? { truncated: true as const } : {}),
    };
  }
}
