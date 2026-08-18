from pathlib import Path
import re


def read(path):
    return Path(path).read_text()


def write(path, content):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(content)


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f"missing replacement target: {label}")
    return text.replace(old, new, 1)


def replace_between(text, start, end, replacement, label):
    i = text.find(start)
    if i < 0:
        raise SystemExit(f"missing start marker: {label}")
    j = text.find(end, i)
    if j < 0:
        raise SystemExit(f"missing end marker: {label}")
    return text[:i] + replacement + text[j:]


# New release trust boundary: private signing material is never persisted in source.
release_trust = r'''import crypto from "node:crypto";

export const RELEASE_SIGNING_ALGORITHM = "Ed25519";
export const REVOKED_RELEASE_KEY_IDS = Object.freeze(["tool-evolver-release-v1"]);

function normalizePem(value) {
  return typeof value === "string" ? value.replace(/\\n/g, "\n").trim() : "";
}

function fingerprintPublicKey(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex");
}

function rawEd25519PublicKeyHex(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return der.subarray(-32).toString("hex");
}

export function createReleaseSigningKey(input, options = {}) {
  const keyId = typeof input?.keyId === "string" ? input.keyId.trim() : "";
  const privateKeyPkcs8Pem = normalizePem(input?.privateKeyPkcs8Pem || input?.privateKeyPem);
  const publicKeyPemInput = normalizePem(input?.publicKeyPem);
  const allowTestOnly = options.allowTestOnly === true;

  if (!keyId) {
    throw new Error("Release signing key ID is required.");
  }
  if (REVOKED_RELEASE_KEY_IDS.includes(keyId)) {
    throw new Error(`Release signing key '${keyId}' is revoked and cannot be used.`);
  }
  if (keyId.startsWith("test-only-") && !allowTestOnly) {
    throw new Error("Test-only release signing keys cannot be used for production releases.");
  }
  if (!privateKeyPkcs8Pem) {
    throw new Error("Release signing private key is required from the external secret boundary.");
  }
  if (!publicKeyPemInput) {
    throw new Error("Release signing public key is required so the private key can be cross-checked.");
  }

  const privateKey = crypto.createPrivateKey(privateKeyPkcs8Pem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Release signing private key must be Ed25519.");
  }
  const derivedPublicKey = crypto.createPublicKey(privateKey);
  const suppliedPublicKey = crypto.createPublicKey(publicKeyPemInput);
  if (suppliedPublicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Release signing public key must be Ed25519.");
  }

  const derivedDer = derivedPublicKey.export({ type: "spki", format: "der" });
  const suppliedDer = suppliedPublicKey.export({ type: "spki", format: "der" });
  if (
    derivedDer.length !== suppliedDer.length ||
    !crypto.timingSafeEqual(Buffer.from(derivedDer), Buffer.from(suppliedDer))
  ) {
    throw new Error("Release signing public key does not match the supplied private key.");
  }

  return Object.freeze({
    keyId,
    algorithm: RELEASE_SIGNING_ALGORITHM,
    trustDomain: keyId.startsWith("test-only-") ? "test-only" : "production",
    privateKey,
    publicKey: derivedPublicKey,
    publicKeyPem: derivedPublicKey.export({ type: "spki", format: "pem" }).toString(),
    publicKeyHex: rawEd25519PublicKeyHex(derivedPublicKey),
    publicKeyFingerprintSha256: fingerprintPublicKey(derivedPublicKey),
  });
}

export function createTestReleaseSigningKey() {
  const generated = crypto.generateKeyPairSync("ed25519");
  return createReleaseSigningKey(
    {
      keyId: `test-only-${crypto.randomUUID()}`,
      privateKeyPkcs8Pem: generated.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicKeyPem: generated.publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
    { allowTestOnly: true },
  );
}

export function loadReleaseSigningKeyFromEnv(env = process.env) {
  return createReleaseSigningKey({
    keyId: env.TOOL_EVOLVER_RELEASE_KEY_ID,
    privateKeyPkcs8Pem: env.TOOL_EVOLVER_RELEASE_PRIVATE_KEY_PEM,
    publicKeyPem: env.TOOL_EVOLVER_RELEASE_PUBLIC_KEY_PEM,
  });
}

export function publicTrustRecord(key) {
  return Object.freeze({
    keyId: key.keyId,
    algorithm: RELEASE_SIGNING_ALGORITHM,
    trustDomain: key.trustDomain,
    publicKeyPem: key.publicKeyPem,
    publicKeyHex: key.publicKeyHex,
    publicKeyFingerprintSha256: key.publicKeyFingerprintSha256,
  });
}

export function trustedKeysFromSigningKey(key) {
  return Object.freeze({ [key.keyId]: publicTrustRecord(key) });
}

export function loadTrustedReleaseKeysFromEnv(env = process.env) {
  const keyId = typeof env.TOOL_EVOLVER_RELEASE_KEY_ID === "string" ? env.TOOL_EVOLVER_RELEASE_KEY_ID.trim() : "";
  const publicKeyPem = normalizePem(env.TOOL_EVOLVER_RELEASE_PUBLIC_KEY_PEM);
  if (!keyId || !publicKeyPem) {
    throw new Error(
      "Trusted release key ID and public key are required (TOOL_EVOLVER_RELEASE_KEY_ID / TOOL_EVOLVER_RELEASE_PUBLIC_KEY_PEM).",
    );
  }
  if (REVOKED_RELEASE_KEY_IDS.includes(keyId)) {
    throw new Error(`Trusted release key '${keyId}' is revoked.`);
  }
  const publicKey = crypto.createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Trusted release public key must be Ed25519.");
  }
  const record = Object.freeze({
    keyId,
    algorithm: RELEASE_SIGNING_ALGORITHM,
    trustDomain: "production",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    publicKeyHex: rawEd25519PublicKeyHex(publicKey),
    publicKeyFingerprintSha256: fingerprintPublicKey(publicKey),
  });
  return Object.freeze({ [keyId]: record });
}

export function signReleasePayload(payload, key) {
  if (!key?.privateKey) {
    throw new Error("Release signing requires an externally provisioned private key.");
  }
  const canonical = canonicalJson(payload);
  const signature = crypto.sign(null, Buffer.from(canonical, "utf8"), key.privateKey);
  return Object.freeze({
    keyId: key.keyId,
    algorithm: RELEASE_SIGNING_ALGORITHM,
    publicKeyPem: key.publicKeyPem,
    publicKeyHex: key.publicKeyHex,
    publicKeyFingerprintSha256: key.publicKeyFingerprintSha256,
    signatureHex: signature.toString("hex"),
  });
}

export function verifyReleasePayloadSignature(payload, signature, trustedKeys) {
  if (!signature || signature.algorithm !== RELEASE_SIGNING_ALGORITHM) {
    return { valid: false, reason: "unsupported_or_missing_signature" };
  }
  if (REVOKED_RELEASE_KEY_IDS.includes(signature.keyId)) {
    return { valid: false, reason: "revoked_key" };
  }
  const trusted = trustedKeys?.[signature.keyId];
  if (!trusted) {
    return { valid: false, reason: "unknown_key" };
  }
  if (
    (signature.publicKeyHex && signature.publicKeyHex !== trusted.publicKeyHex) ||
    (signature.publicKeyFingerprintSha256 &&
      signature.publicKeyFingerprintSha256 !== trusted.publicKeyFingerprintSha256)
  ) {
    return { valid: false, reason: "embedded_key_mismatch" };
  }
  try {
    const publicKey = crypto.createPublicKey(trusted.publicKeyPem);
    const valid = crypto.verify(
      null,
      Buffer.from(canonicalJson(payload), "utf8"),
      publicKey,
      Buffer.from(signature.signatureHex || signature.signature || "", "hex"),
    );
    return { valid, reason: valid ? undefined : "signature_mismatch" };
  } catch {
    return { valid: false, reason: "signature_verification_error" };
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(",")}}`;
}
'''
write("scripts/release-trust.mjs", release_trust)

