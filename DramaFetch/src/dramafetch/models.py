"""Data model shared by every module. Pure data: no I/O, no TikTok specifics beyond field names."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol

TIKTOK_BASE_URL = "https://www.tiktok.com"
#: Default file name of an episode (without extension); see ``manifest.episode_stem`` for the
#: placeholders: {series} {number} {n} {title} {id}.
DEFAULT_NAME_FORMAT = "{series} - Episode {number}"
#: ``DownloadOptions.thumbnail`` values — where an episode's cover goes: into the MP4 as its cover
#: art (``embed``, the default), into the MP4 and a file next to it (``both``), a file next to the
#: video only (``file``), nowhere (``none``: no cover request at all).
THUMBNAIL_MODES = ("embed", "both", "file", "none")
#: ``DownloadOptions.quality`` values — which rendition of an episode is taken: ``compatible``
#: (the default) the highest-bitrate H.264, which plays everywhere; ``best`` the highest bitrate
#: whatever the codec (TikTok's ``bytevc1``/H.265 renditions need a capable player). Nothing is
#: re-encoded; the source's top rendition is the ceiling.
QUALITY_MODES = ("compatible", "best")


@dataclass(frozen=True)
class SeriesRef:
    """A short-drama series as identified from a pasted URL.

    `/shortdrama/episode/<series_id>/<episode>` — the long number is the SERIES id (TikTok calls it
    `dramaID` in its API), not a video id; the trailing number is the 1-based episode the viewer was
    looking at, kept only as a hint for which page to open first.
    """

    series_id: str
    episode_hint: int | None = None
    source_url: str = ""


@dataclass(frozen=True)
class VideoRef:
    """A single ordinary TikTok video (`/@user/video/<item_id>`); downloadable without discovery."""

    item_id: str
    author: str | None = None
    source_url: str = ""


@dataclass
class Episode:
    """One episode of a series, as TikTok's `item_list` payload describes it.

    `number` comes from `dramaInfo.DramaVideoData.EpisodeNumber`, never from upload time (episodes
    are often published in one batch, so `createTime` order is a shuffle). `item_id` is the ordinary
    TikTok video id of the episode, which is what yt-dlp downloads.
    """

    number: int
    item_id: str
    title: str
    series_id: str
    series_name: str | None = None
    author: str | None = None
    duration_s: int | None = None
    # Human-readable reasons to believe the episode is locked/paid/unplayable, e.g. "isFree=false".
    # Empty means "nothing in the payload says it is locked" — not a guarantee it will download.
    lock_hints: tuple[str, ...] = ()
    # The episode cover (thumbnail): video.originCover, else video.cover, else video.dynamicCover.
    cover_url: str | None = None
    # What the default quality mode would download, e.g. "720p h264": the label of the rendition
    # ``catalog.choose_rendition(item, "compatible")`` picks; None when the item lists none.
    quality_hint: str | None = None
    raw: dict[str, Any] | None = field(default=None, repr=False, compare=False)

    @property
    def locked(self) -> bool:
        return bool(self.lock_hints)

    @property
    def page_url(self) -> str:
        """The ordinary video page yt-dlp understands. TikTok ignores the username segment."""
        return f"{TIKTOK_BASE_URL}/@{self.author or '_'}/video/{self.item_id}"


@dataclass
class Series:
    series_id: str
    name: str | None
    episodes: list[Episode]
    # Total announced by TikTok (series detail payload) when available; used to detect gaps.
    total_hint: int | None = None
    warnings: list[str] = field(default_factory=list)

    @property
    def numbers(self) -> list[int]:
        return [e.number for e in self.episodes]

    def episode(self, number: int) -> Episode | None:
        return next((e for e in self.episodes if e.number == number), None)

    @property
    def display_name(self) -> str:
        return self.name or f"series-{self.series_id}"


@dataclass
class DiscoveryOptions:
    """How to reach TikTok while resolving a series."""

    cookies_file: Path | None = None  # Netscape cookies.txt exported from a logged-in browser
    browser_channel: str | None = None  # "chrome" / "msedge" / None (Playwright's bundled Chromium)
    executable_path: Path | None = None  # explicit browser binary (CI, sandboxes)
    headful: bool = False  # show the window (lets a human pass a captcha or log in)
    base_url: str = TIKTOK_BASE_URL  # overridden by tests to point at the fake TikTok
    page_count: int = 30  # episodes requested per `item_list` page
    max_pages: int = 60  # hard stop for pagination (60 x 30 = 1800 episodes)
    timeout_s: float = 45.0  # waiting for the first episode payload
    page_delay_s: float = 0.8  # pause between pages (the web app itself paces like this)
    dump_dir: Path | None = None  # write every raw payload here for diagnostics
    strategy: str = "auto"  # auto | browser | static


@dataclass
class DownloadOptions:
    out_dir: Path = Path("downloads")
    cookies_file: Path | None = None
    # yt-dlp's --cookies-from-browser (chrome, firefox, edge, ...)
    cookies_from_browser: str | None = None
    # Pacing — the anti-bot protection is behaving like one person watching, so these are not
    # knobs to turn down: one download at a time, a random pause between episodes, a longer rest
    # every few episodes, and a full stop at the first sign of blocking.
    delay_min_s: float = 4.0  # randomized pause between episodes (seconds)
    delay_max_s: float = 9.0
    # "fixed" uses delay_min/max; "human" waits about as long as the previous episode lasts.
    pace: str = "fixed"
    rest_every: int = 10  # after this many downloads, take a longer rest (0 disables)
    rest_min_s: float = 60.0
    rest_max_s: float = 120.0
    max_consecutive_failures: int = 3  # stop the run after N failures in a row (0 disables)
    # Engine: "yt-dlp" (default; downloads each episode's page) or "browser" (fetches the play
    # URLs the episode list already carries, inside one browser session of its own — fewer
    # requests).
    engine: str = "yt-dlp"
    browser_channel: str | None = None  # browser engine: Playwright channel ("chrome", ...)
    browser_executable: Path | None = None  # browser engine: explicit Chromium binary
    browser_headful: bool = False
    base_url: str = TIKTOK_BASE_URL  # browser engine refreshes expired play URLs from here (tests)
    # File names: placeholders {series} {number} (zero-padded) {n} {title} {id}; see
    # ``manifest.episode_stem``. Validated by ``engine.validate_naming`` before anything is written.
    name_format: str = DEFAULT_NAME_FORMAT
    # The episode cover: "embed" (default) writes it into the MP4 as its cover art (the `covr`
    # atom) and leaves no other file; "both" embeds it and keeps <stem>.<jpeg|jpg|png|webp> next to
    # the video; "file" keeps that file only; "none" requests no cover at all. One of
    # THUMBNAIL_MODES, checked by ``engine.validate_thumbnail`` before anything is written.
    thumbnail: str = "embed"
    series_name: str | None = None  # filled by engine.download_series; expands {series}
    impersonate: bool = True  # yt-dlp + curl_cffi browser impersonation when installed
    # Which rendition: "compatible" (default) is the highest-bitrate H.264 — it plays everywhere;
    # "best" the highest bitrate whatever the codec. One of QUALITY_MODES, checked by
    # ``engine.validate_quality``; ``catalog.play_url_candidates`` and yt-dlp's format selector
    # follow it. Nothing is re-encoded.
    quality: str = "compatible"
    # Verify every saved video (``media.verify_video``: an MP4 that parses, is not cut short, has
    # an audio track and lasts about ``Episode.duration_s``); a file that fails is renamed
    # "<name> (incomplete).<ext>" and the episode is FAILED. ``--no-verify`` turns it off — a
    # debugging aid only.
    verify: bool = True
    retries: int = 3
    overwrite: bool = False
    include_locked: bool = False  # try episodes that look locked (they usually have no formats)
    dry_run: bool = False
    extractor_args: dict[str, dict[str, list[str]]] | None = None  # passthrough to yt-dlp

    @property
    def thumbnails(self) -> bool:
        """Whether a cover is requested at all: every mode but ``"none"``."""
        return self.thumbnail != "none"

    @property
    def embed_cover(self) -> bool:
        """Whether the cover goes into the video file (modes ``embed`` and ``both``)."""
        return self.thumbnail in ("embed", "both")

    @property
    def keep_cover_file(self) -> bool:
        """Whether a cover file stays next to the video (modes ``both`` and ``file``)."""
        return self.thumbnail in ("both", "file")


class DownloadStatus(StrEnum):
    DONE = "done"
    SKIPPED_EXISTS = "skipped-exists"
    SKIPPED_LOCKED = "skipped-locked"
    DRY_RUN = "dry-run"
    FAILED_LOGIN = "failed-login-required"
    FAILED_UNAVAILABLE = "failed-unavailable"  # locked, region-restricted, removed or private
    FAILED_RATE_LIMITED = "failed-rate-limited"
    FAILED_BLOCKED = "failed-blocked"  # HTTP 403 / access denied: stop and wait, do not retry
    FAILED = "failed"

    @property
    def ok(self) -> bool:
        return self in {
            DownloadStatus.DONE,
            DownloadStatus.SKIPPED_EXISTS,
            DownloadStatus.SKIPPED_LOCKED,
            DownloadStatus.DRY_RUN,
        }


@dataclass
class DownloadResult:
    episode: Episode
    status: DownloadStatus
    path: Path | None = None
    message: str = ""


class Discovery(Protocol):
    """Resolves a series reference into its episode list."""

    def discover(self, ref: SeriesRef, options: DiscoveryOptions) -> Series: ...


class Downloader(Protocol):
    """Downloads one episode. Per-episode failures are reported in the result, never raised."""

    def download(self, episode: Episode, options: DownloadOptions) -> DownloadResult: ...
