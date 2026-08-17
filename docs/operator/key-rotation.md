# Key Rotation & Secret Management Guide

This document outlines the cryptographic keys, rotation intervals, emergency revocation procedures, and migration strategies used across the Tool Evolver platform.

---

## 1. Cryptographic Key Inventory

| Key Purpose | Algorithm | Storage Location | Standard Rotation Interval |
|-------------|-----------|------------------|----------------------------|
| **Release Signing Key** | Ed25519 | Hardware Security Module (HSM) / Offline Vault | 12 Months |
| **Tool Bundle Signing Key** | Ed25519 | Cloud KMS / Secret Manager | 6 Months |
| **Device Auth JWT Signing** | Ed25519 / ES256 | Cloud KMS | 90 Days |
| **Local Vault Encryption** | AES-256-GCM | OS Keychain / System Keyring | Per Device Lifecycle |

---

## 2. Release & Bundle Signing Key Rotation

Tool Evolver uses dual-key verification windows during scheduled key rotations to ensure backward compatibility for distributed clients.

### Step 1: Generate New Keypair in KMS
```bash
# Generate new Ed25519 keypair with key ID: release-key-2027
pnpm --filter @tool-evolver/crypto run keygen:ed25519 --id release-key-2027 --out ./keys/
```

### Step 2: Publish Public Key in Trust Keystore
Add the new public key to the cloud trust store while retaining the previous key in `deprecated` mode:

```json
{
  "keys": [
    {
      "keyId": "release-key-2027",
      "algorithm": "Ed25519",
      "publicKey": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "status": "active",
      "validFrom": "2026-08-17T00:00:00Z"
    },
    {
      "keyId": "release-key-2026",
      "algorithm": "Ed25519",
      "publicKey": "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      "status": "grace_period",
      "validUntil": "2026-11-17T00:00:00Z"
    }
  ]
}
```

---

## 3. Emergency Key Revocation

If a signing key is suspected to be compromised:

1. **Mark Key as Revoked in Cloud Keystore**:
   ```bash
   pnpm --filter @tool-evolver/cloud run keys:revoke --key-id release-key-2026 --reason "Compromise suspected"
   ```
2. **Push Instant Keystore Invalidation**:
   The cloud gateway immediately propagates a trust update to all active observer daemons.
3. **Re-sign Active Tool Bundles**:
   Re-sign all promoted tool manifests using the newly active key.

---

## 4. Local Device Token Revocation

To revoke a local device's credentials:

```bash
tool-evolver logout
```

This immediately revokes the device's authorization token with the cloud auth service and purges local encryption keys from the system keychain.

---

## Related Documentation

- [Deployment Architecture](deployment.md)
- [Operational Runbooks](runbooks.md)
- [Security Threat Model](../security/threat-model.md)
- [Backup & Restore](backup-and-restore.md)
