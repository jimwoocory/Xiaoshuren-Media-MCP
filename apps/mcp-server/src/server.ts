import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { McpToolBackend } from "./backend.js";
import type { AuthContext } from "./oauth.js";
import { TOOL_SCOPES } from "./scopes.js";
import { TOOL_DEFINITIONS, TOOL_NAMES, type ToolName } from "./schemas.js";

const TOOL_SET = new Set<string>(TOOL_NAMES);

const errorResult = (error: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({
        error: {
          code: typeof (error as { code?: unknown })?.code === "string"
            ? (error as { code: string }).code
            : "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : "Unknown MCP tool error",
          retryable: typeof (error as { retryable?: unknown })?.retryable === "boolean"
            ? (error as { retryable: boolean }).retryable
            : false,
        },
      }),
    },
  ],
  isError: true,
});

export function createMediaMcpServer(backend: McpToolBackend, auth?: AuthContext): Server {
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

    const toolName = name as ToolName;
    if (auth && !auth.scopes.includes(TOOL_SCOPES[toolName])) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: {
              code: "FORBIDDEN",
              message: `Missing required scope: ${TOOL_SCOPES[toolName]}`,
              retryable: false,
            },
          }),
        }],
        isError: true,
      };
    }

    try {
      const output = await backend.call(
        toolName,
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
