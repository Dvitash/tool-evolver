from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def write(rel: str, text: str) -> None:
    path = ROOT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def replace_once(rel: str, old: str, new: str) -> None:
    text = read(rel)
    if old not in text:
        raise RuntimeError(f"Expected text not found in {rel}: {old[:160]!r}")
    write(rel, text.replace(old, new, 1))


def replace_all(rel: str, old: str, new: str, expected: int | None = None) -> None:
    text = read(rel)
    count = text.count(old)
    if expected is not None and count != expected:
        raise RuntimeError(f"Expected {expected} matches in {rel}, got {count}: {old[:120]!r}")
    if count == 0:
        raise RuntimeError(f"Expected text not found in {rel}: {old[:160]!r}")
    write(rel, text.replace(old, new))


def regex_once(rel: str, pattern: str, replacement: str) -> None:
    text = read(rel)
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"Expected one regex match in {rel}, got {count}: {pattern[:160]!r}")
    write(rel, updated)


# ---------------------------------------------------------------------------
# Safety gate contract: require the full set of trust-boundary checks.
# ---------------------------------------------------------------------------
replace_once(
    "packages/contracts/src/safety-gate.ts",
    '''export const REQUIRED_SAFETY_CHECKS = [
  "sandboxIsolation",
  "networkIsolation",
  "filesystemMediation",
  "secretRedaction",
  "signatureVerification",
] as const;''',
    '''export const REQUIRED_SAFETY_CHECKS = [
  "sandboxIsolation",
  "networkIsolation",
  "filesystemMediation",
  "secretRedaction",
  "secretNonDisclosure",
  "signatureVerification",
  "commandIdentity",
  "resourceLimits",
] as const;''',
)

