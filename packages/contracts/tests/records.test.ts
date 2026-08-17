import { describe, expect, it } from "vitest";
import {
  validAuditRecord,
  validCatalogSnapshot,
  validDeadLetterRecord,
  validDeviceRecord,
  validInstallationRecord,
  validInvocationRecord,
  validSyncCursor,
  validTelemetryRecord,
  validWorkspaceRecord,
} from "../fixtures/index.js";
import {
  AuditRecordSchema,
  CatalogSnapshotSchema,
  DeadLetterRecordSchema,
  DeviceRecordSchema,
  InstallationRecordSchema,
  InvocationRecordSchema,
  SyncCursorSchema,
  TelemetryRecordSchema,
  WorkspaceRecordSchema,
} from "../src/records.js";

describe("records contracts", () => {
  describe("WorkspaceRecordSchema & DeviceRecordSchema", () => {
    it("parses valid workspace record fixture", () => {
      const parsed = WorkspaceRecordSchema.parse(validWorkspaceRecord);
      expect(parsed.workspaceId).toBe("ws_dev_primary_01");
      expect(parsed.activeTools.fast_ast_grep).toBe("1.0.0");
    });

    it("parses valid device record fixture", () => {
      const parsed = DeviceRecordSchema.parse(validDeviceRecord);
      expect(parsed.deviceId).toBe("dev_01JABCDEF");
      expect(parsed.platform).toBe("darwin");
      expect(parsed.arch).toBe("arm64");
    });

    it("rejects device with negative cpu cores", () => {
      expect(() =>
        DeviceRecordSchema.parse({
          ...validDeviceRecord,
          cpuCores: -4,
        }),
      ).toThrow();
    });
  });

  describe("InstallationRecordSchema & CatalogSnapshotSchema", () => {
    it("parses valid installation record fixture", () => {
      const parsed = InstallationRecordSchema.parse(validInstallationRecord);
      expect(parsed.installationId).toBe("inst_001");
      expect(parsed.state).toBe("active");
    });

    it("parses valid catalog snapshot fixture", () => {
      const parsed = CatalogSnapshotSchema.parse(validCatalogSnapshot);
      expect(parsed.snapshotId).toBe("cat_snap_001");
      expect(parsed.tools.fast_ast_grep.status).toBe("active");
    });
  });

  describe("InvocationRecordSchema & AuditRecordSchema", () => {
    it("parses valid invocation record fixture", () => {
      const parsed = InvocationRecordSchema.parse(validInvocationRecord);
      expect(parsed.invocationId).toBe("inv_001");
      expect(parsed.status).toBe("success");
      expect(parsed.durationMs).toBe(14.5);
    });

    it("parses valid audit record fixture", () => {
      const parsed = AuditRecordSchema.parse(validAuditRecord);
      expect(parsed.auditId).toBe("aud_001");
      expect(parsed.action).toBe("promote_to_active");
      expect(parsed.actor.type).toBe("user");
    });
  });

  describe("TelemetryRecordSchema, SyncCursorSchema & DeadLetterRecordSchema", () => {
    it("parses valid telemetry record fixture", () => {
      const parsed = TelemetryRecordSchema.parse(validTelemetryRecord);
      expect(parsed.metricName).toBe("gateway.tool_invocation.duration_ms");
      expect(parsed.metricType).toBe("histogram");
    });

    it("parses valid sync cursor fixture", () => {
      const parsed = SyncCursorSchema.parse(validSyncCursor);
      expect(parsed.cursorId).toBe("cur_001");
      expect(parsed.lastSyncedSequence).toBe(42);
    });

    it("parses valid dead letter record fixture", () => {
      const parsed = DeadLetterRecordSchema.parse(validDeadLetterRecord);
      expect(parsed.deadLetterId).toBe("dlq_001");
      expect(parsed.status).toBe("exhausted");
      expect(parsed.retryCount).toBe(3);
    });

    it("rejects dead letter record with negative retryCount", () => {
      expect(() =>
        DeadLetterRecordSchema.parse({
          ...validDeadLetterRecord,
          retryCount: -1,
        }),
      ).toThrow();
    });
  });
});
