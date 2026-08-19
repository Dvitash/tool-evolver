# Doctor & Repair Guide

Tool Evolver includes built-in diagnostic and self-healing commands to inspect system health, verify environmental dependencies, and remediate service issues.

---

## 1. `tool-evolver status`

The `status` command provides an immediate snapshot of the background daemon, MCP gateway, worker pool, database connections, and registered harnesses.

```bash
tool-evolver status
```

### CLI Output Example

```text
Tool Evolver (v1.0.0)
============================================================
● Daemon:        Active (PID: 14209, Uptime: 4h 12m)
● Gateway:       http://127.0.0.1:9400/mcp/sse (Listening)
● Database:      Healthy (~/.tool-evolver/state/local.db)
● Worker Pool:   4 available / 0 active (Deno runtime v2.1.0)
● Catalog:       4 meta-tools, 6 promoted tools, 1 canary

Harness Connections:
  ✓ Claude Code: Connected (last event 12s ago)
  ✓ Codex CLI:   Connected (last event 1m ago)
  ✓ Oh My Pi:    Connected (SSE active, last event 4s ago)
============================================================
```

### JSON Mode

For scripts and automated checks, use `--json`:

```bash
tool-evolver status --json
```

---

## 2. `tool-evolver doctor`

The `doctor` command runs a comprehensive suite of diagnostic checks against the operating system, permissions, file locks, database schema, IPC sockets, and harness configuration files.

```bash
tool-evolver doctor
```

### Diagnostic Checks Evaluated

| Check Name | Category | What is Verified |
|------------|----------|------------------|
| `platform` | OS | Validates OS (Linux, macOS, WSL) and Node.js version (`>= 22.0.0`). |
| `directories` | Filesystem | Verifies permissions for `~/.tool-evolver/` subdirectories. |
| `sqlite` | Database | Tests read/write operations, schema integrity, and WAL journal mode. |
| `daemon_ipc` | Process | Checks socket responsiveness, PID lock freshness, and memory limits. |
| `gateway` | Network | Verifies loopback port binding (`127.0.0.1:9400`) and SSE endpoint. |
| `worker_runtime`| Execution | Tests sandbox isolation (Deno or fallback Node worker). |
| `harness_claude`| Integration | Validates `~/.claude/claude.json` MCP registration syntax. |
| `harness_codex` | Integration | Validates `~/.codex/config.toml` MCP registration syntax. |
| `harness_omp`   | Integration | Validates `~/.omp/agent/mcp.json` MCP registration syntax. |

### Sample Output with Identified Issues

```text
Running Tool Evolver Doctor...

[PASS] Platform & Node.js Runtime (v24.17.0 on Linux arm64)
[PASS] Filesystem Permissions (~/.tool-evolver/)
[PASS] Local SQLite Storage (~/.tool-evolver/state/local.db)
[WARN] Gateway Port Conflict (Port 9400 is bound by another process)
[FAIL] Claude Code Config Drift (~/.claude/claude.json missing tool-evolver entry)

Found 1 error and 1 warning.
Suggested fix: Run `tool-evolver repair` to automatically resolve detected issues.
```

---

## 3. `tool-evolver repair`

The `repair` command executes automated remediation recipes to resolve issues identified by `doctor`.

```bash
tool-evolver repair
```

### Automated Remediation Capabilities

- **Stale Lock Cleanup**: Removes orphaned PID files and dead IPC sockets from previous unclean shutdowns.
- **Database Index Optimization**: Runs `VACUUM` and schema integrity repairs on `local.db`.
- **Harness Config Resynchronization**: Restores missing MCP server registrations in Claude Code, Codex CLI, and OMP configuration files while preserving existing user settings.
- **Port Conflict Resolution**: Automatically signals orphaned gateway instances to terminate or selects an alternate loopback port.
- **Worker Quarantine Purge**: Cleans up failed compilation artifacts and temporary execution worktrees.

### Dry-Run Mode

Preview repairs without applying changes:

```bash
tool-evolver repair --dry-run
```

---

## 4. Diagnostic Recipes

### Recipe A: Resetting All Harness Configurations

If you modified harness settings manually and need to restore Tool Evolver registrations:

```bash
tool-evolver repair --fix-harness-configs
```

### Recipe B: Restarting the Local Daemon

If the background daemon stops responding:

```bash
tool-evolver repair --restart-daemon
```

### Recipe C: Generating Support Diagnostics

To export a sanitized diagnostic bundle for troubleshooting:

```bash
tool-evolver doctor --export-bundle ./support-bundle.json
```

---

## Related Documentation

- [Getting Started](getting-started.md)
- [Troubleshooting Guide](troubleshooting.md)
- [Configuration Reference](configuration.md)
- [Security & Privacy](security-and-privacy.md)
