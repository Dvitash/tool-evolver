import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type ChannelMetadata,
  DEFAULT_RELEASE_PUBLIC_KEY,
  type ManifestAsset,
  type SignedManifest,
  canonicalJson,
  compareSemver,
  isVersionAtLeast,
  isVersionRevoked,
  selectPlatformAsset,
  verifyChannelMetadata,
  verifyEd25519Signature,
  verifyManifest,
} from "../../src/installer/channel-verifier.js";

// Deterministic test Ed25519 keypair
const TEST_KEYPAIR = {
  keyId: "test-release-key-v1",
  publicKeyHex: "a4b9318ac386c0e21c30aba1e211c54883ceb53a39689980f2e27387c6c5ea95",
  privateKeyPkcs8Pem:
    // secret-scanner:ignore gitleaks:allow
    "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIKHrfxWS03wRJJBHc6iyHjaoz93NxyMnlkCPd0XkQJcC\n-----END PRIVATE KEY-----\n",
};

function signPayload(payload: unknown, privateKeyPem = TEST_KEYPAIR.privateKeyPkcs8Pem): string {
  const canonical = canonicalJson(payload);
  const dataBuf = Buffer.from(canonical, "utf8");
  const privKey = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, dataBuf, privKey).toString("hex");
}

describe("signed-channel-verifier: Release channel metadata & cryptographic integrity", () => {
  describe("Ed25519 signature verification", () => {
    it("verifies valid signatures over canonical JSON payloads", () => {
      const payload = {
        version: "1.0.0",
        releaseDate: "2026-08-17T00:00:00.000Z",
        channel: "stable",
      };

      const signatureHex = signPayload(payload);
      const valid = verifyEd25519Signature(payload, signatureHex, TEST_KEYPAIR.publicKeyHex);
      expect(valid).toBe(true);
    });

    it("rejects tampered payloads with signature verification failure", () => {
      const payload = {
        version: "1.0.0",
        releaseDate: "2026-08-17T00:00:00.000Z",
        channel: "stable",
      };

      const signatureHex = signPayload(payload);

      // Tampered payload
      const tamperedPayload = {
        version: "1.0.1-malicious",
        releaseDate: "2026-08-17T00:00:00.000Z",
        channel: "stable",
      };

      const valid = verifyEd25519Signature(
        tamperedPayload,
        signatureHex,
        TEST_KEYPAIR.publicKeyHex,
      );
      expect(valid).toBe(false);
    });

    it("rejects corrupted or malformed signature hex strings", () => {
      const payload = { foo: "bar" };
      const valid = verifyEd25519Signature(
        payload,
        "invalid_hex_signature",
        TEST_KEYPAIR.publicKeyHex,
      );
      expect(valid).toBe(false);
    });
  });

  describe("SemVer comparison and policy enforcement", () => {
    it("compares semver strings correctly", () => {
      expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
      expect(compareSemver("1.1.0", "1.0.0")).toBe(1);
      expect(compareSemver("1.0.0", "1.1.0")).toBe(-1);
      expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
      expect(compareSemver("1.0.0", "1.0.0-alpha.1")).toBe(1);
      expect(compareSemver("1.0.0-alpha.1", "1.0.0")).toBe(-1);
    });

    it("enforces minimum supported version constraints", () => {
      expect(isVersionAtLeast("1.0.0", "0.1.0")).toBe(true);
      expect(isVersionAtLeast("0.1.0", "0.1.0")).toBe(true);
      expect(isVersionAtLeast("0.0.9", "0.1.0")).toBe(false);
    });

    it("checks revocation lists accurately", () => {
      const revoked = ["0.0.9", "v1.0.0-rc.1", "0.1.0-compromised"];
      expect(isVersionRevoked("0.0.9", revoked)).toBe(true);
      expect(isVersionRevoked("v0.0.9", revoked)).toBe(true);
      expect(isVersionRevoked("1.0.0-rc.1", revoked)).toBe(true);
      expect(isVersionRevoked("1.0.0", revoked)).toBe(false);
      expect(isVersionRevoked("1.0.0", undefined)).toBe(false);
    });
  });

  describe("Channel metadata verification", () => {
    it("verifies valid channel metadata and extracts channel details", () => {
      const metadataPayload = {
        schemaVersion: "1.0.0",
        minSupportedVersion: "0.1.0",
        currentVersion: "1.0.0",
        updatedAt: "2026-08-17T00:00:00.000Z",
        channels: {
          stable: {
            version: "1.0.0",
            releaseDate: "2026-08-17T00:00:00.000Z",
            manifestUrl: "https://releases.tool-evolver.dev/v1.0.0/manifest.json",
            manifestDigest: "abc123def456",
            isLatest: true,
          },
          prerelease: {
            version: "1.1.0-alpha.1",
            releaseDate: "2026-08-17T00:00:00.000Z",
            minSupportedVersion: "1.0.0",
            isLatest: false,
          },
        },
        rollbackReferences: {
          targetVersion: "0.1.0",
          minSafeVersion: "0.1.0",
          rollbackTarball: "tool-evolver-v0.1.0-rollback.tar.gz",
          rollbackSha256: "fedcba987654",
        },
        revokedVersions: ["0.0.8", "0.0.9"],
      };

      const signature = signPayload(metadataPayload);
      const channelData: ChannelMetadata = {
        ...metadataPayload,
        signatures: [
          {
            keyId: TEST_KEYPAIR.keyId,
            algorithm: "Ed25519",
            publicKeyHex: TEST_KEYPAIR.publicKeyHex,
            signatureHex: signature,
          },
        ],
      };

      const result = verifyChannelMetadata(channelData, {
        channel: "stable",
        trustedPublicKeys: [TEST_KEYPAIR.publicKeyHex],
      });

      expect(result.valid).toBe(true);
      expect(result.channel).toBe("stable");
      expect(result.targetVersion).toBe("1.0.0");
      expect(result.manifestDigest).toBe("abc123def456");
      expect(result.rollbackReference?.targetVersion).toBe("0.1.0");
      expect(result.errors).toHaveLength(0);
    });

    it("rejects revoked versions in channel metadata", () => {
      const channelData: ChannelMetadata = {
        schemaVersion: "1.0.0",
        currentVersion: "0.0.9",
        updatedAt: "2026-08-17T00:00:00.000Z",
        channels: {
          stable: {
            version: "0.0.9",
            releaseDate: "2026-08-17T00:00:00.000Z",
          },
        },
        revokedVersions: ["0.0.9"],
      };

      const result = verifyChannelMetadata(channelData, {
        channel: "stable",
        skipSignatureVerification: true,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("revoked"))).toBe(true);
    });

    it("rejects versions below minimum supported version", () => {
      const channelData: ChannelMetadata = {
        schemaVersion: "1.0.0",
        minSupportedVersion: "1.0.0",
        currentVersion: "0.9.0",
        updatedAt: "2026-08-17T00:00:00.000Z",
        channels: {
          stable: {
            version: "0.9.0",
            releaseDate: "2026-08-17T00:00:00.000Z",
          },
        },
      };

      const result = verifyChannelMetadata(channelData, {
        channel: "stable",
        skipSignatureVerification: true,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("minimum supported version"))).toBe(true);
    });
  });

  describe("Signed manifest verification", () => {
    it("verifies signed release manifest and checks SHA-256 digest", () => {
      const manifest: SignedManifest = {
        schemaVersion: "1.0.0",
        version: "1.0.0",
        releaseDate: "2026-08-17T00:00:00.000Z",
        assets: {
          "linux-x64": {
            filename: "tool-evolver-v1.0.0-linux-x64.tar.gz",
            platform: "linux",
            arch: "x64",
            isWsl: false,
            sizeBytes: 1048576,
            sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            path: "dist/release/v1.0.0/tool-evolver-v1.0.0-linux-x64.tar.gz",
          },
        },
      };

      const rawCanonical = canonicalJson(manifest);
      const expectedDigest = crypto.createHash("sha256").update(rawCanonical).digest("hex");

      const result = verifyManifest(manifest, {
        expectedDigest,
        skipSignatureVerification: true,
      });

      expect(result.valid).toBe(true);
      expect(result.version).toBe("1.0.0");
      expect(result.assets["linux-x64"]).toBeDefined();
    });

    it("rejects manifest with digest mismatch", () => {
      const manifest: SignedManifest = {
        schemaVersion: "1.0.0",
        version: "1.0.0",
        releaseDate: "2026-08-17T00:00:00.000Z",
        assets: {},
      };

      const result = verifyManifest(manifest, {
        expectedDigest: "tampered_digest_value_12345",
        skipSignatureVerification: true,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("digest mismatch"))).toBe(true);
    });
  });

  describe("Exact OS/Architecture artifact selection", () => {
    const fullManifest: SignedManifest = {
      schemaVersion: "1.0.0",
      version: "1.0.0",
      releaseDate: "2026-08-17T00:00:00.000Z",
      assets: {
        "linux-x64": {
          filename: "tool-evolver-v1.0.0-linux-x64.tar.gz",
          platform: "linux",
          arch: "x64",
          isWsl: false,
          sizeBytes: 1000,
          sha256: "sha_linux_x64",
          path: "dist/release/v1.0.0/tool-evolver-v1.0.0-linux-x64.tar.gz",
        },
        "linux-arm64": {
          filename: "tool-evolver-v1.0.0-linux-arm64.tar.gz",
          platform: "linux",
          arch: "arm64",
          isWsl: false,
          sizeBytes: 1000,
          sha256: "sha_linux_arm64",
          path: "dist/release/v1.0.0/tool-evolver-v1.0.0-linux-arm64.tar.gz",
        },
        "darwin-x64": {
          filename: "tool-evolver-v1.0.0-darwin-x64.tar.gz",
          platform: "darwin",
          arch: "x64",
          isWsl: false,
          sizeBytes: 1000,
          sha256: "sha_darwin_x64",
          path: "dist/release/v1.0.0/tool-evolver-v1.0.0-darwin-x64.tar.gz",
        },
        "darwin-arm64": {
          filename: "tool-evolver-v1.0.0-darwin-arm64.tar.gz",
          platform: "darwin",
          arch: "arm64",
          isWsl: false,
          sizeBytes: 1000,
          sha256: "sha_darwin_arm64",
          path: "dist/release/v1.0.0/tool-evolver-v1.0.0-darwin-arm64.tar.gz",
        },
        "wsl-x64": {
          filename: "tool-evolver-v1.0.0-wsl-x64.tar.gz",
          platform: "wsl",
          arch: "x64",
          isWsl: true,
          sizeBytes: 1000,
          sha256: "sha_wsl_x64",
          path: "dist/release/v1.0.0/tool-evolver-v1.0.0-wsl-x64.tar.gz",
        },
      },
    };

    it("selects linux-x64 for Linux x64 host", () => {
      const asset = selectPlatformAsset(fullManifest, { os: "linux", arch: "x64", isWsl: false });
      expect(asset.filename).toBe("tool-evolver-v1.0.0-linux-x64.tar.gz");
      expect(asset.sha256).toBe("sha_linux_x64");
    });

    it("selects linux-arm64 for Linux ARM64 host", () => {
      const asset = selectPlatformAsset(fullManifest, { os: "linux", arch: "arm64", isWsl: false });
      expect(asset.filename).toBe("tool-evolver-v1.0.0-linux-arm64.tar.gz");
      expect(asset.sha256).toBe("sha_linux_arm64");
    });

    it("selects darwin-arm64 for macOS Apple Silicon host", () => {
      const asset = selectPlatformAsset(fullManifest, {
        os: "darwin",
        arch: "arm64",
        isWsl: false,
      });
      expect(asset.filename).toBe("tool-evolver-v1.0.0-darwin-arm64.tar.gz");
      expect(asset.sha256).toBe("sha_darwin_arm64");
    });

    it("selects wsl-x64 for WSL host", () => {
      const asset = selectPlatformAsset(fullManifest, { os: "wsl", arch: "x64", isWsl: true });
      expect(asset.filename).toBe("tool-evolver-v1.0.0-wsl-x64.tar.gz");
      expect(asset.sha256).toBe("sha_wsl_x64");
    });

    it("throws clear error when no compatible platform asset exists", () => {
      expect(() => {
        selectPlatformAsset(fullManifest, { os: "freebsd", arch: "riscv64", isWsl: false });
      }).toThrow(/No compatible release asset found/);
    });
  });
});
