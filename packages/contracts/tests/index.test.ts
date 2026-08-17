import { describe, expect, it } from "vitest";
import { CONTRACTS_VERSION } from "../src/index.js";

describe("contracts", () => {
  it("exports CONTRACTS_VERSION", () => {
    expect(CONTRACTS_VERSION).toBe("0.1.0");
  });
});
