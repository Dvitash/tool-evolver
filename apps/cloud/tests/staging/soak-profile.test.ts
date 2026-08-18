import { describe, expect, it } from "vitest";
import { createAuthService } from "../../src/auth/index.js";
import { MemoryDatabasePool, runMigrations } from "../../src/db/index.js";
import { MemoryDurableQueue } from "../../src/queue/index.js";
import { SoakRunner } from "../../src/staging/index.js";
import { MemoryObjectStore } from "../../src/storage/index.js";

describe("Staging Soak Profile & Multi-Tenant Lifecycle Verification Suite", () => {
  it("should complete full multi-tenant soak cycle with zero data loss and strict isolation", async () => {
    const runner = new SoakRunner({
      tenantCount: 4,
      durationMs: 2500,
      concurrency: 2,
      enableFaultInjection: true,
      faultIntervalMs: 800,
      verbose: false,
    });

    const result = await runner.runSoak();

    expect(result.passed).toBe(true);
    expect(result.metrics.totalRequests).toBeGreaterThan(0);
    expect(result.metrics.successfulRequests).toBeGreaterThan(0);
    expect(result.metrics.totalObservationsIngested).toBeGreaterThan(0);
    expect(result.metrics.opportunitiesDetected).toBeGreaterThan(0);
    expect(result.metrics.candidatesSynthesized).toBeGreaterThan(0);
    expect(result.metrics.validationsCompleted).toBeGreaterThan(0);
    expect(result.metrics.replaysCompleted).toBeGreaterThan(0);
    expect(result.metrics.publicationsCompleted).toBeGreaterThan(0);
    expect(result.metrics.canariesDeployed).toBeGreaterThan(0);

    // Invariant 1: Ingestion & Privacy Gate Scans
    expect(result.metrics.privacyGateScanned).toBe(result.metrics.totalObservationsIngested);

    // Invariant 2: Rollout Outcomes (Promotions + Rollbacks = Canaries)
    expect(result.metrics.rolloutsPromoted + result.metrics.rolloutsRolledBack).toBe(
      result.metrics.canariesDeployed,
    );

    // Invariant 3: Memory Stability (Heap growth under control during short test)
    const heapGrowthMb = result.metrics.heapUsedMbEnd - result.metrics.heapUsedMbStart;
    expect(heapGrowthMb).toBeLessThan(100); // Heap growth must remain bounded

    // Invariant 4: Restore Rehearsal verification passed
    expect(result.rehearsalReport.rehearsalPassed).toBe(true);
    expect(result.rehearsalReport.deviceAuthOk).toBe(true);
    expect(result.rehearsalReport.catalogIntegrityOk).toBe(true);
    expect(result.rehearsalReport.interruptedEvolutionResumeOk).toBe(true);

    // Invariant 5: Evidence Bundle Completeness
    expect(result.evidenceBundle).toBeDefined();
    expect(result.evidenceBundle.summary.successRate).toBeDefined();
    expect(result.evidenceBundle.summary.latencyPercentilesMs.p50).toBeGreaterThanOrEqual(0);
    expect(result.evidenceBundle.summary.latencyPercentilesMs.p95).toBeGreaterThanOrEqual(0);
    expect(result.evidenceBundle.faultTimeline).toBeDefined();
    expect(result.evidenceBundle.sanitizedLogs.length).toBeGreaterThan(0);
  });

  it("should enforce tenant isolation during concurrent synthetic execution", async () => {
    const runner = new SoakRunner({
      tenantCount: 3,
      durationMs: 1500,
      concurrency: 3,
      enableFaultInjection: false,
      verbose: false,
    });

    const result = await runner.runSoak();
    expect(result.passed).toBe(true);
    expect(result.metrics.candidatesSynthesized).toBeGreaterThanOrEqual(3);
  });
});
