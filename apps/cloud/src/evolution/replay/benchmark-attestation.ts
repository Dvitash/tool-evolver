import { createHmac, timingSafeEqual } from "node:crypto";
import {
  parseBenchmarkAttestationConfig,
  readBenchmarkAttestationEnv,
} from "../../config.js";
import type { BenchmarkAttestation, WorkloadBenchmarkComparison } from "./types.js";

/**
 * Verifier for HMAC-SHA256 benchmark attestations.
 * Secret is NEVER logged or exposed.
 */
export interface BenchmarkEvidenceVerifier {
  verify(row: WorkloadBenchmarkComparison): boolean | Promise<boolean>;
}

/**
 * Options for HmacBenchmarkEvidenceVerifier construction.
 * Secret only via constructor; issuer/keyId are exact-match expectations.
 */
export interface HmacBenchmarkEvidenceVerifierOptions {
  issuer: string;
  keyId: string;
  secret: string | Uint8Array;
}

/**
 * Options for signing a benchmark row.
 */
export interface SignBenchmarkOptions {
  issuer: string;
  keyId: string;
  secret: string | Uint8Array;
}

/**
 * Stable JSON stringify with sorted keys, recursively.
 * Produces deterministic canonical representation.
 * Numeric handling: -0 normalized to 0, non-finite numbers become null (JSON spec), and undefined/function/symbol omitted.
 * Retained for generic use; benchmark canonicalization uses explicit builder below.
 */
