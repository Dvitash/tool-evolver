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

Production mode (--production): 4 cells x 4 workloads x 5 sequential cache
blocks (80 measured runs), cacheRetention:long, wave/block scheduler,
AUDIT_RESULT gate, provenance lock, and aggregate/per-workload reports
under /tmp/te-omp-runs/prod/. Default CLI remains the n=6-compatible probe.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import re
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

PRIMARY_CELLS = ("ctrl", "shim4q", "shim", "both")
PROD_OUT = Path("/tmp/te-omp-runs/prod")
PROD_PROBE_ARCHIVE = Path("/tmp/te-omp-runs/e2e/probe")
FIXTURE_ROOT = Path("/tmp/te-omp-fixtures")
WORKLOADS = (8, 12, 16, 24)
WORKLOAD_LABELS = {8: "tiny-8", 12: "small-12", 16: "medium-16", 24: "large-24"}
PROD_REPS = 5
BOOTSTRAP_SEED = 20260820
BOOTSTRAP_B = 10000
PROD_PROMPT_DIR = PROD_OUT / "prompts"
PROD_OVERLAY = """providers:
  cacheRetention: long
compaction:
  enabled: false
  midTurnEnabled: false
  remoteEnabled: false
memory:
  backend: "off"
autolearn:
  enabled: false
advisor:
  enabled: false
github:
  cache:
    enabled: false
"""