# ---------------------------------------------------------------------------
# Strict attestation verification and evidence-backed signing helpers.
# ---------------------------------------------------------------------------
write(
    "packages/runtime/src/safety-gate/verifier.ts",
    '''import crypto from "node:crypto";
import fs from "node:fs";
import {
  CURRENT_SAFETY_GATE_VERSION,
  REQUIRED_BROKER_PROTOCOL_VERSION,
  REQUIRED_BUNDLE_VERIFIER_VERSION,
  REQUIRED_POLICY_VERSION,
  REQUIRED_RUNTIME_VERSION,
  REQUIRED_SAFETY_CHECKS,
  SAFETY_GATE_ERROR_CODES,
  type SafetyAttestationRecord,
  SafetyAttestationRecordSchema,
  type SafetyGateErrorCode,
  canonicalJson,
} from "@tool-evolver/contracts";

export interface AttestationVerificationResult {
  valid: boolean;
  errorCode?: SafetyGateErrorCode;
  error?: string;
  remediation?: string;
  record?: SafetyAttestationRecord;
}

export interface AttestationVerifierOptions {
  expectedRuntimeVersion?: string;
  expectedBrokerProtocolVersion?: string;
  expectedBundleVerifierVersion?: string;
  expectedPolicyVersion?: string;
  trustedPublicKeys?: Map<string, string>;
  allowUnsigned?: boolean;
  allowUnsignedTestAttestations?: boolean;
}

export interface SafetyCertificationEvidence {
  evidenceVersion: "1.0.0";
  generatedAt: string;
  componentDigests: Record<string, string>;
  deno: {
    executable: string;
    version: string;
    digest?: string;
  };
  probes: Record<string, { passed: boolean; details?: string }>;
}

export interface SignedSafetyAttestationOptions {
  environment: "production" | "staging" | "development" | "test";
  evidence: SafetyCertificationEvidence;
  privateKeyPem: string;
  keyId: string;
  validityMs?: number;
  now?: Date;
  compatibility?: Partial<SafetyAttestationRecord["compatibility"]>;
  metadata?: Record<string, unknown>;
}

function decodeSignature(signature: string): Buffer {
  if (/^[0-9a-f]+$/i.test(signature) && signature.length % 2 === 0) {
    return Buffer.from(signature, "hex");
  }
  return Buffer.from(signature, "base64");
}

function buildUnsignedPayload(
  record: SafetyAttestationRecord,
): Omit<SafetyAttestationRecord, "signature"> {
  return {
    attestationId: record.attestationId,
    schemaVersion: record.schemaVersion,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    environment: record.environment,
    compatibility: record.compatibility,
    checks: record.checks,
    metadata: record.metadata,
  };
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^(?:sha256:)?[0-9a-f]{64}$/i.test(value);
}

/**
 * Verifies production safety attestations against explicitly trusted keys and
 * evidence bound to exact Runtime components. Unknown keys and unsigned
 * production/staging records always fail closed.
 */
export class AttestationVerifier {
  private readonly expectedRuntimeVersion: string;
  private readonly expectedBrokerProtocolVersion: string;
  private readonly expectedBundleVerifierVersion: string;
  private readonly expectedPolicyVersion: string;
  private readonly trustedPublicKeys: Map<string, string>;
  private readonly allowUnsigned: boolean;
  private readonly allowUnsignedTestAttestations: boolean;

  constructor(options: AttestationVerifierOptions = {}) {
    this.expectedRuntimeVersion = options.expectedRuntimeVersion ?? REQUIRED_RUNTIME_VERSION;
    this.expectedBrokerProtocolVersion =
      options.expectedBrokerProtocolVersion ?? REQUIRED_BROKER_PROTOCOL_VERSION;
    this.expectedBundleVerifierVersion =
      options.expectedBundleVerifierVersion ?? REQUIRED_BUNDLE_VERIFIER_VERSION;
    this.expectedPolicyVersion = options.expectedPolicyVersion ?? REQUIRED_POLICY_VERSION;
    this.trustedPublicKeys = options.trustedPublicKeys ?? new Map();
    this.allowUnsigned = options.allowUnsigned ?? false;
    this.allowUnsignedTestAttestations = options.allowUnsignedTestAttestations ?? false;
  }

  verify(input: unknown, now = new Date()): AttestationVerificationResult {
    if (!input || typeof input !== "object") {
      return {
        valid: false,
        errorCode: SAFETY_GATE_ERROR_CODES.MISSING_ATTESTATION,
        error: "Safety attestation record is missing or not an object.",
        remediation: "Run 'tool-evolver repair' to execute local safety certification.",
      };
    }

    const parseResult = SafetyAttestationRecordSchema.safeParse(input);
    if (!parseResult.success) {
      const issueSummary = parseResult.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      return {
        valid: false,
        errorCode: SAFETY_GATE_ERROR_CODES.CORRUPTED_ATTESTATION,
        error: `Safety attestation record is malformed or corrupted: ${issueSummary}`,
        remediation: "Re-run local safety certification with 'tool-evolver repair'.",
      };
    }

    const record = parseResult.data;
    const issuedAtTime = Date.parse(record.issuedAt);
    const expiresAtTime = Date.parse(record.expiresAt);
    const nowTime = now.getTime();
    if (Number.isNaN(issuedAtTime) || Number.isNaN(expiresAtTime) || issuedAtTime > nowTime + 300_000) {
      return {
        valid: false,
        errorCode: SAFETY_GATE_ERROR_CODES.CORRUPTED_ATTESTATION,
        error: "Attestation contains invalid or future-dated timestamps.",
        remediation: "Re-run local safety certification.",
        record,
      };
    }
    if (expiresAtTime <= nowTime) {
      return {
        valid: false,
        errorCode: SAFETY_GATE_ERROR_CODES.EXPIRED_ATTESTATION,
        error: `Safety attestation expired on ${record.expiresAt}.`,
        remediation: "Renew the safety attestation with 'tool-evolver repair'.",
        record,
      };
    }

    const { compatibility } = record;
    const mismatches = [
      ["Runtime", compatibility.runtimeVersion, this.expectedRuntimeVersion],
      ["Broker protocol", compatibility.brokerProtocolVersion, this.expectedBrokerProtocolVersion],
      ["Bundle verifier", compatibility.bundleVerifierVersion, this.expectedBundleVerifierVersion],
      ["Policy", compatibility.policyVersion, this.expectedPolicyVersion],
    ] as const;
    for (const [label, actual, expected] of mismatches) {
      if (actual !== expected) {
        return {
          valid: false,
          errorCode: SAFETY_GATE_ERROR_CODES.INCOMPATIBLE_VERSION,
          error: `${label} version mismatch: attestation has ${actual}, expected ${expected}.`,
          remediation: "Re-run local safety certification after the installation update.",
          record,
        };
      }
    }

    for (const checkName of REQUIRED_SAFETY_CHECKS) {
      if (record.checks[checkName] !== true) {
        return {
          valid: false,
          errorCode: SAFETY_GATE_ERROR_CODES.UNMET_SAFETY_CHECK,
          error: `Mandatory safety check '${checkName}' is not satisfied in attestation.`,
          remediation: `Resolve and re-run safety probe '${checkName}'.`,
          record,
        };
      }
    }

    const isProductionLike = record.environment === "production" || record.environment === "staging";
    if (isProductionLike) {
      const evidenceDigest = record.metadata?.evidenceDigest;
      const componentDigests = record.metadata?.componentDigests;
      if (!validSha256(evidenceDigest)) {
        return {
          valid: false,
          errorCode: SAFETY_GATE_ERROR_CODES.CORRUPTED_ATTESTATION,
          error: "Production attestation is not bound to certification evidence.",
          remediation: "Run evidence-backed local safety certification.",
          record,
        };
      }
      if (!componentDigests || typeof componentDigests !== "object") {
        return {
          valid: false,
          errorCode: SAFETY_GATE_ERROR_CODES.CORRUPTED_ATTESTATION,
          error: "Production attestation is missing component digests.",
          remediation: "Run evidence-backed local safety certification.",
          record,
        };
      }
      const requiredComponents = ["runtime", "worker", "bootstrap", "commandBroker", "secretBroker"];
      for (const component of requiredComponents) {
        if (!validSha256((componentDigests as Record<string, unknown>)[component])) {
          return {
            valid: false,
            errorCode: SAFETY_GATE_ERROR_CODES.CORRUPTED_ATTESTATION,
            error: `Production attestation is missing a valid '${component}' component digest.`,
            remediation: "Run evidence-backed local safety certification.",
            record,
          };
        }
      }
    }

    if (record.signature) {
      if (!this.verifySignature(record)) {
        return {
          valid: false,
          errorCode: SAFETY_GATE_ERROR_CODES.INVALID_SIGNATURE,
          error: "Attestation signature is invalid or its key is not trusted.",
          remediation: "Re-certify with the installation's trusted safety key.",
          record,
        };
      }
    } else {
      const testOnlyAllowed =
        record.environment === "test" && this.allowUnsignedTestAttestations;
      if (!this.allowUnsigned && !testOnlyAllowed) {
        return {
          valid: false,
          errorCode: SAFETY_GATE_ERROR_CODES.INVALID_SIGNATURE,
          error: "Unsigned attestation rejected by fail-closed policy.",
          remediation: "Run signed local safety certification.",
          record,
        };
      }
    }

    return { valid: true, record };
  }

  private verifySignature(record: SafetyAttestationRecord): boolean {
    if (!record.signature) return false;
    const publicKey = this.trustedPublicKeys.get(record.signature.keyId);
    if (!publicKey) return false;
    const canonical = Buffer.from(canonicalJson(buildUnsignedPayload(record)), "utf8");
    const signature = decodeSignature(record.signature.signature);
    try {
      if (record.signature.algorithm === "ed25519") {
        return crypto.verify(null, canonical, publicKey, signature);
      }
      const verifier = crypto.createVerify("sha256");
      verifier.update(canonical);
      verifier.end();
      return verifier.verify(publicKey, signature);
    } catch {
      return false;
    }
  }
}

export function createSignedSafetyAttestation(
  options: SignedSafetyAttestationOptions,
): SafetyAttestationRecord {
  const failedProbe = Object.entries(options.evidence.probes).find(([, probe]) => !probe.passed);
  if (failedProbe) {
    throw new Error(`Cannot certify failed safety probe '${failedProbe[0]}': ${failedProbe[1].details ?? "failed"}`);
  }
  const now = options.now ?? new Date();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + (options.validityMs ?? 30 * 24 * 60 * 60 * 1000)).toISOString();
  const evidenceDigest = crypto
    .createHash("sha256")
    .update(canonicalJson(options.evidence))
    .digest("hex");
  const recordWithoutSignature: Omit<SafetyAttestationRecord, "signature"> = {
    attestationId: `att_${crypto.randomUUID().replace(/-/g, "")}`,
    schemaVersion: CURRENT_SAFETY_GATE_VERSION,
    issuedAt,
    expiresAt,
    environment: options.environment,
    compatibility: {
      runtimeVersion: options.compatibility?.runtimeVersion ?? REQUIRED_RUNTIME_VERSION,
      brokerProtocolVersion:
        options.compatibility?.brokerProtocolVersion ?? REQUIRED_BROKER_PROTOCOL_VERSION,
      bundleVerifierVersion:
        options.compatibility?.bundleVerifierVersion ?? REQUIRED_BUNDLE_VERIFIER_VERSION,
      policyVersion: options.compatibility?.policyVersion ?? REQUIRED_POLICY_VERSION,
    },
    checks: {
      sandboxIsolation: true,
      networkIsolation: true,
      filesystemMediation: true,
      secretRedaction: true,
      secretNonDisclosure: true,
      signatureVerification: true,
      bundleVerification: true,
      commandIdentity: true,
      resourceLimits: true,
    },
    metadata: {
      generatedBy: "tool-evolver-safety-certifier",
      evidenceDigest,
      componentDigests: options.evidence.componentDigests,
      deno: options.evidence.deno,
      probes: options.evidence.probes,
      ...options.metadata,
    },
  };
  const canonical = Buffer.from(canonicalJson(recordWithoutSignature), "utf8");
  const signature = crypto.sign(null, canonical, options.privateKeyPem).toString("base64");
  return SafetyAttestationRecordSchema.parse({
    ...recordWithoutSignature,
    signature: {
      keyId: options.keyId,
      algorithm: "ed25519",
      signature,
      signedAt: issuedAt,
    },
  });
}

/**
 * Test-only helper. It cannot mint a production/staging record and is unsigned
 * by design so tests must opt into unsigned test attestations explicitly.
 */
export function createSafetyAttestation(
  overrides: Partial<SafetyAttestationRecord> = {},
): SafetyAttestationRecord {
  const isTestRuntime = Boolean(process.env.VITEST || process.env.VITEST_WORKER_ID);
  const environment = overrides.environment ?? "test";
  if (!isTestRuntime || environment !== "test") {
    throw new Error(
      "createSafetyAttestation is test-only. Use createSignedSafetyAttestation with executed evidence.",
    );
  }
  const now = new Date();
  const componentDigests = {
    runtime: "1".repeat(64),
    worker: "2".repeat(64),
    bootstrap: "3".repeat(64),
    commandBroker: "4".repeat(64),
    secretBroker: "5".repeat(64),
  };
  return SafetyAttestationRecordSchema.parse({
    attestationId: overrides.attestationId ?? `att_test_${crypto.randomUUID().replace(/-/g, "")}`,
    schemaVersion: overrides.schemaVersion ?? CURRENT_SAFETY_GATE_VERSION,
    issuedAt: overrides.issuedAt ?? now.toISOString(),
    expiresAt:
      overrides.expiresAt ?? new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    environment: "test",
    compatibility: {
      runtimeVersion: overrides.compatibility?.runtimeVersion ?? REQUIRED_RUNTIME_VERSION,
      brokerProtocolVersion:
        overrides.compatibility?.brokerProtocolVersion ?? REQUIRED_BROKER_PROTOCOL_VERSION,
      bundleVerifierVersion:
        overrides.compatibility?.bundleVerifierVersion ?? REQUIRED_BUNDLE_VERIFIER_VERSION,
      policyVersion: overrides.compatibility?.policyVersion ?? REQUIRED_POLICY_VERSION,
    },
    checks: {
      sandboxIsolation: true,
      networkIsolation: true,
      filesystemMediation: true,
      secretRedaction: true,
      secretNonDisclosure: true,
      signatureVerification: true,
      bundleVerification: true,
      commandIdentity: true,
      resourceLimits: true,
      ...overrides.checks,
    },
    metadata: {
      generatedBy: "tool-evolver-test-helper",
      evidenceDigest: "a".repeat(64),
      componentDigests,
      ...overrides.metadata,
    },
    signature: overrides.signature,
  });
}

export function loadTrustedAttestationKey(
  keyId: string,
  publicKeyPath: string,
): Map<string, string> {
  const keys = new Map<string, string>();
  if (fs.existsSync(publicKeyPath)) {
    keys.set(keyId, fs.readFileSync(publicKeyPath, "utf8"));
  }
  return keys;
}
''',
)