# package-release: remove persisted key, bind exact build identity + evidence, sign manifest/channel externally.
p = "scripts/package-release.mjs"
s = read(p)
s = s.replace('import { writeReleaseEvidence } from "./generate-release-evidence.mjs";', 'import { getGitCommitSha, writeReleaseEvidence } from "./generate-release-evidence.mjs";\nimport {\n  createTestReleaseSigningKey,\n  loadReleaseSigningKeyFromEnv,\n  publicTrustRecord,\n  signReleasePayload,\n  trustedKeysFromSigningKey,\n  REVOKED_RELEASE_KEY_IDS,\n} from "./release-trust.mjs";')
start = "/**\n * Known deterministic release Ed25519 keypair"
end = "/**\n * Generates a CycloneDX 1.5 JSON SBOM"
replacement = r'''function resolveReleaseIdentity(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const testOnly = options.testOnly === true;
  const commitSha = options.commitSha || process.env.GITHUB_SHA || getGitCommitSha(rootDir);
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw new Error(`Release commit SHA must be an exact 40-character Git SHA, received '${commitSha}'.`);
  }
  const repository = options.repository || process.env.GITHUB_REPOSITORY || (testOnly ? "test-only/local" : "");
  const ref = options.ref || process.env.GITHUB_REF || (testOnly ? "refs/test-only/local" : "");
  const workflowRunId = String(options.workflowRunId || process.env.GITHUB_RUN_ID || (testOnly ? "test-only" : ""));
  const workflowRunAttempt = String(
    options.workflowRunAttempt || process.env.GITHUB_RUN_ATTEMPT || (testOnly ? "1" : ""),
  );
  if (!testOnly && (!repository || !ref || !workflowRunId || !workflowRunAttempt)) {
    throw new Error(
      "Production release packaging requires GitHub repository/ref/run identity and cannot fabricate provenance.",
    );
  }

  return Object.freeze({
    repository,
    commitSha,
    ref,
    workflow: {
      name: options.workflowName || process.env.GITHUB_WORKFLOW || (testOnly ? "test-only-release" : ""),
      runId: workflowRunId,
      runAttempt: workflowRunAttempt,
    },
  });
}

function resolveSigningKey(options = {}) {
  if (options.keyPair) return options.keyPair;
  if (options.testOnly === true) return createTestReleaseSigningKey();
  return loadReleaseSigningKeyFromEnv();
}

/**
 * Generates and signs the release manifest (`manifest.json`).
 * Production callers must supply an externally provisioned signing identity.
 */
export function generateSignedManifest(packageDigests, assetDigests, options = {}) {
  const keyPair = resolveSigningKey(options);
  const releaseIdentity = options.releaseIdentity || resolveReleaseIdentity(options);
  const evidence = options.evidence;
  if (!evidence && options.testOnly !== true) {
    throw new Error("Production release manifests require release evidence metadata before signing.");
  }

  const manifestPayload = {
    schemaVersion: "2.0.0",
    version: RELEASE_VERSION,
    releaseDate: RELEASE_DATE,
    releaseIdentity,
    packages: packageDigests,
    assets: assetDigests,
    evidence: evidence || { status: "TEST_ONLY" },
  };
  const signature = signReleasePayload(manifestPayload, keyPair);

  return {
    ...manifestPayload,
    signatures: [{ ...signature, signedAt: RELEASE_DATE }],
  };
}

'''
s = replace_between(s, start, end, replacement, "package release key/signing block")
start = "/**\n * Generates release channel metadata (`channels.json`)."
end = "/**\n * Orchestrates the full release packaging process."
replacement = r'''/**
 * Generates signed release channel metadata.
 */
export function generateChannelMetadata(manifestSha256, options = {}) {
  const keyPair = resolveSigningKey(options);
  const releaseIdentity = options.releaseIdentity || resolveReleaseIdentity(options);
  const payload = {
    schemaVersion: "2.0.0",
    minSupportedVersion: "0.1.0",
    currentVersion: RELEASE_VERSION,
    updatedAt: RELEASE_DATE,
    releaseIdentity,
    channels: {
      stable: {
        version: RELEASE_VERSION,
        releaseDate: RELEASE_DATE,
        manifestUrl: `https://releases.tool-evolver.dev/v${RELEASE_VERSION}/manifest.json`,
        manifestDigest: manifestSha256,
        releaseNotesUrl: `https://docs.tool-evolver.dev/release/v${RELEASE_VERSION}-release-notes`,
        isLatest: true,
      },
    },
    rollbackReferences: {
      targetVersion: "0.1.0",
      minSafeVersion: "0.1.0",
      instructionsUrl: "https://docs.tool-evolver.dev/release/rollback-procedure",
    },
    revokedKeyIds: [...REVOKED_RELEASE_KEY_IDS],
  };
  return {
    ...payload,
    signatures: [{ ...signReleasePayload(payload, keyPair), signedAt: RELEASE_DATE }],
  };
}

'''
s = replace_between(s, start, end, replacement, "channel metadata block")
start = "export function packageRelease(options = {}) {"
end = "// CLI Execution"
replacement = r'''export function packageRelease(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const skipBuild = options.skipBuild ?? false;
  const testOnly = options.testOnly === true || process.env.TOOL_EVOLVER_RELEASE_TEST_ONLY === "1";
  const distDir =
    options.distDir ||
    options.outputDir ||
    path.resolve(rootDir, `dist/release/v${RELEASE_VERSION}`);

  const releaseIdentity = resolveReleaseIdentity({ ...options, rootDir, testOnly });
  const keyPair = resolveSigningKey({ ...options, testOnly });

  console.log(`📦 Packaging Tool Evolver V${RELEASE_VERSION} Release...`);
  console.log(`📂 Output Directory: ${distDir}`);
  console.log(`🔐 Trust Domain: ${keyPair.trustDomain}`);

  if (!skipBuild) {
    buildWorkspacePackages(rootDir);
  }

  const packageDigests = generatePackageDigests(rootDir);
  const assetDigests = createPlatformReleaseTarballs(rootDir, distDir);

  const evidenceResult = writeReleaseEvidence({
    rootDir,
    distDir,
    releaseIdentity,
    commitSha: releaseIdentity.commitSha,
    keyId: keyPair.keyId,
    testOnly,
    verificationEvidence: options.verificationEvidence,
    syncDocs: options.syncDocs ?? false,
  });

  const evidenceMetadata = {
    json: "release-evidence.json",
    markdown: "RELEASE-EVIDENCE.md",
    jsonSha256: evidenceResult.jsonSha256,
    markdownSha256: evidenceResult.markdownSha256,
    status: evidenceResult.evidence.status,
    mode: evidenceResult.evidence.mode,
  };
  const manifest = generateSignedManifest(packageDigests, assetDigests, {
    keyPair,
    releaseIdentity,
    evidence: evidenceMetadata,
    testOnly,
  });
  const manifestPath = path.join(distDir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const manifestSha256 = fileSha256(manifestPath);

  const sbom = generateCycloneDxSbom(rootDir, packageDigests);
  fs.writeFileSync(path.join(distDir, "sbom.json"), JSON.stringify(sbom, null, 2));

  const channels = generateChannelMetadata(manifestSha256, {
    keyPair,
    releaseIdentity,
    testOnly,
  });
  fs.writeFileSync(path.join(distDir, "channels.json"), JSON.stringify(channels, null, 2));

  const trustRecord = {
    schemaVersion: "1.0.0",
    releaseVersion: RELEASE_VERSION,
    trustDomain: keyPair.trustDomain,
    signingKey: publicTrustRecord(keyPair),
    revokedKeyIds: [...REVOKED_RELEASE_KEY_IDS],
  };
  fs.writeFileSync(path.join(distDir, "release-trust.json"), JSON.stringify(trustRecord, null, 2));

  return {
    success: true,
    version: RELEASE_VERSION,
    distDir,
    packagesCount: Object.keys(packageDigests).length,
    assetsCount: Object.keys(assetDigests).length,
    manifestSha256,
    evidenceSha256: evidenceResult.jsonSha256,
    releaseIdentity,
    publicTrust: publicTrustRecord(keyPair),
    trustedKeys: trustedKeysFromSigningKey(keyPair),
    testOnly,
  };
}

'''
s = replace_between(s, start, end, replacement, "package release orchestration")
write(p, s)

