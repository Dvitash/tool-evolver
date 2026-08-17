import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson } from "@tool-evolver/contracts";
import { z } from "zod";

export type QuarantineReason =
  | "signature_mismatch"
  | "digest_mismatch"
  | "path_traversal"
  | "decompression_bomb"
  | "corrupted_archive"
  | "manifest_invalid"
  | "policy_violation"
  | "symlink_escape"
  | "resource_limit_exceeded";

export const QuarantineRecordSchema = z.object({
  quarantineId: z.string().min(1),
  digest: z.string().optional(),
  reason: z.enum([
    "signature_mismatch",
    "digest_mismatch",
    "path_traversal",
    "decompression_bomb",
    "corrupted_archive",
    "manifest_invalid",
    "policy_violation",
    "symlink_escape",
    "resource_limit_exceeded",
  ]),
  quarantinedAt: z.string(),
  details: z.record(z.unknown()).default({}),
  sourceIdentifier: z.string().optional(),
  payloadSize: z.number().int().nonnegative(),
  quarantinePath: z.string(),
});
export type QuarantineRecord = z.infer<typeof QuarantineRecordSchema>;

export interface QuarantineManagerOptions {
  quarantineDir: string;
}

/**
 * Quarantine manager isolating and inspecting corrupted, tampered, or malicious artifacts.
 */
export class QuarantineManager {
  readonly quarantineDir: string;

  constructor(options: QuarantineManagerOptions) {
    this.quarantineDir = path.resolve(options.quarantineDir);
  }

  async ensureDirectory(): Promise<void> {
    await fs.promises.mkdir(this.quarantineDir, { recursive: true });
  }

  /**
   * Quarantines an in-memory buffer or string artifact.
   */
  async quarantinePayload(
    payload: Buffer | string,
    reason: QuarantineReason,
    details: Record<string, unknown> = {},
    digest?: string,
    sourceIdentifier?: string,
  ): Promise<QuarantineRecord> {
    await this.ensureDirectory();

    const timestamp = new Date().toISOString();
    const cleanDigest = digest ? digest.replace(/^sha256:/i, "").slice(0, 12) : "unknown";
    const quarantineId = `quarantine_${Date.now()}_${cleanDigest}_${crypto.randomUUID().slice(0, 8)}`;
    const targetDir = path.join(this.quarantineDir, quarantineId);
    await fs.promises.mkdir(targetDir, { recursive: true });

    const payloadBuffer = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
    const payloadFile = path.join(targetDir, "payload.bin");
    await fs.promises.writeFile(payloadFile, payloadBuffer);

    const record: QuarantineRecord = {
      quarantineId,
      digest,
      reason,
      quarantinedAt: timestamp,
      details,
      sourceIdentifier,
      payloadSize: payloadBuffer.length,
      quarantinePath: targetDir,
    };

    const recordFile = path.join(targetDir, "record.json");
    await fs.promises.writeFile(recordFile, canonicalJson(record), "utf8");

    return record;
  }

  /**
   * Quarantines a whole directory (e.g. invalid extracted artifact).
   */
  async quarantineDirectory(
    sourceDir: string,
    reason: QuarantineReason,
    details: Record<string, unknown> = {},
    digest?: string,
    sourceIdentifier?: string,
  ): Promise<QuarantineRecord> {
    await this.ensureDirectory();

    const timestamp = new Date().toISOString();
    const cleanDigest = digest ? digest.replace(/^sha256:/i, "").slice(0, 12) : "dir";
    const quarantineId = `quarantine_${Date.now()}_${cleanDigest}_${crypto.randomUUID().slice(0, 8)}`;
    const targetDir = path.join(this.quarantineDir, quarantineId);

    let totalSize = 0;
    try {
      if (fs.existsSync(sourceDir)) {
        await fs.promises.rename(sourceDir, targetDir);
      } else {
        await fs.promises.mkdir(targetDir, { recursive: true });
      }
    } catch {
      await fs.promises.mkdir(targetDir, { recursive: true });
    }

    const record: QuarantineRecord = {
      quarantineId,
      digest,
      reason,
      quarantinedAt: timestamp,
      details,
      sourceIdentifier,
      payloadSize: totalSize,
      quarantinePath: targetDir,
    };

    const recordFile = path.join(targetDir, "record.json");
    await fs.promises.writeFile(recordFile, canonicalJson(record), "utf8");

    return record;
  }

  /**
   * Lists all quarantined records.
   */
  async listQuarantined(): Promise<QuarantineRecord[]> {
    if (!fs.existsSync(this.quarantineDir)) return [];

    const entries = await fs.promises.readdir(this.quarantineDir, { withFileTypes: true });
    const records: QuarantineRecord[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const recordPath = path.join(this.quarantineDir, entry.name, "record.json");
      if (fs.existsSync(recordPath)) {
        try {
          const raw = await fs.promises.readFile(recordPath, "utf8");
          const parsed = JSON.parse(raw);
          records.push(QuarantineRecordSchema.parse(parsed));
        } catch {
          // Skip unparseable records
        }
      }
    }

    return records.sort((a, b) => b.quarantinedAt.localeCompare(a.quarantinedAt));
  }

  /**
   * Retrieves a single quarantine record by ID.
   */
  async getQuarantineRecord(quarantineId: string): Promise<QuarantineRecord | null> {
    const recordPath = path.join(this.quarantineDir, quarantineId, "record.json");
    if (!fs.existsSync(recordPath)) return null;

    try {
      const raw = await fs.promises.readFile(recordPath, "utf8");
      return QuarantineRecordSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /**
   * Purges old quarantined artifacts.
   */
  async purgeQuarantine(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<{ purgedCount: number; freedBytes: number }> {
    if (!fs.existsSync(this.quarantineDir)) {
      return { purgedCount: 0, freedBytes: 0 };
    }

    const records = await this.listQuarantined();
    const now = Date.now();
    let purgedCount = 0;
    let freedBytes = 0;

    for (const record of records) {
      const recordTime = new Date(record.quarantinedAt).getTime();
      if (now - recordTime > maxAgeMs) {
        try {
          await fs.promises.rm(record.quarantinePath, { recursive: true, force: true });
          purgedCount++;
          freedBytes += record.payloadSize;
        } catch {
          // Ignore deletion error
        }
      }
    }

    return { purgedCount, freedBytes };
  }
}
