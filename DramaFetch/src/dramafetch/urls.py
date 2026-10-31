"""Parse what the user pastes into a SeriesRef or VideoRef, and build TikTok page URLs.

Verified facts (October 2026): the short-drama entry point is
`https://www.tiktok.com/shortdrama/episode/<series_id>/<episode_number>`; the long number is the
series (TikTok: `dramaID`), the trailing number is the 1-based episode. yt-dlp does not recognise
this URL (yt-dlp/yt-dlp#17725); it does download the ordinary `/@user/video/<item_id>` page of each
episode, and the username segment is not checked, so `@_` works.
"""

from __future__ import annotations

import re

from dramafetch.errors import UnsupportedUrlError
from dramafetch.models import TIKTOK_BASE_URL, SeriesRef, VideoRef

_HOST = r"https?://(?:www\.|m\.)?tiktok\.com"
_TAIL = r"/?(?:[?#].*)?$"
SERIES_EPISODE_RE = re.compile(
    rf"^{_HOST}/shortdrama/episode/(?P<id>\d{{15,22}})(?:/(?P<n>\d{{1,4}}))?{_TAIL}", re.IGNORECASE
)
# Series pages without an episode segment (seen as `/shortdrama/<id>`; accepted defensively).
SERIES_RE = re.compile(
    rf"^{_HOST}/shortdrama/(?:detail/|series/)?(?P<id>\d{{15,22}}){_TAIL}", re.IGNORECASE
)
VIDEO_RE = re.compile(
    rf"^{_HOST}/(?:@(?P<user>[\w.-]+)/)?video/(?P<id>\d{{15,22}}){_TAIL}", re.IGNORECASE
)
SHORT_LINK_RE = re.compile(
    r"^https?://(?:vm|vt)\.tiktok\.com/|^https?://(?:www\.)?tiktok\.com/t/", re.IGNORECASE
)
BARE_ID_RE = re.compile(r"^\d{15,22}$")


def parse_input(text: str) -> SeriesRef | VideoRef:
    """Return the series or video the text refers to, or raise UnsupportedUrlError."""
    candidate = text.strip().strip("<>").strip()
    if not candidate:
        raise UnsupportedUrlError("Paste a TikTok short-drama URL (…/shortdrama/episode/<id>/<n>).")
    if BARE_ID_RE.match(candidate):
        return SeriesRef(series_id=candidate, episode_hint=None, source_url=candidate)
    if (m := SERIES_EPISODE_RE.match(candidate)) is not None:
        hint = int(m.group("n")) if m.group("n") else None
        return SeriesRef(series_id=m.group("id"), episode_hint=hint or None, source_url=candidate)
    if (m := SERIES_RE.match(candidate)) is not None:
        return SeriesRef(series_id=m.group("id"), episode_hint=None, source_url=candidate)
    if (m := VIDEO_RE.match(candidate)) is not None:
        return VideoRef(item_id=m.group("id"), author=m.group("user"), source_url=candidate)
    if SHORT_LINK_RE.match(candidate):
        raise UnsupportedUrlError(
            "Short links (vm.tiktok.com, vt.tiktok.com, tiktok.com/t/…) are not resolved: open the "
            "link in your browser and paste the full address, which contains /shortdrama/episode/."
        )
    raise UnsupportedUrlError(
        f"Not a TikTok short-drama or video URL: {candidate[:120]!r}. Expected "
        "https://www.tiktok.com/shortdrama/episode/<series id>/<episode> or "
        "https://www.tiktok.com/@user/video/<id>."
    )


def series_page_url(series_id: str, episode: int = 1, base_url: str = TIKTOK_BASE_URL) -> str:
    return f"{base_url.rstrip('/')}/shortdrama/episode/{series_id}/{max(1, episode)}"


def video_page_url(item_id: str, author: str | None = None, base_url: str = TIKTOK_BASE_URL) -> str:
    return f"{base_url.rstrip('/')}/@{author or '_'}/video/{item_id}"
