# Privacy-Safe Telemetry & Analytics

Tool Evolver includes an opt-in, privacy-preserving telemetry and analytics pipeline designed to evaluate tool performance and reliability across client installations without collecting personal information or code.

---

## 1. Privacy Guarantees & Non-Collection

| Data Category | Collected by Telemetry? | Handling & Guarantees |
|---------------|-------------------------|------------------------|
| **User Prompts / Reasoning** | ❌ **Never** | Dropped locally; never buffered or transmitted |
| **Workspace Source Code** | ❌ **Never** | Dropped locally; never buffered or transmitted |
| **Environment Variables & Secrets** | ❌ **Never** | Redacted by regex & entropy scanners before storage |
| **Tool Names & Semver** | ✅ Yes (Opt-in) | Aggregated counters (e.g. `git_cleaner:v1.2.0`) |
| **Execution Latencies** | ✅ Yes (Opt-in) | Quantized bucketed histograms (ms) |
| **Success / Failure Codes** | ✅ Yes (Opt-in) | Coarse error category (e.g. `TIMEOUT`, `EXIT_1`) |

---

## 2. Metric Windows & Aggregation

Telemetry events are batched and aggregated locally before periodic dispatch (default: once every 60 minutes):

```json
{
  "windowStart": "2026-08-17T12:00:00Z",
  "windowEnd": "2026-08-17T13:00:00Z",
  "clientMetrics": {
    "totalInvocations": 42,
    "successfulInvocations": 41,
    "failedInvocations": 1,
    "latencyP50Ms": 35,
    "latencyP95Ms": 120
  },
  "toolBreakdown": [
    {
      "toolId": "git_branch_cleaner",
      "version": "1.2.0",
      "invocations": 18,
      "errors": 0
    }
  ]
}
```

---

## 3. Disabling Telemetry (Opt-Out)

Telemetry is disabled by default in strict local-only deployments. Users can explicitly disable telemetry at any time:

### Via CLI
```bash
tool-evolver config set privacy.telemetryEnabled false
```

### Via Environment Variable
```bash
export TOOL_EVOLVER_TELEMETRY_DISABLED=true
```

---

## Related Documentation

- [Deployment Architecture](deployment.md)
- [Operations & Monitoring](operations.md)
- [Privacy Inventory (Security)](../security/privacy-inventory.md)
- [Threat Model (Security)](../security/threat-model.md)
