import type { NormalizedSessionEvent } from "@tool-evolver/contracts";
import type { ConsentManager } from "../auth/consent.js";

/**
 * Custom error thrown when normalized observation consent is missing.
 */
export class ConsentRequiredError extends Error {
  public readonly accountId: string;
  public readonly workspaceId: string;
  public readonly deviceId?: string;

  constructor(message: string, accountId: string, workspaceId: string, deviceId?: string) {
    super(message);
    this.name = "ConsentRequiredError";
    this.accountId = accountId;
    this.workspaceId = workspaceId;
    this.deviceId = deviceId;
  }
}

/**
 * Custom error thrown when raw or local-only content is submitted without raw upload consent.
 */
export class RawConsentRequiredError extends Error {
  public readonly violations: string[];

  constructor(message: string, violations: string[] = []) {
    super(message);
    this.name = "RawConsentRequiredError";
    this.violations = violations;
  }
}

function hasLocalOnlyOrRawMarker(obj: Record<string, unknown>): boolean {
  if (obj.localOnly === true || obj.isLocalOnly === true) return true;
  if (obj.raw === true || obj.rawTranscript === true || obj.rawContent !== undefined) return true;
  return false;
}

/**
 * Privacy & Consent boundary guard.
 * Enforces that normalized observations are explicitly consented and rejects
 * local-only or unredacted raw-bearing payloads unless raw upload consent is granted.
 */
export class IngestionConsentGuard {
  private consentManager: ConsentManager;

  constructor(consentManager: ConsentManager) {
    this.consentManager = consentManager;
  }

  /**
   * Validates observation batch against consent policies.
   */
  async validateBatchConsent(
    accountId: string,
    workspaceId: string,
    deviceId: string | undefined,
    observations: NormalizedSessionEvent[],
    explicitRawConsent?: boolean,
  ): Promise<void> {
    // 1. Verify Normalized Observations Consent
    const hasNormalizedConsent = await this.consentManager.hasNormalizedObservationsConsent(
      accountId,
      workspaceId,
      deviceId,
    );

    if (!hasNormalizedConsent) {
      throw new ConsentRequiredError(
        `Normalized observation ingestion is not consented for workspace '${workspaceId}'`,
        accountId,
        workspaceId,
        deviceId,
      );
    }

    // 2. Check Raw Upload Consent
    const hasRawConsent =
      explicitRawConsent ??
      (await this.consentManager.hasRawUploadConsent(accountId, workspaceId, deviceId));

    if (hasRawConsent) {
      return; // Raw content is permitted by explicit user consent
    }

    // 3. Scan for Raw-bearing or Local-only markers
    const violations: string[] = [];

    for (let i = 0; i < observations.length; i++) {
      const event = observations[i];
      const eventId = event.eventId ?? `event-${i}`;

      // Check redaction status
      if (event.redaction && event.redaction.isRedacted === false) {
        // If event is unredacted, check if strategy is 'none' with sensitive/raw payload
        if (event.redaction.redactionStrategy === "none") {
          violations.push(
            `Event ${eventId} at index ${i} is explicitly marked as unredacted (isRedacted: false) without raw consent`,
          );
        }
      }

      // Check event metadata for local-only or raw flags
      if (event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)) {
        const meta = event.metadata as Record<string, unknown>;
        if (hasLocalOnlyOrRawMarker(meta)) {
          violations.push(
            `Event ${eventId} at index ${i} has local-only or raw marker in metadata`,
          );
        }
      }

      // Check content parts if present (e.g. for message events)
      if ("contentParts" in event && Array.isArray(event.contentParts)) {
        const parts = event.contentParts;
        for (let partIdx = 0; partIdx < parts.length; partIdx++) {
          const part = parts[partIdx];
          if (part && typeof part === "object" && !Array.isArray(part) && "metadata" in part) {
            const partMeta = part.metadata;
            if (partMeta && typeof partMeta === "object" && !Array.isArray(partMeta)) {
              if (hasLocalOnlyOrRawMarker(partMeta as Record<string, unknown>)) {
                violations.push(
                  `Event ${eventId} content part ${partIdx} contains local-only or raw unnormalized data`,
                );
              }
            }
          }
        }
      }
    }

    if (violations.length > 0) {
      throw new RawConsentRequiredError(
        "Raw-bearing or local-only observation payload rejected: explicit raw transcript upload consent is required",
        violations,
      );
    }
  }
}
