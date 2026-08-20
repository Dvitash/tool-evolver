#!/usr/bin/env python3
"""Regenerate a full-coverage evolved tool from dense OMP transcripts.

Uses b2 transcripts (git + wc/grep families). run4/run5 explode G1 into
~30 per-file profiles and fail evidence-coverage; do not use them here.
"""
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import harness as H  # noqa: E402

# b2: git log/status + wc/grep on modules without 30 per-file commands.
TRANSCRIPTS = [
    "/tmp/te-omp-runs/b2-run1.jsonl",
    "/tmp/te-omp-runs/b2-run2.jsonl",
    "/tmp/te-omp-runs/b2-run3.jsonl",
]


def main():
    ten = f"e2e-fullcov-{int(time.time())}"
    ACC, WS = f"acc-{ten}", f"ws-{ten}"
    DEV, INST = f"dev-{ten}", f"inst-{ten}"
    HDR = {"Content-Type": "application/json", "x-account-id": ACC, "x-workspace-id": WS}
    ING = dict(HDR, **{"x-device-id": DEV, "x-installation-id": INST})
    H.log(f"tenant {ten}")

    sessions, all_events = [], []
    for j, path in enumerate(TRANSCRIPTS, 1):
        sid = f"fullcov_s{j}"
        evs = H.extract(path, sid)
        sessions.append(sid)
        all_events.extend(evs)
        batch = {"batchId": f"batch-{ten}-{j}-{int(time.time())}", "workspaceId": WS,
                 "deviceId": DEV, "installationId": INST, "cursor": f"seq-{j}",
                 "compressed": False, "compression": "none", "observations": evs}
        st, body = H.req("POST", "/v1/observations/batch", batch, headers=ING)
        H.log(f"ingest s{j}: {st} events={len(evs)}")

    H.drain("ingest", headers=HDR)
    st, body = H.req("POST", "/v1/jobs",
                     {"jobType": "opportunity.detect", "payload": {"sessionIds": sessions}},
                     headers=HDR)
    H.log(f"detect job: {st}")
    H.drain("detect", 240, headers=HDR)

    st, body = H.req("POST", "/v1/evolution/opportunity/detect", {"events": all_events},
                     headers=HDR)
    opps = (body or {}).get("opportunities") or []
    for o in opps:
        H.log(f"opp {o.get('status')} {o.get('id')} occ={o.get('occurrenceCount')} "
              f"tool={(o.get('classification') or {}).get('suggestedToolName')}")
    eligible = [o for o in opps if o.get("status") == "eligible"]
    if not eligible:
        H.log("NO_ELIGIBLE")
        sys.exit(2)
    opp = sorted(eligible, key=lambda o: -(o.get("occurrenceCount") or 0))[0]

    st, body = H.req("POST", "/v1/evolution/candidates/generate",
                     {"opportunityId": opp["id"]}, headers=HDR)
    H.log(f"generate: {st}")
    if st != 202:
        sys.exit(3)

    cand = None
    t0 = time.time()
    while time.time() - t0 < 720:
        st, body = H.req(
            "GET", f"/v1/evolution/candidates?opportunityId={opp['id']}",
            timeout=30, headers=HDR)
        cands = (body or {}).get("candidates") or []
        if cands:
            cand = cands[0]
            if (cand.get("state") or cand.get("status")) not in ("generating", "pending", None):
                break
        time.sleep(10)
    if not cand:
        H.log("NO_CANDIDATE")
        sys.exit(4)
    H.log(f"candidate {cand['id']} state={cand.get('state')} tool={cand.get('toolName')}")
    st, full = H.req("GET", f"/v1/evolution/candidates/{cand['id']}", headers=HDR)
    if st == 200 and isinstance(full, dict):
        cand = full.get("candidate") or full
    json.dump({"tenant": ten, "acc": ACC, "ws": WS, "candidate": cand},
              open("/tmp/te-omp-runs/e2e/fullcov_candidate.json", "w"), indent=2)

    st, body = H.req("POST", "/v1/evolution/candidates/validate",
                     {"candidateId": cand["id"]}, headers=HDR)
    lc = (body or {}).get("lifecycle") or {}
    vr = lc.get("validationResult") or {}
    H.log(f"validate: status={vr.get('status')} state={lc.get('currentState')}")
    if vr.get("status") != "pass":
        sys.exit(5)
    for step in ("replay", "evaluate"):
        st, body = H.req("POST", f"/v1/evolution/candidates/{step}",
                         {"candidateId": cand["id"]}, headers=HDR)
        H.log(f"{step}: http={st}")
    st, body = H.req("POST", "/v1/evolution/candidates/publish",
                     {"candidateId": cand["id"]}, headers=HDR)
    H.log(f"publish: {st}")
    if not (isinstance(body, dict) and body.get("published")):
        sys.exit(6)
    rid = body.get("rolloutId")
    H.req("POST", "/v1/evolution/rollout/promote",
          {"rolloutId": rid, "reason": "fullcov"}, headers=HDR)
    st, body = H.req("GET", "/v1/evolution/catalog", headers=HDR)
    H.log(f"catalog: {json.dumps(body)[:800] if body else ''}")
    st, full = H.req("GET", f"/v1/evolution/candidates/{cand['id']}", headers=HDR)
    if st == 200 and isinstance(full, dict):
        cand = full.get("candidate") or full
    injected = {}
    H.inject_tool(cand, injected)
    H.log(f"inject: {injected}")
    json.dump({"tenant": ten, "acc": ACC, "ws": WS, "candidateId": cand.get("id"),
               "injected": injected},
              open("/tmp/te-omp-runs/e2e/fullcov_tenant.json", "w"), indent=2)
    print(ten)
    H.log("FULLCOV COMPLETE")


if __name__ == "__main__":
    main()