def fallback_instructions() -> str:
    md = (
        f"### `{TOOL}`\n\n"
        "Runs the observed git/module audit workflow in one call. "
        "Use the evolved tool before running individual git, wc, or grep commands — prefer this over separate bash git/wc/grep commands.\n"
    )
    return (
        "<!-- tool-evolver:catalog:start -->\n\n"
        f"{md}\n"
        "These tools are exposed over MCP. Invoke them through the `xd://` "
        "tool-device surface rather than re-running the underlying shell "
        "commands manually. Use the evolved tool before running individual git, wc, or grep commands.\n\n"
        f"#### Invocation: `{TOOL}`\n"
        f"- **Invoke**: write the JSON arguments to `{XD}` "
        f"(e.g. `write` `{{\"path\": \"{XD}\", \"content\": \"{{}}\"}}` "
        "when the tool takes no inputs).\n"
        f"- **Docs**: `read` `{XD}` returns the tool's documentation.\n"
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


def catalog_instructions(fail_closed: bool = False) -> str:
    st, body = H.req("GET", "/v1/evolution/catalog/instructions", headers=catalog_headers())
    if st == 200 and isinstance(body, dict):
        md = body.get("markdown") or body.get("instructionsMarkdown") or ""
        if md:
            # Backend returns only markdown; parse tool names from ### `name` headings
            names = re.findall(r"^### `([^`]+)`$", md, flags=re.MULTILINE)
            if fail_closed and TOOL not in names:
                raise SystemExit(
                    f"catalog instructions missing required tool {TOOL}: {names}"
                )
            if not names:
                names = [TOOL]
            return (
                "<!-- tool-evolver:catalog:start -->\n\n"
                f"{md.strip()}\n\n"
                "These tools are exposed over MCP. Invoke them through the "
                "`xd://` tool-device surface rather than re-running the underlying shell "
                "commands manually. Use the evolved tool before running individual git, wc, or grep commands.\n\n"
                + "".join(
                    f"#### Invocation: `{n}`\n"
                    f"- **Invoke**: write the JSON arguments to "
                    f"`xd://mcp__{SERVER.replace('-', '_')}_{n}` "
                    f"(e.g. `write` `{{\"path\": \"xd://mcp__{SERVER.replace('-', '_')}_{n}\", \"content\": \"{{}}\"}}` "
                    "when the tool takes no inputs).\n"
                    f"- **Docs**: `read` `xd://mcp__{SERVER.replace('-', '_')}_{n}` returns the tool's documentation.\n\n"
                    for n in names
                )
                + "<!-- tool-evolver:catalog:end -->\n"
            )
    if fail_closed:
        raise SystemExit(f"catalog instructions unavailable: status={st} body={body}")
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


def tool_provenance() -> dict | None:
    if not H.MANIFEST.is_file():
        return None
    manifest_bytes = H.MANIFEST.read_bytes()
    manifest = json.loads(manifest_bytes)
    entry = next(
        (item for item in manifest.get("tools", []) if item.get("name") == TOOL),
        None,
    )
    if not entry:
        return None
    source_path = Path(entry.get("file", ""))
    source_digest = (
        hashlib.sha256(source_path.read_bytes()).hexdigest()
        if source_path.is_file()
        else None
    )
    return {
        "candidateId": entry.get("candidateId"),
        "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "sourceSha256": source_digest,
        "sourcePath": str(source_path) if source_path else None,
        "catalogWorkspaceId": catalog_headers().get("x-workspace-id"),
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

    Model note (2026-08-20): opencode-go's catalog exposes ONLY
    ``muse-spark-1.2-contributor`` (openai-responses, 1M context). The
    bare ``muse-spark-1.2`` id is NOT a real gateway model — requesting it
    returns 401 ``Model muse-spark-1.2 is not supported`` and omp falls
    back to cursor/cursor-grok which reports input:0. This entry therefore
    exposes the contributor model as the default te-ocg model; the vanilla
    id is NOT exposed here — requesting it 401s and omp would silently
    fall back to cursor/cursor-grok. Using the bare id fails loudly at
    config load instead. Prefer ``te-ocg/muse-spark-1.2-contributor``
    for real inputTokens.
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
            "id": "muse-spark-1.2-contributor",
            "name": "Muse Spark 1.2 Contributor",
            "reasoning": True,
            "input": ["text", "image"],
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


def prepare_profile(cfg_root: str, shim: bool, instr: bool, instructions: str, reuse: bool = False) -> Path:
    """Build a per-run config root under $HOME (PI_CONFIG_DIR is
    HOME-relative in omp 17.3.8). MCP servers load from the config root's
    agent/mcp.json, so this is the isolation unit instead of --profile."""
    dest = Path.home() / cfg_root
    if dest.exists():
        if reuse:
            agent = dest / "agent"
            expected_mcp = mcp_payload(shim)
            try:
                actual_mcp = json.loads((agent / "mcp.json").read_text())
                actual_append = (agent / "APPEND_SYSTEM.md").read_text()
            except Exception as exc:
                raise RuntimeError(
                    f"cannot validate reused profile {cfg_root}: {exc}"
                ) from exc
            expected_append = instructions if instr else ""
            if actual_mcp != expected_mcp or actual_append != expected_append:
                raise RuntimeError(f"reused profile treatment drifted: {cfg_root}")
            return dest
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
    # Pin the default model role in the copied config so omp's retry
    # fallback retries te-ocg instead of silently substituting
    # cursor/grok (observed: te-ocg 401 -> retry_fallback_applied ->
    # cursor-grok-4.6 ran the whole audit, contaminating results).
    cfg = agent / "config.yml"
    if cfg.is_file():
        try:
            cc = yaml.safe_load(cfg.read_text())
            roles = cc.setdefault("modelRoles", {})
            roles["default"] = "te-ocg/muse-spark-1.2-contributor:high"
            cfg.write_text(yaml.safe_dump(cc))
        except Exception:
            pass
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
    lines = ["cell | model | prompt | xdev | n | attempt | adopt | bash_mean | input_mean | firstCache_mean | cold_n | turns_mean | wall_mean | toolTime_mean | evolvedTime_mean"]
    for key, rs in by.items():
        cell, model, prompt, xdev = key
        n = len(rs)
        adopt = sum(1 for r in rs if r["metrics"]["evolvedCalls"] > 0)
        attempts = sum(
            1 for r in rs if r["metrics"].get("evolvedAttempts", 0) > 0
        )
        lines.append(
            f"{cell} | {model} | {prompt} | {xdev} | {n} | "
            f"{attempts}/{n} | {adopt}/{n} | "
            f"{mean([r['metrics']['bashCalls'] for r in rs])} | "
            f"{mean([r['metrics']['inputTokens'] for r in rs])} | "
            f"{mean([r['metrics']['firstCacheReadTokens'] for r in rs])} | "
            f"{sum(1 for r in rs if r['metrics']['coldCache'])}/{n} | "
            f"{mean([r['metrics']['turns'] for r in rs])} | "
            f"{mean([r['metrics'].get('wallSeconds') for r in rs if r['metrics'].get('wallSeconds') is not None])} | "
            f"{mean([r['metrics'].get('toolTimeSeconds', 0) for r in rs])} | "
            f"{mean([r['metrics'].get('evolvedTimeSeconds', 0) for r in rs])}"
        )
    return "\n".join(lines)


def _percent_savings(baseline, treatment):
    if baseline is None or treatment is None or baseline == 0:
        return None
    return 100.0 * (baseline - treatment) / baseline


def _cohort_means(rows, cell, model, prompt, xdev, prices):
    all_rows = [
        r for r in rows
        if r["cell"] == cell
        and r["model"] == model
        and r["prompt"] == prompt
        and r.get("xdev", True) == xdev
    ]
    successful = [
        r for r in all_rows
        if r["metrics"].get("exitCode") == 0
        and r["metrics"].get("isComplete") is not False
        and not r["metrics"].get("provenanceDrift")
    ]
    token_rows = [
        r for r in successful
        if not r["metrics"].get("inputTokensIsEstimated")
        and not r["metrics"].get("fallbackModel")
        and not r["metrics"].get("usageTokensIncomplete")
    ]

    def average(source, metric):
        values = [r["metrics"].get(metric) for r in source]
        values = [value for value in values if value is not None]
        return statistics.mean(values) if values else None

    def average_derived(source, derive):
        values = [derive(r["metrics"]) for r in source]
        values = [value for value in values if value is not None]
        return statistics.mean(values) if values else None

    return {
        "bashCalls": average(successful, "bashCalls"),
        "turns": average(successful, "turns"),
        "wallSeconds": average(successful, "wallSeconds"),
        "inputTokens": average(token_rows, "inputTokens"),
        "outputTokens": average(token_rows, "outputTokens"),
        "cacheReadTokens": average(token_rows, "cacheReadTokens"),
        "totalObservedTokens": average_derived(
            token_rows,
            lambda m: (
                (m.get("inputTokens") or 0)
                + (m.get("outputTokens") or 0)
                + (m.get("cacheReadTokens") or 0)
            ),
        ),
        "costDollars": average_derived(
            token_rows,
            lambda m: (
                (m.get("inputTokens") or 0) * prices["in"]
                + (m.get("outputTokens") or 0) * prices["out"]
                + (m.get("cacheReadTokens") or 0) * prices["cache"]
            ) / 1_000_000,
        ),
        "n_total": len(all_rows),
        "n": len(successful),
        "n_failed": len(all_rows) - len(successful),
        "n_token": len(token_rows),
    }


def _format(value, digits=1):
    return "n/a" if value is None else f"{value:.{digits}f}"


def savings_table(rows, prices=None):
    prices = prices or {"in": 1.0, "out": 4.0, "cache": 0.25}
    comparisons = [
        ("availability", "ctrl", "prompt5", "shim", "prompt5"),
        ("instructions_only", "ctrl", "prompt5", "instr", "prompt5"),
        ("deployed", "ctrl", "prompt5", "both", "prompt5"),
        ("user_nudge", "shim4q", "prompt4q", "shim", "prompt5"),
        ("catalog_instructions", "shim", "prompt5", "both", "prompt5"),
    ]
    metrics = [
        "bashCalls", "turns", "wallSeconds", "inputTokens", "outputTokens",
        "cacheReadTokens", "totalObservedTokens", "costDollars",
    ]
    model_xdev = sorted({(r["model"], r.get("xdev", True)) for r in rows})
    lines = [
        "| effect | model | xdev | baseline | treatment | bash_savings | "
        "turns_savings | wall_savings | input_savings | output_savings | "
        "cache_read_savings | total_token_savings | dollar_savings | "
        "baseline_ok/total | treatment_ok/total | baseline_token | treatment_token |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for effect, base_cell, base_prompt, treat_cell, treat_prompt in comparisons:
        for model, xdev in model_xdev:
            base = _cohort_means(
                rows, base_cell, model, base_prompt, xdev, prices
            )
            treatment = _cohort_means(
                rows, treat_cell, model, treat_prompt, xdev, prices
            )
            if not base["n_total"] or not treatment["n_total"]:
                continue
            values = [
                _percent_savings(base[metric], treatment[metric])
                for metric in metrics
            ]
            savings = [
                "n/a" if value is None else f"{value:.1f}%" for value in values
            ]
            lines.append(
                f"| {effect} | {model} | {xdev} | "
                f"{base_cell}/{base_prompt} | {treat_cell}/{treat_prompt} | "
                f"{' | '.join(savings)} | "
                f"{base['n']}/{base['n_total']} | "
                f"{treatment['n']}/{treatment['n_total']} | "
                f"{base['n_token']} | {treatment['n_token']} |"
            )

    lines.extend([
        "",
        "Cohort means:",
        "| cell | model | prompt | xdev | bash | turns | wall | input | output | "
        "cache_read | total_tokens | dollar_cost | ok/total | failed | token_n |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ])
    cohort_keys = sorted({
        (r["cell"], r["model"], r["prompt"], r.get("xdev", True))
        for r in rows
    })
    for cell, model, prompt, xdev in cohort_keys:
        values = _cohort_means(rows, cell, model, prompt, xdev, prices)
        lines.append(
            f"| {cell} | {model} | {prompt} | {xdev} | "
            f"{_format(values['bashCalls'])} | {_format(values['turns'])} | "
            f"{_format(values['wallSeconds'])} | {_format(values['inputTokens'])} | "
            f"{_format(values['outputTokens'])} | "
            f"{_format(values['cacheReadTokens'])} | "
            f"{_format(values['totalObservedTokens'])} | "
            f"{_format(values['costDollars'], 4)} | "
            f"{values['n']}/{values['n_total']} | {values['n_failed']} | "
            f"{values['n_token']} |"
        )
    lines.extend([
        "",
        "Savings = 100 × (baseline mean − treatment mean) / baseline mean.",
        "Dollar cost uses the configured per-million input/output/cache-read prices.",
        "All means exclude failed runs. Token means also exclude estimated or fallback runs.",
    ])
    return "\n".join(lines)



def _lorem_line(rng: random.Random, n_words: int) -> str:
    words = [
        "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf",
        "hotel", "india", "juliet", "kilo", "lima", "module", "audit",
        "status", "commit", "branch", "todo", "metric", "workflow",
        "cache", "token", "count", "bytes", "lines", "words", "head",
        "tail", "diff", "stat",
    ]
    return " ".join(rng.choice(words) for _ in range(n_words))


def _prompt_body(n: int, workdir: str, nudge: bool) -> str:
    label = WORKLOAD_LABELS.get(n, f"w{n}")
    last = f"module_{n:02d}.txt"
    body = (
        f"Work in the mock project at {workdir} [{label}] (a git repository with {n} "
        f"modules: module_01.txt through {last}). Perform this audit exactly, "
        "in order. Every requested value must stay individually attributable "
        "— labeled per module and per metric. If a tool or command returns "
        "several clearly-labeled values in one call, that is acceptable.\n\n"
        "Phase 1 — Repo snapshot:\n"
        "1. Show the last 5 commits in oneline form.\n"
        "2. Show the working tree status in porcelain form.\n"
        "3. Show the diff stat of the most recent commit.\n"
        "4. List all branches.\n"
        "5. Show the current HEAD commit hash.\n\n"
        f"Phase 2 — Per-module metrics: for EACH module file module_01.txt "
        f"through {last}, in order:\n"
        "- line count\n- word count\n- byte size\n- count of TODO markers\n"
        "- the first line of the file\n- the last line of the file\n\n"
        f"Phase 3 — Full read: read the COMPLETE content of every module file, "
        f"module_01.txt through {last}, without truncating or summarizing. "
        "These files are large; read them fully in pages if your read tool "
        "paginates.\n\n"
        "Phase 4 — Repo snapshot again:\n"
        "1. Last 5 commits in oneline form.\n"
        "2. Working tree status in porcelain form.\n"
        "3. Diff stat of the most recent commit.\n"
        "4. Branch list.\n"
        "5. HEAD commit hash.\n\n"
        "Phase 5 — Report: a per-module table with all six metrics, totals "
        "for lines/words/bytes/TODOs, which files are modified or untracked, "
        "and the last 5 commit subjects.\n\n"
        "End with exactly one machine-parseable line of the form:\n"
        "AUDIT_RESULT {\"nModules\": N, \"totalLines\": L, \"totalTodos\": T, "
        "\"gitSubjects\": [s1,s2,s3,s4,s5], \"perModule\": "
        "[{\"file\":\"module_01.txt\",\"lines\":n,\"todos\":t}, ...]}\n\n"
        "Begin the audit now?\n"
    )
    if nudge:
        body += (
            "\nTool-use note: the system prompt lists additional tools as "
            "`xd://` devices (names like `xd://mcp__...`). If one of those "
            "tools can gather several requested values in a single call, "
            "prefer it: first `read` its docs path, then invoke it by writing "
            "your JSON arguments to that `xd://` path with the `write` tool. "
            "Otherwise use `bash`/`read` as usual.\nBegin?\n"
        )
    return body


def ensure_workload_fixture(n: int) -> Path:
    """Deterministic git fixture with n root module_*.txt files."""
    dest = FIXTURE_ROOT / f"w{n}"
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    rng = random.Random(0x5445 + n)
    env = dict(os.environ)
    env.update({
        "GIT_AUTHOR_NAME": "te-e2e",
        "GIT_AUTHOR_EMAIL": "te-e2e@local",
        "GIT_COMMITTER_NAME": "te-e2e",
        "GIT_COMMITTER_EMAIL": "te-e2e@local",
        "GIT_AUTHOR_DATE": "2026-01-01T00:00:00",
        "GIT_COMMITTER_DATE": "2026-01-01T00:00:00",
    })
    subprocess.run(["git", "init", "-b", "main"], cwd=dest, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["git", "config", "user.email", "te-e2e@local"], cwd=dest, check=True)
    subprocess.run(["git", "config", "user.name", "te-e2e"], cwd=dest, check=True)
    subprocess.run(["git", "config", "core.autocrlf", "false"], cwd=dest, check=True)
    (dest / "README.txt").write_text(f"te-e2e fixture w{n} modules={n}\n")
    subprocess.run(["git", "add", "README.txt"], cwd=dest, check=True)
    env["GIT_AUTHOR_DATE"] = "2026-01-01T00:00:00"
    env["GIT_COMMITTER_DATE"] = env["GIT_AUTHOR_DATE"]
    subprocess.run(["git", "commit", "-m", "init"], cwd=dest, check=True, env=env,
                   stdout=subprocess.DEVNULL)
    for i in range(1, n + 1):
        n_lines = 80 + (n * 4) + (i * 3)
        lines = []
        for ln in range(n_lines):
            if rng.random() < 0.04:
                lines.append(f"TODO {i:02d}-{ln:04d} {_lorem_line(rng, 6)}")
            else:
                lines.append(_lorem_line(rng, rng.randint(6, 9)))
        (dest / f"module_{i:02d}.txt").write_text("\n".join(lines) + "\n")
    subprocess.run(["git", "add", "."], cwd=dest, check=True)
    env["GIT_AUTHOR_DATE"] = "2026-01-02T00:00:00"
    env["GIT_COMMITTER_DATE"] = env["GIT_AUTHOR_DATE"]
    subprocess.run(["git", "commit", "-m", "work"], cwd=dest, check=True, env=env,
                   stdout=subprocess.DEVNULL)
    for k, msg in enumerate(("iter0", "iter1", "iter2"), start=3):
        target = dest / f"module_{((k % n) + 1):02d}.txt"
        with target.open("a") as fh:
            fh.write(f"# {msg}\n")
        subprocess.run(["git", "add", "-u"], cwd=dest, check=True)
        env["GIT_AUTHOR_DATE"] = f"2026-01-0{k}T00:00:00"
        env["GIT_COMMITTER_DATE"] = env["GIT_AUTHOR_DATE"]
        subprocess.run(["git", "commit", "-m", msg], cwd=dest, check=True, env=env,
                       stdout=subprocess.DEVNULL)
    notes = dest / f"notes_w{n}.txt"
    notes.write_text(f"untracked notes for w{n}\n")
    dirty = dest / "module_01.txt"
    with dirty.open("a") as fh:
        fh.write("# dirty line\n")
    return dest




def write_block_prompt(cell: str, workload: int, workdir: str, prompt_name: str, git_head: str) -> Path:
    PROD_PROMPT_DIR.mkdir(parents=True, exist_ok=True)
    p = PROD_PROMPT_DIR / f"{cell}-w{workload}.txt"
    nudge = prompt_name == "prompt5"
    body = _prompt_body(workload, workdir, nudge=nudge)
    nonce = block_nonce(cell, workload, git_head)
    p.write_text(nonce + body)
    return p


def block_id(cell: str, workload: int) -> str:
    return f"{cell}-w{workload}"


def block_cfg_root(cell: str, workload: int) -> str:
    return f"tmp/te-omp-runs/prod/cfg/{block_id(cell, workload)}"


def block_workdir(cell: str, workload: int) -> Path:
    return PROD_OUT / "work" / block_id(cell, workload)


def block_nonce(cell: str, workload: int, fixture_sha: str) -> str:
    h = hashlib.sha256(f"{cell}|{workload}|{fixture_sha}".encode()).hexdigest()[:16]
    return f"<!-- probe-nonce:block-{block_id(cell, workload)}-{h} -->\n"


def snapshot_file_sha(path: Path) -> str:
    if not path.is_file():
        return ""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fixture_git_head(path: Path) -> str:
    p = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=path, capture_output=True, text=True
    )
    return (p.stdout or "").strip()


def fixture_git_porcelain(path: Path) -> str:
    p = subprocess.run(
        ["git", "status", "--porcelain"], cwd=path, capture_output=True, text=True
    )
    return (p.stdout or "").strip()


def compute_workload_truth(work: Path) -> dict:
    files = sorted(work.glob("module_*.txt"))
    per = []
    total_lines = 0
    total_todos = 0
    line_counts = {}
    todo_counts = {}
    for f in files:
        txt = f.read_text(errors="ignore")
        ls = txt.splitlines()
        lc = len(ls)
        # also count wc -l style (file ends with newline => lines count as wc -l)
        # Use wc-consistent count: number of lines with trailing newline counts correctly;
        # our ls length already matches wc -l because each file ends with newline
        tc = sum(1 for line in ls if "TODO" in line)
        per.append({"file": f.name, "lines": lc, "todos": tc})
        line_counts[f.name] = lc
        todo_counts[f.name] = tc
        total_lines += lc
        total_todos += tc
    # git subjects
    p = subprocess.run(["git", "log", "--oneline", "-5", "--pretty=format:%s"], cwd=work, capture_output=True, text=True)
    subjects = [s.strip() for s in (p.stdout or "").splitlines() if s.strip()]
    # also need full oneline with hash for smoke? but subjects only
    # porcelain
    porcelain = fixture_git_porcelain(work)
    # head
    head = fixture_git_head(work)
    return {
        "nModules": len(files),
        "totalLines": total_lines,
        "totalTodos": total_todos,
        "perModule": per,
        "line_counts": line_counts,
        "todo_counts": todo_counts,
        "gitSubjects": subjects,
        "gitPorcelain": porcelain,
        "gitHead": head,
        "orderedFiles": [f.name for f in files],
    }


def lock_provenance(workloads: dict[int, Path], instructions: str) -> dict:
    tp = tool_provenance() or {}
    # fail closed if any required provenance missing
    for k in ("candidateId", "manifestSha256", "sourceSha256", "sourcePath", "catalogWorkspaceId"):
        if not tp.get(k):
            raise SystemExit(f"provenance lock failed: missing {k}: {tp}")
    instructions_sha = hashlib.sha256(instructions.encode()).hexdigest()
    lock = {
        "model": "te-ocg/muse-spark-1.2-contributor",
        "xdev": True,
        "cells": list(PRIMARY_CELLS),
        "workloads": list(WORKLOADS),
        "reps": PROD_REPS,
        "manifestPath": str(H.MANIFEST),
        "manifestSha256": tp.get("manifestSha256"),
        "sourceSha256": tp.get("sourceSha256"),
        "sourcePath": tp.get("sourcePath"),
        "candidateId": tp.get("candidateId"),
        "catalogWorkspaceId": tp.get("catalogWorkspaceId"),
        "instructionsSha256": instructions_sha,
        "fixtures": {},
    }
    for n, src in workloads.items():
        truth = compute_workload_truth(src)
        lock["fixtures"][str(n)] = {
            "path": str(src),
            "gitHead": truth["gitHead"],
            "nModules": truth["nModules"],
            "moduleSha256": {f.name: snapshot_file_sha(f) for f in sorted(src.glob("module_*.txt"))},
            "gitPorcelain": truth["gitPorcelain"],
            "totalLines": truth["totalLines"],
            "totalTodos": truth["totalTodos"],
            "gitSubjects": truth["gitSubjects"],
            "orderedFiles": truth["orderedFiles"],
            "line_counts": truth["line_counts"],
            "todo_counts": truth["todo_counts"],
        }
    PROD_OUT.mkdir(parents=True, exist_ok=True)
    (PROD_OUT / "provenance.lock.json").write_text(json.dumps(lock, indent=2) + "\n")
    return lock


def live_provenance(lock: dict, workload: int, work: Path) -> tuple[dict, bool, str]:
    tp = tool_provenance() or {}
    truth = compute_workload_truth(work)
    live = {
        "manifestSha256": tp.get("manifestSha256"),
        "sourceSha256": tp.get("sourceSha256"),
        "sourcePath": tp.get("sourcePath"),
        "candidateId": tp.get("candidateId"),
        "catalogWorkspaceId": tp.get("catalogWorkspaceId"),
        "workdir": str(work),
        "gitHead": truth["gitHead"],
        "gitPorcelain": truth["gitPorcelain"],
        "nModules": truth["nModules"],
        "totalLines": truth["totalLines"],
        "totalTodos": truth["totalTodos"],
        "gitSubjects": truth["gitSubjects"],
        "orderedFiles": truth["orderedFiles"],
        "moduleSha256": {
            f.name: snapshot_file_sha(f)
            for f in sorted(work.glob("module_*.txt"))
        },
    }
    reasons = []
    for key in (
        "manifestSha256", "sourceSha256", "candidateId",
        "catalogWorkspaceId", "sourcePath",
    ):
        if live.get(key) != lock.get(key):
            reasons.append(f"{key} drifted")
    expected = (lock.get("fixtures") or {}).get(str(workload), {})
    if live["gitHead"] != expected.get("gitHead"):
        reasons.append("workspace gitHead drifted")
    if live["nModules"] != expected.get("nModules"):
        reasons.append("module count drifted")
    if live["totalLines"] != expected.get("totalLines"):
        reasons.append("total lines drifted")
    if live["totalTodos"] != expected.get("totalTodos"):
        reasons.append("total TODOs drifted")
    if live["gitSubjects"] != expected.get("gitSubjects"):
        reasons.append("git subjects drifted")
    if live["orderedFiles"] != expected.get("orderedFiles"):
        reasons.append("ordered module files drifted")
    if live["moduleSha256"] != (expected.get("moduleSha256") or {}):
        reasons.append("module SHA256 drifted")
    if live["gitPorcelain"] != expected.get("gitPorcelain"):
        reasons.append("git porcelain drifted")
    return live, bool(reasons), "; ".join(reasons)


def parse_audit_result(metrics: dict, transcript: Path,
                       expected: dict | None = None) -> dict:
    texts = []
    try:
        for line in open(transcript):
            try:
                je = json.loads(line)
            except Exception:
                continue
            if je.get("type") != "message_end":
                continue
            msg = je.get("message") or {}
            role = msg.get("role") or je.get("role")
            if role and role != "assistant":
                continue
            content = msg.get("content") or msg.get("text") or ""
            if isinstance(content, list):
                parts = []
                for part in content:
                    if isinstance(part, dict):
                        parts.append(str(part.get("text") or part.get("content") or ""))
                    else:
                        parts.append(str(part))
                content = "\n".join(parts)
            if content:
                texts.append(str(content))
    except FileNotFoundError:
        pass
    blob = "\n".join(texts)
    # Inspect exactly one single line beginning AUDIT_RESULT
    lines = blob.splitlines()
    audit_lines = [line for line in lines if line.startswith("AUDIT_RESULT")]
    present = len(audit_lines) > 0
    parsed = None
    errors: list[str] = []
    if len(audit_lines) == 0:
        errors.append("missing AUDIT_RESULT line")
    elif len(audit_lines) != 1:
        errors.append(f"expected exactly one AUDIT_RESULT line, found {len(audit_lines)}")
    else:
        line = audit_lines[0]
        # parse only JSON remainder after AUDIT_RESULT prefix
        idx = line.index("AUDIT_RESULT") + len("AUDIT_RESULT")
        remainder = line[idx:].strip()
        if not remainder.startswith("{"):
            errors.append("AUDIT_RESULT remainder not JSON object")
        else:
            try:
                parsed = json.loads(remainder)
            except json.JSONDecodeError as e:
                errors.append(f"AUDIT_RESULT JSON parse failed: {e}")
                parsed = None
    if parsed is not None and expected is not None:
        if parsed.get("nModules") != expected["nModules"]:
            errors.append(
                f"nModules mismatch: got {parsed.get('nModules')} "
                f"expected {expected['nModules']}"
            )
        if parsed.get("totalLines") != expected["totalLines"]:
            errors.append(
                f"totalLines mismatch: got {parsed.get('totalLines')} "
                f"expected {expected['totalLines']}"
            )
        if parsed.get("totalTodos") != expected["totalTodos"]:
            errors.append(
                f"totalTodos mismatch: got {parsed.get('totalTodos')} "
                f"expected {expected['totalTodos']}"
            )
        subjects = parsed.get("gitSubjects")
        if subjects != expected["gitSubjects"]:
            errors.append(
                f"gitSubjects mismatch: got {subjects} "
                f"expected {expected['gitSubjects']}"
            )
        modules = parsed.get("perModule")
        if not isinstance(modules, list) or len(modules) != expected["nModules"]:
            errors.append("perModule length mismatch")
        else:
            for index, entry in enumerate(modules):
                if not isinstance(entry, dict):
                    errors.append(f"perModule[{index}] is not an object")
                    continue
                expected_file = expected["orderedFiles"][index]
                filename = entry.get("file")
                if filename != expected_file:
                    errors.append(
                        f"perModule[{index}] file mismatch: got {filename} "
                        f"expected {expected_file}"
                    )
                    continue
                if entry.get("lines") != expected["line_counts"][filename]:
                    errors.append(f"perModule {filename} lines mismatch")
                if entry.get("todos") != expected["todo_counts"][filename]:
                    errors.append(f"perModule {filename} todos mismatch")
    elif parsed is not None:
        if not (
            isinstance(parsed.get("nModules"), int)
            and isinstance(parsed.get("totalLines"), int)
            and isinstance(parsed.get("gitSubjects"), list)
            and isinstance(parsed.get("perModule"), list)
            and parsed["nModules"] == len(parsed["perModule"])
        ):
            errors.append("minimal completeness check failed")
    complete = present and parsed is not None and not errors
    metrics["auditResultPresent"] = present
    metrics["auditResult"] = parsed
    metrics["auditValidationErrors"] = errors
    metrics["isComplete"] = complete
    if errors:
        metrics["auditResultError"] = "; ".join(errors)
    return metrics


def attach_turn_cache(metrics: dict) -> dict:
    metrics.setdefault("turnCacheReadTokens", [])
    metrics.setdefault(
        "firstCacheReadTokens",
        metrics["turnCacheReadTokens"][0]
        if metrics["turnCacheReadTokens"]
        else 0,
    )
    metrics["totalObservedTokens"] = (
        (metrics.get("inputTokens") or 0)
        + (metrics.get("outputTokens") or 0)
        + (metrics.get("cacheReadTokens") or 0)
    )
    return metrics


def dollar_cost(metrics: dict, prices: dict) -> float:
    inp = (metrics.get("inputTokens") or 0) / 1_000_000 * prices["in"]
    out = (metrics.get("outputTokens") or 0) / 1_000_000 * prices["out"]
    cr = (metrics.get("cacheReadTokens") or 0) / 1_000_000 * prices["cache"]
    return inp + out + cr


def row_excluded(row: dict) -> tuple[bool, str]:
    m = row.get("metrics") or {}
    if m.get("exitCode") not in (0, None):
        return True, "nonzero-exit"
    if m.get("fallbackModel"):
        return True, "fallback"
    if m.get("inputTokensIsEstimated"):
        return True, "estimated-token"
    if m.get("usageTokensIncomplete"):
        return True, "incomplete-token-usage"
    if row.get("workload") is not None and m.get("isComplete") is not True:
        return True, "incomplete"
    if m.get("isComplete") is False:
        return True, "incomplete"
    if m.get("provenanceDrift"):
        return True, "provenance-drift"
    return False, ""


def primary_rows(rows: list) -> list:
    keep = []
    for r in rows:
        ex, _ = row_excluded(r)
        if not ex:
            keep.append(r)
    return keep


def wilson_interval(k: int, n: int, z: float = 1.959963984540054) -> tuple[float | None, float | None]:
    if n <= 0:
        return None, None
    phat = k / n
    z2 = z * z
    denom = 1 + z2 / n
    center = (phat + z2 / (2 * n)) / denom
    margin = (z * math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)) / denom
    lo = max(0.0, center - margin)
    hi = min(1.0, center + margin)
    return lo, hi


def _quantile(xs: list[float], q: float) -> float | None:
    if not xs:
        return None
    ys = sorted(xs)
    if len(ys) == 1:
        return ys[0]
    pos = q * (len(ys) - 1)
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return ys[lo]
    w = pos - lo
    return ys[lo] * (1 - w) + ys[hi] * w


def metric_stats(values: list[float]) -> dict:
    vals = [v for v in values if v is not None]
    if not vals:
        return {"n": 0, "mean": None, "median": None, "sd": None, "iqr": None,
                "p25": None, "p75": None}
    sd = statistics.stdev(vals) if len(vals) > 1 else 0.0
    p25 = _quantile(vals, 0.25)
    p75 = _quantile(vals, 0.75)
    iqr = None if p25 is None or p75 is None else (p75 - p25)
    return {
        "n": len(vals),
        "mean": statistics.mean(vals),
        "median": statistics.median(vals),
        "sd": sd,
        "iqr": iqr,
        "p25": p25,
        "p75": p75,
    }


def _fmt_num(v, digits=2):
    if v is None:
        return "NA"
    if isinstance(v, float):
        return f"{v:.{digits}f}"
    return str(v)


def smoke_mcp(fixture: Path, n: int, label: str | None = None) -> dict:
    """Direct MCP JSON-RPC smoke against evolved-mcp-server.mjs (no omp)."""
    env = dict(os.environ)
    env["TE_MCP_WORKSPACE"] = str(fixture)
    proc = subprocess.Popen(
        ["node", str(SHIM)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(fixture),
        env=env,
        text=True,
    )
    reqs = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                    "clientInfo": {"name": "te-prod-smoke", "version": "1"}}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
         "params": {"name": TOOL, "arguments": {}}},
    ]
    payload = "".join(json.dumps(r) + "\n" for r in reqs)
    try:
        out, err = proc.communicate(payload, timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()
        return {"passed": False, "n": n, "error": "timeout", "stderr": ""}
    replies = []
    for line in (out or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            replies.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    listed = False
    called_ok = False
    tool_text = None
    tool_json = None
    for r in replies:
        result = r.get("result") or {}
        if r.get("id") == 2:
            names = [t.get("name") for t in (result.get("tools") or [])]
            listed = TOOL in names
        if r.get("id") == 3:
            if not result.get("isError") and "content" in result:
                called_ok = True
                content = result.get("content") or []
                # MCP content is list of {type:"text", text:"..."}
                texts = []
                for c in content:
                    if isinstance(c, dict):
                        texts.append(c.get("text") or "")
                    elif isinstance(c, str):
                        texts.append(c)
                tool_text = "\n".join(texts)
                if tool_text:
                    try:
                        tool_json = json.loads(tool_text)
                    except json.JSONDecodeError:
                        # tool may return pretty printed JSON with surrounding whitespace
                        try:
                            s = tool_text.strip()
                            # find first { and last }
                            s_idx = s.find("{")
                            e_idx = s.rfind("}")
                            if s_idx >=0 and e_idx> s_idx:
                                tool_json = json.loads(s[s_idx:e_idx+1])
                        except Exception:
                            tool_json = None
    # Deep validation against fixture truth
    errors = []
    truth = compute_workload_truth(fixture)
    if tool_json is not None:
        if not tool_json.get("success"):
            errors.append("tool success false")
        data = tool_json.get("data") or {}
        # validate line_counts / todo_counts / total_lines / status / recent_commits
        line_counts = data.get("line_counts") or {}
        todo_counts = data.get("todo_counts") or {}
        total_lines = data.get("total_lines")
        status = data.get("status")
        recent = data.get("recent_commits") or []
        # exact module filename/line/TODO maps
        if line_counts != truth["line_counts"]:
            errors.append(f"line_counts mismatch: got {line_counts} expected {truth['line_counts']}")
        if todo_counts != truth["todo_counts"]:
            errors.append(f"todo_counts mismatch: got {todo_counts} expected {truth['todo_counts']}")
        if total_lines is not None and total_lines != truth["totalLines"]:
            errors.append(f"total_lines mismatch: got {total_lines} expected {truth['totalLines']}")
        # total lines also check sum of line_counts if total_lines missing
        # recent commit subjects: tool returns oneline strings "hash subject"; extract subjects
        if recent:
            # recent_commits are "hash subject" strings; extract subject part after first space
            recent_subjects = []
            for rc in recent:
                parts = rc.split(" ", 1)
                subj = parts[1] if len(parts) > 1 else parts[0]
                recent_subjects.append(subj)
            if recent_subjects != truth["gitSubjects"]:
                errors.append(f"recent_commits subjects mismatch: got {recent_subjects} expected {truth['gitSubjects']}")
        else:
            errors.append("missing recent_commits")
        if status is not None:
            # status should equal porcelain (allow trailing newline differences)
            if status.strip() != truth["gitPorcelain"].strip():
                errors.append(f"porcelain mismatch: got {repr(status.strip())} expected {repr(truth['gitPorcelain'].strip())}")
        else:
            errors.append("missing status")
        # check ordered module filenames via line_counts keys
        if sorted(line_counts.keys()) != truth["orderedFiles"]:
            errors.append(f"module filenames mismatch: got {sorted(line_counts.keys())} expected {truth['orderedFiles']}")
    else:
        if called_ok:
            errors.append("tool JSON parse failed")
        else:
            errors.append("tool not called ok")
    passed = listed and called_ok and not errors and proc.returncode in (0, None)
    rec = {
        "passed": bool(passed),
        "n": n,
        "label": label or f"w{n}",
        "listed": listed,
        "calledOk": called_ok,
        "returncode": proc.returncode,
        "stderr": (err or "")[-2000:],
        "fixture": str(fixture),
        "toolJson": tool_json,
        "validationErrors": errors,
        "truth": {"nModules": truth["nModules"], "totalLines": truth["totalLines"], "gitSubjects": truth["gitSubjects"]},
    }
    artifact_label = re.sub(r"[^a-zA-Z0-9_.-]+", "-", label or f"w{n}")
    (PROD_OUT / f"smoke-{artifact_label}.json").write_text(
        json.dumps(rec, indent=2) + "\n"
    )
    return rec


def archive_generic_artifacts(out: Path) -> None:
    stamp = (
        f"{time.strftime('%Y%m%dT%H%M%S')}-"
        f"{time.time_ns() % 1_000_000_000:09d}"
    )
    dest = out / "archive" / stamp
    names = {"summary.md", "results.json", "results.partial.json", "savings.md"}
    names.update(path.name for path in out.glob("summary-w*.md"))
    names.update(path.name for path in out.glob("savings-w*.md"))
    moved = []
    for name in sorted(names):
        src = out / name
        if src.is_file():
            dest.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dest / name))
            moved.append(name)
    if moved:
        H.log(f"archived {moved} -> {dest}")


def write_prod_overlay(cfg_root: str, xdev: bool) -> Path:
    ov = yaml.safe_load(PROD_OVERLAY)
    if not xdev:
        ov.setdefault("tools", {})["xdev"] = False
    path = Path.home() / cfg_root / "overlay.yml"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(ov))
    return path


