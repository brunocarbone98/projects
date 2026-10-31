"""Hand one episode to yt-dlp. Per-episode failures are reported in the result, never raised.

TikTok facts this module relies on (verified October 2026): yt-dlp does not recognise the
``/shortdrama/episode/<series_id>/<n>`` URL (yt-dlp/yt-dlp#17725), but every episode is also an
ordinary video at ``https://www.tiktok.com/@<user>/video/<item_id>`` (the username segment is not
checked), which yt-dlp downloads as a single progressive file — no merging, so ffmpeg is optional.
Without a logged-in session TikTok returns no formats ("No video formats found") or redirects to
``/login``, so a Netscape ``cookies.txt`` (or ``--cookies-from-browser``) is the normal way to run.
Locked (paid) episodes are skipped before any network access; nothing here unlocks or bypasses
anything. Cookie values are never logged; error messages are redacted just in case.
"""

from __future__ import annotations

import importlib
import re
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from dramafetch.discovery.cookies import cookie_file_problems
from dramafetch.discovery.static import redact_tokens, safe_url
from dramafetch.manifest import episode_stem
from dramafetch.models import DownloadOptions, DownloadResult, DownloadStatus, Episode

TIKTOK_REFERER = "https://www.tiktok.com/"
H264_FORMAT = "best[vcodec^=h264]/best[vcodec=avc1]/best"
BEST_FORMAT = "best"
MAX_MESSAGE_LEN = 300
#: yt-dlp retries per download are capped here whatever ``DownloadOptions.retries`` says: after a
#: refusal every retry is one more request against the same address, which is what trips TikTok's
#: protection. The CLI rejects larger values up front.
MAX_RETRIES = 3
#: Prefix of the message of a FAILED_BLOCKED result (HTTP 403 / forbidden / access denied).
BLOCKED_MESSAGE = (
    "blocked (HTTP 403): TikTok refused the request; wait 30-60 minutes before trying again"
)

_PARTIAL_SUFFIXES = (".part", ".ytdl", ".temp", ".tmp")
_SECRET_RE = re.compile(
    r"\b(cookies?|sessionid(?:_ss)?|sid_tt|sid_guard|uid_tt|mstoken|ttwid|tt_chain_token"
    r"|passport_csrf_token|odin_tt|tt_csrf_token)\b\s*[:=]\s*[^\s;,&]+",
    re.IGNORECASE,
)
#: ``http(s)`` URLs inside free text: a signed play URL's query string is a token.
_URL_RE = re.compile(r"https?://[^\s\"'<>]+")
# "429" only as a whole token: yt-dlp prefixes TikTok errors with the 19-digit video id, and about
# 1.6 % of those ids contain the digits 429 somewhere.
_RATE_LIMIT_RE = re.compile(r"\b429\b|too many requests|rate limit")
# HTTP 403 and its wordings. A 403 from TikTok is the protection saying no, not a missing video:
# the run must stop and wait, so it gets its own status rather than FAILED/FAILED_UNAVAILABLE.
_BLOCKED_RE = re.compile(r"http error 403|\b403\b\s*:?\s*forbidden|\bforbidden\b|access denied")


def curl_cffi_available() -> bool:
    """True when ``curl_cffi`` imports, which is what lets yt-dlp impersonate Chrome's TLS stack."""
    try:
        importlib.import_module("curl_cffi")
    except Exception:
        return False
    return True


def impersonate_target() -> Any | None:
    """``ImpersonateTarget("chrome")`` when both curl_cffi and yt-dlp's impersonation exist."""
    if not curl_cffi_available():
        return None
    try:
        from yt_dlp.networking.impersonate import ImpersonateTarget
    except Exception:
        return None
    return ImpersonateTarget("chrome")


def is_partial_file(name: str) -> bool:
    """yt-dlp's in-progress artefacts (``.part``, ``.ytdl``, ``.part-Frag3``...)."""
    return name.endswith(_PARTIAL_SUFFIXES) or ".part-Frag" in name


def existing_episode_file(out_dir: Path, episode: Episode) -> Path | None:
    """The newest complete file named ``<episode stem>.<ext>`` in ``out_dir``, if any."""
    if not out_dir.is_dir():
        return None
    prefix = episode_stem(episode) + "."
    candidates = [
        path
        for path in out_dir.iterdir()
        if path.is_file() and path.name.startswith(prefix) and not is_partial_file(path.name)
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda path: path.stat().st_mtime)


