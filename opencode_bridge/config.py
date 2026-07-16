"""Shared configuration for the OpenCode bridge (Windows + macOS + Linux)."""

from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

_PACKAGE_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _PACKAGE_DIR.parent


def is_windows() -> bool:
    return sys.platform == "win32"


def is_macos() -> bool:
    return sys.platform == "darwin"


def opencode_data_dir() -> Path:
    """OpenCode user data root (DB, logs, …).

    Override: OPENCODE_DATA_DIR.
    Prefer an existing dir among common layouts (XDG + Windows LocalAppData).
    """
    env = os.environ.get("OPENCODE_DATA_DIR", "").strip()
    if env:
        return Path(env).expanduser()

    home = Path.home()
    xdg = home / ".local" / "share" / "opencode"
    candidates: list[Path] = [xdg]
    if is_windows():
        local = os.environ.get("LOCALAPPDATA", "").strip()
        if local:
            candidates.insert(0, Path(local) / "opencode")
        candidates.append(home / "AppData" / "Local" / "opencode")
    for c in candidates:
        try:
            if c.is_dir():
                return c
        except OSError:
            continue
    return xdg


def opencode_log_dir() -> Path:
    """Directory of OpenCode structured log files. Override: OPENCODE_LOG_DIR."""
    env = os.environ.get("OPENCODE_LOG_DIR", "").strip()
    if env:
        return Path(env).expanduser()
    return opencode_data_dir() / "log"


def tool_root() -> Path:
    env = os.environ.get("AGENT_TOOL_ROOT", "").strip()
    if env:
        return Path(env).expanduser().resolve()
    return _REPO_ROOT


