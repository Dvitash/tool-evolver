# Cloud Service Deployment Architecture

This document describes the production deployment topology, infrastructure requirements, database migrations, object storage, and worker execution runtime for the Tool Evolver Cloud platform.

---

## 1. Cloud Architecture Overview

```text
                               ┌────────────────────────┐
                               │   API Gateway / Edge   │
                               │  (TLS Termination, LB) │
                               └───────────┬────────────┘
                                           │
                      ┌────────────────────┼────────────────────┐
                      ▼                                         ▼
         ┌─────────────────────────┐               ┌─────────────────────────┐
         │   Cloud API Service     │               │   Auth & Device Service │
         │ (Catalog, Sync, Health) │               │   (Token Exchange, OIDC)│
         └────────────┬────────────┘               └────────────┬────────────┘
                      │                                         │
        ┌─────────────┴─────────────┐             ┌─────────────┴─────────────┐
        ▼                           ▼             ▼                           ▼
 ┌──────────────┐            ┌──────────────┐ ┌──────────────┐         ┌──────────────┐
 │ PostgreSQL 16│            │ Object Store │ │ Redis / Queue│         │ Synthesis &  │
 │  (Relational)│            │ (S3 Bundles) │ │ (BullMQ/Jobs)│         │ Eval Workers │
 └──────────────┘            └──────────────┘ └──────────────┘         └──────────────┘
```

---

## 2. Component Requirements

| Component | Minimum Specification | Production Recommended | Technology / Engine |
|-----------|-----------------------|------------------------|---------------------|
| **API Nodes** | 2 vCPU, 4 GB RAM | 4 vCPU, 8 GB RAM (3+ nodes) | Node.js 22+ (Fastify / Express) |
| **PostgreSQL**| 2 vCPU, 4 GB RAM | 8 vCPU, 32 GB RAM (HA Replica) | PostgreSQL 16 with WAL archiving |
| **Durable Queue** | 2 vCPU, 4 GB RAM | 4 vCPU, 8 GB RAM (Redis Cluster) | Redis 7.2+ or pg-boss / RabbitMQ |
| **Object Store** | 50 GB storage | S3-compatible multi-region | AWS S3, MinIO, or Cloudflare R2 |
| **Worker Nodes** | 4 vCPU, 8 GB RAM | 16 vCPU, 32 GB RAM (Autoscaling) | Hardened Deno / Container Sandboxes |

---

## 3. Database Schema Migrations

Tool Evolver uses ordered, idempotent SQL migrations located in `packages/db/migrations/`.

### Running Migrations

To apply pending migrations in production:

```bash
pnpm --filter @tool-evolver/db run migrate:up
```

### Migration Integrity Checks

Verify migration status and checksums:

```bash
pnpm --filter @tool-evolver/db run migrate:status
```

The database schema manages:
- **Workspaces & Devices**: Cryptographic device records, authorized public keys, and workspace enrollments.
- **Tool Catalog & Versions**: Evolved tool manifests, bundle hashes, and signature metadata.
- **Evaluation Records**: Scoring metrics, sandbox test runs, and candidate benchmarks.
- **Deployments & Rollouts**: Canary split percentages, promotion states, and rollback events.
- **Audit Trails**: Tamper-evident execution logs and administrative modifications.

---

## 4. Object Storage Configuration

Tool bundle archives (`.tar.gz`) containing compiled code, manifests, and signatures are stored in S3-compatible object storage.

### Required Bucket Policies

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowWorkerBundleReadWrite",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:HeadObject"],
      "Resource": "arn:aws:s3:::tool-evolver-bundles-prod/*"
    }
  ]
}
```

---

## 5. Worker Runtime & Sandboxing

Worker nodes evaluate generated tool candidates against historical replay benchmarks:

1. **Isolation Engine**: Workers run each candidate inside a fresh Deno / cgroup v2 sandbox with zero network access and restricted disk mounts.
2. **Resource Quotas**: Hard CPU caps (1.0 core) and memory caps (512 MB) are enforced per test container.
3. **Execution Timeout**: Evaluations are killed and marked as failed if they exceed 45 seconds.

---

## Related Documentation

- [Operations Guide](operations.md)
- [Operational Runbooks](runbooks.md)
- [Backup & Restore](backup-and-restore.md)
- [Key Rotation](key-rotation.md)
- [Security Threat Model](../security/threat-model.md)
