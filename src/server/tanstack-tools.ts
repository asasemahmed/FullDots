import { toolDefinition } from '@tanstack/ai';
import type { ToolDefinition } from '@copilotkit/runtime/v2';
import type { JSONSchema } from '@tanstack/ai';

/** A server tool described by a plain JSON Schema (MCP connector tools). */
export interface JsonSchemaTool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  execute: (args: unknown) => Promise<unknown>;
}
export type ServerTool = ToolDefinition | JsonSchemaTool;
export const isJsonSchemaTool = (tool: ServerTool): tool is JsonSchemaTool =>
  'inputSchema' in tool;

export function tanstackTools(tools: ServerTool[]) {
  return tools.map((tool) => {
    if (isJsonSchemaTool(tool)) {
      return toolDefinition({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }).server(async (args) => tool.execute(args));
    }
    const { name, description, parameters, execute } = tool;
    if (!execute) throw new Error(`Server tool has no executor: ${name}`);
    return toolDefinition({
      name,
      description,
      inputSchema: parameters,
    }).server(execute);
  });
}
