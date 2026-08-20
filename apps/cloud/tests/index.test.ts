import { describe, expect, it } from "vitest";
import { redactConfig } from "../src/config.js";
import { createConfiguredBenchmarkEvidenceVerifier } from "../src/evolution/replay/benchmark-attestation.js";
import { createCloudService } from "../src/index.js";

const ATTESTATION_SECRET = "benchmark-attestation-secret-32b!!";

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
    expect(cloud.benchmarkEvidenceVerifier).toBeUndefined();

    await expect(cloud.shutdown()).resolves.toBeUndefined();
  });

  it("accepts an explicit benchmark evidence verifier for tests", async () => {
    const verifier = createConfiguredBenchmarkEvidenceVerifier({
      BENCHMARK_ATTESTATION_ISSUER: "test-issuer",
      BENCHMARK_ATTESTATION_KEY_ID: "test-key",
      BENCHMARK_ATTESTATION_SECRET: ATTESTATION_SECRET,
    });
    const cloud = createCloudService({
      config: { server: { port: 0, host: "127.0.0.1" } },
      benchmarkEvidenceVerifier: verifier,
    });
    expect(cloud.benchmarkEvidenceVerifier).toBe(verifier);
    await cloud.shutdown();
  });

  it("wires a verifier from validated attestation config on the promotion path", async () => {
    const cloud = createCloudService({
      config: {
        server: { port: 0, host: "127.0.0.1" },
        benchmarkAttestation: {
          issuer: "prod-issuer",
          keyId: "prod-key",
          secret: ATTESTATION_SECRET,
        },
      },
    });
    expect(cloud.benchmarkEvidenceVerifier).toBeDefined();
    expect(JSON.stringify(cloud.benchmarkEvidenceVerifier)).not.toContain(ATTESTATION_SECRET);
    expect(JSON.stringify(redactConfig(cloud.config))).not.toContain(ATTESTATION_SECRET);
    await cloud.shutdown();
  });
});
