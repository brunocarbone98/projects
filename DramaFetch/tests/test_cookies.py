"""Netscape cookies.txt: #HttpOnly_ lines, session cookies, domain filter, names-only report."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from dramafetch.discovery.cookies import (
    SESSION_COOKIE_NAMES,
    CookieReport,
    cookie_file_problems,
    cookie_header,
    describe_cookies,
    load_netscape_cookies,
)

FAR_FUTURE = int(time.time()) + 10 * 365 * 86_400
LONG_AGO = 1_000_000  # January 1970: expired


def _line(domain, flag, path, secure, expires, name, value, *, http_only=False) -> str:
    prefix = "#HttpOnly_" if http_only else ""
    return f"{prefix}{domain}\t{flag}\t{path}\t{secure}\t{expires}\t{name}\t{value}"


def _write(tmp_path: Path, lines: list[str], newline: str = "\n") -> Path:
    path = tmp_path / "cookies.txt"
    path.write_text(newline.join(lines) + newline, encoding="utf-8")
    return path


@pytest.fixture
def cookies_file(tmp_path: Path) -> Path:
    return _write(
        tmp_path,
        [
            "# Netscape HTTP Cookie File",
            "# https://curl.se/docs/http-cookies.html",
            "",
            _line(
                ".tiktok.com",
                "TRUE",
                "/",
                "TRUE",
                FAR_FUTURE,
                "sessionid",
                "SESSION-VALUE-1",
                http_only=True,
            ),
            _line(
                ".tiktok.com",
                "TRUE",
                "/",
                "TRUE",
                FAR_FUTURE,
                "sid_tt",
                "SID-VALUE-2",
                http_only=True,
            ),
            _line(".tiktok.com", "TRUE", "/", "TRUE", FAR_FUTURE, "msToken", "MS-VALUE-3"),
            # expiry 0: a session cookie, kept
            _line("www.tiktok.com", "FALSE", "/", "FALSE", 0, "tt_csrf_token", "CSRF-VALUE-4"),
            # expired long ago: dropped
            _line(".tiktok.com", "TRUE", "/", "TRUE", LONG_AGO, "stale", "STALE-VALUE-5"),
            # other domains: filtered out (tiktokcdn.com is not a subdomain of tiktok.com)
            _line(".example.com", "TRUE", "/", "TRUE", FAR_FUTURE, "other", "OTHER-VALUE-6"),
            _line(".tiktokcdn.com", "TRUE", "/", "FALSE", FAR_FUTURE, "cdn", "CDN-VALUE-7"),
            "this line is not a cookie at all",
            _line("127.0.0.1", "FALSE", "/", "FALSE", FAR_FUTURE, "sessionid", "LOCAL-VALUE-8"),
            # six fields: an empty value written without the trailing tab
            f".tiktok.com\tTRUE\t/\tFALSE\t{FAR_FUTURE}\temptyvalue",
        ],
    )


def test_loads_tiktok_cookies_as_playwright_dicts(cookies_file: Path) -> None:
    cookies = load_netscape_cookies(cookies_file)

    assert [c["name"] for c in cookies] == [
        "sessionid",
        "sid_tt",
        "msToken",
        "tt_csrf_token",
        "emptyvalue",
    ]
    session = cookies[0]
    assert session == {
        "name": "sessionid",
        "value": "SESSION-VALUE-1",
        "domain": ".tiktok.com",
        "path": "/",
        "expires": float(FAR_FUTURE),
        "httpOnly": True,
        "secure": True,
    }
    assert cookies[2]["httpOnly"] is False  # no #HttpOnly_ prefix
    csrf = cookies[3]
    assert csrf["expires"] == -1.0  # session cookie
    assert csrf["secure"] is False
    assert csrf["domain"] == "www.tiktok.com"
    assert cookies[4]["value"] == ""


def test_domain_filter_selects_the_host(cookies_file: Path) -> None:
    local = load_netscape_cookies(cookies_file, domain_filter="127.0.0.1")
    assert [(c["name"], c["value"], c["domain"]) for c in local] == [
        ("sessionid", "LOCAL-VALUE-8", "127.0.0.1")
    ]
    assert (
        len(load_netscape_cookies(cookies_file, domain_filter="")) == 8
    )  # all but the expired one
    assert load_netscape_cookies(cookies_file, domain_filter="example.com")[0]["name"] == "other"
    assert load_netscape_cookies(cookies_file, domain_filter="nothing.test") == []


def test_cookie_header_joins_name_value_pairs(cookies_file: Path) -> None:
    header = cookie_header(load_netscape_cookies(cookies_file))
    assert header == (
        "sessionid=SESSION-VALUE-1; sid_tt=SID-VALUE-2; msToken=MS-VALUE-3; "
        "tt_csrf_token=CSRF-VALUE-4; emptyvalue="
    )


def test_describe_cookies_reports_names_and_counts_only(cookies_file: Path) -> None:
    report = describe_cookies(cookies_file)

    assert isinstance(report, CookieReport)
    assert report.count == 5
    assert report.has_session_cookie is True
    assert report.names == ["emptyvalue", "msToken", "sessionid", "sid_tt", "tt_csrf_token"]
    assert report.expired == 1
    assert report.age_days is not None
    assert 0.0 <= report.age_days < 1.0
    assert "VALUE-" not in repr(report)  # never a cookie value


def test_describe_cookies_without_a_session_cookie(tmp_path: Path) -> None:
    path = _write(tmp_path, [_line(".tiktok.com", "TRUE", "/", "TRUE", FAR_FUTURE, "msToken", "x")])
    report = describe_cookies(path)
    assert report.has_session_cookie is False
    assert report.names == ["msToken"]
    assert "sessionid" in SESSION_COOKIE_NAMES


def test_describe_cookies_handles_missing_and_unreadable_files(tmp_path: Path) -> None:
    missing = describe_cookies(tmp_path / "nope.txt")
    assert missing == CookieReport(count=0, has_session_cookie=False, age_days=None, names=[])

    garbage = describe_cookies(_write(tmp_path, ['{"not": "netscape"}']))
    assert garbage.count == 0
    assert garbage.names == []
    assert garbage.age_days is not None  # exists, just unreadable


def test_load_rejects_files_without_cookie_lines(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="Netscape"):
        load_netscape_cookies(_write(tmp_path, ["# Netscape HTTP Cookie File", "", "# nothing"]))
    with pytest.raises(FileNotFoundError):
        load_netscape_cookies(tmp_path / "missing.txt")


def test_cookie_file_problems_names_line_numbers_never_content(tmp_path: Path) -> None:
    path = _write(
        tmp_path,
        [
            "# Netscape HTTP Cookie File",
            "",
            _line(".tiktok.com", "TRUE", "/", "TRUE", FAR_FUTURE, "sessionid", "SECRET-1"),
            _line(".tiktok.com", "TRUE", "/", "TRUE", FAR_FUTURE, "ttwid", "SECRET-2") + "\textra",
            _line(".tiktok.com", "TRUE", "/", "TRUE", f"{FAR_FUTURE}.5", "msToken", "SECRET-3"),
            "domain TRUE / TRUE 0 spaces SECRET-4",  # whitespace instead of tabs: 1 field
            f".tiktok.com\tTRUE\t/\tFALSE\t{FAR_FUTURE}\tsixfields",
            _line(".tiktok.com", "TRUE", "/", "TRUE", "", "blank_expiry", "x", http_only=True),
        ],
    )
    problems = cookie_file_problems(path)
    assert problems == [
        "line 4: 8 fields (expected 7)",
        "line 5: the expiry field is not a whole number",
        "line 6: 1 fields (expected 7)",
        "line 7: 6 fields (expected 7)",
    ]
    assert "SECRET" not in " ".join(problems)
    clean = _write(
        tmp_path,
        [
            "# Netscape HTTP Cookie File",
            _line(".tiktok.com", "TRUE", "/", "TRUE", FAR_FUTURE, "sessionid", "v", http_only=True),
            _line(".tiktok.com", "TRUE", "/", "TRUE", 0, "tt_csrf_token", ""),
        ],
    )
    assert cookie_file_problems(clean) == []


def test_windows_line_endings_and_odd_expiry_values(tmp_path: Path) -> None:
    path = _write(
        tmp_path,
        [
            _line(".tiktok.com", "TRUE", "/", "TRUE", "", "blank_expiry", "A"),  # empty = session
            _line(".tiktok.com", "TRUE", "/", "TRUE", f"{FAR_FUTURE}.5", "float_expiry", "B"),
            _line(".tiktok.com", "TRUE", "/", "TRUE", "soon", "bad_expiry", "C"),  # unusable
        ],
        newline="\r\n",
    )
    cookies = load_netscape_cookies(path)
    assert [(c["name"], c["expires"]) for c in cookies] == [
        ("blank_expiry", -1.0),
        ("float_expiry", FAR_FUTURE + 0.5),
    ]
