"""Logic tests mirroring overlay session key resolution (Python port)."""

from __future__ import annotations


def session_key_from_event(data: dict) -> str:
    sid = str(data.get("session_id") or "").strip()
    pid = str(data.get("bridge_pid") if data.get("bridge_pid") is not None else "").strip()
    if sid and pid:
        return f"{pid}:{sid}"
    if sid:
        return f"sid:{sid}"
    if pid:
        return f"pid:{pid}"
    return "anon"


def resolve_key(active: dict, meta: dict) -> str | None:
    exact = session_key_from_event(meta)
    if exact in active:
        return exact
    sid = str(meta.get("session_id") or "").strip()
    pid = str(meta.get("bridge_pid") if meta.get("bridge_pid") is not None else "").strip()
    entries = list(active.items())
    if sid:
        by_sid = [(k, s) for k, s in entries if str(s.get("session_id") or "") == sid]
        if len(by_sid) == 1:
            return by_sid[0][0]
        if len(by_sid) > 1 and pid:
            for k, s in by_sid:
                if str(s.get("bridge_pid") or "") == pid:
                    return k
    if pid:
        by_pid = [(k, s) for k, s in entries if str(s.get("bridge_pid") or "") == pid]
        if len(by_pid) == 1:
            return by_pid[0][0]
    return None


def test_two_sessions_end_only_matching():
    active = {
        "111:ses_a": {"session_id": "ses_a", "bridge_pid": 111, "tokens": 10},
        "222:ses_b": {"session_id": "ses_b", "bridge_pid": 222, "tokens": 20},
    }
    key = resolve_key(active, {"session_id": "ses_a", "bridge_pid": 111})
    assert key == "111:ses_a"
    del active[key]
    assert "222:ses_b" in active
    # Must NOT fall back to sole remaining when key mismatch
    key2 = resolve_key(active, {"session_id": "ses_missing", "bridge_pid": 999})
    assert key2 is None
    assert len(active) == 1


def test_key_prefers_pid_and_sid():
    assert session_key_from_event({"session_id": "ses_a", "bridge_pid": 5}) == "5:ses_a"
    assert session_key_from_event({"bridge_pid": 5}) == "pid:5"
    assert session_key_from_event({}) == "anon"


if __name__ == "__main__":
    test_two_sessions_end_only_matching()
    test_key_prefers_pid_and_sid()
    print("session_keys: ok")
