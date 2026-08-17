# Client & Cloud Rollback Procedures

This document provides definitive instructions for executing rollbacks at the tool level, client binary level, and cloud infrastructure level.

---

## 1. Local Tool-Level Rollback

If a specific evolved tool version behaves incorrectly or fails within a local workspace:

### Instant Tool Rollback via CLI
```bash
# Roll back a specific tool to its prior stable promoted version
tool-evolver repair --rollback-tool git_branch_cleaner
```

### Tool Pinning
To prevent autonomous updates or canaries for a specific tool:
```bash
# Pin tool to an explicit version
tool-evolver config set tools.git_branch_cleaner.pinnedVersion "1.2.0"
```

---

## 2. Client Binary Rollback & Downgrade

If an upgraded CLI or daemon version causes operational regressions:

### Atomic Upgrade Rollback
The CLI preserves backup snapshots in `~/.tool-evolver/state/backups/`:

```bash
# Roll back to the previous installed version snapshot
tool-evolver upgrade --rollback
```

### Specific Target Version Downgrade
```bash
# Force downgrade to an explicit release version
tool-evolver upgrade --target-version 0.1.0 --force
```

---

## 3. Cloud Service Rollback Procedures

### API & Worker Deployment Rollback
To rollback cloud Kubernetes deployments to the prior replica set:

```bash
# Undo API deployment
kubectl rollout undo deployment/cloud-api -n tool-evolver

# Undo Worker deployment
kubectl rollout undo deployment/synthesis-workers -n tool-evolver
```

### Database Migration Reversal
To roll back the most recently applied database migration:

```bash
pnpm --filter @tool-evolver/db run migrate:down
```

---

## 4. Emergency Global Tool Revocation

In the event that a distributed tool candidate is found to contain a severe defect or vulnerability across all client environments:

1. **Issue Global Revocation in Cloud Registry**:
   ```bash
   pnpm --filter @tool-evolver/cloud run tool:revoke --tool-id <tool-id> --version <version>
   ```
2. **Propagate Invalidation to All Clients**:
   The cloud gateway emits a global revocation event across all connected SSE and polling clients. Active observer daemons purge the revoked tool from local catalogs immediately.

---

## Related Documentation

- [Release Notes](v1.0.0-release-notes.md)
- [Compatibility Matrix](compatibility-matrix.md)
- [Release Evidence Trace](release-evidence.md)
- [Operational Runbooks](../operator/runbooks.md)
