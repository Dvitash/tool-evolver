import { describe, expect, it } from "vitest";
import { SemanticVersionClassifier } from "../../../src/evolution/artifacts/versioning.js";
import { createMockToolManifest } from "./helpers.js";

describe("SemanticVersionClassifier - SemVer Classification & Manifest Diff Engine", () => {
  const versioning = new SemanticVersionClassifier();

  it("should classify initial tool release without prior manifest", () => {
    const manifest = createMockToolManifest({ version: "1.0.0" });
    const report = versioning.diffManifests(manifest);

    expect(report.previousVersion).toBeUndefined();
    expect(report.newVersion).toBe("1.0.0");
    expect(report.increment).toBe("major");
    expect(report.breakingChanges).toHaveLength(0);
    expect(report.schemaChanges.addedParameters).toEqual(["a", "b", "operation"]);
    expect(report.summary).toContain("Initial release");
  });

  it("should classify major increment for breaking parameter removal", () => {
    const priorManifest = createMockToolManifest({ version: "1.0.0" });
    const candidateManifest = createMockToolManifest({
      version: "1.0.0",
      parameters: {
        type: "object",
        properties: {
          a: { type: "number" },
          // Removed 'operation' and 'b'
        },
        required: ["a"],
      },
    });

    const report = versioning.diffManifests(candidateManifest, priorManifest);
    expect(report.increment).toBe("major");
    expect(report.newVersion).toBe("2.0.0");
    expect(report.schemaChanges.removedParameters).toContain("operation");
    expect(report.schemaChanges.removedParameters).toContain("b");
    expect(report.breakingChanges.length).toBeGreaterThanOrEqual(2);
  });

  it("should classify major increment when adding a required parameter without default", () => {
    const priorManifest = createMockToolManifest({ version: "1.0.0" });
    const candidateManifest = createMockToolManifest({
      version: "1.0.0",
      parameters: {
        type: "object",
        properties: {
          ...priorManifest.parameters?.properties,
          precision: { type: "number", description: "Precision decimal places" },
        },
        required: ["operation", "a", "b", "precision"], // newly required
      },
    });

    const report = versioning.diffManifests(candidateManifest, priorManifest);
    expect(report.increment).toBe("major");
    expect(report.newVersion).toBe("2.0.0");
    expect(report.schemaChanges.addedParameters).toContain("precision");
    expect(report.breakingChanges.some((c) => c.includes("precision"))).toBe(true);
  });

  it("should classify major increment when parameter type changes or becomes required", () => {
    const priorManifest = createMockToolManifest({
      version: "1.0.0",
      parameters: {
        type: "object",
        properties: {
          a: { type: "string" },
          opt: { type: "string" },
        },
        required: ["a"],
      },
    });

    // 1. Type changed string -> number
    const candidateTypeChange = createMockToolManifest({
      version: "1.0.0",
      parameters: {
        type: "object",
        properties: {
          a: { type: "number" },
          opt: { type: "string" },
        },
        required: ["a"],
      },
    });

    const report1 = versioning.diffManifests(candidateTypeChange, priorManifest);
    expect(report1.increment).toBe("major");
    expect(report1.breakingChanges.some((c) => c.includes("type changed"))).toBe(true);

    // 2. Optional -> Required
    const candidateRequiredChange = createMockToolManifest({
      version: "1.0.0",
      parameters: {
        type: "object",
        properties: {
          a: { type: "string" },
          opt: { type: "string" },
        },
        required: ["a", "opt"],
      },
    });

    const report2 = versioning.diffManifests(candidateRequiredChange, priorManifest);
    expect(report2.increment).toBe("major");
    expect(report2.breakingChanges.some((c) => c.includes("changed from optional to required"))).toBe(true);
  });

  it("should classify major increment when an existing capability is removed", () => {
    const priorManifest = createMockToolManifest({
      version: "1.0.0",
      capabilities: {
        fs: { readPaths: ["/data/input"], writePaths: [] },
        net: { allowOutbound: false, allowedDomains: [], allowedHosts: ["api.example.com"], allowedPorts: [], allowedProtocols: ["https"], allowLocalhost: false, denyPrivateRanges: true },
        command: { allowShellExecution: false, allowedCommands: [], allowedBinaries: [], forbiddenPatterns: [], allowEnvPassthrough: [] },
        secrets: { allowedSecretNames: [] },
        limits: { maxConcurrentExecutions: 4, maxCpuUsagePercent: 100, maxMemoryMb: 128, maxExecutionTimeMs: 30000, maxOutputSizeBytes: 1048576 },
      },
    });

    const candidateManifest = createMockToolManifest({
      version: "1.0.0",
      capabilities: {
        fs: { readPaths: [], writePaths: [] }, // Removed /data/input
        net: { allowOutbound: false, allowedDomains: [], allowedHosts: [], allowedPorts: [], allowedProtocols: ["https"], allowLocalhost: false, denyPrivateRanges: true }, // Removed api.example.com
        command: { allowShellExecution: false, allowedCommands: [], allowedBinaries: [], forbiddenPatterns: [], allowEnvPassthrough: [] },
        secrets: { allowedSecretNames: [] },
        limits: { maxConcurrentExecutions: 4, maxCpuUsagePercent: 100, maxMemoryMb: 128, maxExecutionTimeMs: 30000, maxOutputSizeBytes: 1048576 },
      },
    });

    const report = versioning.diffManifests(candidateManifest, priorManifest);
    expect(report.increment).toBe("major");
    expect(report.capabilityChanges.removedCapabilities).toContain("fs:read:/data/input");
    expect(report.capabilityChanges.removedCapabilities).toContain("net:api.example.com");
  });

  it("should classify minor increment when adding optional parameters or new capabilities", () => {
    const priorManifest = createMockToolManifest({ version: "1.0.0" });
    const candidateManifest = createMockToolManifest({
      version: "1.0.0",
      parameters: {
        type: "object",
        properties: {
          ...priorManifest.parameters?.properties,
          verbose: { type: "boolean", description: "Enable verbose output" },
        },
        required: ["operation", "a", "b"], // verbose is optional
      },
      capabilities: {
        ...priorManifest.capabilities,
        fs: { readPaths: ["/tmp/cache"], writePaths: [] },
      },
    });

    const report = versioning.diffManifests(candidateManifest, priorManifest);
    expect(report.increment).toBe("minor");
    expect(report.newVersion).toBe("1.1.0");
    expect(report.schemaChanges.addedParameters).toEqual(["verbose"]);
    expect(report.capabilityChanges.addedCapabilities).toContain("fs:read:/tmp/cache");
    expect(report.breakingChanges).toHaveLength(0);
  });

  it("should classify patch increment for description updates and non-breaking bug fixes", () => {
    const priorManifest = createMockToolManifest({ version: "1.2.3", description: "Old description" });
    const candidateManifest = createMockToolManifest({
      version: "1.2.3",
      description: "Updated description with more details.",
    });

    const report = versioning.diffManifests(candidateManifest, priorManifest);
    expect(report.increment).toBe("patch");
    expect(report.newVersion).toBe("1.2.4");
    expect(report.breakingChanges).toHaveLength(0);
    expect(report.schemaChanges.addedParameters).toHaveLength(0);
    expect(report.schemaChanges.removedParameters).toHaveLength(0);
  });

  it("should compute correct semantic version increments", () => {
    expect(versioning.computeNextVersion("1.0.0", "patch")).toBe("1.0.1");
    expect(versioning.computeNextVersion("1.0.0", "minor")).toBe("1.1.0");
    expect(versioning.computeNextVersion("1.0.0", "major")).toBe("2.0.0");
    expect(versioning.computeNextVersion("2.4.9", "patch")).toBe("2.4.10");
    expect(versioning.computeNextVersion("2.4.9", "minor")).toBe("2.5.0");
    expect(versioning.computeNextVersion("2.4.9", "major")).toBe("3.0.0");
    expect(versioning.computeNextVersion(undefined, "patch", "0.5.0")).toBe("0.5.0");
  });
});
