# System Scope & Limitations (V1)

This document specifies the supported scope, platform matrix, resource boundaries, and intentional non-goals for the Tool Evolver V1 release.

---

## 1. Supported Platform Matrix

| Platform | Architecture | Status | Minimum Requirements |
|----------|--------------|--------|----------------------|
| **Linux** | `x86_64` | Supported | Kernel 5.4+, Node.js >= 22.0.0, glibc 2.31+ |
| **Linux** | `arm64` | Supported | Kernel 5.4+, Node.js >= 22.0.0, glibc 2.31+ |
| **macOS** | Apple Silicon (`arm64`) | Supported | macOS 12+ (Monterey or later), Node.js >= 22.0.0 |
| **macOS** | Intel (`x86_64`) | Supported | macOS 12+ (Monterey or later), Node.js >= 22.0.0 |
| **Windows Subsystem for Linux** | `WSL2` (Ubuntu 22.04+) | Supported | WSL2 with systemd enabled, Node.js >= 22.0.0 |
| **Windows Native (Win32)** | `x86_64` | Unsupported in V1 | Recommended to run inside WSL2 |

---

## 2. Supported AI Coding Harnesses

| Harness | Version Compatibility | Tested Versions | Supported Protocols |
|---------|-----------------------|-----------------|---------------------|
| **Claude Code CLI** | `>= 0.1.0` | `0.2.29`, `1.0.0` | MCP SSE / JSONL observation |
| **Codex CLI** | `>= 0.1.0` | `0.1.0`, `0.2.0` | MCP SSE / TOML session observation |
| **Oh My Pi (OMP)** | `>= 0.1.0` | `0.1.0`, `0.2.0` | MCP SSE / Hub IPC observation |
---

## 3. Runtime Boundaries & Default Limits

| Resource Limit | Default Value | Max Configurable | Description |
|----------------|---------------|------------------|-------------|
| **Execution Timeout** | 30 seconds | 300 seconds | Maximum time a single tool invocation may run |
| **Worker Memory** | 512 MB | 2048 MB | Maximum RSS memory allocated per tool sandbox |
| **Output Size** | 2 MB | 10 MB | Maximum stdout/return payload size per invocation |
| **Max Concurrent Workers**| 4 workers | 16 workers | Concurrent tool execution sandbox instances |
| **Max Evolution Candidates**| 20 / day | 100 / day | Daily quota for autonomous tool synthesis |
| **File Read Size** | 10 MB | 50 MB | Maximum single file size a tool may read |

---

## 4. Explicit Non-Goals for V1

The following capabilities are deliberately excluded from the V1 architecture:

1. **Raw Transcript Cloud Exfiltration**: Tool Evolver will never upload raw user prompts, reasoning thoughts, or proprietary source code to cloud endpoints.
2. **Unmediated Root/Sudo Execution**: Evolved tools run as standard user processes inside restricted sandboxes and cannot invoke `sudo` or modify system files.
3. **Arbitrary Internet Scraping**: Tools cannot initiate unrestricted WAN network requests without explicit domain allowlisting in the capability envelope.
4. **Kernel-Level Drivers or Hooks**: System observation relies exclusively on userspace session logs and standard file system tailing.
5. **Interactive GUI Automation**: Tool Evolver focuses exclusively on CLI tools, MCP endpoints, code refactoring scripts, and developer workflow automation.

---

## Related Documentation

- [Getting Started](getting-started.md)
- [Configuration Reference](configuration.md)
- [Security & Privacy](security-and-privacy.md)
- [Support Policy](../security/support-policy.md)
- [Compatibility Matrix](../release/compatibility-matrix.md)