def reset_workdir(src: Path, dest: Path) -> Path:
    # Copy fixtures verbatim; do not git reset/clean (destroys dirty/untracked state)
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(src, dest, symlinks=True)
    return dest




def bootstrap_paired_savings(ctrl: list[float], treat: list[float],
                             seed: int = BOOTSTRAP_SEED, b: int = BOOTSTRAP_B):
    # Kept for default mode compatibility (nominal paired bootstrap)
    if len(ctrl) != len(treat):
        raise ValueError("paired bootstrap inputs must have equal length")
    n = len(ctrl)
    if n == 0:
        return None, None, None
    rng = random.Random(seed)
    diffs = []
    c = ctrl
    t = treat
    point = None
    cmean = statistics.mean(c)
    tmean = statistics.mean(t)
    if cmean:
        point = 100.0 * (cmean - tmean) / cmean
    for _ in range(b):
        idx = [rng.randrange(n) for _ in range(n)]
        cm = statistics.mean(c[i] for i in idx)
        tm = statistics.mean(t[i] for i in idx)
        if cm:
            diffs.append(100.0 * (cm - tm) / cm)
    if not diffs:
        return point, None, None
    diffs.sort()
    lo = diffs[int(0.025 * (len(diffs) - 1))]
    hi = diffs[int(0.975 * (len(diffs) - 1))]
    return point, lo, hi


