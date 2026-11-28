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
#: A series whose manifest says it was complete less than this long ago is skipped without a
#: single request (``engine.run_series``); ``--recheck`` resolves it anyway.
RECHECK_AFTER_S = 24 * 3600
#: Largest episode number DramaFetch reckons with: an ``--episodes`` spec may name none above it,
#: and a report's gaps and a listing's missing numbers are computed up to it at most. Short dramas
#: have at most a few hundred episodes (the series URL itself allows four digits), so the bound
#: only keeps a typo such as ``1-99999999999``, or an absurd count in a payload, from being taken
#: seriously.
MAX_EPISODE_NUMBER = 10_000
#: ``Episode.access`` values — what THIS session may do with an episode, decided by
#: ``catalog.access_of`` from the payload TikTok served to the user's own account: ``free`` (nothing
#: says it is sold, or a truthy ``free`` flag such as ``isLimitedFree`` says it is free — with
#: conditions the field does not name), ``unlocked`` (a paid episode this account may play: an
#: entitlement flag, or a play address TikTok gave this session for a sold episode) and ``locked``
#: (a lock, paywall or DRM flag, a short header — ``music.duration`` far shorter than
#: ``video.duration`` — or no play address at all: listed and skipped, never unlocked).
ACCESS_MODES = ("free", "unlocked", "locked")
#: The tail of ``engine.RECHECK_HINT`` (``unlocked more in the TikTok app since? --recheck looks
#: again``): the short-served message carries it too, so the extension's display maps both to
#: its own "look again" checkbox advice.
RECHECK_HINT_TAIL = "--recheck looks again"
#: Every short-served message starts with this (both engines, ``downloader.served_short``):
#: TikTok answered the whole file by size — ``video.size`` / a ``PlayAddr.DataSize`` within 0.5 % —
#: but its header plays less than the listed duration: a window for an episode the account has
#: not unlocked, or a defective encode on TikTok's side (the owner's 7 episodes of 2026-11-06
#: broke at the same point in the TikTok app and in TikTok's web player: no sound past it, a
#: broken picture when seeking past it); the list cannot tell the two apart, so the message
#: offers both readings. DramaFetch never rewrites that header: the file is kept as ``<stem>
#: (short).mp4`` and the episode is FAILED_UNAVAILABLE.
SHORT_SERVED_PREFIX = "TikTok serves this episode short: "
#: The quarantine mark of such a file (``media.quarantine(path, mark=SHORT_MARK)``):
#: ``<stem> (short).mp4``, ``(short 2)``, … — next to ``media.INCOMPLETE_MARK``'s
#: ``(incomplete)``.
SHORT_MARK = "short"
#: Every DRM message starts with this: DramaFetch never decrypts and never keeps encrypted media.
DRM_MARK = "protected by DRM"
#: Why an encrypted download is deleted (``media.drm_problem``) or an episode is refused: the
#: verdict of a downloaded file (both engines) and of yt-dlp's own "DRM protected"
#: (``downloader.describe_failure`` puts it first).
DRM_MESSAGE = f"{DRM_MARK} (encrypted tracks): DramaFetch does not decrypt it"
#: The message of an episode skipped because an earlier run's DOWNLOAD found it protected by DRM
#: (``Manifest.drm_protected``): no request — retrying cannot change that verdict — unless
#: ``--include-locked``. A row with it keeps the memory; a payload's DRM flag is never remembered
#: (the payload is read again whenever the series is listed).
DRM_REMEMBERED_MESSAGE = (
    f"{DRM_MARK} (found by an earlier run): DramaFetch does not decrypt it; "
    "--include-locked tries again"
)
#: Every row of an episode TikTok's list lacks starts with this (3.0.1, the owner's report of
#: 2026-11-27: "que cuente y se dé cuenta si falta un episodio" — an episode missing from the list
#: gets a row of its own, never silence): ``FAILED_UNAVAILABLE``, made without a request by
#: ``engine.not_listed_results``, never recorded in the manifest, never counted in the failure
#: streak. ``engine.series_report`` counts such a row as missing from TikTok's list (a gap), not as
#: a failed download.
NOT_LISTED_PREFIX = "not in TikTok's list"
#: The row of a number a whole series' listing lacks once its gap filling is over
#: (``Series.missing_numbers``): a hole below the highest number listed, or a number up to TikTok's
#: count — the Chrome extension's whole-series run, whose **Retry** lists the drama again.
NOT_LISTED_MESSAGE = NOT_LISTED_PREFIX
#: The same row for a number past the highest one listed when the listing ended before TikTok said
#: the list was over (``Series.early_end``).
NOT_LISTED_EARLY_END_MESSAGE = f"{NOT_LISTED_PREFIX}: it ended early"
#: The row of a number a SELECTION wanted that its fresh list does not hold (a **Retry**, an
#: automatic retry, **See episodes**' downloads in the extension; ``download --episodes`` for a
#: number up to the series' last episode as far as anyone knows: ``engine.unlisted_requested``).
NOT_LISTED_AGAIN_MESSAGE = f"{NOT_LISTED_PREFIX} this time"


