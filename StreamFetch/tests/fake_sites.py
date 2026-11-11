"""Fake Dailymotion, Bilibili and Bilibili.tv on one local port, for StreamFetch's end-to-end tests.

One stdlib `ThreadingHTTPServer` on `127.0.0.1:<random port>` serves three fake sites under three
prefixes. The extension's TEST copy is pointed at them through `testSettings.baseUrls`
(`FakeSites.base_urls()`); links are pasted in their REAL shape (`https://www.dailymotion.com/…`,
`https://b23.tv/…`, `https://www.bilibili.tv/en/video/…`) and the resolver swaps the origin for
the base. The media is real (`media_fixtures.build_media`, made by ffmpeg once per session), so
what the extension saves can be checked frame by frame against the source clip.

Routes (all GET; every answer `Cache-Control: no-store`, no CORS header — the extension reaches
the fake through its test host permission `http://127.0.0.1/*`, never through CORS):

Dailymotion (`/dm`, base `baseUrls.dailymotion`; CDN `/dm/cdn`, `baseUrls.dmcdn`)
  /dm/player/metadata/video/<xid>     the player metadata JSON (`fixtures/dailymotion-metadata.json`
                                      filled in): `title`, `duration` 6, `owner`, `posters` /
                                      `thumbnails` (`/dm/poster/<xid>.jpg`), `qualities.auto` =
                                      the HLS master (`application/x-mpegURL`, with a `sec` token)
                                      and a lumberjack entry to ignore; HTTP 200 with an `error`
                                      object for `dm_geo_blocked` (`DM007`) and `dm_not_found`
                                      (`DM002`), as the real endpoint answers; `dm_claims_longer`:
                                      `duration` 60 while the media is the 6 s clip (a shorter
                                      file than the site says: never saved)
  /dm/cdn/manifest/<xid>.m3u8         the HLS master: two variants, `NAME="1080"` (1920x1080) and
                                      `NAME="480"` (854x480), muxed audio; 429 for
                                      `dm_rate_limit_manifest`. Every master request starts a new
                                      URL generation (`gen`): the URLs it lists carry it
  /dm/cdn/<xid>/media-<name>.m3u8     the media playlist (ffmpeg's own, its URIs rewritten to carry
                                      `gen`): MPEG-TS segments, or fMP4 (`#EXT-X-MAP`) for
                                      `dm_fmp4`; `#EXT-X-KEY:METHOD=AES-128` for
                                      `dm_key_protected`; no `#EXT-X-ENDLIST` for `dm_live`. Both
                                      variants list the source clip's segments
  /dm/cdn/<xid>/seg<n>.ts|.m4s        a segment; `dm_expire_segment_once`: 403 on segment
                                      `EXPIRING_SEGMENT` the first time it is asked for (a fresh
                                      master serves new URLs: a new `gen`);
                                      `dm_truncate_segment`: segment `TRUNCATED_SEGMENT` cut short
                                      once (full `Content-Length`, half the body, the connection
                                      dropped `CUT_LINGER_S` later)
  /dm/cdn/<xid>/init.mp4              the fMP4 init segment
  /dm/cdn/<xid>/key.bin               404: StreamFetch never asks for a key (the log shows it if it
                                      did)
  /dm/poster/<xid>.jpg                a poster (the cover rules below)

Bilibili (`/bili`, base `baseUrls.bilibili`; short links `/b23`, `baseUrls.b23`)
  /bili/video/<bvid>[/]?p=N           the video page (`fixtures/bilibili-page.html`) embedding
                                      `window.__INITIAL_STATE__ = {...}` (`videoData` with
                                      `bili_parts` pages — `bili_parts_of` sets one video's
                                      count —, `upData`) and `window.__playinfo__ =
                                      {...}` for part N (default 1): DASH `video[]` per
                                      `bili_qualities`, `audio[]` 30280 + 30216, `support_formats`,
                                      `accept_quality`, `accept_description`, `timelength`; every
                                      media URL `{base}/bili/cdn/<cid>/…?deadline=<now+1h>&upsig=…`
                                      plus a backup URL (`&mirror=2`). Sets a `SESSDATA` cookie
                                      (`FAKE_SESSDATA`: a test greps every report for it). Options:
                                      `bili_login_wall` (`error.trueCode` -403), `bili_deleted`
                                      (-404), `bili_riskdata` (no state, `window._riskdata_` with a
                                      `v_voucher`), `bili_missing_premium` (`support_formats` names
                                      116, absent from `dash.video`), `bili_upower_no_dash`
                                      (`is_upower_exclusive`, no DASH), `bili_trial` (`试看` in
                                      `accept_description`)
  /b23/<code>                         302 to `/bili/video/<bvid>?share_source=copy_web`
                                      (`B23_CODES`)
  /bili/cdn/<cid>/<q>[-hevc].m4s      a DASH video track (a complete fragmented MP4: the source clip
                                      for q >= 80, the 160x90 clip below); `Range` (206,
                                      `Content-Range`; 416 when unsatisfiable); 403 unless the
                                      `Referer` is `{base}/bili/` (the real CDN wants
                                      `https://www.bilibili.com/`) or when `deadline` has passed;
                                      `bili_cdn_412`: 412 `Request is blocked by server (412)`;
                                      `bili_drm`: the video served encrypted (`encv` + `pssh`);
                                      `bili_cut_once`: the first request of part 1's chosen video
                                      file is cut short (half the body, then the connection drops)
  /bili/cdn/<cid>/audio-<id>.m4s      a DASH audio track; same rules; `bili_expire_once`: 403 the
                                      first time (expired: the extension re-reads the page)
  /bili/cover/<bvid>.jpg              the cover (`videoData.pic`; the cover rules below)

Bilibili.tv (`/btv` pages, base `baseUrls.bilibilitv`; API `/btv-api`, `baseUrls.bilibilitvApi`)
  /btv[/<lang>]/video/<aid>           a user video page (`fixtures/bilibilitv-page.html`):
                                      `window.__INITIAL_DATA__ = {"UgcVideo": {"videoData": …}}`
                                      (`title`, `title_display`, `cover`, `duration` 6), `og:` tags,
                                      JSON-LD `VideoObject`; any two-letter language segment
  /btv[/<lang>]/play/<season>/<ep>    an episode page: `{"OgvVideo": {"epDetail": …}}`
  /btv-api/intl/gateway/web/playurl   `?platform=web&aid=…|ep_id=…` → `{code, message, data:
                                      {playurl: {video: [...], audio_resource: [...]}}}`: video
                                      1080P (q 80, the source clip), 720P (64) and 480P (32, both
                                      the 160x90 clip), audio 30280 and 30216; PROGRESSIVE files by
                                      default (`mdat` before `moov`), fragmented for
                                      `btv_fragmented`; codes for `btv_geo` (10004001),
                                      `btv_login` (10004004), `btv_premium` (10023006); `btv_empty`
                                      (no stream); `btv_missing_quality` (a 1080P+ entry, quality
                                      112, without `url`); `btv_uncovered_host` (every media URL on
                                      `localhost`, a host the test copy has no permission for)
  /btv-api/intl/gateway/web/v2/ogv/play/episodes?season_id=…   two sections, three episodes
  /btv-api/intl/gateway/web/v2/ogv/play/season_info?season_id=… `data.season.title`
  /btv-cdn/<id>/<q>.mp4, /btv-cdn/<id>/audio-<q>.mp4             the media; `Range`; 403 unless
                                      the `Referer` is `{base}/btv/`, or once `deadline` passed
  /btv-cover/<id>.jpg                 the cover (the cover rules below)

Covers (B.2: StreamFetch embeds the cover in the MP4; its rows show it as a lazy thumbnail): every
cover is `media.cover` (a JPEG) at a `.jpg` URL, except `cover_png` (`media.cover_png` at `.png`)
and `cover_webp` (`media.cover_webp` at `.webp`, the one the extension converts to JPEG);
`cover_status` refuses one video's cover with a status (404, 429, 403 …: a cover is never worth a
stop). A cover asked for under another extension than its own is a 404.

Per-video options are sets of ids (`"*"` = every id): xids for `dm_*`, bvids for `bili_*`, aids
or episode ids for `btv_*`. `FakeSites.set_options(...)` changes them while the server runs (a
Retry after the cause is gone).

The request log (`FakeSites.requests`) keeps, per request: method, path, the query (kept here,
server side, for the assertions — never shown by the extension's report), the host NAME the
client asked for (`127.0.0.1` or `localhost`), the `Referer`, `Origin` and `Range` VALUES, the
NAMES of the headers and of the cookies sent — never a cookie value or another header's value —
the status answered, the bytes sent, whether the body was cut short, and when the request
started and finished (monotonic clock), so a test can prove the requests never overlapped.
"""