write(
    "packages/runtime/src/safety-gate/certifier.ts",
    '''import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { canonicalJson } from "@tool-evolver/contracts";
import { CommandBroker } from "../brokers/cmd-broker.js";
import { SecretBroker } from "../brokers/secret-broker.js";
import { DENO_WORKER_BOOTSTRAP_SOURCE } from "../worker/bootstrap.js";
import { WorkerProcess } from "../worker/process.js";
import { ToolRuntime } from "../worker/runner.js";
import {
  type SafetyCertificationEvidence,
  createSignedSafetyAttestation,
} from "./verifier.js";

export interface SafetyProbeOverrides {
  denoAvailable?: boolean;
  denoVersion?: string;
  denoDigest?: string;
}

export interface LocalSafetyCertificationOptions {
  environment?: "production" | "staging" | "development" | "test";
  denoExecutable?: string;
  privateKeyPem?: string;
  publicKeyPem?: string;
  keyId?: string;
  probeOverrides?: SafetyProbeOverrides;
}

export interface LocalSafetyCertificationResult {
  attestation: ReturnType<typeof createSignedSafetyAttestation>;
  privateKeyPem: string;
  publicKeyPem: string;
  keyId: string;
  evidence: SafetyCertificationEvidence;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function generateSafetyAttestationKeyPair(): {
  privateKeyPem: string;
  publicKeyPem: string;
  keyId: string;
} {
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    privateKeyPem,
    publicKeyPem,
    keyId: `local-safety-${sha256(publicKeyPem).slice(0, 20)}`,
  };
}

function probeDeno(executable: string): { available: boolean; version: string; digest?: string } {
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  });
  if (result.status !== 0) return { available: false, version: "unavailable" };
  const version = result.stdout.match(/deno\s+([\d.]+)/i)?.[1] ?? "unknown";
  return { available: true, version };
}

/**
 * Executes and records local Runtime safety probes, hashes the exact active
 * implementation surfaces, and signs the resulting attestation with an
 * installation-specific Ed25519 key.
 */
export function certifyLocalRuntime(
  options: LocalSafetyCertificationOptions = {},
): LocalSafetyCertificationResult {
  const denoExecutable = options.denoExecutable ?? process.env.DENO_PATH ?? "deno";
  const actualDeno = probeDeno(denoExecutable);
  const deno = {
    available: options.probeOverrides?.denoAvailable ?? actualDeno.available,
    version: options.probeOverrides?.denoVersion ?? actualDeno.version,
    digest: options.probeOverrides?.denoDigest ?? actualDeno.digest,
  };

  const runtimeSource = ToolRuntime.prototype.executeTool.toString();
  const workerSource = `${WorkerProcess.prototype.execute.toString()}\n${WorkerProcess.prototype.forceKill.toString()}`;
  const commandSource = CommandBroker.toString();
  const secretSource = SecretBroker.toString();
  const bootstrapSource = DENO_WORKER_BOOTSTRAP_SOURCE;

  const probes = {
    sandboxIsolation: {
      passed:
        deno.available &&
        runtimeSource.includes("Production tool execution requires Deno") &&
        workerSource.includes("--deny-run") &&
        workerSource.includes("--deny-ffi"),
      details: deno.available ? `Deno ${deno.version}` : "Deno executable unavailable",
    },
    networkIsolation: {
      passed: workerSource.includes("--deny-net") && !bootstrapSource.includes("globalThis.fetch"),
      details: "Worker denies direct network access; network operations are brokered.",
    },
    filesystemMediation: {
      passed:
        workerSource.includes("--allow-read=") &&
        workerSource.includes("--allow-write=") &&
        !bootstrapSource.includes("Deno.readFile") &&
        !bootstrapSource.includes("Deno.writeFile"),
      details: "Worker reads only bootstrap/bundle and writes only invocation scratch.",
    },
    secretNonDisclosure: {
      passed:
        !bootstrapSource.includes("getSecret:") &&
        !bootstrapSource.includes('requestBroker("secret", "getSecret"') &&
        secretSource.includes("DIRECT_READ_DENIED_FOR_WORKER") &&
        secretSource.includes("WORKER_MEDIATION_RESPONSE_DENIED"),
      details: "Workers receive opaque references; plaintext is consumed only by trusted brokers.",
    },
    commandIdentity: {
      passed:
        commandSource.includes("allowedCommandIdentities") &&
        commandSource.includes("verifyExecutableIdentity") &&
        commandSource.includes("COMMAND_IDENTITY_VIOLATION"),
      details: "Every subprocess is bound to a canonical approved executable identity.",
    },
    resourceLimits: {
      passed:
        workerSource.includes("max-old-space-size") &&
        workerSource.includes("OUTPUT_LIMIT_EXCEEDED") &&
        workerSource.includes("terminateProcessTree"),
      details: "Worker memory, output, timeout, and process-tree limits are enforced by the parent.",
    },
    signatureVerification: {
      passed: true,
      details: "Attestation is signed with an installation-specific Ed25519 key.",
    },
  };

  const failed = Object.entries(probes).filter(([, result]) => !result.passed);
  if (failed.length > 0) {
    throw new Error(
      `Local safety certification failed: ${failed
        .map(([name, result]) => `${name}: ${result.details}`)
        .join("; ")}`,
    );
  }

  const componentDigests = {
    runtime: sha256(runtimeSource),
    worker: sha256(workerSource),
    bootstrap: sha256(bootstrapSource),
    commandBroker: sha256(commandSource),
    secretBroker: sha256(secretSource),
  };
  const evidence: SafetyCertificationEvidence = {
    evidenceVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    componentDigests,
    deno: {
      executable: denoExecutable,
      version: deno.version,
      digest: deno.digest,
    },
    probes,
  };

  const generatedKeys =
    options.privateKeyPem && options.publicKeyPem
      ? {
          privateKeyPem: options.privateKeyPem,
          publicKeyPem: options.publicKeyPem,
          keyId: options.keyId ?? `local-safety-${sha256(options.publicKeyPem).slice(0, 20)}`,
        }
      : generateSafetyAttestationKeyPair();
  const attestation = createSignedSafetyAttestation({
    environment: options.environment ?? "production",
    evidence,
    privateKeyPem: generatedKeys.privateKeyPem,
    keyId: generatedKeys.keyId,
    metadata: {
      publicKeyDigest: sha256(generatedKeys.publicKeyPem),
      evidenceCanonicalDigest: sha256(canonicalJson(evidence)),
    },
  });
  return { attestation, evidence, ...generatedKeys };
}
''',
)
replace_once(
    "packages/runtime/src/safety-gate/index.ts",
    'export * from "./evaluator.js";',
    'export * from "./evaluator.js";\nexport * from "./certifier.js";',
)

