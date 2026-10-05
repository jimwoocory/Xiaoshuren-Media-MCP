import { createHash } from "node:crypto";

export type JobStatus = "queued" | "submitting" | "submitted" | "running" | "unknown" | "reconciling" | "cancel_requested" | "succeeded" | "failed" | "cancelled";
export type ProviderStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export type Capability = "image_generation" | "video_generation" | "audio_generation";

export type AuthContext = { tenantId: string; subjectId: string; clientId: string; scopes: string[]; defaultWorkspaceId?: string };
export type Workspace = { id: string; tenantId: string; name: string; status: "active" | "disabled" };
export type ModelCatalogEntry = { id: string; publicModelId: string; version: string; providerId: string; providerModelId: string; capability: Capability; inputSchema: Record<string, unknown>; pricingRuleVersion: string; availability: "available" | "disabled" | "maintenance"; limits: Record<string, unknown>; features: { supportsWebhook: boolean; supportsCancel: boolean; supportsProviderIdempotency: boolean } };
export type Quote = { id: string; tenantId: string; subjectId: string; workspaceId: string; publicModelId: string; requestHash: string; normalizedRequest: Record<string, unknown>; pricingRuleVersion: string; status: "reserved" | "confirmed" | "expired" | "released"; expiresAt: Date };
export type Job = { id: string; tenantId: string; subjectId: string; workspaceId: string; quoteId?: string; kind: "image" | "video"; publicModelId: string; requestHash: string; frozenRequest: Record<string, unknown>; status: JobStatus; version: number; createdAt: Date; updatedAt: Date };
export type ProviderExecution = { id: string; jobId: string; providerId: string; providerModelId: string; providerRequestKey: string; providerJobId?: string; status: ProviderStatus; submissionAttempts: number; createdAt: Date; updatedAt: Date };
export type Asset = { id: string; tenantId: string; workspaceId: string; sourceJobId?: string; kind: "input" | "generated_image" | "generated_video"; status: "pending_upload" | "processing" | "ready" | "rejected" | "deleted"; storageBucket?: string; storageKey?: string; sha256?: string; mimeType?: string; byteSize?: number; width?: number; height?: number; durationMs?: number; createdAt: Date; updatedAt: Date };
export type UploadSession = { id: string; tenantId: string; subjectId: string; workspaceId: string; assetId: string; storageKey: string; mimeType: string; expectedByteSize: number; status: "pending" | "completed" | "expired" | "rejected"; expiresAt: Date; createdAt: Date; completedAt?: Date };
export type Audit = { id: string; tenantId: string; subjectId: string; workspaceId: string; action: string; targetType: string; targetId: string; requestId: string; metadataRedacted: Record<string, unknown>; createdAt: Date };
export type Outbox = { id: string; aggregateType: string; aggregateId: string; eventType: string; payload: Record<string, unknown>; availableAt: Date; createdAt: Date; processedAt?: Date };
export type IdempotencyRecord = { id: string; tenantId: string; subjectId: string; toolName: string; idempotencyKey: string; requestHash: string; responseSnapshot: Record<string, unknown>; resourceType: string; resourceId: string; createdAt: Date };

export type ProviderExecutionContext = { tenantId: string; workspaceId: string; jobId: string; providerExecutionId: string; providerRequestKey: string; providerModelId?: string; callbackUrl?: string };
export type ProviderSubmitResult = { providerJobId?: string; status: "submitted" | "running" | "unknown" };
export type ProviderStatusResult = { status: ProviderStatus; outputs?: Array<{ url: string; mimeType?: string }>; error?: { providerCode?: string; message: string; retryable: boolean } };
export interface ProviderAdapter { submit(ctx: ProviderExecutionContext, request: Record<string, unknown>): Promise<ProviderSubmitResult>; getStatus(ctx: ProviderExecutionContext, providerJobId: string): Promise<ProviderStatusResult>; cancel?(ctx: ProviderExecutionContext, providerJobId: string): Promise<ProviderStatusResult>; verifyWebhook?(headers: Record<string, string>, rawBody: Uint8Array): Promise<{ valid: boolean; eventId?: string }>; normalizeError(error: unknown): { code: string; message: string; retryable: boolean; providerCode?: string } }

export class DomainError extends Error { constructor(public readonly code: string, message: string, public readonly retryable = false) { super(message); this.name = "DomainError"; } }
export const stableHash = (value: unknown): string => createHash("sha256").update(stableJson(value)).digest("hex");
export const stableJson = (value: unknown): string => Array.isArray(value) ? `[${value.map(stableJson).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value as Record<string, unknown>).sort().map(k => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(value);
