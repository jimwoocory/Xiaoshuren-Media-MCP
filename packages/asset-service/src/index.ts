import { createHash, randomUUID } from "node:crypto";
import { Asset, AuthContext, DomainError, UploadSession } from "@xiaoshuren/contracts";
import { AssetUploadStore } from "@xiaoshuren/media-core";
import { detectMediaMime, FetchedMedia } from "@xiaoshuren/security";
import { ObjectStore, PresignedUpload } from "@xiaoshuren/storage";

const ALLOWED_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
]);

const normalizeMime = (value: string): string => value.split(";", 1)[0].trim().toLowerCase();

const extensionForMime = (mimeType: string): string => ({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
}[mimeType] ?? "bin");

export type UploadCreateResult = {
  assetId: string;
  sessionId: string;
  upload: PresignedUpload;
};

export class AssetUploadService {
  constructor(
    private readonly store: AssetUploadStore,
    private readonly objectStore: ObjectStore,
    private readonly options: {
      maxBytes?: number;
      uploadExpiresInSeconds?: number;
      now?: () => Date;
    } = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async create(auth: AuthContext, input: {
    workspaceId?: string;
    mimeType: string;
    byteSize: number;
  }): Promise<UploadCreateResult> {
    const workspace = await this.store.authorize(auth, input.workspaceId);
    const mimeType = normalizeMime(input.mimeType);
    const maxBytes = this.options.maxBytes ?? 100 * 1024 * 1024;

    if (!ALLOWED_MEDIA_TYPES.has(mimeType)) {
      throw new DomainError("ASSET_REJECTED", "Unsupported upload media type");
    }
    if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0 || input.byteSize > maxBytes) {
      throw new DomainError("ASSET_REJECTED", "Upload size is outside the allowed range");
    }

    const now = this.now();
    const expiresInSeconds = this.options.uploadExpiresInSeconds ?? 15 * 60;
    const assetId = randomUUID();
    const sessionId = randomUUID();
    const storageKey = [
      auth.tenantId,
      workspace.id,
      "uploads",
      `${assetId}.${extensionForMime(mimeType)}`,
    ].map(part => encodeURIComponent(part)).join("/");

    const upload = await this.objectStore.createPresignedPut({
      key: storageKey,
      contentType: mimeType,
      expiresInSeconds,
    });
    const asset: Asset = {
      id: assetId,
      tenantId: auth.tenantId,
      workspaceId: workspace.id,
      kind: "input",
      status: "pending_upload",
      storageBucket: this.objectStore.bucket,
      storageKey,
      mimeType,
      byteSize: input.byteSize,
      createdAt: now,
      updatedAt: now,
    };
    const session: UploadSession = {
      id: sessionId,
      tenantId: auth.tenantId,
      subjectId: auth.subjectId,
      workspaceId: workspace.id,
      assetId,
      storageKey,
      mimeType,
      expectedByteSize: input.byteSize,
      status: "pending",
      expiresAt: upload.expiresAt,
      createdAt: now,
    };

    await this.store.createUploadSession(auth, asset, session);
    return { assetId, sessionId, upload };
  }

  async confirm(auth: AuthContext, sessionId: string): Promise<Asset> {
    const session = await this.store.findUploadSession(auth, sessionId);
    if (!session) throw new DomainError("NOT_FOUND", "Resource not found");

    if (session.status === "completed") {
      const existing = await this.store.findAsset(auth, session.assetId);
      if (!existing) throw new DomainError("NOT_FOUND", "Resource not found");
      return existing;
    }
    if (session.status !== "pending") {
      throw new DomainError("ASSET_REJECTED", "Upload session cannot be confirmed");
    }
    if (session.expiresAt.getTime() < this.now().getTime()) {
      throw new DomainError("ASSET_REJECTED", "Upload session expired");
    }

    const observed = await this.objectStore.headObject(session.storageKey);
    if (!observed.exists || observed.byteSize == null || !observed.contentType) {
      throw new DomainError("ASSET_NOT_READY", "Uploaded object is not available");
    }

    const contentType = normalizeMime(observed.contentType);
    if (observed.byteSize !== session.expectedByteSize) {
      throw new DomainError("ASSET_REJECTED", "Uploaded object size does not match the session");
    }
    if (contentType !== session.mimeType) {
      throw new DomainError("ASSET_REJECTED", "Uploaded object content type does not match the session");
    }

    return this.store.completeUploadSession(auth, sessionId, {
      byteSize: observed.byteSize,
      contentType,
      sha256: observed.sha256,
    });
  }

  async confirmByAsset(auth: AuthContext, assetId: string): Promise<Asset> {
    const session = await this.store.findUploadSessionByAsset(auth, assetId);
    if (!session || session.assetId !== assetId) {
      throw new DomainError("NOT_FOUND", "Resource not found");
    }
    return this.confirm(auth, session.id);
  }
}

export interface ImportFetcher {
  fetch(sourceUrl: string, maxBytes: number): Promise<FetchedMedia>;
}

export class UrlImportService {
  constructor(
    private readonly store: AssetUploadStore,
    private readonly fetcher: ImportFetcher,
    private readonly objectStore: ObjectStore,
    private readonly maxBytes = 100 * 1024 * 1024,
  ) {}