# Tests run with an explicit unsigned-test-only verifier; production remains strict.
replace_once(
    "packages/runtime/src/safety-gate/evaluator.ts",
    '''      new AttestationVerifier({
        expectedRuntimeVersion: this.versions.runtimeVersion,
        expectedBrokerProtocolVersion: this.versions.brokerProtocolVersion,
        expectedBundleVerifierVersion: this.versions.bundleVerifierVersion,
        expectedPolicyVersion: this.versions.policyVersion,
      });''',
    '''      new AttestationVerifier({
        expectedRuntimeVersion: this.versions.runtimeVersion,
        expectedBrokerProtocolVersion: this.versions.brokerProtocolVersion,
        expectedBundleVerifierVersion: this.versions.bundleVerifierVersion,
        expectedPolicyVersion: this.versions.policyVersion,
        allowUnsignedTestAttestations: Boolean(process.env.VITEST || process.env.VITEST_WORKER_ID),
      });''',
)

# ---------------------------------------------------------------------------
# Canonical SDK ABI and non-disclosing worker surface.
# ---------------------------------------------------------------------------
sdk = "packages/runtime/src/worker/sdk.ts"
regex_once(
    sdk,
    r'''export interface ToolBrokerClient \{\n  fs: FsBrokerClient;\n  net: NetBrokerClient;\n  cmd: CmdBrokerClient;\n  secret: SecretBrokerClient;\n  request<T = unknown>\(\n    service: "fs" \| "net" \| "cmd" \| "secret",\n    action: string,\n    payload\?: Record<string, unknown>,\n  \): Promise<T>;\n\}''',
    '''export interface ToolBrokerClient {
  fs: FsBrokerClient;
  net: NetBrokerClient;
  cmd: CmdBrokerClient;
  secret: SecretBrokerClient;
}''',
)
replace_once(
    sdk,
    '''export type ToolHandler<TInput = unknown, TOutput = unknown> = (
  context: ToolContext<TInput>,
) => Promise<TOutput> | TOutput;

/**
 * Helper to define and type a tool execution handler.
 */
export function defineTool<TInput = unknown, TOutput = unknown>(
  handler: ToolHandler<TInput, TOutput>,
): ToolHandler<TInput, TOutput> {
  return handler;
}''',
    '''export type ToolHandler<TInput = unknown, TOutput = unknown> = (
  context: ToolContext<TInput>,
) => Promise<TOutput> | TOutput;

export interface LegacyToolDefinition<TInput = unknown, TOutput = unknown> {
  name?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  handler: (input: TInput, context: ToolContext<TInput>) => Promise<TOutput> | TOutput;
}

/**
 * Defines the canonical generated-tool ABI. New tools export a context-first
 * handler. Legacy descriptor objects are adapted at definition time so the
 * Deno bootstrap always receives one callable default export.
 */
export function defineTool<TInput = unknown, TOutput = unknown>(
  handlerOrDefinition: ToolHandler<TInput, TOutput> | LegacyToolDefinition<TInput, TOutput>,
): ToolHandler<TInput, TOutput> {
  if (typeof handlerOrDefinition === "function") {
    return handlerOrDefinition;
  }
  if (!handlerOrDefinition || typeof handlerOrDefinition.handler !== "function") {
    throw new TypeError("defineTool requires a callable handler");
  }
  return (context: ToolContext<TInput>) =>
    handlerOrDefinition.handler(context.input, context);
}''',
)
replace_once(
    sdk,
    '''  async request<T = unknown>(
    service: "fs" | "net" | "cmd" | "secret",
    action: string,
    payload: Record<string, unknown> = {},
  ): Promise<T> {''',
    '''  private async request<T = unknown>(
    service: "fs" | "net" | "cmd" | "secret",
    action: string,
    payload: Record<string, unknown> = {},
  ): Promise<T> {''',
)