def bootstrap_cluster_savings(clustered_ctrl: dict, clustered_treat: dict,
                              seed: int = BOOTSTRAP_SEED, b: int = BOOTSTRAP_B):
    # Deterministic workload-cluster bootstrap for aggregate comparisons.
    # clustered_* are dict workload -> list[float] paired values in workload order
    workloads = sorted(set(clustered_ctrl) | set(clustered_treat))
    if not workloads:
        return None, None, None
    for workload in workloads:
        if len(clustered_ctrl.get(workload, [])) != len(
            clustered_treat.get(workload, [])
        ):
            raise ValueError(
                f"cluster {workload} has unpaired bootstrap inputs"
            )
    all_c = [
        value for workload in workloads
        for value in clustered_ctrl.get(workload, [])
    ]
    all_t = [
        value for workload in workloads
        for value in clustered_treat.get(workload, [])
    ]
    if not all_c:
        return None, None, None
    cmean = statistics.mean(all_c)
    tmean = statistics.mean(all_t)
    point = 100.0 * (cmean - tmean) / cmean if cmean else None
    rng = random.Random(seed)
    diffs = []
    for _ in range(b):
        # sample workloads with replacement
        sampled = [rng.choice(workloads) for _ in range(len(workloads))]
        bv, tv = [], []
        for w in sampled:
            cb = clustered_ctrl.get(w, [])
            tb = clustered_treat.get(w, [])
            # per-workload bootstrap repetitions: resample within workload with replacement
            if cb and tb:
                m = len(cb)
                idx = [rng.randrange(m) for _ in range(m)]
                for i in idx:
                    bv.append(float(cb[i]))
                    tv.append(float(tb[i]))
        if not bv or not tv:
            continue
        cm = statistics.mean(bv)
        tm = statistics.mean(tv)
        if cm:
            diffs.append(100.0 * (cm - tm) / cm)
    if not diffs:
        return point, None, None
    diffs.sort()
    lo = diffs[int(0.025 * (len(diffs) - 1))]
    hi = diffs[int(0.975 * (len(diffs) - 1))]
    return point, lo, hi


