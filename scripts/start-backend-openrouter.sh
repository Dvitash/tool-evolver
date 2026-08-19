#!/usr/bin/env bash
# ==============================================================================
# Tool Evolver - Dev backend against OpenRouter (DeepSeek V4 Flash, low thinking)
#
# Loads OPENROUTER_API_KEY from repo .env, points MODEL_* at OpenRouter, and
# starts the unified cloud backend (HTTP API + worker + scheduler) with logs.
#
# Usage:
#   ./scripts/start-backend-openrouter.sh
# ==============================================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG_DIR="${LOG_DIR:-$ROOT/tmp}"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_FILE:-$LOG_DIR/backend-openrouter.log}"
STAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

log() {
  printf '[%s] %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$*"
}

die() {
  log "ERROR: $*"
  exit 1
}

if [[ ! -f "$ROOT/.env" ]]; then
  die "missing $ROOT/.env (expected OPENROUTER_API_KEY)"
fi

set -a
# shellcheck disable=SC1091
source "$ROOT/.env"
set +a

if [[ -z "${OPENROUTER_API_KEY:-}" && -z "${MODEL_API_KEY:-}" ]]; then
  die "OPENROUTER_API_KEY is not set in .env"
fi

export MODEL_PROVIDER="${MODEL_PROVIDER:-openai-compatible}"
export MODEL_BASE_URL="${MODEL_BASE_URL:-https://openrouter.ai/api/v1}"
export MODEL_API_KEY="${MODEL_API_KEY:-$OPENROUTER_API_KEY}"
export MODEL_ID="${MODEL_ID:-deepseek/deepseek-v4-flash}"
export MODEL_ALLOW_DETERMINISTIC_FALLBACK="${MODEL_ALLOW_DETERMINISTIC_FALLBACK:-false}"
export MODEL_REASONING_ENABLED="${MODEL_REASONING_ENABLED:-true}"
export MODEL_REASONING_EFFORT="${MODEL_REASONING_EFFORT:-low}"
export MODEL_TIMEOUT_MS="${MODEL_TIMEOUT_MS:-120000}"
export LOG_LEVEL="${LOG_LEVEL:-debug}"
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-8080}"

redact() {
  local value="${1:-}"
  if [[ -z "$value" ]]; then
    printf '%s' "(unset)"
    return
  fi
  local n=${#value}
  if (( n <= 8 )); then
    printf '%s' "${value:0:2}***"
    return
  fi
  printf '%s...%s (len=%s)' "${value:0:7}" "${value: -4}" "$n"
}

log "starting cloud backend for OpenRouter inference"
log "log file: $LOG_FILE"
log "MODEL_PROVIDER=$MODEL_PROVIDER"
log "MODEL_BASE_URL=$MODEL_BASE_URL"
log "MODEL_ID=$MODEL_ID"
log "MODEL_API_KEY=$(redact "$MODEL_API_KEY")"
log "MODEL_ALLOW_DETERMINISTIC_FALLBACK=$MODEL_ALLOW_DETERMINISTIC_FALLBACK"
log "MODEL_REASONING_ENABLED=$MODEL_REASONING_ENABLED"
log "MODEL_REASONING_EFFORT=$MODEL_REASONING_EFFORT"
log "LOG_LEVEL=$LOG_LEVEL"
log "listen ${HOST}:${PORT}"

if [[ ! -f "$ROOT/apps/cloud/dist/bin/dev.js" ]]; then
  log "cloud dist missing; building @tool-evolver/cloud"
  pnpm --filter @tool-evolver/cloud build
fi

exec > >(tee -a "$LOG_FILE") 2>&1

log "launching pnpm --filter @tool-evolver/cloud dev"
exec pnpm --filter @tool-evolver/cloud dev
