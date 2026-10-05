import type { AuthContext as DomainAuthContext } from "@xiaoshuren/contracts";
import { DomainError } from "@xiaoshuren/contracts";
import type {
  AssetReadService,
  AssetUploadService,
  InlineAssetService,
  UrlImportService,
} from "@xiaoshuren/asset-service";
import type {
  GenerationService,
  IdempotencyService,
  JobAccessService,
  ModelCatalogReader,
  QuoteService,
} from "@xiaoshuren/media-core";
import type { McpToolBackend } from "./backend.js";
import type { AuthContext } from "./oauth.js";
import type { ToolName } from "./schemas.js";

type JsonObject = Record<string, unknown>;

export type CoreBackendDependencies = {
  catalog: ModelCatalogReader;
  quotes: QuoteService;
  generation: GenerationService;
  jobs: JobAccessService;
  idempotency?: IdempotencyService;
  assets?: {
    upload: AssetUploadService;
    urlImport: UrlImportService;
    inline: InlineAssetService;
    read: AssetReadService;
  };
};

const asString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value) {
    throw new DomainError("VALIDATION_ERROR", `${field} is required`);
  }
  return value;
};

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

const asObject = (value: unknown, field: string): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("VALIDATION_ERROR", `${field} must be an object`);
  }
  return value as JsonObject;
};

const domainAuth = (auth: AuthContext): DomainAuthContext => ({
  tenantId: auth.tenantId,
  subjectId: auth.subjectId,
  clientId: auth.clientId,
  scopes: auth.scopes,
  defaultWorkspaceId: auth.defaultWorkspaceId,
});

export class CoreMediaMcpBackend implements McpToolBackend {
  private readonly auth: DomainAuthContext;

  constructor(
    auth: AuthContext,
    private readonly services: CoreBackendDependencies,
  ) {
    this.auth = domainAuth(auth);
  }

  private async idempotentWrite<T extends JsonObject>(
    toolName: ToolName,
    input: JsonObject,
    resourceType: string,
    execute: () => Promise<T>,
  ): Promise<T> {
    const service = this.services.idempotency;
    if (!service) throw new DomainError("INTERNAL_ERROR", "Write idempotency service is not configured");
    const idempotencyKey = asString(input.idempotency_key, "idempotency_key");
    const semanticRequest = { ...input };
    delete semanticRequest.idempotency_key;
    return service.run(this.auth, {
      toolName,
      idempotencyKey,
      semanticRequest,
      resourceType,
      execute: async () => {
        const response = await execute();
        const resourceId = typeof response.asset_id === "string"
          ? response.asset_id
          : typeof response.job_id === "string"
            ? response.job_id
            : "unknown";
        return { response, resourceId };
      },
    });
  }