# evidence: no fake git SHA, suite existence is not a pass, production qualification must be injected from CI.
p = "scripts/generate-release-evidence.mjs"
s = read(p)
start = "/**\n * Retrieves the current git commit SHA or a deterministic fallback."
end = "/**\n * Authoritative V1 Milestones Specification"
replacement = r'''/**
 * Retrieves the exact current Git commit SHA. Release evidence never fabricates identity.
 */
export function getGitCommitSha(rootDir = process.cwd()) {
  let sha = "";
  try {
    sha = execSync("git rev-parse HEAD", {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    throw new Error(`Unable to resolve release Git commit: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`Release Git commit must be a full 40-character SHA, received '${sha}'.`);
  }
  return sha;
}

'''
s = replace_between(s, start, end, replacement, "git sha")
start = "export function generateReleaseEvidence(options = {}) {"
end = "/**\n * Formats the release evidence into markdown document."
replacement = r'''export function generateReleaseEvidence(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const testOnly = options.testOnly === true;
  const commitSha = options.commitSha || options.releaseIdentity?.commitSha || getGitCommitSha(rootDir);
  const verificationEvidence = options.verificationEvidence;
  if (!testOnly && (!verificationEvidence || typeof verificationEvidence !== "object")) {
    throw new Error(
      "Production release evidence requires machine-readable CI qualification evidence; source file existence is not proof of a pass.",
    );
  }

  let totalArtifactsCount = 0;
  let totalSuitesCount = 0;
  let verifiedMilestonesCount = 0;

  const suiteResults = verificationEvidence?.suites || {};
  const resolvedMilestones = V1_MILESTONES_SPEC.map((spec) => {
    const resolvedArtifacts = spec.artifacts.map((relPath) => {
      totalArtifactsCount++;
      const fullPath = path.resolve(rootDir, relPath);
      const exists = fs.existsSync(fullPath);
      return {
        path: relPath,
        sha256: exists ? fileSha256(fullPath) : "NOT_FOUND",
        exists,
      };
    });

    const resolvedSuites = spec.suites.map((relPath) => {
      totalSuitesCount++;
      const fullPath = path.resolve(rootDir, relPath);
      const exists = fs.existsSync(fullPath);
      const observed = suiteResults[relPath];
      return {
        path: relPath,
        sha256: exists ? fileSha256(fullPath) : "NOT_FOUND",
        exists,
        status: testOnly ? (exists ? "TEST_ONLY" : "MISSING") : observed?.status || "UNVERIFIED",
        runId: testOnly ? undefined : observed?.runId,
        jobId: testOnly ? undefined : observed?.jobId,
      };
    });

    const allArtifactsExist = resolvedArtifacts.every((artifact) => artifact.exists);
    const allSuitesPassed = testOnly
      ? resolvedSuites.every((suite) => suite.exists)
      : resolvedSuites.every((suite) => suite.status === "PASSED" && suite.runId);
    const isVerified = allArtifactsExist && allSuitesPassed;
    if (isVerified) verifiedMilestonesCount++;

    return {
      id: spec.id,
      issue: spec.issue,
      remId: spec.remId,
      title: spec.title,
      description: spec.description,
      category: spec.category,
      status: testOnly ? (isVerified ? "TEST_ONLY" : "FAILED") : isVerified ? "VERIFIED" : "FAILED",
      artifacts: resolvedArtifacts,
      verificationSuites: resolvedSuites,
    };
  });

  const qualification = testOnly
    ? {
        platforms: { totalLanes: 5, passedLanes: 0, status: "TEST_ONLY", lanes: [] },
        harnesses: { totalHarnesses: 3, qualifiedHarnesses: 0, status: "TEST_ONLY", harnesses: [] },
        cloudStaging: {
          backupRestoreRehearsal: { status: "TEST_ONLY" },
          faultInjectionMatrix: { status: "TEST_ONLY" },
          soakPerformance: { status: "TEST_ONLY" },
        },
        securityAudit: { status: "TEST_ONLY" },
      }
    : verificationEvidence.qualification;

  if (!testOnly) {
    const requiredQualification = [
      qualification?.platforms?.status,
      qualification?.harnesses?.status,
      qualification?.cloudStaging?.backupRestoreRehearsal?.status,
      qualification?.cloudStaging?.faultInjectionMatrix?.status,
      qualification?.cloudStaging?.soakPerformance?.status,
      qualification?.securityAudit?.status,
    ];
    if (!requiredQualification.every((status) => status === "QUALIFIED" || status === "PASSED")) {
      throw new Error("Production release qualification evidence is incomplete or not passing.");
    }
  }

  const fullyVerified = verifiedMilestonesCount === V1_MILESTONES_SPEC.length;
  return {
    schemaVersion: "2.0.0",
    release: RELEASE_VERSION,
    releaseDate: RELEASE_DATE,
    commitSha,
    releaseIdentity: options.releaseIdentity,
    parentEpic: PARENT_EPIC_ID,
    mode: testOnly ? "test-only" : "production",
    status: testOnly ? (fullyVerified ? "TEST_ONLY" : "INCOMPLETE") : fullyVerified ? "VERIFIED" : "INCOMPLETE",
    keyId: options.keyId,
    verificationSource: testOnly
      ? { type: "local-test-fixtures" }
      : {
          type: "github-actions",
          workflowRunId: verificationEvidence.workflowRunId,
          workflowRunAttempt: verificationEvidence.workflowRunAttempt,
          generatedAt: verificationEvidence.generatedAt,
        },
    qualification,
    summary: {
      totalMilestones: V1_MILESTONES_SPEC.length,
      verifiedMilestones: verifiedMilestonesCount,
      totalArtifacts: totalArtifactsCount,
      totalVerificationSuites: totalSuitesCount,
      generatedAt: new Date().toISOString(),
    },
    milestones: resolvedMilestones,
  };
}

'''
s = replace_between(s, start, end, replacement, "release evidence generation")
s = s.replace(
    '    const statusIcon = m.status === "VERIFIED" ? "✅ Verified" : "❌ Failed";',
    '    const statusIcon = m.status === "VERIFIED" ? "✅ Verified" : m.status === "TEST_ONLY" ? "🧪 Test Only" : "❌ Failed";',
)
s = s.replace(
    '''  for (const lane of evidence.qualification.platforms.lanes) {
    lines.push(
      `| **${lane.id}** | ${lane.os} | ${lane.arch} | `${lane.serviceManager}` | ✅ ${lane.status} | `${lane.evidence}` |`,
    );
  }''',
    '''  for (const lane of evidence.qualification.platforms.lanes || []) {
    lines.push(
      `| **${lane.id}** | ${lane.os || "n/a"} | ${lane.arch || "n/a"} | `${lane.serviceManager || "n/a"}` | ${lane.status || "UNVERIFIED"} | `${lane.evidence || "n/a"}` |`,
    );
  }''',
)
s = s.replace(
    '''  for (const h of evidence.qualification.harnesses.harnesses) {
    lines.push(
      `| **${h.name}** | `@tool-evolver/adapter-${h.id}` | ${h.transport} | ✅ ${h.status} | `${h.evidence}` |`,
    );
  }''',
    '''  for (const h of evidence.qualification.harnesses.harnesses || []) {
    lines.push(
      `| **${h.name || h.id}** | `@tool-evolver/adapter-${h.id}` | ${h.transport || "n/a"} | ${h.status || "UNVERIFIED"} | `${h.evidence || "n/a"}` |`,
    );
  }''',
)
write(p, s)

