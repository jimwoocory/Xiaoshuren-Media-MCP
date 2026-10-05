import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { TrustedLocalFileFetcher } from "../packages/security/src/index.js";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe("TrustedLocalFileFetcher", () => {
  it("reads a generated image only from the configured trusted download root", async () => {
    const root = await mkdtemp(join(tmpdir(), "xsr-media-root-"));
    try {
      const file = join(root, "generated.png");
      await writeFile(file, png);
      const fetcher = new TrustedLocalFileFetcher(root);

      await expect(fetcher.fetch(pathToFileURL(file).toString(), 1024)).resolves.toMatchObject({
        mimeType: "image/png",
      });
      const result = await fetcher.fetch(pathToFileURL(file).toString(), 1024);
      expect(result.body).toEqual(png);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects file URLs that escape the trusted root", async () => {
    const root = await mkdtemp(join(tmpdir(), "xsr-media-root-"));
    const outside = await mkdtemp(join(tmpdir(), "xsr-media-outside-"));
    try {
      const file = join(outside, "secret.png");
      await writeFile(file, png);
      const fetcher = new TrustedLocalFileFetcher(root);

      await expect(fetcher.fetch(pathToFileURL(file).toString(), 1024)).rejects.toMatchObject({
        code: "UNSAFE_SOURCE_URL",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
