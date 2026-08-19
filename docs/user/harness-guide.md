# Harness Integration Guide

Tool Evolver integrates seamlessly with multiple AI developer harnesses via the Model Context Protocol (MCP) and local observation adapters.

---

## Supported Coding Harnesses

| Harness | Tested Versions | Configuration File | Bridge Protocol | Observation Mode | Refresh Mechanism |
|---------|-----------------|-------------------|-----------------|------------------|-------------------|
| **Claude Code CLI** | `0.2.29`, `1.0.0` (`>= 0.1.0`) | `~/.claude/claude.json` | MCP over SSE / Stdio | Local JSONL Session Tailing | Context Notice Prompt Nudge |
| **Codex CLI** | `0.1.0`, `0.2.0` (`>= 0.1.0`) | `~/.codex/config.toml` | MCP over SSE | Local TOML/JSON Log Tailing | Session Restart Required |
| **Oh My Pi (OMP)** | `0.1.0`, `0.2.0`, `17.3.8` (`>= 0.1.0`) | `~/.omp/agent/mcp.json` | MCP over Stdio / SSE / Hub IPC | In-process Event Tailer | Native ListChanged Notification |
---

## 1. Claude Code CLI Integration

### Automated Registration

When you run `npx tool-evolver init`, Tool Evolver automatically patches `~/.claude/claude.json`:

```json
{
  "mcpServers": {
    "tool-evolver": {
      "type": "sse",
      "url": "http://127.0.0.1:9400/mcp/sse"
    }
  }
}
```

### Manual Verification

To verify that Claude Code recognizes Tool Evolver:

```bash
claude mcp list
```

Expected output:

```text
✓ tool-evolver (SSE: http://127.0.0.1:9400/mcp/sse) - 4 tools enabled
```

### Session Observation

Tool Evolver monitors Claude Code sessions locally by following active session files in `~/.claude/projects/`. Only normalized structural telemetry (tool names, execution status, latencies) is processed; raw prompt context and assistant reasoning are strictly kept on localhost.

---

## 2. Codex CLI Integration

### Automated Registration

Tool Evolver automatically registers the gateway MCP server in `~/.codex/config.toml`:

```toml
# Tool Evolver Gateway Registration
[mcp_servers.tool_evolver_gateway]
url = "http://127.0.0.1:9400/mcp/sse"
```

### Session Observation

Codex CLI session logs are tailed from `~/.codex/sessions/`. Tool Evolver's observer extracts normalized events (`tool_discovery`, `tool_call`, `tool_result`, `error`) and updates local usage counters.

---

## 3. Oh My Pi (OMP) Integration

### Automated Registration

For OMP environments, Tool Evolver updates `~/.omp/agent/mcp.json`:

```json
{
  "$schema": "https://json.schemastore.org/mcp-server-config.json",
  "mcpServers": {
    "tool-evolver-gateway": {
      "type": "stdio",
      "command": "tool-evolver-gateway",
      "args": ["--stdio"],
      "env": {}
    }
  }
}
```

### In-Process Hub Integration

OMP sessions connect directly to the Gateway's SSE endpoint and receive real-time tool catalog updates. When a new tool completes its canary evaluation and is promoted, an SSE `notifications/tools/list_changed` message is dispatched immediately to active OMP agents.

---

## 4. Real-Time Tool Catalog Refresh

When a new tool is synthesized or promoted, agents do not need to restart their sessions:

1. **SSE Push Notification**: The Gateway broadcasts `notifications/tools/list_changed` across all open SSE client streams.
2. **Dynamic Invalidation**: The harness invalidates its local tool cache and invokes `tools/list` to fetch the updated catalog.
3. **Instant Availability**: Newly promoted tools can be discovered immediately via `search_tools`.

---

## 5. Troubleshooting Harness Connections

If a harness fails to communicate with Tool Evolver:

1. **Check Gateway Service**:
   ```bash
   curl -s http://127.0.0.1:9400/health
   ```
   Should return `{"status":"ok","version":"1.0.0"}`.

2. **Run Doctor Diagnostic**:
   ```bash
   tool-evolver doctor --harness all
   ```

3. **Re-apply Configuration**:
   ```bash
   tool-evolver repair --fix-harness-configs
   ```

---

## Related Documentation

- [Getting Started](getting-started.md)
- [Configuration Reference](configuration.md)
- [Meta-Tools Reference](meta-tools.md)
- [Doctor & Repair Guide](doctor-and-repair.md)
- [Security & Privacy Model](security-and-privacy.md)
