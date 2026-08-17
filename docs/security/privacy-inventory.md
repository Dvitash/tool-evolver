# Privacy Data Inventory & Consent Lifecycle

This document provides an exhaustive inventory of all data classes handled, stored, or processed by Tool Evolver, along with consent requirements and retention periods.

---

## 1. Data Classification Matrix

| Data Element | Classification | Storage Location | Retention Period | Transmitted to Cloud? |
|--------------|----------------|------------------|------------------|------------------------|
| **Raw User Prompts** | Highly Confidential | Ephemeral (RAM only) | Dropped immediately | ❌ **Never** |
| **Assistant Reasoning / Thoughts** | Highly Confidential | Ephemeral (RAM only) | Dropped immediately | ❌ **Never** |
| **Workspace Source Code** | Confidential | Local Workspace | User controlled | ❌ **Never** |
| **API Keys & Secrets** | Restricted | OS Secure Vault | Revoked on `logout` | ❌ **Never** |
| **Normalized Session Events** | Internal | `~/.tool-evolver/state/local.db` | 30 Days (auto-pruned) | ❌ No (Local only) |
| **Tool Execution Metrics** | Telemetry (Opt-in) | `~/.tool-evolver/state/local.db` | 90 Days | ✅ Aggregated only (if opted-in) |
| **Device ID & Public Key** | Public Metadata | Cloud Auth DB | Active Device Lifetime | ✅ Yes (during init) |

---

## 2. Consent Lifecycle

```text
┌─────────────────────────────────────────────────────────────┐
│                    npx tool-evolver init                    │
│            Explicit Capability Authorization Prompt         │
└──────────────────────────────┬──────────────────────────────┘
                               │
            ┌──────────────────┴──────────────────┐
            ▼                                     ▼
   [ Explicit Consent Granted ]           [ Consent Denied ]
            │                                     │
            ▼                                     ▼
  Store Encrypted Auth in Vault         Abort Installation
  Start Local Daemon & Gateway          No Files Modified
            │
            ▼
┌─────────────────────────────────────────────────────────────┐
│                    tool-evolver logout                      │
│        Revoke Device Token, Purge Local Vault Keys          │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Real-Time Redaction Engine

Before any normalized event or log line is committed to `local.db` or exported in a diagnostic bundle, it passes through the privacy redaction filter:

- **Token Redaction**: Matches patterns for JWT, Bearer tokens, GitHub Personal Access Tokens, AWS Access Keys, and Anthropic/OpenAI API keys.
- **Path Sanitization**: Replaces home directory paths (`/home/username/...`) with `~/$PROJECT_ROOT/` when generating diagnostics.
- **Entropy Filtering**: Replaces high-entropy character sequences (> 4.5 Shannon entropy) with `[REDACTED_ENTROPY]`.

---

## Related Documentation

- [Security Threat Model](threat-model.md)
- [Vulnerability Reporting](vulnerability-reporting.md)
- [Support Policy](support-policy.md)
- [User Security & Privacy Model](../user/security-and-privacy.md)
