"""Parse OpenCode stdout/stderr/log lines → generation lifecycle events."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable

TOKEN_PATTERN = re.compile(
    r"tokens\.(input|output|reasoning|cache\.read|cache\.write)=(\d+)"
)
# Any provider (xai, aibox, opencode, …). Skip title/small streams when possible.
STREAM_START_PATTERN = re.compile(
    r"message=stream\s+providerID=(\S+)\s+modelID=(\S+)"
)
END_MARKERS = ("exiting loop", "disposing instance")


def parse_structured_line(line: str) -> dict:
    result: dict[str, str] = {}
    for part in line.split():
        if "=" in part:
            key, value = part.split("=", 1)
            result[key.strip()] = value.strip().strip('"')
    return result


EventCallback = Callable[[str, dict], None]


@dataclass
class GenerationDetector:
    """Stateful line scanner for OpenCode structured logs."""

    on_event: EventCallback
    is_generating: bool = False
    current_tokens: dict = field(
        default_factory=lambda: {"input": 0, "output": 0, "reasoning": 0}
    )

    def feed(self, line: str) -> None:
        parsed = parse_structured_line(line)

        # Start: primary stream, not the tiny "title" / small helper call
        m = STREAM_START_PATTERN.search(line)
        if not self.is_generating and m:
            if "small=true" in line:
                return
            self.is_generating = True
            sid = (
                parsed.get("session.id")
                or parsed.get("sessionID")
                or parsed.get("session_id")
            )
            self.on_event(
                "generation_start",
                {
                    "provider": m.group(1) or parsed.get("providerID"),
                    "model": m.group(2) or parsed.get("modelID"),
                    "session_id": sid,
                },
            )

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

        if self.is_generating and any(m in line for m in END_MARKERS):
            self.is_generating = False
            self.on_event(
                "generation_end",
                {
                    "final_tokens": self.current_tokens.copy(),
                    "session_id": parsed.get("session.id"),
                },
            )
            self.current_tokens = {"input": 0, "output": 0, "reasoning": 0}