from __future__ import annotations

import json
import re
import threading
import time
import zlib
from dataclasses import dataclass, field, replace
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from media_fixtures import SOURCE_SECONDS, MediaSet

FIXTURES = Path(__file__).resolve().parent / "fixtures"

# -- the fake catalogue (INVENTED ids of the real shapes) ----------------------------------------

#: Dailymotion: `x` + lowercase alphanumerics (addendum A.8: invented, never the owner's).
DM_TS_ID = "xbq9z2k"
DM_FMP4_ID = "xfm4p7a"
DM_SHORT_ID = "xdl2y8c"
DM_PLAYLIST_ID = "x8pl4yq"
DM_TITLES = {
    DM_TS_ID: "Fake Dailymotion clip in TS",
    DM_FMP4_ID: "Fake Dailymotion clip in fMP4",
    DM_SHORT_ID: "Fake Dailymotion short link clip",
}
DM_ID_RE = re.compile(r"^(?:x[0-9a-z]+|k[0-9A-Za-z]+)$")
#: The master's variants: NAME, RESOLUTION, BANDWIDTH. Both list the source clip's segments.
DM_VARIANTS = (("1080", "1920x1080", 5_000_000), ("480", "854x480", 1_200_000))
#: `dm_expire_segment_once` refuses this segment (`seg002`) the first time.
EXPIRING_SEGMENT = 2
#: `dm_truncate_segment` cuts this segment (`seg001`) short once.
TRUNCATED_SEGMENT = 1
#: `dm_claims_longer`: the duration the metadata claims, far beyond the 6 s clip it serves.
CLAIMED_SECONDS = SOURCE_SECONDS * 10

#: Bilibili: `BV` + 10 alphanumerics.
BILI_MAIN = "BV1Fk4y1A7Ab"
#: A one-part video pasted as a share link (`vd_source`, `spm_id_from`: B.3).
BILI_SHARE = "BV1Sh8R1aE2s"
#: A video whose title is not ASCII: the `©nam` tag must carry it in UTF-8 (B.2).
BILI_UNICODE = "BV1Uc9N1iC0d"
BILI_TITLES = {
    BILI_MAIN: "Fake Bilibili two-part video",
    BILI_SHARE: "Fake Bilibili share link video",
    BILI_UNICODE: "Fake 封面测试 — vídeo ñandú",
}
BILI_PART_TITLES = ("First half", "Second half")
BILI_ID_RE = re.compile(r"^(?:BV[0-9A-Za-z]{10}|av\d+)$")
#: b23.tv short codes → the video they redirect to.
B23_CODE = "fK3pQ9x"
B23_CODES = {B23_CODE: BILI_MAIN}
#: Quality id → (width, height, label as `support_formats[].new_description`).
BILI_QUALITY_INFO: dict[int, tuple[int, int, str]] = {
    120: (3840, 2160, "4K 超清"),
    116: (1920, 1080, "1080P 60帧"),
    112: (1920, 1080, "1080P 高码率"),
    80: (1920, 1080, "1080P 高清"),
    64: (1280, 720, "720P 高清"),
    32: (852, 480, "480P 清晰"),
    16: (640, 360, "360P 流畅"),
}
BILI_CODECS = {"avc": ("avc1.64001F", 7), "hevc": ("hev1.1.6.L120.90", 12)}
BILI_AUDIO = ((30280, 192_000), (30216, 64_000))
DEFAULT_BILI_QUALITIES: tuple[tuple[int, str], ...] = ((80, "avc"), (80, "hevc"), (64, "avc"))
DEFAULT_BILI_QUALITIES += ((32, "avc"),)
#: The premium quality `bili_missing_premium` names in `support_formats` (never in `dash.video`).
BILI_PREMIUM_QUALITY = 116
#: A SESSDATA-like cookie value the fake Bilibili sets: no report may ever contain it.
FAKE_SESSDATA = "fakesessdata0123456789abcdefFAKE%2C1790000000%2Cabcde"

#: Bilibili.tv: 16-digit aids (addendum A.7: invented, the owner's shape), digit episode ids.
BTV_AID = "4801520000000001"
BTV_AID_2 = "4801520000000002"
BTV_TITLES = {BTV_AID: "Fake Bstation user video", BTV_AID_2: "Another fake Bstation video"}
BTV_SEASON = "2090001"
BTV_SEASON_TITLE = "Fake Bstation Series"
#: The series' episodes in order: (episode id, title_display); two sections (E1-E2, E3).
BTV_EPISODES = (
    ("13000001", "E1 - The fake beginning"),
    ("13000002", "E2 - The fake middle"),
    ("13000003", "E3 - The fake ending"),
)
BTV_SECTIONS = ((0, 1), (2,))
#: The tracking parameter of the owner's example links (addendum A.7), exactly.
BSTAR_FROM = "bstar-web.ugc-video-detail.related-recommend.all"
#: Video qualities: (quality, desc_words, width, height, bandwidth). 80 is the source clip.
BTV_VIDEO = (
    (80, "1080P", 1920, 1080, 2_300_000),
    (64, "720P", 1280, 720, 1_100_000),
    (32, "480P", 852, 480, 600_000),
)
#: The quality `btv_missing_quality` lists without a URL (a premium-only one).
BTV_MISSING_QUALITY = (112, "1080P+", 1920, 1080, 4_000_000)
BTV_AUDIO = ((30280, 192_000), (30216, 64_000))
BTV_CODES = {"geo": 10004001, "login": 10004004, "premium": 10023006}
BTV_LANG_RE = r"(?:/(?P<lang>[A-Za-z]{2}))?"

#: How long a read of the log waits for the requests being answered.
SETTLE_S = 2.0
#: How long a cut answer keeps its connection open after the half body, before dropping it: a
#: network cut drops a connection that has delivered bytes, and a browser hands the body stream
#: what it received before it reports the error — closed at once, Chrome reports the error first
#: and the client never sees the bytes it could resume from.
CUT_LINGER_S = 0.3
#: Every option's id set accepts this as "every id".
ANY = "*"

