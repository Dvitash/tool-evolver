# ADR 0004: Evolution Scope and Zero-Approval Autonomy Model

- **Status**: accepted
- **Date**: 2026-08-17
- **Deciders**: Tool Evolver Core Architecture Team
- **Consulted**: Security, Product Management, Machine Learning Team

## Context and Problem Statement

The promise of self-evolving developer tooling is that repeated development friction, repetitive tool call patterns, slow execution paths, and missing API abstractions can be detected, synthesized into optimized tools, and deployed seamlessly.

However, an unconstrained evolution engine that modifies system prompts, agent personalities, harness configuration files, or model weights introduces unpredictability, breaks developer mental models, and creates immense security attack surfaces. Furthermore, if every candidate tool creation requires manual human review and click-through approval, developer flow state is interrupted, defeating the speed benefits of automated evolution.

We must define the precise scope of autonomous evolution in V1 and the rules governing human approval versus automated autonomy.

## Decision Drivers

- **Developer Flow**: Eliminating cognitive interrupts (no annoying approval pop-ups during active coding sessions).
- **Safety within Bounds**: Ensuring autonomous mutations cannot compromise the host system, exfiltrate data, or degrade tool reliability.
- **Clear Scope Boundaries**: Focusing on high-impact, deterministic programmatic assets (MCP tools and workflows) rather than fuzzy prompt mutations.
- **Predictable Reproducibility**: Ensuring tool evolutions can be audited, deterministically tested, and reproduced across team members.

## Considered Options

1. **Option 1: Full-Stack Evolution (Prompts, Agent Configs, Skills, MCP Tools, and Model Weights)**
   - *Pros*: Broadest theoretical optimization space.
   - *Cons*: Extremely high variance, unpredictable agent behavior, difficult rollback verification, vast security surface.

2. **Option 2: Human-in-the-Loop for Every Tool Mutation**
   - *Pros*: Complete human awareness of every code change.
   - *Cons*: High friction, developer fatigue leading to rubber-stamping, stalls background evolution when developer is away.

3. **Option 3: Scope-Constrained Evolution (MCP Tools & Workflows) with Zero-Approval Autonomy within Capability Envelope (Selected)**
   - *Pros*: Clean API boundaries; testable via standard unit/contract tests; zero-friction developer experience within bounded security parameters; deterministic canary and rollback.
   - *Cons*: Prompt engineering and agent config tuning must be handled manually or in future versions.

## Decision

We decide on the following evolution scope and autonomy policies for V1:

### 1. Strictly Constrained Evolution Scope

In V1, the Evolution Engine is permitted to autonomously synthesize, optimize, and activate only two artifact types:
1. **Atomic MCP Tools**: TypeScript-based tool definitions providing specific inputs, logic, and output schemas conforming to the Model Context Protocol.
2. **Reusable Tool Workflows**: Deterministic composite pipelines that combine multiple tool invocations into a single low-latency, batched execution plan.

**Explicitly Out of Scope for Autonomous Evolution in V1**:
- System prompts and meta-prompts.
- Harness configuration files (e.g., `CLAUDE.md`, `.cursorrules`, OMP config files).
- Agent skills, persona definitions, or memory banks.
- Model weights, fine-tuning datasets, or embedding indexes.

### 2. Zero-Approval Autonomy within Capability Envelope

- **Zero Per-Tool Approvals**: As long as a candidate tool requests capabilities strictly within the pre-authorized **Capability Envelope** configured for the workspace (e.g., read/write access limited to the workspace directory, outbound network limited to project API domains), the tool evolves, tests, deploys to canary, and promotes **with zero manual approvals**.
- **Out-of-Envelope Escalation**: Any candidate tool requesting capabilities beyond the pre-authorized envelope is placed into `Pending Approval` state and cannot be activated without explicit developer CLI confirmation (`tool-evolver approve <tool-id>`).
- **Autonomous Lifecycle Loop**:
  1. **Observation**: Observer captures sanitized traces of repetitive or failing tool sequences.
  2. **Synthesis**: Evolution Engine generates candidate implementation and schema.
  3. **Static Verification**: Typechecking, linting, and AST security scans.
  4. **Contract & Test Suite**: Auto-generated test harness runs candidate in sandbox.
  5. **Canary Activation**: Deployed to local gateway with traffic splitting or shadow execution.
  6. **Health Evaluation**: Real-time error rate, latency, and schema compliance tracking.
  7. **Promotion / Rollback**: Promoted to primary version if healthy; instantly rolled back if any anomaly is detected.

```
+---------------------------------------------------------------+
| Autonomous Evolution Pipeline (Zero Human Interruption)       |
|                                                               |
|  [Traces/Observations]                                        |
|           |                                                   |
|           v                                                   |
|  +----------------------------------------------------------+ |
|  | 1. Candidate Synthesis (Cloud/Local LLM)                 | |
|  +---------------------------+------------------------------+ |
|                              |                                |
|                              v                                |
|  +----------------------------------------------------------+ |
|  | 2. Static & Capability Envelope Verification             | |
|  |    (AST checks, Permission token matching)               | |
|  +---------------------------+------------------------------+ |
|                              |                                |
|                              v                                |
|  +----------------------------------------------------------+ |
|  | 3. Automated Contract & Property Testing Sandbox         | |
|  +---------------------------+------------------------------+ |
|                              |                                |
|                              v                                |
|  +----------------------------------------------------------+ |
|  | 4. Canary Activation in Local Gateway (No Prompt)        | |
|  +---------------------------+------------------------------+ |
|                              |                                |
|            +-----------------+-----------------+              |
|            | (Healthy)                         | (Error/Deg)  |
|            v                                   v              |
|  +-------------------+               +----------------------+ |
|  | 5a. Promotion     |               | 5b. Auto-Rollback    | |
|  |     (Active V1)   |               |     & Quarantine     | |
|  +-------------------+               +----------------------+ |
+---------------------------------------------------------------+
```

## Consequences

### Positive
- Developers experience continuous performance improvements and new tool capabilities without modal prompts or friction.
- Security remains strictly enforced through the Capability Envelope rather than fallible human inspection of generated code.
- Clear technical boundaries make testing, benchmarking, and rollback deterministic.

### Negative / Trade-offs
- Autonomous optimizations cannot fix problems rooted in flawed system prompts or harness orchestration logic in V1.

### Mitigations
- Expose rich CLI inspect commands (`tool-evolver status`, `tool-evolver history`, `tool-evolver diff <tool>`) allowing developers to review evolution history retroactively.
- Provide global and per-workspace kill-switches (`tool-evolver freeze`, `tool-evolver disable-evolution`).

## Compliance and Verification

- Security tests verify that tools exceeding workspace capability envelopes fail to activate without explicit authorization.
- Test suites in `@tool-evolver/contracts` validate candidate tool schema contracts and lifecycle state transitions.
