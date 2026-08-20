#!/usr/bin/env python3
"""Regenerate a full-coverage evolved tool from dense OMP transcripts.

Uses b2 transcripts (git + wc/grep families). run4/run5 explode G1 into
~30 per-file profiles and fail evidence-coverage; do not use them here.
"""
import json
import sys
import time
import uuid
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


def _fail(msg, code):
    H.log(msg)
    sys.exit(code)


def main():
    for p in TRANSCRIPTS:
        if not Path(p).is_file():
            _fail(f"missing transcript {p}", 2)
    ten = f"e2e-fullcov-{uuid.uuid4().hex[:8]}"
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
        batch = {"batchId": f"batch-{uuid.uuid4()}", "workspaceId": WS,
                 "deviceId": DEV, "installationId": INST, "cursor": f"seq-{j}",
                 "compressed": False, "compression": "none", "observations": evs}
        st, body = H.req("POST", "/v1/observations/batch", batch, headers=ING)
        H.log(f"ingest s{j}: {st} events={len(evs)}")
        if st not in (200, 201, 202):
            _fail(f"ingest s{j} failed http={st} body={body}", 2)

    if not H.drain("ingest", headers=HDR):
        _fail("ingest drain failed", 2)
    # Detect once from the same normalized events. Enqueuing opportunity.detect
    # as well duplicates the model-heavy pass and its global queue drain can be
    # blocked by unrelated/dead-lettered jobs.

    st, body = H.req("POST", "/v1/evolution/opportunity/detect", {"events": all_events},
                     headers=HDR)
    if st != 200:
        _fail(f"opportunity detect failed http={st} body={body}", 2)
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
    H.log(f"generate: {st} {body}")
    if st != 202:
        _fail(f"generate failed http={st} body={body}", 3)

    FAILED = {"failed", "quarantined", "rejected", "error"}
    cand = None
    t0 = time.time()
    while time.time() - t0 < 720:
        st, body = H.req(
            "GET", f"/v1/evolution/candidates?opportunityId={opp['id']}",
            timeout=30, headers=HDR)
        if st != 200:
            H.log(f"poll candidates http={st} {body}")
            time.sleep(10)
            continue
        cands = (body or {}).get("candidates") or []
        if not cands:
            time.sleep(10)
            continue
        pick = None
        for c in cands:
            s = (c.get("state") or c.get("status") or "").lower()
            if s in FAILED:
                continue
            pick = c
            break
        if pick is None:
            _fail(f"candidates failed/quarantined: {cands}", 4)
        cand = pick
        s = (cand.get("state") or cand.get("status") or "")
        if s.lower() in FAILED:
            _fail(f"candidate {cand.get('id')} in failed state {s}", 4)
        if s not in ("generating", "pending", None):
            break
        time.sleep(10)
    if not cand:
        H.log("NO_CANDIDATE")
        sys.exit(4)
    if (cand.get("state") or cand.get("status") or "").lower() in FAILED:
        _fail(f"candidate terminal failed state {cand.get('state')}", 4)
    H.log(f"candidate {cand['id']} state={cand.get('state')} tool={cand.get('toolName')}")

    st, body = H.req("POST", "/v1/evolution/candidates/validate",
                     {"candidateId": cand["id"]}, headers=HDR)
    if st != 200:
        _fail(f"validate http={st} body={body}", 5)
    lc = (body or {}).get("lifecycle") or {}
    vr = lc.get("validationResult") or {}
    H.log(f"validate: status={vr.get('status')} state={lc.get('currentState')}")
    if vr.get("status") != "pass":
        _fail(f"validation failed status={vr.get('status')} {body}", 5)
    for step in ("replay", "evaluate"):
        st, body = H.req("POST", f"/v1/evolution/candidates/{step}",
                         {"candidateId": cand["id"]}, headers=HDR)
        H.log(f"{step}: http={st} {body}")
        if st != 200:
            _fail(f"{step} failed http={st} body={body}", 5)
    st, body = H.req("POST", "/v1/evolution/candidates/publish",
                     {"candidateId": cand["id"]}, headers=HDR)
    H.log(f"publish: {st} {body}")
    if st not in (200, 201, 202) or not (isinstance(body, dict) and body.get("published")):
        _fail(f"publish failed http={st} body={body}", 6)
    published = body
    rid = published.get("rolloutId")
    if not rid:
        _fail(f"publish missing rolloutId body={body}", 6)
    st, rbody = H.req("POST", "/v1/evolution/rollout/promote",
          {"rolloutId": rid, "reason": "fullcov"}, headers=HDR)
    H.log(f"promote: {st} {rbody}")
    if st != 200:
        _fail(f"promote failed http={st} body={rbody}", 6)
    st, catalog_body = H.req("GET", "/v1/evolution/catalog", headers=HDR)
    H.log(f"catalog: {json.dumps(catalog_body)[:800] if catalog_body else ''}")
    if st != 200 or not isinstance(catalog_body, dict):
        _fail(f"catalog fetch failed http={st} body={catalog_body}", 6)
    catalog = catalog_body.get("catalog") or {}
    tool_name = published.get("toolName") or ""
    version = published.get("version") or ""
    tools = catalog.get("tools") or []
    catalog_tool = next(
        (tool for tool in tools
         if tool.get("name") == tool_name and tool.get("version") == version),
        None,
    )
    if not catalog_tool:
        _fail(f"catalog missing exact tool {tool_name}@{version}", 6)
    deployments = catalog.get("activeDeployments") or []
    deployment = next(
        (item for item in deployments
         if item.get("toolId") == catalog_tool.get("id")
         and item.get("toolVersion") == version
         and item.get("state") == "promoted"),
        None,
    )
    if not deployment:
        _fail(f"catalog missing promoted deployment for {tool_name}@{version}", 6)
    H.log(f"catalog verified: {tool_name}@{version}")
    st, ibody = H.req("GET", "/v1/evolution/catalog/instructions", headers=HDR)
    H.log(f"instructions: {json.dumps(ibody)[:800] if ibody else ''}")
    if st != 200 or not isinstance(ibody, dict):
        _fail(f"instructions fetch failed http={st} body={ibody}", 6)
    md = ibody.get("markdown") or ""
    if f"### `{tool_name}`" not in md.splitlines():
        _fail(f"instructions missing exact tool heading {tool_name}: {md[:800]}", 6)
    H.log(f"instructions verified: {tool_name}")
    st, refreshed = H.req(
        "GET", f"/v1/evolution/candidates?opportunityId={opp['id']}",
        timeout=30, headers=HDR)
    if st != 200 or not isinstance(refreshed, dict):
        _fail(f"published candidate refresh failed http={st} body={refreshed}", 6)
    cand = next(
        (item for item in refreshed.get("candidates", [])
         if item.get("id") == cand["id"]),
        None,
    )
    if not cand:
        _fail(f"published candidate {published.get('candidateId')} missing", 6)
    active = cand.get("activeRevision") or {}
    source = cand.get("sourceCode") or active.get("sourceCode")
    if not source:
        source = (active.get("artifacts") or {}).get("sourceCode")
    if not source:
        _fail(f"published candidate {cand['id']} has no active source", 6)
    Path("/tmp/te-omp-runs/e2e").mkdir(parents=True, exist_ok=True)
    json.dump({"tenant": ten, "acc": ACC, "ws": WS, "candidate": cand},
              open("/tmp/te-omp-runs/e2e/fullcov_candidate.json", "w"), indent=2)
    injected = {}
    H.inject_tool(cand, injected)
    H.log(f"inject: {injected}")
    if not injected.get("injected"):
        _fail(f"inject failed {injected}", 6)
    json.dump({"tenant": ten, "acc": ACC, "ws": WS, "candidateId": cand.get("id"),
               "injected": injected},
              open("/tmp/te-omp-runs/e2e/fullcov_tenant.json", "w"), indent=2)
    print(ten)
    H.log("FULLCOV COMPLETE")


if __name__ == "__main__":
    main()
