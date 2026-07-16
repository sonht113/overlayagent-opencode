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


def write_status(**fields) -> None:
    payload = {"updated_at": __import__("datetime").datetime.now().isoformat()}
    payload.update(fields)
    try:
        STATUS_FILE.write_text(
            json.dumps(payload, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception:
        pass


def platform_name() -> str:
    return platform.system().lower()
