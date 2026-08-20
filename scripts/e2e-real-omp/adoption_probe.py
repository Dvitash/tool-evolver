#!/usr/bin/env python3
"""Factorial adoption probe (shim × instructions) with cold prompt-cache.

omp 17.3.8 has no --no-cache. Isolation:
  * unique --profile per run (local caches, mcp.json, APPEND_SYSTEM.md)
  * --config omp_overlay.yml  (providers.cacheRetention: none)
  * --no-session
  * unique HTML-comment nonce prefix on the user prompt
  * unique bench workdir copy so --jobs > 1 cannot clobber cwd

Does not patch ~/.omp/agent. Does not call `omp models` (hangs).
Writes artifacts under /tmp/te-omp-runs/e2e/probe/.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import statistics
import subprocess
import sys
import time
import uuid
import yaml
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import harness as H  # noqa: E402

REPO = HERE.parent.parent
SHIM = HERE / "evolved-mcp-server.mjs"
OUT = Path("/tmp/te-omp-runs/e2e/probe")
PROMPT4 = Path("/tmp/te-omp-bench2-prompt4.txt")
PROMPT3 = Path("/tmp/te-omp-bench2-prompt3.txt")
# prompt4 + trailing '?' suppresses omp 17.3.8's eager-todo-prelude, whose
# forced first tool call Muse frequently emits with malformed JSON args
# (JSON Parse error kills the turn). Baseline for Muse factorial runs.
PROMPT4Q = Path("/tmp/te-omp-bench2-prompt4q.txt")
# prompt4q + explicit xd:// MCP tool-use nudge in the user prompt
PROMPT5 = Path("/tmp/te-omp-bench2-prompt5.txt")
TEMPLATE = Path(os.path.expanduser("~/.omp/profiles/te-spark-e2e"))
DEFAULT_AGENT = Path(os.path.expanduser("~/.omp/agent"))
SERVER = "tool-evolver-gateway"
TOOL = "git_operation_helper"
XD = f"xd://mcp__{SERVER.replace('-', '_')}_{TOOL}"

FACTORIAL = [
    ("ctrl", False, False, "prompt5"),
    ("shim", True, False, "prompt5"),
    ("shim4q", True, False, "prompt4q"),
    ("instr", False, True, "prompt5"),
    ("both", True, True, "prompt5"),
]


def fallback_instructions() -> str:
    md = (
        f"### `{TOOL}`\n\n"
        "Runs the observed git/module audit workflow in one call. "
        "Prefer this over separate bash git/wc/grep commands.\n"
    )
    return (
        "<!-- tool-evolver:catalog:start -->\n\n"
        f"{md}\n"
        "These tools are exposed over MCP. Invoke them through the `xd://` "
        "tool-device surface rather than re-running the underlying shell "
        "commands manually.\n\n"
        f"#### Invocation: `{TOOL}`\n"
        f"- **Invoke**: write the JSON arguments to `{XD}` "
        f"(e.g. `write` `{{\"path\": \"{XD}\", \"content\": \"{{}}\"}}` "
        "when the tool takes no inputs).\n"
        f"- **Docs**: `read` `{XD}` returns the tool's documentation.\n\n"
        "<!-- tool-evolver:catalog:end -->\n"
    )


def catalog_headers() -> dict:
    ten = Path("/tmp/te-omp-runs/e2e/fullcov_tenant.json")
    if ten.is_file():
        d = json.loads(ten.read_text())
        return {
            "Content-Type": "application/json",
            "x-account-id": d.get("acc") or "acc-e2e-d3probe",
            "x-workspace-id": d.get("ws") or "ws-e2e-d3probe",
        }
    return {
        "Content-Type": "application/json",
        "x-account-id": "acc-e2e-d3probe",
        "x-workspace-id": "ws-e2e-d3probe",
    }


def catalog_instructions() -> str:
    st, body = H.req("GET", "/v1/evolution/catalog/instructions", headers=catalog_headers())
    if st == 200 and isinstance(body, dict):
        md = body.get("markdown") or body.get("instructionsMarkdown") or ""
        names = body.get("toolNames") or [TOOL]
        if md:
            return (
                "<!-- tool-evolver:catalog:start -->\n\n"
                f"{md.strip()}\n\n"
                "These tools are exposed over MCP. Invoke them through the "
                "`xd://` tool-device surface rather than re-running the "
                "underlying shell commands manually.\n\n"
                + "".join(
                    f"#### Invocation: `{n}`\n"
                    f"- **Invoke**: write JSON args to "
                    f"`xd://mcp__{SERVER.replace('-', '_')}_{n}`.\n"
                    f"- **Docs**: `read` that path.\n\n"
                    for n in names
                )
                + "<!-- tool-evolver:catalog:end -->\n"
            )
    return fallback_instructions()


def mcp_payload(shim: bool) -> dict:
    servers = {}
    if shim:
        servers[SERVER] = {
            "type": "stdio",
            "command": "node",
            "args": [str(SHIM)],
        }
    return {
        "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
        "mcpServers": servers,
    }


def proxy_provider_entry() -> dict:
    """Muse via the opencode-go gateway, openai-responses API.

    Fixes the omp 17.3.8 abort: the relay's /v1/chat/completions endpoint
    closes SSE streams without a finish_reason chunk ('OpenAI completions
    stream closed before a finish_reason was received' kills any turn that
    streamed content). The /v1/responses endpoint emits proper terminal
    events, so custom provider 'te-ocg' uses openai-responses and completes
    multi-turn workflows. Note omp re-resolves responses-API models through
    the built-in gateway (baseUrl here is informational; requests go direct
    to https://opencode.ai/zen/go/v1). Key is read from the copied agent.db
    at runtime (never echoed), matching the built-in opencode-go credential.
    """
    key = ""
    try:
        import sqlite3
        db = sqlite3.connect(str(DEFAULT_AGENT / "agent.db"))
        for row in db.execute(
            "SELECT data FROM auth_credentials "
            "WHERE provider='opencode-go' AND credential_type='api_key' "
            "ORDER BY created_at DESC LIMIT 1"
        ):
            key = (json.loads(row[0]).get("key") or "").strip()
    except Exception:
        key = ""
    return {
        "baseUrl": "https://opencode.ai/zen/go/v1",
        "api": "openai-responses",
        "apiKey": key,
        "models": [{
            "id": "muse-spark-1.2",
            "name": "Muse Spark 1.2",
            "reasoning": True,
            "input": ["text"],
            "contextWindow": 1048576,
            "maxTokens": 131072,
            "thinking": {"mode": "effort",
                         "efforts": ["minimal", "low", "medium", "high", "xhigh"]},
        }],
    }


def inject_proxy_provider(agent: Path) -> None:
    mp = agent / "models.yml"
    m = yaml.safe_load(mp.read_text())
    m.setdefault("providers", {})["te-ocg"] = proxy_provider_entry()
    mp.write_text(yaml.safe_dump(m))
    try:
        os.chmod(mp, 0o600)
    except OSError:
        pass


def prepare_profile(cfg_root: str, shim: bool, instr: bool, instructions: str) -> Path:
    """Build a per-run config root under $HOME (PI_CONFIG_DIR is
    HOME-relative in omp 17.3.8). MCP servers load from the config root's
    agent/mcp.json, so this is the isolation unit instead of --profile."""
    dest = Path.home() / cfg_root
    if dest.exists():
        shutil.rmtree(dest)
    if TEMPLATE.is_dir():
        shutil.copytree(TEMPLATE, dest, ignore=shutil.ignore_patterns(
            "sessions", "logs", "terminal-sessions", "cache"))
    else:
        (dest / "agent").mkdir(parents=True)
    agent = dest / "agent"
    agent.mkdir(parents=True, exist_ok=True)
    # Config roots do not inherit default auth. Muse/OpenCode-Go keys live in
    # ~/.omp/agent/agent.db; copy them plus the model catalog.
    for name in ("agent.db", "agent.db-wal", "agent.db-shm", "models.yml", "models.db"):
        src = DEFAULT_AGENT / name
        if src.is_file():
            shutil.copy2(src, agent / name)
    inject_proxy_provider(agent)
    (agent / "mcp.json").write_text(json.dumps(mcp_payload(shim), indent=2) + "\n")
    append = agent / "APPEND_SYSTEM.md"
    body = instructions if instr else ""
    append.write_text(body)
    return dest


def prepare_workdir(run_id: str) -> Path:
    """Copy the mock bench so parallel omp processes do not share cwd."""
    dest = OUT / "work" / run_id
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(H.BENCH, dest)
    return dest


def mean(xs):
    return round(statistics.mean(xs), 1) if xs else None


def summarize(rows):
    by = {}
    for r in rows:
        key = (r["cell"], r["model"], r["prompt"], r.get("xdev", True))
        by.setdefault(key, []).append(r)
    lines = ["cell | model | prompt | xdev | n | adopt | bash_mean | input_mean | firstCache_mean | cold_n | turns_mean"]
    for key, rs in by.items():
        cell, model, prompt, xdev = key
        n = len(rs)
        adopt = sum(1 for r in rs if r["metrics"]["evolvedCalls"] > 0)
        lines.append(
            f"{cell} | {model} | {prompt} | {xdev} | {n} | {adopt}/{n} | "
            f"{mean([r['metrics']['bashCalls'] for r in rs])} | "
            f"{mean([r['metrics']['inputTokens'] for r in rs])} | "
            f"{mean([r['metrics']['firstCacheReadTokens'] for r in rs])} | "
            f"{sum(1 for r in rs if r['metrics']['coldCache'])}/{n} | "
            f"{mean([r['metrics']['turns'] for r in rs])}"
        )
    return "\n".join(lines)


def run_one(cell, shim, instr, prompt_name, model, rep, instructions, xdev=True):
    tag = "" if xdev else "-xdevfalse"
    run_id = f"{cell}{tag}-{model.replace('/', '_')}-r{rep}-{uuid.uuid4().hex[:8]}"
    # omp 17.3.8 ignores profile agent/mcp.json (MCP loads from the config
    # root agent dir only), so isolate per run via PI_CONFIG_DIR (resolved
    # HOME-relative) instead of --profile.
    cfg_root = f"tmp/te-omp-runs/cfg/{uuid.uuid4().hex[:12]}"
    prepare_profile(cfg_root, shim, instr, instructions)
    work = prepare_workdir(run_id)
    prompt_path = {"prompt4": PROMPT4, "prompt3": PROMPT3}.get(
        prompt_name, PROMPT5 if prompt_name == "prompt5" else PROMPT4Q)
    nonce = f"<!-- probe-nonce:{run_id} -->\n"
    prompt = nonce + prompt_path.read_text()
    OUT.mkdir(parents=True, exist_ok=True)
    out = OUT / f"{run_id}.jsonl"
    err = OUT / f"{run_id}.err"
    H.log(f"{run_id}: shim={shim} instr={instr} xdev={xdev} model={model}")
    t0 = time.time()
    env = dict(os.environ)
    env["PI_CONFIG_DIR"] = cfg_root
    overlay = None
    if not xdev:
        # Ship MCP tools top-level (first-class function schemas) instead of
        # xd:// on-demand devices.
        ov = yaml.safe_load(H.OVERLAY_YML.read_text())
        ov.setdefault("tools", {})["xdev"] = False
        overlay = Path.home() / cfg_root / "overlay.yml"
        overlay.write_text(yaml.safe_dump(ov))
    with open(out, "w") as fo, open(err, "w") as fe:
        p = subprocess.run(
            H.omp_argv(prompt, model=model, overlay=overlay),
            cwd=str(work), stdout=fo, stderr=fe, timeout=1500, env=env)
    dur = round(time.time() - t0, 1)
    m = H.run_metrics(out)
    m["wallSeconds"] = dur
    m["exitCode"] = p.returncode
    row = {
        "id": run_id, "cell": cell, "shim": shim, "instructions": instr,
        "xdev": xdev, "prompt": prompt_name, "model": model, "rep": rep,
        "profile": cfg_root, "workdir": str(work), "metrics": m,
    }
    (OUT / f"{run_id}.json").write_text(json.dumps(row, indent=2))
    H.log(f"{run_id}: exit={p.returncode} dur={dur}s evolved={m['evolvedCalls']} "
          f"bash={m['bashCalls']} in={m['inputTokens']} "
          f"firstCache={m['firstCacheReadTokens']} cold={m['coldCache']}")
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=3)
    ap.add_argument("--model", default="te-ocg/muse-spark-1.2")
    ap.add_argument("--replicate-model", default="",
                    help="Second model for the both-cell replication. Empty to skip.")
    ap.add_argument("--skip-hostile", action="store_true")
    ap.add_argument("--cells", default="ctrl,shim,instr,both",
                    help="Comma subset of factorial cell names")
    ap.add_argument("--jobs", type=int, default=12,
                    help="Parallel omp processes. Isolated via --profile + per-run cwd.")
    ap.add_argument("--xdev", choices=["true", "false"], default="true",
                    help="tools.xdev: true = MCP tools on-demand xd:// devices "
                         "(default); false = ship MCP schemas top-level as "
                         "first-class functions.")
    args = ap.parse_args()
    wanted = {c.strip() for c in args.cells.split(",") if c.strip()}
    xdev = args.xdev == "true"
    instructions = catalog_instructions()
    jobs = []
    for name, shim, instr, prompt in FACTORIAL:
        if name not in wanted:
            continue
        for rep in range(1, args.n + 1):
            jobs.append((name, shim, instr, prompt, args.model, rep, instructions, xdev))
    if not args.skip_hostile:
        for rep in range(1, args.n + 1):
            jobs.append(("hostile", True, True, "prompt3", args.model, rep, instructions, xdev))
    if args.replicate_model:
        for rep in range(1, args.n + 1):
            jobs.append(("both", True, True, "prompt4", args.replicate_model, rep, instructions, xdev))
    H.log(f"dispatch {len(jobs)} runs jobs={args.jobs}")
    rows = []
    workers = max(1, args.jobs)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = [pool.submit(run_one, *job) for job in jobs]
        for fut in as_completed(futs):
            rows.append(fut.result())
    rows.sort(key=lambda r: (r["cell"], r["model"], r["prompt"], r["rep"]))
    table = summarize(rows)
    (OUT / "summary.md").write_text(table + "\n")
    (OUT / "results.json").write_text(json.dumps(rows, indent=2))
    print(table)
    H.log("PROBE COMPLETE")


if __name__ == "__main__":
    main()