_DM_METADATA = re.compile(r"^/dm/player/metadata/video/(?P<id>[^/]+)$")
_DM_MASTER = re.compile(r"^/dm/cdn/manifest/(?P<id>[^/]+)\.m3u8$")
_DM_MEDIA = re.compile(r"^/dm/cdn/(?P<id>[^/]+)/media-(?P<name>[0-9a-z]+)\.m3u8$")
_DM_SEGMENT = re.compile(r"^/dm/cdn/(?P<id>[^/]+)/seg(?P<n>\d+)\.(?P<ext>ts|m4s)$")
_DM_INIT = re.compile(r"^/dm/cdn/(?P<id>[^/]+)/init\.mp4$")
_DM_KEY = re.compile(r"^/dm/cdn/(?P<id>[^/]+)/key\.bin$")
_COVER_EXT = r"\.(?P<ext>jpg|png|webp)"
_DM_POSTER = re.compile(rf"^/dm/poster/(?P<id>[^/]+){_COVER_EXT}$")
_BILI_PAGE = re.compile(r"^/bili/video/(?P<id>[^/]+)/?$")
_B23 = re.compile(r"^/b23/(?P<code>[0-9A-Za-z]+)$")
_BILI_VIDEO = re.compile(r"^/bili/cdn/(?P<cid>\d+)/(?P<q>\d+)(?:-(?P<codec>hevc))?\.m4s$")
_BILI_AUDIO = re.compile(r"^/bili/cdn/(?P<cid>\d+)/audio-(?P<q>\d+)\.m4s$")
_BILI_COVER = re.compile(rf"^/bili/cover/(?P<id>[^/]+){_COVER_EXT}$")
_BTV_VIDEO_PAGE = re.compile(rf"^/btv{BTV_LANG_RE}/video/(?P<aid>\d+)/?$")
_BTV_EPISODE_PAGE = re.compile(rf"^/btv{BTV_LANG_RE}/play/(?P<season>\d+)/(?P<ep>\d+)/?$")
_BTV_PLAYURL = "/btv-api/intl/gateway/web/playurl"
_BTV_EPISODES = "/btv-api/intl/gateway/web/v2/ogv/play/episodes"
_BTV_SEASON_INFO = "/btv-api/intl/gateway/web/v2/ogv/play/season_info"
_BTV_VIDEO = re.compile(r"^/btv-cdn/(?P<id>\d+)/(?P<q>\d+)\.mp4$")
_BTV_AUDIO = re.compile(r"^/btv-cdn/(?P<id>\d+)/audio-(?P<q>\d+)\.mp4$")
_BTV_COVER = re.compile(rf"^/btv-cover/(?P<id>\d+){_COVER_EXT}$")
_RANGE = re.compile(r"^bytes=(?P<start>\d+)-(?P<end>\d*)$")

#: Route name → (site, kind). `kind`: page (pages, metadata, manifests, APIs, redirects), media
#: (segments, init, m4s/mp4 tracks, a key), cover (posters, covers).
ROUTES: dict[str, tuple[str, str]] = {
    "dm-metadata": ("dailymotion", "page"),
    "dm-master": ("dailymotion", "page"),
    "dm-media-playlist": ("dailymotion", "page"),
    "dm-segment": ("dailymotion", "media"),
    "dm-init": ("dailymotion", "media"),
    "dm-key": ("dailymotion", "media"),
    "dm-poster": ("dailymotion", "cover"),
    "bili-page": ("bilibili", "page"),
    "b23": ("bilibili", "page"),
    "bili-video": ("bilibili", "media"),
    "bili-audio": ("bilibili", "media"),
    "bili-cover": ("bilibili", "cover"),
    "btv-page": ("bilibilitv", "page"),
    "btv-playurl": ("bilibilitv", "page"),
    "btv-episodes": ("bilibilitv", "page"),
    "btv-season-info": ("bilibilitv", "page"),
    "btv-video": ("bilibilitv", "media"),
    "btv-audio": ("bilibilitv", "media"),
    "btv-cover": ("bilibilitv", "cover"),
    "unknown": ("", "other"),
}


@dataclass(frozen=True)
class FakeOptions:
    """What the fake sites do differently. Sets name the videos an option applies to (`ANY`:
    all); see the module docstring for each route's behaviour."""

    # Dailymotion (xids)
    dm_geo_blocked: frozenset[str] = frozenset()
    dm_not_found: frozenset[str] = frozenset()
    dm_key_protected: frozenset[str] = frozenset()
    dm_live: frozenset[str] = frozenset()
    dm_fmp4: frozenset[str] = frozenset()
    dm_expire_segment_once: frozenset[str] = frozenset()
    dm_rate_limit_manifest: frozenset[str] = frozenset()
    dm_truncate_segment: frozenset[str] = frozenset()
    #: Not in spec 9's list: the metadata says the video lasts `CLAIMED_SECONDS` while the media is
    #: the 6 s clip, so the e2e suite proves B.1's "a shorter file is never saved as the video".
    dm_claims_longer: frozenset[str] = frozenset()
    # Bilibili (bvids)
    bili_parts: int = 1
    #: `(bvid, parts)` pairs: those videos' part counts, whatever `bili_parts` says.
    bili_parts_of: tuple[tuple[str, int], ...] = ()
    bili_qualities: tuple[tuple[int, str], ...] = DEFAULT_BILI_QUALITIES
    bili_missing_premium: frozenset[str] = frozenset()
    bili_login_wall: frozenset[str] = frozenset()
    bili_deleted: frozenset[str] = frozenset()
    bili_riskdata: frozenset[str] = frozenset()
    bili_cdn_412: frozenset[str] = frozenset()
    bili_drm: frozenset[str] = frozenset()
    bili_expire_once: frozenset[str] = frozenset()
    bili_upower_no_dash: frozenset[str] = frozenset()
    bili_trial: frozenset[str] = frozenset()
    #: Not in spec 9's list: a cut transfer on the Bilibili CDN, so the batch scenario can prove
    #: that `Range` is sent only after a cut ("the Bilibili CDN hit with Range only after a cut").
    bili_cut_once: frozenset[str] = frozenset()
    # Bilibili.tv (aids or episode ids)
    btv_geo: frozenset[str] = frozenset()
    btv_login: frozenset[str] = frozenset()
    btv_premium: frozenset[str] = frozenset()
    btv_empty: frozenset[str] = frozenset()
    btv_fragmented: frozenset[str] = frozenset()
    btv_missing_quality: frozenset[str] = frozenset()
    btv_uncovered_host: frozenset[str] = frozenset()
    # Covers (xids, bvids, aids, episode ids)
    cover_png: frozenset[str] = frozenset()
    cover_webp: frozenset[str] = frozenset()
    #: `(video id, status)` pairs: that video's cover is refused with that status.
    cover_status: tuple[tuple[str, int], ...] = ()
    #: Seconds every media answer waits before its body (a slow CDN; `0` = none). Lets a test see
    #: a job in progress (covers never requested during a job, Stop, the second tab).
    media_delay_s: float = 0.0


def applies(option: frozenset[str], video_id: str) -> bool:
    """Whether a per-video option names `video_id` (or `ANY`)."""
    return ANY in option or video_id in option


def parts_of(options: FakeOptions, bvid: str) -> int:
    """How many parts the fake Bilibili video `bvid` has (`bili_parts_of`, else `bili_parts`)."""
    return max(1, dict(options.bili_parts_of).get(bvid, options.bili_parts))


#: Cover formats: extension → (content type, `MediaSet` attribute).
COVER_FORMATS = {
    "jpg": ("image/jpeg", "cover"),
    "png": ("image/png", "cover_png"),
    "webp": ("image/webp", "cover_webp"),
}


def cover_ext(options: FakeOptions, video_id: str) -> str:
    """The extension of `video_id`'s cover URL: `png`, `webp` or `jpg` (the default)."""
    if applies(options.cover_png, video_id):
        return "png"
    return "webp" if applies(options.cover_webp, video_id) else "jpg"


@dataclass(frozen=True)
class RequestRecord:
    """One request, as the fake saw it. Never a cookie value, never another header's value than
    `Referer`, `Origin` and `Range`."""

    method: str
    path: str
    query: dict[str, str] = field(default_factory=dict)
    host: str = ""  # the host NAME asked for (`127.0.0.1`, `localhost`), without the port
    referer: str | None = None
    origin: str | None = None
    range: str | None = None
    header_names: tuple[str, ...] = ()  # lower-cased, sorted
    cookie_names: tuple[str, ...] = ()  # sorted; never a value
    status: int = 0
    sent_bytes: int = 0  # body bytes written
    cut: bool = False  # the body stopped short of its Content-Length on purpose
    started: float = 0.0  # time.monotonic() when the request line was read
    finished: float = 0.0  # time.monotonic() when the answer was written
    route: str = "unknown"

    @property
    def site(self) -> str:
        return ROUTES[self.route][0]

    @property
    def kind(self) -> str:
        return ROUTES[self.route][1]


