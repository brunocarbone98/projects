"""cooldown: the global "do not contact TikTok" window — recording, reading, expiry, a corrupt
file, clearing, the message, the state directory (and the conftest fixture that keeps it out of
~/.dramafetch)."""

from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path

from dramafetch import cooldown as cooldown_module
from dramafetch.cooldown import (
    COOLDOWN_MINUTES,
    STATE_DIR_ENV,
    Cooldown,
    active_cooldown,
    clear_cooldown,
    clock_time,
    cooldown_message,
    cooldown_path,
    cooldown_summary,
    read_cooldown,
    record_block,
    state_dir,
)

NOW = 1_800_000_000.0


def test_the_autouse_fixture_points_the_state_dir_at_tmp_path(tmp_path):
    """tests/conftest.py sets DRAMAFETCH_STATE_DIR for every test, so nothing below — and no CLI
    subprocess a test starts — ever reads or writes the real ~/.dramafetch."""
    assert os.environ[STATE_DIR_ENV] == str(tmp_path)
    assert state_dir() == tmp_path
    assert cooldown_path() == tmp_path / "cooldown.json"
    assert active_cooldown() is None


def test_record_block_writes_the_file_and_active_cooldown_reads_it(tmp_path):
    assert COOLDOWN_MINUTES == 30
    recorded = record_block("HTTP 429 from the video server", "yt-dlp", now=NOW)
    assert recorded == Cooldown(
        until=NOW + 1800, reason="HTTP 429 from the video server", source="yt-dlp", recorded_at=NOW
    )
    assert json.loads((tmp_path / "cooldown.json").read_text("utf-8")) == {
        "until": NOW + 1800,
        "reason": "HTTP 429 from the video server",
        "source": "yt-dlp",
        "recorded_at": NOW,
    }
    assert sorted(p.name for p in tmp_path.iterdir()) == ["cooldown.json"]  # no .tmp left
    assert active_cooldown(now=NOW) == recorded
    assert active_cooldown(now=NOW + 1799) == recorded
    assert active_cooldown(now=NOW + 1800) is None  # expired: the window is over
    assert read_cooldown() == recorded  # the expired record is still readable, just not active
    assert recorded.seconds_left(NOW + 1799.2) == 1 and recorded.minutes_left(NOW + 1799.2) == 1
    assert recorded.seconds_left(NOW) == 1800 and recorded.minutes_left(NOW) == 30
    assert recorded.seconds_left(NOW + 5000) == 0 and recorded.minutes_left(NOW + 5000) == 0
    assert recorded.active(NOW + 1) and not recorded.active(NOW + 1800)


def test_a_newer_refusal_restarts_the_window_and_minutes_can_differ():
    record_block("first", "browser", now=NOW)
    later = record_block("second", "discovery", now=NOW + 600, minutes=10)
    assert active_cooldown(now=NOW + 600) == later
    assert later.until == NOW + 600 + 600 and later.source == "discovery"
    assert active_cooldown(now=NOW + 1300) is None  # 10 minutes, not the first record's 30


def test_a_corrupt_or_unreadable_file_counts_as_no_cooldown(tmp_path):
    path = tmp_path / "cooldown.json"
    for junk in (
        "{not json",
        "[]",
        "null",
        '{"until": "soon"}',
        '{"until": true}',
        '{"until": NaN}',
        '{"until": Infinity}',
        '{"reason": "x"}',
        "",
        b"\xff\xfe\x00".decode("latin-1"),
    ):
        path.write_text(junk, encoding="utf-8")
        assert active_cooldown(now=0.0) is None, junk
        assert read_cooldown() is None, junk
    path.write_bytes(b"\xff\xfe\xfd")  # not UTF-8
    assert active_cooldown(now=0.0) is None
    path.unlink()
    path.mkdir()  # a directory in the way: an OSError on read
    assert active_cooldown(now=0.0) is None
    path.rmdir()
    assert active_cooldown(now=0.0) is None  # missing
    # a record with odd field types still reads: the strings are defaulted
    path.write_text(json.dumps({"until": NOW + 60, "reason": 5, "source": None}), "utf-8")
    assert active_cooldown(now=NOW) == Cooldown(until=NOW + 60, reason="", source="")


