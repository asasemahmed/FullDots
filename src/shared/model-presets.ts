// Model providers FullDots can talk to. Every preset is reached through its OpenAI-compatible
// chat-completions endpoint; the fields below describe each provider's differences.
// Facts verified against official docs on 2026-10-09 (see MODEL-PROVIDERS-PLAN.md section 1).

export type ModelPresetId =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openrouter'
  | 'groq'
  | 'mistral'
  | 'deepseek'
  | 'xai'
  | 'together'
  | 'fireworks'
  | 'cerebras'
  | 'ollama'
  | 'lmstudio'
  | 'custom';

export interface ModelPreset {
  id: ModelPresetId;
  name: string;
  /** One short line for the gallery card. */
  description: string;
  docsUrl: string;
  /** Where to create an API key. */
  keysUrl?: string;
  /** Undefined for custom: the owner enters it. */
  baseUrl?: string;
  /** Runs on this computer: http on loopback allowed, key optional. */
  local?: boolean;
  keyOptional?: boolean;
  /** Observed key prefixes; the UI only warns, it never rejects. */
  keyHint?: { prefix: string[]; label: string };
  maxTokensKey: 'max_tokens' | 'max_completion_tokens';
  models: {
    path: string;
    shape: 'openai' | 'array' | 'gemini';
    auth: 'bearer' | 'x-api-key';
    headers?: Record<string, string>;
  };
  /** Top-level request fields the provider rejects (removed before sending). */
  dropFields?: string[];
  defaultHeaders?: Record<string, string>;
  extraFields?: { id: 'anthropicWorkspaceId'; label: string; header: string }[];
}

/** The model a Dot uses: a plain model id plus the provider that serves it (null = default). */
export interface ModelRef {
  providerId: string | null;
  model: string;
}

export type ModelProviderKeyKind = 'stored' | 'env' | 'none';

/** What the API returns about a provider. The key itself never leaves the server. */
export interface ModelProviderView {
  id: string;
  presetId: ModelPresetId;
  name: string;
  baseUrl: string;
  key: {
    kind: ModelProviderKeyKind;
    set: boolean;
    /** Last four characters of a stored key, for recognition only. */
    last4?: string;
    envName?: string;
  };
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastTestedAt: number | null;
  lastError: string | null;
  /** The provider configured in .env (OPENAI_API_KEY/OPENAI_BASE_URL): read-only in the UI. */
  builtIn: boolean;
}

export interface ModelInfo {
  id: string;
  name?: string;
  tools?: boolean;
  contextLength?: number;
}

const openaiList = {
  path: '/models',
  shape: 'openai',
  auth: 'bearer',
} as const;

