import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpToolBackend } from "./backend.js";
import type { AuthContext } from "./oauth.js";
import { createMediaMcpServer } from "./server.js";

export type BackendFactory = (
  request: IncomingMessage,
  auth?: AuthContext,
) => Promise<McpToolBackend> | McpToolBackend;

export type HttpAuthenticator = (request: IncomingMessage) => Promise<AuthContext>;

export type MediaMcpHttpOptions = {
  authenticator?: HttpAuthenticator;
};

export function createMediaMcpHttpHandler(
  backendFactory: BackendFactory,
  options: MediaMcpHttpOptions = {},
) {
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

    const auth = options.authenticator ? await options.authenticator(request) : undefined;
    const backend = await backendFactory(request, auth);
    const server = createMediaMcpServer(backend, auth);
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

export function createMediaMcpHttpServer(
  backendFactory: BackendFactory,
  options: MediaMcpHttpOptions = {},
) {
  const handler = createMediaMcpHttpHandler(backendFactory, options);
  return createServer((request, response) => {
    handler(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;
      const code = typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code
        : "INTERNAL_ERROR";
      response.statusCode = statusCode;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        error: {
          code,
          message: error instanceof Error ? error.message : "Unexpected MCP HTTP error",
          retryable: false,
        },
      }));
    });
  });
}
