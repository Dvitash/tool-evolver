# Cloud Service Operations & Monitoring

This document details day-to-day operations, health check endpoints, telemetry metrics, Prometheus collectors, alerting thresholds, and Service Level Objectives (SLOs) for the Tool Evolver Cloud platform.

---

## 1. Health Check Endpoints

| Endpoint | Method | Purpose | Healthy Response |
|----------|--------|---------|------------------|
| `/health` | `GET` | Shallow liveness check for load balancers | `{"status":"ok"}` (200 OK) |
| `/health/ready` | `GET` | Deep readiness check (DB, Redis, S3, Worker pool) | `{"status":"ready","db":true,"queue":true}` (200 OK) |
| `/metrics` | `GET` | Prometheus formatted metrics export | Standard Prometheus text format |

### Deep Readiness Evaluation

The `/health/ready` endpoint verifies:
1. **PostgreSQL Connectivity**: Executes `SELECT 1` with a 2-second timeout.
2. **Redis / Durable Queue**: Performs `PING` and verifies queue backlog size.
3. **Object Storage**: Performs `HeadBucket` against the tool bundle repository.
4. **Active Workers**: Verifies at least one candidate evaluation worker is polling.

---

## 2. Key Telemetry & Prometheus Metrics

| Metric Name | Type | Labels | Description |
|-------------|------|--------|-------------|
| `tool_evolver_http_requests_total` | Counter | `route`, `status`, `method` | Total HTTP requests handled |
| `tool_evolver_http_duration_seconds` | Histogram | `route`, `status` | Request latency distribution |
| `tool_evolver_tool_invocations_total` | Counter | `tool_id`, `status` | Local/cloud tool invocation count |
| `tool_evolver_candidate_evaluations_total` | Counter | `state`, `score_tier` | Synthesis candidate evaluations |
| `tool_evolver_canary_rollbacks_total` | Counter | `tool_id`, `reason` | Automated canary rollback events |
| `tool_evolver_db_pool_active_connections` | Gauge | `pool` | Active PostgreSQL connections |
| `tool_evolver_queue_pending_jobs` | Gauge | `queue_name` | Pending jobs in evaluation queue |
| `tool_evolver_dlq_messages_count` | Gauge | `queue_name` | Dead-letter queue message count |

---

## 3. Recommended Alerting Thresholds

```yaml
# Prometheus Alerting Rules Example
groups:
  - name: tool_evolver_alerts
    rules:
      - alert: HighHttpErrorRate
        expr: sum(rate(tool_evolver_http_requests_total{status=~"5.."}[5m])) / sum(rate(tool_evolver_http_requests_total[5m])) > 0.01
        for: 2m
        labels: { severity: critical }
        annotations: { summary: "HTTP 5xx error rate exceeds 1%" }

      - alert: DeadLetterQueueBacklog
        expr: tool_evolver_dlq_messages_count > 10
        for: 5m
        labels: { severity: warning }
        annotations: { summary: "DLQ has unprocessed messages" }

      - alert: ElevatedCanaryRollbackRate
        expr: rate(tool_evolver_canary_rollbacks_total[15m]) > 5
        for: 5m
        labels: { severity: warning }
        annotations: { summary: "High rate of canary rollbacks detected" }
```

---

## 4. Service Level Objectives (SLOs)

| Metric | Target SLO | Measurement Window |
|--------|------------|--------------------|
| **API Availability** | `>= 99.9%` uptime | 30-day rolling |
| **P95 Gateway Latency** | `< 50ms` | 5-minute average |
| **P95 Candidate Evaluation Time** | `< 60s` | 1-hour average |
| **Canary Rollback SLA** | `< 5s` from trigger | Immediate |

---

## 5. Release Gates, CI/CD Pipeline & Branch Governance

### 5.1 Local Verification Gate (`pnpm run check:all`)

Operators and contributors must run the master check command before merging or promoting any release candidate:

```bash
pnpm run check:all
```

This executes the full automated gate sequence:
1. **ADR Validation:** `pnpm run check:adrs`
2. **Package Boundaries:** `pnpm run check:boundaries`
3. **Linting & Formatting:** `pnpm run lint`
4. **Type Checking:** `pnpm run typecheck`
5. **Monorepo Build:** `pnpm run build`
6. **Unit Tests:** `pnpm run test`
7. **E2E Integration Tests:** `pnpm run test:e2e`
8. **Binary Smoke Tests:** `pnpm run check:smoke` (verifying all 4 binaries: CLI, Daemon, Gateway MCP Shim, and Conformance Runner)
9. **Release Verification:** `pnpm run release:verify` (verifying tarballs, SHA-256 digests, Ed25519 signatures, SBOM, and documentation links)

### 5.2 Branch Protection & Release Gates

The `main` branch enforces strict release and merge gates:
- **PR-Only Ingestion:** Direct commits and pushes to `main` are disabled. All changes must be proposed via pull requests.
- **Force Push Protection:** Force-pushing is strictly disabled.
- **Code Review Governance:** Required approval from code owners (`.github/CODEOWNERS`) for Runtime, brokers, authentication, cryptography, privacy, signing, installer, and release scripts. Authors cannot approve their own pull requests.
- **Dismissal of Stale Approvals:** Any push of new commits automatically invalidates prior approvals and mandates re-review.
- **Required Status Checks:** Merging requires 10 parallel green checks and the `ci-gate` rollup:
  - `lint`
  - `typecheck`
  - `build`
  - `test-unit`
  - `test-e2e`
  - `check-boundaries`
  - `check-adrs`
  - `release-verification`
  - `binary-smoke`
  - `secret-scan`
  - `ci-gate`

---

## Related Documentation

- [Deployment Architecture](deployment.md)
- [Operational Runbooks](runbooks.md)
- [Backup & Restore](backup-and-restore.md)
- [Telemetry & Analytics](telemetry-and-analytics.md)
