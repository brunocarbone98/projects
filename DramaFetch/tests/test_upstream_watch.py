"""tools/upstream_watch.py — the maintenance agents' upstream report, tested offline: every fetch
is a fake, nothing here touches the network (and the tool itself may only read three hosts)."""

from __future__ import annotations

import importlib.util
import io
import json
import sys
import urllib.error
import urllib.parse
from contextlib import redirect_stdout
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "upstream_watch", ROOT / "tools" / "upstream_watch.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["upstream_watch"] = module
    spec.loader.exec_module(module)
    return module


uw = _load()

CHANGELOG = """# Changelog

<!--
# To create a release, dispatch the release workflow on master
-->

### 2026.12.01

#### Important changes
- Security: [[CVE-2026-99999](https://nvd.nist.gov/vuln/detail/CVE-2026-99999)] Something fixed
    - See the [advisory](https://github.com/advisories/GHSA-abcd-efgh-ijkl)

#### Extractor changes
- **tiktok**
    - [Fix formats extraction](https://github.com/yt-dlp/yt-dlp/commit/aaa) ([#1](https://x)) by [dev](https://y)
    - live: [Fix room ID](https://github.com/yt-dlp/yt-dlp/commit/bbb)
- **youtube**: [Unrelated](https://github.com/yt-dlp/yt-dlp/commit/ccc)

### 2026.11.05

#### Extractor changes
- **TikTok**: user: [Support share URLs](https://github.com/yt-dlp/yt-dlp/commit/ddd)
- **vimeo**
    - [Not ours](https://github.com/yt-dlp/yt-dlp/commit/eee)

### 2026.10.26

#### Extractor changes
- **tiktok**: [Older than the installed version](https://github.com/yt-dlp/yt-dlp/commit/fff)
"""

OLD_EXTRACTOR = """
def _parse(self, item):
    video = item['video']
    urls = video.get('playAddr'), video.get('bitrateInfo')
    return item.get('itemStruct'), traverse(video, ('PlayAddr', 'UrlList'))
"""

NEW_EXTRACTOR = """
def _parse(self, item):
    video = item['video']
    urls = video.get("bitrateInfo"), video.get("playUrl")
    return item.get('itemStruct'), traverse(video, ('PlayAddr', 'UrlList', "cursor"))
"""


# ------------------------------------------------------------------------------- helpers


def test_version_key_orders_ytdlp_dates_and_dotted_versions() -> None:
    assert (
        uw.version_key("2026.10.26") < uw.version_key("2026.11.05") < uw.version_key("2026.11.05.1")
    )
    assert uw.version_key("1.64.1rc1") == (1, 64, 1)
    assert uw.version_key("1.64.1") > uw.version_key("1.64")
    assert uw.version_key("garbage") == ()


def test_normalize_follows_pep_503() -> None:
    assert uw.normalize("curl_cffi") == uw.normalize("Curl.CFFI") == "curl-cffi"


def test_pyproject_floors_reads_dependencies_and_extras() -> None:
    text = """
[project]
name = "dramafetch"
dependencies = ["yt-dlp>=2026.10.26", "playwright>=1.50", "mutagen >= 1.47 ; python_version>'3'"]
[project.optional-dependencies]
impersonate = ["curl_cffi[extra]>=0.10"]
dev = ["pytest"]
"""
    assert uw.pyproject_floors(text) == {
        "yt-dlp": "2026.10.26",
        "playwright": "1.50",
        "mutagen": "1.47",
        "curl-cffi": "0.10",
    }


def test_vulnerabilities_of_keeps_live_entries_only() -> None:
    release = {
        "vulnerabilities": [
            {
                "id": "PYSEC-2026-1",
                "aliases": ["CVE-2026-1", "GHSA-aaaa-bbbb-cccc"],
                "fixed_in": ["2026.11.05"],
                "link": "https://osv.dev/vulnerability/PYSEC-2026-1",
                "summary": "  a   multi\nline  summary ",
                "withdrawn": None,
            },
            {"id": "PYSEC-2026-2", "withdrawn": "2026-10-01T00:00:00Z"},
            "not a dict",
        ]
    }
    (only,) = uw.vulnerabilities_of(release)
    assert only.id == "PYSEC-2026-1"
    assert only.aliases == ("CVE-2026-1", "GHSA-aaaa-bbbb-cccc")
    assert only.fixed_in == ("2026.11.05",)
    assert only.summary == "a multi line summary"
    assert uw.vulnerabilities_of({"vulnerabilities": None}) == []
    assert uw.vulnerabilities_of(None) == []


