import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { McpToolBackend } from "./backend.js";
import { TOOL_DEFINITIONS, TOOL_NAMES, type ToolName } from "./schemas.js";

const TOOL_SET = new Set<string>(TOOL_NAMES);

const errorResult = (error: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({
        error: {
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : "Unknown MCP tool error",
          retryable: false,
        },
      }),
    },
  ],
  isError: true,
});

export function createMediaMcpServer(backend: McpToolBackend): Server {
  const server = new Server(
    { name: "xiaoshuren-media-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (!TOOL_SET.has(name)) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: { code: "NOT_FOUND", message: "Unknown tool", retryable: false } }) }],
        isError: true,
      };
    }

    try {
      const output = await backend.call(
        name as ToolName,
        (request.params.arguments ?? {}) as Record<string, unknown>,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      return errorResult(error);
    }
  });

  return server;
}
