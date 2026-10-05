import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import {
  createMediaMcpHttpServer,
  createOAuthAuthenticator,
  type AuthContext,
  type McpToolBackend,
} from "../apps/mcp-server/src/index.js";

const servers: HttpServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function issueToken(input: {
  privateKey: CryptoKey;
  issuer: string;
  audience: string;
  resource: string;
  scope: string;
  subject?: string;
  clientId?: string;
}) {
  return new SignJWT({
    resource: input.resource,
    scope: input.scope,
    client_id: input.clientId ?? "claude-client",
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setSubject(input.subject ?? "user-123")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(input.privateKey);
}

describe("P0-03 OAuth boundary", () => {
  it("verifies JWT identity/resource and enforces per-tool scopes", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const issuer = "https://auth.example.test";
    const audience = "xiaoshuren-media-mcp";
    const resource = "https://media.example.test/mcp";
    const token = await issueToken({
      privateKey,
      issuer,
      audience,
      resource,
      scope: "media.models.read",
    });

    let observedAuth: AuthContext | undefined;
    const backend: McpToolBackend = {
      async call(tool, input) {
        return { ok: true, tool, input };
      },
    };

    const authenticator = createOAuthAuthenticator({
      issuer,
      audience,
      resource,
      verificationKey: publicKey,
      resolveIdentity: ({ subjectId, clientId }) => {
        expect(subjectId).toBe("user-123");
        expect(clientId).toBe("claude-client");
        return {
          tenantId: "tenant-001",
          defaultWorkspaceId: "workspace-001",
        };
      },
    });

    const httpServer = createMediaMcpHttpServer(
      (_request, auth) => {
        observedAuth = auth;
        return backend;
      },
      { authenticator },
    );
    servers.push(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));

    const { port } = httpServer.address() as AddressInfo;
    const client = new Client({ name: "oauth-test-client", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } },
    );

    try {
      await client.connect(transport);
      const models = await client.callTool({
        name: "models_list",
        arguments: {},
      });
      expect(models.isError).not.toBe(true);
      expect(observedAuth).toEqual({
        tenantId: "tenant-001",
        subjectId: "user-123",
        clientId: "claude-client",
        scopes: ["media.models.read"],
        defaultWorkspaceId: "workspace-001",
      });

      const denied = await client.callTool({
        name: "generate_video",
        arguments: {
          idempotency_key: "1234567890abcdef",
          quote_id: "quote-1",
          request_hash: "hash-1",
          confirm_quote: true,
          request: {},
        },
      });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied.content)).toContain("media.generate.video");
    } finally {
      await client.close();
    }
  });

  it("rejects a token minted for the wrong MCP resource", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const issuer = "https://auth.example.test";
    const audience = "xiaoshuren-media-mcp";
    const resource = "https://media.example.test/mcp";
    const token = await issueToken({
      privateKey,
      issuer,
      audience,
      resource: "https://other.example.test/mcp",
      scope: "media.models.read",
    });

    const authenticator = createOAuthAuthenticator({
      issuer,
      audience,
      resource,
      verificationKey: publicKey,
      resolveIdentity: () => ({ tenantId: "tenant-001" }),
    });

    const httpServer = createMediaMcpHttpServer(
      () => ({
        async call() {
          return { ok: true };
        },
      }),
      { authenticator },
    );
    servers.push(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));

    const { port } = httpServer.address() as AddressInfo;
    const client = new Client({ name: "oauth-test-client", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } },
    );

    await expect(client.connect(transport)).rejects.toMatchObject({ code: 401 });
  });
});