# release verifier: independent trust root, exact commit/evidence binding, no self-trusting manifest keys.
p = "scripts/verify-release.mjs"
s = read(p)
s = s.replace('} from "./package-release.mjs";', '} from "./package-release.mjs";\nimport { loadTrustedReleaseKeysFromEnv, verifyReleasePayloadSignature } from "./release-trust.mjs";')
s = s.replace('    "RELEASE-EVIDENCE.md",', '    "RELEASE-EVIDENCE.md",\n    "release-trust.json",')
s = s.replace('  "rollback-procedure.md",', '  "rollback-procedure.md",\n  "signing-trust.md",')
start = "export function verifyReleaseEvidence(releaseDir) {"
end = "/**\n * Validates Ed25519 signature on manifest.json."
replacement = r'''export function verifyReleaseEvidence(releaseDir, options = {}) {
  const violations = [];
  const evidenceJsonPath = path.join(releaseDir, "release-evidence.json");
  const evidenceMdPath = path.join(releaseDir, "RELEASE-EVIDENCE.md");
  if (!fs.existsSync(evidenceJsonPath)) {
    return [{ rule: "MISSING_EVIDENCE_JSON", file: "release-evidence.json", message: "release-evidence.json is missing." }];
  }
  if (!fs.existsSync(evidenceMdPath)) {
    violations.push({ rule: "MISSING_EVIDENCE_MD", file: "RELEASE-EVIDENCE.md", message: "RELEASE-EVIDENCE.md is missing." });
  }

  try {
    const evidence = JSON.parse(fs.readFileSync(evidenceJsonPath, "utf8"));
    if (evidence.release !== RELEASE_VERSION) {
      violations.push({ rule: "INVALID_EVIDENCE_VERSION", file: "release-evidence.json", message: "Evidence release version mismatch." });
    }
    if (evidence.mode === "test-only" && options.allowTestEvidence !== true) {
      violations.push({ rule: "TEST_ONLY_EVIDENCE", file: "release-evidence.json", message: "Test-only release evidence cannot authorize a production release." });
    } else if (evidence.mode !== "test-only" && evidence.status !== "VERIFIED") {
      violations.push({ rule: "EVIDENCE_NOT_VERIFIED", file: "release-evidence.json", message: `Release evidence status is '${evidence.status}'.` });
    }
    if (options.expectedCommitSha && evidence.commitSha !== options.expectedCommitSha) {
      violations.push({ rule: "EVIDENCE_COMMIT_MISMATCH", file: "release-evidence.json", message: `Evidence commit '${evidence.commitSha}' does not match '${options.expectedCommitSha}'.` });
    }
    if (!Array.isArray(evidence.milestones) || evidence.milestones.length !== 21) {
      violations.push({ rule: "INCOMPLETE_EVIDENCE_MILESTONES", file: "release-evidence.json", message: "Release evidence must contain all 21 milestones." });
    } else if (evidence.mode !== "test-only") {
      for (const milestone of evidence.milestones) {
        if (milestone.status !== "VERIFIED") {
          violations.push({ rule: "UNVERIFIED_MILESTONE", file: "release-evidence.json", message: `Milestone ${milestone.id} is not verified.` });
        }
        for (const suite of milestone.verificationSuites || []) {
          if (suite.status !== "PASSED" || !suite.runId) {
            violations.push({ rule: "UNVERIFIED_SUITE", file: "release-evidence.json", message: `Suite ${suite.path} lacks a passing CI run binding.` });
          }
        }
      }
    }
    if (!evidence.releaseIdentity || !evidence.verificationSource) {
      violations.push({ rule: "MISSING_EVIDENCE_PROVENANCE", file: "release-evidence.json", message: "Release evidence lacks build/workflow provenance." });
    }
  } catch (error) {
    violations.push({ rule: "CORRUPT_EVIDENCE_JSON", file: "release-evidence.json", message: `Failed to parse release evidence: ${error.message}` });
  }

  if (fs.existsSync(evidenceMdPath)) {
    const md = fs.readFileSync(evidenceMdPath, "utf8");
    if (!md.includes("REM-001") || !md.includes("REM-020") || !md.includes("#47")) {
      violations.push({ rule: "INCOMPLETE_EVIDENCE_MD", file: "RELEASE-EVIDENCE.md", message: "Evidence markdown is incomplete." });
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
    const rule = result.reason === "unknown_key" ? "UNKNOWN_SIGNING_KEY" : result.reason === "revoked_key" ? "REVOKED_SIGNING_KEY" : "SIGNATURE_VERIFICATION_FAILED";
    violations.push({ rule, message: `Release manifest signature verification failed: ${result.reason}.` });
  }
  return violations;
}

'''
s = replace_between(s, start, end, replacement, "release evidence/signature verification")
start = "export function verifyChannelMetadata(releaseDir) {"
end = "/**\n * Recursively discovers all markdown files"
replacement = r'''export function verifyChannelMetadata(releaseDir, options = {}) {
  const violations = [];
  const channelsPath = path.join(releaseDir, "channels.json");
  if (!fs.existsSync(channelsPath)) {
    return [{ rule: "MISSING_CHANNELS", file: "channels.json", message: "channels.json is missing." }];
  }
  try {
    const channels = JSON.parse(fs.readFileSync(channelsPath, "utf8"));
    const stable = channels.channels?.stable;
    if (!stable || stable.version !== RELEASE_VERSION) {
      violations.push({ rule: "CHANNEL_VERSION_MISMATCH", file: "channels.json", message: "Stable release channel is missing or mismatched." });
    }
    if (!channels.minSupportedVersion) {
      violations.push({ rule: "MISSING_MIN_SUPPORTED_VERSION", file: "channels.json", message: "Channel metadata lacks minSupportedVersion." });
    }
    if (!channels.rollbackReferences?.targetVersion) {
      violations.push({ rule: "MISSING_ROLLBACK_REFERENCES", file: "channels.json", message: "Channel metadata lacks rollback references." });
    }
    if (options.expectedCommitSha && channels.releaseIdentity?.commitSha !== options.expectedCommitSha) {
      violations.push({ rule: "CHANNEL_COMMIT_MISMATCH", file: "channels.json", message: "Channel metadata is bound to a different commit." });
    }
    if (options.expectedManifestDigest && stable?.manifestDigest !== options.expectedManifestDigest) {
      violations.push({ rule: "CHANNEL_MANIFEST_DIGEST_MISMATCH", file: "channels.json", message: "Channel metadata references a different manifest digest." });
    }
    if (!Array.isArray(channels.signatures) || channels.signatures.length === 0) {
      violations.push({ rule: "MISSING_CHANNEL_SIGNATURE", file: "channels.json", message: "Channel metadata is unsigned." });
    } else {
      const payload = { ...channels };
      delete payload.signatures;
      const verified = verifyReleasePayloadSignature(payload, channels.signatures[0], options.trustedKeys);
      if (!verified.valid) {
        violations.push({ rule: verified.reason === "unknown_key" ? "UNKNOWN_CHANNEL_SIGNING_KEY" : "CHANNEL_SIGNATURE_VERIFICATION_FAILED", file: "channels.json", message: `Channel signature failed: ${verified.reason}.` });
      }
    }
  } catch (error) {
    violations.push({ rule: "INVALID_CHANNELS_JSON", file: "channels.json", message: `Failed to parse channels.json: ${error.message}` });
  }
  return violations;
}

'''
s = replace_between(s, start, end, replacement, "channel verifier")
old = "export function verifyRelease(options = {}) {"
new = '''export function verifyRelease(options = {}) {
  let trustedKeys = options.trustedKeys;
  const allowTestEvidence = options.allowTestEvidence === true;
  if (!trustedKeys && !allowTestEvidence) {
    try {
      trustedKeys = loadTrustedReleaseKeysFromEnv(options.env || process.env);
    } catch {
      trustedKeys = undefined;
    }
  }'''
s = replace_once(s, old, new, "verify release trust init")
old = '''  if (manifest) {
    // 2. Signatures
    const sigViolations = verifyManifestSignatures(manifest);
    violations.push(...sigViolations);'''
new = '''  if (allowTestEvidence && !trustedKeys) {
    const trustPath = path.join(releaseDir, "release-trust.json");
    if (fs.existsSync(trustPath)) {
      const trust = JSON.parse(fs.readFileSync(trustPath, "utf8"));
      if (trust.trustDomain === "test-only" && trust.signingKey?.keyId) {
        trustedKeys = { [trust.signingKey.keyId]: trust.signingKey };
      }
    }
  }
  if (!trustedKeys) {
    violations.push({ rule: "NO_TRUSTED_RELEASE_KEYS", message: "No independent trusted release public key is configured." });
  }

  if (manifest) {
    if (options.expectedCommitSha && manifest.releaseIdentity?.commitSha !== options.expectedCommitSha) {
      violations.push({ rule: "MANIFEST_COMMIT_MISMATCH", file: "manifest.json", message: "Manifest commit binding does not match the expected release commit." });
    }
    // 2. Signatures
    const sigViolations = verifyManifestSignatures(manifest, { trustedKeys });
    violations.push(...sigViolations);'''
s = replace_once(s, old, new, "verify release manifest trust")
old = '''  // 6. Channel metadata verification
  const channelViolations = verifyChannelMetadata(releaseDir);
  violations.push(...channelViolations);'''
