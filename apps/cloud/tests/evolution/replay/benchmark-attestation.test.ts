import { describe, expect, it } from "vitest";
import {
  HmacBenchmarkEvidenceVerifier,
  signWorkloadBenchmark,
  signBenchmarkAttestation,
  canonicalizeBenchmarkRow,
  stableStringify } from "../../../src/evolution/replay/benchmark-attestation.js";
import {
  calculateWeightedModelCost,
  MODEL_COST_SCHEDULE_ID_V1 } from "../../../src/evolution/replay/types.js";
import type { WorkloadBenchmarkComparison, ModelUsageMetrics } from "../../../src/evolution/replay/types.js";

const ISSUER = "test-issuer";
const KEY_ID = "test-key-1";
const SECRET = "super-secret-for-tests-32bytes!!";
const WRONG_SECRET = "wrong-secret-32bytes!!-different";

function makeMetrics(overrides: Partial<ModelUsageMetrics> = {}): ModelUsageMetrics {
  return {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 200,
    turns: 2,
    toolCalls: 3,
    redundantToolCalls: 0,
    wallTimeMs: 1200,
    correct: true,
    ...overrides };
}

function makeRow(
  overrides: Partial<Omit<WorkloadBenchmarkComparison, "attestation">> = {},
): Omit<WorkloadBenchmarkComparison, "attestation"> {
  const baseline = makeMetrics(overrides.baseline as Partial<ModelUsageMetrics> | undefined);
  const candidate = makeMetrics({
    inputTokens: 800,
    outputTokens: 400,
    cacheReadTokens: 100,
    turns: 2,
    toolCalls: 2,
    redundantToolCalls: 0,
    wallTimeMs: 1000,
    correct: true,
    ...((overrides.candidate as unknown as Partial<ModelUsageMetrics>) ?? {}) });
  // If overrides provide baseline/candidate directly, use them
  const finalBaseline = (overrides.baseline as ModelUsageMetrics) ?? baseline;
  const finalCandidate = (overrides.candidate as ModelUsageMetrics) ?? candidate;
  const scheduleId =
    (overrides.scheduleId as string) ?? MODEL_COST_SCHEDULE_ID_V1;
  const baselineCostUsd =
    (overrides.baselineCostUsd as number) ??
    calculateWeightedModelCost(finalBaseline, scheduleId);
  const candidateCostUsd =
    (overrides.candidateCostUsd as number) ??
    calculateWeightedModelCost(finalCandidate, scheduleId);
  const costDeltaPercent =
    (overrides.costDeltaPercent as number) ??
    (baselineCostUsd === 0 ? 0 : ((candidateCostUsd - baselineCostUsd) / baselineCostUsd) * 100);

  return {
    workloadSize: "small",
    baseline: finalBaseline,
    candidate: finalCandidate,
    baselineCostUsd,
    candidateCostUsd,
    costDeltaPercent,
    correctnessPassed: finalCandidate.correct,
    redundantVerificationCalls: finalCandidate.redundantToolCalls,
    benchmarkId: "bench-small-01",
    baselineRunId: "baseline-run-01",
    candidateRunId: "candidate-run-01",
    workloadInputDigest: "a".repeat(64),
    candidateRevisionId: "rev_valid_01",
    artifactDigest: "d".repeat(64),
    modelProvider: "test-provider",
    modelId: "test-model",
    observedAt: "2026-08-20T12:00:00.000Z",
    scheduleId,
    ...overrides
  } as unknown as Omit<WorkloadBenchmarkComparison, "attestation">;
}

