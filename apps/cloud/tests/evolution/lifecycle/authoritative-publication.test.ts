import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("authoritative lifecycle composition", () => {
  it("standalone worker uses the shared CloudService composition root", async () => {
    const source = await readFile(new URL("../../../src/bin/worker.ts", import.meta.url), "utf8");
    expect(source).toContain("createCloudService");
    expect(source).not.toContain("Processing observation for tenant");
    expect(source).not.toContain("Running evaluation for tenant");
  });

  it("public publication no longer accepts caller bundle source", async () => {
    const source = await readFile(new URL("../../../src/index.ts", import.meta.url), "utf8");
    expect(source).not.toContain("parsedObj.bundleCode");
    expect(source).toContain("candidateLifecycleOrchestrator.driveToCompletion");
  });
});
