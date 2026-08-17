import fs from "node:fs";
import {
  type ProductionSafetyGateStatus,
  REQUIRED_BROKER_PROTOCOL_VERSION,
  REQUIRED_BUNDLE_VERIFIER_VERSION,
  REQUIRED_POLICY_VERSION,
  REQUIRED_RUNTIME_VERSION,
  SAFETY_GATE_ERROR_CODES,
  type SafetyAttestationRecord,
  type SafetyGateRefusal,
  UNSAFE_DEV_OVERRIDE_ENV_VAR,
  isSafetyGateBypassTool,
} from "@tool-evolver/contracts";
import { AttestationVerifier } from "./verifier.js";

export class SafetyGateRefusalError extends Error {
  readonly refusal: SafetyGateRefusal;

  constructor(refusal: SafetyGateRefusal) {
    super(refusal.refusalReason);
    this.name = "SafetyGateRefusalError";
    this.refusal = refusal;
  }
}

export interface SafetyGateEvaluatorOptions {
  attestation?: SafetyAttestationRecord | null;
  attestationPath?: string;
  allowUnsafeDevOverride?: boolean;
  versions?: {
    runtimeVersion?: string;
    brokerProtocolVersion?: string;
    bundleVerifierVersion?: string;
    policyVersion?: string;
  };
  verifier?: AttestationVerifier;
}

/**
 * Evaluates production readiness safety state and enforces fail-closed execution policies
 * for autonomously generated tools while ensuring system/meta-tools remain operational.
 */
export class SafetyGateEvaluator {
  private attestation: SafetyAttestationRecord | null = null;
  private readonly attestationPath?: string;
  private readonly allowUnsafeDevOverride: boolean;
  private readonly versions: {
    runtimeVersion: string;
    brokerProtocolVersion: string;
    bundleVerifierVersion: string;
    policyVersion: string;
  };
  private readonly verifier: AttestationVerifier;

  constructor(options: SafetyGateEvaluatorOptions = {}) {
    this.attestationPath = options.attestationPath;
    this.allowUnsafeDevOverride = options.allowUnsafeDevOverride ?? false;

    this.versions = {
      runtimeVersion: options.versions?.runtimeVersion ?? REQUIRED_RUNTIME_VERSION,
      brokerProtocolVersion:
        options.versions?.brokerProtocolVersion ?? REQUIRED_BROKER_PROTOCOL_VERSION,
      bundleVerifierVersion:
        options.versions?.bundleVerifierVersion ?? REQUIRED_BUNDLE_VERIFIER_VERSION,
      policyVersion: options.versions?.policyVersion ?? REQUIRED_POLICY_VERSION,
    };

    this.verifier =
      options.verifier ??
      new AttestationVerifier({
        expectedRuntimeVersion: this.versions.runtimeVersion,
        expectedBrokerProtocolVersion: this.versions.brokerProtocolVersion,
        expectedBundleVerifierVersion: this.versions.bundleVerifierVersion,
        expectedPolicyVersion: this.versions.policyVersion,
      });

    if (options.attestation !== undefined) {
      this.attestation = options.attestation;
    } else if (this.attestationPath) {
      this.loadFromDisk();
    }
  }

  /**
   * Sets or clears the in-memory attestation record.
   */
  setAttestation(record: SafetyAttestationRecord | null): void {
    this.attestation = record;
  }

  /**
   * Reads and parses the attestation file from disk if path configured.
   */
  loadFromDisk(): boolean {
    if (!this.attestationPath) return false;
    try {
      if (!fs.existsSync(this.attestationPath)) {
        this.attestation = null;
        return false;
      }
      const raw = fs.readFileSync(this.attestationPath, "utf8");
      const parsed = JSON.parse(raw);
      this.attestation = parsed as SafetyAttestationRecord;
      return true;
    } catch {
      this.attestation = null;
      return false;
    }
  }

  /**
   * Checks if unsafe development override is active via config or environment.
   */
  isUnsafeOverrideActive(): boolean {
    if (this.allowUnsafeDevOverride) {
      return true;
    }
    const envVal = process.env[UNSAFE_DEV_OVERRIDE_ENV_VAR]?.trim().toLowerCase();
    return envVal === "1" || envVal === "true" || envVal === "yes";
  }

