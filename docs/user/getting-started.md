# Getting Started with Tool Evolver

Tool Evolver is an autonomous, privacy-safe developer tool evolution platform. It observes tool usage within AI coding harnesses (Claude Code, Codex CLI, and Oh My Pi), discovers optimization opportunities, synthesizes safe tool implementations, validates them against strict capability envelopes, and deploys them to local agent environments without manual intervention.

---

## Prerequisites

Before installing Tool Evolver, ensure your environment meets the following requirements:

- **Node.js**: Version `>= 22.0.0` (LTS recommended)
- **Operating System**:
  - Linux (x86_64, arm64)
  - macOS (Apple Silicon arm64, Intel x86_64)
  - Windows Subsystem for Linux (WSL2, Ubuntu 22.04+)
- **Coding Harnesses** (at least one installed):
  - [Claude Code CLI](https://claude.ai/code)
  - [Codex CLI](https://github.com/openai/codex)
  - [Oh My Pi (OMP)](https://github.com/canary-laboratories/omp)
- **Optional**: [Deno runtime](https://deno.com) (`>= 2.0.0`) for hardened worker isolation (falls back to Node.js subprocess sandbox if unavailable).

---

## 1. Single-Command Installation

The fastest way to install, initialize, and register Tool Evolver with your installed harnesses is using `npx`:

```bash
npx tool-evolver init
```

The initialization wizard will:

1. Perform **Preflight Checks** on platform compatibility and Node.js versions.
2. Verify release assets and binary integrity.
3. Initialize local state directories in `~/.tool-evolver/`.
4. Present a **One-Time Capability Envelope Plan** for explicit user authorization.
5. Auto-discover installed coding harnesses and register the Tool Evolver Gateway MCP server.
6. Start the background **Observer Daemon** (`tool-evolver-daemon`).

---

## 2. Dry-Run Setup Mode

To inspect exactly what configuration changes and filesystem operations Tool Evolver will perform without modifying your system, run `init` with `--dry-run`:

```bash
npx tool-evolver init --dry-run
```

You will see an execution journal detailing planned directory creation, harness configuration patches, backup locations, and the capability authorization request:

```json
{
  "dryRun": true,
  "platform": { "os": "linux", "arch": "arm64", "isSupported": true },
  "harnesses": [
    {
      "harnessId": "claude-code",
      "installed": true,
      "targetPath": "/home/user/.claude/claude.json",
      "plan": { "description": "Register Tool Evolver Gateway MCP server" }
    }
  ]
}
```

---

## 3. One-Time Capability Authorization

Tool Evolver operates under the **Principle of Least Privilege**. During initialization, you are prompted to authorize the default workspace **Capability Envelope**:

```text
? Tool Evolver Capability Envelope Authorization
  - Filesystem: Read/Write within active workspace root only
  - Deny Paths: **/.git/**, **/.ssh/**, **/.aws/**, **/.gnupg/**, **/.env*
  - Network: Localhost MCP bridge only (127.0.0.1:9400-9401); outbound WAN blocked
  - Subprocess Execution: Controlled list (git, node, pnpm, deno); shell disabled
  - Secrets: Direct reading blocked; mediated injection only

Authorize capability envelope? [y/N]: y
```

For non-interactive environments (CI/CD, automated provisioning), pass the `--auto-approve` flag:

```bash
npx tool-evolver init --auto-approve
```

---

## 4. Verifying Installation & Service Health

Once initialized, verify that the daemon, MCP gateway, and harness bridges are healthy:

```bash
tool-evolver status
```

Output:

```text
Tool Evolver v1.0.0
● Daemon: Running (PID 28410, uptime 2m)
● Gateway MCP: Listening at http://127.0.0.1:9400/mcp/sse
● Database: SQLite connected (~/.tool-evolver/state/local.db)
● Active Tools: 4 meta-tools, 0 workspace tools
● Harnesses:
  ✓ Claude Code (configured, tailing active)
  ✓ Codex CLI (configured, tailing active)
  ✓ Oh My Pi (configured, SSE connected)
```

Run comprehensive system diagnostics with:

```bash
tool-evolver doctor
```

---

## 5. Your First Tool Invocation

Once connected to your harness, the meta-tools are immediately available. In your harness prompt (e.g. Claude Code or OMP), ask your assistant to search for available tools:

```text
> Search for tools to inspect repository structure
```

The harness will execute the invariant `search_tools` meta-tool and receive the active tool catalog. As you perform development tasks, Tool Evolver will observe session events locally, identify repetitive workflows, and propose newly evolved custom tools.

---

## Next Steps

- [Configuration Reference](configuration.md)
- [Meta-Tools Specification](meta-tools.md)
- [Harness Integration Guide](harness-guide.md)
- [Doctor & Repair Guide](doctor-and-repair.md)
- [Security & Privacy Model](security-and-privacy.md)
