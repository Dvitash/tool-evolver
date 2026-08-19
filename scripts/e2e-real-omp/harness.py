#!/usr/bin/env python3
"""Real-OMP end-to-end experiment (tool-evolver).

5 OMP runs against the mock audit workflow in /tmp/te-omp-bench2.
After each run: extract events -> ingest -> detect -> generate -> validate ->
replay -> evaluate -> publish -> rollout promote -> verify catalog -> inject the
published tool into the manifest-driven MCP shim loaded by OMP
(~/.omp/agent/mcp.json server "tool-evolver-evolved").

Artifacts under /tmp/te-omp-runs/e2e/:
  run{i}.jsonl        OMP transcript (--mode json)
  mutation{i}.json    mutation outcome
  results.json        per-run metrics + mutations
"""
import json, os, re, subprocess, sys, time, urllib.request, urllib.error
from collections import Counter
from pathlib import Path

BASE = "http://127.0.0.1:8090"
E2E = Path("/tmp/te-omp-runs/e2e")
TOOLS_DIR = E2E / "tools"
MANIFEST = TOOLS_DIR / "manifest.json"
BENCH = "/tmp/te-omp-bench2"
PROMPT_FILE = "/tmp/te-omp-bench2-prompt3.txt"
MCP_JSON = Path(os.path.expanduser("~/.omp/agent/mcp.json"))
REDACT = {"isRedacted": True, "redactedFields": [], "redactionStrategy": "mask",
          "scrubbedPatterns": []}
