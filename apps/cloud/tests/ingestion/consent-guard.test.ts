import { NormalizedSessionEvent } from "@tool-evolver/contracts";
import { describe, expect, it } from "vitest";
import { ConsentManager } from "../../src/auth/consent.js";
import {
  ConsentRequiredError,
  IngestionConsentGuard,
  RawConsentRequiredError,
} from "../../src/ingestion/consent-guard.js";

describe("IngestionConsentGuard", () => {
  const accountId = "acc-001";
  const workspaceId = "ws-001";
  const deviceId = "dev-001";

  const normalEvent: NormalizedSessionEvent = {
    eventId: "evt-001",
    schemaVersion: "1.0.0",
    sessionId: "sess-001",
    timestamp: "2026-08-17T12:00:00.000Z",
    causalRef: { causalSequence: 0 },
    redaction: {
      isRedacted: true,
      redactedFields: ["api_key"],
      redactionStrategy: "mask",
      scrubbedPatterns: [],
    },
    type: "message",
    role: "user",
    content: "Normalized user prompt",
  };

  it("should permit normalized observations when consent is granted (default)", async () => {
    const consentManager = new ConsentManager();
    const guard = new IngestionConsentGuard(consentManager);

    await expect(
      guard.validateBatchConsent(accountId, workspaceId, deviceId, [normalEvent]),
    ).resolves.toBeUndefined();
  });

  it("should reject observations when normalized observations consent is revoked", async () => {
    const consentManager = new ConsentManager();
    await consentManager.setConsent({
      accountId,
      workspaceId,
      deviceId,
      normalizedObservations: false,
    });

    const guard = new IngestionConsentGuard(consentManager);
    await expect(
      guard.validateBatchConsent(accountId, workspaceId, deviceId, [normalEvent]),
    ).rejects.toThrow(ConsentRequiredError);
  });

  it("should reject unredacted events without explicit raw upload consent", async () => {
    const consentManager = new ConsentManager();
    const guard = new IngestionConsentGuard(consentManager);

    const unredactedEvent: NormalizedSessionEvent = {
      ...normalEvent,
      eventId: "evt-raw",
      redaction: {
        isRedacted: false,
        redactedFields: [],
        redactionStrategy: "none",
        scrubbedPatterns: [],
      },
    };

    await expect(
      guard.validateBatchConsent(accountId, workspaceId, deviceId, [unredactedEvent]),
    ).rejects.toThrow(RawConsentRequiredError);
  });

  it("should reject events with local-only or raw metadata flags without raw consent", async () => {
    const consentManager = new ConsentManager();
    const guard = new IngestionConsentGuard(consentManager);

    const localOnlyEvent: NormalizedSessionEvent = {
      ...normalEvent,
      metadata: { localOnly: true },
    };

    await expect(
      guard.validateBatchConsent(accountId, workspaceId, deviceId, [localOnlyEvent]),
    ).rejects.toThrow(RawConsentRequiredError);

    const rawTranscriptEvent: NormalizedSessionEvent = {
      ...normalEvent,
      metadata: { rawTranscript: true, rawContent: "raw sensitive data" },
    };

    await expect(
      guard.validateBatchConsent(accountId, workspaceId, deviceId, [rawTranscriptEvent]),
    ).rejects.toThrow(RawConsentRequiredError);
  });

  it("should reject content parts marked local-only or containing raw data without raw consent", async () => {
    const consentManager = new ConsentManager();
    const guard = new IngestionConsentGuard(consentManager);
    const partMarkedLocalOnly: NormalizedSessionEvent = {
      ...normalEvent,
      contentParts: [
        {
          type: "text",
          text: "Some text",
          metadata: { localOnly: true },
        },
      ],
    };

    await expect(
      guard.validateBatchConsent(accountId, workspaceId, deviceId, [partMarkedLocalOnly]),
    ).rejects.toThrow(RawConsentRequiredError);
  });

  it("should permit raw-bearing events when explicit raw upload consent is granted", async () => {
    const consentManager = new ConsentManager();
    await consentManager.setConsent({
      accountId,
      workspaceId,
      deviceId,
      rawTranscriptUpload: true,
    });

    const guard = new IngestionConsentGuard(consentManager);

    const unredactedEvent: NormalizedSessionEvent = {
      ...normalEvent,
      redaction: {
        isRedacted: false,
        redactedFields: [],
        redactionStrategy: "none",
        scrubbedPatterns: [],
      },
      metadata: { rawTranscript: true },
    };

    await expect(
      guard.validateBatchConsent(accountId, workspaceId, deviceId, [unredactedEvent]),
    ).resolves.toBeUndefined();
  });
});
