"""Regression tests for live token poller (thread-safe SQLite access)."""

from __future__ import annotations

import json
import sqlite3
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from opencode_bridge.db_tokens import (  # noqa: E402
    SessionTokenPoller,
    TokenSnap,
    read_live_tokens,
    read_session_totals,
)


def _make_db(path: Path) -> None:
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE session (
            id TEXT PRIMARY KEY,
            tokens_input INTEGER DEFAULT 0,
            tokens_output INTEGER DEFAULT 0,
            tokens_reasoning INTEGER DEFAULT 0,
            tokens_cache_read INTEGER DEFAULT 0,
            tokens_cache_write INTEGER DEFAULT 0
        );
        CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE TABLE part (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        """
    )
    con.execute(
        """
        INSERT INTO session (
            id, tokens_input, tokens_output, tokens_reasoning,
            tokens_cache_read, tokens_cache_write
        ) VALUES (?, 100, 50, 10, 0, 0)
        """,
        ("ses_test",),
    )
    # Compact JSON — matches OpenCode storage and LIKE '%"role":"assistant"%'
    msg_data = json.dumps(
        {
            "role": "assistant",
            "tokens": {
                "input": 20,
                "output": 40,
                "reasoning": 5,
                "cache": {"read": 0, "write": 0},
            },
        },
        separators=(",", ":"),
    )
    con.execute(
        """
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES (?, ?, 1, 100, ?)
        """,
        ("msg_1", "ses_test", msg_data),
    )
    part_data = json.dumps(
        {"type": "text", "text": "hello world " * 20},
        separators=(",", ":"),
    )
    con.execute(
        """
        INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES (?, ?, ?, 1, 100, ?)
        """,
        ("part_1", "msg_1", "ses_test", part_data),
    )
    con.commit()
    con.close()


def test_read_session_totals(tmp_path: Path | None = None):
    base = tmp_path if tmp_path is not None else Path("/tmp")
    db = base / "opencode_test.db"
    if tmp_path is None:
        db = Path(__file__).parent / "_tmp_opencode_tokens.db"
    if db.exists():
        db.unlink()
    _make_db(db)
    snap = read_session_totals("ses_test", db)
    assert snap is not None
    assert snap.output == 50
    assert snap.reasoning == 10
    if tmp_path is None and db.exists():
        db.unlink()


def test_read_live_tokens(tmp_path: Path | None = None):
    if tmp_path is None:
        db = Path(__file__).parent / "_tmp_opencode_tokens2.db"
    else:
        db = tmp_path / "opencode_test.db"
    if db.exists():
        db.unlink()
    _make_db(db)
    baseline = TokenSnap(input=100, output=50, reasoning=10)
    live = read_live_tokens("ses_test", baseline, db)
    assert live is not None
    # message tokens + stream estimate from text part
    assert live.output >= 40
    assert live.intensity_total() > 0
    if tmp_path is None and db.exists():
        db.unlink()


def test_poller_emits_from_other_thread(tmp_path: Path | None = None):
    """
    Core regression: start poller on main thread; DB reads run on worker.

    Previously a process-global sqlite connection created on main made the
    poller thread raise ProgrammingError (check_same_thread) and emit nothing.
    """
    if tmp_path is None:
        db = Path(__file__).parent / "_tmp_opencode_poller.db"
    else:
        db = tmp_path / "opencode_poller.db"
    if db.exists():
        db.unlink()
    _make_db(db)

    received: list[dict] = []
    lock = threading.Lock()

    def on_tokens(d: dict) -> None:
        with lock:
            received.append(d)

    # Construct + start from main (same pattern as detect → runner)
    poller = SessionTokenPoller(
        "ses_test",
        on_tokens=on_tokens,
        interval=0.15,
        db=db,
    )
    poller.start()
    deadline = time.time() + 2.0
    while time.time() < deadline:
        with lock:
            if received:
                break
        time.sleep(0.05)
    snap = poller.stop()

    with lock:
        n = len(received)
        first = received[0] if received else None

    assert n >= 1, f"poller emitted 0 tokens_update (thread-safety regression); snap={snap}"
    assert first is not None
    assert int(first.get("output") or 0) + int(first.get("reasoning") or 0) > 0
    assert snap is not None
    assert snap.intensity_total() > 0

    if tmp_path is None and db.exists():
        db.unlink()


def test_poller_sees_updates(tmp_path: Path | None = None):
    if tmp_path is None:
        db = Path(__file__).parent / "_tmp_opencode_poller2.db"
    else:
        db = tmp_path / "opencode_poller2.db"
    if db.exists():
        db.unlink()
    _make_db(db)

    received: list[dict] = []

    def on_tokens(d: dict) -> None:
        received.append(d)

    poller = SessionTokenPoller(
        "ses_test", on_tokens=on_tokens, interval=0.12, db=db
    )
    poller.start()
    time.sleep(0.4)

    # Grow assistant message tokens mid-flight
    con = sqlite3.connect(db)
    msg_data = json.dumps(
        {
            "role": "assistant",
            "tokens": {
                "input": 30,
                "output": 200,
                "reasoning": 20,
                "cache": {"read": 0, "write": 0},
            },
        },
        separators=(",", ":"),
    )
    con.execute(
        "UPDATE message SET data = ?, time_updated = 200 WHERE id = ?",
        (msg_data, "msg_1"),
    )
    con.commit()
    con.close()

    deadline = time.time() + 2.0
    saw_growth = False
    while time.time() < deadline:
        if any(int(r.get("output") or 0) >= 200 for r in received):
            saw_growth = True
            break
        time.sleep(0.05)
    poller.stop()

    assert saw_growth, f"never saw grown output in {received!r}"
    if tmp_path is None and db.exists():
        db.unlink()


if __name__ == "__main__":
    # Standalone runner (no pytest required)
    test_read_session_totals()
    test_read_live_tokens()
    test_poller_emits_from_other_thread()
    test_poller_sees_updates()
    print("db_tokens: ok")
