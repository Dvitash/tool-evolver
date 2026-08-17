import { describe, expect, it } from "vitest";
import { createCloudService } from "../src/index.js";

describe("cloud", () => {
  it("initializes successfully", async () => {
    const cloud = createCloudService();
    await expect(cloud.initialize()).resolves.toBeUndefined();
  });
});
