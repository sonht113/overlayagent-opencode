"""
Lightweight background helper (no heavy deps).

- Ensures overlay is up
- Watches enable/disable flag
- Exposes status file for diagnostics
- Does NOT attach to arbitrary OpenCode processes (use PATH shim for that)

Run:  python -m opencode_bridge daemon
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

from .config import (
    PID_FILE,
    STATE_DIR,
    is_monitoring_enabled,
    is_windows,
    set_monitoring_enabled,
    tool_root,
    write_status,
)
from .emit import check_overlay_health, read_recent_events


def _overlay_start_cmd() -> list[str] | None:
    root = tool_root()
    if is_windows():
        script = root / "start-overlay.ps1"
        if not script.exists():
            return None
        return [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(script),
        ]
    script = root / "start-overlay.sh"
    if not script.exists():
        return None
    return ["bash", str(script)]


def ensure_overlay() -> bool:
    if check_overlay_health():
        return True
    cmd = _overlay_start_cmd()
    if not cmd:
        write_status(
            state="error",
            error="start-overlay script missing (start-overlay.ps1 / .sh)",
        )
        return False
    try:
        subprocess.run(cmd, check=False, timeout=60)
    except Exception as e:
        write_status(state="error", error=str(e))
        return False
    for _ in range(20):
        time.sleep(0.4)
        if check_overlay_health():
            return True
    return check_overlay_health()


def run_daemon(interval: float = 5.0) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    PID_FILE.write_text(str(os.getpid()), encoding="utf-8")
    print(f"[daemon] pid={os.getpid()} state_dir={STATE_DIR}")
    print("[daemon] PATH shim + `oc` drive events; this process keeps overlay alive.")
    print("[daemon] Toggle: python -m opencode_bridge enable|disable")

    try:
        while True:
            enabled = is_monitoring_enabled()
            healthy = check_overlay_health() if enabled else False
            if enabled and not healthy:
                print("[daemon] overlay down — starting…")
                healthy = ensure_overlay()
            write_status(
                state="daemon",
                monitoring_enabled=enabled,
                overlay_healthy=healthy,
                recent=read_recent_events(5),
            )
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\n[daemon] stopped")
    finally:
        try:
            PID_FILE.unlink(missing_ok=True)
        except Exception:
            pass


_BRIDGE_CMDS = frozenset({"daemon", "enable", "disable", "status", "run"})
_BRIDGE_HELP = frozenset({"-h", "--help"})


def main(argv: list[str] | None = None) -> int:
    raw = list(argv if argv is not None else sys.argv[1:])

    from .runner import run_opencode_with_monitor

    # Default / unknown first token → OpenCode args (flags included).
    if not raw or (raw[0] not in _BRIDGE_CMDS and raw[0] not in _BRIDGE_HELP):
        return run_opencode_with_monitor(raw)

    # `run` must not go through argparse — flags like --version would be rejected.
    if raw[0] == "run":
        extra = raw[1:]
        if extra and extra[0] == "--":
            extra = extra[1:]
        return run_opencode_with_monitor(extra)

    p = argparse.ArgumentParser(prog="opencode_bridge")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("daemon", help="Keep overlay alive + status file")
    sub.add_parser("enable", help="Enable event monitoring")
    sub.add_parser("disable", help="Disable event monitoring (kill switch)")
    sub.add_parser("status", help="Print status JSON")
    sub.add_parser("run", help="Run OpenCode with monitor (same as oc)")

    args = p.parse_args(raw)
    cmd = args.cmd

    if cmd == "daemon":
        run_daemon()
        return 0
    if cmd == "enable":
        set_monitoring_enabled(True)
        print("monitoring enabled")
        return 0
    if cmd == "disable":
        set_monitoring_enabled(False)
        print("monitoring disabled")
        return 0
    if cmd == "status":
        from .config import STATUS_FILE, load_config

        print("config:", load_config())
        print("enabled:", is_monitoring_enabled())
        print("overlay:", check_overlay_health())
        if STATUS_FILE.exists():
            print(STATUS_FILE.read_text(encoding="utf-8"))
        print("recent:", read_recent_events(5))
        return 0

    return run_opencode_with_monitor([])


if __name__ == "__main__":
    sys.exit(main())
