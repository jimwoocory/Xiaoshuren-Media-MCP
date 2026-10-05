import type { ToolName } from "./schemas.js";

export type JsonObject = Record<string, unknown>;

export interface McpToolBackend {
  call(tool: ToolName, input: JsonObject): Promise<JsonObject>;
}

export class UnconfiguredMcpBackend implements McpToolBackend {
  async call(tool: ToolName): Promise<JsonObject> {
    throw new Error(`MCP backend is not configured for ${tool}`);
  }
}
