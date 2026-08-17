import { hashCanonicalContent } from "@tool-evolver/contracts";
import { describe, expect, it } from "vitest";
import { ArtifactSigner } from "../../../src/evolution/artifacts/signer.js";
import { createMockToolManifest, createTestArtifactEnvironment } from "./helpers.js";

describe("ArtifactSigner - Asymmetric Artifact Signing & Trust Management", () => {
  const signer = new ArtifactSigner();

  it("should generate valid keypairs for ed25519, ecdsa_p256_sha256, and rsa_pss_sha256", () => {
    const edKey = signer.generateKeyPair("ed25519");
    expect(edKey.keyId).toMatch(/^key_ed25519_/);
    expect(edKey.algorithm).toBe("ed25519");
    expect(edKey.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(edKey.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(edKey.status).toBe("active");

    const ecKey = signer.generateKeyPair("ecdsa_p256_sha256");
    expect(ecKey.keyId).toMatch(/^key_ecdsa-p256-sha256_/);
    expect(ecKey.algorithm).toBe("ecdsa_p256_sha256");
    expect(ecKey.publicKeyPem).toContain("BEGIN PUBLIC KEY");

    const rsaKey = signer.generateKeyPair("rsa_pss_sha256");
    expect(rsaKey.keyId).toMatch(/^key_rsa-pss-sha256_/);
    expect(rsaKey.algorithm).toBe("rsa_pss_sha256");
    expect(rsaKey.publicKeyPem).toContain("BEGIN PUBLIC KEY");
  });

  it("should sign and verify artifact signatures across supported algorithms", () => {
    const manifest = createMockToolManifest();
    const artifactDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    // 1. Ed25519
    const edKey = signer.generateKeyPair("ed25519");
    const edSig = signer.signArtifact(artifactDigest, manifest, {
      keyId: edKey.keyId,
      privateKeyPem: edKey.privateKeyPem!,
      algorithm: "ed25519",
    });

    const edVerify = signer.verifySignature(artifactDigest, manifest, edSig, edKey.publicKeyPem);
    expect(edVerify.valid).toBe(true);
    expect(edVerify.error).toBeUndefined();

    // 2. ECDSA P-256
    const ecKey = signer.generateKeyPair("ecdsa_p256_sha256");
    const ecSig = signer.signArtifact(artifactDigest, manifest, {
      keyId: ecKey.keyId,
      privateKeyPem: ecKey.privateKeyPem!,
      algorithm: "ecdsa_p256_sha256",
    });

    const ecVerify = signer.verifySignature(artifactDigest, manifest, ecSig, ecKey.publicKeyPem);
    expect(ecVerify.valid).toBe(true);

    // 3. RSA-PSS
    const rsaKey = signer.generateKeyPair("rsa_pss_sha256");
    const rsaSig = signer.signArtifact(artifactDigest, manifest, {
      keyId: rsaKey.keyId,
      privateKeyPem: rsaKey.privateKeyPem!,
      algorithm: "rsa_pss_sha256",
    });

    const rsaVerify = signer.verifySignature(artifactDigest, manifest, rsaSig, rsaKey.publicKeyPem);
    expect(rsaVerify.valid).toBe(true);
  });

  it("should detect tampering when artifact digest or manifest is altered", () => {
    const manifest = createMockToolManifest();
    const artifactDigest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const edKey = signer.generateKeyPair("ed25519");

    const sig = signer.signArtifact(artifactDigest, manifest, {
      keyId: edKey.keyId,
      privateKeyPem: edKey.privateKeyPem!,
      algorithm: "ed25519",
    });

    // Tampered artifact digest
    const tamperedDigest = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const result1 = signer.verifySignature(tamperedDigest, manifest, sig, edKey.publicKeyPem);
    expect(result1.valid).toBe(false);

    // Tampered manifest
    const alteredManifest = { ...manifest, name: "Tampered Name", digest: "" };
    alteredManifest.digest = hashCanonicalContent(alteredManifest);
    const result2 = signer.verifySignature(
      artifactDigest,
      alteredManifest,
      sig,
      edKey.publicKeyPem,
    );
    expect(result2.valid).toBe(false);

    // Corrupted signature bytes
    const corruptedSig = { ...sig, signature: `deadbeef${sig.signature.slice(8)}` };
    const result3 = signer.verifySignature(
      artifactDigest,
      manifest,
      corruptedSig,
      edKey.publicKeyPem,
    );
    expect(result3.valid).toBe(false);
  });

  it("should manage key rotation and revocation through SigningKeyRepository", async () => {
    const env = await createTestArtifactEnvironment();
    const manifest = createMockToolManifest();
    const artifactDigest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    // Register initial key
    const initialKey = signer.generateKeyPair("ed25519");
    await env.signingKeyRepo.saveKey(initialKey);

    const initialSig = signer.signArtifact(artifactDigest, manifest, {
      keyId: initialKey.keyId,
      privateKeyPem: initialKey.privateKeyPem!,
      algorithm: "ed25519",
    });

    // Verify initial signature
    expect(
      signer.verifySignature(artifactDigest, manifest, initialSig, initialKey.publicKeyPem).valid,
    ).toBe(true);

    // Rotate key
    const newKey = signer.generateKeyPair("ed25519");
    await env.signingKeyRepo.rotateKey(initialKey.keyId, newKey);

    // Verify old key status is rotated and new key is active
    const oldKeyRecord = await env.signingKeyRepo.getKey(initialKey.keyId);
    expect(oldKeyRecord?.status).toBe("rotated");
    const activeKey = await env.signingKeyRepo.getActiveKey("ed25519");
    expect(activeKey?.keyId).toBe(newKey.keyId);

    // Existing signature with rotated key remains valid
    expect(
      signer.verifySignature(artifactDigest, manifest, initialSig, initialKey.publicKeyPem).valid,
    ).toBe(true);

    // Revoke old key
    await env.signingKeyRepo.revokeKey(initialKey.keyId, "Key compromise simulation");
    const isRevoked = await env.signingKeyRepo.isRevoked(initialKey.keyId);
    expect(isRevoked).toBe(true);
    const revokedKeyRecord = await env.signingKeyRepo.getKey(initialKey.keyId);
    expect(revokedKeyRecord?.status).toBe("revoked");
    expect(revokedKeyRecord?.revocationReason).toBe("Key compromise simulation");
  });
});
