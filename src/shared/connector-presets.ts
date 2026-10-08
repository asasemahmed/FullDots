import type {
  ConnectorAuth,
  ConnectorTransport,
  ConnectorValue,
} from './types.js';

export type ConnectorPresetCategory = 'work' | 'dev' | 'data' | 'files' | 'web';

export interface ConnectorPreset {
  id: string;
  name: string;
  transport: ConnectorTransport;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, ConnectorValue>;
  env?: Record<string, ConnectorValue>;
  /** Process env variables the owner must set before the connector can connect. */
  requiredEnv: { name: string; label: string }[];
  docsUrl: string;
  /** `oauth`: browser authorization (no headers); `token`: headers reference env variables; `none`: no credentials. */
  auth: ConnectorAuth;
  /** One short sentence for the gallery card. */
  description: string;
  category: ConnectorPresetCategory;
  /**
   * The "use a token instead" alternative for an `oauth` preset: the process
   * env variable, the header it is sent in (default `Authorization`) and the
   * scheme the variable's value must carry (default `Bearer`, which the server
   * adds to a bare token).
   */
  tokenEnv?: { name: string; label: string; header?: string; scheme?: string };
  /** Provider-specific caveat shown next to the authorization button. */
  authNote?: string;
  note?: string;
  /** True for presets that spawn a process on the server host. */
  requiresStdio?: boolean;
}

