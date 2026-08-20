#!/usr/bin/env python3
"""One-shot smoke of the full mutation chain using existing b2 transcripts.
Fresh tenant acc-e2e-smoke; skips OMP run and injection. Verifies:
ingest -> detect -> generate -> validate -> replay -> evaluate -> publish ->
promote -> catalog."""
import sys, json, time
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
import harness as H

# Point extractor at b2 transcripts with 3 sessions (meets occurrence threshold).
orig_extract = H.extract
def extract_b2(path, sid):
    return orig_extract(path, sid)

def main():
    ten = "e2e-smoke"
    ACC, WS = f"acc-{ten}", f"ws-{ten}"
    DEV, INST = f"dev-{ten}", f"inst-{ten}"
    HDR = {"Content-Type": "application/json", "x-account-id": ACC, "x-workspace-id": WS}
    ING = dict(HDR, **{"x-device-id": DEV, "x-installation-id": INST})

    sessions, all_events = [], []
    for j in (1, 2, 3):
        path = f"/tmp/te-omp-runs/b2-run{j}.jsonl"
        sid = f"smoke_s{j}"
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
                     {"jobType": "opportunity.detect", "payload": {"sessionIds": sessions}}, headers=HDR)
    H.log(f"detect job: {st}")
    H.drain("detect", 240, headers=HDR)

    st, body = H.req("POST", "/v1/evolution/opportunity/detect", {"events": all_events}, headers=HDR)
    opps = (body or {}).get("opportunities") or []
    for o in opps:
        H.log(f"opp {o.get('status')} {o.get('id')} occ={o.get('occurrenceCount')} "
              f"tool={(o.get('classification') or {}).get('suggestedToolName')}")
    eligible = [o for o in opps if o.get("status") == "eligible"]
    if not eligible:
        H.log("NO_ELIGIBLE — smoke FAILED")
        sys.exit(2)
    opp = sorted(eligible, key=lambda o: -(o.get("occurrenceCount") or 0))[0]

    st, body = H.req("POST", "/v1/evolution/candidates/generate", {"opportunityId": opp["id"]}, headers=HDR)
    H.log(f"generate: {st}")
    if st != 202:
        sys.exit(3)

    cand = None
    t0 = time.time()
    while time.time() - t0 < 720:
        st, body = H.req("GET", f"/v1/evolution/candidates?opportunityId={opp['id']}", timeout=30, headers=HDR)
        cands = (body or {}).get("candidates") or []
        if cands:
            cand = cands[0]
            if (cand.get("state") or cand.get("status")) not in ("generating", "pending", None):
                break
        time.sleep(10)
    if not cand:
        H.log("NO_CANDIDATE — smoke FAILED")
        sys.exit(4)
    H.log(f"candidate {cand['id']} state={cand.get('state')} tool={cand.get('toolName')} "
          f"in {round(time.time()-t0,1)}s")
    json.dump({"candidate": cand}, open("/tmp/te-omp-runs/e2e/smoke_candidate.json", "w"), indent=2)

    st, body = H.req("POST", "/v1/evolution/candidates/validate", {"candidateId": cand["id"]}, headers=HDR)
    lc = (body or {}).get("lifecycle") or {}
    vr = lc.get("validationResult") or {}
    H.log(f"validate: status={vr.get('status')} state={lc.get('currentState')}")
    for r in ((vr.get("testReport") or {}).get("results") or []):
        H.log(f"  test {r.get('name')}: {'PASS' if r.get('passed') else 'FAIL'}")
    if vr.get("status") != "pass":
        H.log("VALIDATION_NOT_PASS — publish chain untestable this round (expected possible)")
        sys.exit(5)

    for step in ("replay", "evaluate"):
        st, body = H.req("POST", f"/v1/evolution/candidates/{step}", {"candidateId": cand["id"]}, headers=HDR)
        lc = (body or {}).get("lifecycle") or {}
        H.log(f"{step}: http={st} state={lc.get('currentState')}")

    st, body = H.req("POST", "/v1/evolution/candidates/publish", {"candidateId": cand["id"]}, headers=HDR)
    H.log(f"publish: http={st} {json.dumps(body)[:400] if body else ''}")
    if not (isinstance(body, dict) and body.get("published")):
        H.log("PUBLISH_FAILED")
        sys.exit(6)

    rid = body.get("rolloutId")
    st, rbody = H.req("POST", "/v1/evolution/rollout/promote",
                      {"rolloutId": rid, "reason": "smoke"}, headers=HDR)
    H.log(f"promote: http={st} {json.dumps(rbody)[:400] if rbody else ''}")

    st, body = H.req("GET", "/v1/evolution/catalog", headers=HDR)
    H.log(f"catalog: http={st} {json.dumps(body)[:600] if body else ''}")
    st, body = H.req("GET", "/v1/evolution/catalog/instructions", headers=HDR)
    H.log(f"instructions: http={st} {json.dumps(body)[:300] if body else ''}")
    H.log("SMOKE COMPLETE")

if __name__ == "__main__":
    main()
