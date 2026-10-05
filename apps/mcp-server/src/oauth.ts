import { jwtVerify, type JWTPayload } from "jose";
import type { IncomingMessage } from "node:http";

export type AuthContext = {
  tenantId: string;
  subjectId: string;
  clientId: string;
  scopes: string[];
  defaultWorkspaceId?: string;
};

export type IdentityMapping = {
  tenantId: string;
  defaultWorkspaceId?: string;
};

export type OAuthVerifierOptions = {
  issuer: string;
  audience: string;
  resource: string;
  verificationKey: Parameters<typeof jwtVerify>[1];
  resolveIdentity: (input: {
    subjectId: string;
    clientId: string;
    claims: JWTPayload;
  }) => Promise<IdentityMapping | undefined> | IdentityMapping | undefined;
  clockToleranceSeconds?: number;
};

export class OAuthHttpError extends Error {
  constructor(
    public readonly statusCode: 401 | 403,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const claimStrings = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every(item => typeof item === "string")) return value;
  return [];
};

const tokenFromRequest = (request: IncomingMessage): string => {
  const authorization = request.headers.authorization;
  if (!authorization) {
    throw new OAuthHttpError(401, "UNAUTHORIZED", "Bearer token is required");
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match?.[1]) {
    throw new OAuthHttpError(401, "UNAUTHORIZED", "Authorization header must use Bearer token");
  }
  return match[1];
};

const parseScopes = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [...new Set(value.split(/\s+/).map(scope => scope.trim()).filter(Boolean))];
  }
  if (Array.isArray(value) && value.every(scope => typeof scope === "string")) {
    return [...new Set(value)];
  }
  return [];
};

export function createOAuthAuthenticator(options: OAuthVerifierOptions) {
  return async (request: IncomingMessage): Promise<AuthContext> => {
    const token = tokenFromRequest(request);
    let claims: JWTPayload;

    try {
      const verified = await jwtVerify(token, options.verificationKey, {
        issuer: options.issuer,
        audience: options.audience,
        clockTolerance: options.clockToleranceSeconds ?? 5,
      });
      claims = verified.payload;
    } catch {
      throw new OAuthHttpError(401, "UNAUTHORIZED", "Access token verification failed");
    }

    const subjectId = claims.sub;
    if (!subjectId) {
      throw new OAuthHttpError(401, "UNAUTHORIZED", "Access token subject is required");
    }

    const clientId =
      typeof claims.client_id === "string"
        ? claims.client_id
        : typeof claims.azp === "string"
          ? claims.azp
          : undefined;
    if (!clientId) {
      throw new OAuthHttpError(401, "UNAUTHORIZED", "Access token client id is required");
    }

    const resources = claimStrings(claims.resource);
    if (!resources.includes(options.resource)) {
      throw new OAuthHttpError(401, "INVALID_RESOURCE", "Access token is not valid for this MCP resource");
    }

    const scopes = parseScopes(claims.scope);
    const mapping = await options.resolveIdentity({ subjectId, clientId, claims });
    if (!mapping?.tenantId) {
      throw new OAuthHttpError(403, "IDENTITY_NOT_MAPPED", "Client and subject are not mapped to a tenant");
    }

    return {
      tenantId: mapping.tenantId,
      subjectId,
      clientId,
      scopes,
      defaultWorkspaceId: mapping.defaultWorkspaceId,
    };
  };
}
