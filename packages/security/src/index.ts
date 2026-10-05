import { createCipheriv, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile, stat } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DomainError } from "@xiaoshuren/contracts";

export type AddressResolver = (hostname: string) => Promise<string[]>;

export const systemAddressResolver: AddressResolver = async hostname => {
  if (isIP(hostname)) return [hostname];
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map(result => result.address);
};

const blockedAddresses = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

export const isBlockedNetworkAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) return blockedAddresses.check(address, "ipv4");
  if (family === 6) return blockedAddresses.check(address, "ipv6");
  return true;
};

export class UrlImportPolicy {
  constructor(private readonly resolve: AddressResolver = systemAddressResolver) {}

  async assertAllowed(input: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new DomainError("UNSAFE_SOURCE_URL", "Source URL is invalid");
    }

    if (url.protocol !== "https:") {
      throw new DomainError("UNSAFE_SOURCE_URL", "Source URL must use HTTPS");
    }
    if (url.username || url.password) {
      throw new DomainError("UNSAFE_SOURCE_URL", "Source URL credentials are not allowed");
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
      throw new DomainError("UNSAFE_SOURCE_URL", "Source URL host is not allowed");
    }

    let addresses: string[];
    try {
      addresses = await this.resolve(hostname);
    } catch {
      throw new DomainError("UNSAFE_SOURCE_URL", "Source URL host could not be resolved");
    }

    if (addresses.length === 0 || addresses.some(isBlockedNetworkAddress)) {
      throw new DomainError("UNSAFE_SOURCE_URL", "Source URL resolves to a blocked network");
    }

    return url;
  }
}

export type FetchedMedia = {
  sourceUrl: string;
  body: Uint8Array;
  mimeType?: string;
};

export interface MediaSourceFetcher {
  fetch(sourceUrl: string, maxBytes: number): Promise<FetchedMedia>;
}

const hasPrefix = (body: Uint8Array, bytes: number[]): boolean =>
  bytes.every((value, index) => body[index] === value);

export const detectMediaMime = (body: Uint8Array): string | undefined => {
  if (body.byteLength >= 8 && hasPrefix(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (body.byteLength >= 3 && hasPrefix(body, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    body.byteLength >= 12 &&
    String.fromCharCode(...body.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...body.slice(8, 12)) === "WEBP"
  ) return "image/webp";
  if (body.byteLength >= 12 && String.fromCharCode(...body.slice(4, 8)) === "ftyp") return "video/mp4";
  return undefined;
};

export class SafeHttpFetcher {
  constructor(
    private readonly policy: UrlImportPolicy,
    private readonly maxRedirects = 5,
    private readonly timeoutMs = 30_000,
  ) {}

  async fetch(sourceUrl: string, maxBytes: number): Promise<FetchedMedia> {
    let current = sourceUrl;

    for (let redirectCount = 0; redirectCount <= this.maxRedirects; redirectCount += 1) {
      const url = await this.policy.assertAllowed(current);
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirectCount === this.maxRedirects) {
          throw new DomainError("UNSAFE_SOURCE_URL", "Source URL exceeded redirect limit");
        }
        const location = response.headers.get("location");
        if (!location) throw new DomainError("UNSAFE_SOURCE_URL", "Redirect did not include a location");
        current = new URL(location, url).toString();
        continue;
      }

      if (!response.ok || !response.body) {
        throw new DomainError("ASSET_REJECTED", `Source download failed with status ${response.status}`);
      }

      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new DomainError("ASSET_REJECTED", "Source media exceeds the allowed size");
      }

      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = response.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new DomainError("ASSET_REJECTED", "Source media exceeds the allowed size");
        }
        chunks.push(value);
      }

      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }

      return {
        sourceUrl: url.toString(),
        body,
        mimeType: response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase(),
      };
    }

    throw new DomainError("UNSAFE_SOURCE_URL", "Source URL redirect processing failed");
  }
}

