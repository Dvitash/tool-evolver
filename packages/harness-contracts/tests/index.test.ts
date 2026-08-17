import { describe, expect, it } from "vitest";
import { HARNESS_CONTRACTS_VERSION } from "../src/index.js";

describe("harness-contracts", () => {
  it("exports HARNESS_CONTRACTS_VERSION", () => {
    expect(HARNESS_CONTRACTS_VERSION).toBe("0.1.0");
  });
});
