from pathlib import Path


def patch(path, old, new, label):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing {label} in {path}")
    p.write_text(s.replace(old, new, 1))

patch(
    "scripts/package-release.mjs",
    'const testOnly = options.testOnly === true || process.env.TOOL_EVOLVER_RELEASE_TEST_ONLY === "1";',
    'const testOnly = options.testOnly ?? (process.env.TOOL_EVOLVER_RELEASE_TEST_ONLY === "1");',
    "explicit testOnly override",
)

patch(
    "scripts/publish-v1-release.mjs",
    '''import {
  generateReleaseEvidence,
  getGitCommitSha,
  writeReleaseEvidence,
} from "./generate-release-evidence.mjs";''',
    'import { getGitCommitSha } from "./generate-release-evidence.mjs";',
    "unused evidence imports",
)

patch(
    "scripts/publish-v1-release.mjs",
    '''  const releaseIdentity = packageResult.releaseIdentity;
  const evidenceResult = writeReleaseEvidence({
    rootDir,
    distDir,
    commitSha,
    releaseIdentity,
    keyId: keyPair.keyId,
    testOnly,
    verificationEvidence: options.verificationEvidence,
    syncDocs: options.syncDocs ?? false,
  });''',
    '''  const releaseIdentity = packageResult.releaseIdentity;
  // packageRelease already generated the exact evidence whose digest is signed by
  // manifest.json. Never regenerate it after signing.
  const evidenceResult = {
    evidence: JSON.parse(fs.readFileSync(path.join(distDir, "release-evidence.json"), "utf8")),
    jsonSha256: packageResult.evidenceSha256,
  };''',
    "evidence regeneration",
)

patch(
    "scripts/release-evidence.test.mjs",
    'expect(evidence.schemaVersion).toBe("1.0.0");',
    'expect(evidence.schemaVersion).toBe("2.0.0");',
    "evidence schema assertion",
)

patch(
    "scripts/verify-release.test.mjs",
    'expect(manifest.signatures[0].signature).toMatch(/^[a-f0-9]{128}$/);',
    'expect(manifest.signatures[0].signatureHex).toMatch(/^[a-f0-9]{128}$/);',
    "signatureHex assertion",
)
patch(
    "scripts/verify-release.test.mjs",
    '''          skipBuild: true,
        }),''',
    '''          skipBuild: true,
          testOnly: false,
        }),''',
    "production fail-closed explicit mode",
)
patch(
    "scripts/verify-release.test.mjs",
    'expect(channels.schemaVersion).toBe("1.0.0");',
    'expect(channels.schemaVersion).toBe("2.0.0");',
    "channel schema assertion",
)
patch(
    "scripts/verify-release.test.mjs",
    '''      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("CycloneDX SBOM Generation & Verification",''',
    '''      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);
  });

  describe("CycloneDX SBOM Generation & Verification",''',
    "tamper test timeout",
)

print("FIN-002 release test/publication alignment applied")
