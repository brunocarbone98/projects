"""Hand one episode to yt-dlp. Per-episode failures are reported in the result, never raised.

TikTok facts this module relies on (verified October 2026): yt-dlp does not recognise the
``/shortdrama/episode/<series_id>/<n>`` URL (yt-dlp/yt-dlp#17725), but every episode is also an
ordinary video at ``https://www.tiktok.com/@<user>/video/<item_id>`` (the username segment is not
checked), which yt-dlp downloads as a single progressive file — no merging, so ffmpeg is optional.
Without a logged-in session TikTok returns no formats ("No video formats found") or redirects to
``/login``, so a Netscape ``cookies.txt`` (or ``--cookies-from-browser``) is the normal way to run.
Locked episodes (``Episode.locked``: not unlocked by this account) are skipped before any network
access; nothing here unlocks or bypasses anything. Cookie values are never logged; error messages
are redacted just in case.

Every file yt-dlp produces is first checked for encrypted tracks (``dramafetch.media.drm_problem``,
ALWAYS, ``--no-verify`` or not): an encrypted file can never play and DramaFetch never decrypts, so
it is deleted with the cover and any partial file next to it, and the episode is
FAILED_UNAVAILABLE with ``models.DRM_MESSAGE``. yt-dlp's own "This video is DRM protected" maps to
the same status and message (:meth:`YtDlpDownloader.classify_error`, :func:`describe_failure`), and
``allow_unplayable_formats`` is never set. Then every file is verified
(``dramafetch.media.verify_video``: an MP4 that parses, is not cut short, has an audio track and
lasts about ``Episode.duration_s``) unless ``DownloadOptions.verify`` is off; a file that fails is
renamed ``<name> (incomplete).<ext>`` (``media.quarantine``; one the OS will not rename is deleted
rather than left under the episode's name), the cover yt-dlp wrote is deleted and the episode is
FAILED with ``"download looks incomplete or wrong: <reason> (kept as <name>)"`` — a rerun tries it
again. Only then is the episode cover yt-dlp saved next to the video
(``writethumbnail``) embedded into the MP4 as its cover art, kept as a file, or both, as
``DownloadOptions.thumbnail`` says (see :func:`_finish_cover` and ``dramafetch.thumbnails``);
what became of it is appended to the DONE message and never changes the status.
"""

from __future__ import annotations

import importlib
import logging
import re
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from dramafetch.discovery.cookies import cookie_file_problems
from dramafetch.discovery.static import redact_tokens, safe_url
from dramafetch.errors import ThumbnailError
from dramafetch.manifest import episode_stem
from dramafetch.media import (
    INCOMPLETE_PREFIX,
    discard_note,
    drm_problem,
    quarantine_note,
    verify_video,
)
from dramafetch.models import (
    DRM_MARK,
    DRM_MESSAGE,
    DownloadOptions,
    DownloadResult,
    DownloadStatus,
    Episode,
)
from dramafetch.thumbnails import (
    COVER_SUFFIXES,
    MAX_COVER_BYTES,
    embed_cover,
    extension_for,
    image_kind,
)

log = logging.getLogger(__name__)

TIKTOK_REFERER = "https://www.tiktok.com/"
#: yt-dlp format selectors per ``DownloadOptions.quality`` (see :func:`format_for`): ``compatible``
#: takes the highest-bitrate H.264 and falls back to the best of anything, ``best`` the highest
#: bitrate whatever the codec. TikTok formats are progressive, so a selector only chooses a file;
#: nothing is merged or re-encoded.
COMPATIBLE_FORMAT = "best[vcodec^=h264]/best[vcodec=avc1]/best"
BEST_FORMAT = "best"
H264_FORMAT = COMPATIBLE_FORMAT  # the former name of COMPATIBLE_FORMAT
MAX_MESSAGE_LEN = 300
#: yt-dlp retries per download are capped here whatever ``DownloadOptions.retries`` says: after a
#: refusal every retry is one more request against the same address, which is what trips TikTok's
#: protection. The CLI rejects larger values up front.
MAX_RETRIES = 3
#: Prefix of the message of a FAILED_BLOCKED result (HTTP 403 / forbidden / access denied).
BLOCKED_MESSAGE = (
    "blocked (HTTP 403): TikTok refused the request; wait 30-60 minutes before trying again"
)
#: Extensions yt-dlp's ``writethumbnail`` can give the cover — always the cover URL's own:
#: ``.jpeg`` for TikTok's ``cover``/``originCover``, ``.image`` for its ``dynamicCover`` URLs
#: (``…~tplv-tiktokx-origin.image``), written only when the preferred covers fail; a URL without
#: an extension would get ``.jpg``. See :func:`_written_cover`.
WRITTEN_COVER_SUFFIXES = (*COVER_SUFFIXES, ".image")

