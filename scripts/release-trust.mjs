import crypto from "node:crypto";

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
    throw new Error(
      "Release signing public key is required so the private key can be cross-checked.",
    );
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
  const keyId =
    typeof env.TOOL_EVOLVER_RELEASE_KEY_ID === "string"
      ? env.TOOL_EVOLVER_RELEASE_KEY_ID.trim()
      : "";
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
