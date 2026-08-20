#!/usr/bin/env python3
"""Factorial adoption probe (shim × instructions) with cold prompt-cache.

omp 17.3.8 has no --no-cache. Isolation:
  * unique --profile per run (local caches; OMP_HOME is ignored)
  * --config omp_overlay.yml  (providers.cacheRetention: none)
  * --no-session
  * unique HTML-comment nonce prefix on the user prompt

Does not patch ~/.omp/agent. Does not call `omp models` (hangs).
Writes artifacts under /tmp/te-omp-runs/e2e/probe/.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import statistics
import sys
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import harness as H  # noqa: E402

REPO = HERE.parent.parent
SHIM = HERE / "evolved-mcp-server.mjs"
OUT = Path("/tmp/te-omp-runs/e2e/probe")
PROMPT4 = Path("/tmp/te-omp-bench2-prompt4.txt")
PROMPT3 = Path("/tmp/te-omp-bench2-prompt3.txt")
TEMPLATE = Path(os.path.expanduser("~/.omp/profiles/te-spark-e2e"))
PROFILES_ROOT = Path(os.path.expanduser("~/.omp/profiles"))
SERVER = "tool-evolver-gateway"
TOOL = "git_operation_helper"
XD = f"xd://mcp__{SERVER.replace('-', '_')}_{TOOL}"

FACTORIAL = [
    ("ctrl", False, False, "prompt4"),
    ("shim", True, False, "prompt4"),
    ("instr", False, True, "prompt4"),
    ("both", True, True, "prompt4"),
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


def catalog_instructions() -> str:
    st, body = H.req("GET", "/v1/evolution/catalog/instructions", headers={
        "Content-Type": "application/json",
        "x-account-id": "acc-e2e-d3probe",
        "x-workspace-id": "ws-e2e-d3probe",
    })
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
        return block
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


def prepare_profile(name: str, shim: bool, instr: bool, instructions: str) -> Path:
    dest = PROFILES_ROOT / name
    if dest.exists():
        shutil.rmtree(dest)
    if TEMPLATE.is_dir():
        shutil.copytree(TEMPLATE, dest, ignore=shutil.ignore_patterns(
            "sessions", "logs", "terminal-sessions", "agent.db*", "cache"))
    else:
        (dest / "agent").mkdir(parents=True)
    agent = dest / "agent"
    agent.mkdir(parents=True, exist_ok=True)
    (agent / "mcp.json").write_text(json.dumps(mcp_payload(shim), indent=2) + "\n")
    append = agent / "APPEND_SYSTEM.md"
    body = instructions if instr else ""
    append.write_text(body)
    return dest


def mean(xs):
    return round(statistics.mean(xs), 1) if xs else None


def summarize(rows):
    by = {}
    for r in rows:
        key = (r["cell"], r["model"], r["prompt"])
        by.setdefault(key, []).append(r)
    lines = ["cell | model | prompt | n | adopt | bash_mean | input_mean | firstCache_mean | cold_n | turns_mean"]
    for key, rs in by.items():
        cell, model, prompt = key
        n = len(rs)
        adopt = sum(1 for r in rs if r["metrics"]["evolvedCalls"] > 0)
        lines.append(
            f"{cell} | {model} | {prompt} | {n} | {adopt}/{n} | "
            f"{mean([r['metrics']['bashCalls'] for r in rs])} | "
            f"{mean([r['metrics']['inputTokens'] for r in rs])} | "
            f"{mean([r['metrics']['firstCacheReadTokens'] for r in rs])} | "
            f"{sum(1 for r in rs if r['metrics']['coldCache'])}/{n} | "
            f"{mean([r['metrics']['turns'] for r in rs])}"
        )
    return "\n".join(lines)


def run_one(cell, shim, instr, prompt_name, model, rep, instructions):
    run_id = f"{cell}-{model.replace('/', '_')}-r{rep}-{uuid.uuid4().hex[:8]}"
    profile = f"te-probe-{run_id}"
    prepare_profile(profile, shim, instr, instructions)
    prompt_path = PROMPT4 if prompt_name == "prompt4" else PROMPT3
    nonce = f"<!-- probe-nonce:{run_id} -->\n"
    prompt = nonce + prompt_path.read_text()
    OUT.mkdir(parents=True, exist_ok=True)
    out = OUT / f"{run_id}.jsonl"
    err = OUT / f"{run_id}.err"
    H.log(f"{run_id}: shim={shim} instr={instr} model={model}")
    t0 = time.time()
    import subprocess
    with open(out, "w") as fo, open(err, "w") as fe:
        p = subprocess.run(
            H.omp_argv(prompt, model=model, profile=profile),
            cwd=H.BENCH, stdout=fo, stderr=fe, timeout=1500)
    dur = round(time.time() - t0, 1)
    m = H.run_metrics(out)
    m["wallSeconds"] = dur
    m["exitCode"] = p.returncode
    row = {
        "id": run_id, "cell": cell, "shim": shim, "instructions": instr,
        "prompt": prompt_name, "model": model, "rep": rep,
        "profile": profile, "metrics": m,
    }
    (OUT / f"{run_id}.json").write_text(json.dumps(row, indent=2))
    H.log(f"{run_id}: exit={p.returncode} dur={dur}s evolved={m['evolvedCalls']} "
          f"bash={m['bashCalls']} in={m['inputTokens']} "
          f"firstCache={m['firstCacheReadTokens']} cold={m['coldCache']}")
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=3)
    ap.add_argument("--model", default="gemini-3.7-flash")
    ap.add_argument("--replicate-model", default="gpt-5-mini",
                    help="Second model for the both-cell replication. Empty to skip.")
    ap.add_argument("--skip-hostile", action="store_true")
    ap.add_argument("--cells", default="ctrl,shim,instr,both",
                    help="Comma subset of factorial cell names")
    args = ap.parse_args()
    wanted = {c.strip() for c in args.cells.split(",") if c.strip()}
    instructions = catalog_instructions()
    rows = []
    for name, shim, instr, prompt in FACTORIAL:
        if name not in wanted:
            continue
        for rep in range(1, args.n + 1):
            rows.append(run_one(name, shim, instr, prompt, args.model, rep, instructions))
    if not args.skip_hostile:
        for rep in range(1, args.n + 1):
            rows.append(run_one("hostile", True, True, "prompt3", args.model, rep, instructions))
    if args.replicate_model:
        for rep in range(1, args.n + 1):
            rows.append(run_one("both", True, True, "prompt4", args.replicate_model, rep, instructions))
    table = summarize(rows)
    (OUT / "summary.md").write_text(table + "\n")
    (OUT / "results.json").write_text(json.dumps(rows, indent=2))
    print(table)
    H.log("PROBE COMPLETE")


if __name__ == "__main__":
    main()
