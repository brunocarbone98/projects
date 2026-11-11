"""Assertions shared by the end-to-end scenarios: politeness (one request at a time), the media
requests' headers, `Range` only after a cut, and the report's privacy and shape."""

from __future__ import annotations

import itertools
import json
import re
from pathlib import Path
from typing import Any

import pytest

from extension_harness import CHROMIUM
from fake_sites import FAKE_SESSDATA, FakeSites, RequestRecord

#: Every browser scenario module: skipped without a Chromium (failed under
#: `STREAMFETCH_REQUIRE_TOOLS=1`, see `conftest.pytest_runtest_setup`).
NEEDS_CHROMIUM = pytest.mark.skipif(not CHROMIUM.is_file(), reason=f"no Chromium at {CHROMIUM}")
#: Signatures and tokens the fake sites put in query strings: a report holding one leaked a query.
QUERY_MARKERS = ("deadline=", "upsig=", "sign=", "sec=", "gen=", "dmTs=", "mirror=")
#: The cookie values the scenarios set; no report, no row, no history may hold one.
SECRET_COOKIE = "streamfetch-test-secret-cookie-value-42"


def assert_sequential(records: list[RequestRecord]) -> None:
    """No two requests overlapped on the server: each started after the previous one ended."""
    ordered = sorted(records, key=lambda r: r.started)
    for earlier, later in itertools.pairwise(ordered):
        assert later.started >= earlier.finished, (
            f"{later.method} {later.path} started before {earlier.path} was answered"
        )


def assert_one_at_a_time(entries: list[dict[str, Any]]) -> None:
    """The app page's own requests (Resource Timing) never overlapped."""
    for earlier, later in itertools.pairwise(entries):
        assert later["start"] >= earlier["end"], f"{later['name']} overlapped {earlier['name']}"


def assert_media_headers(sites: FakeSites, records: list[RequestRecord]) -> None:
    """Every media request carries the fake site's `Referer` and no `Origin` (the extension's
    declarativeNetRequest session rule in test mode)."""
    assert records, "no media request to check"
    for record in records:
        assert record.referer == sites.expected_referer(record.site), (record.path, record.referer)
        assert record.origin is None, (record.path, record.origin)
        assert "origin" not in record.header_names, record.path


def assert_range_only_after_cut(records: list[RequestRecord]) -> int:
    """For the media requests of one site, in order: a request with `Range` follows a cut answer
    of the same file, asks from where the cut left (`bytes=<n>-`, 0 < n <= the bytes sent), and no
    other request carries `Range`. The number of resumed requests."""
    resumed = 0
    last: dict[str, RequestRecord] = {}
    for record in sorted(records, key=lambda r: r.started):
        previous = last.get(record.path)
        if record.range is not None:
            match = re.fullmatch(r"bytes=(\d+)-", record.range)
            assert match, f"{record.path}: Range {record.range!r}"
            assert previous is not None and previous.cut, f"{record.path}: Range without a cut"
            assert 0 < int(match[1]) <= previous.sent_bytes, (record.range, previous.sent_bytes)
            assert record.status == 206, (record.path, record.status)
            resumed += 1
        last[record.path] = record
    return resumed


def load_report(path: Path) -> dict[str, Any]:
    report: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return report


def assert_report_private(path: Path) -> None:
    """The report holds no cookie value, no query string of a signed URL, no request header."""
    text = path.read_text(encoding="utf-8")
    for secret in (FAKE_SESSDATA, SECRET_COOKIE, "SESSDATA="):
        assert secret not in text, f"{path.name} holds a cookie ({secret[:8]}…)"
    for marker in QUERY_MARKERS:
        assert marker not in text, f"{path.name} holds a query string ({marker})"
    lowered = text.lower()
    for header in ('"cookie"', '"authorization"', '"referer"', "set-cookie"):
        assert header not in lowered, f"{path.name} holds a request header ({header})"


def assert_report_shape(report: dict[str, Any]) -> None:
    """Spec 6 `lib/report.js`: the top-level keys and every row's keys."""
    assert report["report_version"] == 1
    for key in ("what_this_is", "extension_version", "user_agent", "language", "created_at"):
        assert report[key], key
    assert set(report["run"]) >= {"started_at", "finished_at", "stop_reason", "settings"}
    assert isinstance(report["downloaded_count"], int)
    assert isinstance(report["summary"], list)
    for row in report["not_downloaded"]:
        assert set(row) >= {"input", "site", "id", "title", "status", "failure", "message_en"}
        assert set(row) >= {"probable_cause", "attempts", "streams", "page", "raw"}
        assert row["failure"]["code"], row
        assert row["probable_cause"], row
        for attempt in row["attempts"]:
            assert "?" not in str(attempt.get("url", "")), attempt