export const connectorPresets: ConnectorPreset[] = [
  {
    id: 'github',
    name: 'github',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: 'token',
    description: 'Repositories, issues and pull requests',
    category: 'dev',
    headers: { Authorization: { env: 'GITHUB_TOKEN' } },
    requiredEnv: [
      { name: 'GITHUB_TOKEN', label: 'GitHub personal access token' },
    ],
    tokenEnv: { name: 'GITHUB_TOKEN', label: 'GitHub personal access token' },
    docsUrl: 'https://github.com/github/github-mcp-server',
    note: 'The value is sent as `Bearer <token>`: when the variable holds a bare token the server adds the `Bearer ` prefix.',
  },
  {
    id: 'paypal',
    name: 'paypal',
    transport: 'http',
    url: 'https://mcp.paypal.com/http',
    auth: 'token',
    description: 'Invoices, orders and payments',
    category: 'data',
    headers: { Authorization: { env: 'PAYPAL_ACCESS_TOKEN' } },
    requiredEnv: [
      { name: 'PAYPAL_ACCESS_TOKEN', label: 'PayPal access token' },
    ],
    tokenEnv: { name: 'PAYPAL_ACCESS_TOKEN', label: 'PayPal access token' },
    docsUrl: 'https://developer.paypal.com/tools/mcp-server/',
    note: 'Use a client-credentials access token. For the sandbox, change the URL to https://mcp.sandbox.paypal.com/http.',
  },
  {
    id: 'notion',
    name: 'notion',
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    auth: 'oauth',
    description: 'Pages, databases and comments',
    category: 'work',
    requiredEnv: [],
    docsUrl: 'https://developers.notion.com/docs/get-started-with-mcp',
  },
  {
    id: 'linear',
    name: 'linear',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth',
    description: 'Issues, projects and cycles',
    category: 'work',
    requiredEnv: [],
    tokenEnv: {
      name: 'LINEAR_API_KEY',
      label: 'Linear API key',
    },
    docsUrl: 'https://linear.app/docs/mcp',
    note: 'For a read-only connection, change the URL to https://mcp.linear.app/mcp/readonly.',
  },
  {
    id: 'atlassian',
    name: 'atlassian',
    transport: 'http',
    url: 'https://mcp.atlassian.com/v2/mcp',
    auth: 'oauth',
    description: 'Jira issues and Confluence pages',
    category: 'work',
    requiredEnv: [],
    docsUrl:
      'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/',
  },
  {
    id: 'asana',
    name: 'asana',
    transport: 'http',
    url: 'https://mcp.asana.com/v2/mcp',
    auth: 'oauth',
    description: 'Tasks, projects and goals',
    category: 'work',
    requiredEnv: [],
    docsUrl:
      'https://developers.asana.com/docs/using-asanas-model-control-protocol-mcp-server',
  },
  {
    id: 'intercom',
    name: 'intercom',
    transport: 'http',
    url: 'https://mcp.intercom.com/mcp',
    auth: 'oauth',
    description: 'Conversations, contacts and help articles',
    category: 'work',
    requiredEnv: [],
    tokenEnv: {
      name: 'INTERCOM_ACCESS_TOKEN',
      label: 'Intercom access token',
    },
    docsUrl: 'https://developers.intercom.com/docs/guides/mcp',
    authNote:
      'Intercom only allows localhost or 127.0.0.1 as the redirect address. Open FullDots at http://127.0.0.1 or http://localhost to authorize, or ask Intercom support to allow your address. EU workspaces use https://mcp.eu.intercom.com/mcp.',
  },
  {
    id: 'sentry',
    name: 'sentry',
    transport: 'http',
    url: 'https://mcp.sentry.dev/mcp',
    auth: 'oauth',
    description: 'Errors, issues and performance traces',
    category: 'dev',
    requiredEnv: [],
    tokenEnv: {
      name: 'SENTRY_ACCESS_TOKEN',
      label:
        'Sentry user auth token (the variable must hold `Sentry-Bearer <token>`)',
      scheme: 'Sentry-Bearer',
    },
    docsUrl: 'https://mcp.sentry.dev/',
  },
  {
    id: 'huggingface',
    name: 'huggingface',
    transport: 'http',
    url: 'https://huggingface.co/mcp',
    auth: 'oauth',
    description: 'Models, datasets and Spaces on the Hub',
    category: 'dev',
    requiredEnv: [],
    tokenEnv: {
      name: 'HF_TOKEN',
      label: 'Hugging Face access token',
    },
    docsUrl: 'https://huggingface.co/docs/hub/en/hf-mcp-server',
    note: 'Some tools work without signing in.',
  },
  {
    id: 'cloudflare',
    name: 'cloudflare',
    transport: 'http',
    url: 'https://mcp.cloudflare.com/mcp',
    auth: 'oauth',
    description: 'Workers, DNS and the Cloudflare API',
    category: 'dev',
    requiredEnv: [],
    tokenEnv: {
      name: 'CLOUDFLARE_API_TOKEN',
      label: 'Cloudflare API token',
    },
    docsUrl:
      'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/',
  },
  {
    id: 'cloudflare-docs',
    name: 'cloudflare-docs',
    transport: 'http',
    url: 'https://docs.mcp.cloudflare.com/mcp',
    auth: 'none',
    description: 'Search the Cloudflare documentation',
    category: 'web',
    requiredEnv: [],
    docsUrl:
      'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/',
  },
  {
    id: 'supabase',
    name: 'supabase',
    transport: 'http',
    url: 'https://mcp.supabase.com/mcp',
    auth: 'oauth',
    description: 'Postgres databases, migrations and logs',
    category: 'data',
    requiredEnv: [],
    tokenEnv: {
      name: 'SUPABASE_ACCESS_TOKEN',
      label: 'Supabase personal access token',
    },
    docsUrl: 'https://supabase.com/docs/guides/getting-started/mcp',
    note: 'Append ?read_only=true to the URL to block writes.',
  },
  {
    id: 'neon',
    name: 'neon',
    transport: 'http',
    url: 'https://mcp.neon.tech/mcp',
    auth: 'oauth',
    description: 'Serverless Postgres projects and branches',
    category: 'data',
    requiredEnv: [],
    tokenEnv: {
      name: 'NEON_API_KEY',
      label: 'Neon API key',
    },
    docsUrl: 'https://neon.com/docs/ai/neon-mcp-server',
  },
  {
    id: 'stripe',
    name: 'stripe',
    transport: 'http',
    url: 'https://mcp.stripe.com',
    auth: 'oauth',
    description: 'Customers, payments and subscriptions',
    category: 'data',
    requiredEnv: [],
    tokenEnv: {
      name: 'STRIPE_AGENT_API_KEY',
      label: 'Stripe restricted API key',
    },
    docsUrl: 'https://docs.stripe.com/mcp',
    note: 'Stripe asks for its own confirmation before write actions.',
  },
  {
    id: 'filesystem',
    name: 'filesystem',
    transport: 'stdio',
    auth: 'none',
    description: 'Read and write files in one directory',
    category: 'files',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    requiredEnv: [],
    docsUrl:
      'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    note: 'Add the directory to expose as the last argument. Access is scoped to that directory.',
    requiresStdio: true,
  },
  {
    id: 'fetch',
    name: 'fetch',
    transport: 'stdio',
    auth: 'none',
    description: 'Fetch web pages as text',
    category: 'web',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    requiredEnv: [],
    docsUrl:
      'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    requiresStdio: true,
  },
  {
    id: 'google-drive',
    name: 'google-drive',
    transport: 'stdio',
    auth: 'none',
    description: 'Search and read Google Drive files',
    category: 'files',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gdrive'],
    env: {
      GDRIVE_CREDENTIALS_PATH: { literal: '~/.gdrive-server-credentials.json' },
    },
    requiredEnv: [],
    docsUrl:
      'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/gdrive',
    note: 'Run the server once to complete Google OAuth. The credentials file path is not a secret.',
    requiresStdio: true,
  },
  {
    id: 'gmail',
    name: 'gmail',
    transport: 'stdio',
    auth: 'none',
    description: 'Search and send Gmail messages',
    category: 'work',
    command: 'npx',
    args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
    env: {
      GMAIL_CREDENTIALS_PATH: { literal: '~/.gmail-mcp/credentials.json' },
    },
    requiredEnv: [],
    docsUrl: 'https://github.com/GongRzhe/Gmail-MCP-Server',
    note: 'Run `npx @gongrzhe/server-gmail-autoauth-mcp auth` once to complete Google OAuth.',
    requiresStdio: true,
  },
];