_PARTIAL_SUFFIXES = (".part", ".ytdl", ".temp", ".tmp")
#: Extensions that count as "the episode's video" when looking for an existing file. The cover
#: saved next to a video (``<stem>.jpeg``/``.jpg``/``.png``/``.webp``) must never pass for the
#: video, or an episode whose download failed after the cover was written would be skipped for
#: good.
VIDEO_SUFFIXES = frozenset({".mp4", ".m4v", ".mov", ".mkv", ".webm"})
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
# DRM in yt-dlp's words: "This video is DRM protected" (every format flagged `has_drm`, which yt-dlp
# drops while `allow_unplayable_formats` is off — and DramaFetch never turns it on). A whole token,
# so that no id or word that merely contains the letters counts. No retry can change the verdict.
_DRM_RE = re.compile(r"\bdrm\b")


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


def format_for(quality: str) -> str:
    """The yt-dlp format selector for a ``DownloadOptions.quality``: :data:`BEST_FORMAT` for
    ``best``, :data:`COMPATIBLE_FORMAT` otherwise."""
    return BEST_FORMAT if quality == "best" else COMPATIBLE_FORMAT


def is_partial_file(name: str) -> bool:
    """yt-dlp's in-progress artefacts (``.part``, ``.ytdl``, ``.part-Frag3``...)."""
    return name.endswith(_PARTIAL_SUFFIXES) or ".part-Frag" in name


def existing_episode_file(out_dir: Path, episode: Episode, options: DownloadOptions) -> Path | None:
    """The newest complete VIDEO named exactly ``<episode stem>.<ext>`` in ``out_dir``, if any.

    The stem follows ``options.name_format`` (:func:`~dramafetch.manifest.episode_stem`) and must
    match whole (``Path.stem``, which drops the last suffix only): with ``{title}`` in the format,
    another episode's ``Ep 1.5.mp4`` is not ``Ep 1``'s file, while a dotted series name such as
    ``Dr. Who v1.2 - Episode 01.mp4`` still finds its own. Only files whose extension is in
    :data:`VIDEO_SUFFIXES` count, so a cover sidecar (``<stem>.jpeg``/``.jpg``) or an in-progress
    ``.part`` never passes for the episode.
    """
    if not out_dir.is_dir():
        return None
    stem = episode_stem(episode, options)
    candidates = [
        path
        for path in out_dir.iterdir()
        if path.is_file()
        and path.stem == stem
        and path.suffix.lower() in VIDEO_SUFFIXES
        and not is_partial_file(path.name)
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda path: path.stat().st_mtime)


