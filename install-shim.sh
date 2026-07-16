#!/usr/bin/env bash
# Install PATH shim so plain `opencode` is monitored (macOS / Linux).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL_ROOT="${AGENT_TOOL_ROOT:-$SCRIPT_DIR}"
SHIM_DIR="$TOOL_ROOT/shim"
STATE_DIR="$TOOL_ROOT/.agent-bridge"
CONFIG_PATH="$STATE_DIR/config.json"
UNINSTALL=0

if [[ "${1:-}" == "--uninstall" || "${1:-}" == "-Uninstall" ]]; then
  UNINSTALL=1
fi

# --- uninstall ---
if [[ "$UNINSTALL" -eq 1 ]]; then
  RC_FILE=""
  if [[ -f "$HOME/.zshrc" ]]; then RC_FILE="$HOME/.zshrc"
  elif [[ -f "$HOME/.bashrc" ]]; then RC_FILE="$HOME/.bashrc"
  fi
  if [[ -n "$RC_FILE" ]]; then
    # shellcheck disable=SC2016
    tmp="$(mktemp)"
    grep -v '# agent-overlay-shim' "$RC_FILE" >"$tmp" || true
    mv "$tmp" "$RC_FILE"
    echo "[shim] removed agent-overlay PATH lines from $RC_FILE"
  fi
  echo "[shim] Restart terminal. Uninstall complete."
  exit 0
fi

mkdir -p "$STATE_DIR" "$SHIM_DIR"
chmod +x "$SHIM_DIR/opencode" 2>/dev/null || true
chmod +x "$TOOL_ROOT/start-overlay.sh" "$TOOL_ROOT/oc.sh" 2>/dev/null || true

# Find real opencode (not our shim)
find_real() {
  local path_no_shim=""
  local p
  IFS=':' read -ra PARTS <<<"${PATH:-}"
  for p in "${PARTS[@]}"; do
    [[ -z "$p" ]] && continue
    [[ "$p" == "$SHIM_DIR" ]] && continue
    if [[ -x "$p/opencode" ]]; then
      echo "$p/opencode"
      return 0
    fi
  done
  # npm global
  if command -v npm >/dev/null 2>&1; then
    local npm_root
    npm_root="$(npm root -g 2>/dev/null || true)"
    if [[ -n "$npm_root" && -x "$npm_root/opencode-ai/bin/opencode" ]]; then
      echo "$npm_root/opencode-ai/bin/opencode"
      return 0
    fi
  fi
  for p in /opt/homebrew/bin/opencode /usr/local/bin/opencode \
           "$HOME/.npm-global/bin/opencode"; do
    if [[ -x "$p" ]]; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

REAL="$(find_real || true)"
if [[ -z "${REAL:-}" ]]; then
  echo "ERROR: OpenCode not found. Install OpenCode first, then re-run." >&2
  exit 1
fi

# Write config
cat >"$CONFIG_PATH" <<EOF
{
  "opencode_cmd": "$REAL",
  "tauri_event_url": "http://127.0.0.1:9876/event",
  "health_url": "http://127.0.0.1:9876/health",
  "enable_tauri_event": true,
  "monitoring_enabled": true
}
EOF
echo "1" >"$STATE_DIR/monitoring.enabled"

# Prepend shim + tool root to shell rc
MARKER="# agent-overlay-shim"
SNIPPET=$(cat <<EOF
$MARKER
export AGENT_TOOL_ROOT="$TOOL_ROOT"
export PATH="$SHIM_DIR:$TOOL_ROOT:\$PATH"
EOF
)

RC_FILE=""
if [[ -n "${ZSH_VERSION:-}" ]] || [[ -f "$HOME/.zshrc" ]]; then
  RC_FILE="$HOME/.zshrc"
elif [[ -f "$HOME/.bashrc" ]]; then
  RC_FILE="$HOME/.bashrc"
else
  RC_FILE="$HOME/.zshrc"
fi

if [[ -f "$RC_FILE" ]] && grep -q 'agent-overlay-shim' "$RC_FILE" 2>/dev/null; then
  echo "[shim] PATH already configured in $RC_FILE"
else
  {
    echo ""
    echo "$SNIPPET"
  } >>"$RC_FILE"
  echo "[shim] prepended to $RC_FILE: $SHIM_DIR"
fi

echo "[shim] real OpenCode: $REAL"
echo "[shim] config: $CONFIG_PATH"
echo ""
echo "Done. Open a NEW terminal (or: source $RC_FILE), then:"
echo "  which opencode    # should show .../shim/opencode first"
echo "  opencode          # monitored session"
echo "  # or: $TOOL_ROOT/oc.sh"
echo ""
echo "Uninstall:  bash $0 --uninstall"
