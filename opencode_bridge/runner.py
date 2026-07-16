"""
Run OpenCode with a real interactive TUI, while still detecting generation events.

Why: piping stdout (old approach) breaks the OpenCode TUI — you only see
"Running: …opencode" and never enter the app.

Strategy:
  1. Launch the real opencode binary with stdin/stdout inherited (full TUI).
  2. Pass --print-logs so structured logs go to stderr → we parse them.
  3. Fallback: tail ~/.local/share/opencode/log if stderr is quiet.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path

from .config import is_windows, load_config, subprocess_npm_root, write_status
from .db_tokens import SessionTokenPoller
from .detect import GenerationDetector
from .emit import send_event

LOG_DIR = Path.home() / ".local" / "share" / "opencode" / "log"


def get_opencode_cmd() -> list[str]:
    """Resolve to the real OpenCode binary (not the PATH shim)."""
    for key in ("OPENCODE_REAL", "OPENCODE_CMD"):
        raw = os.environ.get(key)
        if raw:
            resolved = _resolve_binary(Path(raw))
            if resolved:
                return [str(resolved)]

    cfg = load_config()
    path = Path(cfg["opencode_cmd"])
    resolved = _resolve_binary(path)
    if resolved:
        return [str(resolved)]

    # Last resort: which, skipping shim dir
    found = _which_opencode_skipping_shim()
    if found:
        return [str(found)]

    print(
        "ERROR: OpenCode binary not found.\n"
        "  Install OpenCode, then run install-shim (Windows .ps1 / macOS .sh)\n"
        "  or set OPENCODE_CMD / OPENCODE_REAL.",
        file=sys.stderr,
    )
    sys.exit(1)


def _which_opencode_skipping_shim() -> Path | None:
    shim = os.environ.get("AGENT_OPENCODE_SHIM_DIR", "").rstrip("\\/")
    path_env = os.environ.get("PATH", "")
    if shim:
        parts = [p for p in path_env.split(os.pathsep) if p and p.rstrip("\\/") != shim]
        path_env = os.pathsep.join(parts)
    found = shutil.which("opencode", path=path_env)
    if found:
        return Path(found)
    return None


def _resolve_binary(path: Path) -> Path | None:
    if not path:
        return None

    path = path.expanduser()

    # Windows: prefer .exe
    if is_windows():
        if path.suffix.lower() == ".exe" and path.exists():
            return path
        if path.exists():
            sibling = (
                path.parent / "node_modules" / "opencode-ai" / "bin" / "opencode.exe"
            )
            if sibling.exists():
                return sibling
            # .cmd / path as last resort
            return path
        appdata = os.environ.get("APPDATA", "")
        if appdata:
            default_exe = (
                Path(appdata)
                / "npm"
                / "node_modules"
                / "opencode-ai"
                / "bin"
                / "opencode.exe"
            )
            if default_exe.exists():
                return default_exe
        return None

    # macOS / Linux: bare binary or script
    if path.exists() and path.is_file():
        # If this is our shim, try harder
        if path.name == "opencode" and "shim" in path.parts:
            alt = _which_opencode_skipping_shim()
            if alt and alt != path:
                return alt
        return path

    # npm global package bin
    root = subprocess_npm_root()
    if root:
        cand = Path(root) / "opencode-ai" / "bin" / "opencode"
        if cand.exists():
            return cand

    for cand in (
        Path("/opt/homebrew/bin/opencode"),
        Path("/usr/local/bin/opencode"),
        Path.home() / ".npm-global" / "bin" / "opencode",
    ):
        if cand.exists():
            return cand

    return _which_opencode_skipping_shim()


def run_opencode_with_monitor(extra_args: list[str] | None = None) -> int:
    cmd = get_opencode_cmd()
    user_args = list(extra_args or [])

    log_flags: list[str] = []
    if "--print-logs" not in user_args:
        log_flags.append("--print-logs")
    if not any(a == "--log-level" or a.startswith("--log-level=") for a in user_args):
        log_flags.extend(["--log-level", "INFO"])

    full_cmd = cmd + log_flags + user_args

    if os.environ.get("AGENT_BRIDGE_VERBOSE", "").strip():
        print(f"Running OpenCode TUI: {full_cmd[0]}", flush=True)
        if user_args:
            print(f"  args: {' '.join(user_args)}", flush=True)
    write_status(state="running_opencode", cmd=full_cmd)

    token_poller: SessionTokenPoller | None = None
    poller_lock = threading.Lock()

    def stop_token_poller() -> dict | None:
        nonlocal token_poller
        with poller_lock:
            p = token_poller
            token_poller = None
        if not p:
            return None
        snap = p.stop()
        return snap.as_dict() if snap else None

    def start_token_poller(session_id: str | None) -> None:
        nonlocal token_poller
        if not session_id:
            return
        with poller_lock:
            if token_poller:
                token_poller.stop()
            token_poller = SessionTokenPoller(
                session_id,
                on_tokens=lambda d: send_event("tokens_update", d),
            )
            token_poller.start()

    def on_detect_event(event_type: str, data: dict) -> None:
        if event_type == "generation_start":
            send_event(event_type, data)
            start_token_poller(data.get("session_id"))
            return
        if event_type == "generation_end":
            final = stop_token_poller()
            payload = dict(data or {})
            if final:
                # Prefer DB snapshot over empty log-parsed tokens
                prev = payload.get("final_tokens") or {}
                prev_sum = sum(
                    int(prev.get(k) or 0)
                    for k in ("input", "output", "reasoning")
                )
                final_sum = sum(
                    int(final.get(k) or 0)
                    for k in ("input", "output", "reasoning")
                )
                if final_sum >= prev_sum:
                    payload["final_tokens"] = final
            send_event(event_type, payload)
            return
        if event_type == "tokens_update":
            # Log-based updates (rare); DB poller is primary
            send_event(event_type, data)
            return
        send_event(event_type, data)

    detector = GenerationDetector(on_event=on_detect_event)
    stop_tails = threading.Event()

    log_file = _latest_log_file()
    log_offset = log_file.stat().st_size if log_file and log_file.exists() else 0

    try:
        process = subprocess.Popen(
            full_cmd,
            stdin=None,
            stdout=None,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=_child_env(),
        )
    except OSError as e:
        print(f"ERROR: failed to start OpenCode: {e}", file=sys.stderr)
        return 1

    def read_stderr() -> None:
        assert process.stderr is not None
        try:
            for line in process.stderr:
                detector.feed(line)
                if os.environ.get("AGENT_BRIDGE_ECHO_LOGS"):
                    sys.stderr.write(line)
                    sys.stderr.flush()
        except Exception:
            pass

    def tail_log_file() -> None:
        nonlocal log_file, log_offset
        while not stop_tails.is_set():
            try:
                active = LOG_DIR / "opencode.log"
                if active.exists():
                    log_file = active
                elif log_file is None or not log_file.exists():
                    log_file = _latest_log_file()
                    log_offset = 0

                if log_file and log_file.exists():
                    size = log_file.stat().st_size
                    if size < log_offset:
                        log_offset = 0
                    if size > log_offset:
                        with log_file.open("r", encoding="utf-8", errors="replace") as f:
                            f.seek(log_offset)
                            chunk = f.read()
                            log_offset = f.tell()
                        for line in chunk.splitlines():
                            detector.feed(line + "\n")
            except Exception:
                pass
            stop_tails.wait(0.25)

    t_err = threading.Thread(target=read_stderr, name="oc-stderr", daemon=True)
    t_log = threading.Thread(target=tail_log_file, name="oc-logtail", daemon=True)
    t_err.start()
    t_log.start()

    code = process.wait()
    stop_tails.set()
    t_err.join(timeout=1.0)
    t_log.join(timeout=1.0)

    if detector.is_generating:
        final = stop_token_poller()
        send_event(
            "generation_end",
            {
                "final_tokens": final
                or detector.current_tokens.copy(),
                "reason": "process_exit",
            },
        )
    else:
        stop_token_poller()

    write_status(state="idle", last_exit=code)
    if code and os.environ.get("AGENT_BRIDGE_VERBOSE", "").strip():
        print(f"\nOpenCode exited with code {code}", flush=True)
    return code if code is not None else 0


def _latest_log_file() -> Path | None:
    if not LOG_DIR.exists():
        return None
    files = sorted(LOG_DIR.glob("*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
    return files[0] if files else None


def _child_env() -> dict:
    """Strip shim dir from PATH so nested tools find the real opencode if needed."""
    env = os.environ.copy()
    shim = env.get("AGENT_OPENCODE_SHIM_DIR")
    if shim:
        shim_n = shim.rstrip("\\/")
        parts = [
            p
            for p in env.get("PATH", "").split(os.pathsep)
            if p and p.rstrip("\\/") != shim_n
        ]
        env["PATH"] = os.pathsep.join(parts)
    real = env.get("OPENCODE_REAL")
    if real:
        env["OPENCODE_CMD"] = real
    return env
