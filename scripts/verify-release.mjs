#!/usr/bin/env node

/**
 * Tool Evolver V1.0.0 Release Verification Tool
 *
 * Validates:
 * 1. Existence and integrity of all release artifacts in `dist/release/v1.0.0/`.
 * 2. SHA-256 digests of all platform tarballs and package definitions against `manifest.json`.
 * 3. Cryptographic validity of Ed25519 signatures in `manifest.json`.
 * 4. CycloneDX 1.5 SBOM format, component coverage, license tags, and digests in `sbom.json`.
 * 5. Release channel metadata, minSupportedVersion, and rollback references in `channels.json`.
 * 6. Markdown documentation cross-links across all docs Markdown files (0 broken links).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  PLATFORMS,
  RELEASE_VERSION,
  WORKSPACE_PACKAGES,
  canonicalJson,
  fileSha256,
  packageRelease,
} from "./package-release.mjs";
import { loadTrustedReleaseKeysFromEnv, verifyReleasePayloadSignature } from "./release-trust.mjs";

export const REQUIRED_USER_DOCS = [
  "getting-started.md",
  "configuration.md",
  "meta-tools.md",
  "harness-guide.md",
  "doctor-and-repair.md",
  "security-and-privacy.md",
  "troubleshooting.md",
  "limitations.md",
];

export const REQUIRED_OPERATOR_DOCS = [
  "deployment.md",
  "operations.md",
  "runbooks.md",
  "backup-and-restore.md",
  "key-rotation.md",
  "telemetry-and-analytics.md",
];

export const REQUIRED_SECURITY_DOCS = [
  "threat-model.md",
  "privacy-inventory.md",
  "vulnerability-reporting.md",
  "support-policy.md",
];

export const REQUIRED_RELEASE_DOCS = [
  "v1.0.0-release-notes.md",
  "compatibility-matrix.md",
  "release-evidence.md",
  "rollback-procedure.md",
  "signing-trust.md",
];

/**
 * Validates existence of all required release artifact files.
 * @param {string} releaseDir
 * @returns {Array<{ rule: string, file: string, message: string }>}
 */
export function verifyReleaseFiles(releaseDir) {
  /** @type {Array<{ rule: string, file: string, message: string }>} */
  const violations = [];

  if (!fs.existsSync(releaseDir)) {
    violations.push({
      rule: "RELEASE_DIR",
      file: releaseDir,
      message: `Release directory does not exist: ${releaseDir}`,
    });
    return violations;
  }

  const requiredFiles = [
    "manifest.json",
    "sbom.json",
    "channels.json",
    "release-evidence.json",
    "RELEASE-EVIDENCE.md",
    "release-trust.json",
  ];

  for (const f of requiredFiles) {
    const full = path.join(releaseDir, f);
    if (!fs.existsSync(full)) {
      violations.push({
        rule: "MISSING_ARTIFACT",
        file: f,
        message: `Required release artifact is missing: ${f}`,
      });
    }
  }

  for (const platform of PLATFORMS) {
    const full = path.join(releaseDir, platform.filename);
    if (!fs.existsSync(full)) {
      violations.push({
        rule: "MISSING_TARBALL",
        file: platform.filename,
        message: `Required platform release tarball is missing: ${platform.filename}`,
      });
    } else {
      const stat = fs.statSync(full);
      if (stat.size === 0) {
        violations.push({
          rule: "EMPTY_TARBALL",
          file: platform.filename,
          message: `Platform release tarball is empty (0 bytes): ${platform.filename}`,
        });
      }
    }
  }

  return violations;
}

/**
 * Validates the existence and contents of release-evidence.json and RELEASE-EVIDENCE.md.
 * @param {string} releaseDir
 * @returns {Array<{ rule: string, file: string, message: string }>}
 */