new = '''  // 6. Channel metadata verification
  const manifestDigest = fs.existsSync(manifestPath) ? fileSha256(manifestPath) : undefined;
  const channelViolations = verifyChannelMetadata(releaseDir, {
    trustedKeys,
    expectedCommitSha: options.expectedCommitSha || manifest?.releaseIdentity?.commitSha,
    expectedManifestDigest: manifestDigest,
  });
  violations.push(...channelViolations);'''
s = replace_once(s, old, new, "verify release channel call")
old = '''  // 8. Release Evidence verification
  const evidenceViolations = verifyReleaseEvidence(releaseDir);
  violations.push(...evidenceViolations);'''
new = '''  // 8. Release Evidence verification and signed digest binding
  const evidenceViolations = verifyReleaseEvidence(releaseDir, {
    allowTestEvidence,
    expectedCommitSha: options.expectedCommitSha || manifest?.releaseIdentity?.commitSha,
  });
  violations.push(...evidenceViolations);
  const evidencePath = path.join(releaseDir, "release-evidence.json");
  if (manifest?.evidence?.jsonSha256 && fs.existsSync(evidencePath)) {
    const actualEvidenceDigest = fileSha256(evidencePath);
    if (actualEvidenceDigest !== manifest.evidence.jsonSha256) {
      violations.push({ rule: "EVIDENCE_DIGEST_MISMATCH", file: "release-evidence.json", message: "Release evidence does not match the digest signed by the manifest." });
    }
  }'''
s = replace_once(s, old, new, "verify release evidence call")
old = '''  if (!fs.existsSync(path.join(defaultReleaseDir, "manifest.json"))) {
    packageRelease({ rootDir, outputDir: defaultReleaseDir });
  }
  const result = verifyRelease();'''
new = '''  if (!fs.existsSync(path.join(defaultReleaseDir, "manifest.json"))) {
    console.error("❌ Release verification failed: release artifacts are missing; verifier will not mint replacements.");
    process.exit(1);
  }
  const result = verifyRelease();'''
s = replace_once(s, old, new, "read only verify cli")
write(p, s)

# Publisher: no fake approvals/smoke evidence and no default private key.
p = "scripts/publish-v1-release.mjs"
s = read(p)
s = s.replace("  DEFAULT_RELEASE_KEY,\n", "")
s = s.replace('import { verifyRelease } from "./verify-release.mjs";', 'import { verifyRelease } from "./verify-release.mjs";\nimport { createTestReleaseSigningKey, loadReleaseSigningKeyFromEnv, publicTrustRecord, trustedKeysFromSigningKey } from "./release-trust.mjs";')
s = s.replace("export function generateChecksumsAndSignatures(distDir, keyPair = DEFAULT_RELEASE_KEY) {", "export function generateChecksumsAndSignatures(distDir, keyPair) {\n  if (!keyPair?.privateKey) throw new Error(\"Detached checksum signing requires an external release signing key.\");")
s = s.replace("  const privateKey = crypto.createPrivateKey(keyPair.privateKeyPkcs8Pem);\n  const signature = crypto.sign(null, Buffer.from(sumsContent, \"utf8\"), privateKey);", "  const signature = crypto.sign(null, Buffer.from(sumsContent, \"utf8\"), keyPair.privateKey);")
s = s.replace("export function generateNpmProvenance(rootDir, distDir, commitSha, keyPair = DEFAULT_RELEASE_KEY) {", "export function generateNpmProvenance(rootDir, distDir, commitSha, keyPair, releaseIdentity) {\n  if (!keyPair?.privateKey) throw new Error(\"NPM provenance signing requires an external release signing key.\");")
s = s.replace('        id: "https://github.com/tool-evolver/tool-evolver/.github/workflows/release.yml@v1.0.0",', '        id: `https://github.com/${releaseIdentity.repository}/actions/runs/${releaseIdentity.workflow.runId}`,')
s = s.replace("  const privateKey = crypto.createPrivateKey(keyPair.privateKeyPkcs8Pem);\n  const sig = crypto.sign(null, Buffer.from(canonicalStmt, \"utf8\"), privateKey);", "  const sig = crypto.sign(null, Buffer.from(canonicalStmt, \"utf8\"), keyPair.privateKey);")
s = s.replace("      publicKeyPem: keyPair.publicKeyPem,", "      publicKeyPem: keyPair.publicKeyPem,\n      publicKeyFingerprintSha256: keyPair.publicKeyFingerprintSha256,")
s = s.replace("      publicKeyPem: DEFAULT_RELEASE_KEY.publicKeyPem,", "      publicKeyPem: evidence.publicTrust.publicKeyPem,")
start = "/**\n * Simulates comprehensive post-release lifecycle smoke tests."
end = "/**\n * Main orchestration function"
replacement = r'''/**
 * Normalizes executed post-release smoke evidence. Static/synthetic passes are rejected.
 */
export function runPostReleaseSmokeTests(observedEvidence) {
  if (!observedEvidence || observedEvidence.source !== "executed-smoke-suite") {
    throw new Error("Post-release smoke evidence must come from an executed smoke suite.");
  }
  const required = ["cleanInstall", "authBootstrap", "canaryTrafficRouting", "instantRollback"];
  for (const name of required) {
    if (!observedEvidence.results?.[name]?.status) {
      throw new Error(`Executed smoke evidence is missing result '${name}'.`);
    }
  }
  return observedEvidence.results;
}

'''
s = replace_between(s, start, end, replacement, "post release smoke")
start = "export function publishV1Release(options = {}) {"
end = "// CLI Execution"
replacement = r'''export function publishV1Release(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const distDir = options.distDir || path.resolve(rootDir, `dist/release/v${RELEASE_VERSION}`);
  const testOnly = options.testOnly === true;
  const keyPair = options.keyPair || (testOnly ? createTestReleaseSigningKey() : loadReleaseSigningKeyFromEnv());
  const commitSha = options.commitSha || getGitCommitSha(rootDir);
  const approvals = Array.isArray(options.approvals) ? options.approvals : [];
  if (!testOnly && approvals.length === 0) {
    throw new Error("Production publication requires recorded independent approvals; publisher will not fabricate them.");
  }

  console.log(`🚀 Publishing Tool Evolver V${RELEASE_VERSION} Release Candidate...`);
  const packageResult = packageRelease({
    rootDir,
    distDir,
    keyPair,
    commitSha,
    testOnly,
    verificationEvidence: options.verificationEvidence,
    skipBuild: options.skipBuild ?? false,
    syncDocs: options.syncDocs ?? false,
  });
  const releaseIdentity = packageResult.releaseIdentity;
  const evidenceResult = writeReleaseEvidence({
    rootDir,
    distDir,
    commitSha,
    releaseIdentity,
    keyId: keyPair.keyId,
    testOnly,
    verificationEvidence: options.verificationEvidence,
    syncDocs: options.syncDocs ?? false,
  });
  const checksumsResult = generateChecksumsAndSignatures(distDir, keyPair);
  const verifyResult = verifyRelease({
    rootDir,
    releaseDir: distDir,
    trustedKeys: trustedKeysFromSigningKey(keyPair),
    allowTestEvidence: testOnly,
    expectedCommitSha: commitSha,
  });
  if (!verifyResult.valid) {
    throw new Error(`Release verification failed with ${verifyResult.violations.length} violations.`);
  }
  const npmProvenance = generateNpmProvenance(rootDir, distDir, commitSha, keyPair, releaseIdentity);
  const outOfRepoSmoke = runOutOfRepoSmokeTest(distDir, rootDir);
  const githubRelease = generateGitHubReleaseBundle(
    rootDir,
    distDir,
    commitSha,
    { ...evidenceResult.evidence, publicTrust: publicTrustRecord(keyPair) },
  );
  const cloudPromotion = options.cloudPromotionEvidence;
  if (!cloudPromotion) {
    throw new Error("Release publication requires observed cloud promotion evidence.");
  }
  const postReleaseSmoke = runPostReleaseSmokeTests(options.postReleaseSmokeEvidence);

  return {
    success: true,
    version: RELEASE_VERSION,
    releaseTag: `v${RELEASE_VERSION}`,
    commitSha,
    releaseDate: RELEASE_DATE,
    distDir,
    approvals,
    manifestSha256: packageResult.manifestSha256,
    evidenceSha256: evidenceResult.jsonSha256,
    publicTrust: publicTrustRecord(keyPair),
    checksums: { assetCount: checksumsResult.assetCount, signature: `${checksumsResult.sigContent.slice(0, 16)}...` },
    npmProvenance: {
      builder: npmProvenance.statement.predicate.builder.id,
      materialsCount: npmProvenance.statement.predicate.materials.length,
      smokeTestPassed: outOfRepoSmoke.cliHelpVerified,
    },
    githubRelease: { tagName: githubRelease.tag_name, assetsCount: githubRelease.assets.length },
    cloudPromotion,
    smokeTests: postReleaseSmoke,
  };
}

'''
s = replace_between(s, start, end, replacement, "publisher orchestration")
write(p, s)