@dataclass(frozen=True)
class SeriesRef:
    """A short-drama series as identified from a pasted URL.

    `/shortdrama/episode/<series_id>/<episode>` — the long number is the SERIES id (TikTok calls it
    `dramaID` in its API), not a video id; the trailing number is the 1-based episode the viewer was
    looking at, kept as parsed: since 3.0.1 no listing reads it — every listing, the browser
    engine's in-session refresh included, opens episode 1 (spec §5) — and it picks no episode.
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
    # Every pricing / lock / entitlement / DRM clue the payload carries, human-readable, e.g.
    # "isFree=false" or "isUnlocked=true". Informational: ``access`` decides. Empty means "nothing
    # in the payload says anything about a price or a lock" — not a guarantee it will download.
    lock_hints: tuple[str, ...] = ()
    # The episode cover (thumbnail): video.originCover, else video.cover, else video.dynamicCover.
    cover_url: str | None = None
    # What the default quality mode would download, e.g. "720p h264": the label of the rendition
    # ``catalog.choose_rendition(item, "compatible")`` picks; None when the item lists none.
    quality_hint: str | None = None
    # One of ACCESS_MODES: "free", "unlocked" (paid, and playable with THIS session: the user's own
    # account bought it or subscribes) or "locked" (skipped unless --include-locked). ``""`` derives
    # it in ``__post_init__`` — "locked" when ``lock_hints`` (or ``drm``) is set, else "free" — so a
    # caller that sets only ``lock_hints`` keeps the old meaning, also when it assigns them later
    # (``__setattr__``); ``catalog.episode_from_item`` always passes an explicit value. Any value
    # outside ACCESS_MODES: ValueError.
    access: str = ""
    # A pricing or entitlement clue is present (the episode is sold, whether or not this account
    # has unlocked it). Set by catalog.
    paid: bool = False
    # The payload itself says the episode is DRM-protected / encrypted (set by catalog). Such an
    # episode is always "locked" (ValueError otherwise): DramaFetch never decrypts anything.
    drm: bool = False
    # 3.0.1 (the owner's report of 2026-11-27): "locked" ONLY by DramaFetch's own structural
    # guesses — the SHORT-HEADER rule and/or no play address — with no DRM, price, entitlement or
    # TikTok lock clue (``catalog.access_of``'s ``guessed_lock``): a free episode DramaFetch
    # guessed was locked. Still skipped before any request; the reports count it as not downloaded
    # (``engine.series_report``). Only ever set on a locked episode that is neither ``drm`` nor
    # ``paid`` (ValueError otherwise).
    guessed_lock: bool = False
    raw: dict[str, Any] | None = field(default=None, repr=False, compare=False)

    def __post_init__(self) -> None:
        if not self.access:
            self.access = _derived_access(self.lock_hints, self.drm)
        if self.access not in ACCESS_MODES:
            raise ValueError(
                f"Episode.access must be one of {', '.join(ACCESS_MODES)}, not {self.access!r}"
            )
        if self.drm and self.access != "locked":
            raise ValueError("a DRM-protected episode is always locked: DramaFetch never decrypts")
        if self.guessed_lock and (self.access != "locked" or self.drm or self.paid):
            raise ValueError(
                "a guessed lock is a locked episode with no DRM, price or entitlement clue"
            )

    def __setattr__(self, name: str, value: object) -> None:
        # An access that is what its lock_hints / drm derive (see __post_init__) follows them when
        # either is assigned later, as ``locked`` followed ``lock_hints`` before the access model —
        # also on a ``dataclasses.replace`` copy. An access catalog decided otherwise ("unlocked",
        # or "free" despite a hint) stays. Nothing happens while __init__ is still assigning.
        follows = (
            name in ("lock_hints", "drm")
            and name in self.__dict__
            and "access" in self.__dict__
            and self.access == _derived_access(self.lock_hints, self.drm)
        )
        object.__setattr__(self, name, value)
        if follows:
            object.__setattr__(self, "access", _derived_access(self.lock_hints, self.drm))

    @property
    def locked(self) -> bool:
        return self.access == "locked"

    @property
    def page_url(self) -> str:
        """The ordinary video page yt-dlp understands. TikTok ignores the username segment."""
        return f"{TIKTOK_BASE_URL}/@{self.author or '_'}/video/{self.item_id}"


def _derived_access(lock_hints: tuple[str, ...], drm: bool) -> str:
    """The access of an Episode built without one: any hint (or DRM) meant "locked" before the
    access model, so it still does; nothing at all means "free"."""
    return "locked" if lock_hints or drm else "free"


@dataclass(frozen=True)
class SkippedItem:
    """An item TikTok listed for a series that is no episode of it (``catalog.skip_reason``).

    ``reason`` is one of ``catalog.SKIP_REASONS`` — ``another drama's id``, ``no id``, ``no
    episode number`` (a trailer, or a number neither ``DramaVideoData`` nor ``dramaInfo`` gives
    usable) —; ``item_id`` is the item's id when it has one. Kept in ``Series.skipped_items`` and
    said in the warnings, never only counted.
    """

    reason: str
    item_id: str | None = None


#: How an episode-list page reached a listing (``ListingPage.kind``): ``page`` — a request the
#: series page made itself, read off the wire (the Python browser strategy); ``first`` — the page's
#: own first request, replayed byte for byte (the extension, which cannot read the page's bodies);
#: ``next`` — the pagination's next page (the template with the next ``cursor`` and ``count``);
#: ``scroll`` — a request of the page's the scroll fallback asked for again (the extension);
#: ``fill`` — the gap filling (``discovery.browser.GAP_FILL_REQUESTS``); ``embedded`` — a list the
#: series page embeds in its HTML (the static strategy, no request of its own).
LISTING_KINDS = ("page", "first", "next", "scroll", "fill", "embedded")


@dataclass(frozen=True)
class ListingPage:
    """One episode-list page a listing asked for or read, as the "did not download" report shows
    it: how it was asked and what came back — never a URL, a query or a cookie.

    ``cursor_asked`` / ``count_asked`` are the request's ``cursor`` and ``count`` parameters (None
    when it had none); ``listed`` whether the answer held an episode list at all (without one,
    ``items`` is 0, ``numbers`` empty and ``has_more`` / ``cursor`` None); ``items`` counts every
    item of the answer (any drama), ``numbers`` the series' episode numbers in it as listed,
    ``has_more`` and ``cursor`` what the answer said.
    """

    kind: str
    cursor_asked: str | None
    count_asked: str | None
    listed: bool
    items: int = 0
    numbers: tuple[int, ...] = ()
    has_more: bool | None = None
    cursor: int | str | None = None


@dataclass
class ListingRecord:
    """What a listing asked TikTok for (``Series.listing``): ``endpoint`` — the list request's
    scheme, host and path, never its query (it carries TikTok's signature parameters) — and every
    page in the order it came (:class:`ListingPage`), the gap filling's requests among them."""

    endpoint: str | None = None
    pages: list[ListingPage] = field(default_factory=list)

    @property
    def fill_requests(self) -> int:
        """How many requests the gap filling made."""
        return sum(1 for page in self.pages if page.kind == "fill")


@dataclass
class Series:
    series_id: str
    name: str | None
    episodes: list[Episode]
    # TikTok's count of the series' episodes when known: the detail payload's total, else the first
    # positive ``dramaInfo.numVideos`` of the listed items (``catalog.Listing.total_hint``).
    total_hint: int | None = None
    warnings: list[str] = field(default_factory=list)
    # The items TikTok listed that are no episode of the series, each with its reason.
    skipped_items: list[SkippedItem] = field(default_factory=list)
    # The distinct items TikTok listed for the series — every episode before the number merge
    # (duplicates included) plus the skipped items of THIS drama (another drama's items are not
    # counted: TikTok's count of this drama leaves them out) — what ``catalog.count_check`` holds
    # against ``total_hint``; None when unknown (a series built by hand).
    items_received: int | None = None
    # The episode numbers the listing still lacks once it is over, the gap filling included
    # (``catalog.missing_numbers``): the holes below the highest number listed and the numbers up
    # to TikTok's count less the drama's other items received (``catalog.count_check``: a number
    # past that is never named, the list is uncertain instead); empty when nothing is known missing.
    missing_numbers: list[int] = field(default_factory=list)
    # Why the listing ended before TikTok said the list was over — the warning of the fallback the
    # pagination stopped on (``discovery.browser.NO_CURSOR_WARNING``, ``NO_LIST_WARNING``,
    # ``NOTHING_NEW_WARNING``, the max-pages warning; the static strategy's ``PARTIAL_WARNING``) —
    # while no page said ``hasMore`` false since; None when the list reached its end. TikTok's
    # count, when known, says whether anything is missing all the same (``missing_numbers``).
    early_end: str | None = None
    # The pages the listing asked for, the gap filling's included (None: a series built by hand).
    listing: ListingRecord | None = None

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
    browser_channel: str | None = None  # "chrome" / "msedge" / "chromium"; None: the full Chromium
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
    # A long break every ``long_rest_every`` network attempts of a RUN — a batch of series, or the
    # web job manager's lifetime — because nobody watches 100 episodes without one. No CLI flag
    # lowers these (tests set them directly); an idle gap of ``long_rest_min_s`` or more counts as
    # the break (``engine.PacingState``).
    long_rest_every: int = 100
    long_rest_min_s: float = 900.0
    long_rest_max_s: float = 1800.0
    # Engine: "yt-dlp" (default; downloads each episode's page) or "browser" (fetches the play
    # URLs the episode list already carries, inside one browser session of its own — fewer
    # requests).
    engine: str = "yt-dlp"
    browser_channel: str | None = (
        None  # browser engine: "chrome" / "msedge" / "chromium"; None: Chromium
    )
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
    # Resolve a series even when its manifest says it was complete less than RECHECK_AFTER_S ago
    # (``--recheck``); without it such a series costs no request (``engine.run_series``).
    recheck: bool = False
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


def is_guessed_locked(result: DownloadResult) -> bool:
    """Whether ``result`` is the row of a FREE episode DramaFetch skipped only because its own
    rules guessed it was locked (3.0.1, the owner's report of 2026-11-27): ``skipped-locked`` for an
    episode whose ``Episode.guessed_lock`` is set (``catalog.access_of``: a short header and/or no
    play address, with no DRM, price, entitlement or TikTok lock clue) — not the skip of a DRM
    verdict an earlier download left in the manifest (:data:`DRM_REMEMBERED_MESSAGE`), which is a
    fact, not a guess. ``engine.series_report`` counts such a row as NOT downloaded; the web UI
    colours it as one (``web.jobs.result_to_dict``'s ``guessed_lock``)."""
    episode = result.episode
    return (
        result.status is DownloadStatus.SKIPPED_LOCKED
        and episode.guessed_lock
        and episode.locked
        and not episode.drm
        and not episode.paid
        and result.message != DRM_REMEMBERED_MESSAGE
    )


class Discovery(Protocol):
    """Resolves a series reference into its episode list."""

    def discover(self, ref: SeriesRef, options: DiscoveryOptions) -> Series: ...


class Downloader(Protocol):
    """Downloads one episode. Per-episode failures are reported in the result, never raised."""

    def download(self, episode: Episode, options: DownloadOptions) -> DownloadResult: ...
