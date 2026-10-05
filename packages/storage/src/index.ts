import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type StoredObject = {
  bucket: string;
  key: string;
};

export type PresignedUpload = {
  method: "PUT";
  url: string;
  expiresAt: Date;
};

export interface ObjectStore {
  readonly bucket: string;
  putObject(input: { key: string; body: Uint8Array; contentType: string; sha256: string }): Promise<StoredObject>;
  createPresignedPut(input: { key: string; contentType: string; expiresInSeconds: number }): Promise<PresignedUpload>;
  createSignedReadUrl(input: { key: string; expiresInSeconds: number }): Promise<{ url: string; expiresAt: Date }>;
  headObject(key: string): Promise<{ exists: boolean; byteSize?: number; contentType?: string; sha256?: string }>;
}

export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly client: S3Client,
    readonly bucket: string,
  ) {}

  async putObject(input: { key: string; body: Uint8Array; contentType: string; sha256: string }): Promise<StoredObject> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      Metadata: { sha256: input.sha256 },
    }));
    return { bucket: this.bucket, key: input.key };
  }

  async createPresignedPut(input: { key: string; contentType: string; expiresInSeconds: number }): Promise<PresignedUpload> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ContentType: input.contentType,
    });
    const url = await getSignedUrl(this.client, command, { expiresIn: input.expiresInSeconds });
    return {
      method: "PUT",
      url,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  async createSignedReadUrl(input: { key: string; expiresInSeconds: number }): Promise<{ url: string; expiresAt: Date }> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: input.key });
    return {
      url: await getSignedUrl(this.client, command, { expiresIn: input.expiresInSeconds }),
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  async headObject(key: string): Promise<{ exists: boolean; byteSize?: number; contentType?: string; sha256?: string }> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        exists: true,
        byteSize: result.ContentLength,
        contentType: result.ContentType?.split(";", 1)[0]?.trim().toLowerCase(),
        sha256: result.Metadata?.sha256,
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return { exists: false };
      throw error;
    }
  }
}

export class MemoryObjectStore implements ObjectStore {
  readonly bucket = "memory";
  readonly objects = new Map<string, { body: Uint8Array; contentType: string; sha256: string }>();

  async putObject(input: { key: string; body: Uint8Array; contentType: string; sha256: string }): Promise<StoredObject> {
    this.objects.set(input.key, {
      body: new Uint8Array(input.body),
      contentType: input.contentType,
      sha256: input.sha256,
    });
    return { bucket: this.bucket, key: input.key };
  }

  async createPresignedPut(input: { key: string; contentType: string; expiresInSeconds: number }): Promise<PresignedUpload> {
    return {
      method: "PUT",
      url: `https://memory.invalid/upload/${encodeURIComponent(input.key)}`,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  async createSignedReadUrl(input: { key: string; expiresInSeconds: number }): Promise<{ url: string; expiresAt: Date }> {
    return {
      url: `https://memory.invalid/read/${encodeURIComponent(input.key)}`,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  async headObject(key: string): Promise<{ exists: boolean; byteSize?: number; contentType?: string; sha256?: string }> {
    const object = this.objects.get(key);
    if (!object) return { exists: false };
    return {
      exists: true,
      byteSize: object.body.byteLength,
      contentType: object.contentType,
      sha256: object.sha256,
    };
  }
}
