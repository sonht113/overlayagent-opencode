"""
Run OpenCode with a real interactive TUI, while still detecting generation events.

Why: piping stdout (old approach) breaks the OpenCode TUI — you only see
"Running: …opencode" and never enter the app.

Strategy:
  1. Launch the real opencode binary with stdin/stdout inherited (full TUI).
  2. Pass --print-logs so structured logs go to stderr → primary event source.
  3. Fallback: tail this process's log file under ~/.local/share/opencode/log
     only when stderr is quiet, with a multi-process claim registry so two
     concurrent bridges never share the same log.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

from .config import (
    claim_log_path,
    is_log_claimed_by_other,
    is_windows,
    load_config,
    opencode_log_dir,
    release_log_claims,
    subprocess_npm_root,
    write_status,
)
from .db_tokens import SessionTokenPoller
from .detect import GenerationDetector
from .emit import send_event

# Resolved at runtime so OPENCODE_LOG_DIR / platform paths apply after import.
def _log_dir() -> Path:
    return opencode_log_dir()


# Mutable for tests; prefer _log_dir() in production paths.
LOG_DIR = opencode_log_dir()

# Dedup window for identical lines seen on both stderr and log file.
DEDUP_TTL_S = 2.5


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
    bridge_pid = os.getpid()
    force_log_tail = os.environ.get("AGENT_BRIDGE_FORCE_LOG_TAIL", "").strip() in (
        "1",
        "true",
        "yes",
        "on",
    )

    if os.environ.get("AGENT_BRIDGE_VERBOSE", "").strip():
        print(f"Running OpenCode TUI: {full_cmd[0]}", flush=True)
        if user_args:
            print(f"  args: {' '.join(user_args)}", flush=True)
    write_status(state="running_opencode", cmd=full_cmd, bridge_pid=bridge_pid)

    token_poller: SessionTokenPoller | None = None
    poller_lock = threading.Lock()

    def with_bridge_meta(data: dict | None = None) -> dict:
        payload = dict(data or {})
        payload["bridge_pid"] = bridge_pid
        return payload

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
        def _on_tokens(d: dict) -> None:
            send_event(
                "tokens_update",
                with_bridge_meta({**d, "session_id": session_id}),
            )

        with poller_lock:
            if token_poller:
                token_poller.stop()
            token_poller = SessionTokenPoller(session_id, on_tokens=_on_tokens)
            token_poller.start()

    def on_detect_event(event_type: str, data: dict) -> None:
        if event_type == "generation_start":
            send_event(event_type, with_bridge_meta(data))
            start_token_poller(data.get("session_id"))
            return
        if event_type == "generation_end":
            final = stop_token_poller()
            payload = with_bridge_meta(data)
            if final:
                # Prefer DB snapshot over empty log-parsed tokens
                prev = payload.get("final_tokens") or {}
                prev_sum = sum(
                    int(prev.get(k) or 0) for k in ("input", "output", "reasoning")
                )
                final_sum = sum(
                    int(final.get(k) or 0) for k in ("input", "output", "reasoning")
                )
                if final_sum >= prev_sum:
                    payload["final_tokens"] = final
            send_event(event_type, payload)
            return
        if event_type == "tokens_update":
            send_event(event_type, with_bridge_meta(data))
            return
        send_event(event_type, with_bridge_meta(data))

    detector = GenerationDetector(on_event=on_detect_event)
    feed_lock = threading.Lock()
    stop_tails = threading.Event()
    # Capture wall time before Popen so we can prefer log files created by this run.
    session_start = time.time()
    # Dedup fingerprints: line_hash → last_seen_monotonic
    recent_lines: dict[str, float] = {}
    recent_lock = threading.Lock()

    def _line_fp(line: str) -> str:
        # Normalize trailing newline; keep content for dedup across stderr/log
        return hashlib.sha1(line.rstrip("\n").encode("utf-8", errors="replace")).hexdigest()

    def feed_line(line: str, *, source: str = "log") -> None:
        """Feed detector with cross-source dedup (stderr vs log file)."""
        del source  # source kept for call-site clarity / future metrics
        fp = _line_fp(line)
        now = time.monotonic()
        with recent_lock:
            # Prune old entries occasionally
            if len(recent_lines) > 400:
                cutoff = now - DEDUP_TTL_S
                dead = [k for k, t in recent_lines.items() if t < cutoff]
                for k in dead:
                    del recent_lines[k]
            prev = recent_lines.get(fp)
            if prev is not None and (now - prev) < DEDUP_TTL_S:
                return
            recent_lines[fp] = now
        with feed_lock:
            detector.feed(line)

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
        release_log_claims(bridge_pid)
        return 1

    child_pid = process.pid
    write_status(
        state="running_opencode",
        cmd=full_cmd,
        bridge_pid=bridge_pid,
        child_pid=child_pid,
    )

    def read_stderr() -> None:
        assert process.stderr is not None
        try:
            for line in process.stderr:
                feed_line(line, source="stderr")
                if os.environ.get("AGENT_BRIDGE_ECHO_LOGS"):
                    sys.stderr.write(line)
                    sys.stderr.flush()
        except Exception:
            pass

    def tail_log_file() -> None:
        """Follow this process's OpenCode log file (sticky claim + re-claim).

        Always tail the log file. OpenCode often writes structured LLM lines to
        ~/.local/share/opencode/log even when --print-logs is set; stderr alone
        is not reliable (block-buffering on PIPE, early noise, MCP spam).

        Stderr is still fed in parallel; feed_line() dedups identical lines so
        dual sources do not double-fire generation_start.

        Multi-process: registry claim ensures two bridges never share a file.
        If we claimed too early (wrong older file), re-claim a better match.
        """
        log_file: Path | None = None
        log_offset = 0
        claimed = False
        claim_mono = 0.0
        last_reclaim_check = 0.0
        # Wait for child to create its timestamped log (OpenCode can take 1–3s).
        if not force_log_tail:
            stop_tails.wait(0.8)
            if stop_tails.is_set():
                return

        while not stop_tails.is_set():
            try:
                if claimed and log_file is not None and not log_file.exists():
                    claimed = False
                    log_file = None
                    log_offset = 0
                    release_log_claims(bridge_pid)

                now_m = time.monotonic()
                # Re-claim rarely once sticky (every 2s); every loop while unclaimed.
                do_reclaim = (not claimed) or (now_m - last_reclaim_check >= 2.0)
                if do_reclaim:
                    last_reclaim_check = now_m
                    if claimed and log_file is not None:
                        better = _better_log_candidate(
                            session_start,
                            bridge_pid=bridge_pid,
                            current=log_file,
                        )
                        if better is not None and better.resolve() != log_file.resolve():
                            release_log_claims(bridge_pid)
                            if claim_log_path(
                                better, bridge_pid=bridge_pid, child_pid=child_pid
                            ):
                                log_file = better
                                claim_mono = time.monotonic()
                                try:
                                    st = log_file.stat()
                                    created = _file_created_at(log_file)
                                    fresh = created >= session_start - 2.0
                                    log_offset = (
                                        0 if (fresh and st.st_size < 8192) else st.st_size
                                    )
                                except OSError:
                                    log_offset = 0
                                if os.environ.get("AGENT_BRIDGE_VERBOSE", "").strip():
                                    print(
                                        f"[bridge] re-claimed log: {log_file} offset={log_offset}",
                                        file=sys.stderr,
                                        flush=True,
                                    )

                    if not claimed:
                        active = _claim_log_file(
                            session_start,
                            bridge_pid=bridge_pid,
                            child_pid=child_pid,
                        )
                        if active is not None:
                            log_file = active
                            claimed = True
                            claim_mono = time.monotonic()
                            try:
                                st = log_file.stat()
                                created = _file_created_at(log_file)
                                fresh = created >= session_start - 2.0
                                if fresh and st.st_size < 8192:
                                    log_offset = 0
                                else:
                                    log_offset = st.st_size
                            except OSError:
                                log_offset = 0
                            if os.environ.get("AGENT_BRIDGE_VERBOSE", "").strip():
                                print(
                                    f"[bridge] claimed log: {log_file} offset={log_offset}",
                                    file=sys.stderr,
                                    flush=True,
                                )

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
                            feed_line(line + "\n", source="log")
            except Exception:
                pass
            # Poll faster while seeking a claim; slower once sticky.
            stop_tails.wait(0.15 if not claimed else 0.35)

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
            with_bridge_meta(
                {
                    "final_tokens": final or detector.current_tokens.copy(),
                    "session_id": detector.current_session_id,
                    "reason": "process_exit",
                }
            ),
        )
    else:
        stop_token_poller()

    release_log_claims(bridge_pid)
    write_status(
        state="idle",
        last_exit=code,
        bridge_pid=bridge_pid,
        child_pid=child_pid,
    )
    if code and os.environ.get("AGENT_BRIDGE_VERBOSE", "").strip():
        print(f"\nOpenCode exited with code {code}", flush=True)
    return code if code is not None else 0


def _latest_log_file() -> Path | None:
    log_dir = LOG_DIR if LOG_DIR else _log_dir()
    if not log_dir.exists():
        return None
    files = _list_log_files()
    return files[0] if files else None


def _list_log_files() -> list[Path]:
    log_dir = LOG_DIR if LOG_DIR else _log_dir()
    if not log_dir.exists():
        return []
    files: list[Path] = []
    for p in log_dir.glob("*.log"):
        try:
            if p.is_file():
                files.append(p)
        except OSError:
            continue
    # Newest mtime first; tie-break by name (timestamped filenames)
    files.sort(key=lambda p: (p.stat().st_mtime, p.name), reverse=True)
    return files


def _file_created_at(path: Path) -> float:
    """Best-effort file creation time (birthtime on macOS, else ctime)."""
    st = path.stat()
    return float(getattr(st, "st_birthtime", None) or st.st_ctime)


def _log_candidates_in_window(
    session_start: float,
    *,
    bridge_pid: int,
    skew: float = 2.0,
    claim_window: float = 30.0,
) -> list[tuple[float, Path]]:
    """Unclaimed logs born near session_start, newest-first by creation time."""
    files = _list_log_files()
    out: list[tuple[float, Path]] = []
    for p in files:
        try:
            if is_log_claimed_by_other(p, bridge_pid):
                continue
            created = _file_created_at(p)
            if session_start - skew <= created <= session_start + claim_window:
                out.append((created, p))
        except OSError:
            continue
    # Newest created first — our process's file is the one created at/after start,
    # not an older concurrent file that happens to fall in the window.
    out.sort(key=lambda t: t[0], reverse=True)
    return out


def _better_log_candidate(
    session_start: float,
    *,
    bridge_pid: int,
    current: Path,
) -> Path | None:
    """Return a better log than *current* if a newer session-born file exists."""
    try:
        cur_created = _file_created_at(current)
    except OSError:
        cur_created = 0.0

    # Current is stale if it was born well before we launched.
    current_stale = cur_created < session_start - 2.0

    for created, p in _log_candidates_in_window(session_start, bridge_pid=bridge_pid):
        try:
            if p.resolve() == current.resolve():
                continue
        except OSError:
            if p == current:
                continue
        # Prefer strictly newer-created file in our window, or any in-window
        # file when current is pre-session.
        if created > cur_created + 0.05 or current_stale:
            return p
    return None


def _claim_log_file(
    session_start: float,
    *,
    bridge_pid: int,
    child_pid: int | None = None,
) -> Path | None:
    """Pick the log file for *this* OpenCode process, not a stale global newest.

    Preference order:
      1. Among *.log created near session_start and not claimed by another live
         bridge, pick the *newest* created after start (this process's file).
      2. Stable name opencode.log if recently modified for this session
      3. No blind claim of pre-session logs (returns None until a real match)
    """
    created_in_window = _log_candidates_in_window(
        session_start, bridge_pid=bridge_pid
    )
    for _, candidate in created_in_window:
        if claim_log_path(candidate, bridge_pid=bridge_pid, child_pid=child_pid):
            return candidate

    log_dir = LOG_DIR if LOG_DIR else _log_dir()
    stable = log_dir / "opencode.log"
    if stable.exists() and stable.is_file():
        try:
            if (
                not is_log_claimed_by_other(stable, bridge_pid)
                and stable.stat().st_mtime >= session_start - 2.0
            ):
                if claim_log_path(stable, bridge_pid=bridge_pid, child_pid=child_pid):
                    return stable
        except OSError:
            pass

    # Do NOT claim arbitrary oldest/newest pre-session logs — that was the
    # multi-process regression (bridge stuck on another process's file).
    return None


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
