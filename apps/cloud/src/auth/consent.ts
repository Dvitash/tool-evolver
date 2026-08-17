import { ISOTimestampSchema, IdentifierSchema } from "@tool-evolver/contracts";
import { z } from "zod";

/**
 * Explicit Consent Record Schema.
 * Tracks granular user & organization consent per account/workspace/device.
 */
export const ConsentRecordSchema = z.object({
  accountId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  deviceId: IdentifierSchema.optional(),
  installationId: IdentifierSchema.optional(),
  normalizedObservations: z.boolean().default(true),
  // Raw transcript upload MUST be explicitly consented by user; default is false (disabled).
  rawTranscriptUpload: z.boolean().default(false),
  diagnostics: z.boolean().default(true),
  telemetry: z.boolean().default(true),
  grantedAt: ISOTimestampSchema.default(() => new Date().toISOString()),
  updatedAt: ISOTimestampSchema.default(() => new Date().toISOString()),
  grantedByUserId: IdentifierSchema.optional(),
});

export type ConsentRecord = z.infer<typeof ConsentRecordSchema>;

/**
 * Consent update request payload.
 */
export interface ConsentUpdateRequest {
  accountId: string;
  workspaceId: string;
  deviceId?: string;
  installationId?: string;
  normalizedObservations?: boolean;
  rawTranscriptUpload?: boolean;
  diagnostics?: boolean;
  telemetry?: boolean;
  grantedByUserId?: string;
}

/**
 * Explicit Consent Manager.
 * Governs collection, normalization, raw transcript upload, diagnostics, and telemetry consent.
 */
export class ConsentManager {
  private consentStore = new Map<string, ConsentRecord>();

  private buildKey(accountId: string, workspaceId: string, deviceId?: string): string {
    return deviceId ? `${accountId}:${workspaceId}:${deviceId}` : `${accountId}:${workspaceId}:*`;
  }

  /**
   * Retrieve current consent record for a tenant/device scope.
   * Returns default safe consent record if none exists.
   */
  async getConsent(
    accountId: string,
    workspaceId: string,
    deviceId?: string,
  ): Promise<ConsentRecord> {
    if (deviceId) {
      const deviceKey = this.buildKey(accountId, workspaceId, deviceId);
      const deviceConsent = this.consentStore.get(deviceKey);
      if (deviceConsent) return deviceConsent;
    }

    const workspaceKey = this.buildKey(accountId, workspaceId);
    const workspaceConsent = this.consentStore.get(workspaceKey);
    if (workspaceConsent) return workspaceConsent;

    // Default safe baseline: rawTranscriptUpload is strictly false
    return {
      accountId,
      workspaceId,
      deviceId,
      normalizedObservations: true,
      rawTranscriptUpload: false,
      diagnostics: true,
      telemetry: true,
      grantedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Set or update consent record for a tenant/device scope.
   */
  async setConsent(update: ConsentUpdateRequest): Promise<ConsentRecord> {
    const existing = await this.getConsent(update.accountId, update.workspaceId, update.deviceId);
    const now = new Date().toISOString();

    const merged: ConsentRecord = {
      accountId: update.accountId,
      workspaceId: update.workspaceId,
      deviceId: update.deviceId ?? existing.deviceId,
      installationId: update.installationId ?? existing.installationId,
      normalizedObservations: update.normalizedObservations ?? existing.normalizedObservations,
      rawTranscriptUpload: update.rawTranscriptUpload ?? existing.rawTranscriptUpload,
      diagnostics: update.diagnostics ?? existing.diagnostics,
      telemetry: update.telemetry ?? existing.telemetry,
      grantedAt: existing.grantedAt,
      updatedAt: now,
      grantedByUserId: update.grantedByUserId ?? existing.grantedByUserId,
    };

    const validated = ConsentRecordSchema.parse(merged);
    const key = this.buildKey(update.accountId, update.workspaceId, update.deviceId);
    this.consentStore.set(key, validated);
    return validated;
  }

  /**
   * Check if raw transcript upload is explicitly enabled for this scope.
   */
  async hasRawUploadConsent(
    accountId: string,
    workspaceId: string,
    deviceId?: string,
  ): Promise<boolean> {
    const consent = await this.getConsent(accountId, workspaceId, deviceId);
    return consent.rawTranscriptUpload === true;
  }

  /**
   * Check if normalized observations collection is allowed.
   */
  async hasNormalizedObservationsConsent(
    accountId: string,
    workspaceId: string,
    deviceId?: string,
  ): Promise<boolean> {
    const consent = await this.getConsent(accountId, workspaceId, deviceId);
    return consent.normalizedObservations === true;
  }

  /**
   * Check if telemetry event collection is allowed.
   */
  async hasTelemetryConsent(
    accountId: string,
    workspaceId: string,
    deviceId?: string,
  ): Promise<boolean> {
    const consent = await this.getConsent(accountId, workspaceId, deviceId);
    return consent.telemetry === true;
  }

  /**
   * Check if diagnostics upload is allowed.
   */
  async hasDiagnosticsConsent(
    accountId: string,
    workspaceId: string,
    deviceId?: string,
  ): Promise<boolean> {
    const consent = await this.getConsent(accountId, workspaceId, deviceId);
    return consent.diagnostics === true;
  }

  clear(): void {
    this.consentStore.clear();
  }
}