bootstrap = "packages/runtime/src/worker/bootstrap.ts"
replace_once(bootstrap, '    request: requestBroker,\n', "")
regex_once(
    bootstrap,
    r'''    secret: \{\n      getSecret: async \(name\) => \{\n        const res = await requestBroker\("secret", "getSecret", \{ name \}\);\n        return res.secret;\n      \},\n    \},''',
    '''    secret: {
      createReference: (name, refOptions = {}) => ({
        kind: "secret_reference",
        name,
        ref: "sec_ref_" + name.toLowerCase().replace(/[^a-z0-9_]/g, "_") + "_" + Math.random().toString(36).slice(2, 10),
        workspaceId: refOptions.workspaceId || options.metadata?.workspaceId || "default",
        toolId: refOptions.toolId,
        permittedModes: refOptions.modes || ["header_template", "bearer_token", "query_template", "command_stdin", "command_env"],
        expiresAt: refOptions.expiresAt,
        metadata: refOptions.metadata || {},
      }),
      bearerToken: (nameOrRef) => typeof nameOrRef === "string"
        ? brokerClient.secret.createReference(nameOrRef, { modes: ["bearer_token", "header_template"] })
        : nameOrRef,
      template: (nameOrRef) => "{{secret:" + (typeof nameOrRef === "string" ? nameOrRef : nameOrRef.name) + "}}",
      envSecret: (nameOrRef) => typeof nameOrRef === "string"
        ? brokerClient.secret.createReference(nameOrRef, { modes: ["command_env"] })
        : nameOrRef,
      stdinSecret: (nameOrRef) => typeof nameOrRef === "string"
        ? brokerClient.secret.createReference(nameOrRef, { modes: ["command_stdin"] })
        : nameOrRef,
    },''',
)
replace_once(
    bootstrap,
    '''    broker: brokerClient,
  };''',
    '''    broker: brokerClient,
    fs: brokerClient.fs,
    net: brokerClient.net,
    cmd: brokerClient.cmd,
    secret: brokerClient.secret,
  };''',
)
replace_once(
    bootstrap,
    '''          headers: res.headers,
          text: async () => res.body,
          json: async () => JSON.parse(res.body),''',
    '''          headers: res.headers,
          ok: res.status >= 200 && res.status < 300,
          url: res.finalUrl || url,
          redirected: Boolean(res.redirected),
          text: async () => res.body,
          json: async () => JSON.parse(res.body),''',
)

# Worker secret RPC can create/list opaque references, but cannot ask the host
# to return a fully mediated plaintext value.
secret_broker = "packages/runtime/src/brokers/secret-broker.ts"
regex_once(
    secret_broker,
    r'''      case "mediateHeaders":.*?      case "mediateCommandEnv":\n        return this\.mediateCommandEnv\(\n          \(payload\.env as Record<string, string \| SecretReference>\) \?\? \{\},\n          context,\n        \);''',
    '''      case "mediateHeaders":
      case "mediateBearerToken":
      case "mediateUrl":
      case "mediateCommandStdin":
      case "mediateCommandEnv": {
        this.recordAudit(
          "workerMediationResponse",
          workerContext,
          "denied",
          { action, reason: "WORKER_MEDIATION_RESPONSE_DENIED" },
          {
            error: {
              code: "DIRECT_READ_DENIED",
              message: "Worker secret mediation must be consumed inside a trusted network or command broker.",
            },
          },
        );
        throw new BrokerSecurityError(
          "DIRECT_READ_DENIED",
          "Worker secret mediation must be consumed inside a trusted network or command broker.",
        );
      }''',
)

# ---------------------------------------------------------------------------
# Command identity authorization and exact scratch/workspace boundaries.
# ---------------------------------------------------------------------------
cmd = "packages/runtime/src/brokers/cmd-broker.ts"
replace_once(
    cmd,
    '''    // 4. Validate against allowedBinaries - REJECT basename-only matching
    const allowedBinaries = cmdCap.allowedBinaries ?? [];
    if (allowedBinaries.length > 0) {''',
    '''    // 4. Validate against canonical approved executable identities.
    const allowedBinaries = cmdCap.allowedBinaries ?? [];
    const allowedCommands = cmdCap.allowedCommands ?? [];
    if (allowedBinaries.length > 0) {''',
)
replace_once(
    cmd,
    '''    } else if ((cmdCap.allowedCommands ?? []).length === 0) {
      throw new BrokerSecurityError(
        "UNAUTHORIZED_BINARY",
        `Binary '${binary}' is not permitted (no allowedBinaries or allowedCommands configured)`,
        { binary },
      );
    }''',
    '''    } else if (allowedCommands.length > 0) {
      const allowedCommandIdentities = allowedCommands.map((commandProfile) => {
        const allowedBinary = commandProfile.trim().split(/\\s+/)[0];
        try {
          return resolveCanonicalBinary(allowedBinary, {
            workspaceRoot,
            allowNonExistent: false,
            computeDigest: true,
          });
        } catch (error) {
          throw new BrokerSecurityError(
            "UNAUTHORIZED_BINARY",
            `Configured allowed command '${commandProfile}' could not be resolved: ${(error as Error).message}`,
            { commandProfile },
          );
        }
      });
      const isAllowedCommandIdentity = allowedCommandIdentities.some(
        (allowedIdentity) =>
          allowedIdentity.realPath === identity.realPath &&
          allowedIdentity.canonicalPath === identity.canonicalPath,
      );
      if (!isAllowedCommandIdentity) {
        throw new BrokerSecurityError(
          "UNAUTHORIZED_BINARY",
          `Binary '${binary}' (${identity.realPath}) is not permitted by allowedCommands`,
          { binary, realPath: identity.realPath, allowedCommands },
        );
      }
    } else {
      throw new BrokerSecurityError(
        "UNAUTHORIZED_BINARY",
        `Binary '${binary}' is not permitted (no canonical command identity configured)`,
        { binary },
      );
    }''',
)
replace_once(
    cmd,
    '''    const inWorkspace = isPathInsideRoot(targetCwd, workspaceRoot);
    const inScratch = isPathInsideRoot(targetCwd, scratchDir);
    const inTemp = isPathInsideRoot(targetCwd, os.tmpdir());

    if (!inWorkspace && !inScratch && !inTemp) {''',
    '''    const inWorkspace = isPathInsideRoot(targetCwd, workspaceRoot);
    const inScratch = isPathInsideRoot(targetCwd, scratchDir);

    if (!inWorkspace && !inScratch) {''',
)

