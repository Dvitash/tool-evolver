import { describe, expect, it } from "vitest";
import { FIXTURES_VERSION, sampleToolSpec } from "../src/index.js";

describe("test-fixtures", () => {
  it("provides valid fixture tool spec", () => {
    expect(sampleToolSpec.id).toBe("fixture-tool-01");
    expect(FIXTURES_VERSION).toBe("0.1.0");
  });
});
