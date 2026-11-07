"""Pure parsing and validation of TikTok's short-drama payloads. No I/O, no network.

TikTok facts this module encodes (verified October 2026; the free series with conditions and the
short header on 2026-11-06, from the owner's real run):

- The web app lists a series through
  ``GET /api/drama/episode/item_list/?dramaID=<series_id>&cursor=<c>&count=<n>&...`` and answers
  ``{"itemList": [...], "cursor": 30, "hasMore": true}``. The list is sometimes nested under
  another key, so :func:`find_item_lists` searches recursively.
- Each item is an ordinary TikTok video object (``id``, ``desc``, ``author``, ``video``) plus a
  ``dramaInfo`` block. ``dramaInfo.DramaVideoData.EpisodeNumber`` is the 1-based episode number
  and the only reliable order: series are published in batches, so ``createTime`` is a shuffle.
  Items without a number (trailers) are skipped; items whose ``dramaInfo.dramaID`` names another
  series are dropped.
- TikTok sells later episodes (coins, a purchase, a subscription). The fields that say whether
  THIS session may play one are undocumented, so :func:`access_of` applies key-name heuristics to
  the payload TikTok served to the user's own session and sorts each episode into ``free``,
  ``unlocked`` (sold, and this account may play it: an entitlement flag such as ``isUnlocked``,
  or a play URL TikTok gave this session for a sold episode) or ``locked`` (a lock, paywall or
  DRM flag, a short header, on a sold episode an entitlement flag that says no, or no play
  address at all); :func:`lock_hints` lists every clue it found. Locked episodes are listed and
  skipped. Nothing here unlocks, buys, fakes entitlement or bypasses anything: the decision only
  reads what TikTok already sent to that session. The field names were inferred without access to
  TikTok; ``--dump-raw`` from a real run confirms them.
- A free series with conditions (verified 2026-11-06: 62 real items, every one of them carrying
  exactly these fields and nothing else that names a price, a lock or an entitlement) says
  ``dramaInfo.isLimitedFree: true`` — the whole series is free, however it is sold otherwise;
  what the condition is, the field does not say — and its ``dramaInfo.DramaVideoData`` carries
  ``IsFreeIntro`` ("is this the free intro teaser": false on every episode, E01 included — NOT
  "is free"), ``IsPreview`` (true on fully served episodes too) and ``PreviewType`` (``4`` or
  ``1``, on fully served episodes too): none of the three says whether this session may play
  the episode, so they give no clue. What does say something is the payload's durations:
  ``video.duration`` is the episode's full length, and ``music.duration`` (the episode's own
  sound, ``music.original: true``) is how long that sound lasts — equal to ``video.duration``
  on a fully served episode, about 70 s on one whose file comes WHOLE by size (``video.size``
  == ``bitrateInfo[0].PlayAddr.DataSize`` ≈ ``Bitrate * duration / 8``) but whose MP4 header
  plays only that part: a window for an episode the account has not unlocked, or a defective
  encode on TikTok's side (the owner's 7 episodes of 2026-11-06 broke at the same point in the
  TikTok app and in TikTok's web player: no sound past it, a broken picture when seeking past
  it) — the list cannot tell the two apart. :func:`access_of`'s SHORT-HEADER rule locks such an
  episode before any request (hint :data:`SHORT_HEADER_HINT_PREFIX` + ``69 s of 106 s``:
  ``plays 69 s of 106 s``); :func:`listed_sizes` gives the sizes the engines compare a saved
  file against to name a short-served file after a download. DramaFetch never rewrites a header
  to play past what it indexes: if the TikTok app plays the episode whole, the user watches it
  there, then looks again (``--recheck``) and a new listing reads it fresh; if the app breaks at
  the same point too, nothing changes it until TikTok replaces the file.
- ``GET /api/drama/detail/`` carries the series name and announced total; its exact shape is
  unknown, so :func:`parse_detail_payload` is best-effort.
- Every item carries the episode's signed play URLs (``video.bitrateInfo[*].PlayAddr.UrlList`` per
  codec and bitrate, plus ``video.playAddr``), valid until their ``expire`` query parameter.
  Each ``bitrateInfo`` entry is one rendition — ``CodecType`` (``h264``, ``h265`` or ``bytevc1``,
  TikTok's name for its H.265 streams), ``Bitrate`` in bit/s, ``GearName`` such as
  ``normal_720_0`` or ``adapt_lower_1080_1`` (the height is in the name; ``video.ratio`` like
  ``720p`` describes the main one) and the URLs. A URL whose path ends in ``/media-video-hvc1/``
  is one of TikTok's video-only HEVC streams (no audio track: yt-dlp marks them ``acodec: none``)
  and is never a candidate (:data:`VIDEO_ONLY_PATH_SUFFIX`). :func:`renditions` reads them,
  :func:`choose_rendition` picks one per quality mode, :func:`play_url_candidates` orders the
  URLs and :func:`url_expiry` reads the expiry; the browser download engine fetches them directly
  instead of loading each episode's page.
- Every item also carries the episode cover (thumbnail) as signed image URLs on
  ``p16-sign-*.tiktokcdn.com``: ``video.originCover`` (the full frame), ``video.cover`` (a
  cropped poster) and ``video.dynamicCover`` (an animated preview), each a string in the web
  payload (a ``UrlList`` dict or a list elsewhere). :func:`episode_from_item` keeps the first of
  them as ``Episode.cover_url``, in that order.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs, urlsplit

from dramafetch.models import QUALITY_MODES, Episode

#: How deep the recursive searches descend into a payload before giving up.
MAX_DEPTH = 12
#: The hint of an item THIS session's payload gives no play address for.
NO_PLAY_ADDRESS = "no play address"
#: The hint of an item whose ``music.duration`` is far shorter than its ``video.duration``
#: (the SHORT-HEADER rule of :func:`access_of`): ``plays 69 s of 106 s``.
SHORT_HEADER_HINT_PREFIX = "plays "
#: The SHORT-HEADER rule: ``music.duration <= SHORT_HEADER_RATIO * video.duration`` and the
#: two at least :data:`SHORT_HEADER_MIN_GAP_S` apart (TikTok's ``duration`` fields are whole
#: seconds; a sound track a second shorter than the video is an ordinary episode).
SHORT_HEADER_RATIO = 0.85

#: The largest integer both front ends read exactly (JavaScript's ``Number.MAX_SAFE_INTEGER``):
#: ``_as_int`` — every episode number, duration, size and bitrate read from the payload — gives
#: None beyond it, so a 400-digit ``video.duration`` or ``DataSize`` is junk in both front ends
#: (the extension parses it as ``Infinity`` or an inexact float), never a ``float`` overflow in
#: ``SHORT_HEADER_RATIO * duration``, ``media.verify_video``'s tolerance or the engines' size
#: tolerance (``OverflowError`` would take the whole listing or download down).
MAX_EXACT_INT = 2**53 - 1
SHORT_HEADER_MIN_GAP_S = 1

_ITEM_LIST_KEYS = ("itemList", "item_list")
#: The key-name heuristic of the builds before the access model; it still catches the leftovers
#: (``unlockType: 1``) as pricing clues, see :func:`access_of`. Matched against the key without
#: its ``block`` words (:func:`_without_block_words`): "block" is not "lock". ``preview`` left it
#: on 2026-11-06: ``IsPreview`` / ``PreviewType`` are set on fully served episodes.
_LOCK_KEY_RE = re.compile(r"lock|paid|needpay|unlock|price|coin|vip", re.IGNORECASE)
#: A ``free`` key: falsy a PRICING clue (``isFree=false``), truthy a FREE clue (``isLimitedFree``)
#: — unless one of its :func:`key_words` is ``intro`` (:data:`_INTRO_WORD`: ``IsFreeIntro``,
#: ``is_free_intro``, "is this the free intro teaser"), which says nothing about the episode, or
#: names DRM (``isDrmFree``, ``drm_free``, ``encryptionFree``: a negation of DRM, not a price —
#: :func:`_names_drm`), which is no price clue either.
_FREE_KEY_RE = re.compile(r"free", re.IGNORECASE)
_INTRO_WORD = "intro"
# The clue classes of :func:`access_of` and the key patterns behind them (case-insensitive).
_DRM = "drm"
#: A truthy ``free`` key (``isLimitedFree: true``, ``isFree: true``, ``limitedFree: 1``): the
#: episode is free for this session, whatever the series' pricing says otherwise (and whatever
#: condition the key's name alludes to: the payload does not say).
_FREE = "free"
#: The structural rule behind :data:`SHORT_HEADER_HINT_PREFIX` (not a key clue).
_SHORT_HEADER = "short-header"
_ENTITLED = "entitled"
#: An ENTITLED full key with a falsy value (``isUnlocked: false``): on a sold episode, the payload
#: saying the account has NOT unlocked it — the flag a client shows its paywall from.
_NOT_ENTITLED = "not-entitled"
_VIEWER_LOCK = "viewer-lock"
_AMBIGUOUS = "ambiguous"
_PRICING = "pricing"
#: One word of a key (:func:`key_words`): an acronym run with its plural ``s`` (``IDs`` of
#: ``encryptedIDs``), the acronym run before a capitalised word (``DRM`` of ``DRMType``), a
#: capitalised or lower-case word, an acronym, a run of digits. Anything else — ``_``, ``-``,
#: spaces, other characters — only separates words.
_KEY_WORD_RE = re.compile(r"[A-Z]+s(?![a-z])|[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+")
#: Words that turn a DRM key into its opposite (``isDrmFree``, ``no_drm``, ``nonEncrypted``,
#: ``notEncrypted``, ``unEncrypted``) ...
_DRM_NEGATION_WORDS = frozenset({"free", "no", "non", "not", "un", "without"})
#: ... or into an identifier, which says nothing about the media (``encryptedUid``,
#: ``encrypted_id``: TikTok's encrypted user ids).
_DRM_ID_WORDS = frozenset({"id", "ids", "uid", "uids"})
#: Matched against the FULL key: ``isUnlocked``, ``is_purchased``, ``hasPaid``, ``paidByUser``, …
_ENTITLED_KEY_RE = re.compile(
    r"(?:is_?)?(?:unlocked|purchased|bought|entitled)"
    r"|has_?(?:paid|purchased|unlocked|bought|access)"
    r"|paid_?by_?(?:user|viewer|me)",
    re.IGNORECASE,
)
#: Matched against the FULL key: ``isLocked``, ``is_locked``, ``locked``.
_LOCKED_KEY_RE = re.compile(r"(?:is_?)?locked", re.IGNORECASE)
#: Anywhere in the key: a payment still needed, a paywall. ``preview`` and ``trial`` were lock
#: words until 2026-11-06, when a real payload showed ``IsPreview: true`` and ``PreviewType`` on
#: fully served episodes of a free series with conditions (``isLimitedFree``): they give no clue
#: now.
_VIEWER_LOCK_KEY_RE = re.compile(r"need_?(?:pay|unlock|buy|purchase)|paywall", re.IGNORECASE)
#: ``lockStatus`` / ``lock_status`` — not ``unlockStatus``, which is a :data:`_STATUS_KEY_RE`,
#: and not ``blockStatus`` (matched against the key without its ``block`` words, see
#: :func:`_without_block_words`). A bool or a number — or a string that spells one, see
#: :data:`_NUMBER_OR_BOOL_TEXT_RE` — locks when truthy; any other STRING value is read like a
#: status (the two sets below), and one that neither set knows is a hint only.
_LOCK_STATUS_KEY_RE = re.compile(r"(?<!un)lock_?status", re.IGNORECASE)
#: A string that spells a number or a bool (``"1"``, ``" 2 "``, ``"-1"``, ``"1.5"``, ``"true"``,
#: ``"yes"``): a ``lock_?status`` key reads it as that number or bool, the way :func:`_truthy`
#: reads ``"0"`` and ``"false"`` — so ``lockStatus: "1"`` locks like ``lockStatus: 1``.
_NUMBER_OR_BOOL_TEXT_RE = re.compile(r"[+-]?[0-9]+(?:\.[0-9]+)?|true|yes", re.IGNORECASE)
#: ``unlockStatus`` / ``payStatus`` / ``purchaseStatus``: only a STRING value decides (one of the
#: two sets below); a bool or a number is a hint only (1 can mean either).
_STATUS_KEY_RE = re.compile(r"(?:unlock|pay|purchase)_?status", re.IGNORECASE)
_ENTITLED_STATUS_VALUES = frozenset({"unlocked", "paid", "purchased", "bought", "entitled"})
_LOCKED_STATUS_VALUES = frozenset(
    {"locked", "lock", "need_pay", "needpay", "unpaid", "unpurchased"}
)
_KNOWN_STATUS_VALUES = _ENTITLED_STATUS_VALUES | _LOCKED_STATUS_VALUES
_PRICE_KEY_RE = re.compile(r"price|coin|cost|charge", re.IGNORECASE)
_SOLD_KEY_RE = re.compile(r"vip|paid", re.IGNORECASE)
_SERIES_ID_KEYS = ("dramaID", "dramaId", "DramaID", "albumId")
_EPISODE_NUMBER_KEYS = ("EpisodeNumber", "episodeNumber", "episode_number")
_NAME_KEYS = ("dramaName", "title", "name")
_TOTAL_KEYS = ("totalEpisode", "totalEpisodes", "episodeCount", "total", "episodeTotal")
_DETAIL_CONTAINER_KEYS = ("dramaInfo", "drama", "detail")
#: Where an item's cover image lives, best first: the full frame, the cropped poster, the animated
#: preview.
_COVER_KEYS = ("originCover", "cover", "dynamicCover")
_FALSY_STRINGS = frozenset({"", "0", "false", "no", "none", "null"})
_MAX_HINT_VALUE_LEN = 40


@dataclass
class PagePayload:
    """What one ``item_list`` page contributed after filtering for the requested series."""

    episodes: list[Episode]
    cursor: int | str | None
    has_more: bool
    seen_items: int
    skipped_items: int


def find_item_lists(payload: Any, max_depth: int = MAX_DEPTH) -> list[list[dict[str, Any]]]:
    """Return every ``itemList`` (list of item dicts) found in the payload, in document order.

    The search is recursive through dicts and lists, depth-limited, and does not descend into a
    list once it has been identified as an item list. Non-dict entries are dropped.
    """
    found: list[list[dict[str, Any]]] = []
    _walk_item_lists(payload, 0, max_depth, found)
    return found


def _walk_item_lists(
    node: Any, depth: int, max_depth: int, found: list[list[dict[str, Any]]]
) -> None:
    if depth > max_depth:
        return
    if isinstance(node, dict):
        for key, value in node.items():
            if key in _ITEM_LIST_KEYS and isinstance(value, list):
                found.append([entry for entry in value if isinstance(entry, dict)])
            else:
                _walk_item_lists(value, depth + 1, max_depth, found)
    elif isinstance(node, list):
        for value in node:
            _walk_item_lists(value, depth + 1, max_depth, found)


def access_of(item: dict[str, Any]) -> tuple[str, bool, bool, tuple[str, ...]]:
    """``(access, paid, drm, hints)`` of an item: what THIS session may do with the episode.

    Pure and deterministic; never raises on junk. ``access`` is one of ``models.ACCESS_MODES``,
    decided from the payload TikTok served to the user's own session — nothing here unlocks,
    buys, fakes or sends anything. Scanned: the item's top-level scalar keys (those of an
    ``itemStruct`` wrapper too), ``dramaInfo`` recursively (``MAX_DEPTH``) and ``video``'s
    top-level scalar keys; values are bools, numbers and strings only (``_truthy`` as ever: ``0``,
    ``""``, ``"false"``, ``"no"``, ``"none"``, ``"null"`` are falsy). Keys match
    case-insensitively; every clue gives the hint ``<key>=<value>`` (a falsy ``free`` key gives
    ``isFree=false``). Then two structural rules read the durations and the play address. The
    clue classes:

    - DRM: a key that names DRM in whole words (:func:`is_drm_key`: one of its
      :func:`key_words` is ``drm`` or starts with ``encrypt``, none is a negation — ``free``,
      ``no``, ``non``, ``not``, ``un``, ``without`` — or an identifier — ``id``, ``ids``,
      ``uid``, ``uids``), truthy: ``isDrm``, ``drmType: "widevine"``, ``DRMType``,
      ``is_encrypted``, ``encryption: "cenc"``; never ``hdrMode``, ``isDrmFree``, ``no_drm``,
      ``nonEncrypted``, ``unencrypted``, ``unEncrypted``, ``encryptedUid`` or ``encryptedUIDs``.
    - ENTITLED (the account may play it): a FULL key ``(is_?)?(unlocked|purchased|bought|
      entitled)``, ``has_?(paid|purchased|unlocked|bought|access)`` or
      ``paid_?by_?(user|viewer|me)``, truthy; or an ``(unlock|pay|purchase)_?status`` or
      ``lock_?status`` key whose string value is ``unlocked``, ``paid``, ``purchased``,
      ``bought`` or ``entitled``.
    - NOT-ENTITLED: one of those full keys with a falsy value (``isUnlocked: false``,
      ``hasPaid: 0``): the payload says the account has not unlocked it. It decides only for a
      sold episode (rule 5) and is not counted in ``paid``.
    - VIEWER-LOCK (this session cannot play it): a FULL key ``(is_?)?locked``; a key containing
      ``need_?(pay|unlock|buy|purchase)`` or ``paywall``; a ``lock_?status`` key (not
      ``unlock…``, not ``block…``) with a bool or a number, or a string that spells one (``"1"``,
      ``"true"``) — all truthy; or an ``(unlock|pay|purchase)_?status`` or ``lock_?status`` key
      whose string value is ``locked``, ``lock``, ``need_pay``, ``needpay``, ``unpaid`` or
      ``unpurchased``. NOT ``preview`` or ``trial`` keys (``IsPreview``, ``PreviewType``,
      ``isTrial``): verified on 2026-11-06 on fully served episodes, they give no clue and no hint
      (the raw item keeps them for diagnosis).
    - AMBIGUOUS: an ``(unlock|pay|purchase)_?status`` key with a bool or numeric value (1 can mean
      either), or a ``lock_?status`` key with any other non-falsy string: a hint, it NEVER
      decides.
    - FREE (free for this session): a key containing ``free`` whose :func:`key_words` do not
      include ``intro``, truthy — ``isLimitedFree: true`` (a sold series free with conditions the
      field does not name), ``isFree: true``, ``limitedFree: 1``. Its hint ``<key>=<value>``
      (``isLimitedFree=True``) is listed only next to a PRICING clue, where it says why a sold
      episode is free; on
      its own a free flag says nothing about a price or a lock, and the hints stay empty (as they
      did for ``isFree: true`` before).
    - PRICING (the episode is sold): such a ``free`` key with a falsy value (hint
      ``isFree=false``); a key containing ``price``, ``coin``, ``cost`` or ``charge`` with a number
      above 0 (or a truthy string); a key containing ``vip`` or ``paid`` that is not an ENTITLED
      full key, truthy; and any other truthy key the old ``lock|paid|needpay|unlock|price|coin|vip``
      heuristic matched and no class above turned into a clue (``unlockType: 1``) — "block" is
      not "lock": a word that contains ``block`` is no lock word (``blockStatus``, ``isBlocked``:
      no clue at all), while ``subLockStatus`` or ``webLock`` still is one. A ``free`` key with
      ``intro`` among its words (``IsFreeIntro``, ``is_free_intro``: "is this the free intro
      teaser"), or one that names DRM (``isDrmFree``, ``drm_free``: a DRM negation, see
      :func:`is_drm_key`), gives no clue at all, whatever its value.
    - SHORT-HEADER (structural, no key): ``video.duration`` (``_as_int``-style, > 0),
      ``music.duration`` (the item's top-level ``music`` dict; a number > 0) and ``music.original``
      truthy, with ``music_duration <= 0.85 * video_duration`` and ``video_duration -
      music_duration >= 1`` (:data:`SHORT_HEADER_RATIO`, :data:`SHORT_HEADER_MIN_GAP_S`): the
      episode's own sound is far shorter than the episode, and so is what the file TikTok
      serves plays — a window for an episode the account has not unlocked, or a defective
      encode on TikTok's side; the list cannot tell. Hint :data:`SHORT_HEADER_HINT_PREFIX` +
      ``<music> s of <video> s`` (``plays 69 s of 106 s``). Without ``music.original`` truthy,
      or without either duration, the rule never fires: a licensed track's length says nothing.
    - PLAY (structural): no ``video.playAddr`` and an empty ``video.bitrateInfo`` (or no ``video``
      at all) in this session's payload: the hint :data:`NO_PLAY_ADDRESS`.

    Decision, first match wins: a DRM clue -> ``locked`` with ``drm`` (DramaFetch never decrypts);
    an ENTITLED clue -> ``unlocked`` (even without a play address: the account is entitled, and
    the downloader finds out what TikTok serves); SHORT-HEADER -> ``locked``; a VIEWER-LOCK clue
    -> ``locked``; no play address -> ``locked`` (free-looking items included); a FREE clue ->
    ``free`` (it beats PRICING: a sold series the payload calls free is free); a PRICING clue
    -> ``unlocked`` when this session's payload holds a real play URL for it
    (:func:`play_url_candidates`: an http(s) URL — a ``bitrateInfo`` entry without one, or a
    ``playAddr`` such as ``"null"``, is no address) and no NOT-ENTITLED clue, else ``locked``
    (without a URL with the hint :data:`NO_PLAY_ADDRESS`); else ``free``. ``paid`` is any PRICING
    or ENTITLED clue. Why a sold episode WITH a play URL counts as unlocked: a client that is to
    show a paywall or a window needs a flag for it — a lock or paywall flag, an entitlement flag
    that says no, or the short header the durations give away — and with none the URL is what
    TikTok's own web player plays for this session. Should the file turn out short after all,
    the integrity check of every download (``media.verify_video``: the duration) catches it: a
    whole file by :func:`listed_sizes` with a short header is named short-served
    (``downloader.served_short``), anything else is quarantined as incomplete.
    """
    if not isinstance(item, dict):
        item = {}
    clues: list[tuple[str, str]] = []
    for key, value in _top_level_scalars(item):
        clues.extend(_clues(key, value))
    drama_info = _field(item, "dramaInfo")
    if isinstance(drama_info, dict):
        _collect_clues(drama_info, 0, clues)
    video = _field(item, "video")
    if isinstance(video, dict):
        for key, value in video.items():
            clues.extend(_clues(str(key), value))
    playable = isinstance(video, dict) and _has_play_address(video)
    window = _short_header(item, video)
    classes = {kind for kind, _ in clues}
    # a free flag is a hint only next to a price (it says why a sold episode is free); on
    # its own it says nothing about a price or a lock, which is what an empty tuple means
    hints = [hint for kind, hint in clues if kind != _FREE or _PRICING in classes]
    if window is not None:
        classes.add(_SHORT_HEADER)
        hints.append(window)
    if not playable:
        hints.append(NO_PLAY_ADDRESS)
    drm = _DRM in classes
    if drm:
        access = "locked"
    elif _ENTITLED in classes:
        access = "unlocked"
    elif _SHORT_HEADER in classes or _VIEWER_LOCK in classes or not playable:
        access = "locked"
    elif _FREE in classes:
        access = "free"
    elif _PRICING in classes:
        # Sold: unlocked only for a real play URL this session got (a rendition without any URL
        # is no address) and no entitlement flag saying no.
        if not play_url_candidates(item):
            access = "locked"
            hints.append(NO_PLAY_ADDRESS)
        else:
            access = "locked" if _NOT_ENTITLED in classes else "unlocked"
    else:
        access = "free"
    paid = _PRICING in classes or _ENTITLED in classes
    return access, paid, drm, tuple(dict.fromkeys(hints))


def lock_hints(item: dict[str, Any]) -> tuple[str, ...]:
    """Every pricing, free, lock, entitlement and DRM clue of an item, deterministic order (the
    fourth element of :func:`access_of`): ``"key=value"``, ``"isFree=false"``, ``"plays 69 s of
    106 s"``, ``"no play address"``. Informational — ``Episode.access`` decides; an empty tuple
    means the payload says nothing about a price or a lock."""
    return access_of(item)[3]


def _short_header(item: dict[str, Any], video: Any) -> str | None:
    """The SHORT-HEADER hint of :func:`access_of`, or None when the rule does not fire: a
    ``music.duration`` (a number above 0, of the item's top-level ``music`` dict, whose
    ``original`` is truthy) at most :data:`SHORT_HEADER_RATIO` of ``video.duration`` (an
    integer above 0, read by ``_as_int``, so at most :data:`MAX_EXACT_INT`) and at least
    :data:`SHORT_HEADER_MIN_GAP_S` shorter. Never raises on junk."""
    if not isinstance(video, dict):
        return None
    video_duration = _as_int(video.get("duration"))
    if video_duration is None or video_duration <= 0:
        return None
    music = _field(item, "music")
    if not isinstance(music, dict) or not _truthy(music.get("original")):
        return None
    music_duration = _as_number(music.get("duration"))
    if music_duration is None or music_duration <= 0:
        return None
    if (
        music_duration > SHORT_HEADER_RATIO * video_duration
        or video_duration - music_duration < SHORT_HEADER_MIN_GAP_S
    ):
        return None
    # a whole float prints as its int (``69.0`` → ``69``): the extension cannot tell them apart
    shown: int | float = music_duration
    if isinstance(music_duration, float) and music_duration.is_integer():
        shown = int(music_duration)
    window = f"{_format_hint_value(shown)} s of {video_duration} s"
    return SHORT_HEADER_HINT_PREFIX + window


def _as_number(value: Any) -> int | float | None:
    """An int or a float as it is (never a bool, never NaN or an infinity); anything else None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value == value and value not in (float("inf"), float("-inf")):
        return value
    return None


def listed_sizes(item: dict[str, Any]) -> tuple[int, ...]:
    """The file sizes the payload lists for an item, sorted and de-duplicated: ``video.size`` and
    every ``video.bitrateInfo[].PlayAddr.DataSize`` that is a positive int (``_as_int``-style:
    an int that is not a bool, a whole float, a string of digits) of at most
    :data:`MAX_EXACT_INT`; anything else is ignored. Pure, never raises on junk. The engines
    compare a saved file's size against them (within 0.5 %) to tell a short-served file — the
    whole file, a short header — from an incomplete download. The item may be wrapped in
    ``{"itemStruct": {...}}``."""
    video = _field(item, "video") if isinstance(item, dict) else None
    if not isinstance(video, dict):
        return ()
    found: set[int] = set()
    size = _as_size(video.get("size"))
    if size is not None:
        found.add(size)
    bitrate_info = video.get("bitrateInfo")
    if isinstance(bitrate_info, list):
        for entry in bitrate_info:
            if not isinstance(entry, dict):
                continue
            play_addr = entry.get("PlayAddr")
            if isinstance(play_addr, dict):
                size = _as_size(play_addr.get("DataSize"))
                if size is not None:
                    found.add(size)
    return tuple(sorted(found))


def _as_size(value: Any) -> int | None:
    """A positive size as :func:`_as_int` reads it (an int, a whole float, a string of digits —
    the same reading as ``video.duration``'s, so at most :data:`MAX_EXACT_INT`); anything else,
    0 and negatives are None."""
    size = _as_int(value)
    return size if size is not None and size > 0 else None


def _top_level_scalars(item: dict[str, Any]) -> list[tuple[str, Any]]:
    """The item's own scalar ``(key, value)`` pairs, then those of an ``itemStruct`` wrapper whose
    key the item itself lacks (the outer key wins, as in :func:`_field`)."""
    pairs = [(key, value) for key, value in item.items() if not isinstance(value, dict | list)]
    inner = item.get("itemStruct")
    if isinstance(inner, dict):
        pairs.extend(
            (key, value)
            for key, value in inner.items()
            if key not in item and not isinstance(value, dict | list)
        )
    return [(str(key), value) for key, value in pairs]


def _collect_clues(node: Any, depth: int, clues: list[tuple[str, str]]) -> None:
    if depth > MAX_DEPTH:
        return
    if isinstance(node, dict):
        for key, value in node.items():
            if isinstance(value, dict | list):
                _collect_clues(value, depth + 1, clues)
            else:
                clues.extend(_clues(str(key), value))
    elif isinstance(node, list):
        for value in node:
            _collect_clues(value, depth + 1, clues)


def key_words(key: str) -> tuple[str, ...]:
    """The lower-case words of a payload key, in order: camelCase and PascalCase split at every
    capital, an acronym run kept whole (``DRMType`` -> ``drm``, ``type``; ``HDRBit`` -> ``hdr``,
    ``bit``), its plural too (``encryptedIDs`` -> ``encrypted``, ``ids``), ``snake_case`` and
    ``kebab-case`` at their separators, digits on their own (``drm2`` -> ``drm``, ``2``). Pure;
    anything that is not an ASCII letter or digit separates."""
    return tuple(word.lower() for word in _KEY_WORD_RE.findall(key))


def is_drm_key(key: str) -> bool:
    """Whether a payload key names DRM (the DRM class of :func:`access_of`, whose value must also
    be truthy): one of its :func:`key_words` is ``drm`` or starts with ``encrypt``, and none is a
    negation (``free``, ``no``, ``non``, ``not``, ``un``, ``without``) or an identifier (``id``,
    ``ids``, ``uid``, ``uids``). So ``isDrm``, ``drmType``, ``DRMType``, ``is_encrypted``,
    ``videoEncrypted``, ``encryption`` and ``encryptType`` are DRM keys; ``hdrMode``,
    ``HDRType``, ``isDrmFree``, ``drm_free``, ``no_drm``, ``nonEncrypted``, ``notEncrypted``,
    ``unencrypted``, ``unEncrypted``, ``encryptedUid``, ``encryptedUIDs`` and ``encrypted_id``
    are not. Whole words, not letters: a DRM clue locks the episode whatever else the payload
    says, and it only saves a download that would be refused anyway (the media check,
    ``media.drm_problem``, is the real guard), so precision beats recall."""
    words = key_words(key)
    if not _names_drm(words):
        return False
    return not any(word in _DRM_NEGATION_WORDS or word in _DRM_ID_WORDS for word in words)


def _names_drm(words: tuple[str, ...]) -> bool:
    """Whether one of a key's words is ``drm`` or starts with ``encrypt`` (negated or not)."""
    return any(word == "drm" or word.startswith("encrypt") for word in words)


def _is_free_key(key: str) -> bool:
    """Whether a key is a ``free`` flag about the episode's price (the FREE / ``isFree=false``
    clues of :func:`access_of`): it contains ``free``, and none of its :func:`key_words` is
    ``intro`` (``IsFreeIntro``: the free intro teaser flag) or names DRM (``isDrmFree``: a DRM
    negation)."""
    if _FREE_KEY_RE.search(key) is None:
        return False
    words = key_words(key)
    return _INTRO_WORD not in words and not _names_drm(words)


def _without_block_words(key: str) -> str:
    """``key`` with each of its :func:`key_words` that contains ``block`` turned into ``_``: what
    :data:`_LOCK_STATUS_KEY_RE` and the old heuristic's leftovers (:data:`_LOCK_KEY_RE`) are
    matched against, because "block" is not "lock" — ``blockStatus``, ``isBlocked``,
    ``BLOCK_STATUS`` and ``unblockStatus`` give no clue at all — while a word that merely ends in
    ``b`` (``subLockStatus``, ``webLock``, ``DBLock``) and a lock word next to a block word
    (``blockLockStatus``) still count, as they did before."""
    return _KEY_WORD_RE.sub(
        lambda word: "_" if "block" in word.group().lower() else word.group(), key
    )


def _clues(key: str, value: Any) -> list[tuple[str, str]]:
    """The ``(class, hint)`` clues one scalar ``key: value`` gives (the table of
    :func:`access_of`); empty for a value that is not a bool, a number or a string."""
    if not isinstance(value, bool | int | float | str):
        return []
    hint = f"{key}={_format_hint_value(value)}"
    truthy = _truthy(value)
    entitled_key = _ENTITLED_KEY_RE.fullmatch(key) is not None
    status_key = _STATUS_KEY_RE.search(key) is not None
    lock_key = _without_block_words(key)  # "block" is not "lock"
    lock_status_key = _LOCK_STATUS_KEY_RE.search(lock_key) is not None
    # a lockStatus string that spells a number or a bool ("1", "true") is that number or bool
    is_text = isinstance(value, str) and not (
        lock_status_key and _NUMBER_OR_BOOL_TEXT_RE.fullmatch(value.strip()) is not None
    )
    # a status STRING decides through the two value sets, for lockStatus as for unlockStatus
    status = (
        value.strip().lower()
        if (status_key or lock_status_key) and isinstance(value, str)
        else None
    )
    found: list[tuple[str, str]] = []
    if truthy and is_drm_key(key):
        found.append((_DRM, hint))
    if (truthy and entitled_key) or status in _ENTITLED_STATUS_VALUES:
        found.append((_ENTITLED, hint))
    elif entitled_key:  # falsy: the payload says the account has NOT unlocked it
        found.append((_NOT_ENTITLED, hint))
    viewer_lock_key = (
        _LOCKED_KEY_RE.fullmatch(key) is not None
        or _VIEWER_LOCK_KEY_RE.search(key) is not None
        or (lock_status_key and not is_text)  # a bool or a number (or one spelled): truthy locks
    )
    if (truthy and viewer_lock_key) or status in _LOCKED_STATUS_VALUES:
        found.append((_VIEWER_LOCK, hint))
    if status_key and not is_text:
        found.append((_AMBIGUOUS, hint))
    elif lock_status_key and is_text and truthy and status not in _KNOWN_STATUS_VALUES:
        found.append((_AMBIGUOUS, hint))  # a lockStatus string neither set knows: a hint only
    sold = (
        (_PRICE_KEY_RE.search(key) is not None and _positive(value))
        or (truthy and not entitled_key and _SOLD_KEY_RE.search(key) is not None)
        # the old heuristic's leftovers, for a key no class above turned into a clue
        or (truthy and not found and _LOCK_KEY_RE.search(lock_key) is not None)
    )
    # a `free` key about the price: falsy a price (isFree=false), truthy FREE
    free_key = _is_free_key(key)
    if free_key and not truthy:
        found.append((_PRICING, "isFree=false"))
    elif free_key:
        found.append((_FREE, hint))
    elif sold:
        found.append((_PRICING, hint))
    return found


def _positive(value: Any) -> bool:
    """A price that means "sold": a number above 0, ``true``, or a truthy string."""
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        return value > 0
    return _truthy(value)


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() not in _FALSY_STRINGS
    return bool(value)


def _format_hint_value(value: Any) -> str:
    try:
        text = value.strip() if isinstance(value, str) else str(value)
    except ValueError:  # an int with more digits than str() converts (Python's safety limit)
        text = "…"
    if len(text) > _MAX_HINT_VALUE_LEN:
        return text[: _MAX_HINT_VALUE_LEN - 1] + "…"
    return text


def _has_play_address(video: dict[str, Any]) -> bool:
    play_addr = video.get("playAddr")
    if isinstance(play_addr, str) and play_addr.strip():
        return True
    bitrate_info = video.get("bitrateInfo")
    return isinstance(bitrate_info, list) and len(bitrate_info) > 0


def episode_from_item(item: dict[str, Any], series_id: str) -> Episode | None:
    """Turn one ``itemList`` entry into an Episode, or None when it must be skipped.

    Skipped: no item id; no (or invalid) ``dramaInfo.DramaVideoData.EpisodeNumber`` — trailers and
    teasers; a ``dramaInfo`` series id (``dramaID``/``dramaId``/``DramaID``/``albumId``) that
    differs from ``series_id``. The item may be wrapped in ``{"itemStruct": {...}}``.
    ``cover_url`` is the first http(s) URL among ``video.originCover``, ``video.cover`` and
    ``video.dynamicCover`` (see :func:`cover_url_of`), None when the item has none.
    ``quality_hint`` is the label of the rendition the default quality mode takes
    (:func:`choose_rendition` with ``"compatible"``, e.g. ``"720p h264"``), None without one.
    ``access`` / ``paid`` / ``drm`` / ``lock_hints`` come from :func:`access_of`, always passed
    explicitly (``Episode`` derives ``access`` from ``lock_hints`` only for other callers).
    """
    item_id = _as_id(_field(item, "id"))
    if item_id is None:
        return None
    drama_info_raw = _field(item, "dramaInfo")
    drama_info: dict[str, Any] = drama_info_raw if isinstance(drama_info_raw, dict) else {}
    found_series_id = _series_id_of(drama_info)
    if found_series_id is not None and found_series_id != str(series_id):
        return None
    number = _episode_number(drama_info)
    if number is None:
        return None

    series_name = _clean_str(drama_info.get("dramaName"))
    desc = _clean_str(_field(item, "desc"))
    if desc:
        title = desc
    elif series_name:
        title = f"{series_name} E{number}"
    else:
        title = f"Episode {number}"

    author_raw = _field(item, "author")
    author = _clean_str(author_raw.get("uniqueId")) if isinstance(author_raw, dict) else None
    video = _field(item, "video")
    duration = _as_int(video.get("duration")) if isinstance(video, dict) else None
    if duration is not None and duration < 0:
        duration = None
    access, paid, drm, hints = access_of(item)

    return Episode(
        number=number,
        item_id=item_id,
        title=title,
        series_id=str(series_id),
        series_name=series_name,
        author=author,
        duration_s=duration,
        lock_hints=hints,
        cover_url=cover_url_of(item),
        quality_hint=chosen.label if (chosen := choose_rendition(item)) is not None else None,
        access=access,
        paid=paid,
        drm=drm,
        raw=item,
    )


def cover_url_of(item: dict[str, Any]) -> str | None:
    """The episode cover of an item: the first http(s) URL found under ``video.originCover``,
    ``video.cover`` or ``video.dynamicCover``, in that order (each a string, a list of strings or
    a dict with a ``UrlList``, like a play address); None when there is none. Never raises on
    junk. The item may be wrapped in ``{"itemStruct": {...}}``."""
    video = _field(item, "video") if isinstance(item, dict) else None
    if not isinstance(video, dict):
        return None
    for key in _COVER_KEYS:
        urls = _play_urls(video.get(key), 0)
        if urls:
            return urls[0]
    return None


def _field(item: dict[str, Any], key: str) -> Any:
    """``item[key]``, falling back to ``item["itemStruct"][key]`` for wrapped items."""
    if key in item:
        return item[key]
    inner = item.get("itemStruct")
    if isinstance(inner, dict):
        return inner.get(key)
    return None


def _as_id(value: Any) -> str | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        try:
            return str(value)
        except ValueError:  # more digits than str() converts: no id of TikTok's
            return None
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _as_int(value: Any) -> int | None:
    """An int that is not a bool, a whole float, or a string of decimal digits (optionally
    negative) — within ±:data:`MAX_EXACT_INT`, what the extension's ``Number`` holds exactly;
    anything else, a longer number included, is None."""
    found: int | None = None
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        found = value
    elif isinstance(value, float) and value.is_integer():
        found = int(value)
    elif isinstance(value, str) and value.strip().lstrip("-").isdigit():
        try:
            found = int(value.strip())
        except ValueError:  # "²" is a digit to isdigit(), not to int(); or too many digits
            return None
    if found is None or abs(found) > MAX_EXACT_INT:
        return None
    return found


def _clean_str(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _series_id_of(drama_info: dict[str, Any]) -> str | None:
    for key in _SERIES_ID_KEYS:
        if key in drama_info:
            found = _as_id(drama_info[key])
            if found is not None:
                return found
    return None


def _episode_number(drama_info: dict[str, Any]) -> int | None:
    video_data = drama_info.get("DramaVideoData")
    containers = [video_data] if isinstance(video_data, dict) else []
    containers.append(drama_info)
    for container in containers:
        for key in _EPISODE_NUMBER_KEYS:
            if key in container:
                number = _as_int(container[key])
                return number if number is not None and number >= 1 else None
    return None


def parse_item_list_payload(payload: Any, series_id: str) -> PagePayload:
    """Parse one ``item_list`` page: episodes of the series, pagination cursor and ``hasMore``.

    ``cursor`` is read from the top level first, else the first one found recursively (items
    themselves are not searched). ``has_more`` is True only for ``hasMore``/``has_more`` being
    ``true`` (also ``1``/``"true"``).
    """
    episodes: list[Episode] = []
    seen = 0
    skipped = 0
    for items in find_item_lists(payload):
        for item in items:
            seen += 1
            episode = episode_from_item(item, series_id)
            if episode is None:
                skipped += 1
            else:
                episodes.append(episode)
    cursor = _as_cursor(_first_value(payload, ("cursor",)))
    has_more = _as_flag(_first_value(payload, ("hasMore", "has_more")))
    return PagePayload(
        episodes=episodes, cursor=cursor, has_more=has_more, seen_items=seen, skipped_items=skipped
    )


def _first_value(payload: Any, keys: tuple[str, ...]) -> Any:
    """The value of the first of ``keys`` at the top level, else the first found recursively."""
    if isinstance(payload, dict):
        for key in keys:
            if key in payload:
                return payload[key]
    return _search_value(payload, keys, 0)


def _search_value(node: Any, keys: tuple[str, ...], depth: int) -> Any:
    if depth > MAX_DEPTH:
        return None
    if isinstance(node, dict):
        for key in keys:
            if key in node:
                return node[key]
        for key, value in node.items():
            if key in _ITEM_LIST_KEYS:
                continue
            found = _search_value(value, keys, depth + 1)
            if found is not None:
                return found
    elif isinstance(node, list):
        for value in node:
            found = _search_value(value, keys, depth + 1)
            if found is not None:
                return found
    return None


def _as_cursor(value: Any) -> int | str | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _as_flag(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value == 1
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1"}
    return False


def merge_episodes(pages: Iterable[Iterable[Episode]]) -> list[Episode]:
    """Combine pages: dedupe by item id, then by number (first seen wins); sort by number."""
    by_item: dict[str, Episode] = {}
    for page in pages:
        for episode in page:
            by_item.setdefault(episode.item_id, episode)
    by_number: dict[int, Episode] = {}
    for episode in by_item.values():
        by_number.setdefault(episode.number, episode)
    return sorted(by_number.values(), key=lambda episode: episode.number)


def catalog_warnings(episodes: list[Episode], total_hint: int | None) -> list[str]:
    """Human-readable oddities: gaps, duplicate numbers, announced-vs-listed total, locked count."""
    warnings: list[str] = []
    numbers = sorted({episode.number for episode in episodes})
    expected = 1
    for number in numbers:
        if number > expected:
            warnings.append(_gap_text(expected, number - 1))
        expected = number + 1
    counts = Counter(episode.number for episode in episodes)
    warnings.extend(
        f"duplicate episode number {number}"
        for number, count in sorted(counts.items())
        if count > 1
    )
    if total_hint is not None and total_hint > 0 and len(numbers) != total_hint:
        warnings.append(f"TikTok announces {total_hint} episodes, {len(numbers)} listed")
    locked = sum(1 for episode in episodes if episode.locked)
    if locked == 1:
        warnings.append("1 episode looks locked")
    elif locked > 1:
        warnings.append(f"{locked} episodes look locked")
    return warnings


def _gap_text(low: int, high: int) -> str:
    if low == high:
        return f"episode {low} missing (gap)"
    return f"episodes {low}-{high} missing (gap)"


def parse_detail_payload(payload: Any) -> tuple[str | None, int | None]:
    """Best-effort ``(series name, announced total)`` from a ``/api/drama/detail/`` payload.

    Looks inside ``dramaInfo``/``drama``/``detail`` objects first (recursively), then at the top
    level: the name is the first string under ``dramaName``, ``title`` or ``name``; the total is
    the first positive integer under ``totalEpisode``, ``totalEpisodes``, ``episodeCount``,
    ``total`` or ``episodeTotal``.
    """
    name: str | None = None
    total: int | None = None
    for container in _detail_containers(payload):
        if name is None:
            name = _first_str(container, _NAME_KEYS)
        if total is None:
            total = _first_positive_int(container, _TOTAL_KEYS)
        if name is not None and total is not None:
            break
    return name, total


def _detail_containers(payload: Any) -> list[dict[str, Any]]:
    containers: list[dict[str, Any]] = []
    _walk_detail_containers(payload, 0, containers)
    if isinstance(payload, dict):
        containers.append(payload)
    return containers


def _walk_detail_containers(node: Any, depth: int, containers: list[dict[str, Any]]) -> None:
    if depth > MAX_DEPTH:
        return
    if isinstance(node, dict):
        for key, value in node.items():
            if key in _DETAIL_CONTAINER_KEYS and isinstance(value, dict):
                containers.append(value)
            _walk_detail_containers(value, depth + 1, containers)
    elif isinstance(node, list):
        for value in node:
            _walk_detail_containers(value, depth + 1, containers)


def _first_str(container: dict[str, Any], keys: tuple[str, ...]) -> str | None:
    for key in keys:
        found = _clean_str(container.get(key))
        if found is not None:
            return found
    return None


def _first_positive_int(container: dict[str, Any], keys: tuple[str, ...]) -> int | None:
    for key in keys:
        found = _as_int(container.get(key))
        if found is not None and found > 0:
            return found
    return None


# ---------------------------------------------------------------------- renditions & play URLs

_H264_CODEC_RE = re.compile(r"h\.?264|avc", re.IGNORECASE)
_H265_CODEC_RE = re.compile(r"h\.?265|hevc|hvc1|hev1", re.IGNORECASE)
_URL_LIST_KEYS = ("UrlList", "urlList", "url_list")
_MAX_URL_LIST_DEPTH = 3
#: The path TikTok's video-only HEVC streams end with. Those renditions carry no audio track —
#: yt-dlp marks every such format ``acodec: none`` (yt-dlp/yt-dlp#16622, #17372) and its ``best``
#: never takes one — so DramaFetch never requests them either, whatever ``--quality`` says: the
#: saved file could only be quarantined as ``no audio track``, three of them a stop.
VIDEO_ONLY_PATH_SUFFIX = "/media-video-hvc1/"
#: The height inside a ``GearName`` such as ``normal_720_0`` or ``adapt_lower_1080_1``: the only
#: run of three or four digits (the trailing ``_0``/``_1`` is one digit).
_GEAR_HEIGHT_RE = re.compile(r"(?<!\d)(\d{3,4})(?!\d)")
#: ``video.ratio`` such as ``720p`` (or a bare ``720``).
_RATIO_RE = re.compile(r"^\s*(\d{3,4})p?\s*$", re.IGNORECASE)
#: Codec of a rendition whose ``CodecType`` is missing.
UNKNOWN_CODEC = "unknown"
#: Height part of a label when neither the ``GearName`` nor ``video.ratio`` tells it.
UNKNOWN_HEIGHT = "?p"


@dataclass(frozen=True)
class Rendition:
    """One ``video.bitrateInfo`` entry: the play URLs of one encoding of the episode.

    ``codec`` is normalised to ``h264``, ``h265`` or ``bytevc1`` (TikTok's own name for its H.265
    streams), else the lower-cased raw ``CodecType`` (``unknown`` when absent); ``bitrate`` is
    bit/s (0 when absent); ``height_hint`` comes from the ``GearName``, else ``video.ratio``;
    ``label`` is what ``info`` shows — ``720p h264``, ``?p h264`` without a height.
    """

    url_list: list[str]
    codec: str
    bitrate: int
    height_hint: int | None
    label: str

    @property
    def h264(self) -> bool:
        return self.codec == "h264"


def codec_name(raw: Any) -> str:
    """``h264`` for H.264/AVC spellings, ``h265`` for H.265/HEVC ones, ``bytevc1`` for TikTok's,
    else the lower-cased raw string; :data:`UNKNOWN_CODEC` for anything that is not a string."""
    if not isinstance(raw, str) or not raw.strip():
        return UNKNOWN_CODEC
    text = raw.strip()
    if _H264_CODEC_RE.search(text):
        return "h264"
    if _H265_CODEC_RE.search(text):
        return "h265"
    if text.lower().startswith("bytevc1"):
        return "bytevc1"
    return text.lower()


def renditions(item: dict[str, Any]) -> list[Rendition]:
    """Every ``video.bitrateInfo`` entry with at least one http(s) play URL, in payload order;
    never raises on junk. A bare ``video.playAddr`` is not a rendition: its codec and bitrate are
    unknown (:func:`play_url_candidates` still appends it last). The item may be wrapped in
    ``{"itemStruct": {...}}``. A URL of a video-only HEVC stream (:func:`is_video_only_url`) is
    left out, and an entry with no other URL is no rendition."""
    video = _field(item, "video") if isinstance(item, dict) else None
    if not isinstance(video, dict):
        return []
    bitrate_info = video.get("bitrateInfo")
    if not isinstance(bitrate_info, list):
        return []
    ratio_height = _ratio_height(video.get("ratio"))
    found: list[Rendition] = []
    for entry in bitrate_info:
        if not isinstance(entry, dict):
            continue
        urls = [url for url in _play_urls(entry.get("PlayAddr"), 0) if not is_video_only_url(url)]
        if not urls:
            continue
        codec = codec_name(entry.get("CodecType"))
        height = _gear_height(entry.get("GearName"))
        if height is None:
            height = ratio_height
        label = f"{height}p {codec}" if height is not None else f"{UNKNOWN_HEIGHT} {codec}"
        found.append(Rendition(urls, codec, _as_int(entry.get("Bitrate")) or 0, height, label))
    return found


def ordered_renditions(item: dict[str, Any], quality: str = "compatible") -> list[Rendition]:
    """The renditions of an item in the order ``quality`` would try them: ``compatible`` the
    H.264 ones by bitrate descending, then the other codecs the same way; ``best`` all of them by
    bitrate descending whatever the codec. Ties keep payload order. ValueError for a quality that
    is not one of ``models.QUALITY_MODES``."""
    if quality not in QUALITY_MODES:
        raise ValueError(f"unknown quality {quality!r}: expected one of {', '.join(QUALITY_MODES)}")
    by_bitrate = sorted(renditions(item), key=lambda rendition: -rendition.bitrate)
    if quality == "best":
        return by_bitrate
    h264 = [rendition for rendition in by_bitrate if rendition.h264]
    others = [rendition for rendition in by_bitrate if not rendition.h264]
    return h264 + others


def choose_rendition(item: dict[str, Any], quality: str = "compatible") -> Rendition | None:
    """The rendition ``quality`` downloads: ``compatible`` the highest-bitrate H.264 — it plays
    everywhere — falling back to the highest bitrate of any codec when the item lists no H.264;
    ``best`` the highest bitrate whatever the codec. None when the item lists no renditions."""
    ordered = ordered_renditions(item, quality)
    return ordered[0] if ordered else None


def play_url_candidates(item: dict[str, Any], quality: str = "compatible") -> list[str]:
    """Direct play URLs of an item, best first and de-duplicated; never raises on junk.

    Order: the renditions as :func:`ordered_renditions` puts them for ``quality`` — ``compatible``
    (the default): the H.264/AVC entries by ``Bitrate`` descending, then the other codecs the same
    way; ``best``: every entry by bitrate descending across codecs — every URL of their
    ``PlayAddr.UrlList``; then ``video.playAddr`` (a string, or a dict with a ``UrlList``) in both
    modes. Only ``http(s)`` strings are kept, and a URL listed twice appears once, at its first
    position. The item may be wrapped in ``{"itemStruct": {...}}``. This is what the browser
    download engine fetches.
    """
    video = _field(item, "video") if isinstance(item, dict) else None
    if not isinstance(video, dict):
        return []
    ordered: list[str] = []
    for rendition in ordered_renditions(item, quality):
        ordered.extend(rendition.url_list)
    ordered.extend(
        url for url in _play_urls(video.get("playAddr"), 0) if not is_video_only_url(url)
    )
    return list(dict.fromkeys(ordered))


def _gear_height(value: Any) -> int | None:
    if not isinstance(value, str):
        return None
    match = _GEAR_HEIGHT_RE.search(value)
    return int(match.group(1)) if match else None


def _ratio_height(value: Any) -> int | None:
    if not isinstance(value, str):
        return None
    match = _RATIO_RE.match(value)
    return int(match.group(1)) if match else None


def _play_urls(value: Any, depth: int) -> list[str]:
    """The http(s) URLs of a play address: a string, a list of them or a dict with ``UrlList``."""
    if depth > _MAX_URL_LIST_DEPTH:
        return []
    if isinstance(value, dict):
        for key in _URL_LIST_KEYS:
            if key in value:
                return _play_urls(value[key], depth + 1)
        return []
    if isinstance(value, list):
        return [url for entry in value for url in _play_urls(entry, depth + 1)]
    if isinstance(value, str):
        url = value.strip()
        return [url] if url.lower().startswith(("http://", "https://")) else []
    return []


def is_video_only_url(url: str) -> bool:
    """True for a play URL whose path ends with :data:`VIDEO_ONLY_PATH_SUFFIX`: one of TikTok's
    HEVC streams without an audio track, never a candidate. The path is the URL up to its first
    ``?`` or ``#`` (what yt-dlp's ``urlparse(url).path.endswith`` sees for these URLs)."""
    path = url.split("#", 1)[0].split("?", 1)[0]
    return path.endswith(VIDEO_ONLY_PATH_SUFFIX)


def url_expiry(url: str) -> int | None:
    """The integer ``expire`` query parameter of a signed CDN URL (seconds since the epoch; TikTok's
    play URLs carry one), or None when it is absent or not a whole number."""
    if not isinstance(url, str):
        return None
    try:
        values = parse_qs(urlsplit(url).query, keep_blank_values=True).get("expire")
    except ValueError:
        return None
    if not values:
        return None
    text = values[0].strip()
    if not text.lstrip("-").isdigit():
        return None
    try:
        return int(text)
    except ValueError:  # more digits than int() accepts
        return None