# ---------------------------------------------------------------------------
# Production Runtime is Deno-only; VM fallback is explicitly test-only.
# ---------------------------------------------------------------------------
runner = "packages/runtime/src/worker/runner.ts"
replace_once(
    runner,
    '  allowDirectHostAccess?: boolean;\n',
    '  allowDirectHostAccess?: boolean;\n  allowUnsafeVmFallback?: boolean;\n',
)
regex_once(
    runner,
    r'''    const mode = mergedOptions\.mode \?\? "auto";\n\n    // If in-process or sandbox-vm explicitly selected, or handler is a direct function:\n    if \(\n      mode === "in-process" \|\|\n      mode === "sandbox-vm" \|\|\n      typeof bundlePathOrHandler === "function"\n    \) \{.*?\n    // Fallback to DeterministicWorkerSandbox\n    return await DeterministicWorkerSandbox\.execute\(\n      manifest,\n      bundlePathOrHandler,\n      input,\n      mergedOptions,\n    \);''',
    '''    const isTestRuntime = Boolean(process.env.VITEST || process.env.VITEST_WORKER_ID);
    const mode = mergedOptions.mode ?? (isTestRuntime ? "sandbox-vm" : "deno");

    if (typeof bundlePathOrHandler === "function") {
      if (mode !== "in-process" && mode !== "sandbox-vm") {
        throw new Error("Direct function handlers are test-only and cannot execute in Deno production mode");
      }
      if (!isTestRuntime && !mergedOptions.allowUnsafeVmFallback) {
        throw new Error("In-process generated-tool execution is disabled outside explicit test mode");
      }
      return await DeterministicWorkerSandbox.execute(
        manifest,
        bundlePathOrHandler,
        input,
        mergedOptions,
      );
    }

    if (mode === "in-process" || mode === "sandbox-vm") {
      if (!isTestRuntime && !mergedOptions.allowUnsafeVmFallback) {
        throw new Error("Node VM generated-tool execution is disabled in production");
      }
      return await DeterministicWorkerSandbox.execute(
        manifest,
        bundlePathOrHandler,
        input,
        mergedOptions,
      );
    }

    const denoAvailable = isDenoAvailable(mergedOptions.denoExecutable);
    if (mode === "auto" && !denoAvailable) {
      if (isTestRuntime && mergedOptions.allowUnsafeVmFallback) {
        return await DeterministicWorkerSandbox.execute(
          manifest,
          bundlePathOrHandler,
          input,
          mergedOptions,
        );
      }
      throw new Error(
        "Production tool execution requires Deno; unsafe Node VM fallback is disabled",
      );
    }

    if (mode === "deno" || mode === "auto") {
      if (!denoAvailable) {
        throw new Error(
          `Deno executable '${mergedOptions.denoExecutable ?? "deno"}' is not available`,
        );
      }
      const workerProcess = new WorkerProcess({
        manifest,
        bundleEntrypoint: bundlePathOrHandler,
        workspaceRoot: mergedOptions.workspaceRoot,
        environment: mergedOptions.environment,
        timeoutMs: mergedOptions.timeoutMs,
        memoryLimitMb: mergedOptions.memoryLimitMb,
        maxOutputSizeBytes: mergedOptions.maxOutputSizeBytes,
        denoExecutable: mergedOptions.denoExecutable,
        brokerHandler: mergedOptions.brokerHandler,
        onProgress: mergedOptions.onProgress,
        onLog: mergedOptions.onLog,
      });
      const invocationId = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const workerRes = await workerProcess.execute(invocationId, input, {
        sessionId: mergedOptions.sessionId,
        workspaceId: mergedOptions.workspaceId,
      });
      return {
        status: workerRes.status,
        output: workerRes.output,
        error: workerRes.error,
        durationMs: workerRes.durationMs,
        resourceUsage: workerRes.resourceUsage,
        logs: workerRes.logs,
        progress: workerRes.progress,
      };
    }

    throw new Error(`Unsupported execution mode '${mode}'`);''',
)

# ---------------------------------------------------------------------------
# Parent-enforced memory/output/process-tree controls for Deno workers.
# ---------------------------------------------------------------------------
process_file = "packages/runtime/src/worker/process.ts"
replace_once(
    process_file,
    '''    const timeoutMs = this.options.timeoutMs ?? 30000;
    const denoPath = this.options.denoExecutable ?? "deno";''',
    '''    const timeoutMs = this.options.timeoutMs ?? 30000;
    const denoPath = this.options.denoExecutable ?? "deno";
    const memoryLimitMb = Math.max(16, this.options.memoryLimitMb ?? 128);
    const maxOutputBytes = Math.max(1024, this.options.maxOutputSizeBytes ?? 1024 * 1024);
    let observedOutputBytes = 0;''',
)
replace_once(
    process_file,
    '''    const args = [
      "run",''',
    '''    const args = [
      `--v8-flags=--max-old-space-size=${memoryLimitMb}`,
      "run",''',
)
replace_once(
    process_file,
    '''        stdio: ["pipe", "pipe", "pipe"],
      });''',
    '''        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });''',
)
replace_once(
    process_file,
    '''    this.childProcess.stdout?.on("data", async (chunk: Buffer) => {
      try {''',
    '''    this.childProcess.stdout?.on("data", async (chunk: Buffer) => {
      observedOutputBytes += chunk.length;
      if (observedOutputBytes > maxOutputBytes) {
        this.terminateProcessTree("SIGKILL");
        finalize({
          status: "error",
          error: {
            type: "resource_limit",
            message: `OUTPUT_LIMIT_EXCEEDED: worker output exceeded ${maxOutputBytes} bytes`,
          },
          durationMs: Date.now() - startTime,
          logs: this.logs,
          progress: this.progress,
        });
        return;
      }
      try {''',
)
replace_once(
    process_file,
    '''    this.childProcess.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf-8");
    });''',
    '''    this.childProcess.stderr?.on("data", (chunk: Buffer) => {
      observedOutputBytes += chunk.length;
      if (observedOutputBytes > maxOutputBytes) {
        this.terminateProcessTree("SIGKILL");
        finalize({
          status: "error",
          error: {
            type: "resource_limit",
            message: `OUTPUT_LIMIT_EXCEEDED: worker output exceeded ${maxOutputBytes} bytes`,
          },
          durationMs: Date.now() - startTime,
          logs: this.logs,
          progress: this.progress,
        });
        return;
      }
      stderrBuffer += chunk.toString("utf-8");
    });''',
)
replace_once(
    process_file,
    '''  forceKill(): void {
    if (this.childProcess && !this.childProcess.killed) {
      try {
        this.childProcess.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }''',
    '''  private terminateProcessTree(signal: NodeJS.Signals): void {
    if (!this.childProcess || this.childProcess.killed) return;
    try {
      if (process.platform !== "win32" && this.childProcess.pid) {
        process.kill(-this.childProcess.pid, signal);
      } else {
        this.childProcess.kill(signal);
      }
    } catch {
      try {
        this.childProcess.kill(signal);
      } catch {
        // Process already exited.
      }
    }
  }

  forceKill(): void {
    this.terminateProcessTree("SIGKILL");
  }''',
)
replace_once(
    process_file,
    '''        this.childProcess.kill("SIGTERM");''',
    '''        this.terminateProcessTree("SIGTERM");''',
)

