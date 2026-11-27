"""Turn a `SeriesRef` into a `Series`.

Two strategies implement the `Discovery` protocol: `StaticHtmlDiscovery` reads the JSON TikTok
embeds in the series page (cheap, no browser, first page only) and `PlaywrightDiscovery` drives a
real Chromium and captures the `/api/drama/episode/item_list/` responses (complete, slower).
`AutoDiscovery` tries static first and falls back to the browser; `choose_discovery` maps
`DiscoveryOptions.strategy` to one of them.
"""

from __future__ import annotations

from dramafetch.catalog import count_check
from dramafetch.discovery.browser import PlaywrightDiscovery
from dramafetch.discovery.static import PARTIAL_WARNING, StaticHtmlDiscovery
from dramafetch.errors import ChallengeError, DiscoveryError, LoginRequiredError, RateLimitedError
from dramafetch.models import Discovery, DiscoveryOptions, Series, SeriesRef

__all__ = ["AutoDiscovery", "PlaywrightDiscovery", "StaticHtmlDiscovery", "choose_discovery"]

STRATEGIES = ("auto", "browser", "static")


class AutoDiscovery:
    """Static first, browser when static fails or saw only the first embedded page.

    `LoginRequiredError`, `ChallengeError` and `RateLimitedError` from the static strategy propagate
    (a browser without cookies would hit the same wall, and after an HTTP 429 the only polite move
    is to stop, not to knock again with a browser); any other `DiscoveryError` is recorded in
    `Series.warnings` and the browser takes over. A partial static result — a list the page embeds
    only in part, a number missing below the highest one listed or up to TikTok's count, or (3.0.1)
    a whole list TikTok counts more episodes than (:func:`_partial`) — is completed with the
    browser, whose listing asks again for what it lacks, when it can be, and returned as is (with
    its warnings, its missing numbers and its early end) when the browser fails too — but a
    `ChallengeError` or `RateLimitedError` the browser meets then (its pagination, its gap filling)
    propagates like the static strategy's: a refusal is a stop and the cooldown, never a warning
    (3.0.1); a `LoginRequiredError` there is a warning. The warning that says so names what the
    static result lacked: the first page only (the page says TikTok has more), an episode its whole
    list lacks, or a count it could not place.
    """

    def __init__(self, static: Discovery | None = None, browser: Discovery | None = None) -> None:
        self._static: Discovery = static if static is not None else StaticHtmlDiscovery()
        self._browser: Discovery = browser if browser is not None else PlaywrightDiscovery()

    def discover(self, ref: SeriesRef, options: DiscoveryOptions) -> Series:
        try:
            series = self._static.discover(ref, options)
        except (LoginRequiredError, ChallengeError, RateLimitedError):
            raise
        except DiscoveryError as exc:
            fallback = self._browser.discover(ref, options)
            fallback.warnings.insert(0, f"static strategy failed ({exc}); used the browser")
            return fallback
        cut = _cut_short(series)
        lacking = cut or bool(series.missing_numbers)
        if not lacking and not _uncertain(series):
            return series
        try:
            complete = self._browser.discover(ref, options)
        except (ChallengeError, RateLimitedError):
            # A refusal met while completing the list — the browser's pagination or its gap
            # filling — is a refusal as on the static path: a stop (and, through engine.resolve,
            # the 30-minute cooldown), never a warning over the embedded first page (3.0.1).
            raise
        except DiscoveryError as exc:
            series.warnings.append(
                f"browser strategy could not complete the list ({exc}); "
                "showing the embedded first page only"
                if cut
                else f"browser strategy could not list it again ({exc}); "
                "showing the list the page embeds"
            )
            return series
        first = (
            PARTIAL_COMPLETED
            if cut
            else LACKING_LISTED_AGAIN
            if lacking
            else UNCERTAIN_LISTED_AGAIN
        )
        complete.warnings.insert(0, first)
        return complete


#: What `auto` says of a static result cut short (the page says TikTok has more), completed with
#: the browser.
PARTIAL_COMPLETED = "static strategy saw only the first page; completed with the browser"
#: What `auto` says of a static result whose whole list (no ``hasMore``) lacks an episode — a hole,
#: or a number TikTok's count places past it (3.0.1) —, listed again with the browser, whose gap
#: filling asks TikTok again for it.
LACKING_LISTED_AGAIN = (
    "static strategy: the episode list the page embeds lacks an episode; listed again with the "
    "browser"
)
#: What `auto` says of a static result whose whole list TikTok counts more episodes than (3.0.1:
#: ``catalog.count_check``'s ``uncertain``), listed again with the browser — whose gap filling asks
#: once for the page after the highest number.
UNCERTAIN_LISTED_AGAIN = (
    "static strategy: TikTok counts more episodes than the page lists; listed again with the "
    "browser"
)


def _partial(series: Series) -> bool:
    """Whether a static result lacks part of the list (:func:`_lacking`) or TikTok counts more
    than the drama certainly has (3.0.1, :func:`_uncertain`: the static strategy asks nothing, the
    browser's gap filling asks once)."""
    return _lacking(series) or _uncertain(series)


def _lacking(series: Series) -> bool:
    """Whether a static result lacks part of the list: it was cut short (:func:`_cut_short`) or a
    number is missing (``Series.missing_numbers``: a hole, or one TikTok's count places past the
    highest episode listed)."""
    return _cut_short(series) or bool(series.missing_numbers)


def _cut_short(series: Series) -> bool:
    """Whether a static result's list was cut short: it ended early (the page says TikTok has
    more) or says so in its warnings (``PARTIAL_WARNING``)."""
    return series.early_end is not None or any(
        warning.startswith(PARTIAL_WARNING) for warning in series.warnings
    )


def _uncertain(series: Series) -> bool:
    """Whether TikTok counts more than a static result's list can place (3.0.1,
    ``catalog.count_check``'s ``uncertain``): its count may include the trailer or the highlight
    the page lists besides the episodes, or episodes past the highest number listed may be
    missing."""
    return count_check(series.numbers, series.total_hint, series.items_received).uncertain


def choose_discovery(options: DiscoveryOptions) -> Discovery:
    """Map `options.strategy` (browser | static | auto) to a Discovery implementation."""
    strategy = (options.strategy or "auto").strip().lower()
    if strategy == "browser":
        return PlaywrightDiscovery()
    if strategy == "static":
        return StaticHtmlDiscovery()
    if strategy == "auto":
        return AutoDiscovery()
    raise ValueError(
        f"unknown discovery strategy {options.strategy!r}: expected one of {', '.join(STRATEGIES)}"
    )