# CLI channel verifier: revoke compromised key and require caller-pinned trust for signatures.
p = "apps/cli/src/installer/channel-verifier.ts"
s = read(p)
start = "/**\n * Standard public key used for Tool Evolver release verification."
end = "// Ed25519 SPKI DER prefix"
replacement = r'''/**
 * The original V1 release key is permanently revoked because its private half
 * was committed historically. Callers must supply a pinned public trust root.
 */
export const REVOKED_RELEASE_KEY_IDS = Object.freeze(["tool-evolver-release-v1"]);

'''
s = replace_between(s, start, end, replacement, "cli default release key")
old = '''  // Validate Cryptographic Signatures if present
  if (!options.skipSignatureVerification && meta.signatures && meta.signatures.length > 0) {
    const trustedKeys = options.trustedPublicKeys || [DEFAULT_RELEASE_PUBLIC_KEY.publicKeyHex];'''
new = '''  // Release metadata is unsafe unless signed by a caller-pinned trust root.
  if (!options.skipSignatureVerification) {
    if (!meta.signatures || meta.signatures.length === 0) {
      errors.push("Cryptographic verification failed: channel metadata is unsigned.");
    }
    const trustedKeys = options.trustedPublicKeys || [];
    if (trustedKeys.length === 0) {
      errors.push("Cryptographic verification failed: no trusted release public keys are configured.");
    }
    if (meta.signatures && meta.signatures.length > 0 && trustedKeys.length > 0) {'''
s = replace_once(s, old, new, "channel signature start")
s = s.replace(
    '''      const pubKey = sig.publicKeyHex || DEFAULT_RELEASE_PUBLIC_KEY.publicKeyHex;
      if (!trustedKeys.includes(pubKey)) {''',
    '''      if (REVOKED_RELEASE_KEY_IDS.includes(sig.keyId)) {
        warnings.push(`Signature key '${sig.keyId}' is revoked.`);
        continue;
      }
      const pubKey = sig.publicKeyHex;
      if (!pubKey || !trustedKeys.includes(pubKey)) {''',
    1,
)
old = '''    if (!signatureMatched) {
      errors.push(
        "Cryptographic verification failed: no valid Ed25519 signature matched channel metadata payload.",
      );
    }
  }

  const selectedChannelInfo'''
new = '''      if (!signatureMatched) {
        errors.push(
          "Cryptographic verification failed: no valid Ed25519 signature matched channel metadata payload.",
        );
      }
    }
  }

  const selectedChannelInfo'''
s = replace_once(s, old, new, "channel signature close")
old = '''  // Ed25519 Signature Verification
  if (!options.skipSignatureVerification && manifest.signatures && manifest.signatures.length > 0) {
    const trustedKeys = options.trustedPublicKeys || [DEFAULT_RELEASE_PUBLIC_KEY.publicKeyHex];'''
new = '''  // Ed25519 Signature Verification
  if (!options.skipSignatureVerification) {
    if (!manifest.signatures || manifest.signatures.length === 0) {
      errors.push("Cryptographic verification failed: release manifest is unsigned.");
    }
    const trustedKeys = options.trustedPublicKeys || [];
    if (trustedKeys.length === 0) {
      errors.push("Cryptographic verification failed: no trusted release public keys are configured.");
    }
    if (manifest.signatures && manifest.signatures.length > 0 && trustedKeys.length > 0) {'''
s = replace_once(s, old, new, "manifest signature start")
s = s.replace(
    '''      const pubKey = sig.publicKeyHex || DEFAULT_RELEASE_PUBLIC_KEY.publicKeyHex;
      if (!trustedKeys.includes(pubKey)) {''',
    '''      if (REVOKED_RELEASE_KEY_IDS.includes(sig.keyId)) {
        warnings.push(`Signature key '${sig.keyId}' is revoked.`);
        continue;
      }
      const pubKey = sig.publicKeyHex;
      if (!pubKey || !trustedKeys.includes(pubKey)) {''',
    1,
)
old = '''    if (!signatureMatched) {
      errors.push(
        "Cryptographic verification failed: no valid Ed25519 signature matched manifest payload.",
      );
    }
  }

  return {'''
new = '''      if (!signatureMatched) {
        errors.push(
          "Cryptographic verification failed: no valid Ed25519 signature matched manifest payload.",
        );
      }
    }
  }

  return {'''
s = replace_once(s, old, new, "manifest signature close")
write(p, s)

# signed-channel verifier test key runtime
p = "apps/cli/tests/installer/signed-channel-verifier.test.ts"
s = read(p)
s = s.replace("  DEFAULT_RELEASE_PUBLIC_KEY,\n", "")
start = "// Deterministic test Ed25519 keypair"
end = "function signPayload"
replacement = r'''// Test-only key material is generated at runtime and is never a production trust root.
const generatedTestKeyPair = crypto.generateKeyPairSync("ed25519");
const TEST_KEYPAIR = {
  keyId: "test-only-runtime-key",
  publicKeyHex: generatedTestKeyPair.publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("hex"),
  privateKeyPkcs8Pem: generatedTestKeyPair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString(),
};

'''
s = replace_between(s, start, end, replacement, "cli test key")
write(p, s)

# verify-release.test
p = "scripts/verify-release.test.mjs"
s = read(p)
s = s.replace("  DEFAULT_RELEASE_KEY,\n", "")
s = s.replace('generateChannelMetadata("test-manifest-sha256")', 'generateChannelMetadata("test-manifest-sha256", { testOnly: true })')
s = s.replace("generateSignedManifest(packageDigests, mockAssets)", "generateSignedManifest(packageDigests, mockAssets, { testOnly: true })")
s = s.replace(
    "const violations = verifyManifestSignatures(manifest);",
    '''const sig = manifest.signatures[0];
      const violations = verifyManifestSignatures(manifest, {
        trustedKeys: {
          [sig.keyId]: {
            keyId: sig.keyId,
            publicKeyPem: sig.publicKeyPem,
            publicKeyHex: sig.publicKeyHex,
            publicKeyFingerprintSha256: sig.publicKeyFingerprintSha256,
          },
        },
      });''',
)
old = '''      const result = packageRelease({
        rootDir,
        distDir: tempReleaseDir,
        skipBuild: true, // already built in baseline
      });'''
new = '''      const result = packageRelease({
        rootDir,
        distDir: tempReleaseDir,
        skipBuild: true,
        testOnly: true,
      });'''
s = replace_once(s, old, new, "verify release package call")
old = '''      const verifyResult = verifyRelease({
        rootDir,
        releaseDir: tempReleaseDir,
      });'''
new = '''      const verifyResult = verifyRelease({
        rootDir,
        releaseDir: tempReleaseDir,
        allowTestEvidence: true,
        trustedKeys: result.trustedKeys,
        expectedCommitSha: result.releaseIdentity.commitSha,
      });'''
s = replace_once(s, old, new, "verify release full verify")
insert = r'''
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
'''
s = s.replace('\n  describe("CycloneDX SBOM Generation & Verification", () => {', insert + '\n  describe("CycloneDX SBOM Generation & Verification", () => {', 1)
write(p, s)

