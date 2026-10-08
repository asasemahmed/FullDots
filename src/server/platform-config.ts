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
  /** CONNECTOR_RESULT_MAX_CHARS, default 20_000. */
  connectorResultMaxChars?: number;
  /** APPROVAL_TTL in seconds, converted to ms; default 7 days. */
  approvalTtlMs?: number;
  /** NOTIFY_WEBHOOK_URL: notification-only webhook for approvals and handoffs. */
  notifyWebhookUrl?: string;
  /** Where the app is opened (APP_ORIGIN, else the server address); makes notification links absolute. */
  publicOrigin?: string;
}
export function setupStatus(config: PlatformConfig): SetupStatus {
  const missing = [
    !config.apiKey && 'OPENAI_API_KEY',
    !config.model && 'OPENAI_MODEL',
  ].filter((item): item is string => !!item);
  return {
    model: !!(config.apiKey && config.model),
    browser: !!(config.browserUrl && config.browserSecret),
    search: (config.webSearchProvider ?? 'duckduckgo') !== 'disabled',
    voice: !!(config.voiceKey && config.voiceModel && !missing.length),
    missing,
    defaultModel: config.model,
  };
}