export function verifyReleaseEvidence(releaseDir, options = {}) {
  const violations = [];
  const evidenceJsonPath = path.join(releaseDir, "release-evidence.json");
  const evidenceMdPath = path.join(releaseDir, "RELEASE-EVIDENCE.md");
  if (!fs.existsSync(evidenceJsonPath)) {
    return [
      {
        rule: "MISSING_EVIDENCE_JSON",
        file: "release-evidence.json",
        message: "release-evidence.json is missing.",
      },
    ];
  }
  if (!fs.existsSync(evidenceMdPath)) {
    violations.push({
      rule: "MISSING_EVIDENCE_MD",
      file: "RELEASE-EVIDENCE.md",
      message: "RELEASE-EVIDENCE.md is missing.",
    });
  }

  try {
    const evidence = JSON.parse(fs.readFileSync(evidenceJsonPath, "utf8"));
    if (evidence.release !== RELEASE_VERSION) {
      violations.push({
        rule: "INVALID_EVIDENCE_VERSION",
        file: "release-evidence.json",
        message: "Evidence release version mismatch.",
      });
    }
    if (evidence.mode === "test-only" && options.allowTestEvidence !== true) {
      violations.push({
        rule: "TEST_ONLY_EVIDENCE",
        file: "release-evidence.json",
        message: "Test-only release evidence cannot authorize a production release.",
      });
    } else if (evidence.mode !== "test-only" && evidence.status !== "VERIFIED") {
      violations.push({
        rule: "EVIDENCE_NOT_VERIFIED",
        file: "release-evidence.json",
        message: `Release evidence status is '${evidence.status}'.`,
      });
    }
    if (options.expectedCommitSha && evidence.commitSha !== options.expectedCommitSha) {
      violations.push({
        rule: "EVIDENCE_COMMIT_MISMATCH",
        file: "release-evidence.json",
        message: `Evidence commit '${evidence.commitSha}' does not match '${options.expectedCommitSha}'.`,
      });
    }
    if (!Array.isArray(evidence.milestones) || evidence.milestones.length !== 21) {
      violations.push({
        rule: "INCOMPLETE_EVIDENCE_MILESTONES",
        file: "release-evidence.json",
        message: "Release evidence must contain all 21 milestones.",
      });
    } else if (evidence.mode !== "test-only") {
      for (const milestone of evidence.milestones) {
        if (milestone.status !== "VERIFIED") {
          violations.push({
            rule: "UNVERIFIED_MILESTONE",
            file: "release-evidence.json",
            message: `Milestone ${milestone.id} is not verified.`,
          });
        }
        for (const suite of milestone.verificationSuites || []) {
          if (suite.status !== "PASSED" || !suite.runId) {
            violations.push({
              rule: "UNVERIFIED_SUITE",
              file: "release-evidence.json",
              message: `Suite ${suite.path} lacks a passing CI run binding.`,
            });
          }
        }
      }
    }
    if (!evidence.releaseIdentity || !evidence.verificationSource) {
      violations.push({
        rule: "MISSING_EVIDENCE_PROVENANCE",
        file: "release-evidence.json",
        message: "Release evidence lacks build/workflow provenance.",
      });
    }
  } catch (error) {
    violations.push({
      rule: "CORRUPT_EVIDENCE_JSON",
      file: "release-evidence.json",
      message: `Failed to parse release evidence: ${error.message}`,
    });
  }

  if (fs.existsSync(evidenceMdPath)) {
    const md = fs.readFileSync(evidenceMdPath, "utf8");
    if (!md.includes("REM-001") || !md.includes("REM-020") || !md.includes("#47")) {
      violations.push({
        rule: "INCOMPLETE_EVIDENCE_MD",
        file: "RELEASE-EVIDENCE.md",
        message: "Evidence markdown is incomplete.",
      });
    }
  }
  return violations;
}

/**
 * Validates the manifest signature against an independently pinned trust root.
 */
export function verifyManifestSignatures(manifest, options = {}) {
  const violations = [];
  if (!Array.isArray(manifest?.signatures) || manifest.signatures.length === 0) {
    return [{ rule: "MISSING_SIGNATURE", message: "Release manifest is unsigned." }];
  }
  const signature = manifest.signatures[0];
  const payload = {
    schemaVersion: manifest.schemaVersion,
    version: manifest.version,
    releaseDate: manifest.releaseDate,
    releaseIdentity: manifest.releaseIdentity,
    packages: manifest.packages,
    assets: manifest.assets,
    evidence: manifest.evidence,
  };
  const result = verifyReleasePayloadSignature(payload, signature, options.trustedKeys);
  if (!result.valid) {
    const rule =
      result.reason === "unknown_key"
        ? "UNKNOWN_SIGNING_KEY"
        : result.reason === "revoked_key"
          ? "REVOKED_SIGNING_KEY"
          : "SIGNATURE_VERIFICATION_FAILED";
    violations.push({
      rule,
      message: `Release manifest signature verification failed: ${result.reason}.`,
    });
  }
  return violations;
}