# release-evidence.test: mark local evidence as test-only and provide explicit observed publication evidence.
p = "scripts/release-evidence.test.mjs"
s = read(p)
s = s.replace("  DEFAULT_RELEASE_KEY,\n", "")
s = s.replace("generateReleaseEvidence({ rootDir })", "generateReleaseEvidence({ rootDir, testOnly: true })")
s = s.replace("expect(evidence.status).toBe(\"VERIFIED\")", "expect(evidence.status).toBe(\"TEST_ONLY\")")
s = s.replace("expect(evidence.summary.verifiedMilestones).toBe(21)", "expect(evidence.summary.verifiedMilestones).toBe(21)")
s = s.replace("expect(m.status).toBe(\"VERIFIED\")", "expect(m.status).toBe(\"TEST_ONLY\")")
s = s.replace("expect(suite.status).toBe(\"PASSED\")", "expect(suite.status).toBe(\"TEST_ONLY\")")
s = s.replace("expect(platforms.passedLanes).toBe(5)", "expect(platforms.passedLanes).toBe(0)")
s = s.replace('expect(laneIds).toEqual(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "wsl"])', "expect(laneIds).toEqual([])")
s = s.replace("expect(harnesses.qualifiedHarnesses).toBe(3)", "expect(harnesses.qualifiedHarnesses).toBe(0)")
s = s.replace('expect(harnessIds).toEqual(["claude-code", "codex-cli", "omp"])', "expect(harnessIds).toEqual([])")
s = s.replace('expect(cloud.backupRestoreRehearsal.status).toBe("QUALIFIED")', 'expect(cloud.backupRestoreRehearsal.status).toBe("TEST_ONLY")')
s = s.replace('expect(cloud.faultInjectionMatrix.status).toBe("QUALIFIED")', 'expect(cloud.faultInjectionMatrix.status).toBe("TEST_ONLY")')
s = s.replace('expect(cloud.soakPerformance.status).toBe("QUALIFIED")', 'expect(cloud.soakPerformance.status).toBe("TEST_ONLY")')
s = s.replace('expect(cloud.soakPerformance.p95LatencyMs).toBeLessThan(50);\n      expect(cloud.soakPerformance.errorRate).toBe("0.00%");\n', "")
old = '''      expect(sec.secretLeaksDetected).toBe(0);
      expect(sec.boundaryViolations).toBe(0);
      expect(sec.circularDependencies).toBe(0);
      expect(sec.adrsEnforced).toBe(10);
      expect(sec.status).toBe("PASSED");'''
new = '''      expect(sec.status).toBe("TEST_ONLY");'''
s = replace_once(s, old, new, "release evidence security assertion")
s = s.replace(
    '''      const evidence = generateReleaseEvidence({ rootDir });''',
    '''      const evidence = generateReleaseEvidence({ rootDir, testOnly: true });''',
)
s = s.replace(
    '''      const res = writeReleaseEvidence({
        rootDir,
        distDir: tempReleaseDir,
        syncDocs: false,
      });''',
    '''      const res = writeReleaseEvidence({
        rootDir,
        distDir: tempReleaseDir,
        syncDocs: false,
        testOnly: true,
      });''',
    1,
)
s = s.replace('expect(parsed.status).toBe("VERIFIED")', 'expect(parsed.status).toBe("TEST_ONLY")')
s = s.replace(
    '''      packageRelease({
        rootDir,
        distDir: tempReleaseDir,
        skipBuild: true,
      });''',
    '''      const packaged = packageRelease({
        rootDir,
        distDir: tempReleaseDir,
        skipBuild: true,
        testOnly: true,
      });''',
    1,
)
s = s.replace(
    '''      const evidenceViolations = verifyReleaseEvidence(tempReleaseDir);''',
    '''      const evidenceViolations = verifyReleaseEvidence(tempReleaseDir, { allowTestEvidence: true });''',
    1,
)
s = s.replace(
    '''      const fullVerify = verifyRelease({
        rootDir,
        releaseDir: tempReleaseDir,
      });''',
    '''      const fullVerify = verifyRelease({
        rootDir,
        releaseDir: tempReleaseDir,
        trustedKeys: packaged.trustedKeys,
        allowTestEvidence: true,
        expectedCommitSha: packaged.releaseIdentity.commitSha,
      });''',
    1,
)
old = '''        const pubResult = publishV1Release({
          rootDir,
          distDir: pubDir,
          skipBuild: true,
          syncDocs: false,
        });'''
new = '''        const pubResult = publishV1Release({
          rootDir,
          distDir: pubDir,
          skipBuild: true,
          syncDocs: false,
          testOnly: true,
          approvals: [{ role: "TestReviewer", reviewer: "test-only", status: "TEST_ONLY" }],
          cloudPromotionEvidence: { status: "TEST_ONLY", promotedWithoutRebuild: true, previousVersionRecoverable: "0.1.0" },
          postReleaseSmokeEvidence: {
            source: "executed-smoke-suite",
            results: {
              cleanInstall: { status: "TEST_ONLY" },
              authBootstrap: { status: "TEST_ONLY" },
              canaryTrafficRouting: { status: "TEST_ONLY" },
              instantRollback: { status: "TEST_ONLY" },
            },
          },
        });'''
s = replace_once(s, old, new, "publication test options")
s = s.replace("expect(pubResult.approvals).toHaveLength(3)", "expect(pubResult.approvals).toHaveLength(1)")
s = s.replace('expect(pubResult.smokeTests.cleanInstall.status).toBe("PASSED")', 'expect(pubResult.smokeTests.cleanInstall.status).toBe("TEST_ONLY")')
s = s.replace('expect(pubResult.smokeTests.authBootstrap.status).toBe("PASSED")', 'expect(pubResult.smokeTests.authBootstrap.status).toBe("TEST_ONLY")')
s = s.replace('expect(pubResult.smokeTests.canaryTrafficRouting.status).toBe("PASSED")', 'expect(pubResult.smokeTests.canaryTrafficRouting.status).toBe("TEST_ONLY")')
s = s.replace('expect(pubResult.smokeTests.instantRollback.status).toBe("PASSED")', 'expect(pubResult.smokeTests.instantRollback.status).toBe("TEST_ONLY")')
write(p, s)

# CI PR release verification is explicit test-only; production release workflow fails closed without external signing secret.
p = ".github/workflows/ci.yml"
s = read(p)
old = '''  release-verification:
    name: Release Artifact Verification
    runs-on: ubuntu-latest'''
new = '''  release-verification:
    name: Release Artifact Verification
    runs-on: ubuntu-latest
    env:
      TOOL_EVOLVER_RELEASE_TEST_ONLY: "1"'''
s = replace_once(s, old, new, "ci test-only release verification")
write(p, s)

release_workflow = r'''name: Production Release

on:
  workflow_dispatch:
    inputs:
      commit_sha:
        description: Exact green main commit SHA to release
        required: true
        type: string

permissions:
  contents: read

jobs:
  build-and-verify-release:
    runs-on: ubuntu-24.04
    env:
      TOOL_EVOLVER_RELEASE_KEY_ID: ${{ vars.TOOL_EVOLVER_RELEASE_KEY_ID }}
      TOOL_EVOLVER_RELEASE_PUBLIC_KEY_PEM: ${{ vars.TOOL_EVOLVER_RELEASE_PUBLIC_KEY_PEM }}
      TOOL_EVOLVER_RELEASE_PRIVATE_KEY_PEM: ${{ secrets.TOOL_EVOLVER_RELEASE_PRIVATE_KEY_PEM }}
      TOOL_EVOLVER_RELEASE_EVIDENCE_PATH: dist/qualification/production-release-evidence.json
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.commit_sha }}
          fetch-depth: 0
      - name: Verify exact release commit
        shell: bash
        run: |
          test "$(git rev-parse HEAD)" = "${{ inputs.commit_sha }}"
          test -n "$TOOL_EVOLVER_RELEASE_KEY_ID"
          test -n "$TOOL_EVOLVER_RELEASE_PUBLIC_KEY_PEM"
          test -n "$TOOL_EVOLVER_RELEASE_PRIVATE_KEY_PEM"
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: pnpm/action-setup@v4
        with:
          version: 10.24.0
          run_install: false
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm test
      - name: Require production qualification evidence
        run: test -s "$TOOL_EVOLVER_RELEASE_EVIDENCE_PATH"
      - name: Package exact signed release
        run: node scripts/package-release.mjs
      - name: Verify exact signed release
        run: node scripts/verify-release.mjs
'''
write(".github/workflows/release.yml", release_workflow)

