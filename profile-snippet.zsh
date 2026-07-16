# Agent Overlay helpers — add to ~/.zshrc (set path first if needed):
#   export AGENT_TOOL_ROOT=/path/to/Tool
#   source $AGENT_TOOL_ROOT/profile-snippet.zsh

if [[ -z "${AGENT_TOOL_ROOT:-}" ]]; then
  # When sourced as: source /abs/path/profile-snippet.zsh
  if [[ -n "${ZSH_VERSION:-}" ]]; then
    _snippet="${(%):-%x}"
  else
    _snippet="${BASH_SOURCE[0]:-$0}"
  fi
  if [[ -f "$_snippet" ]]; then
    export AGENT_TOOL_ROOT="$(cd "$(dirname "$_snippet")" && pwd)"
  fi
fi

if [[ -z "${AGENT_TOOL_ROOT:-}" || ! -d "$AGENT_TOOL_ROOT/opencode_bridge" ]]; then
  echo "[agent-overlay] Set AGENT_TOOL_ROOT to your Tool repo root" >&2
  return 0 2>/dev/null || true
fi

export PATH="$AGENT_TOOL_ROOT/shim:$AGENT_TOOL_ROOT:$PATH"
export PYTHONPATH="${AGENT_TOOL_ROOT}${PYTHONPATH:+:$PYTHONPATH}"

oc() {
  bash "$AGENT_TOOL_ROOT/oc.sh" "$@"
}

start-agent-overlay() {
  bash "$AGENT_TOOL_ROOT/start-overlay.sh" "$@"
}

enable-agent-monitor() {
  (cd "$AGENT_TOOL_ROOT" && python3 -m opencode_bridge enable)
}

disable-agent-monitor() {
  (cd "$AGENT_TOOL_ROOT" && python3 -m opencode_bridge disable)
}

get-agent-status() {
  (cd "$AGENT_TOOL_ROOT" && python3 -m opencode_bridge status)
}
