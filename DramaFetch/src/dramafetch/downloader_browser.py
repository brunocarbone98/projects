"""Browser download engine: fetch each episode's play URL inside one browser session.

Why a second engine: yt-dlp downloads an episode by loading its video page and then the video —
at least two requests per episode, from a client that is not the browser that listed the series.
TikTok's ``item_list`` payload already carries every episode's signed play URLs
(``video.bitrateInfo[*].PlayAddr.UrlList`` and ``video.playAddr``, valid until their ``expire``
timestamp), so this engine fetches them directly, from a Chromium session of its own set up like
the discovery's (same Chrome user agent, same cookies file): no per-episode page load, about half
the requests. When the signed URLs have expired (long runs, a list resolved a while ago) it opens
the series page once more inside that session, takes the fresh list and caches it for the rest of
the run.

Scope and conduct are the same as everywhere else in DramaFetch: only episodes the account can
already watch (a locked episode has no play URL and stays skipped), one request at a time and at
most :data:`MAX_GETS_PER_EPISODE` per episode (the engine paces the calls; this class never
retries on its own beyond the next listed URL), a stop at the first sign of blocking (HTTP 429, a
captcha page), Chromium with its default flags, a Chrome user agent, nothing hidden and nothing
bypassed. Once an episode's video is written, and only then, one more small request fetches its
cover image (``Episode.cover_url``) unless ``DownloadOptions.thumbnail`` is ``none``; by default
the cover goes INTO the MP4 as its cover art (``dramafetch.thumbnails.embed_cover``, never
touching the video in place), with ``both`` it is also kept — and with ``file`` only kept — as
``<stem>.jpg``/``.png``/``.webp`` next to the video. That request is outside the media budget
(:data:`MAX_COVER_GETS`) and whatever becomes of the cover never changes the episode's status.
Cookie values and signed URLs never reach messages or logs: messages carry host names only.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

from dramafetch.catalog import play_url_candidates, url_expiry
from dramafetch.discovery.browser import VIEWPORT, PlaywrightDiscovery
from dramafetch.discovery.cookies import load_netscape_cookies
from dramafetch.discovery.static import chrome_user_agent, cookie_domain_filter
from dramafetch.downloader import existing_episode_file, locked_result, sanitize_error
from dramafetch.errors import (
    ChallengeError,
    DramaFetchError,
    LoginRequiredError,
    RateLimitedError,
    ThumbnailError,
)
from dramafetch.manifest import episode_stem
from dramafetch.models import (
    DiscoveryOptions,
    DownloadOptions,
    DownloadResult,
    DownloadStatus,
    Episode,
    SeriesRef,
)
from dramafetch.thumbnails import (
    MAX_COVER_BYTES,
    MIN_IMAGE_BYTES,
    embed_cover,
    extension_for,
    format_size,
    image_kind,
    image_problem,
)

if TYPE_CHECKING:
    from playwright.sync_api import APIResponse, Browser, BrowserContext

log = logging.getLogger(__name__)

#: A real episode is megabytes; anything under this is an error page, not a video.
MIN_VIDEO_BYTES = 64 * 1024
#: A play URL that expires within this many seconds is treated as expired (the download takes time).
EXPIRY_MARGIN_S = 60
REQUEST_TIMEOUT_MS = 120_000
MAX_REDIRECTS = 5
#: Media requests one episode may cost, over its listed URLs and the fresh list together: a locked
#: or region-restricted episode must not turn into a burst of requests against every mirror.
MAX_GETS_PER_EPISODE = 4
#: Cover (thumbnail) requests per episode, on top of the media budget: the one URL the episode
#: list names, after the video is on disk; never a retry, never a second candidate.
MAX_COVER_GETS = 1
#: How long the in-session refresh waits for the episode list (the discovery default is 45 s too).
REFRESH_TIMEOUT_S = 45.0
UNAVAILABLE_MESSAGE = "no playable stream: locked, region-restricted or not logged in"
RATE_LIMIT_MESSAGE = (
    "rate limited (HTTP 429) by the video server: wait 30-60 minutes before trying again"
)
_MIB = 1024 * 1024
#: Answers that mean "not this URL" (expired signature, gone, not for this account): try the next
#: candidate, then a fresh list; everything else non-200 is an outright failure.
_DENIED_STATUSES = frozenset({403, 404, 410})
_VIDEO_CONTENT_TYPES = ("video/", "application/octet-stream")
_MP4_MAGIC = b"ftyp"


@dataclass(frozen=True)
class _Attempt:
    """Why one candidate URL did not yield a video (token-free, fit for a message)."""

    reason: str
    unavailable: bool  # denied status or a non-video body → FAILED_UNAVAILABLE, else FAILED


class BrowserDownloader:
    """Downloads one episode at a time from the play URLs its item already carries.

    One Chromium is launched lazily on the first episode that needs the network and one context
    serves the whole run (the engine calls :meth:`close` at the end). ``playwright_factory`` is a
    callable returning the ``sync_playwright()`` context manager (tests inject a fake object graph)
    and ``clock`` is what the expiry check compares against.
    """

    def __init__(
        self,
        playwright_factory: Callable[[], Any] | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._factory = playwright_factory
        self._clock = clock
        self._stack: ExitStack | None = None
        self._context: BrowserContext | None = None
        self._setup_error: str | None = None  # a failed launch is reported, not repeated
        # series id -> item id -> the item from the most recent in-session refresh of that series
        self._fresh_items: dict[str, dict[str, dict[str, Any]]] = {}
        self.refreshes = 0  # in-session refreshes of an episode list performed so far

    def __enter__(self) -> BrowserDownloader:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    @property
    def browser_started(self) -> bool:
        return self._context is not None

    # -- the Downloader protocol ---------------------------------------------------------------

    def download(self, episode: Episode, options: DownloadOptions) -> DownloadResult:
        """Download into ``options.out_dir`` (already the SERIES directory). Never raises.

        Skip rules as for yt-dlp: a locked episode (unless ``include_locked``), an existing
        ``<episode stem>.<video ext>`` file (unless ``overwrite``) and a dry run never touch the
        network — an episode skipped for its existing video does not fetch a missing cover either.
        After a DONE the cover is fetched (see :meth:`_thumbnail`); its outcome only ever adds to
        the message.
        """
        if episode.locked and not options.include_locked:
            return locked_result(episode)
        existing = existing_episode_file(options.out_dir, episode, options)
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
                message=self._dry_run_message(episode, options),
            )
        try:
            result = self._download(episode, options)
        except LoginRequiredError as exc:
            return self._failure(episode, DownloadStatus.FAILED_LOGIN, exc)
        except RateLimitedError as exc:
            return self._failure(episode, DownloadStatus.FAILED_RATE_LIMITED, exc)
        except ChallengeError as exc:
            # A captcha wall on the series page during the refresh: TikTok's protection has this
            # session in view, so the run stops here (the engine does, on FAILED_BLOCKED).
            return self._failure(episode, DownloadStatus.FAILED_BLOCKED, exc)
        except Exception as exc:
            return self._failure(episode, DownloadStatus.FAILED, exc)
        if result.status is DownloadStatus.DONE and result.path is not None:
            result.message += self._thumbnail(episode, options, result.path)
        return result

    def close(self) -> None:
        """Close the context, the browser and Playwright; idempotent, fine before any launch."""
        stack, self._stack, self._context = self._stack, None, None
        if stack is None:
            return
        try:
            stack.close()
        except Exception as exc:
            log.debug("closing the browser failed: %s", _one_line(exc))

    # -- one episode ---------------------------------------------------------------------------

    def _download(self, episode: Episode, options: DownloadOptions) -> DownloadResult:
        context = self._ensure_context(options)
        target = options.out_dir / (episode_stem(episode, options) + ".mp4")
        tried: set[str] = set()  # every URL requested for this episode: its request budget
        refreshed = False
        candidates = self._usable_candidates(episode.raw)
        if not candidates:
            refreshed = True
            self._refresh(context, episode, options, tried)
            candidates = self._usable_candidates(episode.raw)
            if not candidates:
                return DownloadResult(
                    episode=episode,
                    status=DownloadStatus.FAILED_UNAVAILABLE,
                    message=f"{UNAVAILABLE_MESSAGE} (no play url, even in a fresh episode list)",
                )
        result, last = self._try_candidates(context, episode, options, candidates, target, tried)
        if result is not None:
            return result
        assert last is not None
        # A fresh list is worth a page load only after denials (a 5xx is the server failing, not
        # this URL) and while the episode's request budget has room to try what it brings.
        if not refreshed and last.unavailable and len(tried) < MAX_GETS_PER_EPISODE:
            try:
                self._refresh(context, episode, options, tried)
            except (LoginRequiredError, RateLimitedError, ChallengeError):
                raise
            except DramaFetchError as exc:
                return DownloadResult(
                    episode=episode,
                    status=DownloadStatus.FAILED,
                    message=f"{last.reason}; refreshing the episode list failed: {_one_line(exc)}",
                )
            fresh = [url for url in self._usable_candidates(episode.raw) if url not in tried]
            if fresh:
                result, retried = self._try_candidates(
                    context, episode, options, fresh, target, tried
                )
                if result is not None:
                    return result
                last = retried or last
        if last.unavailable:
            return DownloadResult(
                episode=episode,
                status=DownloadStatus.FAILED_UNAVAILABLE,
                message=f"{UNAVAILABLE_MESSAGE} ({last.reason})",
            )
        return DownloadResult(
            episode=episode, status=DownloadStatus.FAILED, message=f"download failed: {last.reason}"
        )

    def _try_candidates(
        self,
        context: BrowserContext,
        episode: Episode,
        options: DownloadOptions,
        candidates: list[str],
        target: Path,
        tried: set[str],
    ) -> tuple[DownloadResult | None, _Attempt | None]:
        """GET the candidates in order, within the episode's budget of :data:`MAX_GETS_PER_EPISODE`
        requests (``tried`` holds every URL requested so far), until one yields a video (DONE) or
        the server rate-limits (FAILED_RATE_LIMITED). A denied status or a non-video body moves on
        to the next URL; any other status stops. Otherwise return why the last one was no good."""
        headers = {"Referer": options.base_url.rstrip("/") + "/", "Accept": "*/*"}
        last: _Attempt | None = None
        for url in candidates:
            if len(tried) >= MAX_GETS_PER_EPISODE:
                log.debug(
                    "episode %s: budget of %d requests spent; %d play URL(s) left untried",
                    episode.number,
                    MAX_GETS_PER_EPISODE,
                    sum(1 for candidate in candidates if candidate not in tried),
                )
                break
            tried.add(url)
            host = _host(url)
            response = context.request.get(
                url, headers=headers, max_redirects=MAX_REDIRECTS, timeout=REQUEST_TIMEOUT_MS
            )
            try:
                status = response.status
                if status == 429:
                    log.debug("episode %s: HTTP 429 from %s", episode.number, host)
                    return (
                        DownloadResult(
                            episode=episode,
                            status=DownloadStatus.FAILED_RATE_LIMITED,
                            message=RATE_LIMIT_MESSAGE,
                        ),
                        None,
                    )
                if status != 200:
                    log.debug("episode %s: HTTP %s from %s", episode.number, status, host)
                    last = _Attempt(f"HTTP {status} from {host}", status in _DENIED_STATUSES)
                    if status in _DENIED_STATUSES:
                        continue
                    break  # the server failing, not this URL: no next mirror, no fresh list
                body = response.body()
                content_type = response.headers.get("content-type", "")
            finally:
                _dispose(response)
            problem = _body_problem(body, content_type)
            if problem is not None:
                log.debug("episode %s: %s from %s", episode.number, problem, host)
                last = _Attempt(f"{problem} from {host}", True)
                continue
            _write_atomically(target, body)
            return (
                DownloadResult(
                    episode=episode,
                    status=DownloadStatus.DONE,
                    path=target,
                    message=f"saved {target.name} ({len(body) / _MIB:.1f} MiB)",
                ),
                None,
            )
        return None, last

    def _dry_run_message(self, episode: Episode, options: DownloadOptions) -> str:
        thumbnail = " + cover" if options.thumbnails and episode.cover_url else ""
        candidates = play_url_candidates(episode.raw) if episode.raw is not None else []
        if not candidates:
            return (
                "would download: no play url in the episode list (it would be refreshed first)"
                + thumbnail
            )
        suffix = "" if self._usable(candidates[0]) else " (play url expired: fresh list first)"
        return f"would download from {_host(candidates[0])}{suffix}{thumbnail}"

    # -- the cover (thumbnail) -----------------------------------------------------------------

    def _thumbnail(self, episode: Episode, options: DownloadOptions, video: Path) -> str:
        """Fetch the episode cover and embed it into ``video`` and/or save it next to it as
        ``<stem>.<jpg|png|webp>``, as ``options.thumbnail`` says (see :func:`_keep_cover`).

        Called once the video is on disk, and only when ``options.thumbnails`` and the episode
        list named a cover. Exactly one request (:data:`MAX_COVER_GETS`), outside the media budget
        of :data:`MAX_GETS_PER_EPISODE` and with no pause before it: a browser loads an episode's
        cover together with the page, so the cover following the video at once is what a viewer's
        session looks like. Returns what to append to the DONE message: ``" + cover embedded"``,
        ``" + cover embedded + file"`` or ``" + cover file"`` on success, else ``"; cover:
        <reason>"`` — a cover that cannot be had never changes the episode's status, is logged at
        DEBUG (host names only) and, for an HTTP 429, at WARNING: the next video request will stop
        the run if TikTok is really limiting. Never raises.
        """
        if not options.thumbnails or not episode.cover_url:
            return ""
        context = self._context
        if context is None:  # a DONE always has a session; stated for the type checker
            return "; cover: no browser session"
        url = episode.cover_url
        host = _host(url)
        headers = {"Referer": options.base_url.rstrip("/") + "/", "Accept": "image/*,*/*"}
        try:
            response = context.request.get(
                url, headers=headers, max_redirects=MAX_REDIRECTS, timeout=REQUEST_TIMEOUT_MS
            )
            try:
                status = response.status
                if status == 429:
                    log.warning(
                        "episode %s: HTTP 429 for the cover from %s; the video came through, so "
                        "the run goes on",
                        episode.number,
                        host,
                    )
                    return f"; cover: HTTP 429 from {host}"
                if status != 200:
                    log.debug("episode %s: cover HTTP %s from %s", episode.number, status, host)
                    return f"; cover: HTTP {status} from {host}"
                body = response.body()
                content_type = response.headers.get("content-type", "")
            finally:
                _dispose(response)
            kind = image_kind(body, content_type)
            if kind is None or len(body) < MIN_IMAGE_BYTES:
                problem = image_problem(body, content_type)
                log.debug("episode %s: cover %s from %s", episode.number, problem, host)
                return f"; cover: {problem} from {host}"
            if len(body) > MAX_COVER_BYTES:
                size = format_size(len(body))
                log.debug("episode %s: cover of %s from %s not kept", episode.number, size, host)
                return "; cover: too large, not kept"
            return _keep_cover(video, body, kind, options)
        except Exception as exc:
            reason = _one_line(exc)
            log.debug("episode %s: cover from %s failed: %s", episode.number, host, reason)
            return f"; cover: {reason}"

    def _failure(
        self, episode: Episode, status: DownloadStatus, exc: BaseException
    ) -> DownloadResult:
        message = _one_line(exc)
        log.debug("episode %s: %s (%s)", episode.number, status.value, message)
        return DownloadResult(episode=episode, status=status, message=message)

    # -- play URL candidates and their expiry --------------------------------------------------

    def _usable_candidates(self, item: dict[str, Any] | None) -> list[str]:
        if item is None:
            return []
        return [url for url in play_url_candidates(item) if self._usable(url)]

    def _usable(self, url: str) -> bool:
        """False when the URL's ``expire`` is in the past or within :data:`EXPIRY_MARGIN_S`."""
        expiry = url_expiry(url)
        return expiry is None or expiry > self._clock() + EXPIRY_MARGIN_S

    # -- refreshing the episode list inside the session ----------------------------------------

    def _refresh(
        self, context: BrowserContext, episode: Episode, options: DownloadOptions, stale: set[str]
    ) -> None:
        """Replace ``episode.raw`` with the item from a fresh episode list.

        The series is resolved again — through a new page of the same context, with the
        discovery's own logic, cookies and user agent — only when this run holds no fresh list for
        it yet, or when that list's entry for the episode is spent (see :meth:`_cache_spent`); the
        result is cached, so a run over a long series refreshes once, not once per episode.
        """
        fresh = self._fresh_items.get(episode.series_id)
        if fresh is None or self._cache_spent(fresh.get(episode.item_id), stale):
            fresh = self._resolve_in_session(context, episode, options)
            self._fresh_items[episode.series_id] = fresh
        cached = fresh.get(episode.item_id)
        if cached is not None:
            episode.raw = cached

    def _cache_spent(self, item: dict[str, Any] | None, stale: set[str]) -> bool:
        """Whether the fresh list's entry for an episode calls for a newer list: it names play URLs,
        but every one of them has been tried (``stale``) or has expired. An entry without any play
        URL (a locked episode) and an episode the fresh list does not carry at all are final — one
        more page load would not add a URL — so they never cost one."""
        if item is None:
            return False
        candidates = play_url_candidates(item)
        if not candidates:
            return False
        return all(url in stale or not self._usable(url) for url in candidates)

    def _resolve_in_session(
        self, context: BrowserContext, episode: Episode, options: DownloadOptions
    ) -> dict[str, dict[str, Any]]:
        discovery_options = DiscoveryOptions(
            cookies_file=options.cookies_file,  # the context holds them; this shapes messages
            headful=options.browser_headful,
            base_url=options.base_url,
            timeout_s=REFRESH_TIMEOUT_S,
            strategy="browser",
        )
        ref = SeriesRef(series_id=episode.series_id, episode_hint=episode.number)
        self.refreshes += 1
        page = context.new_page()
        try:
            series = PlaywrightDiscovery().discover_in_page(page, ref, discovery_options)
        finally:
            _close_quietly(page)
        log.debug(
            "refreshed the episode list of series %s: %d episodes",
            episode.series_id,
            len(series.episodes),
        )
        return {e.item_id: e.raw for e in series.episodes if e.raw is not None}

    # -- the browser session -------------------------------------------------------------------

    def _ensure_context(self, options: DownloadOptions) -> BrowserContext:
        if self._context is not None:
            return self._context
        if self._setup_error is not None:
            raise DramaFetchError(self._setup_error)
        try:
            self._context = self._open(options)
        except Exception as exc:
            self._setup_error = _launch_message(exc)
            self.close()
            raise DramaFetchError(self._setup_error) from exc
        return self._context

    def _open(self, options: DownloadOptions) -> BrowserContext:
        factory = self._factory if self._factory is not None else _default_factory()
        stack = ExitStack()
        try:
            playwright = stack.enter_context(factory())
            kwargs: dict[str, Any] = {"headless": not options.browser_headful}
            if options.browser_executable is not None:
                kwargs["executable_path"] = str(options.browser_executable)
            elif options.browser_channel:
                kwargs["channel"] = options.browser_channel
            browser: Browser = playwright.chromium.launch(**kwargs)
            stack.callback(browser.close)
            context = browser.new_context(
                user_agent=chrome_user_agent(browser.version),
                locale="en-US",
                viewport=VIEWPORT,
            )
            stack.callback(context.close)
            self._add_cookies(context, options)
        except BaseException:
            stack.close()
            raise
        self._stack = stack
        return context

    @staticmethod
    def _add_cookies(context: BrowserContext, options: DownloadOptions) -> None:
        if options.cookies_file is None:
            return
        domain = cookie_domain_filter(options.base_url)
        try:
            cookies = load_netscape_cookies(options.cookies_file, domain_filter=domain)
        except (OSError, ValueError) as exc:
            raise DramaFetchError(f"cookies file: {_one_line(exc)}") from exc
        if not cookies:
            log.warning(
                "cookies file has no unexpired cookies for %s; downloading without a session",
                domain,
            )
            return
        cookie_params: Any = cookies  # Playwright types this with its private SetCookieParam
        try:
            context.add_cookies(cookie_params)
        except Exception as exc:
            # Fixed text on purpose: a protocol error could echo the cookie it rejected.
            raise DramaFetchError(
                f"could not load the cookies into the browser ({exc.__class__.__name__})"
            ) from None