def output_template(out_dir: Path, episode: Episode, options: DownloadOptions) -> str:
    """yt-dlp ``outtmpl`` for the episode: ``<out_dir>/<episode stem>.%(ext)s``.

    Everything except the final ``%(ext)s`` is literal text that TikTok partly controls (the series
    name in ``out_dir`` and in the stem, the episode title in the stem), so its percent signs are
    doubled: yt-dlp expands ``%(name)s`` sequences in the template, and an unescaped
    ``%(cookies)s`` in a title would otherwise put the session cookies into the file name.
    """
    return str(out_dir / episode_stem(episode, options)).replace("%", "%%") + ".%(ext)s"


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
    """The SKIPPED_LOCKED result for a locked episode (``Episode.locked``: the payload says this
    session cannot play it): ``"looks locked: <hints>"``, or — the payload itself flags DRM
    (``Episode.drm``) — ``"protected by DRM (<hints>): DramaFetch does not decrypt it"``
    (:data:`~dramafetch.models.DRM_MARK` first, as every DRM message)."""
    hints = "; ".join(episode.lock_hints)
    if episode.drm:
        message = f"{DRM_MARK} ({hints}): DramaFetch does not decrypt it" if hints else DRM_MESSAGE
    else:
        message = f"looks locked: {hints}" if hints else "looks locked"
    return DownloadResult(episode=episode, status=DownloadStatus.SKIPPED_LOCKED, message=message)


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
    :data:`BLOCKED_MESSAGE` (what happened and what to do), a FAILED_UNAVAILABLE one that names DRM
    with :data:`~dramafetch.models.DRM_MESSAGE` (so it starts with ``DRM_MARK``, which is how the
    manifest remembers it), the others keep yt-dlp's words."""
    if status is DownloadStatus.FAILED_BLOCKED:
        return f"{BLOCKED_MESSAGE}: {message}" if message else BLOCKED_MESSAGE
    if status is DownloadStatus.FAILED_UNAVAILABLE and mentions_drm(message):
        return f"{DRM_MESSAGE}: {message}"
    return message


def mentions_drm(message: str) -> bool:
    """Whether an error message names DRM as a whole word (yt-dlp: "This video is DRM
    protected"), case-insensitively."""
    return _DRM_RE.search(message.lower()) is not None


def _written_cover(video: Path) -> Path | None:
    """The cover yt-dlp wrote next to ``video``: the first existing ``<stem>.<ext>`` for the
    extensions in :data:`WRITTEN_COVER_SUFFIXES`, or None."""
    for suffix in WRITTEN_COVER_SUFFIXES:
        candidate = video.with_suffix(suffix)
        if candidate.is_file():
            return candidate
    return None


def _leftovers(video: Path) -> list[Path]:
    """What a download left next to ``video`` besides the video itself: every cover
    ``<stem>.<ext>`` for the extensions in :data:`WRITTEN_COVER_SUFFIXES`, and yt-dlp's in-progress
    files of that very video (``<name>.part``, ``<name>.ytdl``, ``<name>.part-Frag3``, …: the
    whole file name first, so another episode's files never match)."""
    found = [video.with_suffix(suffix) for suffix in WRITTEN_COVER_SUFFIXES]
    found = [path for path in found if path.is_file()]
    try:
        found += [
            path
            for path in video.parent.iterdir()
            if path.name.startswith(video.name) and is_partial_file(path.name) and path.is_file()
        ]
    except OSError as exc:
        log.debug("could not list %s: %s", video.parent, exc.strerror)
    return found