/**
 * Validates that all asset tarballs match the digests recorded in manifest.json.
 * @param {string} releaseDir
 * @param {object} manifest
 * @returns {Array<{ rule: string, file: string, message: string }>}
 */
export function verifyAssetDigests(releaseDir, manifest) {
  /** @type {Array<{ rule: string, file: string, message: string }>} */
  const violations = [];

  if (!manifest.assets || typeof manifest.assets !== "object") {
    violations.push({
      rule: "INVALID_MANIFEST_ASSETS",
      file: "manifest.json",
      message: "Manifest missing 'assets' object.",
    });
    return violations;
  }

  for (const platform of PLATFORMS) {
    const assetMeta = manifest.assets[platform.id];
    if (!assetMeta) {
      violations.push({
        rule: "MISSING_MANIFEST_ASSET_ENTRY",
        file: platform.filename,
        message: `Manifest assets does not contain entry for platform '${platform.id}'.`,
      });
      continue;
    }

    const tarballPath = path.join(releaseDir, platform.filename);
    if (!fs.existsSync(tarballPath)) continue;

    const actualSha256 = fileSha256(tarballPath);
    if (actualSha256 !== assetMeta.sha256) {
      violations.push({
        rule: "ASSET_DIGEST_MISMATCH",
        file: platform.filename,
        message: `Digest mismatch for ${platform.filename}: expected ${assetMeta.sha256}, calculated ${actualSha256}`,
      });
    }
  }

  return violations;
}

/**
 * Validates that all 15 workspace packages are recorded in manifest.json.
 * @param {object} manifest
 * @returns {Array<{ rule: string, message: string }>}
 */
export function verifyPackageDigests(manifest) {
  /** @type {Array<{ rule: string, message: string }>} */
  const violations = [];

  if (!manifest.packages || typeof manifest.packages !== "object") {
    violations.push({
      rule: "INVALID_MANIFEST_PACKAGES",
      message: "Manifest missing 'packages' object.",
    });
    return violations;
  }

  for (const pkg of WORKSPACE_PACKAGES) {
    const pkgMeta = manifest.packages[pkg.name];
    if (!pkgMeta) {
      violations.push({
        rule: "MISSING_PACKAGE_IN_MANIFEST",
        message: `Manifest packages does not contain entry for '${pkg.name}'.`,
      });
      continue;
    }

    if (!pkgMeta.packageSha256 || pkgMeta.packageSha256.length !== 64) {
      violations.push({
        rule: "INVALID_PACKAGE_DIGEST",
        message: `Package '${pkg.name}' has invalid or missing packageSha256 digest.`,
      });
    }
  }

  return violations;
}

/**
 * Validates the CycloneDX 1.5 SBOM.
 * @param {string} releaseDir
 * @returns {Array<{ rule: string, file: string, message: string }>}
 */
export function verifySbom(releaseDir) {
  /** @type {Array<{ rule: string, file: string, message: string }>} */
  const violations = [];
  const sbomPath = path.join(releaseDir, "sbom.json");

  if (!fs.existsSync(sbomPath)) {
    violations.push({
      rule: "MISSING_SBOM",
      file: "sbom.json",
      message: "SBOM file sbom.json is missing.",
    });
    return violations;
  }

  try {
    const sbom = JSON.parse(fs.readFileSync(sbomPath, "utf8"));

    if (sbom.bomFormat !== "CycloneDX") {
      violations.push({
        rule: "INVALID_SBOM_FORMAT",
        file: "sbom.json",
        message: `Invalid SBOM format: ${sbom.bomFormat} (expected CycloneDX).`,
      });
    }

    if (sbom.specVersion !== "1.5") {
      violations.push({
        rule: "INVALID_SBOM_VERSION",
        file: "sbom.json",
        message: `Invalid CycloneDX specVersion: ${sbom.specVersion} (expected 1.5).`,
      });
    }

    if (!Array.isArray(sbom.components) || sbom.components.length < WORKSPACE_PACKAGES.length) {
      violations.push({
        rule: "INCOMPLETE_SBOM_COMPONENTS",
        file: "sbom.json",
        message: `SBOM components count (${sbom.components?.length}) is less than workspace packages (${WORKSPACE_PACKAGES.length}).`,
      });
    }

    // Verify each workspace package is present in SBOM components
    const componentNames = new Set(sbom.components.map((c) => c.name));
    for (const pkg of WORKSPACE_PACKAGES) {
      if (!componentNames.has(pkg.name)) {
        violations.push({
          rule: "MISSING_SBOM_COMPONENT",
          file: "sbom.json",
          message: `SBOM is missing component for workspace package '${pkg.name}'.`,
        });
      }
    }
  } catch (err) {
    violations.push({
      rule: "INVALID_SBOM_JSON",
      file: "sbom.json",
      message: `Failed to parse sbom.json as valid JSON: ${err.message}`,
    });
  }

  return violations;
}