def test_changelog_entries_takes_inline_and_nested_tiktok_lines_newer_than_installed() -> None:
    entries = uw.changelog_entries(CHANGELOG, newer_than="2026.10.26")
    assert [(e.version, e.text.split("](")[0]) for e in entries] == [
        ("2026.12.01", "tiktok: [Fix formats extraction"),
        ("2026.12.01", "tiktok: live: [Fix room ID"),
        ("2026.11.05", "TikTok: user: [Support share URLs"),
    ]
    assert all("Unrelated" not in e.text and "Not ours" not in e.text for e in entries)
    assert uw.changelog_entries(CHANGELOG, newer_than="2026.12.01") == []


def test_security_notes_find_cves_and_advisories() -> None:
    notes = uw.security_notes(CHANGELOG, newer_than="2026.10.26")
    assert [n.version for n in notes] == ["2026.12.01", "2026.12.01"]
    assert "CVE-2026-99999" in notes[0].text and "GHSA-abcd" in notes[1].text


def test_watched_literals_are_field_names_and_api_paths_only() -> None:
    source = (
        'KEYS = ("itemStruct", "playAddr")\nPATH = "/api/drama/detail/"\n'
        'MESSAGE = "a sentence with spaces"\nSHORT = "id"\n'
    )
    assert uw.watched_literals([source]) == {"itemStruct", "playAddr", "/api/drama/detail/"}


def test_literal_drift_and_changed_lines() -> None:
    watched = {"playAddr", "bitrateInfo", "itemStruct", "PlayAddr", "UrlList", "cursor", "unused"}
    gone, added = uw.literal_drift(watched, OLD_EXTRACTOR, NEW_EXTRACTOR)
    assert gone == ["playAddr"]
    assert added == ["cursor"]
    assert uw.changed_lines(OLD_EXTRACTOR, NEW_EXTRACTOR) == 4
    assert uw.changed_lines(OLD_EXTRACTOR, OLD_EXTRACTOR + "   \n") == 1
    assert uw.quoted_in("x = 'a.b'", "a.b") and not uw.quoted_in("x = 'aXb'", "a.b")


# ------------------------------------------------------------------------------ network


def _url_hosts() -> set[str]:
    templates = [uw.PYPI_LATEST, uw.PYPI_RELEASE, uw.YTDLP_RAW, uw.CHROME_STABLE]
    return {
        urllib.parse.urlsplit(
            t.format(name="x", version="1", ref="m", path="p", platform="win")
        ).hostname
        or ""
        for t in templates
    }


def test_the_tool_reads_only_its_three_primary_sources_and_never_tiktok() -> None:
    assert _url_hosts() == set(uw.ALLOWED_HOSTS)
    assert not any("tiktok" in host for host in uw.ALLOWED_HOSTS)
    report = uw.Report()
    with pytest.raises(ValueError, match="not a source"):
        uw.fetch_text(lambda url: b"", "https://www.tiktok.com/", report)


def test_a_failed_host_is_listed_once_and_skipped_afterwards() -> None:
    calls: list[str] = []

    def fetch(url: str) -> bytes:
        calls.append(url)
        raise TimeoutError("timed out")

    report = uw.Report()
    assert uw.fetch_text(fetch, "https://pypi.org/pypi/a/json", report) is None
    assert uw.fetch_text(fetch, "https://pypi.org/pypi/b/json", report) is None
    assert calls == ["https://pypi.org/pypi/a/json"]
    assert report.unreachable == ["https://pypi.org/pypi/a/json (TimeoutError: timed out)"]
    assert report.failed_hosts == {"pypi.org"}


def test_a_404_is_an_answer_not_an_outage() -> None:
    def fetch(url: str) -> bytes:
        raise urllib.error.HTTPError(url, 404, "Not Found", None, None)

    report = uw.Report()
    assert uw.fetch_text(fetch, "https://pypi.org/pypi/local-only/1.0/json", report) is None
    assert report.unreachable == [] and report.failed_hosts == set()


# ------------------------------------------------------------------------------- report


def _project(tmp_path: Path) -> Path:
    project = tmp_path / "DramaFetch"
    (project / "src" / "dramafetch" / "discovery").mkdir(parents=True)
    (project / "extension").mkdir()
    (project / "pyproject.toml").write_text(
        '[project]\nname = "dramafetch"\n'
        'dependencies = ["yt-dlp>=2026.10.26", "playwright>=1.50", "mutagen>=1.47"]\n'
        '[project.optional-dependencies]\nimpersonate = ["curl_cffi>=0.10"]\n',
        encoding="utf-8",
    )
    (project / "src" / "dramafetch" / "catalog.py").write_text(
        'KEYS = ("playAddr", "bitrateInfo", "itemStruct")\n', encoding="utf-8"
    )
    (project / "extension" / "manifest.json").write_text(
        json.dumps({"minimum_chrome_version": "116"}), encoding="utf-8"
    )
    return project