export class TrustedLocalFileFetcher implements MediaSourceFetcher {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async fetch(sourceUrl: string, maxBytes: number): Promise<FetchedMedia> {
    let path: string;
    try {
      const url = new URL(sourceUrl);
      if (url.protocol !== "file:") {
        throw new DomainError("UNSAFE_SOURCE_URL", "Trusted local fetcher only accepts file URLs");
      }
      path = resolve(fileURLToPath(url));
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("UNSAFE_SOURCE_URL", "Local media URL is invalid");
    }

    const rel = relative(this.root, path);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new DomainError("UNSAFE_SOURCE_URL", "Local media path escapes the trusted download directory");
    }

    const info = await stat(path);
    if (!info.isFile()) throw new DomainError("ASSET_REJECTED", "Local media source is not a file");
    if (info.size <= 0 || info.size > maxBytes) {
      throw new DomainError("ASSET_REJECTED", "Local media exceeds the allowed size");
    }

    const body = new Uint8Array(await readFile(path));
    return {
      sourceUrl,
      body,
      mimeType: detectMediaMime(body),
    };
  }
}

export class CompositeMediaFetcher implements MediaSourceFetcher {
  constructor(
    private readonly httpsFetcher: MediaSourceFetcher,
    private readonly localFetcher: MediaSourceFetcher,
  ) {}

  async fetch(sourceUrl: string, maxBytes: number): Promise<FetchedMedia> {
    const url = new URL(sourceUrl);
    if (url.protocol === "file:") return this.localFetcher.fetch(sourceUrl, maxBytes);
    return this.httpsFetcher.fetch(sourceUrl, maxBytes);
  }
}

export interface SecretProvider {
  get(name: string): Promise<string>;
}

export class EnvironmentSecretProvider implements SecretProvider {
  async get(name: string): Promise<string> {
    const value = process.env[name];
    if (!value) throw new DomainError("INTERNAL_ERROR", "Required server secret is not configured");
    return value;
  }
}

export type SecretMapping = Record<string, { secretId: string; jsonKey?: string }>;

type SecretsManagerPort = Pick<SecretsManagerClient, "send">;

export class AwsSecretsManagerProvider implements SecretProvider {
  private readonly cache = new Map<string, { value: string; expiresAt: number }>();

  constructor(
    private readonly client: SecretsManagerPort,
    private readonly mapping: SecretMapping,
    private readonly cacheTtlMs = 5 * 60 * 1000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async get(name: string): Promise<string> {
    const cached = this.cache.get(name);
    const now = this.now();
    if (cached && cached.expiresAt > now) return cached.value;

    const mapped = this.mapping[name];
    if (!mapped) throw new DomainError("INTERNAL_ERROR", "Required server secret is not mapped");

    const response = await this.client.send(new GetSecretValueCommand({ SecretId: mapped.secretId }));
    let raw: string | undefined = response.SecretString;
    if (!raw && response.SecretBinary) raw = Buffer.from(response.SecretBinary).toString("utf8");
    if (!raw) throw new DomainError("INTERNAL_ERROR", "Required server secret is empty");

    let value = raw;
    if (mapped.jsonKey) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new DomainError("INTERNAL_ERROR", "Mapped server secret is not valid JSON");
      }
      if (!parsed || typeof parsed !== "object") {
        throw new DomainError("INTERNAL_ERROR", "Mapped server secret JSON is invalid");
      }
      const candidate = (parsed as Record<string, unknown>)[mapped.jsonKey];
      if (typeof candidate !== "string" || candidate.length === 0) {
        throw new DomainError("INTERNAL_ERROR", "Mapped server secret key is missing");
      }
      value = candidate;
    }

    this.cache.set(name, { value, expiresAt: now + this.cacheTtlMs });
    return value;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export interface PayloadProtector {
  protect(rawBody: Uint8Array): Promise<Uint8Array>;
}

export class AesGcmPayloadProtector implements PayloadProtector {
  constructor(private readonly key: Uint8Array) {
    if (key.byteLength !== 32) throw new Error("AES-GCM key must be exactly 32 bytes");
  }

  async protect(rawBody: Uint8Array): Promise<Uint8Array> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(rawBody), cipher.final()]);
    const tag = cipher.getAuthTag();
    return new Uint8Array(Buffer.concat([Buffer.from([1]), iv, tag, encrypted]));
  }
}