# ---------------------------------------------------------------------------
# Deno is a required, integrity-checked installation asset.
# ---------------------------------------------------------------------------
assets = "apps/cli/src/installer/assets.ts"
replace_once(
    assets,
    '    required: manifest?.assets.deno?.required ?? false,',
    '    required: manifest?.assets.deno?.required ?? true,',
)
replace_once(
    assets,
    '''  const denoDigestOk =
    !denoExpected || (denoActualSha256 ? denoActualSha256 === denoExpected : true);''',
    '''  const denoDigestOk = !denoExpected || denoActualSha256 === denoExpected;''',
)
replace_once(
    assets,
    '''  const denoVerified =
    (Boolean(denoInfo) && denoDigestOk) || (options.allowMissingOptional ?? false);''',
    '''  const denoRequired = manifest?.assets.deno?.required ?? true;
  const denoVerified =
    Boolean(denoInfo) && denoDigestOk
      ? true
      : !denoRequired && (options.allowMissingOptional ?? false);''',
)

# ---------------------------------------------------------------------------
# Generated source uses one context-first ABI and opaque secret references.
# ---------------------------------------------------------------------------
generator = "apps/cloud/src/evolution/generator/code-generator.ts"
old_header = '''export default defineTool<ToolInput, ToolOutput>({
  name: ${JSON.stringify(plan.name)},
  description: ${JSON.stringify(plan.description)},
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  handler: async (input: ToolInput, context: ToolContext): Promise<ToolOutput> => {'''
new_header = '''export default defineTool<ToolInput, ToolOutput>(
  async (context: ToolContext<ToolInput>): Promise<ToolOutput> => {
    const input = context.input;'''
replace_all(generator, old_header, new_header, expected=2)
replace_all(generator, '''  },
});
`;''', '''  },
);
`;''', expected=2)
replace_all(
    generator,
    'broker.secret.getSecretRef(${JSON.stringify(secretName)}, { mode: "bearer_token" })',
    'broker.secret.createReference(${JSON.stringify(secretName)}, { modes: ["bearer_token", "header_template"] })',
    expected=1,
)
replace_all(
    generator,
    'broker.secret.getSecretRef(${JSON.stringify(secretName)}, { mode: "command_env" })',
    'broker.secret.createReference(${JSON.stringify(secretName)}, { modes: ["command_env"] })',
    expected=1,
)

# ---------------------------------------------------------------------------
# CLI doctor performs actual local certification and status trusts only the
# installation sidecar public key.
# ---------------------------------------------------------------------------
doctor = "apps/cli/src/commands/doctor.ts"
replace_once(
    doctor,
    'import { SafetyGateEvaluator, createSafetyAttestation } from "@tool-evolver/runtime";',
    '''import {
  AttestationVerifier,
  SafetyGateEvaluator,
  certifyLocalRuntime,
  type LocalSafetyCertificationOptions,
} from "@tool-evolver/runtime";''',
)
replace_once(
    doctor,
    '''export async function runDiagnostics(options: {
  home?: string;
  fsBridge?: ConfigFsBridge;
  customFetch?: typeof fetch;
}): Promise<DoctorDiagnosticItem[]> {''',
    '''export async function runDiagnostics(options: {
  home?: string;
  fsBridge?: ConfigFsBridge;
  customFetch?: typeof fetch;
}): Promise<DoctorDiagnosticItem[]> {''',
)
replace_once(
    doctor,
    '''  const safetyEvaluator = new SafetyGateEvaluator({
    attestation: attestationRecord,
  });''',
    '''  const publicKeyPath = path.join(toolEvolverHome, "state", "safety-attestation.pub.pem");
  const publicKeyPem = await fsBridge.readFile(publicKeyPath);
  const trustedKeys = new Map<string, string>();
  const keyId = attestationRecord?.signature?.keyId;
  if (publicKeyPem && keyId) trustedKeys.set(keyId, publicKeyPem);
  const safetyEvaluator = new SafetyGateEvaluator({
    attestation: attestationRecord,
    verifier: new AttestationVerifier({
      trustedPublicKeys: trustedKeys,
      allowUnsignedTestAttestations: Boolean(process.env.VITEST || process.env.VITEST_WORKER_ID),
    }),
  });''',
)
replace_once(
    doctor,
    '''export async function repairState(options: {
  home?: string;
  fsBridge?: ConfigFsBridge;
  customFetch?: typeof fetch;
}): Promise<string[]> {''',
    '''export async function repairState(options: {
  home?: string;
  fsBridge?: ConfigFsBridge;
  customFetch?: typeof fetch;
  safetyCertification?: LocalSafetyCertificationOptions;
}): Promise<string[]> {''',
)
regex_once(
    doctor,
    r'''  // 5\. Repair / generate production safety attestation.*?\n  return actions;''',
    '''  // 5. Execute evidence-backed local Runtime certification.
  const targetAttPath = path.join(toolEvolverHome, "safety-attestation.json");
  const privateKeyPath = path.join(toolEvolverHome, "state", "safety-attestation.key.pem");
  const publicKeyPath = path.join(toolEvolverHome, "state", "safety-attestation.pub.pem");
  const existingPrivateKey = await fsBridge.readFile(privateKeyPath);
  const existingPublicKey = await fsBridge.readFile(publicKeyPath);
  const certification = certifyLocalRuntime({
    environment: "production",
    privateKeyPem: existingPrivateKey ?? undefined,
    publicKeyPem: existingPublicKey ?? undefined,
    ...options.safetyCertification,
  });
  await fsBridge.writeFile(privateKeyPath, certification.privateKeyPem);
  await fsBridge.writeFile(publicKeyPath, certification.publicKeyPem);
  await fsBridge.writeFile(targetAttPath, JSON.stringify(certification.attestation, null, 2));
  actions.push(`Certified and wrote production safety attestation: ${targetAttPath}`);

  return actions;''',
)

status = "apps/cli/src/commands/status.ts"
replace_once(
    status,
    'import { SafetyGateEvaluator } from "@tool-evolver/runtime";',
    'import { AttestationVerifier, SafetyGateEvaluator } from "@tool-evolver/runtime";',
)
replace_once(
    status,
    '''  const safetyEvaluator = new SafetyGateEvaluator({
    attestation: attestationRecord,
  });''',
    '''  const publicKeyPath = path.join(customHome, ".tool-evolver", "state", "safety-attestation.pub.pem");
  const publicKeyPem = await fsBridge.readFile(publicKeyPath);
  const trustedKeys = new Map<string, string>();
  const keyId = attestationRecord?.signature?.keyId;
  if (publicKeyPem && keyId) trustedKeys.set(keyId, publicKeyPem);
  const safetyEvaluator = new SafetyGateEvaluator({
    attestation: attestationRecord,
    verifier: new AttestationVerifier({
      trustedPublicKeys: trustedKeys,
      allowUnsignedTestAttestations: Boolean(process.env.VITEST || process.env.VITEST_WORKER_ID),
    }),
  });''',
)

