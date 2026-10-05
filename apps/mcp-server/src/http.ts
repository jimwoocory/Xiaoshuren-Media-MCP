import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpToolBackend } from "./backend.js";
import { createMediaMcpServer } from "./server.js";

export type BackendFactory = (request: IncomingMessage) => Promise<McpToolBackend> | McpToolBackend;

export function createMediaMcpHttpHandler(backendFactory: BackendFactory) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/mcp") {
      response.statusCode = 404;
      response.end("Not Found");
      return;
    }
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.setHeader("Allow", "POST");
      response.end("Method Not Allowed");
      return;
    }

    const backend = await backendFactory(request);
    const server = createMediaMcpServer(backend);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  };
}

export function createMediaMcpHttpServer(backendFactory: BackendFactory) {
  const handler = createMediaMcpHttpHandler(backendFactory);
  return createServer((request, response) => {
    handler(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        error: {
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : "Unexpected MCP HTTP error",
          retryable: false,
        },
      }));
    });
  });
}
