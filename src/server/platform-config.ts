import type { WebConfig } from './web-search.js';
import type { Limits } from './limits.js';
import type { SetupStatus } from '../shared/types.js';
export interface PlatformConfig extends WebConfig {
  model?: string;
  apiKey?: string;
  baseUrl: string;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  voiceKey?: string;
  voiceModel?: string;
  voiceName: string;
  ownerToken?: string;
  limits?: Limits;
  /** CONNECTORS_ALLOW_STDIO=true lets connectors start programs on this host. */
  connectorsAllowStdio?: boolean;
  /** CONNECTORS_REGISTRY_SEARCH=true lets Settings > Connectors search the public MCP registry. */
  connectorsRegistrySearch?: boolean;
  /** CONNECTOR_RESULT_MAX_CHARS, default 20_000. */
  connectorResultMaxChars?: number;
  /** APPROVAL_TTL in seconds, converted to ms; default 7 days. */
  approvalTtlMs?: number;
  /** NOTIFY_WEBHOOK_URL: notification-only webhook for approvals and handoffs. */
  notifyWebhookUrl?: string;
  /** BACKGROUND_CONCURRENCY, default 4: background tasks running at once. */
  backgroundConcurrency?: number;
  /** DOT_DAILY_TOKEN_WARN, default 2,000,000: warn once a Dot passes this many tokens in a day. */
  dailyTokenWarn?: number;
  /** TEAM_MAX_DEPTH, default 2: how many hand-offs between Dots may chain. */
  teamMaxDepth?: number;
  /** TEAM_RESULT_BATCH_MS, default 1500: how long one turn's hand-off results wait for each other. */
  teamResultBatchMs?: number;
  /** TEAM_RELAY_MAX, default 4: consecutive Dot turns in a group chat without an owner message. */
  teamRelayMax?: number;
  /** Where the app is opened (APP_ORIGIN, else the server address); makes notification links absolute. */
  publicOrigin?: string;
  /** COMPOSIO_API_KEY. Absent means connected apps are not offered. */
  composioApiKey?: string;
  /** Hosts from AGENT_ENDPOINT_ALLOWED_HOSTS. Exact host or host:port. */
  agentEndpointAllowedHosts?: ReadonlySet<string>;
  /** Test seam. Production uses the platform fetch. */
  agentFetch?: (url: string, init?: RequestInit) => Promise<Response>;
}
/**
 * `modelReady` and `defaultModel` come from the model provider registry (a usable `.env` or stored
 * default). Without them the legacy `.env`-only check is used.
 */
export function setupStatus(
  config: PlatformConfig,
  modelReady?: boolean,
  defaultModel?: string,
): SetupStatus {
  const missing =
    modelReady === undefined
      ? [
          !config.apiKey && 'OPENAI_API_KEY',
          !config.model && 'OPENAI_MODEL',
        ].filter((item): item is string => !!item)
      : modelReady
        ? []
        : ['model provider'];
  return {
    model: !missing.length,
    browser: !!(config.browserUrl && config.browserSecret),
    search: (config.webSearchProvider ?? 'duckduckgo') !== 'disabled',
    voice: !!(config.voiceKey && config.voiceModel && !missing.length),
    composio: !!config.composioApiKey,
    missing,
    defaultModel: modelReady === undefined ? config.model : defaultModel,
  };
}