/**
 * Validates channels.json metadata.
 * @param {string} releaseDir
 * @returns {Array<{ rule: string, file: string, message: string }>}
 */
export function verifyChannelMetadata(releaseDir, options = {}) {
  const violations = [];
  const channelsPath = path.join(releaseDir, "channels.json");
  if (!fs.existsSync(channelsPath)) {
    return [
      { rule: "MISSING_CHANNELS", file: "channels.json", message: "channels.json is missing." },
    ];
  }
  try {
    const channels = JSON.parse(fs.readFileSync(channelsPath, "utf8"));
    const stable = channels.channels?.stable;
    if (!stable || stable.version !== RELEASE_VERSION) {
      violations.push({
        rule: "CHANNEL_VERSION_MISMATCH",
        file: "channels.json",
        message: "Stable release channel is missing or mismatched.",
      });
    }
    if (!channels.minSupportedVersion) {
      violations.push({
        rule: "MISSING_MIN_SUPPORTED_VERSION",
        file: "channels.json",
        message: "Channel metadata lacks minSupportedVersion.",
      });
    }
    if (!channels.rollbackReferences?.targetVersion) {
      violations.push({
        rule: "MISSING_ROLLBACK_REFERENCES",
        file: "channels.json",
        message: "Channel metadata lacks rollback references.",
      });
    }
    if (
      options.expectedCommitSha &&
      channels.releaseIdentity?.commitSha !== options.expectedCommitSha
    ) {
      violations.push({
        rule: "CHANNEL_COMMIT_MISMATCH",
        file: "channels.json",
        message: "Channel metadata is bound to a different commit.",
      });
    }
    if (
      options.expectedManifestDigest &&
      stable?.manifestDigest !== options.expectedManifestDigest
    ) {
      violations.push({
        rule: "CHANNEL_MANIFEST_DIGEST_MISMATCH",
        file: "channels.json",
        message: "Channel metadata references a different manifest digest.",
      });
    }
    if (!Array.isArray(channels.signatures) || channels.signatures.length === 0) {
      violations.push({
        rule: "MISSING_CHANNEL_SIGNATURE",
        file: "channels.json",
        message: "Channel metadata is unsigned.",
      });
    } else {
      const payload = { ...channels };
      delete payload.signatures;
      const verified = verifyReleasePayloadSignature(
        payload,
        channels.signatures[0],
        options.trustedKeys,
      );
      if (!verified.valid) {
        violations.push({
          rule:
            verified.reason === "unknown_key"
              ? "UNKNOWN_CHANNEL_SIGNING_KEY"
              : "CHANNEL_SIGNATURE_VERIFICATION_FAILED",
          file: "channels.json",
          message: `Channel signature failed: ${verified.reason}.`,
        });
      }
    }
  } catch (error) {
    violations.push({
      rule: "INVALID_CHANNELS_JSON",
      file: "channels.json",
      message: `Failed to parse channels.json: ${error.message}`,
    });
  }
  return violations;
}

/**
 * Recursively discovers all markdown files in a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function findMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Validates documentation completeness and cross-links across all docs.
 * @param {string} rootDir
 * @returns {Array<{ rule: string, file: string, message: string }>}
 */
