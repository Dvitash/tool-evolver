import { describe, expect, it } from "vitest";
import { ConsentManager } from "../../src/auth/consent.js";

describe("Explicit Consent Management", () => {
  it("should have safe defaults where raw transcript upload is strictly disabled", async () => {
    const consentManager = new ConsentManager();

    const consent = await consentManager.getConsent("acc_test_01", "ws_test_01");

    expect(consent.normalizedObservations).toBe(true);
    expect(consent.rawTranscriptUpload).toBe(false); // MUST be false by default
    expect(consent.diagnostics).toBe(true);
    expect(consent.telemetry).toBe(true);

    expect(await consentManager.hasRawUploadConsent("acc_test_01", "ws_test_01")).toBe(false);
    expect(await consentManager.hasNormalizedObservationsConsent("acc_test_01", "ws_test_01")).toBe(true);
  });

  it("should support explicit grant and revocation of raw transcript upload consent", async () => {
    const consentManager = new ConsentManager();

    // Explicitly grant raw transcript upload
    await consentManager.setConsent({
      accountId: "acc_test_01",
      workspaceId: "ws_test_01",
      deviceId: "dev_special_01",
      rawTranscriptUpload: true,
      grantedByUserId: "usr_admin_01",
    });

    expect(
      await consentManager.hasRawUploadConsent("acc_test_01", "ws_test_01", "dev_special_01"),
    ).toBe(true);

    // Other devices in same workspace should still default to false
    expect(
      await consentManager.hasRawUploadConsent("acc_test_01", "ws_test_01", "dev_other_02"),
    ).toBe(false);

    // Revoke consent
    await consentManager.setConsent({
      accountId: "acc_test_01",
      workspaceId: "ws_test_01",
      deviceId: "dev_special_01",
      rawTranscriptUpload: false,
    });

    expect(
      await consentManager.hasRawUploadConsent("acc_test_01", "ws_test_01", "dev_special_01"),
    ).toBe(false);
  });
});
