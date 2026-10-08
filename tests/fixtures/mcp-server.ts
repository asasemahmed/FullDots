import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import type { Connector } from '../../src/shared/types.js';

export interface McpFixtureOptions {
  /** What `echo_secret` returns. */
  secret?: string;
}

const text = (value: string) => ({
  content: [{ type: 'text' as const, text: value }],
});

/** An in-process MCP server; every connection gets its own server instance linked through memory. */
export function createMcpFixture(options: McpFixtureOptions = {}) {
  const servers: McpServer[] = [];
  const connectors: string[] = [];

  function build(): McpServer {
    const server = new McpServer({ name: 'fixture', version: '1.0.0' });
    server.registerTool(
      'get_issue',
      {
        description: 'Read one issue.',
        inputSchema: { number: z.number() },
        annotations: { readOnlyHint: true },
      },
      async ({ number }) => text(JSON.stringify({ number, title: 'Bug' })),
    );
    server.registerTool(
      'create_issue',
      {
        description: 'Create an issue.',
        inputSchema: { title: z.string() },
      },
      async ({ title }) => text(`created ${title}`),
    );
    server.registerTool(
      'delete_repo',
      {
        description: 'Delete a repository.',
        inputSchema: { name: z.string() },
        annotations: { destructiveHint: true },
      },
      async ({ name }) => text(`deleted ${name}`),
    );
    server.registerTool(
      'big',
      { description: 'Return 100 kB.', annotations: { readOnlyHint: true } },
      async () => text('lorem ipsum dolor '.repeat(6000).slice(0, 100_000)),
    );
    server.registerTool(
      'echo_secret',
      {
        description: 'Return the secret the fixture was given.',
        annotations: { readOnlyHint: true },
      },
      async () => text(options.secret ?? ''),
    );
    server.registerTool(
      'fail',
      { description: 'Always reports an error.' },
      async () => ({ ...text('it broke'), isError: true }),
    );
    server.registerTool(
      'hang',
      { description: 'Never answers.', annotations: { readOnlyHint: true } },
      () => new Promise<never>(() => undefined),
    );
    return server;
  }

  /** The registry's `transport` option. */
  const transport = (connector: Connector): Transport => {
    const [client, server] = InMemoryTransport.createLinkedPair();
    const instance = build();
    servers.push(instance);
    connectors.push(connector.name);
    void instance.connect(server);
    return client;
  };

  return {
    transport,
    servers,
    /** Names of the connectors that asked for a transport, in order. */
    connectors,
    async close() {
      await Promise.allSettled(servers.map((server) => server.close()));
    },
  };
}