export function verifyDocumentation(rootDir = process.cwd()) {
  /** @type {Array<{ rule: string, file: string, message: string }>} */
  const violations = [];

  const docsDir = path.resolve(rootDir, "docs");
  if (!fs.existsSync(docsDir)) {
    violations.push({
      rule: "MISSING_DOCS_DIR",
      file: "docs",
      message: "docs/ directory does not exist.",
    });
    return violations;
  }

  // 1. Verify required user docs
  for (const doc of REQUIRED_USER_DOCS) {
    const full = path.join(docsDir, "user", doc);
    if (!fs.existsSync(full)) {
      violations.push({
        rule: "MISSING_USER_DOC",
        file: `docs/user/${doc}`,
        message: `Required user documentation is missing: docs/user/${doc}`,
      });
    }
  }

  // 2. Verify required operator docs
  for (const doc of REQUIRED_OPERATOR_DOCS) {
    const full = path.join(docsDir, "operator", doc);
    if (!fs.existsSync(full)) {
      violations.push({
        rule: "MISSING_OPERATOR_DOC",
        file: `docs/operator/${doc}`,
        message: `Required operator documentation is missing: docs/operator/${doc}`,
      });
    }
  }

  // 3. Verify required security docs
  for (const doc of REQUIRED_SECURITY_DOCS) {
    const full = path.join(docsDir, "security", doc);
    if (!fs.existsSync(full)) {
      violations.push({
        rule: "MISSING_SECURITY_DOC",
        file: `docs/security/${doc}`,
        message: `Required security documentation is missing: docs/security/${doc}`,
      });
    }
  }

  // 4. Verify required release docs
  for (const doc of REQUIRED_RELEASE_DOCS) {
    const full = path.join(docsDir, "release", doc);
    if (!fs.existsSync(full)) {
      violations.push({
        rule: "MISSING_RELEASE_DOC",
        file: `docs/release/${doc}`,
        message: `Required release documentation is missing: docs/release/${doc}`,
      });
    }
  }

  // 5. Verify all relative links across all markdown files in docs/
  const allDocFiles = findMarkdownFiles(docsDir);
  for (const filePath of allDocFiles) {
    const relPath = path.relative(rootDir, filePath);
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    let inFencedCodeBlock = false;

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const rawLine = lines[lineNum];
      if (rawLine.trim().startsWith("```")) {
        inFencedCodeBlock = !inFencedCodeBlock;
        continue;
      }
      if (inFencedCodeBlock) continue;

      const lineWithoutCode = rawLine.replace(/`[^`]+`/g, "");
      const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;

      let match;
      while (true) {
        match = linkRegex.exec(lineWithoutCode);
        if (match === null) break;
        const target = match[2].trim();

        if (
          target.startsWith("http://") ||
          target.startsWith("https://") ||
          target.startsWith("mailto:") ||
          target.startsWith("#")
        ) {
          continue;
        }

        const [targetPath] = target.split("#");
        if (targetPath) {
          const resolvedTarget = path.resolve(path.dirname(filePath), targetPath);
          if (!fs.existsSync(resolvedTarget)) {
            violations.push({
              rule: "BROKEN_LINK",
              file: relPath,
              message: `Broken link on line ${lineNum + 1}: "${target}" targets non-existent file "${path.relative(rootDir, resolvedTarget)}"`,
            });
          }
        }
      }
    }
  }

  return violations;
}

/**
 * Full release verification suite.
 * @param {object} options
 * @returns {{ valid: boolean, violations: Array<{ rule: string, file?: string, message: string }>, stats: object }}
 */
export function verifyRelease(options = {}) {
  let trustedKeys = options.trustedKeys;
  const allowTestEvidence = options.allowTestEvidence === true;
  if (!trustedKeys && !allowTestEvidence) {
    try {
      trustedKeys = loadTrustedReleaseKeysFromEnv(options.env || process.env);
    } catch {
      trustedKeys = undefined;
    }
  }
  const rootDir = options.rootDir || process.cwd();
  const releaseDir =
    options.releaseDir || path.resolve(rootDir, `dist/release/v${RELEASE_VERSION}`);

  console.log(`🔍 Verifying Tool Evolver V${RELEASE_VERSION} Release Artifacts & Documentation...`);
  console.log(`📂 Release Directory: ${releaseDir}`);

  /** @type {Array<{ rule: string, file?: string, message: string }>} */
  const violations = [];

  // 1. Files existence & integrity
  const fileViolations = verifyReleaseFiles(releaseDir);
  violations.push(...fileViolations);

  let manifest = null;
  const manifestPath = path.join(releaseDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (err) {
      violations.push({
        rule: "INVALID_MANIFEST_JSON",
        file: "manifest.json",
        message: `Failed to parse manifest.json: ${err.message}`,
      });
    }
  }

  if (allowTestEvidence && !trustedKeys) {
    const trustPath = path.join(releaseDir, "release-trust.json");
    if (fs.existsSync(trustPath)) {
      const trust = JSON.parse(fs.readFileSync(trustPath, "utf8"));
      if (trust.trustDomain === "test-only" && trust.signingKey?.keyId) {
        trustedKeys = { [trust.signingKey.keyId]: trust.signingKey };
      }
    }
  }
  if (!trustedKeys) {
    violations.push({
      rule: "NO_TRUSTED_RELEASE_KEYS",
      message: "No independent trusted release public key is configured.",
    });
  }

  if (manifest) {
    if (
      options.expectedCommitSha &&
      manifest.releaseIdentity?.commitSha !== options.expectedCommitSha
    ) {
      violations.push({
        rule: "MANIFEST_COMMIT_MISMATCH",
        file: "manifest.json",
        message: "Manifest commit binding does not match the expected release commit.",
      });
    }
    // 2. Signatures
    const sigViolations = verifyManifestSignatures(manifest, { trustedKeys });
    violations.push(...sigViolations);

    // 3. Asset digests
    const assetViolations = verifyAssetDigests(releaseDir, manifest);
    violations.push(...assetViolations);

    // 4. Package digests
    const pkgViolations = verifyPackageDigests(manifest);
    violations.push(...pkgViolations);
  }

  // 5. SBOM verification
  const sbomViolations = verifySbom(releaseDir);
  violations.push(...sbomViolations);

  // 6. Channel metadata verification
  const manifestDigest = fs.existsSync(manifestPath) ? fileSha256(manifestPath) : undefined;
  const channelViolations = verifyChannelMetadata(releaseDir, {
    trustedKeys,
    expectedCommitSha: options.expectedCommitSha || manifest?.releaseIdentity?.commitSha,
    expectedManifestDigest: manifestDigest,
  });
  violations.push(...channelViolations);

  // 7. Documentation verification
  const docViolations = verifyDocumentation(rootDir);
  // 8. Release Evidence verification and signed digest binding
  const evidenceViolations = verifyReleaseEvidence(releaseDir, {
    allowTestEvidence,
    expectedCommitSha: options.expectedCommitSha || manifest?.releaseIdentity?.commitSha,
  });
  violations.push(...evidenceViolations);
  const evidencePath = path.join(releaseDir, "release-evidence.json");
  if (manifest?.evidence?.jsonSha256 && fs.existsSync(evidencePath)) {
    const actualEvidenceDigest = fileSha256(evidencePath);
    if (actualEvidenceDigest !== manifest.evidence.jsonSha256) {
      violations.push({
        rule: "EVIDENCE_DIGEST_MISMATCH",
        file: "release-evidence.json",
        message: "Release evidence does not match the digest signed by the manifest.",
      });
    }
  }

  violations.push(...docViolations);

  const valid = violations.length === 0;
  const allDocs = findMarkdownFiles(path.resolve(rootDir, "docs"));

  const stats = {
    releaseVersion: RELEASE_VERSION,
    platformsCount: PLATFORMS.length,
    packagesCount: WORKSPACE_PACKAGES.length,
    docFilesCount: allDocs.length,
    violationsCount: violations.length,
  };

  if (valid) {
    console.log(
      `\n✅ Release verification PASSED! All ${PLATFORMS.length} platform tarballs, signed manifest, SBOM, channel metadata, and ${allDocs.length} documentation files verified.`,
    );
  } else {
    console.error(`\n❌ Release verification FAILED with ${violations.length} violation(s):`);
    for (const v of violations) {
      console.error(`   - [${v.rule}] ${v.file ? `${v.file}: ` : ""}${v.message}`);
    }
  }

  return { valid, violations, stats };
}

// CLI Execution
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  const rootDir = process.cwd();
  const defaultReleaseDir = path.resolve(rootDir, `dist/release/v${RELEASE_VERSION}`);
  if (!fs.existsSync(path.join(defaultReleaseDir, "manifest.json"))) {
    console.error(
      "❌ Release verification failed: release artifacts are missing; verifier will not mint replacements.",
    );
    process.exit(1);
  }
  const result = verifyRelease();
  if (!result.valid) {
    process.exit(1);
  }
}
