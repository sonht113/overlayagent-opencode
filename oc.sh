#!/usr/bin/env bash
# One-command OpenCode + Agent Overlay (macOS / Linux).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export AGENT_TOOL_ROOT="${AGENT_TOOL_ROOT:-$SCRIPT_DIR}"
HEALTH_URL="${AGENT_OVERLAY_HEALTH:-http://127.0.0.1:9876/health}"
START_OVERLAY="$AGENT_TOOL_ROOT/start-overlay.sh"

health_ok() {
  curl -sf --max-time 1 "$HEALTH_URL" >/dev/null 2>&1
}

if ! health_ok; then
  echo "[oc] Overlay not detected - starting..."
  if [[ -x "$START_OVERLAY" ]]; then
    bash "$START_OVERLAY" || true
  else
    bash "$START_OVERLAY" || true
  fi
  for _ in $(seq 1 20); do
    sleep 0.4
    if health_ok; then break; fi
  done
  if ! health_ok; then
    echo "[oc] WARNING: Overlay health still failing - events may be dropped." >&2
  fi
else
  echo "[oc] Overlay OK"
fi

PY=""
if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "ERROR: Python not found (tried python3, python)" >&2
  exit 1
fi

cd "$AGENT_TOOL_ROOT"
export PYTHONPATH="${AGENT_TOOL_ROOT}${PYTHONPATH:+:$PYTHONPATH}"
echo "[oc] OpenCode via monitor..."
exec "$PY" -m opencode_bridge run "$@"
