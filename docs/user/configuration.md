# Configuration Reference

This guide details all configuration files, directory layouts, environment variables, and policy parameters used by Tool Evolver.

---

## 1. Directory Structure

Tool Evolver uses a dedicated directory hierarchy in the user's home directory (`~/.tool-evolver/`):

| Path | Purpose | Persistence |
|------|---------|-------------|
| `~/.tool-evolver/config/` | Global configuration files, harness settings, and policy overrides | Persistent |
| `~/.tool-evolver/data/` | Tool bundle artifacts, sandboxed execution caches, and quarantined scripts | Persistent |
| `~/.tool-evolver/state/` | SQLite database (`local.db`), process locks, and socket files | Ephemeral / Local state |
| `~/.tool-evolver/logs/` | Daemon, gateway, worker, and harness bridge rotating log files | 14-day retention |

### Workspace-Specific Configuration

Within any individual project workspace root, an optional `.tool-evolver/` folder can provide repository-scoped policies:

```text
my-project/
├── .tool-evolver/
│   ├── config.json          # Workspace-level capability overrides
│   └── tools/                # Workspace-pinned evolved tool bundles
├── package.json
└── src/
```

---

## 2. Global Configuration File (`config.json`)

The primary configuration file is located at `~/.tool-evolver/config/config.json`. Below is an annotated example:

```json
{
  "version": "1.0.0",
  "daemon": {
    "port": 9400,
    "host": "127.0.0.1",
    "logLevel": "info",
    "maxWorkers": 4,
    "idleTimeoutMs": 300000
  },
  "privacy": {
    "localOnly": true,
    "telemetryEnabled": false,
    "redactionStrategy": "mask",
    "sensitivePatterns": [
      "token",
      "secret",
      "key",
      "password",
      "auth",
      "credential",
      "signature"
    ]
  },
  "evolution": {
    "autoApproveCanaries": true,
    "canaryTrafficPercent": 10,
    "minEvaluationsBeforePromotion": 5,
    "autoRollbackErrorThreshold": 0.05,
    "maxEvolutionCandidatesPerDay": 20
  },
  "runtime": {
    "engine": "auto",
    "denoPath": "/usr/local/bin/deno",
    "timeoutMs": 30000,
    "maxMemoryMb": 512,
    "maxOutputSizeBytes": 2097152
  }
}
```

---

## 3. Environment Variables

All settings can be overridden via environment variables. Environment variables take precedence over configuration file values.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `TOOL_EVOLVER_HOME` | `string` | `~/.tool-evolver` | Custom base directory for config, state, and logs. |
| `TOOL_EVOLVER_CONFIG_DIR` | `string` | `$TOOL_EVOLVER_HOME/config` | Custom directory for configuration files. |
| `TOOL_EVOLVER_STATE_DIR` | `string` | `$TOOL_EVOLVER_HOME/state` | Custom directory for runtime state & SQLite DB. |
| `TOOL_EVOLVER_LOG_DIR` | `string` | `$TOOL_EVOLVER_HOME/logs` | Custom directory for log files. |
| `TOOL_EVOLVER_PORT` | `number` | `9400` | Gateway MCP server TCP listening port. |
| `TOOL_EVOLVER_HOST` | `string` | `127.0.0.1` | Gateway MCP server bind address (must be loopback). |
| `TOOL_EVOLVER_LOG_LEVEL` | `string` | `info` | Logging verbosity: `debug`, `info`, `warn`, `error`. |
| `TOOL_EVOLVER_TELEMETRY_DISABLED` | `boolean` | `true` | Set `true` to disable all privacy-safe telemetry metrics. |
| `TOOL_EVOLVER_DENO_PATH` | `string` | `""` | Path to explicit Deno executable for hardened worker sandboxing. |
| `TOOL_EVOLVER_AUTO_APPROVE` | `boolean` | `false` | Automatically authorize default capability envelopes during `init`. |
| `TOOL_EVOLVER_CLOUD_URL` | `string` | `""` | Optional remote cloud coordination service URL. |

---

## 4. Capability Envelope Configuration

Each tool execution runs strictly inside a **Capability Envelope**. You can adjust default limits in `config.json`:

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
      "allowedHosts": ["127.0.0.1", "localhost"],
      "allowedPorts": [9400, 9401],
      "denyPrivateRanges": true
    },
    "command": {
      "allowShellExecution": false,
      "allowedCommands": ["git", "node", "pnpm", "deno"],
      "forbiddenPatterns": ["sudo", "rm -rf /", "shutdown", "reboot"]
    },
    "secrets": {
      "denyDirectRead": true,
      "injectAsEnv": true
    }
  }
}
```

---

## Related Documentation

- [Getting Started](getting-started.md)
- [Security & Privacy](security-and-privacy.md)
- [Harness Guide](harness-guide.md)
- [Meta-Tools Reference](meta-tools.md)
