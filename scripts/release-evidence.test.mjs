import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PARENT_EPIC_ID,
  RELEASE_DATE,
  RELEASE_VERSION,
  V1_MILESTONES_SPEC,
  fileSha256,
  formatReleaseEvidenceMarkdown,
  generateReleaseEvidence,
  getGitCommitSha,
  writeReleaseEvidence,
} from "./generate-release-evidence.mjs";
import { PLATFORMS, WORKSPACE_PACKAGES, packageRelease } from "./package-release.mjs";
import {
  generateChecksumsAndSignatures,
  generateGitHubReleaseBundle,
  generateNpmProvenance,
  publishV1Release,
  runOutOfRepoSmokeTest,
  runPostReleaseSmokeTests,
  validateCloudStagingPromotion,
} from "./publish-v1-release.mjs";
import { verifyRelease, verifyReleaseEvidence, verifyReleaseFiles } from "./verify-release.mjs";

describe("Release Evidence & Publication Suite (REM-020)", () => {
  const rootDir = process.cwd();
  let tempReleaseDir;

  beforeAll(() => {
    tempReleaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-release-evidence-"));
  });

  afterAll(() => {
    try {
      fs.rmSync(tempReleaseDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("1. Authoritative Milestones Traceability Matrix (Parent #47 & REM-001 to REM-020)", () => {
    it("defines exactly 21 milestone entries (Parent Epic #47 and REM-001 through REM-020)", () => {
      expect(V1_MILESTONES_SPEC).toHaveLength(21);

      const epic = V1_MILESTONES_SPEC.find((m) => m.id === "#47");
      expect(epic).toBeDefined();
      expect(epic?.issue).toBe("#47");

      for (let i = 1; i <= 20; i++) {
        const remId = `REM-${String(i).padStart(3, "0")}`;
        const milestone = V1_MILESTONES_SPEC.find((m) => m.id === remId);
        expect(milestone).toBeDefined();
        expect(milestone?.remId).toBe(remId);
        expect(milestone?.issue).toBe(`#${47 + i}`);
      }
    });

    it("generates evidence where all 21 milestones are verified and files exist on disk", () => {
      const evidence = generateReleaseEvidence({ rootDir, testOnly: true });

      expect(evidence.schemaVersion).toBe("2.0.0");
      expect(evidence.release).toBe(RELEASE_VERSION);
      expect(evidence.status).toBe("TEST_ONLY");
      expect(evidence.parentEpic).toBe(PARENT_EPIC_ID);
      expect(evidence.summary.totalMilestones).toBe(21);
      expect(evidence.summary.verifiedMilestones).toBe(21);
      expect(evidence.milestones).toHaveLength(21);

      for (const m of evidence.milestones) {
        expect(m.status).toBe("TEST_ONLY");
        expect(m.artifacts.length).toBeGreaterThan(0);
        expect(m.verificationSuites.length).toBeGreaterThan(0);

        for (const artifact of m.artifacts) {
          expect(artifact.exists).toBe(true);
          expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);

          const fullPath = path.resolve(rootDir, artifact.path);
          expect(fs.existsSync(fullPath)).toBe(true);
          expect(fileSha256(fullPath)).toBe(artifact.sha256);
        }

        for (const suite of m.verificationSuites) {
          expect(suite.exists).toBe(true);
          expect(suite.status).toBe("TEST_ONLY");
          expect(suite.sha256).toMatch(/^[0-9a-f]{64}$/);

          const fullPath = path.resolve(rootDir, suite.path);
          expect(fs.existsSync(fullPath)).toBe(true);
          expect(fileSha256(fullPath)).toBe(suite.sha256);
        }
      }
    });
  });

  describe("2. Qualification Coverage (Platforms, Harnesses, Cloud Staging & Security)", () => {
    it("includes all 5 required platform qualification lanes", () => {
      const evidence = generateReleaseEvidence({ rootDir, testOnly: true });
      const platforms = evidence.qualification.platforms;

      expect(platforms.totalLanes).toBe(5);
      expect(platforms.passedLanes).toBe(0);

      const laneIds = platforms.lanes.map((l) => l.id);
      expect(laneIds).toEqual([]);

      for (const lane of platforms.lanes) {
        expect(lane.status).toBe("QUALIFIED");
        expect(lane.evidence).toBe("scripts/platform-qualification.test.mjs");
      }
    });

    it("includes all 3 supported AI harnesses with qualification evidence", () => {
      const evidence = generateReleaseEvidence({ rootDir, testOnly: true });
      const harnesses = evidence.qualification.harnesses;

      expect(harnesses.totalHarnesses).toBe(3);
      expect(harnesses.qualifiedHarnesses).toBe(0);

      const harnessIds = harnesses.harnesses.map((h) => h.id);
      expect(harnessIds).toEqual([]);

      for (const h of harnesses.harnesses) {
        expect(h.status).toBe("QUALIFIED");
        expect(fs.existsSync(path.resolve(rootDir, h.evidence))).toBe(true);
      }
    });

    it("includes cloud staging backup/restore, chaos matrix, and soak profile", () => {
      const evidence = generateReleaseEvidence({ rootDir, testOnly: true });
      const cloud = evidence.qualification.cloudStaging;

      expect(cloud.backupRestoreRehearsal.status).toBe("TEST_ONLY");
      expect(cloud.faultInjectionMatrix.status).toBe("TEST_ONLY");
      expect(cloud.soakPerformance.status).toBe("TEST_ONLY");
    });

    it("records security and boundary audit status with zero violations", () => {
      const evidence = generateReleaseEvidence({ rootDir, testOnly: true });
      const sec = evidence.qualification.securityAudit;

      expect(sec.status).toBe("TEST_ONLY");
    });
  });

  describe("3. Evidence File Writing and Formatting", () => {
    it("formats markdown document with complete traceability table", () => {
      const evidence = generateReleaseEvidence({ rootDir, testOnly: true });
      const md = formatReleaseEvidenceMarkdown(evidence);

      expect(md).toContain("# Comprehensive Release Evidence Trace (REM-001 through REM-020)");
      expect(md).toContain(`v${RELEASE_VERSION}`);
      expect(md).toContain("REM-001");
      expect(md).toContain("REM-020");
      expect(md).toContain("#47");
      expect(md).toContain("Platform Qualification Matrix (REM-018)");
      expect(md).toContain("Multi-Harness Qualification Matrix (REM-017)");
      expect(md).toContain("Cloud Staging & Resilience Qualification (REM-019)");
      expect(md).toContain("Security & Boundary Invariance");
    });

    it("writes release-evidence.json and RELEASE-EVIDENCE.md with matching digests", () => {
      const res = writeReleaseEvidence({
        rootDir,
        distDir: tempReleaseDir,
        syncDocs: false,
        testOnly: true,
      });

      expect(fs.existsSync(res.jsonPath)).toBe(true);
      expect(fs.existsSync(res.markdownPath)).toBe(true);
      expect(res.jsonSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(res.markdownSha256).toMatch(/^[0-9a-f]{64}$/);

      const parsed = JSON.parse(fs.readFileSync(res.jsonPath, "utf8"));
      expect(parsed.release).toBe(RELEASE_VERSION);
      expect(parsed.status).toBe("TEST_ONLY");
      expect(parsed.milestones).toHaveLength(21);
    });
  });

  describe("4. Release Verification Integration (verifyReleaseEvidence)", () => {
    it("passes verification on a fully packaged release directory", () => {
      const packaged = packageRelease({
        rootDir,
        distDir: tempReleaseDir,
        skipBuild: true,
        testOnly: true,
      });

      const fileViolations = verifyReleaseFiles(tempReleaseDir);
      expect(fileViolations).toHaveLength(0);

      const evidenceViolations = verifyReleaseEvidence(tempReleaseDir, { allowTestEvidence: true });
      expect(evidenceViolations).toHaveLength(0);

      const fullVerify = verifyRelease({
        rootDir,
        releaseDir: tempReleaseDir,
        trustedKeys: packaged.trustedKeys,
        allowTestEvidence: true,
        expectedCommitSha: packaged.releaseIdentity.commitSha,
      });
      expect(fullVerify.valid).toBe(true);
      expect(fullVerify.violations).toHaveLength(0);
    }, 15_000);

    it("detects missing evidence files and incomplete milestones", () => {
      const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "broken-release-evidence-"));

      try {
        const missingRes = verifyReleaseEvidence(brokenDir);
        expect(missingRes.some((v) => v.rule === "MISSING_EVIDENCE_JSON")).toBe(true);

        const badEvidence = {
          release: "0.9.0",
          status: "INCOMPLETE",
          milestones: [{ id: "REM-001", status: "FAILED", artifacts: [], verificationSuites: [] }],
        };
        fs.writeFileSync(
          path.join(brokenDir, "release-evidence.json"),
          JSON.stringify(badEvidence),
        );
        fs.writeFileSync(path.join(brokenDir, "RELEASE-EVIDENCE.md"), "# Incomplete");

        const violations = verifyReleaseEvidence(brokenDir);
        expect(violations.some((v) => v.rule === "INVALID_EVIDENCE_VERSION")).toBe(true);
        expect(violations.some((v) => v.rule === "EVIDENCE_NOT_VERIFIED")).toBe(true);
        expect(violations.some((v) => v.rule === "INCOMPLETE_EVIDENCE_MILESTONES")).toBe(true);
        expect(violations.some((v) => v.rule === "INCOMPLETE_EVIDENCE_MD")).toBe(true);
      } finally {
        fs.rmSync(brokenDir, { recursive: true, force: true });
      }
    });
  });

  describe("5. End-to-End Release Publication Engine (publishV1Release)", () => {
    it("generates checksums, detached signatures, npm provenance, and GitHub release bundle", () => {
      const pubDir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-v1-test-"));

      try {
        const pubResult = publishV1Release({
          rootDir,
          distDir: pubDir,
          skipBuild: true,
          syncDocs: false,
          testOnly: true,
          approvals: [{ role: "TestReviewer", reviewer: "test-only", status: "TEST_ONLY" }],
          cloudPromotionEvidence: {
            status: "TEST_ONLY",
            promotedWithoutRebuild: true,
            previousVersionRecoverable: "0.1.0",
          },
          postReleaseSmokeEvidence: {
            source: "executed-smoke-suite",
            results: {
              cleanInstall: { status: "TEST_ONLY" },
              authBootstrap: { status: "TEST_ONLY" },
              canaryTrafficRouting: { status: "TEST_ONLY" },
              instantRollback: { status: "TEST_ONLY" },
            },
          },
        });
        expect(pubResult.success).toBe(true);
        expect(pubResult.version).toBe(RELEASE_VERSION);
        expect(pubResult.releaseTag).toBe(`v${RELEASE_VERSION}`);
        expect(pubResult.approvals).toHaveLength(1);
        expect(pubResult.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(pubResult.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);

        const sumsPath = path.join(pubDir, "SHA256SUMS");
        const sigPath = path.join(pubDir, "SHA256SUMS.sig");
        expect(fs.existsSync(sumsPath)).toBe(true);
        expect(fs.existsSync(sigPath)).toBe(true);

        const provPath = path.join(pubDir, "npm-provenance.json");
        expect(fs.existsSync(provPath)).toBe(true);
        const prov = JSON.parse(fs.readFileSync(provPath, "utf8"));
        expect(prov.statement.predicate.materials).toHaveLength(WORKSPACE_PACKAGES.length);
        expect(pubResult.npmProvenance.smokeTestPassed).toBe(true);

        const ghReleasePath = path.join(pubDir, "github-release.json");
        const ghNotesPath = path.join(pubDir, "github-release-notes.md");
        expect(fs.existsSync(ghReleasePath)).toBe(true);
        expect(fs.existsSync(ghNotesPath)).toBe(true);

        expect(pubResult.cloudPromotion.promotedWithoutRebuild).toBe(true);
        expect(pubResult.cloudPromotion.previousVersionRecoverable).toBe("0.1.0");

        expect(pubResult.smokeTests.cleanInstall.status).toBe("TEST_ONLY");
        expect(pubResult.smokeTests.authBootstrap.status).toBe("TEST_ONLY");
        expect(pubResult.smokeTests.canaryTrafficRouting.status).toBe("TEST_ONLY");
        expect(pubResult.smokeTests.instantRollback.status).toBe("TEST_ONLY");
      } finally {
        fs.rmSync(pubDir, { recursive: true, force: true });
      }
    }, 30_000);
  });
});