def _finish_cover(video: Path, options: DownloadOptions) -> str:
    """Embed into ``video``, keep, or both, the cover yt-dlp wrote next to it, as
    ``options.thumbnail`` says; the suffix for the DONE message (empty for mode ``none``).

    The sidecar is read whole, capped at :data:`~dramafetch.thumbnails.MAX_COVER_BYTES` (over the
    cap it is deleted: ``"; cover: too large, not kept"``), and its kind sniffed from the bytes;
    a ``dynamicCover``'s ``.image`` is renamed to the real extension first. Then: mode ``file`` ->
    ``" + cover file"``; ``embed``/``both`` -> :func:`~dramafetch.thumbnails.embed_cover` (the
    video is copied, never edited in place) -> ``" + cover embedded"`` and the sidecar deleted,
    or ``" + cover embedded + file"`` for ``both``. Whatever cannot be embedded stays on disk, so
    nothing is lost: ``"; cover: webp cannot be embedded; file kept"``, ``"; cover: could not
    embed (<reason>); file kept"`` (:class:`~dramafetch.errors.ThumbnailError`: not an MP4,
    mutagen missing or failing), ``"; cover: not a JPEG, PNG or WEBP image; file kept"``. No
    sidecar at all (yt-dlp could not get the cover) -> ``"; cover: not available"``. Never
    raises; never changes the status.
    """
    if not options.thumbnails:
        return ""
    sidecar = _written_cover(video)
    if sidecar is None:
        return "; cover: not available"
    try:
        if sidecar.stat().st_size > MAX_COVER_BYTES:
            sidecar.unlink()
            return "; cover: too large, not kept"
        data = sidecar.read_bytes()
    except OSError as exc:
        return f"; cover: {exc.strerror or exc.__class__.__name__}; file kept"
    kind = image_kind(data)
    if kind is None:
        return "; cover: not a JPEG, PNG or WEBP image; file kept"
    if sidecar.suffix.lower() == ".image":
        sidecar = _rename_cover(sidecar, video.with_suffix(extension_for(kind)))
    if not options.embed_cover:
        return " + cover file"
    if kind == "webp":
        return "; cover: webp cannot be embedded; file kept"
    try:
        embed_cover(video, data)
    except ThumbnailError as exc:
        return f"; cover: could not embed ({exc}); file kept"
    if options.keep_cover_file:
        return " + cover embedded + file"
    try:
        sidecar.unlink()
    except OSError:  # the cover is in the video; a file that would not go is reported as kept
        return " + cover embedded + file"
    return " + cover embedded"


