"""Parse OpenCode stdout/stderr/log lines → generation lifecycle events."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable

TOKEN_PATTERN = re.compile(
    r"tokens\.(input|output|reasoning|cache\.read|cache\.write)=(\d+)"
)

# Legacy: message=stream providerID=… modelID=…
STREAM_START_LEGACY = re.compile(
    r"message=stream\s+providerID=(\S+)\s+modelID=(\S+)"
)

# OpenCode ≥1.15: service=llm providerID=… modelID=… … stream
# Example:
#   INFO … service=llm providerID=xai modelID=grok-4.5 session.id=ses_… small=false … stream
STREAM_START_LLM = re.compile(
    r"service=llm\b.*?\bproviderID=(\S+)\s+modelID=(\S+)\b"
)

# End of a generation loop (session-scoped when session.id present)
END_MARKERS = (
    "exiting loop",
    "type=session.idle",
    "session.idle",
)

# Process/instance teardown — only end if we have no better session match
HARD_END_MARKERS = (
    "disposing instance",
)


def parse_structured_line(line: str) -> dict:
    result: dict[str, str] = {}
    for part in line.split():
        if "=" in part:
            key, value = part.split("=", 1)
            result[key.strip()] = value.strip().strip('"')
    return result


def _session_id(parsed: dict) -> str | None:
    return (
        parsed.get("session.id")
        or parsed.get("sessionID")
        or parsed.get("session_id")
        or None
    )


def _match_stream_start(line: str) -> re.Match[str] | None:
    """Return match with group(1)=provider, group(2)=model, or None."""
    m = STREAM_START_LEGACY.search(line)
    if m:
        return m
    # New format: must look like an llm stream line (token "stream" present)
    if "service=llm" not in line:
        return None
    # Require stream token (word boundary) so we don't match unrelated llm lines
    if not re.search(r"(?:^|\s)stream(?:\s|$)", line) and not line.rstrip().endswith(
        "stream"
    ):
        return None
    return STREAM_START_LLM.search(line)


def _is_abort_end(line: str) -> bool:
    """User cancel / aborted generation mid-stream."""
    if "error=Aborted" in line or " error=Aborted" in line:
        return True
    if "service=session.prompt" in line and re.search(r"(?:^|\s)cancel(?:\s|$)", line):
        return True
    return False


EventCallback = Callable[[str, dict], None]


@dataclass
class GenerationDetector:
    """Stateful line scanner for OpenCode structured logs.

    One detector per bridge process. Tracks a single active generation at a
    time (typical TUI use). Overlay multi-process support comes from multiple
    bridge processes each with their own detector + bridge_pid.
    """

    on_event: EventCallback
    is_generating: bool = False
    current_tokens: dict = field(
        default_factory=lambda: {"input": 0, "output": 0, "reasoning": 0}
    )
    current_session_id: str | None = None

    def feed(self, line: str) -> None:
        parsed = parse_structured_line(line)

        # Start: primary stream, not the tiny "title" / small helper call
        m = _match_stream_start(line)
        if m and "small=true" not in line:
            sid = _session_id(parsed)
            # New stream while already generating:
            # - same session → agent step loop; keep generating (no re-start)
            # - different session / none → end previous then start
            if self.is_generating:
                if sid and self.current_session_id and sid == self.current_session_id:
                    return
                self._emit_end(sid or self.current_session_id, reason="superseded")
            self.is_generating = True
            self.current_session_id = sid
            self.current_tokens = {"input": 0, "output": 0, "reasoning": 0}
            self.on_event(
                "generation_start",
                {
                    "provider": m.group(1) or parsed.get("providerID"),
                    "model": m.group(2) or parsed.get("modelID"),
                    "session_id": sid,
                },
            )
            return

        token_matches = TOKEN_PATTERN.findall(line)
        if token_matches:
            updated = False
            for key, value in token_matches:
                key = key.replace("cache.", "cache_")
                new_val = int(value)
                if self.current_tokens.get(key, 0) != new_val:
                    self.current_tokens[key] = new_val
                    updated = True
            if updated and self.is_generating:
                self.on_event("tokens_update", self.current_tokens.copy())

        if not self.is_generating:
            return

        sid = _session_id(parsed)

        # Soft ends: prefer matching current session when id is present
        if any(marker in line for marker in END_MARKERS):
            if sid and self.current_session_id and sid != self.current_session_id:
                return
            self._emit_end(sid or self.current_session_id, reason="loop_end")
            return

        if _is_abort_end(line):
            if sid and self.current_session_id and sid != self.current_session_id:
                return
            self._emit_end(sid or self.current_session_id, reason="abort")
            return

        if any(marker in line for marker in HARD_END_MARKERS):
            self._emit_end(self.current_session_id, reason="dispose")

    def _emit_end(self, session_id: str | None, *, reason: str) -> None:
        if not self.is_generating:
            return
        self.is_generating = False
        self.on_event(
            "generation_end",
            {
                "final_tokens": self.current_tokens.copy(),
                "session_id": session_id or self.current_session_id,
                "reason": reason,
            },
        )
        self.current_tokens = {"input": 0, "output": 0, "reasoning": 0}
        self.current_session_id = None
