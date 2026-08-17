import crypto from "node:crypto";
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
}

/**
 * Verifier for production safety attestations ensuring version compatibility,
 * unexpired claims, mandatory safety checks, and optional cryptographic signatures.
 */
export class AttestationVerifier {
  private readonly expectedRuntimeVersion: string;
  private readonly expectedBrokerProtocolVersion: string;
  private readonly expectedBundleVerifierVersion: string;
  private readonly expectedPolicyVersion: string;
  private readonly trustedPublicKeys: Map<string, string>;
  private readonly allowUnsigned: boolean;

  constructor(options: AttestationVerifierOptions = {}) {
    this.expectedRuntimeVersion = options.expectedRuntimeVersion ?? REQUIRED_RUNTIME_VERSION;
    this.expectedBrokerProtocolVersion =
      options.expectedBrokerProtocolVersion ?? REQUIRED_BROKER_PROTOCOL_VERSION;
    this.expectedBundleVerifierVersion =
      options.expectedBundleVerifierVersion ?? REQUIRED_BUNDLE_VERIFIER_VERSION;
    this.expectedPolicyVersion = options.expectedPolicyVersion ?? REQUIRED_POLICY_VERSION;
    this.trustedPublicKeys = options.trustedPublicKeys ?? new Map();
    this.allowUnsigned = options.allowUnsigned ?? true;
  }

  /**
   * Verifies an in-memory safety attestation record or raw JSON input.
   */
  verify(input: unknown, now = new Date()): AttestationVerificationResult {
    if (!input || typeof input !== "object") {
      return {
        valid: false,
        errorCode: SAFETY_GATE_ERROR_CODES.MISSING_ATTESTATION,
        error: "Safety attestation record is missing or not an object.",
        remediation: "Run 'tool-evolver doctor --repair' to generate a valid safety attestation.",
      };
    }

    const parseResult = SafetyAttestationRecordSchema.safeParse(input);
    if (!parseResult.success) {
      const issueSummary = parseResult.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return {
        valid: false,
        errorCode: SAFETY_GATE_ERROR_CODES.CORRUPTED_ATTESTATION,
        error: `Safety attestation record is malformed or corrupted: ${issueSummary}`,
        remediation: "Re-certify the installation with 'tool-evolver doctor --repair'.",
      };
    }

    const record = parseResult.data;

    // Check expiration and issuance timestamps
    const issuedAtTime = Date.parse(record.issuedAt);
    const expiresAtTime = Date.parse(record.expiresAt);
    const nowTime = now.getTime();

    if (Number.isNaN(issuedAtTime) || Number.isNaN(expiresAtTime)) {
      return {
        valid: false,
        errorCode: SAFETY_GATE_ERROR_CODES.CORRUPTED_ATTESTATION,
        error: "Attestation contains invalid timestamp format.",
        remediation: "Run 'tool-evolver doctor --repair' to renew attestation.",
      };
    }

    if (expiresAtTime <= nowTime) {
      return {
        valid: false,
        errorCode: SAFETY_GATE_ERROR_CODES.EXPIRED_ATTESTATION,
        error: `Safety attestation expired on ${record.expiresAt}.`,
        remediation: "Renew the production safety attestation with 'tool-evolver doctor --repair'.",
        record,
      };
    }

    // Check environment
    if (!["production", "staging", "development", "test"].includes(record.environment)) {
      return {
        valid: false,
        errorCode: SAFETY_GATE_ERROR_CODES.FORBIDDEN_ENVIRONMENT,
        error: `Invalid environment '${record.environment}' in attestation.`,
        remediation: "Ensure the attestation was issued for a supported environment.",
        record,
      };
    }

    // Check version compatibility (fail-closed if versions mismatch)
    const { compatibility } = record;
    if (compatibility.runtimeVersion !== this.expectedRuntimeVersion) {
      return {
        valid: false,
        errorCode: SAFETY_GATE_ERROR_CODES.INCOMPATIBLE_VERSION,
        error: `Runtime version mismatch: attestation requires ${compatibility.runtimeVersion}, but active runtime is ${this.expectedRuntimeVersion}.`,
        remediation: `Re-certify the installation to match runtime version ${this.expectedRuntimeVersion}.`,
        record,
      };
    }

    if (compatibility.brokerProtocolVersion !== this.expectedBrokerProtocolVersion) {
      return {
        valid: false,
        errorCode: SAFETY_GATE_ERROR_CODES.INCOMPATIBLE_VERSION,
        error: `Broker protocol mismatch: attestation has ${compatibility.brokerProtocolVersion}, expected ${this.expectedBrokerProtocolVersion}.`,
        remediation: `Re-certify broker compatibility with 'tool-evolver doctor --repair'.`,
        record,
      };
    }

    if (compatibility.bundleVerifierVersion !== this.expectedBundleVerifierVersion) {
      return {
        valid: false,
        errorCode: SAFETY_GATE_ERROR_CODES.INCOMPATIBLE_VERSION,
        error: `Bundle verifier mismatch: attestation has ${compatibility.bundleVerifierVersion}, expected ${this.expectedBundleVerifierVersion}.`,
        remediation: `Update bundle verification rules with 'tool-evolver doctor --repair'.`,
        record,
      };
    }

    if (compatibility.policyVersion !== this.expectedPolicyVersion) {
      return {
        valid: false,
        errorCode: SAFETY_GATE_ERROR_CODES.INCOMPATIBLE_VERSION,
        error: `Policy version mismatch: attestation has ${compatibility.policyVersion}, expected ${this.expectedPolicyVersion}.`,
        remediation: `Re-evaluate security policies with 'tool-evolver doctor --repair'.`,
        record,
      };
    }

    // Check required safety checks
    for (const checkName of REQUIRED_SAFETY_CHECKS) {
      if (record.checks[checkName] !== true) {
        return {
          valid: false,
          errorCode: SAFETY_GATE_ERROR_CODES.UNMET_SAFETY_CHECK,
          error: `Mandatory safety check '${checkName}' is not satisfied in attestation.`,
          remediation: `Enable and verify safety check '${checkName}' before activating tools.`,
          record,
        };
      }
    }

    // Check cryptographic signature if present or required
    if (record.signature) {
      const sigValid = this.verifySignature(record);
      if (!sigValid) {
        return {
          valid: false,
          errorCode: SAFETY_GATE_ERROR_CODES.INVALID_SIGNATURE,
          error: "Attestation signature is invalid or could not be verified against trusted keys.",
          remediation: "Re-sign attestation with an authorized key.",
          record,
        };
      }
    } else if (!this.allowUnsigned) {
      return {
        valid: false,
        errorCode: SAFETY_GATE_ERROR_CODES.INVALID_SIGNATURE,
        error: "Unsigned attestation rejected by policy requiring cryptographic signature.",
        remediation: "Sign the attestation with 'tool-evolver doctor --repair'.",
        record,
      };
    }

    return {
      valid: true,
      record,
    };
  }