export function stableStringify(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "number") {
    if (!Number.isFinite(value as number)) return "null";
    const n = value as number;
    return JSON.stringify(n === 0 ? 0 : n);
  }
  if (t === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = (value as unknown[]).map((v) => stableStringify(v));
    return `[${items.join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
      parts.push(`${JSON.stringify(k)}:${stableStringify(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeCanonicalNumber(value: unknown): unknown {
  if (typeof value !== "number") return value;
  if (!Number.isFinite(value)) return null;
  return value === 0 ? 0 : value;
}

function canonicalizeMetrics(metrics: unknown): string {
  const m = (metrics ?? {}) as Record<string, unknown>;
  // Explicit projection of ModelUsageMetrics stable fields only; alphabetical order for determinism.
  // Fields: cacheReadTokens, correct, inputTokens, outputTokens, redundantToolCalls, toolCalls, turns, wallTimeMs
  const parts: string[] = [];
  const add = (key: string, val: unknown, isCorrect = false) => {
    if (val === undefined) return;
    if (typeof val === "function" || typeof val === "symbol") return;
    const normalized = isCorrect ? val : normalizeCanonicalNumber(val);
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(normalized)}`);
  };
  add("cacheReadTokens", m.cacheReadTokens);
  add("correct", m.correct, true);
  add("inputTokens", m.inputTokens);
  add("outputTokens", m.outputTokens);
  add("redundantToolCalls", m.redundantToolCalls);
  add("toolCalls", m.toolCalls);
  add("turns", m.turns);
  add("wallTimeMs", m.wallTimeMs);
  return `{${parts.join(",")}}`;
}

/**
 * Canonical payload for a benchmark row.
 * Explicit projection of stable row fields only — excludes attestation and ignores any optional undefined/compatibility fields.
 * Shared by sign and verify; survives JSON stringify/parse, validation/cloning, and persistence.
 * Numeric handling: -0 normalized to 0, non-finite numbers become null.
 * Uses explicit field enumeration with sorted keys for deterministic HMAC.
 */
export function canonicalizeBenchmarkRow(
  row: Omit<WorkloadBenchmarkComparison, "attestation">,
): string {
  const r = row as unknown as Record<string, unknown>;
  const parts: string[] = [];
  const addField = (key: string, value: unknown, custom?: () => string) => {
    if (value === undefined) return;
    if (typeof value === "function" || typeof value === "symbol") return;
    const str = custom ? custom() : JSON.stringify(
      typeof value === "number" ? normalizeCanonicalNumber(value) : value,
    );
    parts.push(`${JSON.stringify(key)}:${str}`);
  };
  // Sorted alphabetical explicit projection; only signed fields, attestation omitted.
  addField("artifactDigest", r.artifactDigest);
  if (r.baseline !== undefined) addField("baseline", r.baseline, () => canonicalizeMetrics(r.baseline));
  addField("baselineCostUsd", r.baselineCostUsd);
  addField("baselineRunId", r.baselineRunId);
  addField("benchmarkId", r.benchmarkId);
  if (r.candidate !== undefined) addField("candidate", r.candidate, () => canonicalizeMetrics(r.candidate));
  addField("candidateCostUsd", r.candidateCostUsd);
  addField("candidateRevisionId", r.candidateRevisionId);
  addField("candidateRunId", r.candidateRunId);
  addField("correctnessPassed", r.correctnessPassed);
  addField("costDeltaPercent", r.costDeltaPercent);
  addField("modelId", r.modelId);
  addField("modelProvider", r.modelProvider);
  addField("observedAt", r.observedAt);
  addField("redundantVerificationCalls", r.redundantVerificationCalls);
  addField("scheduleId", r.scheduleId);
  addField("workloadInputDigest", r.workloadInputDigest);
  addField("workloadSize", r.workloadSize);
  return `{${parts.join(",")}}`;
}

function toSecretBuffer(secret: string | Uint8Array): Buffer {
  if (typeof secret === "string") {
    return Buffer.from(secret, "utf8");
  }
  if (Buffer.isBuffer(secret)) {
    return Buffer.from(secret);
  }
  // Uint8Array
  return Buffer.from(secret);
}

function isNonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

export function createBenchmarkSignature(
  row: Omit<WorkloadBenchmarkComparison, "attestation">,
  secret: string | Uint8Array,
): string {
  const secretBuf = toSecretBuffer(secret);
  if (secretBuf.length === 0) {
    throw new Error("Benchmark attestation secret must be non-empty");
  }
  const canonical = canonicalizeBenchmarkRow(row);
  return createHmac("sha256", secretBuf).update(canonical, "utf8").digest("hex");
}

export function signBenchmarkAttestation(
  row: Omit<WorkloadBenchmarkComparison, "attestation">,
  options: SignBenchmarkOptions,
): BenchmarkAttestation {
  if (!options || typeof options !== "object") {
    throw new Error("signBenchmarkAttestation options must be an object");
  }
  if (!isNonEmptyString(options.issuer)) {
    throw new Error("issuer must be a nonempty string");
  }
  if (!isNonEmptyString(options.keyId)) {
    throw new Error("keyId must be a nonempty string");
  }
  if (
    options.secret === undefined ||
    options.secret === null ||
    (typeof options.secret === "string" && (options.secret as string).length === 0) ||
    (options.secret instanceof Uint8Array && (options.secret as Uint8Array).length === 0)
  ) {
    throw new Error("secret must be a non-empty string or Uint8Array");
  }
  const signature = createBenchmarkSignature(row, options.secret);
  return {
    issuer: options.issuer,
    keyId: options.keyId,
    algorithm: "hmac-sha256",
    signature,
  };
}

export function signWorkloadBenchmark(
  row: Omit<WorkloadBenchmarkComparison, "attestation">,
  options: SignBenchmarkOptions,
): WorkloadBenchmarkComparison {
  const attestation = signBenchmarkAttestation(row, options);
  // Return new object with attestation, without mutating input
  return {
    ...(row as unknown as WorkloadBenchmarkComparison),
    attestation,
  } as WorkloadBenchmarkComparison;
}


export class HmacBenchmarkEvidenceVerifier implements BenchmarkEvidenceVerifier {
  #secret: Buffer;
  #issuer: string;
  #keyId: string;

  constructor(options: HmacBenchmarkEvidenceVerifierOptions) {
    if (!options || typeof options !== "object") {
      throw new Error("HmacBenchmarkEvidenceVerifier options must be an object");
    }
    if (!isNonEmptyString(options.issuer)) {
      throw new Error("issuer must be a nonempty string");
    }
    if (!isNonEmptyString(options.keyId)) {
      throw new Error("keyId must be a nonempty string");
    }
    if (
      options.secret === undefined ||
      options.secret === null ||
      (typeof options.secret === "string" && (options.secret as string).length === 0) ||
      (options.secret instanceof Uint8Array && (options.secret as Uint8Array).length === 0)
    ) {
      throw new Error("secret must be a non-empty string or Uint8Array");
    }
    const secretBuf = toSecretBuffer(options.secret);
    if (secretBuf.length === 0) {
      throw new Error("secret must be non-empty");
    }
    this.#issuer = options.issuer;
    this.#keyId = options.keyId;
    // Copy buffer to avoid external mutation; do not expose
    this.#secret = Buffer.from(secretBuf);
  }

  verify(row: WorkloadBenchmarkComparison): boolean {
    if (!row || typeof row !== "object") return false;
    const att = (row as unknown as Record<string, unknown>).attestation as
      | BenchmarkAttestation
      | undefined;
    if (!att || typeof att !== "object") return false;
    // Exact issuer/keyId/algorithm check — prevents key substitution
    if (att.issuer !== this.#issuer) return false;
    if (att.keyId !== this.#keyId) return false;
    if (att.algorithm !== "hmac-sha256") return false;
    if (typeof att.signature !== "string" || !/^[a-f0-9]{64}$/i.test(att.signature)) return false;

    let canonical: string;
    try {
      // Exclude attestation from canonical payload
      const { attestation: _omit, ...rowWithoutAttestation } = row as unknown as Record<
        string,
        unknown
      > & { attestation?: unknown };
      canonical = canonicalizeBenchmarkRow(
        rowWithoutAttestation as unknown as Omit<WorkloadBenchmarkComparison, "attestation">,
      );
    } catch {
      return false;
    }

    let expectedHex: string;
    try {
      expectedHex = createHmac("sha256", this.#secret).update(canonical, "utf8").digest("hex");
    } catch {
      return false;
    }

    let expectedBuf: Buffer;
    let actualBuf: Buffer;
    try {
      expectedBuf = Buffer.from(expectedHex, "hex");
      actualBuf = Buffer.from(att.signature, "hex");
    } catch {
      return false;
    }
    if (expectedBuf.length !== actualBuf.length) return false;
    try {
      return timingSafeEqual(expectedBuf, actualBuf);
    } catch {
      return false;
    }
  }

  /**
   * Helper to sign a row using this verifier's key material.
   * Useful for tests and controlled signing; not for production verification path.
   */
  sign(row: Omit<WorkloadBenchmarkComparison, "attestation">): BenchmarkAttestation {
    return signBenchmarkAttestation(row, {
      issuer: this.#issuer,
      keyId: this.#keyId,
      secret: this.#secret,
    });
  }

  /**
   * Prevent secret exposure via JSON serialization or inspection.
   */
  toJSON(): unknown {
    return {
      issuer: this.#issuer,
      keyId: this.#keyId,
      algorithm: "hmac-sha256",
    };
  }
}

/**
 * Create a HmacBenchmarkEvidenceVerifier from validated config/env.
 * Uses typed parseBenchmarkAttestationConfig; does not reimplement secret checks.
 * Secret is never logged.
 */
export function createConfiguredBenchmarkEvidenceVerifier(
  env: Record<string, string | undefined> = process.env,
): HmacBenchmarkEvidenceVerifier {
  const parsed = parseBenchmarkAttestationConfig(readBenchmarkAttestationEnv(env));
  return new HmacBenchmarkEvidenceVerifier(parsed);
}
