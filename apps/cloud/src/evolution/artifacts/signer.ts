import crypto, { randomUUID } from "node:crypto";
import {
  type SignatureMetadata,
  type ToolManifest,
  canonicalJson,
  hashCanonicalContent,
} from "@tool-evolver/contracts";
import type {
  SigningKeyAlgorithm,
  SigningKeyMetadata,
  SigningKeyStatus,
  SigningKeyTrustLevel,
} from "./types.js";

/**
 * Result of artifact signature verification.
 */
export interface SignatureVerificationResult {
  valid: boolean;
  keyId: string;
  algorithm: SigningKeyAlgorithm;
  error?: string;
  keyStatus?: SigningKeyStatus;
}

/**
 * Creates canonical payload buffer for signing artifact and manifest digests.
 */
export function createArtifactSignPayload(
  artifactDigest: string,
  manifestDigest: string,
  keyId: string,
  algorithm: SigningKeyAlgorithm,
  signedAt: string,
): Buffer {
  const canonicalString = canonicalJson({
    algorithm,
    artifactDigest,
    keyId,
    manifestDigest,
    signedAt,
  });
  return Buffer.from(canonicalString, "utf8");
}

/**
 * Asymmetric Artifact Signer and Cryptographic Trust Manager.
 * Signs artifact packages using Ed25519, ECDSA, or RSA-PSS, and validates signatures against trust stores.
 */
export class ArtifactSigner {
  /**
   * Generates a new cryptographic keypair and returns its metadata.
   */
  generateKeyPair(
    algorithm: SigningKeyAlgorithm = "ed25519",
    trustLevel: SigningKeyTrustLevel = "production",
  ): SigningKeyMetadata {
    const keyId = `key_${algorithm.replace(/_/g, "-")}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const now = new Date().toISOString();

    if (algorithm === "ed25519") {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
      return {
        keyId,
        algorithm,
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        status: "active",
        trustLevel,
        createdAt: now,
      };
    }

    if (algorithm === "ecdsa_p256_sha256") {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
      });
      return {
        keyId,
        algorithm,
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        status: "active",
        trustLevel,
        createdAt: now,
      };
    }

    if (algorithm === "rsa_pss_sha256") {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
      });
      return {
        keyId,
        algorithm,
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        status: "active",
        trustLevel,
        createdAt: now,
      };
    }

    throw new Error(`Unsupported signature algorithm: ${algorithm}`);
  }

  /**
   * Signs artifact digest and manifest deterministically.
   */
  signArtifact(
    artifactDigest: string,
    manifestOrDigest: ToolManifest | string,
    options: {
      keyId: string;
      privateKeyPem: string;
      algorithm: SigningKeyAlgorithm;
      signedAt?: string;
      certificateChain?: string[];
    },
  ): SignatureMetadata {
    const manifestDigest =
      typeof manifestOrDigest === "string"
        ? manifestOrDigest
        : hashCanonicalContent(manifestOrDigest);

    const signedAt = options.signedAt ?? new Date().toISOString();
    const payloadBuffer = createArtifactSignPayload(
      artifactDigest,
      manifestDigest,
      options.keyId,
      options.algorithm,
      signedAt,
    );

    let signatureHex: string;

    if (options.algorithm === "ed25519") {
      const signature = crypto.sign(null, payloadBuffer, options.privateKeyPem);
      signatureHex = signature.toString("hex");
    } else if (options.algorithm === "ecdsa_p256_sha256") {
      const signer = crypto.createSign("SHA256");
      signer.update(payloadBuffer);
      signer.end();
      signatureHex = signer.sign(options.privateKeyPem, "hex");
    } else if (options.algorithm === "rsa_pss_sha256") {
      const signer = crypto.createSign("SHA256");
      signer.update(payloadBuffer);
      signer.end();
      signatureHex = signer.sign(
        {
          key: options.privateKeyPem,
          padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
          saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
        },
        "hex",
      );
    } else {
      throw new Error(`Unsupported signature algorithm: ${options.algorithm}`);
    }

    return {
      keyId: options.keyId,
      algorithm: options.algorithm,
      signature: signatureHex,
      signedAt,
      certificateChain: options.certificateChain,
    };
  }

  /**
   * Verifies an artifact signature using public key PEM.
   */
  verifySignature(
    artifactDigest: string,
    manifestOrDigest: ToolManifest | string,
    signatureData: SignatureMetadata,
    publicKeyPem: string,
  ): SignatureVerificationResult {
    const manifestDigest =
      typeof manifestOrDigest === "string"
        ? manifestOrDigest
        : hashCanonicalContent(manifestOrDigest);

    const payloadBuffer = createArtifactSignPayload(
      artifactDigest,
      manifestDigest,
      signatureData.keyId,
      signatureData.algorithm as SigningKeyAlgorithm,
      signatureData.signedAt,
    );

    try {
      let valid = false;

      if (signatureData.algorithm === "ed25519") {
        valid = crypto.verify(
          null,
          payloadBuffer,
          publicKeyPem,
          Buffer.from(signatureData.signature, "hex"),
        );
      } else if (signatureData.algorithm === "ecdsa_p256_sha256") {
        const verifier = crypto.createVerify("SHA256");
        verifier.update(payloadBuffer);
        verifier.end();
        valid = verifier.verify(publicKeyPem, signatureData.signature, "hex");
      } else if (signatureData.algorithm === "rsa_pss_sha256") {
        const verifier = crypto.createVerify("SHA256");
        verifier.update(payloadBuffer);
        verifier.end();
        valid = verifier.verify(
          {
            key: publicKeyPem,
            padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
            saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
          },
          signatureData.signature,
          "hex",
        );
      } else {
        return {
          valid: false,
          keyId: signatureData.keyId,
          algorithm: signatureData.algorithm as SigningKeyAlgorithm,
          error: `Unsupported signature algorithm: ${signatureData.algorithm}`,
        };
      }

      return {
        valid,
        keyId: signatureData.keyId,
        algorithm: signatureData.algorithm as SigningKeyAlgorithm,
        error: valid ? undefined : "Signature verification failed: cryptographic mismatch",
      };
    } catch (err) {
      return {
        valid: false,
        keyId: signatureData.keyId,
        algorithm: signatureData.algorithm as SigningKeyAlgorithm,
        error: `Signature verification exception: ${(err as Error).message}`,
      };
    }
  }
}

/**
 * Factory helper for ArtifactSigner.
 */
export function createArtifactSigner(): ArtifactSigner {
  return new ArtifactSigner();
}
