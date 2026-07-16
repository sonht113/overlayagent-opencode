"""HTTP emit to Agent Overlay + local event log.

IMPORTANT: Do NOT print to stdout/stderr during OpenCode TUI sessions —
console prints overwrite the chat UI. Logging goes to last_events.jsonl only
unless AGENT_BRIDGE_VERBOSE=1.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import urllib.request
from datetime import datetime
from typing import Any

from .config import LAST_EVENTS_FILE, is_monitoring_enabled, load_config

_MAX_LOG_LINES = 50
_TRIM_EVERY_N = 20
_CONFIG_TTL_S = 5.0
_HTTP_TIMEOUT_S = 0.6
_TOKEN_COALESCE_S = 0.25

_cfg_lock = threading.Lock()
_cfg_cache: dict | None = None
_cfg_at = 0.0

_log_write_count = 0
_log_count_lock = threading.Lock()

_token_lock = threading.Lock()
_pending_tokens: dict | None = None
_token_flush_at = 0.0
_token_timer: threading.Timer | None = None


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
        print(msg, file=sys.stderr, flush=True)


def _cached_config() -> dict:
    global _cfg_cache, _cfg_at
    now = time.monotonic()
    with _cfg_lock:
        if _cfg_cache is not None and (now - _cfg_at) < _CONFIG_TTL_S:
            return _cfg_cache
        _cfg_cache = load_config()
        _cfg_at = now
        return _cfg_cache


def invalidate_config_cache() -> None:
    global _cfg_cache, _cfg_at
    with _cfg_lock:
        _cfg_cache = None
        _cfg_at = 0.0


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

    cfg = _cached_config()
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
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_S):
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


def _flush_pending_tokens() -> None:
    global _pending_tokens, _token_timer, _token_flush_at
    with _token_lock:
        data = _pending_tokens
        _pending_tokens = None
        _token_timer = None
        _token_flush_at = 0.0
    if data is not None:
        send_event_to_tauri("tokens_update", data, quiet=not _verbose())


def send_event(event_type: str, data: dict | None = None) -> bool:
    """POST to Tauri + local log. Coalesces tokens_update; quiet unless verbose."""
    if _verbose():
        ts = datetime.now().strftime("%H:%M:%S")
        if data:
            _vprint(f"[{ts}] [EVENT] {event_type} → {data}")
        else:
            _vprint(f"[{ts}] [EVENT] {event_type}")

    # Coalesce high-frequency token ticks so overlay/HTTP stay light
    if event_type == "tokens_update":
        global _pending_tokens, _token_timer, _token_flush_at
        with _token_lock:
            _pending_tokens = dict(data or {})
            now = time.monotonic()
            if _token_timer is None:
                delay = _TOKEN_COALESCE_S
                _token_flush_at = now + delay
                _token_timer = threading.Timer(delay, _flush_pending_tokens)
                _token_timer.daemon = True
                _token_timer.start()
            # else: latest payload wins when timer fires
        return True

    # Flush any pending tokens before lifecycle events so order stays sensible
    if event_type in ("generation_start", "generation_end"):
        with _token_lock:
            timer = _token_timer
        if timer is not None:
            try:
                timer.cancel()
            except Exception:
                pass
            _flush_pending_tokens()

    return send_event_to_tauri(event_type, data, quiet=not _verbose())


def check_overlay_health() -> bool:
    cfg = _cached_config()
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
    global _log_write_count
    # Skip local audit for routine token ticks (keeps disk quiet)
    if event_type == "tokens_update" and ok:
        return
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
        with _log_count_lock:
            _log_write_count += 1
            n = _log_write_count
        if n % _TRIM_EVERY_N == 0:
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