RUNS = 5


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def req(method, path, body=None, timeout=660, headers=None):
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(BASE + path, data=data,
                               headers=headers or {"Content-Type": "application/json"},
                               method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read().decode()
            return resp.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw
    except Exception as e:
        return None, str(e)


BAD_ID_CHARS = re.compile(r"[^A-Za-z0-9_.:-]")


def sanitize_id(value):
    if not isinstance(value, str):
        return value
    return BAD_ID_CHARS.sub("_", value)


def extract(path, session_id):
    """OMP --mode json transcript -> observation events (golden-loop shape)."""
    events, seq, ts, user_done = [], 0, None, False
    with open(path) as f:
        lines = f.readlines()
    for line in lines:
        try:
            e = json.loads(line)
        except Exception:
            continue
        t = e.get("type")
        if t == "session":
            ts = e.get("timestamp") or ts
        elif t == "message_end" and not user_done:
            m = e.get("message", {})
            if m.get("role") == "user":
                text = "".join(c.get("text", "") for c in m.get("content", [])
                               if isinstance(c, dict))
                events.append({"eventId": f"{session_id}_evt_{seq:03d}", "sessionId": session_id,
                               "timestamp": ts, "type": "message", "schemaVersion": "1.0.0",
                               "causalRef": {"causalSequence": seq}, "redaction": REDACT,
                               "role": "user", "content": text[:4000]})
                seq += 1
                user_done = True
        elif t == "tool_execution_start":
            events.append({"eventId": f"{session_id}_evt_{seq:03d}", "sessionId": session_id,
                           "timestamp": ts, "type": "tool_call", "schemaVersion": "1.0.0",
                           "causalRef": {"causalSequence": seq}, "redaction": REDACT,
                           "callId": sanitize_id(e.get("toolCallId")),
                           "toolName": e.get("toolName"),
                           "parameters": e.get("args") or {}, "isShadow": False})
            seq += 1
        elif t == "tool_execution_end":
            res = e.get("result") or {}
            text = ""
            if isinstance(res, dict):
                text = "".join(c.get("text", "") for c in res.get("content", [])
                               if isinstance(c, dict))
            events.append({"eventId": f"{session_id}_evt_{seq:03d}", "sessionId": session_id,
                           "timestamp": ts, "type": "tool_result", "schemaVersion": "1.0.0",
                           "causalRef": {"causalSequence": seq,
                                         "parentId": f"{session_id}_evt_{seq-1:03d}"},
                           "redaction": REDACT, "callId": sanitize_id(e.get("toolCallId")),
                           "toolName": e.get("toolName"),
                           "result": {"stdout": text[:4000]}, "isError": bool(e.get("isError")),
                           "executionDurationMs": 100, "isShadow": False})
            seq += 1
    return events


def drain(label, timeout_s=180, headers=None):
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        st, body = req("GET", "/v1/jobs", timeout=30, headers=headers)
        if not isinstance(body, dict):
            log(f"  {label}: backend unavailable ({st}), retrying")
            time.sleep(3)
            continue
        stats = (body or {}).get("stats") or {}
        if stats.get("pendingCount", 0) == 0 and stats.get("processingCount", 0) == 0:
            log(f"  {label}: queue drained in {round(time.time()-t0,1)}s")
            return True
        time.sleep(2)
    log(f"  {label}: TIMEOUT waiting for drain")
    return False


def run_metrics(path):
    usage_in = usage_out = cache_read = 0
    tools = Counter()
    errors = 0
    for line in open(path):
        try:
            e = json.loads(line)
        except Exception:
            continue
        t = e.get("type")
        if t == "tool_execution_start":
            tools[e.get("toolName")] += 1
            # MCP-evolved tools are invoked by writing JSON args to their xd:// path
            args = e.get("args") or {}
            # invocation = write of JSON args; read of the same path is doc inspection
            if e.get("toolName") == "write" and isinstance(args, dict) \
                    and str(args.get("path", "")).startswith("xd://mcp__"):
                tools["xd-mcp-invoke"] += 1
        elif t == "tool_execution_end":
            if e.get("isError"):
                errors += 1
        elif t == "message_end":
            u = (e.get("message", {}) or {}).get("usage") or {}
            usage_in += u.get("input", 0) or 0
            usage_out += u.get("output", 0) or 0
            cache_read += u.get("cacheRead", 0) or 0
    bash = tools.get("bash", 0)
    evolved = sum(v for k, v in tools.items() if k and "evolved" in k) + tools.get("xd-mcp-invoke", 0)
    return {"inputTokens": usage_in, "outputTokens": usage_out,
            "cacheReadTokens": cache_read, "toolCalls": dict(tools),
            "bashCalls": bash, "evolvedCalls": evolved, "toolErrors": errors}


def run_omp(i):
    prompt = open(PROMPT_FILE).read()
    out = E2E / f"run{i}.jsonl"
    err = E2E / f"run{i}.err"
    log(f"RUN {i}: launching omp session")
    t0 = time.time()
    with open(out, "w") as fo, open(err, "w") as fe:
        p = subprocess.run(
            ["omp", "-p", "--mode", "json", "--model", "gemini-3.7-flash",
             "--approval-mode=yolo", prompt],
            cwd=BENCH, stdout=fo, stderr=fe, timeout=1500)
    dur = round(time.time() - t0, 1)
    m = run_metrics(out)
    m["wallSeconds"] = dur
    m["exitCode"] = p.returncode
    log(f"RUN {i}: done in {dur}s exit={p.returncode} "
        f"in={m['inputTokens']} out={m['outputTokens']} bash={m['bashCalls']} "
        f"evolved={m['evolvedCalls']} tools={m['toolCalls']}")
    return m


LAUNCH = str(int(time.time()))


def mutate(idx, tag=""):
    ten = f"e2e-{LAUNCH}-r{idx}{tag}"
    ACC, WS = f"acc-{ten}", f"ws-{ten}"
    DEV, INST = f"dev-{ten}", f"inst-{ten}"
    HDR = {"Content-Type": "application/json", "x-account-id": ACC, "x-workspace-id": WS}
    ING = dict(HDR, **{"x-device-id": DEV, "x-installation-id": INST})
    out = {"tenant": ACC}

    sessions, all_events = [], []
    for j in range(1, idx + 1):
        sid = f"e2e_s{j}"
        evs = extract(E2E / f"run{j}.jsonl", sid)
        sessions.append(sid)
        all_events.extend(evs)
        batch = {"batchId": f"batch-{ten}-{j}-{int(time.time())}", "workspaceId": WS,
                 "deviceId": DEV, "installationId": INST, "cursor": f"seq-{j}",
                 "compressed": False, "compression": "none", "observations": evs}
        st, body = req("POST", "/v1/observations/batch", batch, headers=ING)
        log(f"  ingest s{j}: {st} events={len(evs)}")
        if st == 409:
            log(f"  ingest s{j}: duplicate batch (409), continuing")
        elif st != 202 and st != 200:
            out["status"] = "ingest_failed"
            out["detail"] = body
            return out

    drain("ingest", headers=HDR)
    st, body = req("POST", "/v1/jobs",
                   {"jobType": "opportunity.detect", "payload": {"sessionIds": sessions}}, headers=HDR)
    log(f"  detect job: {st}")
    drain("opportunity.detect", 240, headers=HDR)

    st, body = req("POST", "/v1/evolution/opportunity/detect", {"events": all_events}, headers=HDR)
    opps = (body or {}).get("opportunities") or []
    out["opportunities"] = [
        {"id": o.get("id"), "status": o.get("status"),
         "occ": o.get("occurrenceCount"), "sess": o.get("distinctSessionCount"),
         "tool": (o.get("classification") or {}).get("suggestedToolName")}
        for o in opps]
    eligible = [o for o in opps if o.get("status") == "eligible"]
    if not eligible:
        out["status"] = "no_eligible"
        log(f"  no eligible opportunity: {out['opportunities']}")
        return out
    eligible.sort(key=lambda o: -(o.get("occurrenceCount") or 0))
    opp = eligible[0]
    out["opportunityId"] = opp["id"]
    log(f"  eligible opp {opp['id']} occ={opp.get('occurrenceCount')} "
        f"tool={(opp.get('classification') or {}).get('suggestedToolName')}")

    st, body = req("POST", "/v1/evolution/candidates/generate", {"opportunityId": opp["id"]}, headers=HDR)
    if st != 202:
        out["status"] = "generate_rejected"
        out["detail"] = body
        return out
    log(f"  generate accepted (job {body.get('jobId') if isinstance(body, dict) else '?'})")

    cand = None
    t0 = time.time()
    while time.time() - t0 < 720:
        st, body = req("GET", f"/v1/evolution/candidates?opportunityId={opp['id']}", timeout=30, headers=HDR)
        cands = (body or {}).get("candidates") or []
        if cands:
            cand = cands[0]
            state = cand.get("state") or cand.get("status")
            if state not in ("generating", "pending", None):
                break
        time.sleep(10)
    if not cand:
        out["status"] = "no_candidate_720s"
        return out
    out["candidateId"] = cand["id"]
    out["candidateState"] = cand.get("state")
    out["toolName"] = cand.get("toolName")
    log(f"  candidate {cand['id']} state={cand.get('state')} tool={cand.get('toolName')} "
        f"after {round(time.time()-t0,1)}s")
    json.dump({"candidate": cand}, open(E2E / f"candidate_r{idx}{tag}.json", "w"), indent=2)

    t0 = time.time()
    st, body = req("POST", "/v1/evolution/candidates/validate", {"candidateId": cand["id"]}, headers=HDR)
    lifecycle = (body or {}).get("lifecycle") or {}
    vr = lifecycle.get("validationResult") or {}
    out["validation"] = vr.get("status")
    out["lifecycleState"] = lifecycle.get("currentState")
    out["tests"] = [{"name": r.get("name"), "passed": r.get("passed")}
                    for r in ((vr.get("testReport") or {}).get("results") or [])]
    log(f"  validate: {vr.get('status')} state={lifecycle.get('currentState')} "
        f"in {round(time.time()-t0,1)}s tests={out['tests']}")
    json.dump({"validate": body}, open(E2E / f"validate_r{idx}{tag}.json", "w"), indent=2)
    if vr.get("status") != "pass":
        out["status"] = "validation_failed"
        return out

    for step in ("replay", "evaluate"):
        st, body = req("POST", f"/v1/evolution/candidates/{step}", {"candidateId": cand["id"]}, headers=HDR)
        lc = (body or {}).get("lifecycle") or {}
        out[step] = {"http": st, "state": lc.get("currentState")}
        log(f"  {step}: http={st} state={lc.get('currentState')}")
        if st != 200:
            out["status"] = f"{step}_failed"
            out["detail"] = body
            return out

    st, body = req("POST", "/v1/evolution/candidates/publish", {"candidateId": cand["id"]}, headers=HDR)
    out["publish"] = {"http": st, "body": body if isinstance(body, dict) else str(body)[:400]}
    log(f"  publish: http={st} {json.dumps(body)[:300] if body else ''}")
    if st not in (200, 201, 202) or not (isinstance(body, dict) and body.get("published")):
        out["status"] = "publish_failed"
        return out
    out["published"] = True
    out["version"] = body.get("version")
    out["rolloutId"] = body.get("rolloutId")
    out["rolloutState"] = body.get("state")

    if body.get("rolloutId"):
        st, rbody = req("POST", "/v1/evolution/rollout/promote",
                        {"rolloutId": body["rolloutId"], "reason": "e2e experiment promotion"}, headers=HDR)
        out["promote"] = {"http": st, "body": rbody if isinstance(rbody, dict) else str(rbody)[:400]}
        log(f"  promote: http={st} {json.dumps(rbody)[:300] if rbody else ''}")

    st, body = req("GET", "/v1/evolution/catalog", headers=HDR)
    cat_raw = json.dumps((body or {}).get("catalog") or {})
    out["catalogHasTool"] = (out.get("toolName") or "__none__") in cat_raw
    log(f"  catalog contains tool: {out['catalogHasTool']}")

    inject_tool(cand, out)
    out["status"] = "published"
    return out


def inject_tool(cand, out):
    """Write published source into the MCP shim manifest (upsert by tool name)."""
    inner = cand.get("candidate") or {}
    pt = inner.get("proposedTool") or {}
    ar = cand.get("activeRevision") or {}
    arts = ar.get("artifacts") or {}
    src = arts.get("sourceCode") or cand.get("sourceCode") or ""
    name = pt.get("name") or cand.get("toolName") or "evolved_tool"
    desc = pt.get("description") or "Evolved tool synthesized by tool-evolver."
    desc += (
        " Takes no input: invoke with an empty JSON object {}"
        " (in OMP: write {} to this tool's xd:// path)."
        " One call returns JSON containing every value listed above."
        " Strongly prefer this over issuing many separate bash commands."
    )
    schema = pt.get("parameters") or {"type": "object", "properties": {}}
    if not src:
        out["injected"] = False
        log("  inject: NO SOURCE, skipped")
        return
    path = TOOLS_DIR / f"{name}.ts"
    path.write_text(src)
    manifest = {"tools": []}
    if MANIFEST.exists():
        try:
            manifest = json.loads(MANIFEST.read_text())
        except Exception:
            pass
    tools = [t for t in manifest.get("tools", []) if t.get("name") != name]
    tools.append({"name": name, "description": desc, "file": str(path),
                  "inputSchema": schema, "candidateId": cand.get("id")})
    manifest["tools"] = tools
    MANIFEST.write_text(json.dumps(manifest, indent=2))
    out["injected"] = True
    out["manifestTools"] = [t["name"] for t in tools]
    log(f"  injected {name} -> {path} (manifest now: {out['manifestTools']})")


def setup_mcp_json():
    cfg = json.loads(MCP_JSON.read_text())
    servers = cfg.setdefault("mcpServers", {})
    servers["tool-evolver-evolved"] = {
        "type": "stdio",
        "command": "node",
        "args": ["/tmp/te-omp-runs/e2e/evolved-mcp-server.mjs"],
    }
    MCP_JSON.write_text(json.dumps(cfg, indent=2) + "\n")
    if not MANIFEST.exists():
        MANIFEST.write_text(json.dumps({"tools": []}, indent=2))
    log(f"mcp.json updated; servers: {list(servers)}")


def main():
    setup_mcp_json()
    start = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    results = []
    for j in range(1, start):
        tpath = E2E / f"run{j}.jsonl"
        if tpath.exists():
            m = run_metrics(tpath)
            m["wallSeconds"] = None
            m["exitCode"] = 0
            mpath = E2E / f"mutation{j}.json"
            mut = json.load(open(mpath)) if mpath.exists() else {"status": "pre-resume"}
            results.append({"run": j, "metrics": m, "mutation": mut})
            log(f"resumed run {j} from transcript: in={m['inputTokens']} bash={m['bashCalls']}")
    for i in range(start, RUNS + 1):
        m = run_omp(i)
        mut = mutate(i)
        if mut.get("status") == "validation_failed":
            log(f"MUTATION {i}: validation failed, retrying with fresh tenant (b)")
            mut_retry = mutate(i, "b")
            mut_retry["retried"] = True
            mut = {"first": mut, "retry": mut_retry, "status": mut_retry.get("status")}
        json.dump(mut, open(E2E / f"mutation{i}.json", "w"), indent=2, default=str)
        results.append({"run": i, "metrics": m, "mutation": mut})
        json.dump(results, open(E2E / "results.json", "w"), indent=2, default=str)
        log(f"RUN {i} COMPLETE: mutation status={mut.get('status')}")
    log("EXPERIMENT COMPLETE")
    log(json.dumps([{ "run": r["run"],
                      "in": r["metrics"]["inputTokens"],
                      "out": r["metrics"]["outputTokens"],
                      "bash": r["metrics"]["bashCalls"],
                      "evolved": r["metrics"]["evolvedCalls"],
                      "mut": r["mutation"].get("status")} for r in results], indent=2))


if __name__ == "__main__":
    main()
