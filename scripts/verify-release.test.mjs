import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_RELEASE_KEY,
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

      const manifest = generateSignedManifest(packageDigests, mockAssets);

      expect(manifest.version).toBe(RELEASE_VERSION);
      expect(manifest.signatures).toHaveLength(1);
      expect(manifest.signatures[0].algorithm).toBe("Ed25519");
      expect(manifest.signatures[0].signature).toMatch(/^[a-f0-9]{128}$/);

      const violations = verifyManifestSignatures(manifest);
      expect(violations).toHaveLength(0);
    });

    it("detects tampered manifest payload when signature is modified", () => {
      const packageDigests = generatePackageDigests(rootDir);
      const mockAssets = {
        "linux-x64": { filename: "tool-evolver-v1.0.0-linux-x64.tar.gz", sha256: "a".repeat(64) },
      };

      const manifest = generateSignedManifest(packageDigests, mockAssets);
      // Tamper with payload
      manifest.version = "2.0.0-unauthorized";

      const violations = verifyManifestSignatures(manifest);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0].rule).toBe("SIGNATURE_VERIFICATION_FAILED");
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
      const channels = generateChannelMetadata("test-manifest-sha256");

      expect(channels.schemaVersion).toBe("1.0.0");
      expect(channels.channels.stable.version).toBe(RELEASE_VERSION);
      expect(channels.channels.stable.manifestDigest).toBe("test-manifest-sha256");
      expect(channels.minSupportedVersion).toBe("0.1.0");
      expect(channels.rollbackReferences.targetVersion).toBe("0.1.0");
    });

    it("verifies valid channels.json in release directory", () => {
      const channels = generateChannelMetadata("test-manifest-sha256");
      fs.writeFileSync(
        path.join(tempReleaseDir, "channels.json"),
        JSON.stringify(channels, null, 2),
      );

      const violations = verifyChannelMetadata(tempReleaseDir);
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
        skipBuild: true, // already built in baseline
      });

      expect(result.success).toBe(true);
      expect(result.packagesCount).toBe(15);
      expect(result.assetsCount).toBe(PLATFORMS.length);

      const verifyResult = verifyRelease({
        rootDir,
        releaseDir: tempReleaseDir,
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
