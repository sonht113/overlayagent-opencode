"""HTTP emit to Agent Overlay + local event log.

IMPORTANT: Do NOT print to stdout/stderr during OpenCode TUI sessions —
console prints overwrite the chat UI. Logging goes to last_events.jsonl only
unless AGENT_BRIDGE_VERBOSE=1.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from datetime import datetime
from typing import Any

from .config import LAST_EVENTS_FILE, is_monitoring_enabled, load_config

_MAX_LOG_LINES = 50


def _verbose() -> bool:
    return os.environ.get("AGENT_BRIDGE_VERBOSE", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _vprint(msg: str) -> None:
    """Only print when verbose — never touch the TUI console by default."""
    if _verbose():
        # Use stderr so it is less likely to sit in the TUI main pane if echoed
        print(msg, file=sys.stderr, flush=True)


def send_event_to_tauri(
    event_type: str,
    data: dict | None = None,
    *,
    quiet: bool = True,
) -> bool:
    """POST event to Tauri. Returns True on success. Quiet by default (TUI-safe)."""
    if not is_monitoring_enabled():
        if not quiet:
            _vprint(f"[TAURI] skip (monitoring disabled): {event_type}")
        _log_local(event_type, data or {}, ok=False, error="monitoring_disabled")
        return False

    cfg = load_config()
    if not cfg.get("enable_tauri_event", True):
        return False

    payload = {
        "event": event_type,
        "timestamp": datetime.now().isoformat(),
        "data": data or {},
    }
    url = cfg["tauri_event_url"]

    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=2):
            pass
        if not quiet:
            _vprint(f"[TAURI] Sent event: {event_type}")
        _log_local(event_type, data or {}, ok=True)
        return True
    except Exception as e:
        if not quiet:
            _vprint(f"[TAURI] Failed to send event '{event_type}': {e}")
        _log_local(event_type, data or {}, ok=False, error=str(e))
        return False


def send_event(event_type: str, data: dict | None = None) -> bool:
    """POST to Tauri + local log. No console output unless AGENT_BRIDGE_VERBOSE=1."""
    if _verbose():
        ts = datetime.now().strftime("%H:%M:%S")
        if data:
            _vprint(f"[{ts}] [EVENT] {event_type} → {data}")
        else:
            _vprint(f"[{ts}] [EVENT] {event_type}")
    # Always quiet console path; file log still written inside send_event_to_tauri
    return send_event_to_tauri(event_type, data, quiet=not _verbose())


def check_overlay_health() -> bool:
    cfg = load_config()
    url = cfg.get("health_url", "http://127.0.0.1:9876/health")
    try:
        with urllib.request.urlopen(url, timeout=1) as resp:
            return 200 <= resp.status < 300
    except Exception:
        return False


def _log_local(
    event_type: str,
    data: dict[str, Any],
    *,
    ok: bool,
    error: str | None = None,
) -> None:
    line = {
        "ts": datetime.now().isoformat(),
        "event": event_type,
        "ok": ok,
        "data": data,
    }
    if error:
        line["error"] = error
    try:
        with LAST_EVENTS_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(line, ensure_ascii=False) + "\n")
        _trim_log()
    except Exception:
        pass


def _trim_log() -> None:
    try:
        lines = LAST_EVENTS_FILE.read_text(encoding="utf-8").splitlines()
        if len(lines) > _MAX_LOG_LINES:
            LAST_EVENTS_FILE.write_text(
                "\n".join(lines[-_MAX_LOG_LINES:]) + "\n",
                encoding="utf-8",
            )
    except Exception:
        pass


def read_recent_events(limit: int = 10) -> list[dict]:
    if not LAST_EVENTS_FILE.exists():
        return []
    try:
        lines = LAST_EVENTS_FILE.read_text(encoding="utf-8").splitlines()
        out = []
        for line in lines[-limit:]:
            try:
                out.append(json.loads(line))
            except Exception:
                pass
        return out
    except Exception:
        return []
