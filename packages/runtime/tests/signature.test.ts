import { describe, expect, it } from "vitest";
import {
  InMemoryKeyStore,
  createDevelopmentKeyStore,
  generateBundleKeyPair,
  getDevelopmentKeyPair,
  signBundlePayload,
  verifyBundleSignature,
} from "../src/bundle/signature.js";
import type { BundleSignatureAlgorithm } from "../src/bundle/spec.js";

describe("bundle signature and key store", () => {
  const algorithms: BundleSignatureAlgorithm[] = ["ed25519", "ecdsa_p256_sha256", "rsa_pss_sha256"];

  for (const algo of algorithms) {
    it(`generates key pair, signs, and successfully verifies with algorithm: ${algo}`, async () => {
      const keyPair = generateBundleKeyPair(algo, `test-key-${algo}`);
      const keyStore = new InMemoryKeyStore([
        {
          keyId: keyPair.keyId,
          algorithm: keyPair.algorithm,
          publicKeyPem: keyPair.publicKeyPem,
          trustLevel: "production",
          createdAt: new Date().toISOString(),
        },
      ]);

      const bundleDigest = "a".repeat(64);
      const fileDigests = {
        "manifest.json": "b".repeat(64),
        "src/index.ts": "c".repeat(64),
      };

      const sigData = signBundlePayload(bundleDigest, fileDigests, {
        keyId: keyPair.keyId,
        privateKeyPem: keyPair.privateKeyPem,
        algorithm: algo,
      });

      const verification = await verifyBundleSignature(sigData, keyStore);
      expect(verification.valid).toBe(true);
      expect(verification.keyId).toBe(keyPair.keyId);
      expect(verification.algorithm).toBe(algo);
    });
  }

  it("detects tampered bundle digest", async () => {
    const keyPair = generateBundleKeyPair("ed25519", "dev-key-tamper");
    const keyStore = new InMemoryKeyStore([
      {
        keyId: keyPair.keyId,
        algorithm: keyPair.algorithm,
        publicKeyPem: keyPair.publicKeyPem,
        trustLevel: "production",
        createdAt: new Date().toISOString(),
      },
    ]);

    const bundleDigest = "1".repeat(64);
    const sigData = signBundlePayload(
      bundleDigest,
      {},
      {
        keyId: keyPair.keyId,
        privateKeyPem: keyPair.privateKeyPem,
        algorithm: "ed25519",
      },
    );

    // Verify with mismatched expected digest
    const verification = await verifyBundleSignature(sigData, keyStore, {
      expectedBundleDigest: "2".repeat(64),
    });

    expect(verification.valid).toBe(false);
    expect(verification.reason).toBe("BUNDLE_DIGEST_MISMATCH");
  });

  it("rejects revoked signing keys", async () => {
    const keyPair = generateBundleKeyPair("ed25519", "revoked-key");
    const keyStore = new InMemoryKeyStore([
      {
        keyId: keyPair.keyId,
        algorithm: keyPair.algorithm,
        publicKeyPem: keyPair.publicKeyPem,
        trustLevel: "production",
        createdAt: new Date().toISOString(),
      },
    ]);

    const sigData = signBundlePayload(
      "3".repeat(64),
      {},
      {
        keyId: keyPair.keyId,
        privateKeyPem: keyPair.privateKeyPem,
        algorithm: "ed25519",
      },
    );

    // Revoke key
    await keyStore.revokeKey(keyPair.keyId);

    const verification = await verifyBundleSignature(sigData, keyStore);
    expect(verification.valid).toBe(false);
    expect(verification.reason).toBe("UNTRUSTED_KEY");
  });

  it("handles development keys and policy restrictions", async () => {
    const devKeyStore = createDevelopmentKeyStore();
    const devKey = getDevelopmentKeyPair();

    const sigData = signBundlePayload(
      "4".repeat(64),
      {},
      {
        keyId: devKey.keyId,
        privateKeyPem: devKey.privateKeyPem,
        algorithm: "ed25519",
      },
    );

    // Allowed with allowDevKeys: true
    const verifyDevAllowed = await verifyBundleSignature(sigData, devKeyStore, {
      allowDevKeys: true,
    });
    expect(verifyDevAllowed.valid).toBe(true);

    // Rejected with allowDevKeys: false (production mode)
    const verifyDevBlocked = await verifyBundleSignature(sigData, devKeyStore, {
      allowDevKeys: false,
    });
    expect(verifyDevBlocked.valid).toBe(false);
    expect(verifyDevBlocked.reason).toBe("UNTRUSTED_KEY");
  });
});
