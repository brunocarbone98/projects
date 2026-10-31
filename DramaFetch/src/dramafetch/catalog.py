"""Pure parsing and validation of TikTok's short-drama payloads. No I/O, no network.

TikTok facts this module encodes (verified October 2026):

- The web app lists a series through
  ``GET /api/drama/episode/item_list/?dramaID=<series_id>&cursor=<c>&count=<n>&...`` and answers
  ``{"itemList": [...], "cursor": 30, "hasMore": true}``. The list is sometimes nested under
  another key, so :func:`find_item_lists` searches recursively.
- Each item is an ordinary TikTok video object (``id``, ``desc``, ``author``, ``video``) plus a
  ``dramaInfo`` block. ``dramaInfo.DramaVideoData.EpisodeNumber`` is the 1-based episode number
  and the only reliable order: series are published in batches, so ``createTime`` is a shuffle.
  Items without a number (trailers) are skipped; items whose ``dramaInfo.dramaID`` names another
  series are dropped.
- TikTok sells later episodes for coins. The field that marks a locked episode is undocumented, so
  :func:`lock_hints` applies key-name heuristics (``isLocked``, ``unlockPrice``, ``isFree=false``)
  and treats an item without any play address as locked too. Locked episodes are listed and
  skipped; nothing here unlocks, buys or bypasses anything.
- ``GET /api/drama/detail/`` carries the series name and announced total; its exact shape is
  unknown, so :func:`parse_detail_payload` is best-effort.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from dramafetch.models import Episode

#: How deep the recursive searches descend into a payload before giving up.
MAX_DEPTH = 12

_ITEM_LIST_KEYS = ("itemList", "item_list")
_LOCK_KEY_RE = re.compile(r"lock|paid|needpay|unlock|price|coin|vip|preview", re.IGNORECASE)
_FREE_KEY_RE = re.compile(r"free", re.IGNORECASE)
_SERIES_ID_KEYS = ("dramaID", "dramaId", "DramaID", "albumId")
_EPISODE_NUMBER_KEYS = ("EpisodeNumber", "episodeNumber", "episode_number")
_NAME_KEYS = ("dramaName", "title", "name")
_TOTAL_KEYS = ("totalEpisode", "totalEpisodes", "episodeCount", "total", "episodeTotal")
_DETAIL_CONTAINER_KEYS = ("dramaInfo", "drama", "detail")
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


def lock_hints(item: dict[str, Any]) -> tuple[str, ...]:
    """Heuristic reasons to believe an item is locked, paid or unplayable (deterministic order).

    ``item["dramaInfo"]`` is scanned recursively and ``item["video"]`` at its top level: a key
    matching ``lock|paid|needpay|unlock|price|coin|vip|preview`` with a truthy scalar value gives
    ``"key=value"``; a key matching ``free`` with a falsy scalar value gives ``"isFree=false"``; a
    missing or empty ``video.playAddr`` together with an empty ``video.bitrateInfo`` gives
    ``"no play address"``. An empty tuple means nothing in the payload says "locked".
    """
    hints: list[str] = []
    drama_info = _field(item, "dramaInfo")
    if isinstance(drama_info, dict):
        _collect_lock_hints(drama_info, 0, hints)
    video = _field(item, "video")
    if isinstance(video, dict):
        for key, value in video.items():
            _hint_for(str(key), value, hints)
        if not _has_play_address(video):
            hints.append("no play address")
    else:
        hints.append("no play address")
    return tuple(dict.fromkeys(hints))


def _collect_lock_hints(node: Any, depth: int, hints: list[str]) -> None:
    if depth > MAX_DEPTH:
        return
    if isinstance(node, dict):
        for key, value in node.items():
            if isinstance(value, dict | list):
                _collect_lock_hints(value, depth + 1, hints)
            else:
                _hint_for(str(key), value, hints)
    elif isinstance(node, list):
        for value in node:
            _collect_lock_hints(value, depth + 1, hints)


def _hint_for(key: str, value: Any, hints: list[str]) -> None:
    if value is None or not isinstance(value, bool | int | float | str):
        return
    if _LOCK_KEY_RE.search(key) and _truthy(value):
        hints.append(f"{key}={_format_hint_value(value)}")
    elif _FREE_KEY_RE.search(key) and not _truthy(value):
        hints.append("isFree=false")


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() not in _FALSY_STRINGS
    return bool(value)


def _format_hint_value(value: Any) -> str:
    text = str(value).strip() if isinstance(value, str) else str(value)
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

    return Episode(
        number=number,
        item_id=item_id,
        title=title,
        series_id=str(series_id),
        series_name=series_name,
        author=author,
        duration_s=duration,
        lock_hints=lock_hints(item),
        raw=item,
    )


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
        return str(value)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _as_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip().lstrip("-").isdigit():
        return int(value.strip())
    return None


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
    """Combine pages: dedupe by item id, then by episode number (first seen wins), sort by number."""
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