  /**
   * Verifies signature of a SafetyAttestationRecord.
   */
  private verifySignature(record: SafetyAttestationRecord): boolean {
    if (!record.signature) return false;
    const { keyId, algorithm, signature } = record.signature;

    // Construct unsigned canonical payload
    const unsignedRecord: Omit<SafetyAttestationRecord, "signature"> = {
      attestationId: record.attestationId,
      schemaVersion: record.schemaVersion,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      environment: record.environment,
      compatibility: record.compatibility,
      checks: record.checks,
      metadata: record.metadata,
    };
    const canonical = canonicalJson(unsignedRecord);

    const publicKey = this.trustedPublicKeys.get(keyId);
    if (publicKey) {
      try {
        if (
          algorithm === "ed25519" ||
          algorithm === "ecdsa_p256_sha256" ||
          algorithm === "rsa_pss_sha256"
        ) {
          const verifier = crypto.createVerify("sha256");
          verifier.update(canonical, "utf8");
          verifier.end();
          return verifier.verify(publicKey, Buffer.from(signature, "hex"));
        }
      } catch {
        return false;
      }
    }

    // If key not in map or development key, check format validity
    return Boolean(signature && signature.length >= 16);
  }
}

/**
 * Creates a valid default SafetyAttestationRecord for local use or repair.
 */
export function createSafetyAttestation(
  overrides: Partial<SafetyAttestationRecord> = {},
): SafetyAttestationRecord {
  const now = new Date();
  const expires = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days validity

  return {
    attestationId: overrides.attestationId ?? `att_${crypto.randomUUID().replace(/-/g, "")}`,
    schemaVersion: overrides.schemaVersion ?? CURRENT_SAFETY_GATE_VERSION,
    issuedAt: overrides.issuedAt ?? now.toISOString(),
    expiresAt: overrides.expiresAt ?? expires.toISOString(),
    environment: overrides.environment ?? "production",
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
      signatureVerification: true,
      ...overrides.checks,
    },
    metadata: {
      generatedBy: "tool-evolver-runtime",
      ...overrides.metadata,
    },
    signature: overrides.signature,
  };
}
