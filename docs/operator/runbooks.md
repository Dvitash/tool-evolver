# Operational Runbooks

This document provides step-by-step operational procedures for diagnosing, containing, and resolving production incidents in the Tool Evolver Cloud platform.

---

## Runbook 1: High API Error Rates (HTTP 5xx)

### 1. Severity & Triage
- **Severity**: Critical (P1)
- **Initial Verification**: Inspect `/health/ready` endpoint across API pods to determine whether database or queue connectivity is degraded.

### 2. Diagnosis
1. Inspect live application error logs:
   ```bash
   kubectl logs -n tool-evolver -l app=cloud-api --tail=100 -f
   ```
2. Check database connection pool exhaustion:
   ```sql
   SELECT count(*), state FROM pg_stat_activity WHERE datname = 'tool_evolver' GROUP BY state;
   ```
3. Check Redis memory and client connections:
   ```bash
   redis-cli -u $REDIS_URL INFO stats
   ```

### 3. Mitigation
- If database connection limits are saturated: temporarily scale down background evaluation workers to free pool connections for the API gateway.
- If an unhandled error was introduced in the latest deployment: trigger an immediate Kubernetes rollback:
  ```bash
  kubectl rollout undo deployment/cloud-api -n tool-evolver
  ```

---

## Runbook 2: Dead Letter Queue (DLQ) Backlog & Requeueing

### 1. Severity & Triage
- **Severity**: Medium (P2)
- **Trigger**: `DeadLetterQueueBacklog` alert fired (`tool_evolver_dlq_messages_count > 10`).

### 2. Investigation
1. Fetch and inspect top dead-letter records:
   ```bash
   pnpm --filter @tool-evolver/cloud run dlq:inspect --limit 5
   ```
2. Identify root cause:
   - Schema validation errors on incoming observation batches?
   - Expired client authentication tokens?
   - Sandbox execution timeout during candidate testing?

### 3. Resolution & Replay
Once the underlying defect is patched or downstream service is restored:
```bash
# Replay failed DLQ jobs with exponential backoff
pnpm --filter @tool-evolver/cloud run dlq:requeue --queue evaluation-jobs --all
```

---

## Runbook 3: Emergency Global Tool Freeze / Rollback

### 1. Severity & Triage
- **Severity**: High (P1)
- **Scenario**: A malicious or buggy tool candidate passed evaluation and is causing failures across multiple client workspaces.

### 2. Immediate Containment
1. Trigger global tool revocation via administrative CLI:
   ```bash
   pnpm --filter @tool-evolver/cloud run tool:revoke --tool-id <compromised-tool-id> --reason "Emergency security freeze"
   ```
2. Broadcast instant catalog invalidation event:
   ```bash
   pnpm --filter @tool-evolver/cloud run catalog:broadcast-invalidation
   ```
3. Freeze candidate synthesis pipeline:
   ```bash
   kubectl scale deployment/synthesis-workers --replicas=0 -n tool-evolver
   ```

### 3. Verification
Verify that client gateway instances have removed the revoked tool from active catalogs:
```bash
curl -s http://127.0.0.1:9400/tools | grep "<compromised-tool-id>"
# Must return empty
```

---

## Runbook 4: Database Failover Procedure

### 1. Verification of Primary Failure
Confirm primary node is unreachable via automated health checks.

### 2. Replica Promotion
1. Promote standby PostgreSQL replica to primary:
   ```bash
   pg_ctl promote -D /var/lib/postgresql/data
   ```
2. Update connection string secret in Kubernetes:
   ```bash
   kubectl set env deployment/cloud-api DATABASE_URL=$NEW_PRIMARY_DB_URL -n tool-evolver
   ```
3. Verify `/health/ready` returns 200 OK.

---

## Related Documentation

- [Deployment Architecture](deployment.md)
- [Operations & Monitoring](operations.md)
- [Backup & Restore](backup-and-restore.md)
- [Key Rotation](key-rotation.md)
- [Client & Cloud Rollback Procedures](../release/rollback-procedure.md)