  async call(tool: ToolName, input: JsonObject): Promise<JsonObject> {
    switch (tool) {
      case "models_list": {
        const capability = input.capability === "image_generation" || input.capability === "video_generation"
          ? input.capability
          : undefined;
        const limit = typeof input.limit === "number" ? input.limit : undefined;
        const items = await this.services.catalog.list({ capability, limit });
        return {
          items: items.map(model => ({
            public_model_id: model.publicModelId,
            display_name: model.publicModelId,
            capability: model.capability,
            availability: model.availability,
            pricing_rule_version: model.pricingRuleVersion,
          })),
        };
      }
      case "models_get": {
        const model = await this.services.catalog.get(asString(input.public_model_id, "public_model_id"));
        return {
          public_model_id: model.publicModelId,
          display_name: model.publicModelId,
          capability: model.capability,
          input_schema: model.inputSchema,
          pricing_rule_version: model.pricingRuleVersion,
          availability: model.availability,
          limits: model.limits,
        };
      }
      case "quote_create": {
        const quote = await this.services.quotes.create(this.auth, {
          workspaceId: asOptionalString(input.workspace_id),
          idempotencyKey: asString(input.idempotency_key, "idempotency_key"),
          publicModelId: asString(input.public_model_id, "public_model_id"),
          request: asObject(input.request, "request"),
        });
        return {
          quote_id: quote.quoteId,
          request_hash: quote.requestHash,
          max_charge: {
            currency: quote.maxCharge.currency,
            amount_minor: quote.maxCharge.amountMinor,
          },
          expires_at: quote.expiresAt.toISOString(),
          pricing_rule_version: quote.pricingRuleVersion,
          spend_mode: quote.spendMode,
          confirmation_required: quote.confirmationRequired,
        };
      }
      case "generate_image":
      case "generate_video": {
        if (input.confirm_quote !== true) {
          throw new DomainError("QUOTE_CONFIRMATION_REQUIRED", "confirm_quote must be true");
        }
        const result = await this.services.generation.create(this.auth, {
          toolName: tool,
          workspaceId: asOptionalString(input.workspace_id),
          idempotencyKey: asString(input.idempotency_key, "idempotency_key"),
          quoteId: asString(input.quote_id, "quote_id"),
          requestHash: asString(input.request_hash, "request_hash"),
          confirmQuote: true,
          request: asObject(input.request, "request"),
        });
        return {
          job_id: result.jobId,
          status: result.status,
          quote_id: result.quoteId,
          request_hash: result.requestHash,
        };
      }
      case "job_get": {
        const job = await this.services.jobs.get(this.auth, {
          workspaceId: asOptionalString(input.workspace_id),
          jobId: asString(input.job_id, "job_id"),
        });
        const outputAssets = this.services.assets
          ? await this.services.assets.read.listBySourceJob(this.auth, job.id)
          : [];
        return {
          job_id: job.id,
          kind: job.kind === "image" ? "image_generation" : "video_generation",
          status: job.status,
          output_asset_ids: outputAssets
            .filter(asset => asset.status === "ready")
            .map(asset => asset.id),
          created_at: job.createdAt.toISOString(),
          updated_at: job.updatedAt.toISOString(),
        };
      }
      case "job_cancel":
        return this.idempotentWrite("job_cancel", input, "job", async () => {
          const job = await this.services.jobs.cancel(this.auth, {
            workspaceId: asOptionalString(input.workspace_id),
            jobId: asString(input.job_id, "job_id"),
          });
          return {
            job_id: job.id,
            status: job.status,
          };
        });
      case "asset_create_upload":
        return this.idempotentWrite("asset_create_upload", input, "asset", async () => {
          const assets = this.services.assets;
          if (!assets) throw new DomainError("NOT_IMPLEMENTED", "Asset services are not configured");
          const source = asObject(input.source, "source");
          const kind = asString(source.kind, "source.kind");
          const workspaceId = asOptionalString(input.workspace_id);

          if (kind === "upload_session") {
            const created = await assets.upload.create(this.auth, {
              workspaceId,
              mimeType: asString(source.mime_type, "source.mime_type"),
              byteSize: Number(source.byte_size),
            });
            return {
              asset_id: created.assetId,
              status: "pending_upload",
              upload: {
                mode: "single_put",
                put_url: created.upload.url,
                expires_at: created.upload.expiresAt.toISOString(),
              },
            };
          }
          if (kind === "controlled_url_import") {
            const asset = await assets.urlImport.import(this.auth, {
              workspaceId,
              sourceUrl: asString(source.url, "source.url"),
            });
            return {
              asset_id: asset.id,
              status: asset.status === "ready" ? "processing" : asset.status,
            };
          }
          if (kind === "inline_base64") {
            const asset = await assets.inline.create(this.auth, {
              workspaceId,
              filename: asString(source.filename, "source.filename"),
              mimeType: asString(source.mime_type, "source.mime_type"),
              base64: asString(source.base64, "source.base64"),
            });
            return {
              asset_id: asset.id,
              status: asset.status === "ready" ? "processing" : asset.status,
            };
          }
          throw new DomainError("VALIDATION_ERROR", "Unsupported asset source kind");
        });
      case "asset_confirm":
        return this.idempotentWrite("asset_confirm", input, "asset", async () => {
          const assets = this.services.assets;
          if (!assets) throw new DomainError("NOT_IMPLEMENTED", "Asset services are not configured");
          const asset = await assets.upload.confirmByAsset(
            this.auth,
            asString(input.asset_id, "asset_id"),
          );
          return {
            asset_id: asset.id,
            status: asset.status,
          };
        });
      case "asset_get": {
        const assets = this.services.assets;
        if (!assets) throw new DomainError("NOT_IMPLEMENTED", "Asset services are not configured");
        const result = await assets.read.get(this.auth, {
          workspaceId: asOptionalString(input.workspace_id),
          assetId: asString(input.asset_id, "asset_id"),
          includeAccessUrl: input.include_access_url === true,
        });
        return {
          asset_id: result.asset.id,
          kind: result.asset.kind,
          status: result.asset.status,
          mime_type: result.asset.mimeType,
          byte_size: result.asset.byteSize,
          width: result.asset.width,
          height: result.asset.height,
          duration_ms: result.asset.durationMs,
          access_url: result.accessUrl,
          access_url_expires_at: result.accessUrlExpiresAt?.toISOString(),
        };
      }
      default:
        throw new DomainError("NOT_FOUND", "Unknown tool");
    }
  }
}