describe("BenchmarkAttestation HMAC-SHA256", () => {
  it("valid signature verifies", () => {
    const row = makeRow();
    const verifier = new HmacBenchmarkEvidenceVerifier({
      issuer: ISSUER,
      keyId: KEY_ID,
      secret: SECRET });
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    expect(signed.attestation.issuer).toBe(ISSUER);
    expect(signed.attestation.keyId).toBe(KEY_ID);
    expect(signed.attestation.algorithm).toBe("hmac-sha256");
    expect(signed.attestation.signature).toMatch(/^[a-f0-9]{64}$/i);
    expect(verifier.verify(signed)).toBe(true);
    // Also via signBenchmarkAttestation
    const att = signBenchmarkAttestation(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    expect(att.signature).toBe(signed.attestation.signature);
  });

  it("any token change fails (baseline inputTokens)", () => {
    const row = makeRow();
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const verifier = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const tampered = {
      ...signed,
      baseline: { ...signed.baseline, inputTokens: signed.baseline.inputTokens + 1 } } as WorkloadBenchmarkComparison;
    // Need to recompute costs? If we don't recompute, costs will mismatch but signature should still fail due to baseline change
    expect(verifier.verify(tampered)).toBe(false);
  });

  it("any token change fails (candidate outputTokens)", () => {
    const row = makeRow();
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const verifier = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const tampered = {
      ...signed,
      candidate: { ...signed.candidate, outputTokens: signed.candidate.outputTokens + 10 } } as WorkloadBenchmarkComparison;
    expect(verifier.verify(tampered)).toBe(false);
  });

  it("correctness change fails", () => {
    const row = makeRow();
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const verifier = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    // Flip candidate.correct and derived fields
    const tamperedCandidate = { ...signed.candidate, correct: false };
    const tampered = {
      ...signed,
      candidate: tamperedCandidate,
      correctnessPassed: false } as WorkloadBenchmarkComparison;
    // Need to adjust costs if tokens same, costs same, but correctness changed -> signature should fail because candidate.correct is part of canonical
    expect(verifier.verify(tampered)).toBe(false);
    // Also flipping only correctnessPassed without candidate.correct should fail (derived inconsistency, but signature covers both)
    const tampered2 = { ...signed, correctnessPassed: false } as WorkloadBenchmarkComparison;
    expect(verifier.verify(tampered2)).toBe(false);
  });

  it("redundancy change fails", () => {
    const row = makeRow();
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const verifier = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const tamperedCandidate = { ...signed.candidate, redundantToolCalls: 5 };
    const tampered = {
      ...signed,
      candidate: tamperedCandidate,
      redundantVerificationCalls: 5 } as WorkloadBenchmarkComparison;
    expect(verifier.verify(tampered)).toBe(false);
    // Only redundantVerificationCalls
    const tampered2 = { ...signed, redundantVerificationCalls: 999 } as WorkloadBenchmarkComparison;
    expect(verifier.verify(tampered2)).toBe(false);
  });

  it("workload change fails", () => {
    const row = makeRow();
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const verifier = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const tampered = { ...signed, workloadSize: "medium" } as unknown as WorkloadBenchmarkComparison;
    expect(verifier.verify(tampered)).toBe(false);
  });

  it("revision change fails", () => {
    const row = makeRow();
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const verifier = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const tampered = { ...signed, candidateRevisionId: "rev_tampered" } as WorkloadBenchmarkComparison;
    expect(verifier.verify(tampered)).toBe(false);
  });

  it("digest change fails (artifactDigest)", () => {
    const row = makeRow();
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const verifier = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const tampered = { ...signed, artifactDigest: "e".repeat(64) } as WorkloadBenchmarkComparison;
    expect(verifier.verify(tampered)).toBe(false);
  });

  it("digest change fails (workloadInputDigest)", () => {
    const row = makeRow();
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const verifier = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const tampered = { ...signed, workloadInputDigest: "f".repeat(64) } as WorkloadBenchmarkComparison;
    expect(verifier.verify(tampered)).toBe(false);
  });

  it("model change fails (modelProvider/modelId)", () => {
    const row = makeRow();
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const verifier = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const tampered1 = { ...signed, modelProvider: "other-provider" } as WorkloadBenchmarkComparison;
    expect(verifier.verify(tampered1)).toBe(false);
    const tampered2 = { ...signed, modelId: "other-model" } as WorkloadBenchmarkComparison;
    expect(verifier.verify(tampered2)).toBe(false);
  });

  it("timestamp change fails", () => {
    const row = makeRow();
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const verifier = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const tampered = { ...signed, observedAt: "2026-08-21T12:00:00.000Z" } as WorkloadBenchmarkComparison;
    expect(verifier.verify(tampered)).toBe(false);
  });

  it("scheduleId change fails", () => {
    const row = makeRow();
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const verifier = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const tampered = { ...signed, scheduleId: "OTHER_SCHEDULE" } as unknown as WorkloadBenchmarkComparison;
    expect(verifier.verify(tampered)).toBe(false);
  });

  it("benchmarkId change fails", () => {
    const row = makeRow();
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const verifier = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const tampered = { ...signed, benchmarkId: "bench-tampered" } as WorkloadBenchmarkComparison;
    expect(verifier.verify(tampered)).toBe(false);
  });

  it("run IDs change fails", () => {
    const row = makeRow();
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const verifier = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const tampered1 = { ...signed, baselineRunId: "baseline-tampered" } as WorkloadBenchmarkComparison;
    expect(verifier.verify(tampered1)).toBe(false);
    const tampered2 = { ...signed, candidateRunId: "candidate-tampered" } as WorkloadBenchmarkComparison;
    expect(verifier.verify(tampered2)).toBe(false);
  });

  it("derived cost tamper fails", () => {
    const row = makeRow();
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const verifier = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const tampered = { ...signed, baselineCostUsd: 9999 } as WorkloadBenchmarkComparison;
    expect(verifier.verify(tampered)).toBe(false);
    const tampered2 = { ...signed, costDeltaPercent: 123 } as WorkloadBenchmarkComparison;
    expect(verifier.verify(tampered2)).toBe(false);
  });

  it("wrong key fails", () => {
    const row = makeRow();
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const verifierWrong = new HmacBenchmarkEvidenceVerifier({
      issuer: ISSUER,
      keyId: KEY_ID,
      secret: WRONG_SECRET });
    expect(verifierWrong.verify(signed)).toBe(false);
  });

  it("wrong issuer fails", () => {
    const row = makeRow();
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const verifier = new HmacBenchmarkEvidenceVerifier({
      issuer: "other-issuer",
      keyId: KEY_ID,
      secret: SECRET });
    expect(verifier.verify(signed)).toBe(false);
    // Also tampered issuer in row
    const tampered = {
      ...signed,
      attestation: { ...signed.attestation, issuer: "other-issuer" } } as WorkloadBenchmarkComparison;
    const verifier2 = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    expect(verifier2.verify(tampered)).toBe(false);
  });

  it("wrong keyId fails", () => {
    const row = makeRow();
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const verifier = new HmacBenchmarkEvidenceVerifier({
      issuer: ISSUER,
      keyId: "other-key",
      secret: SECRET });
    expect(verifier.verify(signed)).toBe(false);
    const tampered = {
      ...signed,
      attestation: { ...signed.attestation, keyId: "other-key" } } as WorkloadBenchmarkComparison;
    const verifier2 = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    expect(verifier2.verify(tampered)).toBe(false);
  });

  it("signature tamper fails", () => {
    const row = makeRow();
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const verifier = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const tampered = {
      ...signed,
      attestation: {
        ...signed.attestation,
        signature: "00".repeat(32) } } as WorkloadBenchmarkComparison;
    expect(verifier.verify(tampered)).toBe(false);
    // Flipping one hex char
    const sig = signed.attestation.signature;
    const flipped = sig.slice(0, 63) + (sig[63] === "a" ? "b" : "a");
    const tampered2 = {
      ...signed,
      attestation: { ...signed.attestation, signature: flipped } } as WorkloadBenchmarkComparison;
    expect(verifier.verify(tampered2)).toBe(false);
  });

  it("missing attestation fails", () => {
    const row = makeRow();
    const verifier = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const withoutAtt = row as unknown as WorkloadBenchmarkComparison;
    expect(verifier.verify(withoutAtt)).toBe(false);
  });

  it("algorithm mismatch fails", () => {
    const row = makeRow();
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const verifier = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const tampered = {
      ...signed,
      attestation: { ...signed.attestation, algorithm: "hmac-sha512" } } as unknown as WorkloadBenchmarkComparison;
    expect(verifier.verify(tampered)).toBe(false);
  });

  it("no secret exposure", () => {
    const verifier = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    // Secret should not be enumerable or via JSON
    const json = JSON.stringify(verifier);
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain("super-secret");
    // Own property names should not include secret
    const ownProps = Object.getOwnPropertyNames(verifier);
    expect(ownProps).not.toContain("secret");
    expect(ownProps).not.toContain("#secret");
    expect(ownProps).not.toContain("_secret");
    // Check that verifier object doesn't have secret value as property value
    const values = Object.values(verifier as unknown as Record<string, unknown>);
    for (const v of values) {
      if (typeof v === "string") expect(v).not.toBe(SECRET);
      if (v instanceof Uint8Array) expect(Buffer.from(v).toString()).not.toBe(SECRET);
    }
    // toJSON should not leak secret
    const toJson = (verifier as unknown as { toJSON?: () => unknown }).toJSON?.();
    if (toJson) {
      expect(JSON.stringify(toJson)).not.toContain(SECRET);
    }
    // Ensure private field not accessible via bracket
    expect((verifier as unknown as Record<string, unknown>).secret).toBeUndefined();
    expect((verifier as unknown as Record<string, unknown>).SECRET).toBeUndefined();
  });

  it("canonical payload is deterministic and excludes signature", () => {
    const row = makeRow();
    const canonical1 = canonicalizeBenchmarkRow(row);
    const canonical2 = canonicalizeBenchmarkRow(row);
    expect(canonical1).toBe(canonical2);
    // Ensure canonical does not contain signature
    expect(canonical1).not.toContain("signature");
    // Ensure it contains expected fields
    expect(canonical1).toContain("benchmarkId");
    expect(canonical1).toContain("scheduleId");
    expect(canonical1).toContain("inputTokens");
    expect(canonical1).toContain("observedAt");
    expect(canonical1).toContain("candidateRevisionId");
    expect(canonical1).toContain("artifactDigest");
    // Stable stringify sorts keys
    const objA = { b: 2, a: 1 };
    const objB = { a: 1, b: 2 };
    expect(stableStringify(objA)).toBe(stableStringify(objB));
  });

  it("Uint8Array secret works", () => {
    const row = makeRow();
    const secretBytes = new TextEncoder().encode(SECRET);
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: secretBytes });
    const verifier = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: secretBytes });
    expect(verifier.verify(signed)).toBe(true);
    const verifierString = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    expect(verifierString.verify(signed)).toBe(true);
  });

  it("cacheReadTokens change fails", () => {
    const row = makeRow();
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const verifier = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const tampered = {
      ...signed,
      baseline: { ...signed.baseline, cacheReadTokens: 999 } } as WorkloadBenchmarkComparison;
    expect(verifier.verify(tampered)).toBe(false);
  });

  it("turns/toolCalls/wallTimeMs change fails", () => {
    const row = makeRow();
    const signed = signWorkloadBenchmark(row, { issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const verifier = new HmacBenchmarkEvidenceVerifier({ issuer: ISSUER, keyId: KEY_ID, secret: SECRET });
    const tamperedTurns = { ...signed, candidate: { ...signed.candidate, turns: 99 } } as WorkloadBenchmarkComparison;
    expect(verifier.verify(tamperedTurns)).toBe(false);
    const tamperedCalls = { ...signed, baseline: { ...signed.baseline, toolCalls: 99 } } as WorkloadBenchmarkComparison;
    expect(verifier.verify(tamperedCalls)).toBe(false);
    const tamperedWall = { ...signed, candidate: { ...signed.candidate, wallTimeMs: 9999 } } as WorkloadBenchmarkComparison;
    expect(verifier.verify(tamperedWall)).toBe(false);
  });
});
