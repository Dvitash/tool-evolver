import { describe, expect, it } from "vitest";
import { createGateway } from "../src/index.js";

describe("gateway", () => {
  it("starts and stops cleanly", async () => {
    const gw = createGateway();
    await expect(gw.start()).resolves.toBeUndefined();
    await expect(gw.stop()).resolves.toBeUndefined();
  });
});