def cohort_metric_values(rows: list, metric: str) -> list[float]:
    out = []
    for r in rows:
        m = r.get("metrics") or {}
        if metric == "costDollars":
            v = m.get("costDollars")
        elif metric == "totalObservedTokens":
            v = m.get("totalObservedTokens")
        elif metric == "realToolCalls":
            v = m.get("realToolCalls")
            if v is None:
                v = sum(
                    count
                    for name, count in (m.get("toolCalls") or {}).items()
                    if name != "xd-mcp-invoke"
                )
        else:
            v = m.get(metric)
        if v is not None:
            out.append(float(v))
    return out


def production_report(rows: list, prices: dict) -> tuple[str, str]:
    kept = primary_rows(rows)
    excluded = [r for r in rows if row_excluded(r)[0]]
    metrics = [
        "bashCalls", "realToolCalls", "toolErrors", "turns", "wallSeconds",
        "inputTokens", "outputTokens", "cacheReadTokens",
        "totalObservedTokens", "costDollars", "firstCacheReadTokens",
    ]
    # Detect per-workload filtered input to avoid empty sections
    distinct_workloads = sorted({r.get("workload") for r in kept if r.get("workload") is not None})
    single_workload = len(distinct_workloads) == 1
    # Label helper
    def workload_label(n):
        lbl = WORKLOAD_LABELS.get(n, str(n))
        return f"w{n} ({lbl})"
    lines = [
        "# Production experiment",
        "",
        f"prices: input=${prices['in']}/M output=${prices['out']}/M "
        f"cacheRead=${prices['cache']}/M",
        f"rows total={len(rows)} kept={len(kept)} excluded={len(excluded)}",
        f"distinct workloads: {distinct_workloads if distinct_workloads else 'generic'}",
        "",
        "## Exclusion counts",
    ]
    counts = {}
    for r in rows:
        ex, why = row_excluded(r)
        if ex:
            counts[why] = counts.get(why, 0) + 1
    if not counts:
        lines.append("none")
    else:
        for k, v in sorted(counts.items()):
            lines.append(f"- {k}: {v}")
    lines.append("")
    cold_n = sum(
        1 for row in kept
        if (row.get("metrics") or {}).get("cachePhase") == "cold"
    )
    warm_n = sum(
        1 for row in kept
        if (row.get("metrics") or {}).get("cachePhase") == "warm"
    )
    lines.append(f"cache phases: cold={cold_n} warm={warm_n}")
    lines.append("")
    lines.append("## Aggregate by cell")
    lines.append(
        "| cell | n | attempt | adopt | failed_calls | wilson_lo | wilson_hi | "
        "bash_mean | errors_mean | cache_mean | firstCache_mean | total_mean | "
        "cost_mean | cost_median | cost_iqr | cost_sd |"
    )
    lines.append(
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"
    )

    def cell_rows(cell, subset=None):
        src = subset if subset is not None else kept
        return [r for r in src if r["cell"] == cell]

    for cell in PRIMARY_CELLS:
        rs = cell_rows(cell)
        if not rs and single_workload:
            continue
        n = len(rs)
        if n == 0:
            continue
        adopt = sum(1 for r in rs if (r.get("metrics") or {}).get("evolvedCalls", 0) > 0)
        attempts = sum(
            1 for r in rs
            if (r.get("metrics") or {}).get("evolvedAttempts", 0) > 0
        )
        failed_calls = sum(
            (r.get("metrics") or {}).get("evolvedFailures", 0) for r in rs
        )
        lo, hi = wilson_interval(adopt, n)
        bash = metric_stats(cohort_metric_values(rs, "bashCalls"))
        errors = metric_stats(cohort_metric_values(rs, "toolErrors"))
        cache = metric_stats(cohort_metric_values(rs, "cacheReadTokens"))
        first = metric_stats(cohort_metric_values(rs, "firstCacheReadTokens"))
        total = metric_stats(cohort_metric_values(rs, "totalObservedTokens"))
        cost = metric_stats(cohort_metric_values(rs, "costDollars"))
        lines.append(
            f"| {cell} | {n} | {attempts}/{n} | {adopt}/{n} | "
            f"{failed_calls} | {_fmt_num(lo, 3)} | {_fmt_num(hi, 3)} | "
            f"{_fmt_num(bash['mean'])} | {_fmt_num(errors['mean'])} | "
            f"{_fmt_num(cache['mean'], 1)} | {_fmt_num(first['mean'], 1)} | "
            f"{_fmt_num(total['mean'], 1)} | {_fmt_num(cost['mean'], 4)} | "
            f"{_fmt_num(cost['median'], 4)} | {_fmt_num(cost['iqr'], 4)} | "
            f"{_fmt_num(cost['sd'], 4)} |"
        )
    lines.append("")
    lines.append("## Per-cell metric distributions")
    lines.append("| cell | metric | n | mean | median | IQR | SD |")
    lines.append("|---|---|---|---|---|---|---|")
    for cell in PRIMARY_CELLS:
        rs = cell_rows(cell)
        for metric in metrics:
            s = metric_stats(cohort_metric_values(rs, metric))
            if s["n"]:
                lines.append(
                    f"| {cell} | {metric} | {s['n']} | {_fmt_num(s['mean'])} | "
                    f"{_fmt_num(s['median'])} | {_fmt_num(s['iqr'])} | "
                    f"{_fmt_num(s['sd'])} |"
                )
    lines.append("")
    lines.append("## Cold vs warm (rep1 cold, reps2-5 warm)")
    lines.append(
        "| phase | cell | n | cost_mean | cost_median | cache_mean | "
        "firstCache_mean |"
    )
    lines.append("|---|---|---|---|---|---|---|")
    for phase in ("cold", "warm"):
        for cell in PRIMARY_CELLS:
            ph_rows = [
                r for r in cell_rows(cell)
                if (r.get("metrics") or {}).get("cachePhase") == phase
            ]
            if not ph_rows:
                continue
            cost = metric_stats(cohort_metric_values(ph_rows, "costDollars"))
            cache = metric_stats(cohort_metric_values(ph_rows, "cacheReadTokens"))
            first = metric_stats(cohort_metric_values(ph_rows, "firstCacheReadTokens"))
            lines.append(
                f"| {phase} | {cell} | {len(ph_rows)} | "
                f"{_fmt_num(cost['mean'], 4)} | {_fmt_num(cost['median'], 4)} | "
                f"{_fmt_num(cache['mean'], 1)} | {_fmt_num(first['mean'], 1)} |"
            )
    lines.append("")
    # Per-workload before/after
    workloads_to_show = distinct_workloads if single_workload else list(WORKLOADS)
    if not single_workload:
        lines.append("## Per-workload before/after (ctrl vs treatment means)")
        lines.append(
            "| workload | cell | n | adopt | wilson_lo | wilson_hi | "
            "bash_mean | cache_mean | firstCache_mean | total_mean | cost_mean |"
        )
        lines.append("|---|---|---|---|---|---|---|---|---|---|---|")
        for nmod in workloads_to_show:
            if nmod not in distinct_workloads and distinct_workloads:
                continue
            subset = [r for r in kept if r.get("workload") == nmod]
            for cell in PRIMARY_CELLS:
                rs = cell_rows(cell, subset)
                n = len(rs)
                if n == 0:
                    continue
                adopt = sum(1 for r in rs if (r.get("metrics") or {}).get("evolvedCalls", 0) > 0)
                lo, hi = wilson_interval(adopt, n)
                bash = metric_stats(cohort_metric_values(rs, "bashCalls"))
                cache = metric_stats(cohort_metric_values(rs, "cacheReadTokens"))
                first = metric_stats(cohort_metric_values(rs, "firstCacheReadTokens"))
                total = metric_stats(cohort_metric_values(rs, "totalObservedTokens"))
                cost = metric_stats(cohort_metric_values(rs, "costDollars"))
                lines.append(
                    f"| {workload_label(nmod)} | {cell} | {n} | {adopt}/{n} | "
                    f"{_fmt_num(lo, 3)} | {_fmt_num(hi, 3)} | "
                    f"{_fmt_num(bash['mean'])} | {_fmt_num(cache['mean'], 1)} | "
                    f"{_fmt_num(first['mean'], 1)} | {_fmt_num(total['mean'], 1)} | "
                    f"{_fmt_num(cost['mean'], 4)} |"
                )
        lines.append("")
    else:
        # Single workload file: only show that workload
        nmod = distinct_workloads[0]
        lines.append(f"## Per-workload {workload_label(nmod)} (single-workload file)")
        lines.append(
            "| workload | cell | n | adopt | wilson_lo | wilson_hi | "
            "bash_mean | cache_mean | firstCache_mean | total_mean | cost_mean |"
        )
        lines.append("|---|---|---|---|---|---|---|---|---|---|---|")
        subset = [r for r in kept if r.get("workload") == nmod]
        for cell in PRIMARY_CELLS:
            rs = cell_rows(cell, subset)
            n = len(rs)
            if n == 0:
                continue
            adopt = sum(1 for r in rs if (r.get("metrics") or {}).get("evolvedCalls", 0) > 0)
            lo, hi = wilson_interval(adopt, n)
            bash = metric_stats(cohort_metric_values(rs, "bashCalls"))
            cache = metric_stats(cohort_metric_values(rs, "cacheReadTokens"))
            first = metric_stats(cohort_metric_values(rs, "firstCacheReadTokens"))
            total = metric_stats(cohort_metric_values(rs, "totalObservedTokens"))
            cost = metric_stats(cohort_metric_values(rs, "costDollars"))
            lines.append(
                f"| {workload_label(nmod)} | {cell} | {n} | {adopt}/{n} | "
                f"{_fmt_num(lo, 3)} | {_fmt_num(hi, 3)} | "
                f"{_fmt_num(bash['mean'])} | {_fmt_num(cache['mean'], 1)} | "
                f"{_fmt_num(first['mean'], 1)} | {_fmt_num(total['mean'], 1)} | "
                f"{_fmt_num(cost['mean'], 4)} |"
            )
        lines.append("")
    lines.append("Primary claims exclude fabricated tool/evolved timing; wallSeconds is process elapsed.")
    summary = "\n".join(lines)

    sav = [
        "# Savings",
        "",
        "Savings = 100 × (ctrl mean − treatment mean) / ctrl mean.",
        f"Bootstrap: deterministic workload-cluster bootstrap (aggregate) and per-workload repetition bootstrap (per-workload). Paired by workload+rep. Seed {BOOTSTRAP_SEED}, B={BOOTSTRAP_B}.",
        "",
        "| scope | comparison | metric | savings% | ci_lo | ci_hi | n_pairs |",
        "|---|---|---|---|---|---|---|",
    ]
    comparisons = [("ctrl", "shim4q"), ("ctrl", "shim"), ("ctrl", "both"),
                   ("shim4q", "shim"), ("shim", "both")]
    if single_workload:
        scopes = [(f"w{distinct_workloads[0]}", distinct_workloads[0])]
    else:
        scopes = [("aggregate", None)] + [(f"w{n}", n) for n in WORKLOADS]
    for scope, nmod in scopes:
        src = kept if nmod is None else [r for r in kept if r.get("workload") == nmod]
        # skip empty scopes for per-file
        if single_workload and nmod is not None and nmod != distinct_workloads[0]:
            continue
        if not src:
            continue
        for base, treat in comparisons:
            b_rows = [r for r in src if r["cell"] == base]
            t_rows = [r for r in src if r["cell"] == treat]
            # pair by workload+rep when possible
            index_b = {(r.get("workload"), r.get("rep")): r for r in b_rows}
            index_t = {(r.get("workload"), r.get("rep")): r for r in t_rows}
            keys = sorted(set(index_b) & set(index_t))
            for metric in metrics:
                bv, tv = [], []
                for k in keys:
                    mb = (index_b[k].get("metrics") or {})
                    mt = (index_t[k].get("metrics") or {})
                    xb = mb.get("costDollars") if metric == "costDollars" else mb.get(metric)
                    xt = mt.get("costDollars") if metric == "costDollars" else mt.get(metric)
                    if xb is None or xt is None:
                        continue
                    bv.append(float(xb))
                    tv.append(float(xt))
                if nmod is None:
                    # cluster bootstrap aggregate
                    # build clustered dicts
                    cl_c = {}
                    cl_t = {}
                    for k in keys:
                        w = k[0]
                        mb = (index_b[k].get("metrics") or {})
                        mt = (index_t[k].get("metrics") or {})
                        xb = mb.get("costDollars") if metric == "costDollars" else mb.get(metric)
                        xt = mt.get("costDollars") if metric == "costDollars" else mt.get(metric)
                        if xb is None or xt is None:
                            continue
                        cl_c.setdefault(w, []).append(float(xb))
                        cl_t.setdefault(w, []).append(float(xt))
                    point, lo, hi = bootstrap_cluster_savings(cl_c, cl_t)
                else:
                    point, lo, hi = bootstrap_paired_savings(bv, tv)
                # label scope with descriptive workload label
                scope_label = workload_label(nmod) if nmod is not None else scope
                sav.append(
                    f"| {scope_label if nmod is not None else scope} | {base}→{treat} | {metric} | {_fmt_num(point)} | "
                    f"{_fmt_num(lo)} | {_fmt_num(hi)} | {len(bv)} |"
                )
    return summary, "\n".join(sav)


