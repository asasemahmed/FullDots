import type { ConnectorTransport, ConnectorValue } from './types.js';

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
    headers: { Authorization: { env: 'GITHUB_TOKEN' } },
    requiredEnv: [
      { name: 'GITHUB_TOKEN', label: 'GitHub personal access token' },
    ],
    docsUrl: 'https://github.com/github/github-mcp-server',
    note: 'The value is sent as `Bearer <token>`: when the variable holds a bare token the server adds the `Bearer ` prefix.',
  },
  {
    id: 'notion',
    name: 'notion',
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    headers: {
      Authorization: { env: 'NOTION_TOKEN' },
      'Notion-Version': { literal: '2022-06-28' },
    },
    requiredEnv: [{ name: 'NOTION_TOKEN', label: 'Notion integration token' }],
    docsUrl: 'https://developers.notion.com/docs/mcp',
  },
  {
    id: 'filesystem',
    name: 'filesystem',
    transport: 'stdio',
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