def subprocess_npm_root() -> str | None:
    try:
        r = subprocess.run(
            ["npm", "root", "-g"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    except Exception:
        pass
    return None


def _default_opencode_guess() -> str:
    if os.environ.get("OPENCODE_CMD"):
        return os.environ["OPENCODE_CMD"]

    which = shutil.which("opencode")
    if which:
        return which

    if is_windows():
        appdata = os.environ.get("APPDATA", "")
        if appdata:
            for rel in (
                Path("npm") / "node_modules" / "opencode-ai" / "bin" / "opencode.exe",
                Path("npm") / "opencode.cmd",
            ):
                p = Path(appdata) / rel
                if p.exists():
                    return str(p)
    else:
        candidates: list[Path] = []
        root = subprocess_npm_root()
        if root:
            candidates.append(Path(root) / "opencode-ai" / "bin" / "opencode")
        home = Path.home()
        candidates.extend(
            [
                home / ".npm-global" / "bin" / "opencode",
                Path("/opt/homebrew/bin/opencode"),
                Path("/usr/local/bin/opencode"),
            ]
        )
        for p in candidates:
            if p.exists():
                return str(p)

    return "opencode"


TOOL_ROOT = tool_root()
STATE_DIR = Path(
    os.environ.get("AGENT_BRIDGE_STATE", str(TOOL_ROOT / ".agent-bridge"))
).expanduser()
STATE_DIR.mkdir(parents=True, exist_ok=True)

CONFIG_PATH = STATE_DIR / "config.json"
ENABLED_FLAG = STATE_DIR / "monitoring.enabled"
PID_FILE = STATE_DIR / "daemon.pid"
STATUS_FILE = STATE_DIR / "status.json"
LOG_CLAIMS_FILE = STATE_DIR / "log_claims.json"
LAST_EVENTS_FILE = STATE_DIR / "last_events.jsonl"

DEFAULTS = {
    "opencode_cmd": _default_opencode_guess(),
    "tauri_event_url": os.environ.get(
        "TAURI_EVENT_URL", "http://127.0.0.1:9876/event"
    ),
    "health_url": os.environ.get(
        "AGENT_OVERLAY_HEALTH", "http://127.0.0.1:9876/health"
    ),
    "enable_tauri_event": True,
    "monitoring_enabled": True,
}


def load_config() -> dict:
    cfg = dict(DEFAULTS)
    # Prefer live tool_root for config path when AGENT_TOOL_ROOT set after import
    root = tool_root()
    state = Path(
        os.environ.get("AGENT_BRIDGE_STATE", str(root / ".agent-bridge"))
    ).expanduser()
    cfg_path = state / "config.json"
    if cfg_path.exists():
        try:
            data = json.loads(cfg_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                cfg.update(data)
        except Exception:
            pass
    elif CONFIG_PATH.exists():
        try:
            data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                cfg.update(data)
        except Exception:
            pass
    if os.environ.get("OPENCODE_CMD"):
        cfg["opencode_cmd"] = os.environ["OPENCODE_CMD"]
    if os.environ.get("TAURI_EVENT_URL"):
        cfg["tauri_event_url"] = os.environ["TAURI_EVENT_URL"]
    return cfg


def save_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(
        json.dumps(cfg, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def is_monitoring_enabled() -> bool:
    """Kill-switch: delete monitoring.enabled or write '0' to disable."""
    if not ENABLED_FLAG.exists():
        set_monitoring_enabled(True)
        return True
    try:
        text = ENABLED_FLAG.read_text(encoding="utf-8").strip().lower()
        return text not in ("0", "false", "off", "disabled", "no")
    except Exception:
        return True


def set_monitoring_enabled(on: bool) -> None:
    ENABLED_FLAG.write_text("1" if on else "0", encoding="utf-8")


def _state_dir() -> Path:
    root = tool_root()
    return Path(
        os.environ.get("AGENT_BRIDGE_STATE", str(root / ".agent-bridge"))
    ).expanduser()


def _atomic_write_json(path: Path, payload: dict) -> None:
    """Write JSON via temp file + replace (best-effort atomic on POSIX/NT)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(payload, indent=2, ensure_ascii=False)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(data, encoding="utf-8")
        os.replace(tmp, path)
    except Exception:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass
        path.write_text(data, encoding="utf-8")


def _state_lock_path(name: str) -> Path:
    return _state_dir() / f".{name}.lock"


def _with_state_lock(name: str, fn):
    """Cross-process exclusive lock around status/claims mutations."""
    state = _state_dir()
    state.mkdir(parents=True, exist_ok=True)
    lock_path = _state_lock_path(name)
    # Exclusive create; spin briefly if another bridge holds the lock
    deadline = __import__("time").monotonic() + 2.0
    while True:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            if __import__("time").monotonic() >= deadline:
                # Stale lock: take over so we never wedge forever
                try:
                    lock_path.unlink(missing_ok=True)
                except TypeError:
                    try:
                        if lock_path.exists():
                            lock_path.unlink()
                    except OSError:
                        pass
                except OSError:
                    pass
                try:
                    fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                    break
                except FileExistsError:
                    return fn()
            __import__("time").sleep(0.02)
        except OSError:
            return fn()
    try:
        os.write(fd, str(os.getpid()).encode("ascii", errors="replace"))
        return fn()
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            lock_path.unlink(missing_ok=True)
        except TypeError:
            try:
                if lock_path.exists():
                    lock_path.unlink()
            except OSError:
                pass
        except OSError:
            pass


def write_status(**fields) -> None:
    """Update status.json. Concurrent bridges store under bridges[pid]."""

    def _write() -> None:
        state = _state_dir()
        state.mkdir(parents=True, exist_ok=True)
        path = state / "status.json"
        now = __import__("datetime").datetime.now().isoformat()
        payload: dict = {"updated_at": now}
        try:
            if path.exists():
                existing = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(existing, dict):
                    payload = existing
        except Exception:
            pass

        bridges = payload.get("bridges")
        if not isinstance(bridges, dict):
            bridges = {}

        bridge_pid = fields.get("bridge_pid")
        if bridge_pid is not None:
            bridges[str(bridge_pid)] = {"updated_at": now, **fields}
            payload["bridges"] = bridges
            payload["updated_at"] = now
            payload["latest_bridge_pid"] = bridge_pid
            for k, v in fields.items():
                if k != "bridge_pid":
                    payload[k] = v
        else:
            payload.update(fields)
            payload["updated_at"] = now

        cleaned: dict = {}
        for pid_s, info in bridges.items():
            try:
                pid_i = int(pid_s)
            except (TypeError, ValueError):
                continue
            if _pid_alive(pid_i):
                cleaned[pid_s] = info
        payload["bridges"] = cleaned
        try:
            _atomic_write_json(path, payload)
        except Exception:
            pass

    _with_state_lock("status", _write)


def _pid_alive_windows(pid: int) -> bool:
    """Liveness without TerminateProcess. os.kill on Win32 is not a probe."""
    import ctypes
    from ctypes import wintypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259
    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        # Fallback: PROCESS_QUERY_INFORMATION for older Windows
        handle = kernel32.OpenProcess(0x0400, False, pid)
    if not handle:
        return False
    try:
        code = wintypes.DWORD()
        if kernel32.GetExitCodeProcess(handle, ctypes.byref(code)) == 0:
            return False
        return int(code.value) == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if is_windows():
        try:
            return _pid_alive_windows(pid)
        except Exception:
            return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def load_log_claims() -> dict:
    """Map log_path → claim metadata for concurrent bridge isolation."""
    path = _state_dir() / "log_claims.json"
    try:
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def save_log_claims(claims: dict) -> None:
    try:
        _atomic_write_json(_state_dir() / "log_claims.json", claims)
    except Exception:
        pass


def claim_log_path(
    log_path: Path,
    *,
    bridge_pid: int,
    child_pid: int | None = None,
) -> bool:
    """Claim a log file for this bridge. Returns True if we own it.

    Another live bridge that already claimed the same path blocks us.
    Dead bridge claims are overwritten. A bridge may only hold one log.
    """
    try:
        key = str(log_path.resolve())
    except OSError:
        key = str(log_path)

    result = {"ok": False}

    def _claim() -> None:
        claims = load_log_claims()
        final: dict = {}
        for k, meta in claims.items():
            if not isinstance(meta, dict):
                continue
            try:
                owner_i = int(meta.get("bridge_pid"))
            except (TypeError, ValueError):
                continue
            if owner_i == bridge_pid:
                continue
            if _pid_alive(owner_i):
                final[k] = meta

        existing = final.get(key)
        if existing is not None:
            try:
                owner = int(existing.get("bridge_pid"))
            except (TypeError, ValueError):
                owner = -1
            if owner != bridge_pid and _pid_alive(owner):
                result["ok"] = False
                return

        final[key] = {
            "bridge_pid": bridge_pid,
            "child_pid": child_pid,
            "claimed_at": __import__("datetime").datetime.now().isoformat(),
            "log": key,
        }
        save_log_claims(final)
        result["ok"] = True

    _with_state_lock("log_claims", _claim)
    return bool(result["ok"])


def release_log_claims(bridge_pid: int) -> None:
    def _release() -> None:
        claims = load_log_claims()
        next_claims = {
            k: v
            for k, v in claims.items()
            if not (isinstance(v, dict) and v.get("bridge_pid") == bridge_pid)
        }
        save_log_claims(next_claims)

    _with_state_lock("log_claims", _release)


def is_log_claimed_by_other(log_path: Path, bridge_pid: int) -> bool:
    key = str(log_path.resolve()) if log_path.exists() else str(log_path)
    claims = load_log_claims()
    meta = claims.get(key)
    if not isinstance(meta, dict):
        return False
    try:
        owner = int(meta.get("bridge_pid"))
    except (TypeError, ValueError):
        return False
    if owner == bridge_pid:
        return False
    return _pid_alive(owner)


def platform_name() -> str:
    return platform.system().lower()