# -- module helpers ------------------------------------------------------------------------------


def _default_factory() -> Callable[[], Any]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise DramaFetchError(
            "playwright is not installed: pip install playwright && playwright install chromium"
        ) from exc
    return sync_playwright


def _body_problem(body: bytes, content_type: str) -> str | None:
    """Why a 200 answer is not a video: too small, or neither a video content type nor MP4 bytes."""
    kind = content_type.split(";")[0].strip().lower() or "an untyped body"
    if len(body) < MIN_VIDEO_BYTES:
        return f"{format_size(len(body))} of {kind} instead of a video"
    if not kind.startswith(_VIDEO_CONTENT_TYPES) and _MP4_MAGIC not in body[:32]:
        return f"{kind} instead of a video"
    return None


def _keep_cover(video: Path, body: bytes, kind: str, options: DownloadOptions) -> str:
    """Embed the cover ``body`` (an image of ``kind``, see
    :func:`~dramafetch.thumbnails.image_kind`) into ``video`` and/or save it next to it as
    ``<stem>.<jpg|png|webp>``, per ``options.thumbnail``; the suffix for the DONE message.

    ``file`` saves the sidecar: ``" + cover file"``. ``embed`` and ``both`` call
    :func:`~dramafetch.thumbnails.embed_cover` (the video is copied, never edited in place):
    ``" + cover embedded"``, with ``both`` ``" + cover embedded + file"``. A WEBP cannot live in a
    ``covr`` atom and an embed that fails (:class:`~dramafetch.errors.ThumbnailError`: not an MP4,
    mutagen missing or failing) is no reason to lose the cover: it is saved as the sidecar instead,
    whatever the mode, and the message says ``"; cover: webp cannot be embedded; saved as file"``
    or ``"; cover: could not embed (<reason>); saved as file"``.
    """
    sidecar = video.with_suffix(extension_for(kind))
    if not options.embed_cover:
        _write_atomically(sidecar, body)
        return " + cover file"
    if kind == "webp":
        _write_atomically(sidecar, body)
        return "; cover: webp cannot be embedded; saved as file"
    try:
        embed_cover(video, body)
    except ThumbnailError as exc:
        log.debug("cover of %s not embedded: %s", video.name, exc)
        _write_atomically(sidecar, body)
        return f"; cover: could not embed ({exc}); saved as file"
    if options.keep_cover_file:
        _write_atomically(sidecar, body)
        return " + cover embedded + file"
    return " + cover embedded"


