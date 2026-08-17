import { describe, expect, it } from "vitest";
import { createCloudService } from "../src/index.js";

describe("Cloud Service Platform", () => {
  it("initializes and shuts down successfully", async () => {
    const cloud = createCloudService({
      config: {
        server: { port: 0, host: "127.0.0.1" },
      },
    });

    await expect(cloud.initialize()).resolves.toBeUndefined();

    expect(cloud.dbPool.isConnected()).toBe(true);
    expect(cloud.objectStore).toBeDefined();
    expect(cloud.queue).toBeDefined();
    expect(cloud.server).toBeDefined();

    await expect(cloud.shutdown()).resolves.toBeUndefined();
  });
});
