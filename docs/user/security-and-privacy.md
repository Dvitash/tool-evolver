# Security & Privacy Model

Tool Evolver is built on strict **Local-First**, **Zero Raw Data Exfiltration**, and **Principle of Least Privilege** guarantees. This document details the security architecture, capability boundaries, and privacy protections enforced by the runtime.

---

## 1. Core Security Guarantees

1. **Local-Only Raw Transcripts**: Raw prompts, assistant reasoning, thinking blocks, and workspace code never leave your local machine.
2. **Capability Envelopes**: Evolved tools execute in restricted sandboxes with explicitly declared and authorized permissions.
3. **Mediated Secret Access**: Tools never have raw read access to API keys, passwords, or cloud credentials.
4. **Automated Secret Redaction**: All normalized events, logs, and telemetry pass through real-time entropy and regex pattern masking.
5. **Tamper-Evident Audit Logging**: Every tool execution, capability modification, and lifecycle decision is recorded in an immutable local SQLite audit log.

---

## 2. The Capability Envelope

Every tool version bundled and deployed by Tool Evolver includes a strict **Capability Envelope** defining its permissible runtime surface:

```json
{
  "capabilities": {
    "fs": {
      "allowWorkspaceRoot": true,
      "allowTemp": true,
      "denyPaths": [
        "**/.git/**",
        "**/.ssh/**",
        "**/.aws/**",
        "**/.gnupg/**",
        "**/.env*"
      ],
      "maxFileSizeBytes": 10485760
    },
    "net": {
      "allowOutbound": false,
      "allowedHosts": ["127.0.0.1"],
      "denyPrivateRanges": true
    },
    "command": {
      "allowShellExecution": false,
      "allowedCommands": ["git", "node", "pnpm"],
      "forbiddenPatterns": ["sudo", "rm -rf /", "mkfs"]
    },
    "secrets": {
      "denyDirectRead": true,
      "injectAsEnv": true
    },
    "limits": {
      "maxExecutionTimeMs": 30000,
      "maxMemoryMb": 512,
      "maxOutputSizeBytes": 2097152
    }
  }
}
```

### Filesystem Boundary
Tools may only read/write files within the active workspace root or designated temporary directories. Sensitive paths such as `.git`, `.ssh`, `.aws`, and `.env` files are blocked unconditionally.

### Network Isolation
Outbound internet access is disabled by default. When outbound network access is explicitly granted for specific domains, private IP ranges (RFC 1918, link-local, loopback except gateway) are strictly rejected.

### Command Execution
Arbitrary shell execution (`/bin/sh`, `/bin/bash`, `cmd.exe`) is prohibited. Tools may only invoke pre-approved binary executables via explicit parameter arrays, preventing shell injection vulnerabilities.

---

## 3. Local-Only Raw Transcripts

AI coding harnesses generate rich session transcripts containing proprietary code, private discussions, and internal API details. Tool Evolver guarantees:

- Session files in `~/.claude/projects/`, `~/.codex/sessions/`, or `~/.omp/` are parsed **locally** by the observer daemon.
- Raw text is distilled into **Normalized Session Events** (e.g. `tool_discovery`, `tool_call`, `durationMs`, `exitCode`).
- If cloud synchronization is enabled for candidate evolution, only sanitized, abstract opportunity descriptors are transmitted; raw prompts are discarded.

---

## 4. Secret Mediation & Redaction

### Vault Storage
Secrets (API tokens, auth tokens) are encrypted at rest using AES-256-GCM via the OS keychain (macOS Keychain, Linux Secret Service, or encrypted local keystore).

### Mediated Injection
Tools requiring authentication tokens receive them exclusively as mediated environment variables injected at sandbox launch time. Direct disk reads of token files are prevented.

### Entropy & Regex Redaction
All logs, error messages, and telemetry streams pass through a continuous redaction filter detecting:
- AWS, GitHub, OpenAI, Anthropic, and generic API keys.
- JWT tokens and bearer credentials.
- High-entropy base64 and hex strings.
- Passwords and SSH private keys.

---

## 5. Audit Trail & Verification

All tool invocations and lifecycle operations generate an immutable record in `~/.tool-evolver/state/local.db`:

```bash
tool-evolver doctor --inspect-audit-log
```

Each record contains:
- Invocation ID, timestamp, tool ID, and version.
- Calling harness ID and workspace scope.
- Capability envelope hash.
- Execution duration and resource metrics.
- SHA-256 hash of inputs and outputs.

---

## Related Documentation

- [Getting Started](getting-started.md)
- [Configuration Reference](configuration.md)
- [Doctor & Repair Guide](doctor-and-repair.md)
- [Threat Model (Security)](../security/threat-model.md)
- [Privacy Inventory](../security/privacy-inventory.md)