def _fake_sources() -> dict[str, bytes]:
    def release(vulns: list[dict[str, object]]) -> bytes:
        return json.dumps({"info": {}, "vulnerabilities": vulns}).encode()

    def latest(version: str) -> bytes:
        return json.dumps(
            {"info": {"version": version}, "urls": [{"upload_time": "2026-12-01T10:00:00"}]}
        ).encode()

    raw = "https://raw.githubusercontent.com/yt-dlp/yt-dlp/"
    chrome = "https://versionhistory.googleapis.com/v1/chrome/platforms/{}/channels/stable/versions?pageSize=1"
    sources = {
        "https://pypi.org/pypi/yt-dlp/2026.10.26/json": release([]),
        "https://pypi.org/pypi/yt-dlp/json": latest("2026.12.01"),
        "https://pypi.org/pypi/playwright/1.64.1/json": release([]),
        "https://pypi.org/pypi/playwright/json": latest("1.64.1"),
        "https://pypi.org/pypi/mutagen/1.48.1/json": release([]),
        "https://pypi.org/pypi/mutagen/json": latest("1.48.1"),
        "https://pypi.org/pypi/certifi/2026.1.1/json": release(
            [{"id": "GHSA-6q48-6c7w-9gw2", "aliases": ["CVE-2026-2"], "fixed_in": ["2026.10.23"]}]
        ),
        raw + "master/Changelog.md": CHANGELOG.encode(),
        raw + "2026.10.26/yt_dlp/extractor/tiktok.py": OLD_EXTRACTOR.encode(),
        raw + "master/yt_dlp/extractor/tiktok.py": NEW_EXTRACTOR.encode(),
    }
    for platform, version in (("win", "157.0.1"), ("mac", "157.0.2")):
        sources[chrome.format(platform)] = json.dumps({"versions": [{"version": version}]}).encode()
    return sources


def test_the_report_names_what_needs_attention_and_cites_every_source(tmp_path: Path) -> None:
    sources = _fake_sources()
    asked: list[str] = []

    def fetch(url: str) -> bytes:
        asked.append(url)
        if url in sources:
            return sources[url]
        if "linux" in url:
            raise ConnectionResetError("reset by peer")
        raise urllib.error.HTTPError(url, 404, "Not Found", None, None)

    installed = {
        "dramafetch": "0.1.0",
        "yt-dlp": "2026.10.26",
        "playwright": "1.64.1",
        "mutagen": "1.48.1",
        "certifi": "2026.1.1",
    }
    text = uw.build_report(
        _project(tmp_path), installed=installed, fetch=fetch, now=datetime(2026, 12, 2, tzinfo=UTC)
    )

    assert "# DramaFetch upstream watch — 2026-12-02 00:00 UTC" in text
    attention = text.split("## Attention", 1)[1].split("## Python dependencies", 1)[0]
    assert "yt-dlp 2026.12.01 is out (installed 2026.10.26)" in attention
    assert "certifi 2026.1.1: 1 known vulnerability (GHSA-6q48-6c7w-9gw2)" in attention
    assert "3 TikTok entries newer than 2026.10.26" in attention
    assert "security notes newer than 2026.10.26" in attention
    assert "the TikTok extractor stopped using names DramaFetch reads: playAddr" in attention
    assert "| yt-dlp | 2026.10.26 | 2026.10.26 | 2026.12.01 (2026-12-01) | none |" in text
    assert "| curl-cffi | not installed | 0.10 | - | - |" in text
    assert "- certifi 2026.1.1: [GHSA-6q48-6c7w-9gw2]" in text and "fixed in 2026.10.23" in text
    assert "- 2026.12.01 — tiktok: [Fix formats extraction]" in text
    assert "| win | 157.0.1 |" in text and "| linux | not read |" in text
    assert "`minimum_chrome_version`: 116." in text
    assert "versions?pageSize=1 (ConnectionResetError: reset by peer)" in text
    assert "<https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/Changelog.md>" in text
    assert "pypi.org/pypi/dramafetch" not in " ".join(asked)  # the project itself is not on PyPI
    assert all(urllib.parse.urlsplit(url).hostname in uw.ALLOWED_HOSTS for url in asked)


def test_main_prints_a_report_and_exits_0_even_when_nothing_answers(tmp_path: Path) -> None:
    def offline(url: str) -> bytes:
        raise OSError("network is unreachable")

    out = io.StringIO()
    with redirect_stdout(out):
        status = uw.main(
            ["--project", str(_project(tmp_path)), "--python", sys.executable], fetch=offline
        )
    assert status == 0
    text = out.getvalue()
    assert "## Unreachable" in text and "network is unreachable" in text
    assert "## Attention\n\nnothing new" in text


def test_main_refuses_a_directory_without_pyproject(tmp_path: Path) -> None:
    with pytest.raises(SystemExit) as stopped:
        uw.main(["--project", str(tmp_path)], fetch=lambda url: b"")
    assert stopped.value.code == 2