  /**
   * Evaluates the comprehensive safety gate status.
   */
  getStatus(now = new Date()): ProductionSafetyGateStatus {
    const evaluatedAt = now.toISOString();

    // 1. Unsafe developer override check
    if (this.isUnsafeOverrideActive()) {
      return {
        isOpen: true,
        status: "unsafe_override",
        evaluatedAt,
        versions: this.versions,
        reasons: [
          "Unsafe development override is active (TOOL_EVOLVER_UNSAFE_ALLOW_AUTONOMOUS). Autonomous tool execution permitted without production attestation.",
        ],
        unmetRequirements: [],
        attestation: this.attestation ?? undefined,
        unsafeOverrideActive: true,
      };
    }

    // 2. Missing attestation check
    if (!this.attestation) {
      return {
        isOpen: false,
        status: "uninitialized",
        evaluatedAt,
        versions: this.versions,
        reasons: [
          "No production safety attestation found. Autonomous tool execution is fail-closed and blocked.",
        ],
        unmetRequirements: [
          {
            code: SAFETY_GATE_ERROR_CODES.MISSING_ATTESTATION,
            message: "Missing production safety attestation record.",
            remediation:
              "Run 'tool-evolver doctor --repair' or install a valid safety-attestation.json to activate autonomous execution.",
          },
        ],
        unsafeOverrideActive: false,
      };
    }

    // 3. Verification of attestation record
    const verification = this.verifier.verify(this.attestation, now);
    if (!verification.valid) {
      const code = verification.errorCode ?? SAFETY_GATE_ERROR_CODES.GATE_FAIL_CLOSED;
      const message = verification.error ?? "Safety attestation verification failed.";
      const remediation =
        verification.remediation ??
        "Re-certify the installation with 'tool-evolver doctor --repair'.";

      return {
        isOpen: false,
        status: "failed",
        evaluatedAt,
        versions: this.versions,
        reasons: [message],
        unmetRequirements: [
          {
            code,
            message,
            remediation,
          },
        ],
        attestation: verification.record ?? this.attestation ?? undefined,
        unsafeOverrideActive: false,
      };
    }

    // 4. Fully verified and open
    return {
      isOpen: true,
      status: "passed",
      evaluatedAt,
      versions: this.versions,
      reasons: ["Production readiness safety attestation successfully verified."],
      unmetRequirements: [],
      attestation: verification.record,
      unsafeOverrideActive: false,
    };
  }

  /**
   * Evaluates whether a tool may be executed or activated.
   * Invariant: Built-in and system meta-tools always bypass the gate.
   */
  canExecuteTool(
    toolId: string,
    toolName: string,
    isSystem = false,
    now = new Date(),
  ): { allowed: boolean; refusal?: SafetyGateRefusal } {
    if (isSystem || isSafetyGateBypassTool(toolId) || isSafetyGateBypassTool(toolName)) {
      return { allowed: true };
    }

    const status = this.getStatus(now);
    if (status.isOpen) {
      return { allowed: true };
    }

    const primaryCode =
      status.unmetRequirements[0]?.code ?? SAFETY_GATE_ERROR_CODES.GATE_FAIL_CLOSED;
    const primaryReason =
      status.reasons.join("; ") || "Autonomous tool execution blocked by safety gate.";
    const primaryRemediation =
      status.unmetRequirements[0]?.remediation ??
      "Run 'tool-evolver doctor --repair' to resolve safety gate issues.";

    const refusal: SafetyGateRefusal = {
      isError: true,
      refusalCode: primaryCode,
      refusalReason: `Autonomous execution of generated tool '${toolName || toolId}' is blocked by the production safety gate: ${primaryReason}`,
      remediation: primaryRemediation,
      unmetGates: status.unmetRequirements.map((r) => r.code),
      evaluatedAt: status.evaluatedAt,
      content: [
        {
          type: "text",
          text: `[SAFETY GATE REFUSAL] Autonomous tool '${toolName || toolId}' execution blocked (${primaryCode}).\nReason: ${primaryReason}\nRemediation: ${primaryRemediation}`,
        },
      ],
      details: {
        toolId,
        toolName,
        gateStatus: status.status,
        versions: status.versions,
        unmetRequirements: status.unmetRequirements,
      },
    };

    return { allowed: false, refusal };
  }

  /**
   * Asserts that a tool can execute, throwing SafetyGateRefusalError if fail-closed.
   */
  assertCanExecuteTool(toolId: string, toolName: string, isSystem = false, now = new Date()): void {
    const check = this.canExecuteTool(toolId, toolName, isSystem, now);
    if (!check.allowed && check.refusal) {
      throw new SafetyGateRefusalError(check.refusal);
    }
  }

  /**
   * Verifies the filesystem broker boundary invariant.
   * Ensures that workspace filesystem access is mediated strictly through the broker
   * and that direct Deno worker access is prevented.
   */
  verifyFilesystemBrokerBoundary(now = new Date()): { valid: boolean; error?: string } {
    const status = this.getStatus(now);
    if (!status.isOpen) {
      return {
        valid: false,
        error: status.reasons.join("; ") || "Production safety gate is closed",
      };
    }

    if (status.status === "unsafe_override") {
      return { valid: true };
    }

    if (!status.attestation || status.attestation.checks.filesystemMediation !== true) {
      return {
        valid: false,
        error:
          "Filesystem broker mediation invariant check failed: filesystemMediation attestation check is unmet.",
      };
    }

    return { valid: true };
  }
}