def _rename_cover(sidecar: Path, target: Path) -> Path:
    """Rename yt-dlp's ``<stem>.image`` to the extension its bytes call for; the path to use
    afterwards (the old one when the rename fails or ``target`` is already taken)."""
    if target.exists():
        return sidecar
    try:
        return sidecar.replace(target)
    except OSError:
        return sidecar


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
        With ``options.thumbnails`` (every mode but ``none``) yt-dlp also saves the episode cover
        next to the video (``writethumbnail``, no postprocessor, no ffmpeg) — its way, not the
        browser engine's: it fetches the cover just before the video, names the file after the
        cover URL's extension (``<stem>.jpeg`` for TikTok's covers), tries the next cover the
        extractor listed when one fails, and says nothing when none can be had. What DramaFetch
        then does with that file — embed it into the MP4, keep it, both — is
        :func:`_finish_cover`'s job, after the download. ``allow_unplayable_formats`` is never
        set: yt-dlp keeps dropping the formats it knows to be DRM-protected (its default), and
        DramaFetch never asks for media it could not play without decrypting it.
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
            "format": format_for(options.quality),
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
        if options.thumbnails:
            params["writethumbnail"] = True
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
        """Download into ``options.out_dir`` (already the SERIES directory). Never raises.

        After yt-dlp returns, the produced file is checked for encrypted tracks first — always,
        whatever ``options.verify`` says (:func:`~dramafetch.media.drm_problem`): an encrypted
        file is deleted with its cover and partial files (see :meth:`_discard_encrypted`) and the
        episode is FAILED_UNAVAILABLE. Then it is verified (``options.verify``, see
        :func:`~dramafetch.media.verify_video`) BEFORE the cover step: a file that fails is
        quarantined (see :meth:`_quarantine`) and the episode is FAILED; a file that passes gets
        its cover handled by :func:`_finish_cover`.
        """
        out_dir = options.out_dir
        if episode.locked and not options.include_locked:
            return locked_result(episode)
        existing = existing_episode_file(out_dir, episode, options)
        if existing is not None and not options.overwrite:
            return DownloadResult(
                episode=episode,
                status=DownloadStatus.SKIPPED_EXISTS,
                path=existing,
                message=f"already exists: {existing.name}",
            )
        if options.dry_run:
            cover = " + cover" if options.thumbnails else ""
            return DownloadResult(
                episode=episode,
                status=DownloadStatus.DRY_RUN,
                message=f"would download {episode.page_url}{cover}",
            )
        problem = cookies_file_problem(options.cookies_file)
        if problem is not None:
            return DownloadResult(episode=episode, status=DownloadStatus.FAILED, message=problem)
        params = self.build_options(episode, options, output_template(out_dir, episode, options))
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
        produced = existing_episode_file(out_dir, episode, options)
        if produced is None:
            return DownloadResult(
                episode=episode,
                status=DownloadStatus.FAILED,
                message="yt-dlp finished but no file appeared in the series directory",
            )
        encrypted = drm_problem(produced)  # always, whatever options.verify says
        if encrypted is not None:
            return self._discard_encrypted(episode, produced, encrypted)
        if options.verify:
            problem = verify_video(produced, episode.duration_s)
            if problem is not None:
                return self._quarantine(episode, produced, problem)
        return DownloadResult(
            episode=episode,
            status=DownloadStatus.DONE,
            path=produced,
            message=f"saved {produced.name}" + _finish_cover(produced, options),
        )

    @staticmethod
    def _quarantine(episode: Episode, produced: Path, problem: str) -> DownloadResult:
        """The FAILED result for a file that failed :func:`~dramafetch.media.verify_video`: the
        file is renamed ``<name> (incomplete).<ext>`` (:func:`~dramafetch.media.quarantine`) so
        that a rerun tries the episode again, the cover yt-dlp wrote next to it is deleted (no
        cover is embedded into or kept for a bad download), and the message is
        ``"download looks incomplete or wrong: <problem> (kept as <name>)"``. A file the OS will
        not rename is deleted instead — never left under the episode's name, where the next run
        would skip it as done — and the note says so (:func:`~dramafetch.media.quarantine_note`)."""
        sidecar = _written_cover(produced)
        if sidecar is not None:
            try:
                sidecar.unlink()
            except OSError as exc:
                log.debug("could not delete the cover %s: %s", sidecar.name, exc.strerror)
        note = quarantine_note(produced)
        log.debug("episode %s: %s (%s)", episode.number, problem, note)
        return DownloadResult(
            episode=episode,
            status=DownloadStatus.FAILED,
            message=f"{INCOMPLETE_PREFIX}{problem} ({note})",
        )

    @staticmethod
    def _discard_encrypted(episode: Episode, produced: Path, problem: str) -> DownloadResult:
        """The FAILED_UNAVAILABLE result for a file with encrypted tracks
        (:func:`~dramafetch.media.drm_problem`): DramaFetch never keeps encrypted media, so the
        video is deleted — not quarantined: no rerun makes it play — and so are the cover yt-dlp
        wrote next to it and any partial file of that download (:func:`_leftovers`); no cover is
        embedded or kept. The message is ``problem`` (:data:`~dramafetch.models.DRM_MESSAGE`),
        followed by ``(could not delete <name>: …)`` only when the OS refused to delete the video
        (:func:`~dramafetch.media.discard_note`)."""
        for leftover in _leftovers(produced):
            try:
                leftover.unlink(missing_ok=True)
            except OSError as exc:
                log.debug("could not delete %s: %s", leftover.name, exc.strerror)
        note = discard_note(produced)
        log.debug("episode %s: %s (%s)", episode.number, problem, note or "deleted")
        return DownloadResult(
            episode=episode,
            status=DownloadStatus.FAILED_UNAVAILABLE,
            message=problem if note is None else f"{problem} ({note})",
        )

    @staticmethod
    def classify_error(message: str) -> DownloadStatus:
        """Map a yt-dlp error message to the closest DownloadStatus (case-insensitive).

        DRM comes first (``\\bdrm\\b``: yt-dlp's "This video is DRM protected" ->
        FAILED_UNAVAILABLE, whatever else the message says: no retry, login or wait can change
        it; :func:`describe_failure` then puts :data:`~dramafetch.models.DRM_MESSAGE` first). Then
        login wording, then HTTP 429 (``\\b429\\b``, "too many requests", "rate limit"), then
        HTTP 403 ("HTTP Error 403", "forbidden", "access denied" -> FAILED_BLOCKED), then the
        "unavailable" family; anything else is a plain FAILED.
        """
        text = message.lower()
        if mentions_drm(text):
            return DownloadStatus.FAILED_UNAVAILABLE
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
