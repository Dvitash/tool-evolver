import { randomUUID } from "node:crypto";
import { hashCanonicalContent } from "@tool-evolver/contracts";
import type {
  CanaryMetricsWindow,
  EvidenceVerificationBundle,
  EvidenceVerificationResult,
  RolloutDecision,
  RolloutEntity,
  RolloutOverrideRecord,
  RolloutPolicy,
  RolloutTelemetryEvent,
} from "./types.js";

/**
 * Parameters for evaluating canary telemetry against rollout policies.
 */
export interface EvaluateCanaryMetricsParams {
  rollout: RolloutEntity;
  policy: RolloutPolicy;
  metrics: CanaryMetricsWindow;
  evidenceBundle?: EvidenceVerificationBundle | null;
  userOverride?: RolloutOverrideRecord | null;
  now?: string;
}

/**
 * Computes p50, p95, and p99 percentiles from an array of latencies in milliseconds.
 */
export function computeLatencyPercentiles(latencies: number[]): {
  p50: number;
  p95: number;
  p99: number;
} {
  if (latencies.length === 0) {
    return { p50: 0, p95: 0, p99: 0 };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const n = sorted.length;

  const getPercentile = (p: number): number => {
    const rank = (p / 100) * (n - 1);
    const low = Math.floor(rank);
    const high = Math.ceil(rank);
    const weight = rank - low;
    return sorted[low] * (1 - weight) + sorted[high] * weight;
  };

  return {
    p50: Math.round(getPercentile(50)),
    p95: Math.round(getPercentile(95)),
    p99: Math.round(getPercentile(99)),
  };
}
/**
 * Deterministically verifies the integrity, freshness, and hard evaluation gates of an evidence bundle.
 */
export function verifyRolloutEvidence(
  bundle: EvidenceVerificationBundle,
  options: { maxEvidenceAgeMs?: number } = {},
): EvidenceVerificationResult {
  const maxAgeMs = options.maxEvidenceAgeMs ?? 24 * 60 * 60 * 1000;
  const now = Date.now();
  const reasons: string[] = [];

  // 1. Signature validity
  const signatureValid = Boolean(
    bundle.signature &&
      typeof bundle.signature.signature === "string" &&
      bundle.signature.signature.length > 0 &&
      bundle.signature.keyId,
  );
  if (!signatureValid) {
    reasons.push("Missing or invalid cryptographic signature metadata");
  }

  // 2. Digest matching
  let digestsMatch = true;
  if (bundle.manifest) {
    const computedManifestDigest = hashCanonicalContent(bundle.manifest);
    if (bundle.manifestDigest && bundle.manifestDigest !== computedManifestDigest) {
      digestsMatch = false;
      reasons.push(
        `Manifest digest mismatch: recorded '${bundle.manifestDigest}', computed '${computedManifestDigest}'`,
      );
    }
  }

  // 3. Evidence Freshness
  let freshnessValid = true;
  const timestampStr = bundle.evidenceFreshnessTimestamp ?? bundle.evaluatedAt;
  if (timestampStr) {
    const evidenceAgeMs = now - new Date(timestampStr).getTime();
    if (evidenceAgeMs > maxAgeMs) {
      freshnessValid = false;
      reasons.push(`Evidence is stale: age ${evidenceAgeMs}ms exceeds threshold ${maxAgeMs}ms`);
    }
  }

  // 4. Hard Evaluation Gates & Validation
  const hardGatesValid =
    bundle.hardGatesPassed !== false &&
    bundle.validationPassed !== false &&
    (bundle.replaySuccessRate === undefined || bundle.replaySuccessRate >= 0.99);
  if (!hardGatesValid) {
    reasons.push("Candidate did not satisfy hard evaluation gates or validation checks");
  }

  const valid = signatureValid && digestsMatch && freshnessValid && hardGatesValid;

  return {
    valid,
    reasons,
    verifiedAt: new Date().toISOString(),
    signatureValid,
    digestsMatch,
    freshnessValid,
    hardGatesValid,
  };
}

/**
 * Aggregates raw invocation telemetry events into a structured metrics window.
 */
export function aggregateTelemetryEvents(
  events: RolloutTelemetryEvent[],
  windowStart: string,
  windowEnd: string,
  baselineP95LatencyMs?: number,
  deviceStatus?: { activeCount: number; offlineCount: number },
): CanaryMetricsWindow {
  let totalInvocations = 0;
  let successCount = 0;
  let failureCount = 0;
  const latenciesMs: number[] = [];
  const policyViolations = 0;
  let securityViolations = 0;
  let quarantineSignals = 0;
  let capabilityBreaches = 0;
  let schemaMismatches = 0;
  let signatureValid = true;
  const quarantineReasons: string[] = [];
  const securityViolationDetails: Array<{
    type: string;
    reason: string;
    timestamp: string;
  }> = [];

  for (const event of events) {
    totalInvocations += 1;
    if (event.success) {
      successCount += 1;
    } else {
      failureCount += 1;
    }

    if (typeof event.durationMs === "number" && event.durationMs >= 0) {
      latenciesMs.push(event.durationMs);
    }

    if (event.securityViolation) {
      securityViolations += 1;
      securityViolationDetails.push({
        type: "security_violation",
        reason: event.securityViolationReason ?? "Unspecified security breach",
        timestamp: event.timestamp,
      });
    }

    if (event.quarantineSignal) {
      quarantineSignals += 1;
      if (event.quarantineReason && !quarantineReasons.includes(event.quarantineReason)) {
        quarantineReasons.push(event.quarantineReason);
      }
    }

    if (event.capabilityBreach) {
      capabilityBreaches += 1;
    }

    if (event.schemaMismatch) {
      schemaMismatches += 1;
    }

    if (event.signatureValid === false) {
      signatureValid = false;
    }
  }

  const successRate = totalInvocations > 0 ? successCount / totalInvocations : 1.0;
  const errorRate = totalInvocations > 0 ? failureCount / totalInvocations : 0.0;
  const { p50, p95, p99 } = computeLatencyPercentiles(latenciesMs);

  let latencyRegressionPercent: number | undefined;
  if (baselineP95LatencyMs && baselineP95LatencyMs > 0 && p95 > 0) {
    latencyRegressionPercent = ((p95 - baselineP95LatencyMs) / baselineP95LatencyMs) * 100;
  }

  const activeDevices = deviceStatus?.activeCount ?? 1;
  const offlineDevices = deviceStatus?.offlineCount ?? 0;
  const totalDevices = activeDevices + offlineDevices;
  const deviceReportingRate = totalDevices > 0 ? activeDevices / totalDevices : 1.0;

  return {
    windowStart,
    windowEnd,
    totalInvocations,
    successCount,
    failureCount,
    successRate,
    errorRate,
    latenciesMs,
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    p99LatencyMs: p99,
    baselineP95LatencyMs,
    latencyRegressionPercent,
    policyViolations,
    securityViolations,
    quarantineSignals,
    capabilityBreaches,
    schemaMismatches,
    signatureValid,
    activeDevicesCount: activeDevices,
    offlineDevicesCount: offlineDevices,
    deviceReportingRate,
    quarantineReasons,
    securityViolationDetails,
  };
}

/**
 * Canary Metrics & Rollback Evaluator.
 *
 * Implements:
 * 1. Immediate rollback on hard signals (security violation, local quarantine signal from TE-024, capability breach, invalid signature).
 * 2. Automated rollback on error rate, failure count, or latency regression breaches.
 * 3. Suspension on offline devices or insufficient telemetry evidence before policy timeout.
 * 4. Progression through canary observation windows and auto-promotion upon healthy verification.
 */
export class RolloutEvaluator {
  /**
   * Evaluates a canary metrics window against a versioned rollout policy.
   */
  evaluateCanaryMetrics(params: EvaluateCanaryMetricsParams): RolloutDecision {
    const { rollout, policy, metrics, userOverride, evidenceBundle } = params;
    const now = params.now ?? new Date().toISOString();
    const targetRollbackVersion = rollout.previousVersion ?? "1.0.0";

    // -----------------------------------------------------------------------
    // 1. Evidence Verification & Hard Triggers Enforcement (Cannot be bypassed)
    // -----------------------------------------------------------------------
    const hardTriggers: string[] = [];
    const hardTriggerReasons: string[] = [];

    if (evidenceBundle) {
      const verification = verifyRolloutEvidence(evidenceBundle);
      if (!verification.valid) {
        hardTriggers.push("signature_tamper");
        hardTriggerReasons.push(`Evidence verification failed: ${verification.reasons.join("; ")}`);
      }
    }

    if (metrics.securityViolations > 0) {
      hardTriggers.push("security_violation");
      hardTriggerReasons.push(`${metrics.securityViolations} security violation(s)`);
    }

    if (metrics.quarantineSignals > 0) {
      hardTriggers.push("quarantine_signal");
      hardTriggerReasons.push(
        `${metrics.quarantineSignals} local quarantine signal(s) [${metrics.quarantineReasons.join(", ") || "quarantined"}]`,
      );
    }

    if (metrics.capabilityBreaches > 0) {
      hardTriggers.push("capability_breach");
      hardTriggerReasons.push(`${metrics.capabilityBreaches} capability breach(es)`);
    }

    if (!metrics.signatureValid) {
      if (!hardTriggers.includes("signature_tamper")) {
        hardTriggers.push("signature_tamper");
      }
      hardTriggerReasons.push("invalid or untrusted signature");
    }

    if (hardTriggers.length > 0) {
      const details = hardTriggerReasons.filter(Boolean).join("; ");
      return {
        decisionId: randomUUID(),
        rolloutId: rollout.id,
        workspaceId: rollout.workspaceId,
        toolId: rollout.toolId,
        targetVersion: rollout.targetVersion,
        fromState: rollout.state,
        toState: "rollback_pending",
        action: "trigger_rollback",
        reason: `Hard safety violation triggered rollback: ${details}`,
        confidence: 1.0,
        triggers: hardTriggers,
        targetRollbackVersion,
        metrics,
        evaluatedAt: now,
      };
    }

    // -----------------------------------------------------------------------
    // 2. User Override Enforcement (Only when zero hard safety violations exist)
    // -----------------------------------------------------------------------
    if (userOverride) {
      if (userOverride.overrideType === "disabled") {
        return {
          decisionId: randomUUID(),
          rolloutId: rollout.id,
          workspaceId: rollout.workspaceId,
          toolId: rollout.toolId,
          targetVersion: rollout.targetVersion,
          fromState: rollout.state,
          toState: "suspended",
          action: "suspend",
          reason: `Tool disabled by user override (${userOverride.reason})`,
          confidence: 1.0,
          triggers: ["user_disabled"],
          metrics,
          evaluatedAt: now,
        };
      }

      if (
        userOverride.overrideType === "pinned" &&
        userOverride.pinnedVersion &&
        userOverride.pinnedVersion !== rollout.targetVersion
      ) {
        return {
          decisionId: randomUUID(),
          rolloutId: rollout.id,
          workspaceId: rollout.workspaceId,
          toolId: rollout.toolId,
          targetVersion: rollout.targetVersion,
          fromState: rollout.state,
          toState: "rollback_pending",
          action: "trigger_rollback",
          reason: `Rollout overridden by version pin to ${userOverride.pinnedVersion} (${userOverride.reason})`,
          confidence: 1.0,
          triggers: ["version_pinned"],
          targetRollbackVersion: userOverride.pinnedVersion,
          metrics,
          evaluatedAt: now,
        };
      }
    }
    // -----------------------------------------------------------------------
    // 3. Soft Rollback Triggers (Statistical / Telemetry Thresholds)
    // -----------------------------------------------------------------------
    if (metrics.totalInvocations >= policy.minInvocations) {
      const softTriggers: string[] = [];

      // Check max failure count
      if (metrics.failureCount > policy.maxFailures) {
        softTriggers.push("max_failures_exceeded");
      }

      // Check error rate
      if (metrics.errorRate > policy.maxFailureRate) {
        softTriggers.push("max_error_rate_exceeded");
      }

      // Check P95 latency ceiling
      if (metrics.p95LatencyMs > policy.latencyTolerances.maxP95LatencyMs) {
        softTriggers.push("p95_latency_ceiling_breach");
      }

      // Check P99 latency ceiling
      if (metrics.p99LatencyMs > policy.latencyTolerances.maxP99LatencyMs) {
        softTriggers.push("p99_latency_ceiling_breach");
      }

      // Check latency regression compared to baseline
      if (
        metrics.latencyRegressionPercent !== undefined &&
        metrics.latencyRegressionPercent >
          policy.latencyTolerances.maxAllowedLatencyRegressionPercent
      ) {
        softTriggers.push("latency_regression_exceeded");
      }

      if (softTriggers.length > 0) {
        return {
          decisionId: randomUUID(),
          rolloutId: rollout.id,
          workspaceId: rollout.workspaceId,
          toolId: rollout.toolId,
          targetVersion: rollout.targetVersion,
          fromState: rollout.state,
          toState: "rollback_pending",
          action: "trigger_rollback",
          reason: `Automatic rollback triggered by threshold breach: ${softTriggers.join(", ")} (failures=${metrics.failureCount}, errorRate=${(metrics.errorRate * 100).toFixed(1)}%, p95=${metrics.p95LatencyMs}ms, regression=${metrics.latencyRegressionPercent ? `${metrics.latencyRegressionPercent.toFixed(1)}%` : "N/A"})`,
          confidence: policy.confidenceThreshold,
          triggers: softTriggers,
          targetRollbackVersion,
          metrics,
          evaluatedAt: now,
        };
      }
    }

    // -----------------------------------------------------------------------
    // 4. Suspension Triggers (Offline Devices / Evidence Stalls)
    // -----------------------------------------------------------------------
    // If all target devices are offline or reporting rate is below 50%
    if (
      (metrics.activeDevicesCount === 0 && metrics.offlineDevicesCount > 0) ||
      metrics.deviceReportingRate < 0.5
    ) {
      return {
        decisionId: randomUUID(),
        rolloutId: rollout.id,
        workspaceId: rollout.workspaceId,
        toolId: rollout.toolId,
        targetVersion: rollout.targetVersion,
        fromState: rollout.state,
        toState: "suspended",
        action: "suspend",
        reason: `Rollout suspended: devices offline or insufficient device telemetry (${metrics.activeDevicesCount} active, ${metrics.offlineDevicesCount} offline, reportingRate=${(metrics.deviceReportingRate * 100).toFixed(0)}%)`,
        confidence: 0.85,
        triggers: ["offline_devices"],
        metrics,
        evaluatedAt: now,
      };
    }

    // Check policy timeout on insufficient evidence
    if (rollout.startedAt) {
      const elapsedMs = new Date(now).getTime() - new Date(rollout.startedAt).getTime();
      if (elapsedMs > policy.timeoutMs && metrics.totalInvocations < policy.minInvocations) {
        return {
          decisionId: randomUUID(),
          rolloutId: rollout.id,
          workspaceId: rollout.workspaceId,
          toolId: rollout.toolId,
          targetVersion: rollout.targetVersion,
          fromState: rollout.state,
          toState: "suspended",
          action: "suspend",
          reason: `Rollout suspended: timeout exceeded (${Math.round(elapsedMs / 1000)}s > ${Math.round(policy.timeoutMs / 1000)}s) with insufficient invocation evidence (${metrics.totalInvocations}/${policy.minInvocations})`,
          confidence: 0.8,
          triggers: ["insufficient_evidence_timeout"],
          metrics,
          evaluatedAt: now,
        };
      }
    }

    // -----------------------------------------------------------------------
    // 5. Progression & Promotion Lifecycle
    // -----------------------------------------------------------------------
    if (rollout.state === "canary") {
      // In canary state: advance to observing if minimum invocations reached with healthy metrics
      if (metrics.totalInvocations >= policy.minInvocations) {
        return {
          decisionId: randomUUID(),
          rolloutId: rollout.id,
          workspaceId: rollout.workspaceId,
          toolId: rollout.toolId,
          targetVersion: rollout.targetVersion,
          fromState: "canary",
          toState: "observing",
          action: "observe",
          reason: `Canary invocation threshold met (${metrics.totalInvocations} >= ${policy.minInvocations}) with 0 violations and ${(metrics.successRate * 100).toFixed(1)}% success rate. Advancing to observation window.`,
          confidence: 0.9,
          triggers: ["canary_threshold_satisfied"],
          metrics,
          evaluatedAt: now,
        };
      }

      return {
        decisionId: randomUUID(),
        rolloutId: rollout.id,
        workspaceId: rollout.workspaceId,
        toolId: rollout.toolId,
        targetVersion: rollout.targetVersion,
        fromState: "canary",
        toState: "canary",
        action: "continue_canary",
        reason: `Accumulating canary invocations (${metrics.totalInvocations}/${policy.minInvocations}). Metrics healthy.`,
        confidence: 0.8,
        triggers: ["accumulating_canary_traffic"],
        metrics,
        evaluatedAt: now,
      };
    }

    if (rollout.state === "observing") {
      const nextCleanWindows = rollout.consecutiveCleanWindows + 1;

      if (nextCleanWindows >= policy.requiredCleanWindows) {
        if (policy.allowAutoPromotion) {
          return {
            decisionId: randomUUID(),
            rolloutId: rollout.id,
            workspaceId: rollout.workspaceId,
            toolId: rollout.toolId,
            targetVersion: rollout.targetVersion,
            fromState: "observing",
            toState: "promoted",
            action: "promote",
            reason: `All observation criteria satisfied across ${nextCleanWindows} clean windows (${metrics.totalInvocations} total invocations, ${(metrics.successRate * 100).toFixed(1)}% success rate, p95=${metrics.p95LatencyMs}ms). Auto-promoting to 100% traffic.`,
            confidence: 0.98,
            triggers: ["observation_criteria_satisfied", "auto_promotion"],
            metrics,
            evaluatedAt: now,
          };
        }

        return {
          decisionId: randomUUID(),
          rolloutId: rollout.id,
          workspaceId: rollout.workspaceId,
          toolId: rollout.toolId,
          targetVersion: rollout.targetVersion,
          fromState: "observing",
          toState: "observing",
          action: "maintain",
          reason: `Observation criteria satisfied across ${nextCleanWindows} clean windows. Awaiting manual promotion approval per risk policy (${policy.riskTier}).`,
          confidence: 0.95,
          triggers: ["manual_gate_required"],
          metrics,
          evaluatedAt: now,
        };
      }

      return {
        decisionId: randomUUID(),
        rolloutId: rollout.id,
        workspaceId: rollout.workspaceId,
        toolId: rollout.toolId,
        targetVersion: rollout.targetVersion,
        fromState: "observing",
        toState: "observing",
        action: "observe",
        reason: `Observation window ${nextCleanWindows}/${policy.requiredCleanWindows} clean. Continuing observation.`,
        confidence: 0.85,
        triggers: ["observation_window_passed"],
        metrics,
        evaluatedAt: now,
      };
    }

    // Default maintain state
    return {
      decisionId: randomUUID(),
      rolloutId: rollout.id,
      workspaceId: rollout.workspaceId,
      toolId: rollout.toolId,
      targetVersion: rollout.targetVersion,
      fromState: rollout.state,
      toState: rollout.state,
      action: "maintain",
      reason: `Metrics within policy tolerances, maintaining state ${rollout.state}`,
      confidence: 0.8,
      triggers: ["steady_state"],
      metrics,
      evaluatedAt: now,
    };
  }
}