def _write_atomically(target: Path, body: bytes) -> None:
    """Write ``<target>.part`` and rename it over ``target``; nothing partial is left behind."""
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + ".part")
    try:
        part.write_bytes(body)
        part.replace(target)
    except BaseException:
        part.unlink(missing_ok=True)
        raise


def _dispose(response: APIResponse) -> None:
    try:
        response.dispose()
    except Exception as exc:  # the body is already in memory; nothing depends on this
        log.debug("disposing a response failed: %s", _one_line(exc))


def _close_quietly(page: Any) -> None:
    try:
        page.close()
    except Exception as exc:
        log.debug("closing the refresh page failed: %s", _one_line(exc))


def _launch_message(exc: BaseException) -> str:
    first = _one_line(exc)
    lowered = first.lower()
    if "executable doesn't exist" in lowered or "executable_path" in lowered:
        first += (
            " (run `playwright install chromium`, or pass --browser-channel chrome "
            "or --browser-path PATH)"
        )
    return f"could not start the browser: {first}"


def _host(url: str) -> str:
    """The host of a URL, the only part of a signed play URL that may appear in a message."""
    return urlsplit(url).hostname or "unknown host"


def _one_line(exc: BaseException) -> str:
    """The first line of an exception, every line of it redacted first (see
    :func:`~dramafetch.downloader.sanitize_error`); the class name when it has no text."""
    return sanitize_error(str(exc) or exc.__class__.__name__)