@dataclass
class _State:
    """What the fake remembers between requests (under the server's lock)."""

    dm_generation: dict[str, int] = field(default_factory=dict)
    dm_expired: set[str] = field(default_factory=set)
    dm_truncated: set[str] = field(default_factory=set)
    bili_cids: dict[str, tuple[str, int]] = field(default_factory=dict)  # cid → (bvid, part)
    bili_page_serves: dict[str, int] = field(default_factory=dict)
    bili_expired: set[str] = field(default_factory=set)  # cids
    bili_cut: set[str] = field(default_factory=set)  # bvids
    btv_serves: dict[str, int] = field(default_factory=dict)


class FakeSitesServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, options: FakeOptions, media: MediaSet) -> None:
        super().__init__(("127.0.0.1", 0), _Handler)
        self.options = options
        self.media = media
        self.requests: list[RequestRecord] = []
        self.state = _State()
        self.lock = threading.Lock()
        #: Requests being answered; the log waits for them (`settled`) before it is read, so a
        #: client that already has its answer always finds the request logged.
        self.in_flight = 0
        #: The path of every request as soon as it arrives (before it is answered and logged).
        self.started_paths: list[str] = []
        self.settled_condition = threading.Condition(self.lock)
        self.release = threading.Event()  # set at shutdown: wakes handlers sleeping on purpose
        self._files: dict[Path, bytes] = {}

    @property
    def port(self) -> int:
        return int(self.server_address[1])

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def uncovered_base(self) -> str:
        """This server under a name the extension's test copy has no permission for."""
        return f"http://localhost:{self.port}"

    def file(self, path: Path) -> bytes:
        """`path`'s bytes, read once."""
        with self.lock:
            if path not in self._files:
                self._files[path] = path.read_bytes()
            return self._files[path]

    def begin(self, path: str) -> None:
        with self.lock:
            self.in_flight += 1
            self.started_paths.append(path)

    def record(self, record: RequestRecord) -> None:
        """Log one answered request (and count it out of the ones in flight)."""
        with self.settled_condition:
            self.requests.append(record)
            self.in_flight -= 1
            self.settled_condition.notify_all()

    def logged(self, timeout_s: float = SETTLE_S) -> list[RequestRecord]:
        """The log, once no request is being answered (at most `timeout_s` later: a request held
        on purpose, `media_delay_s`, is left out until it is answered)."""
        with self.settled_condition:
            self.settled_condition.wait_for(lambda: self.in_flight == 0, timeout_s)
            return list(self.requests)

    def handle_error(self, request: Any, client_address: Any) -> None:
        """A client that gave up (a cut answer, an aborted fetch) is no error worth a traceback."""


# -- builders of the sites' documents ------------------------------------------------------------


