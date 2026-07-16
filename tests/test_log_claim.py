"""Unit tests for multi-process log claim registry."""

from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def test_two_bridges_claim_different_logs():
    with tempfile.TemporaryDirectory() as td:
        os.environ["AGENT_BRIDGE_STATE"] = td
        from opencode_bridge import config as cfg

        log_dir = Path(td) / "logs"
        log_dir.mkdir()
        a = log_dir / "a.log"
        b = log_dir / "b.log"
        a.write_text("a\n", encoding="utf-8")
        b.write_text("b\n", encoding="utf-8")

        pid1 = os.getpid()
        pid2 = pid1 + 99999
        assert cfg.claim_log_path(a, bridge_pid=pid1, child_pid=1) is True
        assert cfg.is_log_claimed_by_other(a, bridge_pid=pid1) is False
        assert cfg.is_log_claimed_by_other(a, bridge_pid=pid2) is True

        assert cfg.claim_log_path(a, bridge_pid=pid2, child_pid=2) is False
        assert cfg.claim_log_path(b, bridge_pid=pid2, child_pid=2) is True

        cfg.release_log_claims(pid1)
        assert cfg.is_log_claimed_by_other(a, bridge_pid=pid2) is False
        assert cfg.claim_log_path(a, bridge_pid=pid2, child_pid=2) is True


def test_claim_prefers_newest_in_session_window():
    with tempfile.TemporaryDirectory() as td:
        os.environ["AGENT_BRIDGE_STATE"] = td
        from opencode_bridge import config as cfg
        from opencode_bridge import runner as rn

        log_dir = Path(td) / "oclog"
        log_dir.mkdir()
        rn.LOG_DIR = log_dir

        t0 = time.time()
        older = log_dir / "2026-01-01T000001.log"
        newer = log_dir / "2026-01-01T000002.log"
        older.write_text("old\n", encoding="utf-8")
        time.sleep(0.05)
        newer.write_text("new\n", encoding="utf-8")

        pid1 = os.getpid()
        session_start = t0 - 0.5

        f1 = rn._claim_log_file(session_start, bridge_pid=pid1, child_pid=11)
        assert f1 is not None
        # Newest in window = this process (created after older concurrent file)
        assert f1.name == newer.name

        real_alive = cfg._pid_alive

        def alive(pid: int) -> bool:
            if pid in (pid1, 424242):
                return True
            return real_alive(pid)

        cfg._pid_alive = alive  # type: ignore
        try:
            f2 = rn._claim_log_file(session_start, bridge_pid=424242, child_pid=22)
            assert f2 is not None
            assert f2.resolve() != f1.resolve()
            assert f2.name == older.name
        finally:
            cfg._pid_alive = real_alive  # type: ignore
            cfg.release_log_claims(pid1)
            cfg.release_log_claims(424242)


def test_no_claim_of_pre_session_logs():
    with tempfile.TemporaryDirectory() as td:
        os.environ["AGENT_BRIDGE_STATE"] = td
        from opencode_bridge import runner as rn

        log_dir = Path(td) / "oclog"
        log_dir.mkdir()
        rn.LOG_DIR = log_dir

        old = log_dir / "ancient.log"
        old.write_text("old\n", encoding="utf-8")
        # Make birth/mtime look old relative to a future session_start
        os.utime(old, (time.time() - 3600, time.time() - 3600))

        session_start = time.time()
        f = rn._claim_log_file(session_start, bridge_pid=os.getpid(), child_pid=1)
        assert f is None


def test_better_candidate_when_stale_claim():
    with tempfile.TemporaryDirectory() as td:
        os.environ["AGENT_BRIDGE_STATE"] = td
        from opencode_bridge import runner as rn

        log_dir = Path(td) / "oclog"
        log_dir.mkdir()
        rn.LOG_DIR = log_dir

        t0 = time.time()
        stale = log_dir / "stale.log"
        stale.write_text("stale\n", encoding="utf-8")
        os.utime(stale, (t0 - 100, t0 - 100))

        session_start = time.time()
        time.sleep(0.05)
        fresh = log_dir / "fresh.log"
        fresh.write_text("fresh\n", encoding="utf-8")

        better = rn._better_log_candidate(
            session_start, bridge_pid=os.getpid(), current=stale
        )
        assert better is not None
        assert better.name == fresh.name


if __name__ == "__main__":
    test_two_bridges_claim_different_logs()
    test_claim_prefers_newest_in_session_window()
    test_no_claim_of_pre_session_logs()
    test_better_candidate_when_stale_claim()
    print("log_claim: ok")
