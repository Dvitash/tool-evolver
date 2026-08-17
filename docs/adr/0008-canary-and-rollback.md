# ADR 0008: Autonomous Canary Lifecycle and Automated Rollback

- **Status**: accepted
- **Date**: 2026-08-17
- **Deciders**: Tool Evolver Core Architecture Team
- **Consulted**: Site Reliability Engineering, Machine Learning Platform, QA

## Context and Problem Statement

When an AI coding agent relies on dynamically evolved tools, any regression in tool behavior—such as unexpected runtime exceptions, invalid JSON output schema deviations, degraded execution latency, or subtle semantic regressions—can break the agent's reasoning loop, cause hallucinations, or fail developer tasks.

To achieve trustworthy autonomy without manual developer intervention, new tool candidate versions must be deployed cautiously, evaluated against live health metrics in real-time, and rolled back automatically at the first sign of instability.

We must define the automated canary lifecycle, health monitoring criteria, quarantine policies, and instant rollback mechanisms for V1.

## Decision Drivers

- **Zero Agent Disruption**: Tool updates must never cause agent task failures or unexpected downtime.
- **Continuous Real-Time Verification**: Live invocations must be evaluated against schema integrity and performance baselines.
- **Sub-100ms Rollback**: The system must detect and revert a regressing tool in under 100 milliseconds without requiring daemon or harness restarts.
- **Deterministic Canary Progression**: Gradual traffic shifting (or shadow execution) ensures new candidate versions prove their reliability before full promotion.

## Considered Options

1. **Option 1: Big-Bang Immediate Activation (100% replacement upon build)**
   - *Pros*: Simple state machine; instantaneous availability of new features.
   - *Cons*: High blast radius; any regression immediately breaks all agent interactions with that tool.

2. **Option 2: Manual Canary Gating (Developer manually triggers promotion)**
   - *Pros*: Complete human control.
   - *Cons*: Breaks autonomous evolution; leads to neglected canaries and stale tool versions.

3. **Option 3: Autonomous Multi-Phase Canary with Automatic Quarantine and Rollback (Selected)**
   - *Pros*: Minimal blast radius; zero manual intervention; automated rollback upon threshold breach; continuous health scoring.
   - *Cons*: Requires maintaining versioned tool routing tables and live metrics counters.

## Decision

We decide on the following autonomous canary lifecycle, health evaluation rules, and rollback mechanism for V1:

### 1. Tool Lifecycle States

A tool version transitions through explicit lifecycle states managed by the Local Registry:

```
[Candidate] ---> (Static & Contract Tests Pass) ---> [Canary]
                                                       |
                    +----------------------------------+----------------------------------+
                    | (Health thresholds met for       | (Anomaly or error threshold      |
                    |  evaluation window)              |  breached)                       |
                    v                                  v                                  |
               [Promoted] (Active Default)        [Quarantined] ---> [Rolled Back] <------+
```

1. **`Candidate`**: Newly synthesized tool bundle. Undergoes static analysis, AST security verification, and automated contract tests in the Deno sandbox.
2. **`Canary`**: Active in local gateway with restricted invocation routing:
   - *Shadow Mode (Default for high-risk tools)*: The existing `Promoted` version serves the actual result to the harness, while the `Canary` version executes concurrently in the background; outputs and performance are compared.
   - *Traffic Split Mode (For low-risk/pure tools)*: 10% of invocations route to the Canary; if error-free after $N=10$ invocations, routes 50%, then 100%.
3. **`Promoted`**: Promoted to the active default tool version across the workspace.
4. **`Quarantined`**: Traffic immediately severed (0%); tool isolated and flagged for debug investigation.
5. **`Rolled Back`**: Gateway routing pointer atomically reassigned to the previous known-good `Promoted` version.

### 2. Health Monitoring Criteria & Thresholds

During Canary evaluation, the Gateway Observer monitors four primary health signals:

| Health Signal | Failure Threshold | Action |
| :--- | :--- | :--- |
| **Runtime Error Rate** | $> 0\%$ unhandled exceptions (any crash or timeout) | Instant Rollback & Quarantine |
| **Schema Compliance** | Any output payload failing JSON Schema validation | Instant Rollback & Quarantine |
| **Latency Regression** | $p95$ latency $> 1.5\times$ baseline or $> 500\text{ms}$ degradation | Instant Rollback & Quarantine |
| **Harness Error Feedback** | Agent re-invocation with repair prompt within 2 turns | Flagged for review; rollback if repeated |

### 3. Sub-100ms Instant Rollback Execution

- The Local Gateway maintains an in-memory atomic routing table mapping `tool_id` to `active_version_id` and `fallback_version_id`.
- When an anomaly or health breach occurs:
  1. The Gateway atomically sets `canary_traffic_percent = 0` and points routing to `fallback_version_id` (< 5ms in-memory update).
  2. The candidate version state in SQLite is updated to `quarantined`.
  3. The current in-flight invocation is transparently re-executed against the fallback version if idempotent, or returns the fallback response.
  4. An audit incident record is emitted with the failure signature and stack trace.

```
+---------------------------------------------------------------+
| Local MCP Gateway In-Memory Routing Table                     |
|                                                               |
|  tool_id: "workspace_search"                                  |
|  - active_version: "v2-canary" (Traffic: 10%)                 |
|  - fallback_version: "v1-promoted" (Traffic: 90%)             |
|                                                               |
|  [Incoming Tool Call: workspace_search]                       |
|           |                                                   |
|           v                                                   |
|  [Execute "v2-canary"] ---> ERROR / SCHEMA FAILURE            |
|                                     |                         |
|  +----------------------------------+-----------------------+ |
|  | Immediate Rollback Handler (<100ms)                      | |
|  | 1. Atomically set active_version = "v1-promoted"         | |
|  | 2. Mark "v2-canary" as QUARANTINED in SQLite             | |
|  | 3. Transparently retry invocation with "v1-promoted"     | |
|  | 4. Return successful response to Harness                 | |
|  +----------------------------------------------------------+ |
+---------------------------------------------------------------+
```

## Consequences

### Positive
- Autonomous tool deployment with zero developer maintenance.
- Erroneous tool versions are caught and removed before causing task-level agent failures.
- In-memory routing switch enables sub-100ms rollbacks with zero process restarts.
- Full historical audit trail of canaries, promotions, and rollbacks.

### Negative / Trade-offs
- Running shadow executions consumes additional local CPU/memory during the evaluation window.

### Mitigations
- Bound concurrent shadow executions to a maximum of 2 workers; disable shadow execution on battery power or resource-constrained devices.

## Compliance and Verification

- Unit and integration tests in `@tool-evolver/gateway` simulate runtime exceptions, schema mismatches, and latency spikes in candidate tools, verifying that rollback triggers within 100ms and fallback results are delivered cleanly.