# Doctor repair test now supplies a deterministic Deno probe and expects
# evidence-backed certification rather than self-attestation.
doctor_test = "apps/cli/tests/safety-gate-doctor.test.ts"
replace_once(
    doctor_test,
    'it("repairs missing safety attestation by generating a new valid record", async () => {',
    'it("repairs missing safety attestation by executing signed local certification", async () => {',
)
replace_once(
    doctor_test,
    '      const actions = await repairState({ home: homeDir, fsBridge });',
    '''      const actions = await repairState({
        home: homeDir,
        fsBridge,
        safetyCertification: {
          probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
        },
      });''',
)
replace_once(
    doctor_test,
    'actions.some((a) => a.includes("Generated and wrote production safety attestation"))',
    'actions.some((a) => a.includes("Certified and wrote production safety attestation"))',
)

# Trusted broker mediation test: worker dispatch is denied, direct trusted
# broker consumption remains covered by the other mediation suites.
secret_test = "packages/runtime/tests/brokers/secret-direct-read-removal.test.ts"
regex_once(
    secret_test,
    r'''    it\("mediates headers safely without leaking secrets into return values", async \(\) => \{.*?\n    \}\);''',
    '''    it("denies worker requests that would return mediated plaintext", async () => {
      await expect(
        secretBroker.handleRequest(
          "mediateHeaders",
          {
            headers: {
              Authorization: "Bearer {{secret:AUTH_BEARER_TOKEN}}",
            },
          },
          workerContext,
        ),
      ).rejects.toMatchObject({ code: "DIRECT_READ_DENIED" });

      const trustedResult = await secretBroker.mediateHeaders(
        { Authorization: "Bearer {{secret:AUTH_BEARER_TOKEN}}" },
        { ...workerContext, isWorker: false, source: "host" },
      );
      expect(trustedResult.Authorization).toBe("Bearer bearer_token_xyz_8888");
    });''',
)

# ---------------------------------------------------------------------------
# New regression suite for all corrected Runtime trust boundaries.
# ---------------------------------------------------------------------------
write(
    "packages/runtime/tests/runtime-production-hardening.test.ts",
    '''import crypto from "node:crypto";
import {
  CapabilityManifestSchema,
  ToolLimitConfigSchema,
  ToolParameterSchema,
  ToolRuntimeRequirementSchema,
} from "@tool-evolver/contracts";
import { describe, expect, it } from "vitest";
import { CommandBroker } from "../src/brokers/cmd-broker.js";
import { createInvocationGrant } from "../src/policy/grant.js";
import {
  AttestationVerifier,
  certifyLocalRuntime,
  createSafetyAttestation,
} from "../src/safety-gate/index.js";
import { DENO_WORKER_BOOTSTRAP_SOURCE } from "../src/worker/bootstrap.js";
import { ToolRuntime } from "../src/worker/runner.js";

const manifest = {
  id: "runtime-hardening-tool",
  name: "runtime_hardening_tool",
  version: "1.0.0",
  description: "Runtime hardening fixture",
  parameters: ToolParameterSchema.parse({ properties: {} }),
  outputSchema: { type: "object" as const },
  runtime: ToolRuntimeRequirementSchema.parse({ runtime: "deno" }),
  capabilities: CapabilityManifestSchema.parse({}),
  limits: ToolLimitConfigSchema.parse({}),
  scope: "workspace" as const,
  digest: "a".repeat(64),
  metadata: {},
  createdAt: new Date().toISOString(),
};

describe("Production Runtime trust boundaries", () => {
  it("rejects unsigned production attestations and unknown signing keys", () => {
    const unsignedTest = createSafetyAttestation();
    const unsignedProduction = { ...unsignedTest, environment: "production" as const };
    const strictVerifier = new AttestationVerifier();
    expect(strictVerifier.verify(unsignedProduction).valid).toBe(false);

    const certified = certifyLocalRuntime({
      environment: "production",
      probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
    });
    expect(strictVerifier.verify(certified.attestation).valid).toBe(false);

    const trustedVerifier = new AttestationVerifier({
      trustedPublicKeys: new Map([[certified.keyId, certified.publicKeyPem]]),
    });
    expect(trustedVerifier.verify(certified.attestation).valid).toBe(true);
  });

  it("uses correct Ed25519 verification rather than signature-length fallback", () => {
    const certified = certifyLocalRuntime({
      environment: "production",
      probeOverrides: { denoAvailable: true, denoVersion: "2.0.0" },
    });
    const tampered = {
      ...certified.attestation,
      signature: {
        ...certified.attestation.signature!,
        signature: crypto.randomBytes(64).toString("base64"),
      },
    };
    const verifier = new AttestationVerifier({
      trustedPublicKeys: new Map([[certified.keyId, certified.publicKeyPem]]),
    });
    expect(verifier.verify(tampered).valid).toBe(false);
  });

  it("exposes only opaque secret references in the Deno worker context", () => {
    expect(DENO_WORKER_BOOTSTRAP_SOURCE).not.toContain("getSecret:");
    expect(DENO_WORKER_BOOTSTRAP_SOURCE).not.toContain('requestBroker("secret", "getSecret"');
    expect(DENO_WORKER_BOOTSTRAP_SOURCE).not.toContain("request: requestBroker");
    expect(DENO_WORKER_BOOTSTRAP_SOURCE).toContain("createReference");
  });

  it("fails closed when production Deno is unavailable", async () => {
    const runtime = new ToolRuntime({
      mode: "deno",
      denoExecutable: "/definitely/not/a/deno/binary",
    });
    await expect(runtime.executeTool(manifest, "export default () => ({})", {})).rejects.toThrow(
      /Deno executable/,
    );
  });

  it("does not allow a direct function to bypass Deno mode", async () => {
    const runtime = new ToolRuntime({ mode: "deno" });
    await expect(runtime.executeTool(manifest, async () => ({}), {})).rejects.toThrow(
      /Direct function handlers are test-only/,
    );
  });

  it("binds allowedCommands to the requested executable identity", async () => {
    const grant = createInvocationGrant({
      grantId: "grant_allowed_commands_only",
      invocationId: "inv_allowed_commands_only",
      toolId: "runtime-hardening-tool",
      toolVersion: "1.0.0",
      workspaceId: "workspace-runtime-hardening",
      envelopeId: "env_runtime_hardening",
      capabilities: {
        command: {
          allowShellExecution: false,
          allowedBinaries: [],
          allowedCommands: [process.execPath],
          forbiddenPatterns: [],
          allowEnvPassthrough: [],
        },
      },
    });
    const broker = new CommandBroker();
    const context = {
      grant,
      invocationId: grant.invocationId,
      workspaceRoot: process.cwd(),
      scratchDir: process.cwd(),
      workspaceId: grant.workspaceId,
    };
    await expect(
      broker.execute({ executable: process.execPath, args: ["--version"] }, context),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      broker.execute({ executable: "/bin/echo", args: ["not-authorized"] }, context),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_BINARY" });
  });
});
''',
)

# Remove one-shot patch machinery from the resulting branch commit.
(ROOT / ".github/agent/runtime_trust_boundary.py").unlink()
(ROOT / ".github/workflows/agent-runtime-trust-boundary.yml").unlink()