  async import(auth: AuthContext, input: { workspaceId?: string; sourceUrl: string }): Promise<Asset> {
    const workspace = await this.store.authorize(auth, input.workspaceId);
    const fetched = await this.fetcher.fetch(input.sourceUrl, this.maxBytes);
    const detectedMime = detectMediaMime(fetched.body);
    if (!detectedMime || !ALLOWED_MEDIA_TYPES.has(detectedMime)) {
      throw new DomainError("ASSET_REJECTED", "Imported media has an unsupported signature");
    }

    const declaredMime = fetched.mimeType ? normalizeMime(fetched.mimeType) : undefined;
    if (declaredMime && declaredMime !== "application/octet-stream" && declaredMime !== detectedMime) {
      throw new DomainError("ASSET_REJECTED", "Imported media MIME does not match its signature");
    }

    const assetId = randomUUID();
    const sha256 = createHash("sha256").update(fetched.body).digest("hex");
    const key = [
      auth.tenantId,
      workspace.id,
      "imports",
      `${assetId}.${extensionForMime(detectedMime)}`,
    ].map(part => encodeURIComponent(part)).join("/");

    const stored = await this.objectStore.putObject({
      key,
      body: fetched.body,
      contentType: detectedMime,
      sha256,
    });
    const now = new Date();
    const asset: Asset = {
      id: assetId,
      tenantId: auth.tenantId,
      workspaceId: workspace.id,
      kind: "input",
      status: "ready",
      storageBucket: stored.bucket,
      storageKey: stored.key,
      sha256,
      mimeType: detectedMime,
      byteSize: fetched.body.byteLength,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.persistImportedAsset(auth, asset);
    return asset;
  }
}

export class InlineAssetService {
  constructor(
    private readonly store: AssetUploadStore,
    private readonly objectStore: ObjectStore,
    private readonly maxBytes = 10 * 1024 * 1024,
  ) {}

  async create(auth: AuthContext, input: {
    workspaceId?: string;
    filename: string;
    mimeType: string;
    base64: string;
  }): Promise<Asset> {
    const workspace = await this.store.authorize(auth, input.workspaceId);
    let body: Uint8Array;
    try {
      body = new Uint8Array(Buffer.from(input.base64, "base64"));
    } catch {
      throw new DomainError("ASSET_REJECTED", "Inline base64 is invalid");
    }
    if (!body.byteLength || body.byteLength > this.maxBytes) {
      throw new DomainError("ASSET_REJECTED", "Inline asset size is outside the allowed range");
    }

    const detectedMime = detectMediaMime(body);
    const declaredMime = normalizeMime(input.mimeType);
    if (!detectedMime || !ALLOWED_MEDIA_TYPES.has(detectedMime) || detectedMime !== declaredMime) {
      throw new DomainError("ASSET_REJECTED", "Inline media type does not match its content signature");
    }

    const assetId = randomUUID();
    const sha256 = createHash("sha256").update(body).digest("hex");
    const key = [
      auth.tenantId,
      workspace.id,
      "inline",
      `${assetId}.${extensionForMime(detectedMime)}`,
    ].map(part => encodeURIComponent(part)).join("/");
    const stored = await this.objectStore.putObject({
      key,
      body,
      contentType: detectedMime,
      sha256,
    });
    const now = new Date();
    const asset: Asset = {
      id: assetId,
      tenantId: auth.tenantId,
      workspaceId: workspace.id,
      kind: "input",
      status: "ready",
      storageBucket: stored.bucket,
      storageKey: stored.key,
      sha256,
      mimeType: detectedMime,
      byteSize: body.byteLength,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.persistImportedAsset(auth, asset);
    return asset;
  }
}

export class AssetReadService {
  constructor(
    private readonly store: AssetUploadStore,
    private readonly objectStore: ObjectStore,
    private readonly readUrlExpiresInSeconds = 10 * 60,
  ) {}

  async get(auth: AuthContext, input: {
    workspaceId?: string;
    assetId: string;
    includeAccessUrl?: boolean;
  }): Promise<{ asset: Asset; accessUrl?: string; accessUrlExpiresAt?: Date }> {
    const asset = await this.store.findAsset(auth, input.assetId);
    if (!asset) throw new DomainError("NOT_FOUND", "Resource not found");
    const workspace = await this.store.authorize(auth, input.workspaceId ?? asset.workspaceId);
    if (asset.tenantId !== auth.tenantId || asset.workspaceId !== workspace.id) {
      throw new DomainError("NOT_FOUND", "Resource not found");
    }
    if (!input.includeAccessUrl) return { asset };
    if (asset.status !== "ready" || !asset.storageKey) {
      throw new DomainError("ASSET_NOT_READY", "Asset is not ready for access");
    }
    const signed = await this.objectStore.createSignedReadUrl({
      key: asset.storageKey,
      expiresInSeconds: this.readUrlExpiresInSeconds,
    });
    return {
      asset,
      accessUrl: signed.url,
      accessUrlExpiresAt: signed.expiresAt,
    };
  }

  async listBySourceJob(auth: AuthContext, jobId: string): Promise<Asset[]> {
    return this.store.findAssetsBySourceJob(auth, jobId);
  }
}
