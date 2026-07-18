"""Unit tests for GenerationDetector multi-session lifecycle."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from opencode_bridge.detect import GenerationDetector  # noqa: E402


def _collect():
    events: list[tuple[str, dict]] = []

    def on_event(etype: str, data: dict) -> None:
        events.append((etype, data))

    return events, GenerationDetector(on_event=on_event)


def test_stream_start_and_exiting_loop():
    events, det = _collect()
    det.feed(
        "INFO service=llm providerID=xai modelID=grok-4.5 "
        "session.id=ses_aaa small=false agent=build stream\n"
    )
    assert det.is_generating
    assert events[-1][0] == "generation_start"
    assert events[-1][1]["session_id"] == "ses_aaa"
    assert events[-1][1]["provider"] == "xai"

    det.feed("INFO service=session.prompt session.id=ses_aaa exiting loop\n")
    assert not det.is_generating
    assert events[-1][0] == "generation_end"
    assert events[-1][1]["session_id"] == "ses_aaa"


def test_skip_small_title_stream():
    events, det = _collect()
    det.feed(
        "INFO service=llm providerID=aibox modelID=deepseek "
        "session.id=ses_aaa small=true agent=title stream\n"
    )
    assert not det.is_generating
    assert events == []


def test_same_session_step_does_not_restart():
    events, det = _collect()
    line = (
        "INFO service=llm providerID=xai modelID=grok-4.5 "
        "session.id=ses_aaa small=false stream\n"
    )
    det.feed(line)
    det.feed(line)  # next agent step
    starts = [e for e in events if e[0] == "generation_start"]
    assert len(starts) == 1
    assert det.is_generating


def test_other_session_end_ignored():
    events, det = _collect()
    det.feed(
        "INFO service=llm providerID=xai modelID=grok-4.5 "
        "session.id=ses_aaa small=false stream\n"
    )
    det.feed("INFO service=session.prompt session.id=ses_bbb exiting loop\n")
    assert det.is_generating
    ends = [e for e in events if e[0] == "generation_end"]
    assert ends == []


def test_session_idle_ends():
    events, det = _collect()
    det.feed(
        "INFO service=llm providerID=xai modelID=grok-4.5 "
        "session.id=ses_aaa small=false stream\n"
    )
    det.feed("INFO service=bus type=session.idle publishing\n")
    assert not det.is_generating
    assert events[-1][0] == "generation_end"


def test_abort_ends():
    events, det = _collect()
    det.feed(
        "INFO service=llm providerID=xai modelID=grok-4.5 "
        "session.id=ses_aaa small=false stream\n"
    )
    det.feed(
        "ERROR service=session.processor session.id=ses_aaa "
        "messageID=msg_x error=Aborted process\n"
    )
    assert not det.is_generating
    assert events[-1][1].get("reason") == "abort"


def test_supersede_ends_old_session():
    """When a new session starts mid-gen, end must reference the old sid."""
    events, det = _collect()
    det.feed(
        "INFO service=llm providerID=xai modelID=grok-4.5 "
        "session.id=ses_old small=false stream\n"
    )
    det.feed(
        "INFO service=llm providerID=xai modelID=grok-4.5 "
        "session.id=ses_new small=false stream\n"
    )
    ends = [e for e in events if e[0] == "generation_end"]
    starts = [e for e in events if e[0] == "generation_start"]
    assert len(starts) == 2
    assert len(ends) == 1
    assert ends[0][1]["session_id"] == "ses_old"
    assert ends[0][1]["reason"] == "superseded"
    assert starts[1][1]["session_id"] == "ses_new"
    assert det.current_session_id == "ses_new"
    assert det.is_generating


if __name__ == "__main__":
    test_stream_start_and_exiting_loop()
    test_skip_small_title_stream()
    test_same_session_step_does_not_restart()
    test_other_session_end_ignored()
    test_session_idle_ends()
    test_abort_ends()
    test_supersede_ends_old_session()
    print("detect: ok")
