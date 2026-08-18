import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PLATFORMS,
  RELEASE_VERSION,
  WORKSPACE_PACKAGES,
  canonicalJson,
  createDeterministicTar,
  generateChannelMetadata,
  generateCycloneDxSbom,
  generatePackageDigests,
  generateSignedManifest,
  gzipDeterministic,
  packageRelease,
  sha256Hex,
} from "./package-release.mjs";
import {
  verifyAssetDigests,
  verifyChannelMetadata,
  verifyDocumentation,
  verifyManifestSignatures,
  verifyPackageDigests,
  verifyRelease,
  verifyReleaseFiles,
  verifySbom,
} from "./verify-release.mjs";

describe("Release Packaging & Verification Suite", () => {
  const rootDir = process.cwd();
  let tempReleaseDir = "";

  beforeAll(() => {
    tempReleaseDir = path.join(os.tmpdir(), `test-release-${Date.now()}`);
    fs.mkdirSync(tempReleaseDir, { recursive: true });
  });

  afterAll(() => {
    if (tempReleaseDir && fs.existsSync(tempReleaseDir)) {
      fs.rmSync(tempReleaseDir, { recursive: true, force: true });
    }
  });

  describe("Deterministic Tarball Generation", () => {
    it("generates identical tar bytes for identical inputs (reproducibility)", () => {
      const entries = [
        { path: "tool-evolver/package.json", content: '{"name":"tool-evolver","version":"1.0.0"}' },
        {
          path: "tool-evolver/bin/tool-evolver",
          content: "#!/usr/bin/env node\nconsole.log(1);",
          mode: 0o755,
        },
        { path: "tool-evolver/README.md", content: "# Release Readme" },
      ];

      const tar1 = createDeterministicTar(entries);
      const tar2 = createDeterministicTar(entries);

      expect(tar1.equals(tar2)).toBe(true);

      const gz1 = gzipDeterministic(tar1);
      const gz2 = gzipDeterministic(tar2);

      expect(gz1.equals(gz2)).toBe(true);
      expect(sha256Hex(gz1)).toBe(sha256Hex(gz2));
    });

    it("sorts entries deterministically regardless of input order", () => {
      const entriesA = [
        { path: "b.txt", content: "b" },
        { path: "a.txt", content: "a" },
        { path: "c.txt", content: "c" },
      ];
      const entriesB = [
        { path: "c.txt", content: "c" },
        { path: "a.txt", content: "a" },
        { path: "b.txt", content: "b" },
      ];

      const tarA = createDeterministicTar(entriesA);
      const tarB = createDeterministicTar(entriesB);

      expect(tarA.equals(tarB)).toBe(true);
    });
  });

  describe("Package Digest & Metadata Generation", () => {
    it("computes digests for all 15 workspace packages", () => {
      const digests = generatePackageDigests(rootDir);
      const packageNames = Object.keys(digests);

      expect(packageNames).toHaveLength(15);
      for (const pkg of WORKSPACE_PACKAGES) {
        expect(digests[pkg.name]).toBeDefined();
        expect(digests[pkg.name].version).toBe(RELEASE_VERSION);
        expect(digests[pkg.name].packageSha256).toMatch(/^[a-f0-9]{64}$/);
      }
    });
  });

  describe("Ed25519 Manifest Signing & Verification", () => {
    it("generates a cryptographically valid Ed25519 signature in manifest.json", () => {
      const packageDigests = generatePackageDigests(rootDir);
      const mockAssets = {
        "linux-x64": { filename: "tool-evolver-v1.0.0-linux-x64.tar.gz", sha256: "a".repeat(64) },
      };

      const manifest = generateSignedManifest(packageDigests, mockAssets, { testOnly: true });

      expect(manifest.version).toBe(RELEASE_VERSION);
      expect(manifest.signatures).toHaveLength(1);
      expect(manifest.signatures[0].algorithm).toBe("Ed25519");
      expect(manifest.signatures[0].signature).toMatch(/^[a-f0-9]{128}$/);

      const sig = manifest.signatures[0];
      const violations = verifyManifestSignatures(manifest, {
        trustedKeys: {
          [sig.keyId]: {
            keyId: sig.keyId,
            publicKeyPem: sig.publicKeyPem,
            publicKeyHex: sig.publicKeyHex,
            publicKeyFingerprintSha256: sig.publicKeyFingerprintSha256,
          },
        },
      });
      expect(violations).toHaveLength(0);
    });

    it("detects tampered manifest payload when signature is modified", () => {
      const packageDigests = generatePackageDigests(rootDir);
      const mockAssets = {
        "linux-x64": { filename: "tool-evolver-v1.0.0-linux-x64.tar.gz", sha256: "a".repeat(64) },
      };

      const manifest = generateSignedManifest(packageDigests, mockAssets, { testOnly: true });
      // Tamper with payload
      manifest.version = "2.0.0-unauthorized";

      const sig = manifest.signatures[0];
      const violations = verifyManifestSignatures(manifest, {
        trustedKeys: {
          [sig.keyId]: {
            keyId: sig.keyId,
            publicKeyPem: sig.publicKeyPem,
            publicKeyHex: sig.publicKeyHex,
            publicKeyFingerprintSha256: sig.publicKeyFingerprintSha256,
          },
        },
      });
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0].rule).toBe("SIGNATURE_VERIFICATION_FAILED");
    });
  });

  describe("Production release trust boundary", () => {
    it("fails closed without production signing credentials", () => {
      expect(() =>
        packageRelease({
          rootDir,
          distDir: path.join(tempReleaseDir, "no-credentials"),
          skipBuild: true,
        }),
      ).toThrow(/private key|required|TOOL_EVOLVER_RELEASE/i);
    });

    it("rejects asset mutation, changed commit binding, unknown key, missing signature, and stale evidence", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-tamper-"));
      try {
        let packaged = packageRelease({ rootDir, distDir: dir, skipBuild: true, testOnly: true });
        const baseline = () =>
          verifyRelease({
            rootDir,
            releaseDir: dir,
            allowTestEvidence: true,
            trustedKeys: packaged.trustedKeys,
            expectedCommitSha: packaged.releaseIdentity.commitSha,
          });
        expect(baseline().valid).toBe(true);

        const assetPath = path.join(dir, PLATFORMS[0].filename);
        fs.appendFileSync(assetPath, Buffer.from([0]));
        expect(baseline().violations.some((v) => v.rule === "ASSET_DIGEST_MISMATCH")).toBe(true);

        packaged = packageRelease({ rootDir, distDir: dir, skipBuild: true, testOnly: true });
        let manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
        manifest.releaseIdentity.commitSha = "f".repeat(40);
        fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
        expect(baseline().valid).toBe(false);

        packaged = packageRelease({ rootDir, distDir: dir, skipBuild: true, testOnly: true });
        manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
        manifest.signatures[0].keyId = "unknown-key";
        fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
        expect(baseline().violations.some((v) => v.rule === "UNKNOWN_SIGNING_KEY")).toBe(true);

        packaged = packageRelease({ rootDir, distDir: dir, skipBuild: true, testOnly: true });
        manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
        manifest.signatures = [];
        fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
        expect(baseline().violations.some((v) => v.rule === "MISSING_SIGNATURE")).toBe(true);

        packaged = packageRelease({ rootDir, distDir: dir, skipBuild: true, testOnly: true });
        const evidencePath = path.join(dir, "release-evidence.json");
        const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
        evidence.commitSha = "e".repeat(40);
        fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
        const stale = baseline();
        expect(
          stale.violations.some(
            (v) => v.rule === "EVIDENCE_COMMIT_MISMATCH" || v.rule === "EVIDENCE_DIGEST_MISMATCH",
          ),
        ).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("CycloneDX SBOM Generation & Verification", () => {
    it("generates CycloneDX 1.5 JSON SBOM covering all packages and dependencies", () => {
      const packageDigests = generatePackageDigests(rootDir);
      const sbom = generateCycloneDxSbom(rootDir, packageDigests);

      expect(sbom.bomFormat).toBe("CycloneDX");
      expect(sbom.specVersion).toBe("1.5");
      expect(sbom.components.length).toBeGreaterThanOrEqual(15);

      const componentNames = sbom.components.map((c) => c.name);
      for (const pkg of WORKSPACE_PACKAGES) {
        expect(componentNames).toContain(pkg.name);
      }
    });

    it("verifies valid sbom.json file in release directory", () => {
      const packageDigests = generatePackageDigests(rootDir);
      const sbom = generateCycloneDxSbom(rootDir, packageDigests);
      fs.writeFileSync(path.join(tempReleaseDir, "sbom.json"), JSON.stringify(sbom, null, 2));

      const violations = verifySbom(tempReleaseDir);
      expect(violations).toHaveLength(0);
    });
  });

  describe("Release Channel Metadata", () => {
    it("generates valid channel metadata with stable and rollback definitions", () => {
      const channels = generateChannelMetadata("test-manifest-sha256", { testOnly: true });

      expect(channels.schemaVersion).toBe("1.0.0");
      expect(channels.channels.stable.version).toBe(RELEASE_VERSION);
      expect(channels.channels.stable.manifestDigest).toBe("test-manifest-sha256");
      expect(channels.minSupportedVersion).toBe("0.1.0");
      expect(channels.rollbackReferences.targetVersion).toBe("0.1.0");
    });

    it("verifies valid channels.json in release directory", () => {
      const channels = generateChannelMetadata("test-manifest-sha256", { testOnly: true });
      fs.writeFileSync(
        path.join(tempReleaseDir, "channels.json"),
        JSON.stringify(channels, null, 2),
      );

      const signature = channels.signatures[0];
      const violations = verifyChannelMetadata(tempReleaseDir, {
        trustedKeys: {
          [signature.keyId]: {
            keyId: signature.keyId,
            publicKeyPem: signature.publicKeyPem,
            publicKeyHex: signature.publicKeyHex,
            publicKeyFingerprintSha256: signature.publicKeyFingerprintSha256,
          },
        },
      });
      expect(violations).toHaveLength(0);
    });
  });

  describe("Documentation Completeness & Cross-Link Verification", () => {
    it("verifies all user, operator, security, release, and architecture docs have 0 broken links", () => {
      const violations = verifyDocumentation(rootDir);

      if (violations.length > 0) {
        console.error("Documentation link violations:", violations);
      }

      expect(violations).toHaveLength(0);
    });
  });

  describe("Full End-to-End Package & Verify Cycle", () => {
    it("packages and validates full release in isolated target directory", () => {
      const result = packageRelease({
        rootDir,
        distDir: tempReleaseDir,
        skipBuild: true,
        testOnly: true,
      });

      expect(result.success).toBe(true);
      expect(result.packagesCount).toBe(15);
      expect(result.assetsCount).toBe(PLATFORMS.length);

      const verifyResult = verifyRelease({
        rootDir,
        releaseDir: tempReleaseDir,
        allowTestEvidence: true,
        trustedKeys: result.trustedKeys,
        expectedCommitSha: result.releaseIdentity.commitSha,
      });

      if (!verifyResult.valid) {
        console.error("Release verification failed:", verifyResult.violations);
      }

      expect(verifyResult.valid).toBe(true);
      expect(verifyResult.violations).toHaveLength(0);
      expect(verifyResult.stats.platformsCount).toBe(5);
      expect(verifyResult.stats.packagesCount).toBe(15);
    });
  });
});