def _template(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _script_json(value: object) -> str:
    """JSON for inside a `<script>`: compact, non-ASCII kept, `</` escaped."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def _html_text(text: str) -> str:
    return (
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    )


def _token(*parts: object) -> str:
    """A stable hex token standing for a signature (`sec`, `upsig`, `sign`): the report must
    strip it with the rest of the query."""
    return f"{zlib.crc32('/'.join(map(str, parts)).encode()):08x}" * 4


def dm_title(xid: str) -> str:
    return DM_TITLES.get(xid, f"Fake Dailymotion video {xid}")


def bili_title(bvid: str) -> str:
    return BILI_TITLES.get(bvid, f"Fake Bilibili video {bvid}")


def btv_title(aid: str) -> str:
    return BTV_TITLES.get(aid, f"Fake Bstation video {aid}")


def bili_cid(bvid: str, part: int) -> str:
    """A stable cid per (video, part): digits, as Bilibili's."""
    return str((zlib.crc32(bvid.encode()) % 90_000_000 + 10_000_000) * 10 + part)


def bili_part_title(bvid: str, part: int, parts: int) -> str:
    """Part titles: the video's own title for a single part, `First half` / … for several."""
    if parts <= 1:
        return bili_title(bvid)
    return BILI_PART_TITLES[part - 1] if part <= len(BILI_PART_TITLES) else f"Part {part}"


def btv_episode_title(ep_id: str) -> str:
    return dict(BTV_EPISODES).get(ep_id, f"E0 - Fake episode {ep_id}")


def dm_metadata(base: str, xid: str, options: FakeOptions, generation_token: str) -> dict[str, Any]:
    """The player metadata JSON of `xid` as the fake serves it."""
    if applies(options.dm_geo_blocked, xid):
        message = "Video geo-restricted by the owner."
        error = {"status_code": 403, "code": "DM007", "type": "geoblock"}
        return {"error": {**error, "title": message, "message": message, "raw_message": message}}
    if applies(options.dm_not_found, xid):
        message = "This video does not exist or has been deleted."
        error = {"status_code": 404, "code": "DM002", "type": "not_found"}
        title = "Content not available"
        return {"error": {**error, "title": title, "message": message, "raw_message": message}}
    raw = _template("dailymotion-metadata.json").replace("{{ID}}", xid)
    metadata: dict[str, Any] = json.loads(raw.replace("{{TITLE}}", dm_title(xid)))
    if applies(options.dm_claims_longer, xid):
        metadata["duration"] = CLAIMED_SECONDS
    poster = f"{base}/dm/poster/{xid}.{cover_ext(options, xid)}"
    metadata["posters"] = {height: f"{poster}?h={height}" for height in ("120", "360", "720")}
    metadata["thumbnails"] = dict(metadata["posters"])
    master = f"{base}/dm/cdn/manifest/{xid}.m3u8?sec={generation_token}&dmTs=1762560000"
    lumberjack = f"{base}/dm/cdn/manifest/{xid}.lumberjack?sec={generation_token}"
    metadata["qualities"] = {
        "auto": [
            {"type": "application/x-mpegURL", "url": master},
            {"type": "application/vnd.lumberjack.manifest", "url": lumberjack},
        ]
    }
    return metadata


def dm_master(xid: str, generation: int) -> str:
    """The HLS master: two variants over muxed audio; their URIs relative to the master
    (`/dm/cdn/manifest/<xid>.m3u8` → `/dm/cdn/<xid>/media-<name>.m3u8`) and carrying `gen`."""
    lines = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-INDEPENDENT-SEGMENTS"]
    for name, resolution, bandwidth in DM_VARIANTS:
        lines.append(
            f"#EXT-X-STREAM-INF:BANDWIDTH={bandwidth},RESOLUTION={resolution},"
            f'CODECS="avc1.64001f,mp4a.40.2",FRAME-RATE=25,NAME="{name}"'
        )
        lines.append(f"../{xid}/media-{name}.m3u8?gen={generation}")
    return "\n".join(lines) + "\n"


def dm_media_playlist(media: MediaSet, xid: str, options: FakeOptions, generation: int) -> str:
    """ffmpeg's media playlist with its URIs carrying `gen`, edited per option."""
    fixture = media.hls_fmp4 if applies(options.dm_fmp4, xid) else media.hls_ts
    out: list[str] = []
    for line in fixture.playlist.splitlines():
        if line.startswith("#EXT-X-MAP:"):
            out.append(f'#EXT-X-MAP:URI="init.mp4?gen={generation}"')
        elif line and not line.startswith("#"):
            out.append(f"{line}?gen={generation}")
        elif applies(options.dm_live, xid) and line.startswith(
            ("#EXT-X-ENDLIST", "#EXT-X-PLAYLIST-TYPE")
        ):
            continue
        else:
            out.append(line)
        if line.startswith("#EXT-X-MEDIA-SEQUENCE") and applies(options.dm_key_protected, xid):
            out.append(
                f'#EXT-X-KEY:METHOD=AES-128,URI="key.bin?gen={generation}",'
                "IV=0x00000000000000000000000000000001"
            )
    return "\n".join(out) + "\n"


def bili_page_html(base: str, bvid: str, part: int, options: FakeOptions) -> str:
    """The Bilibili video page of `bvid` showing `part`, per `options`."""
    if applies(options.bili_riskdata, bvid):
        return _template("bilibili-riskdata.html")
    title = bili_title(bvid)
    cover = f"{base}/bili/cover/{bvid}.{cover_ext(options, bvid)}"
    parts = parts_of(options, bvid)
    aid = int(bili_cid(bvid, 0)) // 10
    state: dict[str, Any] = {"aid": aid, "bvid": bvid, "p": part, "episode": "", "error": {}}
    if applies(options.bili_login_wall, bvid):
        state["videoData"] = {}
        state["error"] = {"trueCode": -403, "message": "Login to watch", "code": 403}
    elif applies(options.bili_deleted, bvid):
        state["videoData"] = {}
        state["error"] = {"trueCode": -404, "message": "啥都木有", "code": 404}
    else:
        upower = applies(options.bili_upower_no_dash, bvid) or applies(options.bili_trial, bvid)
        pages = [
            {
                "cid": int(bili_cid(bvid, n)),
                "page": n,
                "from": "vupload",
                "part": bili_part_title(bvid, n, parts),
                "duration": SOURCE_SECONDS,
                "dimension": {"width": 1920, "height": 1080, "rotate": 0},
            }
            for n in range(1, parts + 1)
        ]
        state["videoData"] = {
            "bvid": bvid,
            "aid": aid,
            "videos": parts,
            "pic": cover,
            "title": title,
            "desc": "An invented video for StreamFetch's tests.",
            "duration": SOURCE_SECONDS * parts,
            "rights": {"is_stein_gate": 0, "download": 1, "pay": 0, "ugc_pay": 0},
            "owner": {"mid": 20250001, "name": "Fake Uploader"},
            "cid": pages[0]["cid"],
            "pages": pages,
            "is_upower_exclusive": upower,
            "is_upower_play": False,
            "is_upower_preview": applies(options.bili_trial, bvid),
        }
        state["upData"] = {"mid": 20250001, "name": "Fake Uploader"}
    playinfo = ""
    if state["videoData"]:
        info = bili_playinfo(base, bvid, part, options)
        playinfo = f"<script>window.__playinfo__={_script_json(info)}</script>"
    html = _template("bilibili-page.html")
    html = html.replace("{{TITLE}}", _html_text(title)).replace("{{COVER}}", cover)
    html = html.replace("{{PLAYINFO_SCRIPT}}", playinfo)
    return html.replace("{{STATE}}", _script_json(state))


def bili_playinfo(base: str, bvid: str, part: int, options: FakeOptions) -> dict[str, Any]:
    """`window.__playinfo__` for one part: the playurl answer with `fnval=4048` (DASH)."""
    cid = bili_cid(bvid, part)
    deadline = int(time.time()) + 3600
    served = sorted({quality for quality, _ in options.bili_qualities}, reverse=True)
    exists = list(served)
    if applies(options.bili_missing_premium, bvid) and BILI_PREMIUM_QUALITY not in exists:
        exists = sorted([*exists, BILI_PREMIUM_QUALITY], reverse=True)
    trial = applies(options.bili_trial, bvid)
    descriptions = [BILI_QUALITY_INFO[q][2] for q in exists]
    if trial:
        descriptions = [f"{text} 试看" for text in descriptions]

    def url(name: str, mirror: int = 1) -> str:
        query = f"deadline={deadline}&upsig={_token(cid, name, deadline)}&os=fake&bw=1"
        query += "" if mirror == 1 else f"&mirror={mirror}"
        return f"{base}/bili/cdn/{cid}/{name}.m4s?{query}"

    video = []
    for quality, codec in options.bili_qualities:
        width, height, _ = BILI_QUALITY_INFO[quality]
        codecs, codecid = BILI_CODECS[codec]
        name = str(quality) if codec == "avc" else f"{quality}-{codec}"
        bandwidth = (2_000_000 if quality >= 80 else 900_000) // (2 if codec == "hevc" else 1)
        video.append(
            {
                "id": quality,
                "baseUrl": url(name),
                "base_url": url(name),
                "backupUrl": [url(name, 2)],
                "backup_url": [url(name, 2)],
                "bandwidth": bandwidth,
                "mimeType": "video/mp4",
                "mime_type": "video/mp4",
                "codecs": codecs,
                "width": width,
                "height": height,
                "frameRate": "25",
                "frame_rate": "25",
                "codecid": codecid,
            }
        )
    audio = [
        {
            "id": audio_id,
            "baseUrl": url(f"audio-{audio_id}"),
            "base_url": url(f"audio-{audio_id}"),
            "backupUrl": [url(f"audio-{audio_id}", 2)],
            "backup_url": [url(f"audio-{audio_id}", 2)],
            "bandwidth": bandwidth,
            "mimeType": "audio/mp4",
            "mime_type": "audio/mp4",
            "codecs": "mp4a.40.2",
            "codecid": 0,
        }
        for audio_id, bandwidth in BILI_AUDIO
    ]
    data: dict[str, Any] = {
        "from": "local",
        "result": "suee",
        "quality": served[0] if served else 0,
        "format": "flv",
        "timelength": SOURCE_SECONDS * 1000,
        "accept_format": ",".join(f"q{q}" for q in exists),
        "accept_description": descriptions,
        "accept_quality": exists,
        "video_codecid": 7,
        "support_formats": [
            {
                "quality": q,
                "format": f"q{q}",
                "new_description": BILI_QUALITY_INFO[q][2],
                "display_desc": BILI_QUALITY_INFO[q][2].split(" ")[0],
                "superscript": "",
                "codecs": ["avc1.64001F"],
            }
            for q in exists
        ],
    }
    if not applies(options.bili_upower_no_dash, bvid):
        data["dash"] = {
            "duration": SOURCE_SECONDS,
            "minBufferTime": 1.5,
            "video": video,
            "audio": audio,
            "dolby": {"type": 0, "audio": None},
            "flac": None,
        }
    return {"code": 0, "message": "0", "ttl": 1, "data": data, "session": "fake0123456789"}


def btv_page_html(
    base: str, lang: str, options: FakeOptions, *, aid: str | None, ep_id: str | None
) -> str:
    """A bilibili.tv page: a user video (`aid`) or an episode (`ep_id`)."""
    if aid is not None:
        title = btv_title(aid)
        cover = f"{base}/btv-cover/{aid}.{cover_ext(options, aid)}"
        video = {
            "aid": int(aid),  # a number, as JSON gives it; the URL's string is the truth (A.7)
            "title": title,
            "title_display": title,
            "desc": "An invented user video for StreamFetch's tests.",
            "cover": cover,
            "duration": SOURCE_SECONDS,
            "formatted_pub_date": "2026-11-01",
        }
        initial: dict[str, Any] = {"UgcVideo": {"videoData": video}}
    else:
        assert ep_id is not None
        title = btv_episode_title(ep_id)
        cover = f"{base}/btv-cover/{ep_id}.{cover_ext(options, ep_id)}"
        episode = {
            "episode_id": int(ep_id),
            "season_id": int(BTV_SEASON),
            "title": title.split(" - ", 1)[-1],
            "title_display": title,
            "cover": cover,
            "duration": SOURCE_SECONDS,
            "formatted_pub_date": "2026-11-01",
        }
        initial = {"OgvVideo": {"epDetail": episode}}
    json_ld = {
        "@context": "https://schema.org",
        "@type": "VideoObject",
        "name": title,
        "duration": f"PT{SOURCE_SECONDS}S",
        "thumbnailUrl": [cover],
    }
    html = _template("bilibilitv-page.html").replace("{{LANG}}", lang)
    html = html.replace("{{TITLE}}", _html_text(title)).replace("{{COVER}}", cover)
    html = html.replace("{{DESC}}", "An invented page.").replace(
        "{{JSON_LD}}", _script_json(json_ld)
    )
    return html.replace("{{INITIAL_DATA}}", _script_json(initial))


def btv_playurl(
    base: str, uncovered_base: str, video_id: str, options: FakeOptions
) -> dict[str, Any]:
    """The playurl API's answer for a user video or an episode (`video_id`), per `options`."""
    for name, code in BTV_CODES.items():
        if applies(getattr(options, f"btv_{name}"), video_id):
            return {"code": code, "message": str(code), "ttl": 1, "data": None}
    deadline = int(time.time()) + 3600
    root = uncovered_base if applies(options.btv_uncovered_host, video_id) else base

    def url(name: str) -> str:
        sign = _token(video_id, name, deadline)
        return f"{root}/btv-cdn/{video_id}/{name}.mp4?deadline={deadline}&sign={sign}&bw=1"

    video: list[dict[str, Any]] = []
    audio: list[dict[str, Any]] = []
    if not applies(options.btv_empty, video_id):
        qualities = list(BTV_VIDEO)
        if applies(options.btv_missing_quality, video_id):
            qualities.insert(0, BTV_MISSING_QUALITY)
        for quality, words, width, height, bandwidth in qualities:
            missing = (quality, words, width, height, bandwidth) == BTV_MISSING_QUALITY
            resource = {
                "url": "" if missing else url(str(quality)),
                "backup_url": [],
                "bandwidth": bandwidth,
                "codecs": "avc1.64001F",
                "width": width,
                "height": height,
                "mime_type": "video/mp4",
                "size": 0,
                "quality": quality,
                "duration": SOURCE_SECONDS * 1000,
            }
            info = {"quality": quality, "desc_words": words, "need_vip": missing}
            video.append({"video_resource": resource, "stream_info": info, "audio_quality": 30280})
        audio = [
            {
                "url": url(f"audio-{quality}"),
                "backup_url": [],
                "bandwidth": bandwidth,
                "codecs": "mp4a.40.2",
                "mime_type": "audio/mp4",
                "size": 0,
                "quality": quality,
                "duration": SOURCE_SECONDS * 1000,
            }
            for quality, bandwidth in BTV_AUDIO
        ]
    playurl = {"duration": SOURCE_SECONDS * 1000, "video": video, "audio_resource": audio}
    return {"code": 0, "message": "0", "ttl": 1, "data": {"playurl": playurl}}


def btv_episodes(base: str, options: FakeOptions) -> dict[str, Any]:
    sections = []
    for number, indexes in enumerate(BTV_SECTIONS, start=1):
        episodes = []
        for index in indexes:
            ep_id, title = BTV_EPISODES[index]
            episodes.append(
                {
                    "episode_id": int(ep_id),
                    "title": title.split(" - ", 1)[-1],
                    "title_display": title,
                    "short_title_display": title.split(" - ", 1)[0],
                    "cover": f"{base}/btv-cover/{ep_id}.{cover_ext(options, ep_id)}",
                    "duration": SOURCE_SECONDS,
                }
            )
        sections.append({"title": f"Section {number}", "episodes": episodes})
    return {"code": 0, "message": "0", "ttl": 1, "data": {"sections": sections}}


def btv_season_info() -> dict[str, Any]:
    season = {"season_id": BTV_SEASON, "title": BTV_SEASON_TITLE, "description": "Invented."}
    return {"code": 0, "message": "0", "ttl": 1, "data": {"season": season}}


# -- the handler ---------------------------------------------------------------------------------


class _Handler(BaseHTTPRequestHandler):
    server: FakeSitesServer

    # -- bookkeeping ---------------------------------------------------------------------------

    def _begin(self) -> None:
        self.server.begin(urlsplit(self.path).path)
        self._started = time.monotonic()
        self._status = 0
        self._sent = 0
        self._cut = False
        self._route = "unknown"

    def _finish(self) -> None:
        parts = urlsplit(self.path)
        query = {k: v[-1] for k, v in parse_qs(parts.query, keep_blank_values=True).items()}
        jar: SimpleCookie = SimpleCookie()
        try:
            jar.load(self.headers.get("Cookie", ""))
        except Exception:  # a cookie header SimpleCookie cannot read: still no value logged
            jar = SimpleCookie()
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        self.server.record(
            RequestRecord(
                method=self.command,
                path=parts.path,
                query=query,
                host=host,
                referer=self.headers.get("Referer"),
                origin=self.headers.get("Origin"),
                range=self.headers.get("Range"),
                header_names=tuple(sorted({name.lower() for name in self.headers})),
                cookie_names=tuple(sorted(jar)),
                status=self._status,
                sent_bytes=self._sent,
                cut=self._cut,
                started=self._started,
                finished=time.monotonic(),
                route=self._route,
            )
        )

    def log_message(self, format: str, *args: Any) -> None:
        """Silence the access log (it would echo request lines into the test output)."""

    # -- answers ---------------------------------------------------------------------------------

    def _headers(self, status: int, content_type: str, length: int, extra: dict[str, str]) -> None:
        self._status = status
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        for name, value in extra.items():
            self.send_header(name, value)
        self.end_headers()

    def _send(
        self,
        status: int,
        body: bytes,
        content_type: str = "text/plain; charset=utf-8",
        extra: dict[str, str] | None = None,
    ) -> None:
        self._headers(status, content_type, len(body), extra or {})
        self.wfile.write(body)
        self._sent = len(body)

    def _json(self, payload: object, extra: dict[str, str] | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self._send(200, body, "application/json; charset=utf-8", extra)

    def _html(self, html: str, extra: dict[str, str] | None = None) -> None:
        self._send(200, html.encode(), "text/html; charset=utf-8", extra)

    def _playlist(self, text: str) -> None:
        self._send(200, text.encode(), "application/vnd.apple.mpegurl")

    def _not_found(self) -> None:
        self._send(404, b"not found")

    def _media(self, data: bytes, content_type: str, *, ranges: bool, cut: bool = False) -> None:
        """A media body: `Range` honoured when `ranges` (206 / 416), cut at half when `cut`
        (the full length announced, the connection dropped `CUT_LINGER_S` after the half)."""
        delay = self.server.options.media_delay_s
        if delay > 0:
            self.server.release.wait(delay)
        total = len(data)
        extra = {"Accept-Ranges": "bytes"} if ranges else {}
        status, body = 200, data
        asked = self.headers.get("Range")
        if ranges and asked is not None:
            match = _RANGE.match(asked.strip())
            start = int(match.group("start")) if match else total
            end = int(match.group("end")) if match and match.group("end") else total - 1
            if match is None or start >= total or end < start:
                self._send(416, b"", "text/plain", {"Content-Range": f"bytes */{total}"})
                return
            end = min(end, total - 1)
            status, body = 206, data[start : end + 1]
            extra["Content-Range"] = f"bytes {start}-{end}/{total}"
        if cut:
            self._headers(status, content_type, len(body), extra)
            half = body[: len(body) // 2]
            self.wfile.write(half)
            self.wfile.flush()
            self._sent, self._cut = len(half), True
            self.server.release.wait(CUT_LINGER_S)
            self.close_connection = True
            return
        self._send(status, body, content_type, extra)

    def _cover(self, video_id: str, ext: str) -> None:
        """A cover or poster (the cover rules of the module docstring)."""
        server, options = self.server, self.server.options
        refused = dict(options.cover_status).get(video_id)
        if refused is not None:
            self._send(refused, f"cover refused ({refused})".encode())
            return
        if ext != cover_ext(options, video_id):
            self._not_found()
            return
        content_type, attribute = COVER_FORMATS[ext]
        self._send(200, server.file(getattr(server.media, attribute)), content_type)

    def _referer_ok(self, site_prefix: str) -> bool:
        return self.headers.get("Referer") == f"{self.server.base_url}{site_prefix}/"

    # -- routing -------------------------------------------------------------------------------

    def do_GET(self) -> None:
        self._begin()
        try:
            self._route_get()
        finally:
            self._finish()

    def do_HEAD(self) -> None:
        self._begin()
        try:
            self._send(405, b"")
        finally:
            self._finish()

    def _route_get(self) -> None:
        path = urlsplit(self.path).path
        query = {k: v[-1] for k, v in parse_qs(urlsplit(self.path).query).items()}
        if path.startswith("/dm/"):
            self._dailymotion(path)
        elif path.startswith(("/bili/", "/b23/")):
            self._bilibili(path, query)
        elif path.startswith(("/btv", "/btv-api/", "/btv-cdn/", "/btv-cover/")):
            self._bilibilitv(path, query)
        else:
            self._not_found()

    # -- Dailymotion -----------------------------------------------------------------------------

    def _dailymotion(self, path: str) -> None:
        server, options, media = self.server, self.server.options, self.server.media
        if match := _DM_METADATA.match(path):
            self._route = "dm-metadata"
            xid = match.group("id")
            if not DM_ID_RE.match(xid):
                self._not_found()
                return
            self._json(dm_metadata(server.base_url, xid, options, _token("dm", xid)))
        elif match := _DM_MASTER.match(path):
            self._route = "dm-master"
            xid = match.group("id")
            if applies(options.dm_rate_limit_manifest, xid):
                self._send(429, b"Too Many Requests")
                return
            with server.lock:
                generation = server.state.dm_generation.get(xid, 0) + 1
                server.state.dm_generation[xid] = generation
            self._playlist(dm_master(xid, generation))
        elif match := _DM_MEDIA.match(path):
            self._route = "dm-media-playlist"
            xid, name = match.group("id"), match.group("name")
            if name not in {variant[0] for variant in DM_VARIANTS}:
                self._not_found()
                return
            with server.lock:
                generation = server.state.dm_generation.get(xid, 1)
            self._playlist(dm_media_playlist(media, xid, options, generation))
        elif match := _DM_SEGMENT.match(path):
            self._route = "dm-segment"
            self._dm_segment(match.group("id"), int(match.group("n")), match.group("ext"))
        elif match := _DM_INIT.match(path):
            self._route = "dm-init"
            if media.hls_fmp4.init is None or not applies(options.dm_fmp4, match.group("id")):
                self._not_found()
                return
            self._media(server.file(media.hls_fmp4.init), "video/mp4", ranges=False)
        elif _DM_KEY.match(path):
            self._route = "dm-key"
            self._not_found()
        elif match := _DM_POSTER.match(path):
            self._route = "dm-poster"
            self._cover(match.group("id"), match.group("ext"))
        else:
            self._not_found()

    def _dm_segment(self, xid: str, number: int, ext: str) -> None:
        server, options = self.server, self.server.options
        fmp4 = applies(options.dm_fmp4, xid)
        fixture = server.media.hls_fmp4 if fmp4 else server.media.hls_ts
        if (ext == "m4s") != fmp4 or number >= len(fixture.segments):
            self._not_found()
            return
        if number == EXPIRING_SEGMENT and applies(options.dm_expire_segment_once, xid):
            with server.lock:
                first = xid not in server.state.dm_expired
                server.state.dm_expired.add(xid)
            if first:
                self._send(403, b"Forbidden: the URL expired")
                return
        cut = False
        if number == TRUNCATED_SEGMENT and applies(options.dm_truncate_segment, xid):
            with server.lock:
                cut = xid not in server.state.dm_truncated
                server.state.dm_truncated.add(xid)
        content_type = "video/mp4" if fmp4 else "video/mp2t"
        data = server.file(fixture.segments[number])
        self._media(data, content_type, ranges=False, cut=cut)

    # -- Bilibili --------------------------------------------------------------------------------

    def _bilibili(self, path: str, query: dict[str, str]) -> None:
        server, options = self.server, self.server.options
        if match := _BILI_PAGE.match(path):
            self._route = "bili-page"
            bvid = match.group("id")
            if not BILI_ID_RE.match(bvid):
                self._not_found()
                return
            parts = parts_of(options, bvid)
            part = int(query["p"]) if query.get("p", "").isdigit() else 1
            part = part if 1 <= part <= parts else 1
            with server.lock:
                for n in range(1, parts + 1):
                    server.state.bili_cids[bili_cid(bvid, n)] = (bvid, n)
                server.state.bili_page_serves[bvid] = server.state.bili_page_serves.get(bvid, 0) + 1
            html = bili_page_html(server.base_url, bvid, part, options)
            cookie = f"SESSDATA={FAKE_SESSDATA}; Path=/; HttpOnly; SameSite=Lax"
            self._html(html, {"Set-Cookie": cookie})
        elif match := _B23.match(path):
            self._route = "b23"
            bvid = B23_CODES.get(match.group("code"))
            if bvid is None:
                self._not_found()
                return
            location = f"{server.base_url}/bili/video/{bvid}?share_source=copy_web"
            self._send(302, b"", "text/plain", {"Location": location})
        elif match := _BILI_VIDEO.match(path):
            self._route = "bili-video"
            self._bili_cdn(
                match.group("cid"), query, video=(match.group("q"), match.group("codec"))
            )
        elif match := _BILI_AUDIO.match(path):
            self._route = "bili-audio"
            self._bili_cdn(match.group("cid"), query, video=None)
        elif match := _BILI_COVER.match(path):
            self._route = "bili-cover"
            self._cover(match.group("id"), match.group("ext"))
        else:
            self._not_found()

    def _bili_cdn(
        self, cid: str, query: dict[str, str], video: tuple[str, str | None] | None
    ) -> None:
        server, options, media = self.server, self.server.options, self.server.media
        with server.lock:
            owner = server.state.bili_cids.get(cid)
        if owner is None:
            self._not_found()
            return
        bvid, part = owner
        if applies(options.bili_cdn_412, bvid):
            self._send(412, b"Request is blocked by server (412)")
            return
        if not self._referer_ok("/bili"):
            self._send(403, b"Forbidden: no referer")
            return
        deadline = query.get("deadline", "")
        if not deadline.isdigit() or int(deadline) < time.time():
            self._send(403, b"Forbidden: expired")
            return
        if video is None:
            if applies(options.bili_expire_once, bvid):
                with server.lock:
                    first = cid not in server.state.bili_expired
                    server.state.bili_expired.add(cid)
                if first:
                    self._send(403, b"Forbidden: expired")
                    return
            self._media(server.file(media.dash_audio), "video/mp4", ranges=True)
            return
        quality, codec = int(video[0]), video[1] or "avc"
        if (quality, codec) not in options.bili_qualities:
            self._not_found()
            return
        if applies(options.bili_drm, bvid):
            source = media.dash_video_encrypted
        else:
            source = media.dash_video if quality >= 80 else media.dash_video_low
        cut = False
        if part == 1 and applies(options.bili_cut_once, bvid):
            with server.lock:
                cut = bvid not in server.state.bili_cut
                server.state.bili_cut.add(bvid)
        self._media(server.file(source), "video/mp4", ranges=True, cut=cut)

    # -- Bilibili.tv -----------------------------------------------------------------------------

    def _bilibilitv(self, path: str, query: dict[str, str]) -> None:
        server, options, media = self.server, self.server.options, self.server.media
        if match := _BTV_VIDEO_PAGE.match(path):
            self._route = "btv-page"
            lang = (match.group("lang") or "en").lower()
            aid = match.group("aid")
            self._html(btv_page_html(server.base_url, lang, options, aid=aid, ep_id=None))
        elif match := _BTV_EPISODE_PAGE.match(path):
            self._route = "btv-page"
            lang = (match.group("lang") or "en").lower()
            ep_id = match.group("ep")
            if match.group("season") != BTV_SEASON or ep_id not in dict(BTV_EPISODES):
                self._not_found()
                return
            self._html(btv_page_html(server.base_url, lang, options, aid=None, ep_id=ep_id))
        elif path == _BTV_PLAYURL:
            self._route = "btv-playurl"
            video_id = query.get("aid") or query.get("ep_id") or ""
            if not video_id.isdigit() or query.get("platform") != "web":
                self._json({"code": -400, "message": "invalid request", "ttl": 1, "data": None})
                return
            self._json(btv_playurl(server.base_url, server.uncovered_base, video_id, options))
        elif path == _BTV_EPISODES:
            self._route = "btv-episodes"
            if query.get("season_id") != BTV_SEASON:
                self._json({"code": -404, "message": "-404", "ttl": 1, "data": None})
                return
            self._json(btv_episodes(server.base_url, options))
        elif path == _BTV_SEASON_INFO:
            self._route = "btv-season-info"
            if query.get("season_id") != BTV_SEASON:
                self._json({"code": -404, "message": "-404", "ttl": 1, "data": None})
                return
            self._json(btv_season_info())
        elif match := _BTV_VIDEO.match(path):
            self._route = "btv-video"
            video_id, quality = match.group("id"), int(match.group("q"))
            if quality not in {q[0] for q in BTV_VIDEO} or not self._btv_cdn_ok(query):
                return
            fragmented = applies(options.btv_fragmented, video_id)
            if quality >= 80:
                source = media.dash_video if fragmented else media.progressive_video
            else:
                source = media.dash_video_low if fragmented else media.progressive_video_low
            self._media(server.file(source), "video/mp4", ranges=True)
        elif match := _BTV_AUDIO.match(path):
            self._route = "btv-audio"
            video_id = match.group("id")
            if int(match.group("q")) not in {q for q, _ in BTV_AUDIO}:
                self._not_found()
                return
            if not self._btv_cdn_ok(query):
                return
            fragmented = applies(options.btv_fragmented, video_id)
            source = media.dash_audio if fragmented else media.progressive_audio
            self._media(server.file(source), "audio/mp4", ranges=True)
        elif match := _BTV_COVER.match(path):
            self._route = "btv-cover"
            self._cover(match.group("id"), match.group("ext"))
        else:
            self._not_found()

    def _btv_cdn_ok(self, query: dict[str, str]) -> bool:
        """The bilibili.tv CDN's checks: the fake site's `Referer`, an unexpired `deadline`;
        answers the refusal itself."""
        if not self._referer_ok("/btv"):
            self._send(403, b"Forbidden: no referer")
            return False
        deadline = query.get("deadline", "")
        if not deadline.isdigit() or int(deadline) < time.time():
            self._send(403, b"Forbidden: expired")
            return False
        return True


# -- the context manager the tests use -----------------------------------------------------------


class FakeSites:
    """`with FakeSites(media, dm_fmp4=frozenset({DM_FMP4_ID})) as sites: ... sites.base_url ...`."""

    def __init__(self, media: MediaSet, **options: Any) -> None:
        self.media = media
        self._options = FakeOptions(**options)
        self._server: FakeSitesServer | None = None
        self._thread: threading.Thread | None = None

    def __enter__(self) -> FakeSites:
        self._server = FakeSitesServer(self._options, self.media)
        self._thread = threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        )
        self._thread.start()
        return self

    def __exit__(self, *exc_info: object) -> None:
        assert self._server is not None and self._thread is not None
        self._server.release.set()
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)

    @property
    def server(self) -> FakeSitesServer:
        assert self._server is not None, "the fake sites are not running"
        return self._server

    @property
    def options(self) -> FakeOptions:
        return self.server.options

    def set_options(self, **changes: Any) -> None:
        """Change options while the server runs (e.g. lift a geo-block before a Retry)."""
        with self.server.lock:
            self.server.options = replace(self.server.options, **changes)

    @property
    def base_url(self) -> str:
        return self.server.base_url

    @property
    def port(self) -> int:
        return self.server.port

    def url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    def base_urls(self) -> dict[str, str]:
        """`testSettings.baseUrls`: where the extension's test copy finds each fake site."""
        base = self.base_url
        return {
            "dailymotion": f"{base}/dm",
            "dmcdn": f"{base}/dm/cdn",
            "bilibili": f"{base}/bili",
            "b23": f"{base}/b23",
            "bilibilitv": f"{base}/btv",
            "bilibilitvApi": f"{base}/btv-api",
        }

    def expected_referer(self, site: str) -> str:
        """The `Referer` the extension's test copy must send on that site's media requests: the
        fake site's base and a slash (in production: `https://www.dailymotion.com/`,
        `https://www.bilibili.com/`, `https://www.bilibili.tv/`)."""
        return self.base_urls()[site] + "/"

    # -- the log -------------------------------------------------------------------------------

    @property
    def requests(self) -> list[RequestRecord]:
        """The log (see `FakeSitesServer.logged`)."""
        return self.server.logged()

    def started_paths(self) -> list[str]:
        """The path of every request received so far, answered or not (`media_delay_s` holds
        media answers: this sees them start)."""
        with self.server.lock:
            return list(self.server.started_paths)

    def clear_log(self) -> None:
        """Forget the log (once the requests being answered are logged)."""
        server = self.server
        with server.settled_condition:
            server.settled_condition.wait_for(lambda: server.in_flight == 0, SETTLE_S)
            server.requests.clear()
            server.started_paths.clear()

    def by_route(self, *routes: str) -> list[RequestRecord]:
        return [r for r in self.requests if r.route in routes]

    def of_kind(self, kind: str, site: str | None = None) -> list[RequestRecord]:
        return [r for r in self.requests if r.kind == kind and (site is None or r.site == site)]

    def media_requests(self, site: str | None = None) -> list[RequestRecord]:
        return self.of_kind("media", site)

    def page_requests(self, site: str | None = None) -> list[RequestRecord]:
        return self.of_kind("page", site)

    def cover_requests(self, site: str | None = None) -> list[RequestRecord]:
        return self.of_kind("cover", site)

    def site_requests(self) -> list[RequestRecord]:
        """Every request but the covers: what one run asks of the sites."""
        return [r for r in self.requests if r.kind in {"page", "media"}]

    def about(self, video_id: str, *, covers: bool = False) -> list[RequestRecord]:
        """Every request that names `video_id` in its path or query (pages, APIs, manifests, its
        segments), plus the Bilibili CDN requests of its cids; its covers only with `covers`
        (they are loaded lazily, when its row is in view, whatever the run did)."""
        with self.server.lock:
            cids = {
                cid for cid, (bvid, _) in self.server.state.bili_cids.items() if bvid == video_id
            }
        found = []
        for record in self.requests:
            if record.kind == "cover" and not covers:
                continue
            segments = record.path.split("/")
            if (
                video_id in segments
                or any(segment.startswith(f"{video_id}.") for segment in segments)
                or video_id in record.query.values()
                or (record.route.startswith("bili-") and cids.intersection(segments))
            ):
                found.append(record)
        return found

    def uncovered_requests(self) -> list[RequestRecord]:
        """Requests that reached the fake under a host the test copy does not cover."""
        return [r for r in self.requests if r.host == "localhost"]