export const modelPresets: ModelPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT models from OpenAI.',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    keysUrl: 'https://platform.openai.com/api-keys',
    baseUrl: 'https://api.openai.com/v1',
    keyHint: {
      prefix: ['sk-', 'sk-proj-'],
      label: 'OpenAI keys usually start with sk-',
    },
    maxTokensKey: 'max_completion_tokens',
    models: openaiList,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models through the OpenAI compatibility layer.',
    docsUrl: 'https://platform.claude.com/docs/en/api/openai-sdk',
    keysUrl: 'https://platform.claude.com/settings/keys',
    baseUrl: 'https://api.anthropic.com/v1',
    keyHint: {
      prefix: ['sk-ant-'],
      label: 'Anthropic keys usually start with sk-ant-',
    },
    maxTokensKey: 'max_tokens',
    // The native list endpoint wants x-api-key and a version header; it pages at 20 unless limit is set.
    models: {
      path: '/models?limit=1000',
      shape: 'openai',
      auth: 'x-api-key',
      headers: { 'anthropic-version': '2023-06-01' },
    },
    extraFields: [
      {
        id: 'anthropicWorkspaceId',
        label: 'Workspace ID (optional)',
        header: 'anthropic-workspace-id',
      },
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    description: 'Gemini models from Google AI Studio.',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    keysUrl: 'https://aistudio.google.com/apikey',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyHint: { prefix: ['AIza'], label: 'Gemini keys usually start with AIza' },
    maxTokensKey: 'max_tokens',
    models: { path: '/models', shape: 'gemini', auth: 'bearer' },
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'One key for hundreds of models from many labs.',
    docsUrl: 'https://openrouter.ai/docs/api-reference/overview',
    keysUrl: 'https://openrouter.ai/settings/keys',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyHint: {
      prefix: ['sk-or-v1-'],
      label: 'OpenRouter keys usually start with sk-or-v1-',
    },
    maxTokensKey: 'max_completion_tokens',
    // OpenRouter's optional attribution headers (HTTP-Referer, X-Title) are not sent: FullDots
    // identifies itself to no one.
    models: openaiList,
  },
  {
    id: 'groq',
    name: 'Groq',
    description: 'Fast open-weight models on Groq hardware.',
    docsUrl: 'https://console.groq.com/docs/openai',
    keysUrl: 'https://console.groq.com/keys',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyHint: { prefix: ['gsk_'], label: 'Groq keys usually start with gsk_' },
    maxTokensKey: 'max_completion_tokens',
    models: openaiList,
  },
  {
    id: 'mistral',
    name: 'Mistral',
    description: 'Mistral and Codestral models from La Plateforme.',
    docsUrl: 'https://docs.mistral.ai/api/',
    keysUrl: 'https://console.mistral.ai/api-keys',
    baseUrl: 'https://api.mistral.ai/v1',
    maxTokensKey: 'max_tokens',
    models: openaiList,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek chat and reasoning models.',
    docsUrl: 'https://api-docs.deepseek.com/',
    keysUrl: 'https://platform.deepseek.com/api_keys',
    baseUrl: 'https://api.deepseek.com',
    keyHint: { prefix: ['sk-'], label: 'DeepSeek keys usually start with sk-' },
    maxTokensKey: 'max_tokens',
    models: openaiList,
  },
  {
    id: 'xai',
    name: 'xAI',
    description: 'Grok models from xAI.',
    docsUrl: 'https://docs.x.ai/api-reference',
    keysUrl: 'https://console.x.ai/',
    baseUrl: 'https://api.x.ai/v1',
    keyHint: { prefix: ['xai-'], label: 'xAI keys usually start with xai-' },
    maxTokensKey: 'max_tokens',
    models: openaiList,
  },
  {
    id: 'together',
    name: 'Together AI',
    description: 'Open-source models hosted by Together AI.',
    docsUrl: 'https://docs.together.ai/docs/openai-api-compatibility',
    keysUrl: 'https://api.together.ai/settings/api-keys',
    baseUrl: 'https://api.together.ai/v1',
    maxTokensKey: 'max_tokens',
    // Returns a bare array that also holds image and embedding models.
    models: { path: '/models', shape: 'array', auth: 'bearer' },
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    description: 'Open-source models hosted by Fireworks AI.',
    docsUrl: 'https://docs.fireworks.ai/tools-sdks/openai-compatibility',
    keysUrl: 'https://app.fireworks.ai/settings/users/api-keys',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    keyHint: {
      prefix: ['fw_', 'fw-'],
      label: 'Fireworks keys usually start with fw_',
    },
    maxTokensKey: 'max_tokens',
    // The model list under /inference/v1 is undocumented; if it fails, type the model id by hand.
    models: openaiList,
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    description: 'Very fast inference on Cerebras wafer-scale chips.',
    docsUrl: 'https://inference-docs.cerebras.ai/resources/openai',
    keysUrl: 'https://cloud.cerebras.ai/',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyHint: {
      prefix: ['csk-'],
      label: 'Cerebras keys usually start with csk-',
    },
    maxTokensKey: 'max_completion_tokens',
    models: openaiList,
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Models running on this computer through Ollama.',
    docsUrl: 'https://docs.ollama.com/api/openai-compatibility',
    baseUrl: 'http://localhost:11434/v1',
    local: true,
    keyOptional: true,
    maxTokensKey: 'max_tokens',
    models: openaiList,
    // Ollama rejects tool_choice on its OpenAI-compatible endpoint.
    dropFields: ['tool_choice'],
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    description: 'Models running on this computer through LM Studio.',
    docsUrl: 'https://lmstudio.ai/docs/app/api/endpoints/openai',
    baseUrl: 'http://localhost:1234/v1',
    local: true,
    keyOptional: true,
    maxTokensKey: 'max_tokens',
    models: openaiList,
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    description: 'Any server that speaks the OpenAI chat-completions API.',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    keyOptional: true,
    maxTokensKey: 'max_tokens',
    models: openaiList,
  },
];

export function modelPreset(id: string): ModelPreset | undefined {
  return modelPresets.find((preset) => preset.id === id);
}
