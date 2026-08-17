# Backup & Disaster Recovery Guide

This document defines the backup schedules, retention policies, Point-In-Time Recovery (PITR) workflows, and Recovery Point / Recovery Time Objectives for the Tool Evolver Cloud platform.

---

## 1. Recovery Objectives & SLAs

| Metric | Target SLA | Description |
|--------|------------|-------------|
| **Recovery Point Objective (RPO)** | `<= 5 minutes` | Maximum permissible data loss in a catastrophic failure |
| **Recovery Time Objective (RTO)** | `<= 30 minutes`| Maximum permissible downtime before full service restoration |
| **Backup Retention Period** | `30 days` daily, `1 year` monthly | Archive retention standard for audit and compliance |

---

## 2. Backup Strategy

### A. PostgreSQL Database
- **Continuous WAL Archiving**: Write-Ahead Logs (WAL) are streamed continuously to S3 every 60 seconds.
- **Daily Base Backups**: Full automated pg_dump / pg_basebackup executed daily at 02:00 UTC.
- **Cross-Region Replication**: WAL archives and daily snapshots are replicated to a secondary cloud region.

### B. Object Storage (Tool Bundles)
- **S3 Versioning**: Enabled on the `tool-evolver-bundles` bucket with object lock for 90 days.
- **S3 Cross-Region Replication (CRR)**: Automatically replicates new tool artifacts to the disaster recovery region.

---

## 3. Database Restoration Procedures

### Step 1: Provision Clean Target Instance
Ensure a PostgreSQL 16 instance is available with matching storage and CPU allocation.

### Step 2: Restore from Latest Base Backup
```bash
# Download latest base backup snapshot
aws s3 cp s3://tool-evolver-backups-prod/db/latest-base.tar.gz ./base.tar.gz

# Extract into PostgreSQL data directory
tar -xzf base.tar.gz -C /var/lib/postgresql/data/
```

### Step 3: Configure Point-In-Time Recovery (PITR)
Create `recovery.signal` and configure `postgresql.conf`:

```text
restore_command = 'aws s3 cp s3://tool-evolver-backups-prod/wal/%f %p'
recovery_target_time = '2026-08-17 14:00:00 UTC'
```

### Step 4: Start PostgreSQL and Verify
```bash
systemctl start postgresql
# Verify database consistency
pnpm --filter @tool-evolver/db run verify:integrity
```

---

## 4. Disaster Recovery (DR) Verification Routine

Disaster recovery drills must be executed **quarterly**:

1. Spin up an isolated DR staging environment.
2. Restore database from S3 WAL archive up to a chosen timestamp.
3. Validate tool catalog, user records, and candidate evaluation histories.
4. Measure and document achieved RPO and RTO in the compliance audit log.

---

## Related Documentation

- [Deployment Architecture](deployment.md)
- [Operations & Monitoring](operations.md)
- [Operational Runbooks](runbooks.md)
- [Key Rotation](key-rotation.md)
- [Client & Cloud Rollback Procedures](../release/rollback-procedure.md)
