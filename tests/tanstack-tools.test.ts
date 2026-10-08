import { expect, it } from 'vitest';
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import {
  tanstackTools,
  type JsonSchemaTool,
} from '../src/server/tanstack-tools.js';

it('maps a JSON Schema connector tool and passes its input to execute', async () => {
  const inputSchema = {
    type: 'object' as const,
    properties: { n: { type: 'number' } },
  };
  const tool: JsonSchemaTool = {
    name: 'mcp__x__get',
    description: 'd',
    inputSchema,
    execute: async (args) => ({ got: args }),
  };
  const [mapped] = tanstackTools([tool]);
  expect(mapped.name).toBe('mcp__x__get');
  expect(mapped.description).toBe('d');
  expect(mapped.inputSchema).toBe(inputSchema);
  await expect(mapped.execute?.({ n: 1 } as never)).resolves.toEqual({
    got: { n: 1 },
  });
});

it('still maps a zod-based CopilotKit tool and executes it', async () => {
  const parameters = z.object({ text: z.string() });
  const tool = defineTool({
    name: 'echo',
    description: 'Echo the text',
    parameters,
    execute: async (args) => ({ echoed: args.text }),
  });
  const [mapped] = tanstackTools([tool]);
  expect(mapped.name).toBe('echo');
  expect(mapped.inputSchema).toBe(parameters);
  await expect(mapped.execute?.({ text: 'hi' } as never)).resolves.toEqual({
    echoed: 'hi',
  });
});

it('rejects a CopilotKit tool without an executor', () => {
  const tool = defineTool({
    name: 'no_exec',
    description: 'Has no executor',
    parameters: z.object({}),
  });
  expect(() => tanstackTools([tool])).toThrow(
    'Server tool has no executor: no_exec',
  );
});
