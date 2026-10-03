import type { WebConfig } from './web-search.js';
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
  };
}