def output_template(out_dir: Path, episode: Episode) -> str:
    """yt-dlp ``outtmpl`` for the episode: ``<out_dir>/<episode stem>.%(ext)s``.

    Everything except the final ``%(ext)s`` is literal text that TikTok partly controls (the series
    name in ``out_dir``, the episode title in the stem), so its percent signs are doubled: yt-dlp
    expands ``%(name)s`` sequences in the template, and an unescaped ``%(cookies)s`` in a title
    would otherwise put the session cookies into the file name.
    """
    return str(out_dir / episode_stem(episode)).replace("%", "%%") + ".%(ext)s"


def cookies_file_problem(cookies_file: Path | None) -> str | None:
    """Why ``cookies_file`` must not be handed to yt-dlp, or None when it is fine to use.

    yt-dlp reports every malformed cookies.txt line as a WARNING that quotes the line, value
    included; DramaFetch promises never to print cookie values, so such a file is refused with the
    line numbers only. A missing or unreadable file is left to yt-dlp (its error names the path).
    """
    if cookies_file is None or not cookies_file.is_file():
        return None
    try:
        problems = cookie_file_problems(cookies_file)
    except OSError:
        return None
    if not problems:
        return None
    return (
        f"cookies file {cookies_file.name} has malformed lines ({'; '.join(problems)}); "
        "yt-dlp would print them, cookie values included: fix or re-export the file"
    )


def locked_result(episode: Episode) -> DownloadResult:
    """The SKIPPED_LOCKED result for an episode whose payload says it is locked/paid."""
    return DownloadResult(
        episode=episode,
        status=DownloadStatus.SKIPPED_LOCKED,
        message="looks locked: " + "; ".join(episode.lock_hints),
    )


def redact_secrets(text: str) -> str:
    """``text`` with every cookie-like or token-like value blanked and every URL cut back to its
    host and path, on every line — not only the one a message ends up keeping. A failed Playwright
    request, for one, quotes the whole request below its first line: the signed play URL and the
    ``cookie`` header."""
    text = _URL_RE.sub(lambda match: safe_url(match.group(0)), text)
    text = redact_tokens(text)
    return _SECRET_RE.sub(lambda match: f"{match.group(1)}=<redacted>", text)


def sanitize_error(message: str) -> str:
    """First non-empty line of an error after :func:`redact_secrets` ran over all of it, truncated
    to 300 characters."""
    redacted = redact_secrets(message)
    lines = [line.strip() for line in redacted.strip().splitlines() if line.strip()]
    first = lines[0] if lines else "unknown error"
    if len(first) > MAX_MESSAGE_LEN:
        first = first[: MAX_MESSAGE_LEN - 1] + "…"
    return first


def describe_failure(status: DownloadStatus, message: str) -> str:
    """The user-facing message for a classified failure: a FAILED_BLOCKED result is prefixed with
    :data:`BLOCKED_MESSAGE` (what happened and what to do), the others keep yt-dlp's words."""
    if status is DownloadStatus.FAILED_BLOCKED:
        return f"{BLOCKED_MESSAGE}: {message}" if message else BLOCKED_MESSAGE
    return message


def _default_ydl_factory(params: dict[str, Any]) -> Any:
    import yt_dlp  # lazy: importing yt-dlp is slow and tests never need it

    return yt_dlp.YoutubeDL(params)


