"""
Backward-compatible entrypoint.

Prefer:
  oc
  python -m opencode_bridge run
  python -m opencode_bridge daemon
"""

from __future__ import annotations

import sys
from pathlib import Path

# Allow `python opencode_monitor.py` without installing package
_ROOT = Path(__file__).resolve().parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from opencode_bridge.runner import run_opencode_with_monitor  # noqa: E402


if __name__ == "__main__":
    extra_args = sys.argv[1:] if len(sys.argv) > 1 else []
    raise SystemExit(run_opencode_with_monitor(extra_args))
