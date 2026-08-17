# Troubleshooting Guide

This guide provides step-by-step diagnostic recipes for common issues encountered when using Tool Evolver.

---

## 1. Quick Diagnostic Checklist

When encountering unexpected behavior, run the following three commands in sequence:

```bash
# 1. Check overall service status
tool-evolver status

# 2. Run automated health diagnostics
tool-evolver doctor

# 3. Apply automated remediations
tool-evolver repair
```

---

## 2. Common Troubleshooting Recipes

### Recipe 1: Daemon Fails to Start

**Symptom**: `tool-evolver status` reports `Daemon: Inactive / Stopped`.

**Causes & Solutions**:
1. **Stale Lockfile**: An earlier crash left a PID lockfile behind.
   ```bash
   rm -f ~/.tool-evolver/state/daemon.pid
   tool-evolver repair --restart-daemon
   ```
2. **Port 9400 Already in Use**: Another process is occupying the gateway port.
   ```bash
   # Identify process using port 9400
   lsof -i :9400
   # Or configure a different port in ~/.tool-evolver/config/config.json
   ```
3. **Database Lock**: SQLite database is locked by an orphaned worker.
   ```bash
   tool-evolver repair --fix-database-locks
   ```

---

### Recipe 2: MCP Connection Refused in AI Harness

**Symptom**: Claude Code, Codex, or OMP reports `MCP server tool-evolver disconnected` or `Connection refused`.

**Causes & Solutions**:
1. **Verify Gateway Listening State**:
   ```bash
   curl -i http://127.0.0.1:9400/health
   ```
   If curl fails to connect, start the daemon:
   ```bash
   tool-evolver init --auto-approve
   ```
2. **Check Configuration Path**:
   Verify that your harness configuration file contains the correct URL (`http://127.0.0.1:9400/mcp/sse`):
   - Claude Code: `~/.claude/claude.json`
   - Codex CLI: `~/.codex/config.toml`
   - Oh My Pi: `~/.omp/config.json`
3. **Resynchronize Harness Configs**:
   ```bash
   tool-evolver repair --fix-harness-configs
   ```

---

### Recipe 3: Tool Invocation Timeout

**Symptom**: Calling `invoke_tool` times out after 30 seconds.

**Causes & Solutions**:
1. **Long-running Task**: The tool is executing a large operation exceeding default limits.
   - Increase `timeoutMs` in `~/.tool-evolver/config/config.json` under the `runtime` section.
2. **Worker Pool Exhaustion**: All worker sandboxes are busy.
   - Check active workers: `tool-evolver status`
   - Restart worker pool: `tool-evolver repair --restart-workers`

---

### Recipe 4: Sandbox Permission Denied

**Symptom**: Tool returns `Error: EACCES: Permission denied` or `CapabilityViolation: Denied path access`.

**Causes & Solutions**:
1. **Accessing Files Outside Workspace Root**:
   - By default, tools may only access files within the current workspace directory.
   - Adjust `fs.readPaths` or `fs.writePaths` in `.tool-evolver/config.json` if cross-directory access is required.
2. **Blocked Path Pattern**:
   - Files matching `**/.git/**`, `**/.ssh/**`, or `**/.env*` are protected by security policy. Direct access is denied by design.

---

### Recipe 5: Newly Evolved Tools Not Appearing

**Symptom**: `search_tools` does not list recently evolved tools.

**Causes & Solutions**:
1. **Canary Status**: Evolved tools begin in `canary` or `evaluating` status before general promotion.
   - Check all tool statuses:
     ```bash
     tool-evolver status --all-tools
     ```
2. **Force Tool Promotion**:
   - Manually promote a canary tool:
     ```bash
     tool-evolver repair --promote-tool <tool-id>
     ```

---

## 3. Generating a Support Bundle

If you need to report an issue or investigate complex failures, generate a sanitized support bundle:

```bash
tool-evolver doctor --export-bundle ./support-bundle.json
```

The support bundle includes:
- System platform, OS, architecture, and Node.js version.
- Sanitized service configuration and health check results.
- Recent daemon and worker logs (with all secrets and tokens redacted).
- Anonymous tool execution statistics and error counters.

---

## Related Documentation

- [Getting Started](getting-started.md)
- [Doctor & Repair Guide](doctor-and-repair.md)
- [Security & Privacy](security-and-privacy.md)
- [Configuration Reference](configuration.md)
- [Vulnerability Reporting](../security/vulnerability-reporting.md)