class YtDlpDownloader:
    """Downloads one episode with yt-dlp; ``ydl_factory`` is injectable for tests."""

    def __init__(self, ydl_factory: Callable[[dict[str, Any]], Any] | None = None) -> None:
        self._ydl_factory = ydl_factory or _default_ydl_factory

    def build_options(
        self, episode: Episode, options: DownloadOptions, outtmpl: str
    ) -> dict[str, Any]:
        """yt-dlp params for one episode (the episode itself only influences ``outtmpl``).

        ``retries``/``fragment_retries`` never exceed :data:`MAX_RETRIES` and yt-dlp sleeps one
        second between its own requests (``sleep_interval_requests``): fewer, slower requests.
        """
        del episode  # the caller already folded the episode into outtmpl
        params: dict[str, Any] = {
            "outtmpl": outtmpl,
            "noplaylist": True,
            "retries": min(options.retries, MAX_RETRIES),
            "fragment_retries": min(options.retries, MAX_RETRIES),
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            # TikTok formats are progressive; yt-dlp already ranks the watermarked download_addr
            # below play_addr* through `preference`, so a plain best[...] selector is enough.
            "format": H264_FORMAT if options.prefer_h264 else BEST_FORMAT,
            "http_headers": {"Referer": TIKTOK_REFERER},
            "restrictfilenames": False,
            # The generated parts of the path are already Windows-safe (`safe_filename`). On Windows
            # yt-dlp sanitizes paths anyway; on Linux/macOS `windowsfilenames: True` would run the
            # Windows rules over the WHOLE outtmpl and move a legal `--out` such as `videos:tiktok`
            # or `My Videos.` to a sibling directory DramaFetch never looks at.
            "windowsfilenames": sys.platform == "win32",
            "overwrites": options.overwrite,
            "sleep_interval_requests": 1,
        }
        if options.cookies_file is not None:
            params["cookiefile"] = str(options.cookies_file)
        if options.cookies_from_browser:
            params["cookiesfrombrowser"] = (options.cookies_from_browser,)
        if options.impersonate:
            target = impersonate_target()
            if target is not None:
                params["impersonate"] = target
        if options.extractor_args is not None:
            params["extractor_args"] = options.extractor_args
        return params

    def download(self, episode: Episode, options: DownloadOptions) -> DownloadResult:
        """Download into ``options.out_dir`` (already the SERIES directory). Never raises."""
        out_dir = options.out_dir
        if episode.locked and not options.include_locked:
            return locked_result(episode)
        existing = existing_episode_file(out_dir, episode)
        if existing is not None and not options.overwrite:
            return DownloadResult(
                episode=episode,
                status=DownloadStatus.SKIPPED_EXISTS,
                path=existing,
                message=f"already exists: {existing.name}",
            )
        if options.dry_run:
            return DownloadResult(
                episode=episode,
                status=DownloadStatus.DRY_RUN,
                message=f"would download {episode.page_url}",
            )
        problem = cookies_file_problem(options.cookies_file)
        if problem is not None:
            return DownloadResult(episode=episode, status=DownloadStatus.FAILED, message=problem)
        params = self.build_options(episode, options, output_template(out_dir, episode))
        try:
            out_dir.mkdir(parents=True, exist_ok=True)
            with self._ydl_factory(params) as ydl:
                retcode = ydl.download([episode.page_url])
        except Exception as exc:
            message = sanitize_error(str(exc) or exc.__class__.__name__)
            status = self.classify_error(message)
            return DownloadResult(
                episode=episode, status=status, message=describe_failure(status, message)
            )
        if retcode not in (0, None):
            return DownloadResult(
                episode=episode,
                status=DownloadStatus.FAILED,
                message=f"yt-dlp exited with code {retcode}",
            )
        produced = existing_episode_file(out_dir, episode)
        if produced is None:
            return DownloadResult(
                episode=episode,
                status=DownloadStatus.FAILED,
                message="yt-dlp finished but no file appeared in the series directory",
            )
        return DownloadResult(
            episode=episode,
            status=DownloadStatus.DONE,
            path=produced,
            message=f"saved {produced.name}",
        )

    @staticmethod
    def classify_error(message: str) -> DownloadStatus:
        """Map a yt-dlp error message to the closest DownloadStatus (case-insensitive).

        Login wording wins, then HTTP 429 (``\\b429\\b``, "too many requests", "rate limit"),
        then HTTP 403 ("HTTP Error 403", "forbidden", "access denied" -> FAILED_BLOCKED), then
        the "unavailable" family; anything else is a plain FAILED.
        """
        text = message.lower()
        if any(
            marker in text
            for marker in ("requiring login", "login required", "log in", "logged-in", "logged in")
        ):
            return DownloadStatus.FAILED_LOGIN
        if _RATE_LIMIT_RE.search(text):
            return DownloadStatus.FAILED_RATE_LIMITED
        if _BLOCKED_RE.search(text):
            return DownloadStatus.FAILED_BLOCKED
        if any(
            marker in text
            for marker in (
                "no video formats",
                "not available",
                "unavailable",
                "private",
                "removed",
                "geo",
                "country",
            )
        ):
            return DownloadStatus.FAILED_UNAVAILABLE
        return DownloadStatus.FAILED
