"""
Read live token usage from OpenCode's SQLite DB.

OpenCode INFO logs no longer emit incremental tokens.* during stream.
Session/message tables in ~/.local/share/opencode/opencode.db do.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


def default_db_path() -> Path:
    env = os.environ.get("OPENCODE_DB", "").strip()
    if env:
        return Path(env).expanduser()
    return Path.home() / ".local" / "share" / "opencode" / "opencode.db"


@dataclass
class TokenSnap:
    input: int = 0
    output: int = 0
    reasoning: int = 0
    cache_read: int = 0
    cache_write: int = 0
    source: str = "none"

    def as_dict(self) -> dict:
        return {
            "input": self.input,
            "output": self.output,
            "reasoning": self.reasoning,
            "cache_read": self.cache_read,
            "cache_write": self.cache_write,
            "source": self.source,
        }

    def intensity_total(self) -> int:
        """Value used for warp intensity / token counter (output + reasoning)."""
        return max(0, self.output) + max(0, self.reasoning)

    def key(self) -> tuple:
        return (
            self.input,
            self.output,
            self.reasoning,
            self.cache_read,
            self.cache_write,
        )


def _connect(db: Path) -> sqlite3.Connection | None:
    if not db.exists():
        return None
    try:
        con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True, timeout=1.0)
        con.execute("PRAGMA query_only=ON")
        return con
    except Exception:
        return None


def read_session_totals(session_id: str | None, db: Path | None = None) -> TokenSnap | None:
    if not session_id:
        return None
    path = db or default_db_path()
    con = _connect(path)
    if not con:
        return None
    try:
        row = con.execute(
            """
            SELECT tokens_input, tokens_output, tokens_reasoning,
                   tokens_cache_read, tokens_cache_write
            FROM session WHERE id = ?
            """,
            (session_id,),
        ).fetchone()
        if not row:
            return None
        return TokenSnap(
            input=int(row[0] or 0),
            output=int(row[1] or 0),
            reasoning=int(row[2] or 0),
            cache_read=int(row[3] or 0),
            cache_write=int(row[4] or 0),
            source="session",
        )
    except Exception:
        return None
    finally:
        con.close()


def _part_stream_chars(con: sqlite3.Connection, message_id: str) -> tuple[int, int]:
    """Return (text_chars, reasoning_chars) for a message's parts."""
    text_c = 0
    reason_c = 0
    try:
        rows = con.execute(
            "SELECT data FROM part WHERE message_id = ?",
            (message_id,),
        ).fetchall()
    except Exception:
        return 0, 0
    for (pdata,) in rows:
        try:
            p = json.loads(pdata)
        except Exception:
            continue
        t = p.get("type")
        if t == "text":
            text_c += len(p.get("text") or "")
        elif t == "reasoning":
            reason_c += len(p.get("text") or p.get("content") or "")
    return text_c, reason_c


def read_live_tokens(
    session_id: str | None,
    baseline: TokenSnap | None = None,
    db: Path | None = None,
) -> TokenSnap | None:
    """
    Best-effort live tokens for the active generation turn.

    Priority:
      1. Latest assistant message.tokens (when OpenCode fills them)
      2. Stream estimate from growing text/reasoning parts (~chars/4)
      3. Session totals delta since generation_start baseline
    """
    if not session_id:
        return None
    path = db or default_db_path()
    con = _connect(path)
    if not con:
        return None

    try:
        msg = con.execute(
            """
            SELECT id, data FROM message
            WHERE session_id = ? AND data LIKE '%"role":"assistant"%'
            ORDER BY time_updated DESC LIMIT 1
            """,
            (session_id,),
        ).fetchone()

        msg_snap = TokenSnap(source="message")
        text_c = reason_c = 0
        if msg:
            mid, data = msg
            try:
                obj = json.loads(data)
                tok = obj.get("tokens") or {}
                cache = tok.get("cache") or {}
                msg_snap = TokenSnap(
                    input=int(tok.get("input") or 0),
                    output=int(tok.get("output") or 0),
                    reasoning=int(tok.get("reasoning") or 0),
                    cache_read=int(cache.get("read") or tok.get("cache_read") or 0),
                    cache_write=int(cache.get("write") or tok.get("cache_write") or 0),
                    source="message",
                )
            except Exception:
                pass
            text_c, reason_c = _part_stream_chars(con, mid)

        # ~4 chars/token rough estimate for mid-stream growth
        est_out = max(0, text_c // 4)
        est_reason = max(0, reason_c // 4)

        session = read_session_totals(session_id, path)
        delta = TokenSnap(source="session_delta")
        if session and baseline:
            delta = TokenSnap(
                input=max(0, session.input - baseline.input),
                output=max(0, session.output - baseline.output),
                reasoning=max(0, session.reasoning - baseline.reasoning),
                cache_read=max(0, session.cache_read - baseline.cache_read),
                cache_write=max(0, session.cache_write - baseline.cache_write),
                source="session_delta",
            )

        # Merge: prefer real message tokens, grow with stream estimate, floor with session delta
        out = max(msg_snap.output, est_out, delta.output)
        reasoning = max(msg_snap.reasoning, est_reason, delta.reasoning)
        inp = max(msg_snap.input, delta.input)

        # If everything still zero, return None so we don't spam empty updates
        if out == 0 and reasoning == 0 and inp == 0:
            # still emit tiny stream estimate if any chars
            if text_c or reason_c:
                return TokenSnap(
                    output=max(1, est_out),
                    reasoning=est_reason,
                    source="stream_est",
                )
            return None

        source = "hybrid"
        if msg_snap.output or msg_snap.reasoning:
            source = "message+stream" if (est_out or est_reason) else "message"
        elif est_out or est_reason:
            source = "stream_est"
        elif delta.intensity_total() > 0:
            source = "session_delta"

        return TokenSnap(
            input=inp,
            output=out,
            reasoning=reasoning,
            cache_read=max(msg_snap.cache_read, delta.cache_read),
            cache_write=max(msg_snap.cache_write, delta.cache_write),
            source=source,
        )
    except Exception:
        return None
    finally:
        con.close()


class SessionTokenPoller:
    """Background poller → tokens_update while generating."""

    def __init__(
        self,
        session_id: str,
        on_tokens: Callable[[dict], None],
        interval: float = 0.4,
        db: Path | None = None,
    ):
        self.session_id = session_id
        self.on_tokens = on_tokens
        self.interval = interval
        self.db = db or default_db_path()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._baseline: TokenSnap | None = None
        self._last_key: tuple | None = None

    def start(self) -> None:
        self._baseline = read_session_totals(self.session_id, self.db)
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="oc-token-poll", daemon=True
        )
        self._thread.start()

    def stop(self) -> TokenSnap | None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.5)
        self._thread = None
        return self.snapshot()

    def snapshot(self) -> TokenSnap | None:
        return read_live_tokens(self.session_id, self._baseline, self.db)

    def _loop(self) -> None:
        # Immediate first sample after a short delay (message row appears)
        self._stop.wait(0.15)
        while not self._stop.is_set():
            try:
                snap = read_live_tokens(self.session_id, self._baseline, self.db)
                if snap and snap.key() != self._last_key:
                    self._last_key = snap.key()
                    self.on_tokens(snap.as_dict())
            except Exception:
                pass
            self._stop.wait(self.interval)
