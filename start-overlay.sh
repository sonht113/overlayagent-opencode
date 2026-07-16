#!/usr/bin/env bash
# Start Agent Overlay (macOS / Linux). Prefers built .app / binary; falls back to tauri dev.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL_ROOT="${AGENT_TOOL_ROOT:-$SCRIPT_DIR}"
OVERLAY_DIR="${OVERLAY_DIR:-$TOOL_ROOT/agent-overlay}"
HEALTH_URL="${AGENT_OVERLAY_HEALTH:-http://127.0.0.1:9876/health}"
FORCE="${1:-}"

health_ok() {
  curl -sf --max-time 1 "$HEALTH_URL" >/dev/null 2>&1
}

if [[ "$FORCE" != "--force" && "$FORCE" != "-Force" ]]; then
  if health_ok; then
    echo "[overlay] already running ($HEALTH_URL)"
    exit 0
  fi
fi

find_binary() {
  local candidates=(
    "$OVERLAY_DIR/src-tauri/target/release/bundle/macos/Agent Overlay.app"
    "$OVERLAY_DIR/src-tauri/target/release/bundle/macos/Agent Overlay.app/Contents/MacOS/agent-overlay"
    "$OVERLAY_DIR/src-tauri/target/release/agent-overlay"
    "$OVERLAY_DIR/src-tauri/target/debug/agent-overlay"
  )
  local c
  for c in "${candidates[@]}"; do
    if [[ -e "$c" ]]; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

start_target() {
  local target
  if ! target="$(find_binary)"; then
    echo "[overlay] no binary found — starting npm run tauri dev"
    if [[ ! -d "$OVERLAY_DIR" ]]; then
      echo "ERROR: Overlay dir not found: $OVERLAY_DIR" >&2
      exit 1
    fi
    (cd "$OVERLAY_DIR" && npm run tauri dev) &
    return 0
  fi

  echo "[overlay] starting $target"
  if [[ "$target" == *.app ]]; then
    open "$target"
  elif [[ -d "$target" && "$target" == *.app ]]; then
    open "$target"
  else
    nohup "$target" >/dev/null 2>&1 &
  fi
}

start_target

i=0
while (( i < 40 )); do
  sleep 0.5
  if health_ok; then
    echo "[overlay] ready"
    exit 0
  fi
  i=$((i + 1))
done

echo "[overlay] started but health check did not pass within 20s" >&2
echo "[overlay] Events may fail until the app finishes booting." >&2
exit 0
