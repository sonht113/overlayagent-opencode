#!/usr/bin/env bash
# Install Login Item (LaunchAgent) for Agent Overlay on macOS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL_ROOT="${AGENT_TOOL_ROOT:-$SCRIPT_DIR}"
OVERLAY_DIR="$TOOL_ROOT/agent-overlay"
LABEL="com.agent.overlay"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
UNINSTALL=0

if [[ "${1:-}" == "--uninstall" || "${1:-}" == "-Uninstall" ]]; then
  UNINSTALL=1
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "install-autostart.sh is for macOS only." >&2
  exit 1
fi

if [[ "$UNINSTALL" -eq 1 ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "[autostart] removed $PLIST"
  exit 0
fi

APP=""
for c in \
  "$OVERLAY_DIR/src-tauri/target/release/bundle/macos/Agent Overlay.app" \
  "$OVERLAY_DIR/src-tauri/target/debug/bundle/macos/Agent Overlay.app"
do
  if [[ -d "$c" ]]; then
    APP="$c"
    break
  fi
done

if [[ -z "$APP" ]]; then
  echo "ERROR: Agent Overlay.app not found. Build first:" >&2
  echo "  cd $OVERLAY_DIR && npm install && npm run tauri build" >&2
  exit 1
fi

mkdir -p "$(dirname "$PLIST")"

# Use open -a so .app launches correctly
cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-a</string>
    <string>${APP}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST" 2>/dev/null || true

echo "[autostart] installed $PLIST"
echo "[autostart] app: $APP"
echo "Uninstall: bash $0 --uninstall"
