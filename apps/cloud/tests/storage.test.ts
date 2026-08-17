import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DigestMismatchError,
  MemoryObjectStore,
  ObjectStore,
} from "../src/storage/index.js";

describe("Content-Addressed Object Store", () => {
  it("should store and retrieve objects with valid SHA-256 digest", async () => {
    const store: ObjectStore = new MemoryObjectStore();
    const content = "Hello Tool Evolver Cloud Platform!";
    const expectedSha256 = createHash("sha256").update(content).digest("hex");

    const meta = await store.putObject("tools/v1/bundle.tar.gz", content, {
      contentType: "application/gzip",
      sha256: expectedSha256,
      retention: "permanent",
    });

    expect(meta.sha256).toBe(expectedSha256);
    expect(meta.sizeBytes).toBe(Buffer.byteLength(content));
    expect(meta.retention).toBe("permanent");

    const retrieved = await store.getObject("tools/v1/bundle.tar.gz");
    expect(retrieved.toString("utf8")).toBe(content);
  });

  it("should reject uploads when SHA-256 digest does not match content", async () => {
    const store = new MemoryObjectStore();
    const content = "Real content";
    const fakeDigest = "0000000000000000000000000000000000000000000000000000000000000000";

    await expect(
      store.putObject("corrupted.bin", content, {
        sha256: fakeDigest,
      }),
    ).rejects.toThrow(DigestMismatchError);
  });

  it("should support multipart upload and assemble parts deterministically", async () => {
    const store = new MemoryObjectStore();
    const session = await store.initiateMultipartUpload("large-file.bin", {
      retention: "standard",
    });

    const part1Data = "Part 1 chunk data;";
    const part2Data = "Part 2 chunk data;";

    const part1 = await store.uploadPart(session.uploadId, 1, part1Data);
    const part2 = await store.uploadPart(session.uploadId, 2, part2Data);

    const completed = await store.completeMultipartUpload(session.uploadId, [part1, part2]);
    const expectedFullContent = part1Data + part2Data;
    const expectedDigest = createHash("sha256").update(expectedFullContent).digest("hex");

    expect(completed.sha256).toBe(expectedDigest);
    expect(completed.sizeBytes).toBe(Buffer.byteLength(expectedFullContent));

    const retrieved = await store.getObject("large-file.bin");
    expect(retrieved.toString("utf8")).toBe(expectedFullContent);
  });

  it("should generate presigned GET and PUT transfer URLs", async () => {
    const store = new MemoryObjectStore();

    const getUrl = await store.createPresignedGetUrl("artifacts/manifest.json", 3600);
    expect(getUrl.method).toBe("GET");
    expect(getUrl.url).toContain("artifacts%2Fmanifest.json");
    expect(getUrl.expiresAt).toBeDefined();

    const putUrl = await store.createPresignedPutUrl("artifacts/manifest.json", 3600, {
      contentType: "application/json",
    });
    expect(putUrl.method).toBe("PUT");
    expect(putUrl.headers?.["Content-Type"]).toBe("application/json");
  });

  it("should handle object existence, listing, and deletion", async () => {
    const store = new MemoryObjectStore();

    await store.putObject("dir/file1.txt", "file1");
    await store.putObject("dir/file2.txt", "file2");
    await store.putObject("other/file3.txt", "file3");

    expect(await store.exists("dir/file1.txt")).toBe(true);
    expect(await store.exists("dir/nonexistent.txt")).toBe(false);

    const list = await store.listObjects("dir/");
    expect(list.length).toBe(2);
    expect(list.map((m) => m.key)).toEqual(["dir/file1.txt", "dir/file2.txt"]);

    const deleted = await store.deleteObject("dir/file1.txt");
    expect(deleted).toBe(true);
    expect(await store.exists("dir/file1.txt")).toBe(false);
  });
});