def test_clear_cooldown_deletes_the_file_and_is_fine_without_one(tmp_path):
    record_block("x", "web", now=NOW)
    assert (tmp_path / "cooldown.json").exists()
    clear_cooldown()
    assert not (tmp_path / "cooldown.json").exists()
    assert active_cooldown(now=NOW) is None
    clear_cooldown()  # nothing to do, nothing raised


def test_cooldown_message_and_summary(tmp_path):
    recorded = record_block("blocked (HTTP 403): TikTok refused the request", "yt-dlp", now=NOW)
    message = cooldown_message(recorded, now=NOW + 90)
    assert message == (
        f"TikTok refused a request at {clock_time(NOW)} (blocked (HTTP 403): TikTok refused the "
        f"request); DramaFetch waits until {clock_time(NOW + 1800)} (29 min left) before "
        f"contacting TikTok again — delete {tmp_path / 'cooldown.json'} to lift it, at your own "
        "risk"
    )
    assert re.fullmatch(r"\d\d:\d\d", clock_time(NOW))
    assert cooldown_summary(recorded, now=NOW + 90) == (
        f"until {clock_time(NOW + 1800)} (29 min left): blocked (HTTP 403): TikTok refused the "
        "request"
    )
    # a cooldown built by hand (no recorded_at): the refusal is dated 30 minutes before `until`
    by_hand = Cooldown(until=NOW + 1800, reason="r", source="web")
    assert by_hand.recorded_at is None and by_hand.started == NOW
    assert cooldown_message(by_hand, now=NOW).startswith(
        f"TikTok refused a request at {clock_time(NOW)} (r);"
    )
    assert "(30 min left)" in cooldown_message(by_hand, now=NOW)
    assert "(1 min left)" in cooldown_message(by_hand, now=NOW + 1799)
    assert "(0 min left)" in cooldown_message(by_hand, now=NOW + 1800)


def test_the_reason_is_cleaned_and_bounded():
    assert record_block("  too   many\n\nrequests \t", "web", now=NOW).reason == "too many requests"
    assert record_block("", "web", now=NOW).reason == "request refused"
    long = "x" * 500
    cleaned = record_block(long, "web", now=NOW).reason
    assert len(cleaned) == 200 and cleaned.endswith("…")
    assert active_cooldown(now=NOW).reason == cleaned


def test_state_dir_from_the_environment_then_the_home_directory(tmp_path, monkeypatch):
    monkeypatch.setenv(STATE_DIR_ENV, str(tmp_path / "custom state"))
    assert state_dir() == tmp_path / "custom state"
    assert cooldown_path() == tmp_path / "custom state" / "cooldown.json"
    record_block("x", "web", now=NOW)  # the directory is created on demand
    assert (tmp_path / "custom state" / "cooldown.json").is_file()
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv(STATE_DIR_ENV, "~/elsewhere")
    assert state_dir() == tmp_path / "home" / "elsewhere"  # ~ is expanded
    monkeypatch.setenv(STATE_DIR_ENV, "   ")
    assert state_dir() == Path.home() / ".dramafetch" == tmp_path / "home" / ".dramafetch"
    monkeypatch.delenv(STATE_DIR_ENV)
    assert state_dir() == tmp_path / "home" / ".dramafetch"
    assert active_cooldown() is None  # nothing there
    record_block("x", "web", now=NOW)
    assert (tmp_path / "home" / ".dramafetch" / "cooldown.json").is_file()


def test_record_block_survives_an_unwritable_state_dir(tmp_path, monkeypatch, caplog):
    blocker = tmp_path / "file"
    blocker.write_text("not a directory")
    monkeypatch.setenv(STATE_DIR_ENV, str(blocker / "state"))
    with caplog.at_level(logging.WARNING, logger="dramafetch.cooldown"):
        recorded = record_block("x", "web", now=NOW)
    assert recorded.until == NOW + 1800  # the caller still gets the cooldown
    assert any("could not write the cooldown file" in r.getMessage() for r in caplog.records)
    assert active_cooldown(now=NOW) is None  # nothing could be stored; never raises


def test_defaults_use_the_clock():
    before = time.time()
    recorded = record_block("x", "web")
    assert before + 1800 - 1 <= recorded.until <= time.time() + 1800 + 1
    assert active_cooldown() == recorded
    assert cooldown_module.COOLDOWN_SOURCES == ("yt-dlp", "browser", "discovery", "web")
