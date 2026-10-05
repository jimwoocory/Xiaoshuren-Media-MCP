import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import {
  createMediaMcpHttpServer,
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  type McpToolBackend,
  type ToolName,
} from "../apps/mcp-server/src/index.js";

const servers: HttpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("P0-03 MCP server", () => {
  it("freezes exactly the 10 P0 tool names and strict top-level schemas", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(10);
    expect(TOOL_DEFINITIONS.map(tool => tool.name)).toEqual([...TOOL_NAMES]);
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }

    const writes = TOOL_DEFINITIONS.filter(tool =>
      ["asset_create_upload", "asset_confirm", "quote_create", "generate_image", "generate_video", "job_cancel"].includes(tool.name),
    );
    for (const tool of writes) {
      expect(tool.inputSchema.required).toContain("idempotency_key");
    }
  });

  it("serves tools/list and tools/call over Streamable HTTP", async () => {
    const calls: Array<{ tool: ToolName; input: Record<string, unknown> }> = [];
    const backend: McpToolBackend = {
      async call(tool, input) {
        calls.push({ tool, input });
        return { ok: true, tool, echo: input };
      },
    };

    const httpServer = createMediaMcpHttpServer(() => backend);
    servers.push(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));

    const { port } = httpServer.address() as AddressInfo;
    const client = new Client({ name: "test-client", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name)).toEqual([...TOOL_NAMES]);

      const result = await client.callTool({
        name: "models_get",
        arguments: { public_model_id: "seedance2.0mini" },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        ok: true,
        tool: "models_get",
        echo: { public_model_id: "seedance2.0mini" },
      });
      expect(calls).toEqual([
        {
          tool: "models_get",
          input: { public_model_id: "seedance2.0mini" },
        },
      ]);
    } finally {
      await client.close();
    }
  });
});
