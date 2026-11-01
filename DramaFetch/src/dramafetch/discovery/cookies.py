"""Netscape `cookies.txt` support for the discovery strategies and the `doctor` command.

Cookie VALUES are secrets. This module hands them to exactly two places, Playwright
(`load_netscape_cookies`) and the `Cookie` request header of the static strategy (`cookie_header`),
and never to logs, messages or dumps. `describe_cookies` reports names and counts only.

Format, as `http.cookiejar.MozillaCookieJar` reads it: one cookie per line, seven TAB-separated
fields `domain  include_subdomains  path  secure  expires  name  value`; `expires` is seconds since
the epoch, `0` or empty for a session cookie; `#` starts a comment. The `#HttpOnly_` prefix that
curl and yt-dlp put in front of HttpOnly cookies is handled here explicitly (older Pythons' jars
dropped those lines as comments).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

HTTPONLY_PREFIX = "#HttpOnly_"
# Cookie NAMES that carry TikTok's login session; their presence (never their value) is reported.
SESSION_COOKIE_NAMES = frozenset({"sessionid", "sessionid_ss", "sid_tt", "sid_guard"})
_FIELD_COUNT = 7
_SECONDS_PER_DAY = 86_400.0


@dataclass(frozen=True)
class CookieReport:
    """What `doctor` may say about a cookies file: counts and names, never values."""

    count: int
    has_session_cookie: bool
    age_days: float | None
    names: list[str]
    expired: int = 0  # cookies in the file that were already past their expiry


@dataclass(frozen=True)
class _Entry:
    domain: str
    path: str
    secure: bool
    expires: float  # 0 means "session cookie"
    name: str
    value: str
    http_only: bool

    def is_expired(self, now: float) -> bool:
        return 0 < self.expires < now


def load_netscape_cookies(path: Path, domain_filter: str = "tiktok.com") -> list[dict[str, Any]]:
    """Read a Netscape cookies.txt and return Playwright cookie dicts for `domain_filter`.

    Each dict carries `name, value, domain, path, expires (float; -1 for session cookies), httpOnly,
    secure`. Expired cookies are dropped, malformed lines skipped, and an empty `domain_filter`
    keeps every domain. Raises `FileNotFoundError` when the file is missing and `ValueError` when it
    holds no cookie line at all (wrong format).
    """
    entries = _read_entries(path)
    now = time.time()
    return [
        {
            "name": entry.name,
            "value": entry.value,
            "domain": entry.domain,
            "path": entry.path,
            "expires": entry.expires if entry.expires > 0 else -1.0,
            "httpOnly": entry.http_only,
            "secure": entry.secure,
        }
        for entry in entries
        if not entry.is_expired(now) and _domain_matches(entry.domain, domain_filter)
    ]


def cookie_header(cookies: list[dict[str, Any]]) -> str:
    """Join Playwright cookie dicts into a `Cookie:` header value (for the static strategy)."""
    return "; ".join(f"{cookie['name']}={cookie['value']}" for cookie in cookies)


def describe_cookies(path: Path, domain_filter: str = "tiktok.com") -> CookieReport:
    """Summarise a cookies file for `doctor`: names and counts only, never values.

    A missing file yields an empty report with `age_days=None`; a file in the wrong format yields
    an empty report with its age, so the caller can still say "exists but unreadable".
    """
    if not path.is_file():
        return CookieReport(count=0, has_session_cookie=False, age_days=None, names=[])
    age_days = max(0.0, (time.time() - path.stat().st_mtime) / _SECONDS_PER_DAY)
    try:
        entries = _read_entries(path)
    except ValueError:
        return CookieReport(count=0, has_session_cookie=False, age_days=age_days, names=[])
    now = time.time()
    relevant = [entry for entry in entries if _domain_matches(entry.domain, domain_filter)]
    live = [entry for entry in relevant if not entry.is_expired(now)]
    names = sorted({entry.name for entry in live})
    return CookieReport(
        count=len(live),
        has_session_cookie=any(name in SESSION_COOKIE_NAMES for name in names),
        age_days=age_days,
        names=names,
        expired=len(relevant) - len(live),
    )


def cookie_file_problems(path: Path) -> list[str]:
    """Lines of a cookies.txt that yt-dlp would reject, described by LINE NUMBER only.

    yt-dlp skips a malformed line (not exactly seven tab-separated fields, or a non-numeric expiry)
    with a WARNING that quotes the whole line — cookie value included — on stderr, which
    ``quiet``/``no_warnings`` do not silence. DramaFetch therefore checks the file first and refuses
    to hand such a file to yt-dlp; this function says where the problem is without ever repeating
    the line. Comments, blank lines and the ``#HttpOnly_`` prefix follow yt-dlp's rules.
    """
    problems: list[str] = []
    for number, raw_line in enumerate(
        path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1
    ):
        line = raw_line.rstrip("\r\n")
        if line.startswith(HTTPONLY_PREFIX):
            line = line[len(HTTPONLY_PREFIX) :]
        if line.startswith("#") or not line.strip():
            continue
        fields = line.split("\t")
        if len(fields) != _FIELD_COUNT:
            problems.append(f"line {number}: {len(fields)} fields (expected {_FIELD_COUNT})")
            continue
        expires = fields[4].strip()
        if expires and not expires.isdigit():
            problems.append(f"line {number}: the expiry field is not a whole number")
    return problems


def _read_entries(path: Path) -> list[_Entry]:
    entries: list[_Entry] = []
    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.rstrip("\r\n")
        http_only = line.startswith(HTTPONLY_PREFIX)
        if http_only:
            line = line[len(HTTPONLY_PREFIX) :]
        stripped = line.strip()
        if not stripped or stripped.startswith(("#", "$")):
            continue
        fields = line.split("\t")
        if len(fields) == _FIELD_COUNT - 1:  # empty value written without the trailing tab
            fields.append("")
        if len(fields) != _FIELD_COUNT:
            continue
        domain, _include_subdomains, cookie_path, secure, expires_text, name, value = fields
        expires = _parse_expires(expires_text)
        if not name or not domain or expires is None:
            continue
        entries.append(
            _Entry(
                domain=domain.strip(),
                path=cookie_path.strip() or "/",
                secure=secure.strip().upper() == "TRUE",
                expires=expires,
                name=name.strip(),
                value=value,
                http_only=http_only,
            )
        )
    if not entries:
        raise ValueError(
            f"{path} contains no cookies: expected the Netscape cookies.txt format "
            "(seven tab-separated fields per line)"
        )
    return entries


def _parse_expires(text: str) -> float | None:
    """`0` or empty means a session cookie (0.0); anything non-numeric is unusable (None)."""
    text = text.strip()
    if not text:
        return 0.0
    try:
        return max(0.0, float(text))
    except ValueError:
        return None


def _domain_matches(domain: str, domain_filter: str) -> bool:
    host = domain.lstrip(".").lower()
    wanted = domain_filter.strip().lstrip(".").lower()
    if not wanted:
        return True
    return host == wanted or host.endswith("." + wanted)