docs = r'''# Release signing trust

Tool Evolver production releases use an Ed25519 signing identity whose private key is supplied only by the external release workflow secret boundary.

- The historical `tool-evolver-release-v1` identity is permanently revoked because its private half was committed in repository history. It must never be trusted for a production release.
- Production source, test fixtures, npm packages, and release artifacts contain **no private signing key**.
- Production packaging requires `TOOL_EVOLVER_RELEASE_KEY_ID`, `TOOL_EVOLVER_RELEASE_PUBLIC_KEY_PEM`, and `TOOL_EVOLVER_RELEASE_PRIVATE_KEY_PEM`. The private key is accepted only in memory and its derived public key must match the externally configured public key.
- `release-trust.json` contains public material only. It is informational metadata; production clients must pin the expected public key/key ID independently rather than trusting the key embedded in downloaded content.
- Unit/integration release tests generate ephemeral Ed25519 identities at runtime with `test-only-*` identifiers, and test evidence is marked `TEST_ONLY`. Production verification rejects both.
- The signed manifest binds the exact Git commit, workflow run identity, package digests, distributed asset digests, and release-evidence digests.
'''
write("docs/release/signing-trust.md", docs)


# Final FIN-002 alignment: production evidence input, signed payload shape, and
# independent trust in direct release-verifier tests.

# Production package CLI consumes qualification evidence only from an explicit file.
p = "scripts/package-release.mjs"
s = read(p)
old = '''  const releaseIdentity = resolveReleaseIdentity({ ...options, rootDir, testOnly });
  const keyPair = resolveSigningKey({ ...options, testOnly });

  console.log(`📦 Packaging Tool Evolver V${RELEASE_VERSION} Release...`);'''
new = '''  const releaseIdentity = resolveReleaseIdentity({ ...options, rootDir, testOnly });
  const keyPair = resolveSigningKey({ ...options, testOnly });
  let verificationEvidence = options.verificationEvidence;
  if (!verificationEvidence && !testOnly && process.env.TOOL_EVOLVER_RELEASE_EVIDENCE_PATH) {
    const evidencePath = path.resolve(rootDir, process.env.TOOL_EVOLVER_RELEASE_EVIDENCE_PATH);
    verificationEvidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  }

  console.log(`📦 Packaging Tool Evolver V${RELEASE_VERSION} Release...`);'''
s = replace_once(s, old, new, "production verification evidence input")
s = s.replace(
    "    verificationEvidence: options.verificationEvidence,\n",
    "    verificationEvidence,\n",
    1,
)
write(p, s)

# The installer must verify the same complete signed payload emitted by FIN-002,
# while retaining compatibility with older test fixtures that omit optional V2 fields.
p = "apps/cli/src/installer/channel-verifier.ts"
s = read(p)
s = s.replace(
    '''export interface ChannelMetadata {
  readonly schemaVersion: string;''',
    '''export interface ChannelMetadata {
  readonly schemaVersion: string;
  readonly releaseIdentity?: unknown;
  readonly revokedKeyIds?: string[];''',
    1,
)
s = s.replace(
    '''export interface SignedManifest {
  readonly schemaVersion: string;''',
    '''export interface SignedManifest {
  readonly schemaVersion: string;
  readonly releaseIdentity?: unknown;
  readonly evidence?: unknown;''',
    1,
)
old = '''    const payloadToVerify = {
      schemaVersion: meta.schemaVersion,
      minSupportedVersion: meta.minSupportedVersion,
      currentVersion: meta.currentVersion,
      updatedAt: meta.updatedAt,
      channels: meta.channels,
      rollbackReferences: meta.rollbackReferences,
      revokedVersions: meta.revokedVersions,
    };'''
new = '''    const payloadToVerify = {
      schemaVersion: meta.schemaVersion,
      minSupportedVersion: meta.minSupportedVersion,
      currentVersion: meta.currentVersion,
      updatedAt: meta.updatedAt,
      ...(meta.releaseIdentity ? { releaseIdentity: meta.releaseIdentity } : {}),
      channels: meta.channels,
      rollbackReferences: meta.rollbackReferences,
      revokedVersions: meta.revokedVersions,
      ...(meta.revokedKeyIds ? { revokedKeyIds: meta.revokedKeyIds } : {}),
    };'''
s = replace_once(s, old, new, "channel signed payload V2")
old = '''    const payloadToVerify = {
      schemaVersion: manifest.schemaVersion,
      version: manifest.version,
      releaseDate: manifest.releaseDate,
      packages: manifest.packages,
      assets: manifest.assets,
    };'''
new = '''    const payloadToVerify = {
      schemaVersion: manifest.schemaVersion,
      version: manifest.version,
      releaseDate: manifest.releaseDate,
      ...(manifest.releaseIdentity ? { releaseIdentity: manifest.releaseIdentity } : {}),
      packages: manifest.packages,
      assets: manifest.assets,
      ...(manifest.evidence ? { evidence: manifest.evidence } : {}),
    };'''
s = replace_once(s, old, new, "manifest signed payload V2")
write(p, s)

# Direct channel verification unit test must pin the test key independently.
p = "scripts/verify-release.test.mjs"
s = read(p)
old = '''      const violations = verifyChannelMetadata(tempReleaseDir);
      expect(violations).toHaveLength(0);'''
new = '''      const signature = channels.signatures[0];
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
      expect(violations).toHaveLength(0);'''
s = replace_once(s, old, new, "direct channel verifier trust")
write(p, s)

# Test-only evidence markdown must not make production qualification claims.
p = "scripts/generate-release-evidence.mjs"
s = read(p)
old = '''  lines.push(
    "- **Encrypted Backup & Restore Rehearsal**: Verified AES-256-GCM zero-data-loss recovery (`apps/cloud/tests/staging/backup-restore-rehearsal.test.ts`).",
  );
  lines.push(
    "- **Chaos Fault Injection Matrix**: Verified 12 chaos failure modes with 100% recovery (`apps/cloud/tests/staging/fault-injection-matrix.test.ts`).",
  );
  lines.push(
    "- **24h Soak Performance Profile**: Verified p95 latency < 50ms (42ms observed) and 0.00% error rate under peak load (`apps/cloud/tests/staging/soak-profile.test.ts`).",
  );'''
new = '''  const cloudQualification = evidence.qualification.cloudStaging || {};
  lines.push(
    `- **Backup & Restore Rehearsal**: ${cloudQualification.backupRestoreRehearsal?.status || "UNVERIFIED"}.`,
  );
  lines.push(
    `- **Fault Injection Matrix**: ${cloudQualification.faultInjectionMatrix?.status || "UNVERIFIED"}.`,
  );
  lines.push(
    `- **Soak Performance Profile**: ${cloudQualification.soakPerformance?.status || "UNVERIFIED"}.`,
  );'''
s = replace_once(s, old, new, "non-fabricated staging markdown")
old = '''  lines.push(
    "- **Secret Scanner Audit**: 0 leaked keys or private tokens detected across the entire codebase.",
  );
  lines.push(
    "- **Monorepo Boundaries**: 15 workspace packages verified with 0 boundary violations.",
  );
  lines.push("- **Architecture Decision Records**: 10 ADRs verified and enforced.");'''
new = '''  lines.push(
    `- **Security Audit Evidence**: ${evidence.qualification.securityAudit?.status || "UNVERIFIED"}.`,
  );'''
s = replace_once(s, old, new, "non-fabricated security markdown")
write(p, s)

# Assert known compromised material and self-trusting defaults are gone.
for path in Path(".").rglob("*"):
    if not path.is_file() or ".git" in path.parts or "node_modules" in path.parts:
        continue
    try:
        text = path.read_text()
    except Exception:
        continue
    if "MC4CAQAwBQYDK2VwBCIEIKHrfxWS03wRJJBHc6iyHjaoz93NxyMnlkCPd0XkQJcC" in text:
        raise SystemExit(f"compromised private key still present: {path}")
    if "DEFAULT_RELEASE_KEY" in text:
        raise SystemExit(f"legacy private release key symbol still present: {path}")
    if "DEFAULT_RELEASE_PUBLIC_KEY" in text:
        raise SystemExit(f"legacy self-trusting public key symbol still present: {path}")

print("FIN-002 release trust hardening applied")
