"""Turn a `SeriesRef` into a `Series`.

Two strategies implement the `Discovery` protocol: `StaticHtmlDiscovery` reads the JSON TikTok
embeds in the series page (cheap, no browser, first page only) and `PlaywrightDiscovery` drives a
real Chromium and captures the `/api/drama/episode/item_list/` responses (complete, slower).
`AutoDiscovery` tries static first and falls back to the browser; `choose_discovery` maps
`DiscoveryOptions.strategy` to one of them.
"""

from __future__ import annotations

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
    `Series.warnings` and the browser takes over. A partial static result is completed with the
    browser when it can be, and returned as is (with its warnings) when the browser fails too.
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
        if not any(warning.startswith(PARTIAL_WARNING) for warning in series.warnings):
            return series
        try:
            complete = self._browser.discover(ref, options)
        except DiscoveryError as exc:
            series.warnings.append(
                f"browser strategy could not complete the list ({exc}); "
                "showing the embedded first page only"
            )
            return series
        complete.warnings.insert(
            0, "static strategy saw only the first page; completed with the browser"
        )
        return complete


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