def run_one(cell, shim, instr, prompt_name, model, rep, instructions, xdev=True,
            *, production=False, workload=None, work=None, cfg_root=None,
            overlay=None, lock=None, prices=None, prompt_path=None):
    tag = "" if xdev else "-xdevfalse"
    wtag = f"-w{workload}" if workload is not None else ""
    run_id = f"{cell}{tag}{wtag}-{model.replace('/', '_')}-r{rep}-{uuid.uuid4().hex[:8]}"
    if cfg_root is None:
        cfg_root = f"tmp/te-omp-runs/cfg/{uuid.uuid4().hex[:12]}"
        prepare_profile(cfg_root, shim, instr, instructions, reuse=False)
    else:
        dest = Path.home() / cfg_root
        if not dest.exists():
            prepare_profile(cfg_root, shim, instr, instructions, reuse=False)
        else:
            prepare_profile(cfg_root, shim, instr, instructions, reuse=True)
    if work is None:
        work = prepare_workdir(run_id)
    if production:
        # Use stable prompt outside worktree, scoped by cell+workload; do not rewrite
        if prompt_path is None:
            raise SystemExit(f"production run_one requires prompt_path for {cell} w{workload}")
        # Ensure prompt_path exists and is outside worktree
        if not prompt_path.is_file():
            raise SystemExit(f"prompt_path missing: {prompt_path}")
        # Verify prompt not inside worktree
        try:
            prompt_path.resolve().relative_to(work.resolve())
            raise SystemExit(f"prompt_path inside worktree: {prompt_path} -> {work}")
        except ValueError:
            pass
        out_dir = PROD_OUT
        prompt = prompt_path.read_text()
    else:
        prompt_path_generic = {"prompt4": PROMPT4, "prompt3": PROMPT3}.get(
            prompt_name, PROMPT5 if prompt_name == "prompt5" else PROMPT4Q)
        prompt_path = prompt_path_generic
        nonce = f"<!-- probe-nonce:{run_id} -->\n"
        out_dir = OUT
        prompt = nonce + prompt_path.read_text()
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{run_id}.jsonl"
    err = out_dir / f"{run_id}.err"
    H.log(f"{run_id}: shim={shim} instr={instr} xdev={xdev} model={model} "
          f"workload={workload} prod={production}")
    t0 = time.time()
    env = dict(os.environ)
    env["PI_CONFIG_DIR"] = cfg_root
    env["TE_MCP_WORKSPACE"] = str(work)
    if overlay is None and not xdev:
        ov = yaml.safe_load(H.OVERLAY_YML.read_text())
        ov.setdefault("tools", {})["xdev"] = False
        overlay = Path.home() / cfg_root / "overlay.yml"
        overlay.write_text(yaml.safe_dump(ov))
    try:
        with open(out, "w") as fo, open(err, "w") as fe:
            p = subprocess.run(
                H.omp_argv(prompt, model=model, overlay=overlay),
                cwd=str(work), stdout=fo, stderr=fe, timeout=1500, env=env,
                stdin=subprocess.DEVNULL)
        exit_code = p.returncode
    except subprocess.TimeoutExpired:
        exit_code = 124
    dur = round(time.time() - t0, 1)
    m = H.run_metrics(out)
    m["wallSeconds"] = dur
    m["exitCode"] = exit_code
    attach_turn_cache(m)
    # Determine cache phase: rep1 cold, reps2-5 warm
    cache_phase = "cold" if rep == 1 else "warm"
    m["cachePhase"] = cache_phase
    expected = (
        (lock.get("fixtures") or {}).get(str(workload))
        if lock is not None and workload is not None
        else None
    )
    parse_audit_result(m, out, expected=expected)
    if prices:
        m["costDollars"] = dollar_cost(m, prices)
    drift = False
    drift_why = ""
    live = None
    if lock is not None and workload is not None:
        live, drift, drift_why = live_provenance(lock, workload, work)
        profile_root = Path.home() / cfg_root / "agent"
        append_sha = snapshot_file_sha(profile_root / "APPEND_SYSTEM.md")
        expected_append_sha = (
            lock["instructionsSha256"]
            if instr
            else hashlib.sha256(b"").hexdigest()
        )
        profile_errors = []
        if append_sha != expected_append_sha:
            profile_errors.append("profile instructions drifted")
        try:
            profile_mcp = json.loads((profile_root / "mcp.json").read_text())
            mounted = SERVER in (profile_mcp.get("mcpServers") or {})
            if mounted != shim:
                profile_errors.append("profile MCP mount drifted")
        except Exception as exc:
            mounted = None
            profile_errors.append(f"profile MCP unreadable: {exc}")
        live["profileInstructionsSha256"] = append_sha
        live["profileMcpMounted"] = mounted
        if profile_errors:
            drift = True
            drift_why = "; ".join(
                [reason for reason in (drift_why, *profile_errors) if reason]
            )
        m["provenanceDrift"] = drift
        if drift:
            H.log(f"{run_id}: provenance drift: {drift_why}")
    row = {
        "id": run_id, "cell": cell, "shim": shim, "instructions": instr,
        "xdev": xdev, "prompt": prompt_name, "model": model, "rep": rep,
        "profile": cfg_root, "workdir": str(work),
        "workload": workload,
        "workloadLabel": WORKLOAD_LABELS.get(workload) if workload is not None else None,
        "cachePhase": cache_phase,
        "toolProvenance": tool_provenance(), "metrics": m,
        "liveProvenance": live,
        "promptPath": str(prompt_path) if prompt_path else None,
        "promptSha256": snapshot_file_sha(prompt_path) if prompt_path and prompt_path.is_file() else None,
        "nonce": (prompt.splitlines()[0] if production else f"<!-- probe-nonce:{run_id} -->"),
    }
    (out_dir / f"{run_id}.json").write_text(json.dumps(row, indent=2))
    H.log(f"{run_id}: exit={exit_code} dur={dur}s evolved={m['evolvedCalls']} "
          f"bash={m['bashCalls']} in={m['inputTokens']} "
          f"firstCache={m['firstCacheReadTokens']} cold={m['coldCache']} phase={cache_phase} "
          f"complete={m.get('isComplete')}")
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=3)
    ap.add_argument("--model", default="te-ocg/muse-spark-1.2-contributor")
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
    ap.add_argument("--production", action="store_true",
                    help="80-run production experiment (4 cells x 4 workloads x 5 reps).")
    ap.add_argument("--resume-invalid", action="store_true",
                    help="Resume production repairing fallback/invalid rows (requires --production).")
    ap.add_argument("--price-in", type=float, default=1.0,
                    help="USD per million input tokens (default 1).")
    ap.add_argument("--price-out", type=float, default=4.0,
                    help="USD per million output tokens (default 4).")
    ap.add_argument("--price-cache", type=float, default=0.25,
                    help="USD per million cache-read tokens (default 0.25).")
    args = ap.parse_args()
    if args.resume_invalid and not args.production:
        raise SystemExit("--resume-invalid requires --production")
    prices = {"in": args.price_in, "out": args.price_out, "cache": args.price_cache}
    xdev = args.xdev == "true"
    instructions = catalog_instructions(fail_closed=args.production)

    if not args.production:
        wanted = {c.strip() for c in args.cells.split(",") if c.strip()}
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
        random.Random(0).shuffle(jobs)
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
        savings = savings_table(rows, prices)
        (OUT / "savings.md").write_text(savings + "\n")
        print(savings)
        print(table)
        H.log("PROBE COMPLETE")
        return

    if args.model != "te-ocg/muse-spark-1.2-contributor":
        raise SystemExit("production mode requires te-ocg/muse-spark-1.2-contributor")
    if not xdev:
        raise SystemExit("production mode requires --xdev true")
    jobs_n = 6 if args.jobs == 12 else args.jobs
    if jobs_n != 6:
        raise SystemExit("production mode requires --jobs 6")
    if args.resume_invalid:
        # Resume: load results and provenance before archiving report artifacts
        results_path = PROD_OUT / "results.json"
        lock_path = PROD_OUT / "provenance.lock.json"
        if not results_path.is_file():
            raise SystemExit(f"resume requires existing {results_path}")
        if not lock_path.is_file():
            raise SystemExit(f"resume requires existing {lock_path}")
        rows_orig = json.loads(results_path.read_text())
        lock = json.loads(lock_path.read_text())
        if not isinstance(rows_orig, list):
            raise SystemExit("resume results must be a JSON array")
        seen_ids = set()
        seen_slots = set()
        for row in rows_orig:
            row_id = row.get("id")
            slot = (row.get("cell"), row.get("workload"), row.get("rep"))
            if not row_id or row_id in seen_ids:
                raise SystemExit(f"resume duplicate or missing row id: {row_id}")
            if slot in seen_slots:
                raise SystemExit(f"resume duplicate block/rep slot: {slot}")
            if row.get("cell") not in PRIMARY_CELLS:
                raise SystemExit(f"resume unexpected cell: {row.get('cell')}")
            if row.get("workload") not in WORKLOADS:
                raise SystemExit(
                    f"resume unexpected workload: {row.get('workload')}"
                )
            if row.get("model") != lock.get("model") or row.get("xdev") is not True:
                raise SystemExit(f"resume row treatment drifted: {row_id}")
            expected_phase = "cold" if row.get("rep") == 1 else "warm"
            if (row.get("metrics") or {}).get("cachePhase") != expected_phase:
                raise SystemExit(f"resume cache phase drifted: {row_id}")
            row_provenance = row.get("toolProvenance") or {}
            for key in (
                "candidateId", "manifestSha256", "sourceSha256",
                "catalogWorkspaceId",
            ):
                if row_provenance.get(key) != lock.get(key):
                    raise SystemExit(
                        f"resume row {key} drifted: {row_id}"
                    )
            seen_ids.add(row_id)
            seen_slots.add(slot)
        # Verify exact current model/xdev/cells/jobs
        if args.model != lock.get("model"):
            raise SystemExit(f"resume model mismatch: args {args.model} vs lock {lock.get('model')}")
        if lock.get("model") != "te-ocg/muse-spark-1.2-contributor":
            raise SystemExit(f"resume lock model unexpected: {lock.get('model')}")
        if not xdev or lock.get("xdev") is not True:
            raise SystemExit(f"resume requires xdev true: xdev={xdev} lock xdev={lock.get('xdev')}")
        cell_map = {name: (name, shim, instr, prompt) for name, shim, instr, prompt in FACTORIAL
                    if name in PRIMARY_CELLS}
        wanted = (
            set(PRIMARY_CELLS)
            if args.cells == "ctrl,shim,instr,both"
            else {cell.strip() for cell in args.cells.split(",") if cell.strip()}
        )
        if wanted != set(PRIMARY_CELLS):
            raise SystemExit(
                f"production mode requires cells {list(PRIMARY_CELLS)}, "
                f"got {sorted(wanted)}"
            )
        if lock.get("cells") != list(PRIMARY_CELLS):
            raise SystemExit(f"resume lock cells mismatch: {lock.get('cells')} vs {list(PRIMARY_CELLS)}")
        if lock.get("workloads") != list(WORKLOADS):
            raise SystemExit(f"resume lock workloads mismatch: {lock.get('workloads')} vs {list(WORKLOADS)}")
        if lock.get("reps") != PROD_REPS:
            raise SystemExit(f"resume lock reps mismatch: {lock.get('reps')} vs {PROD_REPS}")
        # Verify current tool candidate/manifest/source/workspace
        tp = tool_provenance()
        if not tp:
            raise SystemExit("resume tool provenance missing")
        for key in ("candidateId", "manifestSha256", "sourceSha256", "sourcePath", "catalogWorkspaceId"):
            if tp.get(key) != lock.get(key):
                raise SystemExit(f"resume {key} drifted: current {tp.get(key)!r} vs lock {lock.get(key)!r}")
        if lock.get("manifestPath") != str(H.MANIFEST):
            raise SystemExit(f"resume manifestPath drifted: {lock.get('manifestPath')} vs {H.MANIFEST}")
        # Verify catalog instructions SHA
        cur_sha = hashlib.sha256(instructions.encode()).hexdigest()
        if cur_sha != lock.get("instructionsSha256"):
            raise SystemExit(f"resume instructions SHA drifted: {cur_sha} vs {lock.get('instructionsSha256')}")
        # Verify existing block workdir/prompt/overlay/profile treatment and live fixture provenance
        cells = list(PRIMARY_CELLS)
        blocks = []
        for cell in cells:
            name, shim, instr, prompt = cell_map[cell]
            for n in WORKLOADS:
                cfg = block_cfg_root(cell, n)
                work = block_workdir(cell, n)
                prompt_path = PROD_PROMPT_DIR / f"{cell}-w{n}.txt"
                overlay_path = Path.home() / cfg / "overlay.yml"
                agent_path = Path.home() / cfg / "agent"
                if not (Path.home() / cfg).is_dir():
                    raise SystemExit(f"resume missing cfg {cfg}")
                if not work.is_dir():
                    raise SystemExit(f"resume missing workdir {work}")
                if not prompt_path.is_file():
                    raise SystemExit(f"resume missing prompt {prompt_path}")
                if not overlay_path.is_file():
                    raise SystemExit(f"resume missing overlay {overlay_path}")
                if not (agent_path / "mcp.json").is_file():
                    raise SystemExit(f"resume missing mcp.json for {cell}-w{n}")
                if not (agent_path / "APPEND_SYSTEM.md").is_file():
                    raise SystemExit(f"resume missing APPEND_SYSTEM.md for {cell}-w{n}")
                expected_git_head = (lock.get("fixtures") or {}).get(str(n), {}).get("gitHead")
                if not expected_git_head:
                    raise SystemExit(f"resume lock missing gitHead for w{n}")
                expected_nonce = block_nonce(cell, n, expected_git_head)
                prompt_text = prompt_path.read_text()
                expected_body = expected_nonce + _prompt_body(n, str(work), nudge=(prompt == "prompt5"))
                if prompt_text != expected_body:
                    raise SystemExit(f"resume prompt drifted for {cell}-w{n}")
                try:
                    expected_overlay = yaml.safe_load(PROD_OVERLAY)
                    actual_overlay = yaml.safe_load(overlay_path.read_text())
                except Exception as exc:
                    raise SystemExit(f"resume overlay unreadable for {cell}-w{n}: {exc}") from exc
                if actual_overlay != expected_overlay:
                    raise SystemExit(f"resume overlay drifted for {cell}-w{n}: {actual_overlay!r} vs {expected_overlay!r}")
                expected_mcp = mcp_payload(shim)
                try:
                    actual_mcp = json.loads((agent_path / "mcp.json").read_text())
                except Exception as exc:
                    raise SystemExit(f"resume mcp.json unreadable for {cell}-w{n}: {exc}") from exc
                if actual_mcp != expected_mcp:
                    raise SystemExit(f"resume profile MCP drifted for {cell}-w{n}: {actual_mcp!r} vs {expected_mcp!r}")
                expected_append = instructions if instr else ""
                actual_append = (agent_path / "APPEND_SYSTEM.md").read_text()
                if actual_append != expected_append:
                    raise SystemExit(f"resume profile APPEND_SYSTEM.md drifted for {cell}-w{n}")
                live, drift, why = live_provenance(lock, n, work)
                if drift:
                    raise SystemExit(f"resume live provenance drifted for {cell}-w{n}: {why}")
                blocks.append({
                    "cell": cell, "shim": shim, "instr": instr, "prompt": prompt,
                    "workload": n, "cfg": cfg, "work": work, "overlay": overlay_path,
                    "prompt_path": prompt_path,
                })
        if len(blocks) != len(PRIMARY_CELLS) * len(WORKLOADS):
            raise SystemExit(f"production matrix incomplete: {len(blocks)} blocks")
        # Count valid rows using row_excluded per (cell,workload). Target PROD_REPS valid each.
        valid_counts = {}
        for cell in cells:
            for n in WORKLOADS:
                cnt = sum(1 for r in rows_orig if r.get("cell") == cell and r.get("workload") == n and not row_excluded(r)[0])
                valid_counts[(cell, n)] = cnt
                if cnt > PROD_REPS:
                    raise SystemExit(f"resume block {cell}-w{n} has >{PROD_REPS} valid rows: {cnt}")
        deficits = {k: PROD_REPS - v for k, v in valid_counts.items()}
        total_deficit = sum(deficits.values())
        expected_kept = len(PRIMARY_CELLS) * len(WORKLOADS) * PROD_REPS
        current_kept = len(primary_rows(rows_orig))
        # cross-check sum
        if sum(valid_counts.values()) != current_kept:
            raise SystemExit(f"resume valid count mismatch: sum {sum(valid_counts.values())} vs primary_rows {current_kept}")
        if current_kept + total_deficit != expected_kept:
            raise SystemExit(f"resume cannot reach exact {expected_kept} kept rows: current {current_kept} deficit {total_deficit}")
        if total_deficit == 0:
            raise SystemExit("resume no deficits to repair")
        # Archive the prior prod summary/results/savings/results.partial/per-workload reports before overwriting; do not archive n=6 probe artifacts on resume.
        PROD_OUT.mkdir(parents=True, exist_ok=True)
        archive_generic_artifacts(PROD_OUT)
        results_path.write_text(json.dumps(rows_orig, indent=2) + "\n")
        # Direct smoke all resumed worktrees before measured replacements.
        for block in blocks:
            label = block_id(block["cell"], block["workload"])
            rec = smoke_mcp(block["work"], block["workload"], label=f"work-{label}")
            if not rec.get("passed"):
                raise SystemExit(f"MCP smoke failed for {label}: {rec}")
            H.log(f"MCP smoke passed {label}")
        # Schedule only deficits, in sequential deterministic waves, using new rep numbers above global max (rep6 here). Each replacement is warm.
        max_rep = max((r.get("rep") or 0) for r in rows_orig) if rows_orig else 0
        max_deficit = max(deficits.values()) if deficits else 0
        rows = list(rows_orig)
        for wave_idx in range(max_deficit):
            rep = max_rep + 1 + wave_idx
            if rep == 1:
                raise SystemExit("resume replacement rep would be cold")
            wave_blocks = [b for b in blocks if deficits[(b["cell"], b["workload"])] > wave_idx]
            wave_blocks = list(wave_blocks)
            random.Random(rep).shuffle(wave_blocks)
            H.log(f"resume wave {wave_idx+1}/{max_deficit} rep={rep} jobs={len(wave_blocks)} workers={jobs_n}")
            with ThreadPoolExecutor(max_workers=max(1, jobs_n)) as pool:
                futs = []
                for b in wave_blocks:
                    futs.append(pool.submit(
                        run_one, b["cell"], b["shim"], b["instr"], b["prompt"],
                        args.model, rep, instructions, True,
                        production=True, workload=b["workload"], work=b["work"],
                        cfg_root=b["cfg"], overlay=b["overlay"], lock=lock,
                        prices=prices, prompt_path=b["prompt_path"],
                    ))
                for fut in as_completed(futs):
                    rows.append(fut.result())
            partial = sorted(
                rows,
                key=lambda r: (r.get("workload") or 0, r["cell"], r["rep"]),
            )
            (PROD_OUT / "results.partial.json").write_text(
                json.dumps(partial, indent=2) + "\n"
            )
            results_path.write_text(json.dumps(partial, indent=2) + "\n")
        # Append replacement rows to original rows, then regenerate summary/savings/results and per-workload reports.
        rows.sort(key=lambda r: (r.get("workload") or 0, r["cell"], r["rep"]))
        kept = primary_rows(rows)
        if len(kept) != expected_kept:
            raise SystemExit(f"resume final kept {len(kept)} != expected {expected_kept}")
        for cell in cells:
            for n in WORKLOADS:
                cnt = sum(1 for r in kept if r.get("cell") == cell and r.get("workload") == n)
                if cnt != PROD_REPS:
                    raise SystemExit(f"resume block {cell}-w{n} final valid {cnt} != {PROD_REPS}")
        summary, savings = production_report(rows, prices)
        (PROD_OUT / "summary.md").write_text(summary + "\n")
        (PROD_OUT / "savings.md").write_text(savings + "\n")
        (PROD_OUT / "results.json").write_text(json.dumps(rows, indent=2))
        for n in WORKLOADS:
            subset = [r for r in rows if r.get("workload") == n]
            s, sav = production_report(subset, prices)
            (PROD_OUT / f"summary-w{n}.md").write_text(s + "\n")
            (PROD_OUT / f"savings-w{n}.md").write_text(sav + "\n")
        print(savings)
        print(summary)
        H.log("PRODUCTION COMPLETE")
        return
    PROD_OUT.mkdir(parents=True, exist_ok=True)
    archive_generic_artifacts(PROD_PROBE_ARCHIVE)
    archive_generic_artifacts(PROD_OUT)
    cell_map = {name: (name, shim, instr, prompt) for name, shim, instr, prompt in FACTORIAL
                if name in PRIMARY_CELLS}
    wanted = (
        set(PRIMARY_CELLS)
        if args.cells == "ctrl,shim,instr,both"
        else {cell.strip() for cell in args.cells.split(",") if cell.strip()}
    )
    if wanted != set(PRIMARY_CELLS):
        raise SystemExit(
            f"production mode requires cells {list(PRIMARY_CELLS)}, "
            f"got {sorted(wanted)}"
        )
    cells = list(PRIMARY_CELLS)
    fixtures = {}
    for n in WORKLOADS:
        fixtures[n] = ensure_workload_fixture(n)
        H.log(f"fixture w{n} ready at {fixtures[n]}")
    lock = lock_provenance(fixtures, instructions)
    H.log("provenance locked")
    for n, src in fixtures.items():
        rec = smoke_mcp(src, n)
        if not rec.get("passed"):
            raise SystemExit(f"MCP smoke failed for w{n}: {rec}")
        live = tool_provenance() or {}
        if live.get("manifestSha256") != lock.get("manifestSha256"):
            raise SystemExit("manifest sha drifted before measured runs")
        H.log(f"MCP smoke passed w{n}")
    blocks = []
    for cell in cells:
        name, shim, instr, prompt = cell_map[cell]
        for n in WORKLOADS:
            cfg = block_cfg_root(cell, n)
            work = block_workdir(cell, n)
            prepare_profile(cfg, shim, instr, instructions, reuse=False)
            overlay = write_prod_overlay(cfg, xdev=True)
            reset_workdir(fixtures[n], work)
            # Stable prompt outside worktree, scoped by cell+workload; includes nonce
            prompt_path = write_block_prompt(cell, n, str(work), prompt, lock["fixtures"][str(n)]["gitHead"])
            # Do not create PROMPT.txt in worktree
            blocks.append({
                "cell": cell, "shim": shim, "instr": instr, "prompt": prompt,
                "workload": n, "cfg": cfg, "work": work, "overlay": overlay,
                "prompt_path": prompt_path,
            })
    if len(blocks) != len(PRIMARY_CELLS) * len(WORKLOADS):
        raise SystemExit(f"production matrix incomplete: {len(blocks)} blocks")
    for block in blocks:
        label = block_id(block["cell"], block["workload"])
        rec = smoke_mcp(
            block["work"], block["workload"], label=f"work-{label}"
        )
        if not rec.get("passed"):
            raise SystemExit(f"MCP smoke failed for {label}: {rec}")
        H.log(f"MCP smoke passed {label}")
    rows = []
    for wave in range(1, PROD_REPS + 1):
        wave_jobs = list(blocks)
        random.Random(wave).shuffle(wave_jobs)
        H.log(f"wave {wave}/{PROD_REPS} jobs={len(wave_jobs)} workers={jobs_n}")
        with ThreadPoolExecutor(max_workers=max(1, jobs_n)) as pool:
            futs = []
            for b in wave_jobs:
                futs.append(pool.submit(
                    run_one, b["cell"], b["shim"], b["instr"], b["prompt"],
                    args.model, wave, instructions, True,
                    production=True, workload=b["workload"], work=b["work"],
                    cfg_root=b["cfg"], overlay=b["overlay"], lock=lock,
                    prices=prices, prompt_path=b["prompt_path"],
                ))
            for fut in as_completed(futs):
                rows.append(fut.result())
        partial = sorted(
            rows,
            key=lambda r: (r.get("workload") or 0, r["cell"], r["rep"]),
        )
        (PROD_OUT / "results.partial.json").write_text(
            json.dumps(partial, indent=2) + "\n"
        )
    rows.sort(key=lambda r: (r.get("workload") or 0, r["cell"], r["rep"]))
    summary, savings = production_report(rows, prices)
    (PROD_OUT / "summary.md").write_text(summary + "\n")
    (PROD_OUT / "savings.md").write_text(savings + "\n")
    (PROD_OUT / "results.json").write_text(json.dumps(rows, indent=2))
    for n in WORKLOADS:
        subset = [r for r in rows if r.get("workload") == n]
        s, sav = production_report(subset, prices)
        (PROD_OUT / f"summary-w{n}.md").write_text(s + "\n")
        (PROD_OUT / f"savings-w{n}.md").write_text(sav + "\n")
    print(savings)
    print(summary)
    H.log("PRODUCTION COMPLETE")


if __name__ == "__main__":
    main()
