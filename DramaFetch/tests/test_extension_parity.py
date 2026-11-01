"""Parity of the Chrome extension's pure modules (``extension/src/lib``) with the Python functions
they port.

``extension/tests/parity_runner.js`` runs the extension's functions on JSON input; every test here
gives it the same inputs it gives the Python functions and compares the answers one by one: the
shared constants and texts, ``access_of`` on every fixture item and on a seeded fuzz corpus of
generated items that covers every clue class, ``key_words`` / ``is_drm_key`` (the DRM key "must"
and "must not" lists), ``parse_item_list_payload`` on every fixture page, the renditions, play URLs
and ``url_expiry``, ``parse_input``, the naming functions, ``series_report`` / ``report_line`` over
a table of reports (the complete-skip line with ``RECHECK_HINT`` and the paid line included),
``dedupe_refs``, the cooldown texts, the pacing decisions and the manifest's semantics.

JavaScript cannot tell ``1`` from ``1.0`` and holds integers exactly up to 2**53 only, and it
enumerates integer-like keys (``"1"``) first: the corpora use integers in that range, fractional
floats and no integer-like keys; everything else is compared exactly. Nothing here sleeps or
touches the network. The tests are skipped, with the reason, only when ``node`` is not installed.
"""

from __future__ import annotations

import json
import random
import shutil
import subprocess
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from dramafetch import catalog, cli, cooldown, engine, manifest, models, urls
from dramafetch.catalog import Rendition
from dramafetch.downloader import BLOCKED_MESSAGE, PAYLOAD_DRM_MESSAGE, locked_result
from dramafetch.downloader_browser import RATE_LIMIT_MESSAGE as MEDIA_RATE_LIMIT_MESSAGE
from dramafetch.downloader_browser import UNAVAILABLE_MESSAGE
from dramafetch.errors import UnsupportedUrlError
from dramafetch.media import INCOMPLETE_PREFIX
from dramafetch.models import (
    DownloadOptions,
    DownloadResult,
    DownloadStatus,
    Episode,
    Series,
    SeriesRef,
)

EXTENSION = Path(__file__).resolve().parent.parent / "extension"
RUNNER = EXTENSION / "tests" / "parity_runner.js"
FIXTURES = Path(__file__).parent / "fixtures"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(
    NODE is None,
    reason="node is not installed: the Chrome extension's parity with the Python functions "
    "cannot be checked without Node.js 22 (https://nodejs.org)",
)

SERIES_ID = "7699393770256782354"
SECOND_SERIES_ID = "7699393770256782399"
PAID_SERIES_ID = "7699393770256782388"
FIXTURE_PAGES = (
    ("item_list_page1.json", SERIES_ID),
    ("item_list_page2.json", SERIES_ID),
    ("item_list_series2.json", SECOND_SERIES_ID),
    ("item_list_series3_logged_in.json", PAID_SERIES_ID),
    ("item_list_series3_logged_out.json", PAID_SERIES_ID),
)
#: How many generated items the access fuzz corpus holds (the spec asks for at least 2,000).
FUZZ_ITEMS = 3000
FUZZ_SEED = 20261101


# --------------------------------------------------------------------------- the runner


def run_js(calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Every call through one ``node parity_runner.js`` process; the raw ``{ok, value | error}``."""
    assert NODE is not None
    completed = subprocess.run(
        [NODE, str(RUNNER)],
        input=json.dumps(calls),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=600,
        check=False,
        cwd=EXTENSION,
    )
    assert completed.returncode == 0, completed.stderr[-3000:]
    results: list[dict[str, Any]] = json.loads(completed.stdout)
    assert len(results) == len(calls)
    return results


def js_values(calls: list[dict[str, Any]]) -> list[Any]:
    """The values of calls that must all succeed."""
    results = run_js(calls)
    failed = [
        (call["fn"], result)
        for call, result in zip(calls, results, strict=True)
        if not result["ok"]
    ]
    assert not failed, f"{len(failed)} calls failed, first: {failed[:3]!r}"
    return [result["value"] for result in results]


def call(fn: str, *args: Any, omit: tuple[str, ...] = ()) -> dict[str, Any]:
    entry: dict[str, Any] = {"fn": fn, "args": list(args)}
    if omit:
        entry["omit"] = list(omit)
    return entry


def assert_same(rows: list[tuple[Any, Any, Any]]) -> None:
    """``(input, python, javascript)`` rows: fail on the first differences, naming the inputs."""
    differ = [row for row in rows if row[1] != row[2]]
    assert not differ, f"{len(differ)} of {len(rows)} differ; first: {differ[:3]!r}"


def outcome(fn: Any, *args: Any) -> tuple[str, Any]:
    """``("ok", value)`` or ``("error", message)`` of a Python call (ValueError-style refusals)."""
    try:
        return "ok", fn(*args)
    except (ValueError, UnsupportedUrlError) as exc:
        return "error", str(exc)


def js_outcome(result: dict[str, Any]) -> tuple[str, Any]:
    return ("ok", result["value"]) if result["ok"] else ("error", result["error"])


# --------------------------------------------------------------------------- Python -> JS shapes


def js_episode(episode: Episode) -> dict[str, Any]:
    return {
        "number": episode.number,
        "itemId": episode.item_id,
        "title": episode.title,
        "seriesId": episode.series_id,
        "seriesName": episode.series_name,
        "author": episode.author,
        "durationS": episode.duration_s,
        "lockHints": list(episode.lock_hints),
        "coverUrl": episode.cover_url,
        "qualityHint": episode.quality_hint,
        "access": episode.access,
        "paid": episode.paid,
        "drm": episode.drm,
    }


def js_episode_in(episode: Episode) -> dict[str, Any]:
    """An episode as an argument (``raw`` is not compared, so it is not sent)."""
    return {**js_episode(episode), "raw": None}


def js_rendition(rendition: Rendition) -> dict[str, Any]:
    return {
        "urlList": list(rendition.url_list),
        "codec": rendition.codec,
        "bitrate": rendition.bitrate,
        "heightHint": rendition.height_hint,
        "label": rendition.label,
    }


def js_series(series: Series) -> dict[str, Any]:
    return {
        "seriesId": series.series_id,
        "name": series.name,
        "episodes": [js_episode_in(episode) for episode in series.episodes],
        "totalHint": series.total_hint,
        "warnings": list(series.warnings),
    }


def js_result(result: DownloadResult) -> dict[str, Any]:
    return {
        "episode": js_episode_in(result.episode),
        "status": result.status.value,
        "path": str(result.path) if result.path is not None else None,
        "message": result.message,
    }


def js_report(report: engine.SeriesReport) -> dict[str, Any]:
    return {
        "seriesId": report.series_id,
        "name": report.name,
        "listed": report.listed,
        "done": report.done,
        "onDisk": report.on_disk,
        "locked": report.locked,
        "failed": report.failed,
        "gaps": list(report.gaps),
        "complete": report.complete,
        "skippedComplete": report.skipped_complete,
        "stopped": report.stopped,
        "total": report.total,
        "lockedNumbers": list(report.locked_numbers),
        "failedNumbers": list(report.failed_numbers),
        "totalHint": report.total_hint,
        "checkedAgoS": report.checked_ago_s,
        "unlocked": report.unlocked,
        "unlockedNumbers": list(report.unlocked_numbers),
    }


def js_pacing_options(options: DownloadOptions) -> dict[str, Any]:
    return {
        "delayMinS": options.delay_min_s,
        "delayMaxS": options.delay_max_s,
        "pace": options.pace,
        "restEvery": options.rest_every,
        "restMinS": options.rest_min_s,
        "restMaxS": options.rest_max_s,
        "maxConsecutiveFailures": options.max_consecutive_failures,
        "longRestEvery": options.long_rest_every,
        "longRestMinS": options.long_rest_min_s,
        "longRestMaxS": options.long_rest_max_s,
    }


def js_pacing(pacing: engine.PacingState) -> dict[str, Any]:
    return {
        "runAttempts": pacing.run_attempts,
        "lastNetworkAt": pacing.last_network_at,
        "consecutiveFailures": pacing.consecutive_failures,
    }


def load_fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def fixture_items() -> list[dict[str, Any]]:
    """Every item of every fixture page, as served and wrapped in ``itemStruct``."""
    items: list[dict[str, Any]] = []
    for name, _ in FIXTURE_PAGES:
        for found in catalog.find_item_lists(load_fixture(name)):
            items.extend(found)
    return [*items, *({"itemStruct": item} for item in items)]


# --------------------------------------------------------------------------- the fuzz corpus

#: Keys of every clue class (DRM, entitled, not entitled, viewer lock, status, pricing), their
#: spelling variants, the "block is not lock" family, Unicode keys Python's re.IGNORECASE matches
#: to an ASCII letter (dotless i, long s, the Kelvin sign, I with a dot) and plain noise.
FUZZ_KEYS = (
    # DRM and the keys that must not be DRM
    "isDrm",
    "drm",
    "drmType",
    "DRMType",
    "is_encrypted",
    "encrypted",
    "videoEncrypted",
    "encryption",
    "encryptType",
    "drm2Type",
    "isDrmFree",
    "drm_free",
    "no_drm",
    "nonEncrypted",
    "notEncrypted",
    "unencrypted",
    "unEncrypted",
    "encryptedUid",
    "encrypted_id",
    "encryptedIDs",
    "encryptedUIDs",
    "hdrMode",
    "HDRType",
    # entitled / not entitled
    "isUnlocked",
    "is_unlocked",
    "unlocked",
    "IsUnlocked",
    "ISUNLOCKED",
    "isPurchased",
    "purchased",
    "bought",
    "entitled",
    "isEntitled",
    "hasPaid",
    "has_paid",
    "hasPurchased",
    "hasUnlocked",
    "hasBought",
    "hasAccess",
    "paidByUser",
    "paid_by_viewer",
    "paidByMe",
    # viewer lock
    "isLocked",
    "is_locked",
    "locked",
    "Locked",
    "needPay",
    "need_pay",
    "needUnlock",
    "needBuy",
    "needPurchase",
    "preview",
    "isPreview",
    "trial",
    "isTrial",
    "paywall",
    "showPaywall",
    "lockStatus",
    "lock_status",
    "LockStatus",
    "episodeLockStatus",
    "subLockStatus",
    "webLockStatus",
    # statuses (decide only by a string)
    "unlockStatus",
    "unlock_status",
    "payStatus",
    "pay_status",
    "purchaseStatus",
    "purchase_status",
    # pricing
    "isFree",
    "free",
    "freeEpisode",
    "unlockPrice",
    "price",
    "coin",
    "coins",
    "cost",
    "charge",
    "chargeType",
    "vip",
    "isVip",
    "vipOnly",
    "isPaid",
    "paid",
    "unlockType",
    "payType",
    "coinPrice",
    # block is not lock
    "blockStatus",
    "isBlocked",
    "BLOCK_STATUS",
    "unblockStatus",
    "blockLockStatus",
    "isBlockLocked",
    "webLock",
    "subLock",
    "DBLock",
    # re.IGNORECASE traps: \u0130 I with dot, \u0131 dotless i, \u017f long s, \u212a Kelvin
    "\u0130sLocked",
    "is\u212aocked",
    "\u0131s_locked",
    "unloc\u212aStatus",
    "has\u0130aid",
    "co\u017ft",
    "pay\u017ftatus",
    "\u0131sFree",
    # noise
    "id",
    "desc",
    "title",
    "name",
    "count",
    "status",
    "type",
    "",
    "  ",
    "\u00fc",
    "\U0001f600",
    "None",
    "x-y",
    "a_b",
    "01",
    "-1",
    "1.5",
)
#: Scalars: bools, ints within 2**53, fractional floats, falsy and status strings, numbers and
#: bools spelled as text, Python-only whitespace (U+0085, U+001C) and a BOM (JavaScript's trim()
#: would strip it, Python's strip() does not), digits of other scripts, long hints.
FUZZ_SCALARS = (
    None,
    True,
    False,
    0,
    1,
    -1,
    2,
    30,
    2**53 - 1,
    -(2**53) + 1,
    0.5,
    -0.5,
    1.5,
    2.25,
    1e-05,
    123456.789,
    "",
    " ",
    "0",
    "1",
    " 1 ",
    "-1",
    "1.5",
    "+1",
    "2",
    "false",
    "False",
    "FALSE",
    "true",
    "TRUE",
    "yes",
    "Yes",
    "ye\u017f",
    "no",
    "none",
    "null",
    "NULL",
    "unlocked",
    " Unlocked ",
    "unloc\u212aed",
    "paid",
    "purchased",
    "bought",
    "entitled",
    "locked",
    "lock",
    "need_pay",
    "NEED_PAY",
    "needpay",
    "unpaid",
    "unpurchased",
    "pending",
    "on",
    "widevine",
    "fairplay",
    "cenc",
    "x" * 45,
    "\u00e9" * 41,
    "\U0001f600" * 41,
    "\u202e",
    "\x85",
    "\x1ctrue\x1c",
    "\ufeff",
    "\ufeff1",
    "\u00a0",
    "\u3000true\u3000",
    "\uff12",
    "\u0663",
    "\u00b2",
    "\u0130",
    "https://v16-webapp-prime.tiktok.com/v/?expire=1",
)
PLAY_URLS = (
    "https://v16-webapp-prime.tiktok.com/video/tos/useast2a/abc/?a=1988&expire=1761200000",
    "https://v16-webapp-prime.tiktok.com/video/tos/useast2a/abc-1080/?a=1988&expire=1761200001",
    "http://v19.tiktokcdn.com/x/?expire=5",
    " https://v16.tiktokcdn-us.com/y/ ",
    "HTTPS://V16.TIKTOKCDN.COM/UPPER/",
    "ftp://nope/",
    "null",
    "",
)
COVERS = (
    "https://p16-sign-sg.tiktokcdn.com/obj/a~tplv-tiktokx-origin.jpeg?x-expires=1800000000",
    ["https://p16-sign-sg.tiktokcdn.com/obj/b.jpeg"],
    {"UrlList": ["", "https://p16-sign-sg.tiktokcdn.com/obj/c.jpeg"]},
    {"url_list": "https://p16-sign-sg.tiktokcdn.com/obj/d.jpeg"},
    "  ",
    "javascript:alert(1)",
    None,
)
CODECS = (
    "h264",
    "H264",
    "avc1",
    "h.264",
    "h265",
    "HEVC",
    "hvc1",
    "bytevc1",
    "ByteVC1_x",
    "vp9",
    "",
    " ",
    None,
    5,
)
GEAR_NAMES = (
    "normal_720_0",
    "adapt_lower_1080_1",
    "lowest_540_0",
    "x",
    "normal_12345_0",
    "\uff14\uff18\uff10",
    "\u0667\u0662\u0660p",
    "",
    None,
)
RATIOS = ("720p", "1080P", " 540p ", "720", "\uff14\uff18\uff10p", "auto", "", "720p\n", 720)


def fuzz_scalar(rng: random.Random) -> Any:
    return rng.choice(FUZZ_SCALARS)


def fuzz_container(rng: random.Random, depth: int) -> Any:
    roll = rng.random()
    if depth > 4 or roll < 0.5:
        return fuzz_scalar(rng)
    if roll < 0.8:
        return {
            rng.choice(FUZZ_KEYS): fuzz_container(rng, depth + 1) for _ in range(rng.randint(0, 5))
        }
    return [fuzz_container(rng, depth + 1) for _ in range(rng.randint(0, 3))]


def fuzz_rendition(rng: random.Random) -> Any:
    if rng.random() < 0.05:
        return rng.choice(["x", None, 3, []])
    entry: dict[str, Any] = {}
    if rng.random() < 0.85:
        entry["CodecType"] = rng.choice(CODECS)
    if rng.random() < 0.85:
        entry["Bitrate"] = rng.choice(
            [1138000, 1652000, 500000, 1138000, 0, -5, "900000", " 700000 ", "x", None, True, 2.5]
        )
    if rng.random() < 0.7:
        entry["GearName"] = rng.choice(GEAR_NAMES)
    roll = rng.random()
    if roll < 0.7:
        entry["PlayAddr"] = {"UrlList": [rng.choice(PLAY_URLS) for _ in range(rng.randint(0, 3))]}
    elif roll < 0.8:
        entry["PlayAddr"] = rng.choice(PLAY_URLS)
    elif roll < 0.85:
        entry["PlayAddr"] = {"urlList": ["null", ""]}
    elif roll < 0.9:
        entry["PlayAddr"] = [[rng.choice(PLAY_URLS)]]
    return entry


def fuzz_video(rng: random.Random) -> Any:
    if rng.random() < 0.1:
        return rng.choice([None, "x", [], 5])
    video: dict[str, Any] = {}
    roll = rng.random()
    if roll < 0.3:
        video["playAddr"] = rng.choice(PLAY_URLS)
    elif roll < 0.45:
        video["playAddr"] = rng.choice(["", " ", "null", "None", "\u3000"])
    elif roll < 0.55:
        video["playAddr"] = {"UrlList": [rng.choice(PLAY_URLS), rng.choice(PLAY_URLS)]}
    elif roll < 0.6:
        video["playAddr"] = [rng.choice(PLAY_URLS)]
    roll = rng.random()
    if roll < 0.45:
        video["bitrateInfo"] = [fuzz_rendition(rng) for _ in range(rng.randint(1, 4))]
    elif roll < 0.55:
        video["bitrateInfo"] = []
    elif roll < 0.6:
        video["bitrateInfo"] = rng.choice([{}, "x", None])
    if rng.random() < 0.5:
        video["ratio"] = rng.choice(RATIOS)
    if rng.random() < 0.6:
        video["duration"] = rng.choice(
            [3, 92, -1, 0, "3", " 88 ", "\u0663", "\u00b2", 2.5, None, True]
        )
    if rng.random() < 0.5:
        video[rng.choice(["originCover", "cover", "dynamicCover"])] = rng.choice(COVERS)
    for _ in range(rng.randint(0, 3)):
        video[rng.choice(FUZZ_KEYS)] = fuzz_scalar(rng)
    return video


def fuzz_item(rng: random.Random) -> dict[str, Any]:
    """One generated ``itemList`` entry: every field access_of and episode_from_item read, each
    sometimes missing, of the wrong type or a trap."""
    item: dict[str, Any] = {}
    if rng.random() < 0.9:
        item["id"] = rng.choice(
            ["7699400000000000001", 7699400, "  42  ", "", " ", None, True, 1.5]
        )
    for _ in range(rng.randint(0, 4)):
        item[rng.choice(FUZZ_KEYS)] = fuzz_scalar(rng)
    if rng.random() < 0.9:
        drama: dict[str, Any] = {
            "DramaVideoData": {
                "EpisodeNumber": rng.choice(
                    [1, 2, 3, "4", " 5 ", 0, -1, "x", None, "\u0663", 2**53 - 1]
                )
            }
        }
        if rng.random() < 0.3:
            drama["dramaID"] = rng.choice(["s", "other", 5, None, "", " s "])
        if rng.random() < 0.5:
            drama["dramaName"] = rng.choice(["Love Story", "  ", None, "\u00dc name", 7])
        for _ in range(rng.randint(0, 4)):
            drama[rng.choice(FUZZ_KEYS)] = fuzz_container(rng, 1)
        if rng.random() < 0.3:
            drama["DramaVideoData"].update(
                {rng.choice(FUZZ_KEYS): fuzz_scalar(rng) for _ in range(rng.randint(1, 3))}
            )
        item["dramaInfo"] = drama if rng.random() < 0.95 else rng.choice(["x", [drama], None])
    if rng.random() < 0.9:
        item["video"] = fuzz_video(rng)
    if rng.random() < 0.3:
        item["desc"] = rng.choice(["Episode desc", "  ", "", None, "\u00e9t\u00e9 | Ep 2"])
    if rng.random() < 0.2:
        item["author"] = rng.choice([{"uniqueId": "drama_us"}, {"uniqueId": "  "}, "x", None])
    if rng.random() < 0.15:
        outer: dict[str, Any] = {"itemStruct": item}
        for _ in range(rng.randint(0, 2)):
            outer[rng.choice(FUZZ_KEYS)] = fuzz_scalar(rng)
        return outer
    return item


def fuzz_corpus() -> list[dict[str, Any]]:
    rng = random.Random(FUZZ_SEED)
    return [fuzz_item(rng) for _ in range(FUZZ_ITEMS)]


def clue_classes(item: dict[str, Any]) -> set[str]:
    """The clue classes access_of finds in an item, walked exactly as access_of walks it."""
    clues: list[tuple[str, str]] = []
    for key, value in catalog._top_level_scalars(item):
        clues.extend(catalog._clues(key, value))
    drama = catalog._field(item, "dramaInfo")
    if isinstance(drama, dict):
        catalog._collect_clues(drama, 0, clues)
    video = catalog._field(item, "video")
    if isinstance(video, dict):
        for key, value in video.items():
            clues.extend(catalog._clues(str(key), value))
    return {kind for kind, _ in clues}


# --------------------------------------------------------------------------- constants and texts


def test_the_shared_texts_and_constants_are_the_python_ones() -> None:
    from dramafetch import downloader_browser
    from dramafetch.discovery import browser as discovery_browser
    from dramafetch.web import jobs

    expected: dict[str, Any] = {
        "messages.TIKTOK_BASE_URL": models.TIKTOK_BASE_URL,
        "messages.DEFAULT_NAME_FORMAT": models.DEFAULT_NAME_FORMAT,
        "messages.THUMBNAIL_MODES": list(models.THUMBNAIL_MODES),
        "messages.QUALITY_MODES": list(models.QUALITY_MODES),
        "messages.RECHECK_AFTER_S": models.RECHECK_AFTER_S,
        "messages.ACCESS_MODES": list(models.ACCESS_MODES),
        "messages.DRM_MARK": models.DRM_MARK,
        "messages.DRM_MESSAGE": models.DRM_MESSAGE,
        "messages.DRM_REMEMBERED_MESSAGE": models.DRM_REMEMBERED_MESSAGE,
        "messages.PAYLOAD_DRM_MESSAGE": PAYLOAD_DRM_MESSAGE,
        "messages.RECHECK_HINT": engine.RECHECK_HINT,
        "messages.BLOCKED_MESSAGE": BLOCKED_MESSAGE,
        "messages.INCOMPLETE_PREFIX": INCOMPLETE_PREFIX,
        "messages.UNAVAILABLE_MESSAGE": UNAVAILABLE_MESSAGE,
        "messages.MEDIA_RATE_LIMIT_MESSAGE": MEDIA_RATE_LIMIT_MESSAGE,
        "messages.LIST_RATE_LIMIT_MESSAGE": discovery_browser.RATE_LIMIT_MESSAGE,
        "messages.MANIFEST_SKIP_PREFIX": engine.MANIFEST_SKIP_PREFIX,
        "messages.STOPPED_PREFIX": engine.STOPPED_PREFIX,
        "messages.NOT_STARTED_PREFIX": jobs.NOT_STARTED_PREFIX,
        "messages.STATUSES": [status.value for status in DownloadStatus],
        "messages.DONE": DownloadStatus.DONE.value,
        "messages.SKIPPED_EXISTS": DownloadStatus.SKIPPED_EXISTS.value,
        "messages.SKIPPED_LOCKED": DownloadStatus.SKIPPED_LOCKED.value,
        "messages.DRY_RUN": DownloadStatus.DRY_RUN.value,
        "messages.FAILED_LOGIN": DownloadStatus.FAILED_LOGIN.value,
        "messages.FAILED_UNAVAILABLE": DownloadStatus.FAILED_UNAVAILABLE.value,
        "messages.FAILED_RATE_LIMITED": DownloadStatus.FAILED_RATE_LIMITED.value,
        "messages.FAILED_BLOCKED": DownloadStatus.FAILED_BLOCKED.value,
        "messages.FAILED": DownloadStatus.FAILED.value,
        "messages.OK_STATUSES": sorted(status.value for status in DownloadStatus if status.ok),
        "catalog.MAX_DEPTH": catalog.MAX_DEPTH,
        "catalog.NO_PLAY_ADDRESS": catalog.NO_PLAY_ADDRESS,
        "catalog.UNKNOWN_CODEC": catalog.UNKNOWN_CODEC,
        "catalog.UNKNOWN_HEIGHT": catalog.UNKNOWN_HEIGHT,
        "naming.NAME_PLACEHOLDERS": list(manifest.NAME_PLACEHOLDERS),
        "naming.MAX_STEM_LEN": manifest.MAX_STEM_LEN,
        "pacing.PACE": engine.PACE,
        "pacing.REST": engine.REST,
        "pacing.LONG_REST": engine.LONG_REST,
        "pacing.SERIES_REST": engine.SERIES_REST,
        "pacing.JOB_REST": jobs.JOB_REST,
        "pacing.PACES": list(engine.PACES),
        "pacing.MAX_HUMAN_PAUSE_S": engine.MAX_HUMAN_PAUSE_S,
        "pacing.HUMAN_JITTER_S": engine.HUMAN_JITTER_S,
        "pacing.PAGE_DELAY_S": models.DiscoveryOptions().page_delay_s,
        "pacing.PAGE_DELAY_JITTER": list(discovery_browser.PAGE_DELAY_JITTER),
        "pacing.MAX_GETS_PER_EPISODE": downloader_browser.MAX_GETS_PER_EPISODE,
        "pacing.MAX_COVER_GETS": downloader_browser.MAX_COVER_GETS,
        "pacing.EXPIRY_MARGIN_S": downloader_browser.EXPIRY_MARGIN_S,
        "pacing.STOP_STATUSES": sorted(status.value for status in engine._STOP_STATUSES),
        "pacing.BLOCK_STATUSES": sorted(status.value for status in engine.BLOCK_STATUSES),
        "pacing.COUNTED_FAILURES": sorted(status.value for status in engine._COUNTED_FAILURES),
        "pacing.NO_NETWORK_STATUSES": sorted(status.value for status in engine.NO_NETWORK_STATUSES),
        "pacing.PACING_DEFAULTS": js_pacing_options(DownloadOptions()),
        "report.MAX_EPISODE_NUMBER": engine.MAX_EPISODE_NUMBER,
        "cooldown.COOLDOWN_MINUTES": cooldown.COOLDOWN_MINUTES,
        "cooldown.COOLDOWN_SOURCES": list(cooldown.COOLDOWN_SOURCES),
        "state.STATE_VERSION": manifest.MANIFEST_VERSION,
    }
    names = list(expected)
    values = js_values([call("$const", name) for name in names])
    rows = []
    for name, value in zip(names, values, strict=True):
        javascript = (
            sorted(value) if name.endswith(("STATUSES", "FAILURES")) and "." in name else value
        )
        if name == "messages.STATUSES":
            javascript = value
        rows.append((name, expected[name], javascript))
    assert_same(rows)


# --------------------------------------------------------------------------- catalog: access


def python_access(item: dict[str, Any]) -> tuple[str, bool, bool, list[str]]:
    access, paid, drm, hints = catalog.access_of(item)
    return access, paid, drm, list(hints)


def js_access(value: dict[str, Any]) -> tuple[str, bool, bool, list[str]]:
    return value["access"], value["paid"], value["drm"], value["hints"]


def test_access_of_matches_on_every_fixture_item() -> None:
    items = fixture_items()
    assert len(items) == 38  # 19 items in the five fixture pages, as served and wrapped
    values = js_values([call("catalog.accessOf", item) for item in items])
    assert_same(
        [
            (index, python_access(item), js_access(value))
            for index, (item, value) in enumerate(zip(items, values, strict=True))
        ]
    )
    # the fixtures hold every access outcome
    assert {js_access(value)[0] for value in values} == {"free", "unlocked", "locked"}


def test_access_of_matches_on_a_seeded_fuzz_corpus_that_covers_every_clue_class() -> None:
    corpus = fuzz_corpus()
    assert len(corpus) >= 2000
    values = js_values([call("catalog.accessOf", item) for item in corpus])
    assert_same(
        [
            (index, python_access(item), js_access(value))
            for index, (item, value) in enumerate(zip(corpus, values, strict=True))
        ]
    )
    classes: dict[str, int] = {}
    for item in corpus:
        for kind in clue_classes(item):
            classes[kind] = classes.get(kind, 0) + 1
    for kind in ("drm", "entitled", "not-entitled", "viewer-lock", "ambiguous", "pricing"):
        assert classes.get(kind, 0) >= 25, (kind, classes)
    decisions = [python_access(item) for item in corpus]
    assert {access for access, _, _, _ in decisions} == {"free", "unlocked", "locked"}
    assert sum(1 for _, _, drm, _ in decisions if drm) >= 25
    assert sum(1 for access, paid, _, _ in decisions if access == "unlocked" and paid) >= 25
    assert sum(1 for access, paid, _, _ in decisions if access == "locked" and paid) >= 25
    assert sum(1 for *_, hints in decisions if catalog.NO_PLAY_ADDRESS in hints) >= 25


#: The spec's DRM key lists (the same as tests/test_catalog.py): "must be DRM" ...
DRM_KEYS = (
    "isDrm",
    "drm",
    "drmType",
    "DRMType",
    "is_encrypted",
    "encrypted",
    "videoEncrypted",
    "encryption",
    "encryptType",
)
#: ... and "must NOT be DRM": HDR flags, negations and identifiers.
NOT_DRM_KEYS = (
    "hdrMode",
    "HDRType",
    "isHdr",
    "isDrmFree",
    "drm_free",
    "nonEncrypted",
    "no_drm",
    "notEncrypted",
    "encryptedUid",
    "encrypted_id",
    "unencrypted",
    "encryptedIDs",
    "encryptedUIDs",
    "encryptedUserIDs",
    "unEncrypted",
    "isUnEncrypted",
    "un_encrypted",
)
WORD_KEYS = (
    "HDRBit",
    "VideoEncrypted",
    "no-drm",
    "drm2Type",
    "HDR10Plus",
    "isDRM",
    "DRM",
    "IDsList",
    "IsDrmFree",
    "",
    "__",
    "\u00fc",
    "a1b2C3",
    "XMLHttpRequest",
    "ABCs",
    "ABCsDef",
    "already-DRMed",
    "\U0001f600drm",
    "drm\u00e9",
    "ENCRYPTION_TYPE",
    "encrypt",
    "Encrypt-Me",
)


def test_key_words_and_is_drm_key_match_on_the_drm_key_lists_and_generated_keys() -> None:
    rng = random.Random(FUZZ_SEED)
    pieces = (
        "drm",
        "DRM",
        "Drm",
        "encrypt",
        "Encrypted",
        "ENCRYPTION",
        "is",
        "no",
        "Non",
        "not",
        "un",
        "Un",
        "without",
        "free",
        "Free",
        "id",
        "Id",
        "IDs",
        "UIDs",
        "uid",
        "type",
        "HDR",
        "hdr",
        "Mode",
        "2",
        "10",
        "x",
        "\u00fc",
        "_",
        "-",
        " ",
    )
    generated = ["".join(rng.choice(pieces) for _ in range(rng.randint(1, 5))) for _ in range(800)]
    keys = [*DRM_KEYS, *NOT_DRM_KEYS, *WORD_KEYS, *FUZZ_KEYS, *generated]
    calls = [call("catalog.keyWords", key) for key in keys] + [
        call("catalog.isDrmKey", key) for key in keys
    ]
    values = js_values(calls)
    words, drm = values[: len(keys)], values[len(keys) :]
    assert_same(
        [(key, list(catalog.key_words(key)), value) for key, value in zip(keys, words, strict=True)]
    )
    assert_same(
        [(key, catalog.is_drm_key(key), value) for key, value in zip(keys, drm, strict=True)]
    )
    assert all(drm[keys.index(key)] for key in DRM_KEYS)
    assert not any(drm[keys.index(key)] for key in NOT_DRM_KEYS)


# --------------------------------------------------------------------------- catalog: pages


def python_page(page: catalog.PagePayload) -> dict[str, Any]:
    return {
        "episodes": [js_episode(episode) for episode in page.episodes],
        "cursor": page.cursor,
        "hasMore": page.has_more,
        "seenItems": page.seen_items,
        "skippedItems": page.skipped_items,
    }


def test_parse_item_list_payload_matches_on_every_fixture_page() -> None:
    cases = [
        (name, load_fixture(name), series_id)
        for name, own in FIXTURE_PAGES
        for series_id in (own, "7600000000000000000", "s")
    ]
    values = js_values(
        [
            call("catalog.parseItemListPayload", payload, sid, omit=("raw",))
            for _, payload, sid in cases
        ]
    )
    assert_same(
        [
            ((name, sid), python_page(catalog.parse_item_list_payload(payload, sid)), value)
            for (name, payload, sid), value in zip(cases, values, strict=True)
        ]
    )
    assert sum(len(value["episodes"]) for value in values) >= 15


def test_merge_episodes_and_catalog_warnings_match() -> None:
    page1 = catalog.parse_item_list_payload(load_fixture("item_list_page1.json"), SERIES_ID)
    page2 = catalog.parse_item_list_payload(load_fixture("item_list_page2.json"), SERIES_ID)
    rng = random.Random(FUZZ_SEED)
    pools = [page1.episodes, page2.episodes]
    corpus = fuzz_corpus()
    fuzz_episodes = [
        e for e in (catalog.episode_from_item(item, "s") for item in corpus) if e is not None
    ]
    for _ in range(60):
        size = rng.randint(0, 12)
        pools.append(
            [replace(rng.choice(fuzz_episodes), number=rng.randint(1, 15)) for _ in range(size)]
        )
    page_sets = [[page1.episodes, page2.episodes], [page2.episodes, page1.episodes]]
    page_sets += [[rng.choice(pools) for _ in range(rng.randint(1, 3))] for _ in range(60)]
    hints = (None, 0, -2, 3, 4, 5, 9)
    calls = [
        call(
            "catalog.mergeEpisodes",
            [[js_episode_in(e) for e in page] for page in pages],
            omit=("raw",),
        )
        for pages in page_sets
    ]
    calls += [
        call("catalog.catalogWarnings", [js_episode_in(e) for e in pool], hint)
        for pool in pools
        for hint in hints
    ]
    values = js_values(calls)
    merged = values[: len(page_sets)]
    warnings = values[len(page_sets) :]
    assert_same(
        [
            (index, [js_episode(e) for e in catalog.merge_episodes(pages)], value)
            for index, (pages, value) in enumerate(zip(page_sets, merged, strict=True))
        ]
    )
    expected = [catalog.catalog_warnings(pool, hint) for pool in pools for hint in hints]
    assert_same(
        [(index, py, js) for index, (py, js) in enumerate(zip(expected, warnings, strict=True))]
    )
    assert any(js for js in warnings)


def fuzz_pages(rng: random.Random, items: list[dict[str, Any]]) -> list[Any]:
    """Pages around generated items: the list at the top level or nested, cursors and hasMore
    flags of every type, junk."""
    pages: list[Any] = []
    cursors = (3, 0, "30", " 7 ", 2.5, True, None, "", "abc", -1)
    flags = (True, False, 1, 0, 2, "true", " TRUE ", "1", "yes", None, 1.5)
    for start in range(0, len(items), 25):
        chunk = items[start : start + 25]
        page: dict[str, Any] = {"itemList": chunk}
        if rng.random() < 0.8:
            page["cursor"] = rng.choice(cursors)
        if rng.random() < 0.8:
            page[rng.choice(("hasMore", "has_more"))] = rng.choice(flags)
        roll = rng.random()
        if roll < 0.3:
            nested: Any = {
                "data": {"item_list": chunk, "cursor": rng.choice(cursors)},
                "hasMore": rng.choice(flags),
            }
        elif roll < 0.4:
            nested = [{"x": {"itemList": chunk[:3]}}, {"itemList": "x", "cursor": 4}]
        elif roll < 0.45:
            nested = rng.choice(["text", 3, None, [], {}])
        else:
            nested = page
        pages.append(nested)
    return pages


def test_parse_item_list_payload_find_item_lists_and_details_match_on_generated_pages() -> None:
    rng = random.Random(FUZZ_SEED + 1)
    pages = fuzz_pages(rng, fuzz_corpus())
    details: list[Any] = []
    names = ("dramaName", "title", "name")
    totals = ("totalEpisode", "totalEpisodes", "episodeCount", "total", "episodeTotal")
    for _ in range(300):
        inner = {
            rng.choice((*names, *totals, "x")): rng.choice(
                ("Love", " ", "", None, 5, "12", " 30 ", 0, -3, 2.5, "\u0663", True, [1])
            )
            for _ in range(rng.randint(0, 4))
        }
        roll = rng.random()
        if roll < 0.4:
            details.append(
                {
                    rng.choice(("dramaInfo", "drama", "detail")): inner,
                    **({"name": "Top"} if rng.random() < 0.3 else {}),
                }
            )
        elif roll < 0.7:
            details.append({"data": [{"detail": inner}, {"drama": {"dramaInfo": inner}}]})
        else:
            details.append(rng.choice((inner, [inner], "x", None, {"total": 4, "title": "T"})))
    calls = [call("catalog.parseItemListPayload", page, "s", omit=("raw",)) for page in pages]
    calls += [call("catalog.findItemLists", page) for page in pages]
    calls += [call("catalog.parseDetailPayload", detail) for detail in details]
    values = js_values(calls)
    parsed = values[: len(pages)]
    found = values[len(pages) : 2 * len(pages)]
    detail_values = values[2 * len(pages) :]
    assert_same(
        [
            (index, python_page(catalog.parse_item_list_payload(page, "s")), value)
            for index, (page, value) in enumerate(zip(pages, parsed, strict=True))
        ]
    )
    assert_same(
        [
            (index, catalog.find_item_lists(page), value)
            for index, (page, value) in enumerate(zip(pages, found, strict=True))
        ]
    )
    assert_same(
        [
            (index, list(catalog.parse_detail_payload(detail)), [value["name"], value["total"]])
            for index, (detail, value) in enumerate(zip(details, detail_values, strict=True))
        ]
    )


# --------------------------------------------------------------------------- catalog: renditions


def test_episodes_covers_renditions_and_play_urls_match_on_fixtures_and_fuzz() -> None:
    items = [*fixture_items(), *fuzz_corpus()]
    per_item = 9
    calls: list[dict[str, Any]] = []
    for item in items:
        calls += [
            call("catalog.episodeFromItem", item, "s", omit=("raw",)),
            call("catalog.episodeFromItem", item, SERIES_ID, omit=("raw",)),
            call("catalog.coverUrlOf", item),
            call("catalog.renditions", item),
            call("catalog.orderedRenditions", item, "compatible"),
            call("catalog.chooseRendition", item, "best"),
            call("catalog.playUrlCandidates", item),
            call("catalog.playUrlCandidates", item, "best"),
            call("catalog.lockHints", item),
        ]
    values = js_values(calls)
    rows: list[tuple[Any, Any, Any]] = []
    for index, item in enumerate(items):
        got = values[index * per_item : (index + 1) * per_item]
        for which, series_id, value in (
            ("episode s", "s", got[0]),
            ("episode id", SERIES_ID, got[1]),
        ):
            episode = catalog.episode_from_item(item, series_id)
            rows.append(((index, which), js_episode(episode) if episode else None, value))
        chosen = catalog.choose_rendition(item, "best")
        expected = [
            catalog.cover_url_of(item),
            [js_rendition(r) for r in catalog.renditions(item)],
            [js_rendition(r) for r in catalog.ordered_renditions(item, "compatible")],
            js_rendition(chosen) if chosen else None,
            catalog.play_url_candidates(item),
            catalog.play_url_candidates(item, "best"),
            list(catalog.lock_hints(item)),
        ]
        rows.append(((index, "rest"), expected, got[2:]))
    assert_same(rows)
    assert sum(1 for value in values[3::per_item] if value) >= 200  # many items list renditions


def test_codec_names_and_the_quality_refusal_match() -> None:
    raws = [
        *CODECS,
        "AVC",
        "x264",
        "H.265",
        "hev1_main",
        "BYTEVC1",
        " bytevc1 ",
        "\u0130",
        "VP9",
        [],
        {},
    ]
    item = {
        "video": {"bitrateInfo": [{"CodecType": "h264", "PlayAddr": {"UrlList": [PLAY_URLS[0]]}}]}
    }
    calls = [call("catalog.codecName", raw) for raw in raws]
    calls += [call("catalog.orderedRenditions", item, quality) for quality in ("fast", "", "Best")]
    calls += [
        call("catalog.playUrlCandidates", {}, "fast"),
        call("catalog.playUrlCandidates", "x", "fast"),
    ]
    results = run_js(calls)
    names = [js_outcome(result) for result in results[: len(raws)]]
    assert_same(
        [(raw, ("ok", catalog.codec_name(raw)), got) for raw, got in zip(raws, names, strict=True)]
    )
    refusals = [js_outcome(result) for result in results[len(raws) : len(raws) + 3]]
    assert_same(
        [
            (quality, outcome(catalog.ordered_renditions, item, quality), got)
            for quality, got in zip(("fast", "", "Best"), refusals, strict=True)
        ]
    )
    assert [js_outcome(result) for result in results[-2:]] == [("ok", []), ("ok", [])]
    assert catalog.play_url_candidates({}, "fast") == []


#: URLs for url_expiry: TikTok's shape, every way urlsplit / parse_qs read a query, the URLs
#: urlsplit refuses (brackets, NFKC tricks), percent-encoding, a BOM, whitespace, junk.
EXPIRY_URLS = (
    "https://v16-webapp-prime.tiktok.com/video/tos/useast2a/abc/?a=1988&expire=1761200000",
    "https://v16.tiktokcdn.com/x/?expire=1761200000&sig=a",
    "https://x/?a=1&expire=  1761  ",
    "https://x/?expire=-5",
    "https://x/?expire=+5",
    "https://x/?expire=%2B5",
    "https://x/?expire=%2D5",
    "https://x/?expire=--5",
    "https://x/?expire=1_000",
    "https://x/?expire=\u0663\u0664",
    "https://x/?expire=%D9%A3%D9%A4",
    "https://x/?expire=\u00b2",
    "https://x/?expire=",
    "https://x/?expire",
    "https://x/?expire=1&expire=2",
    "https://x/?expire=x&expire=2",
    "https://x/?EXPIRE=5",
    "https://x/?%65xpire=7",
    "https://x/?ex%70ire=7&expire=8",
    "https://x/?expire=7#frag",
    "https://x/#?expire=7",
    "https://x/?x=1#expire=3",
    "https://x/?a=1&&expire=4&",
    "https://x/?a+b=1&expire=+4+",
    "https://x/?expire=4%",
    "https://x/?expire=%34",
    "https://x/?a=%ZZ&expire=3",
    "https://x/?expire=1e3",
    "https://x/?expire=0x10",
    "https://x/?expire=123456789012345",
    "https://x/?expire=%EF%BB%BF8",
    "https://x/?%EF%BB%BFexpire=8",
    "https://x/?expire=8%C3",
    "https://x/?expire=\u00e98",
    "https://x/?ex\tpire=8",
    "https://x/?expire=8\n",
    "https://x/?expire=8\r\n9",
    " \x00\x1fhttps://x/?expire=9",
    "\u00a0https://x/?expire=9",
    "https://[::1]/?expire=5",
    "https://[::1/?expire=5",
    "https://::1]/?expire=5",
    "https://[1.2.3.4]/?expire=5",
    "https://[v1.x]/?expire=5",
    "https://[v1.]/?expire=5",
    "https://[vz.x]/?expire=5",
    "https://[fe80::1%25eth0]/?expire=5",
    "https://[fe80::1%]/?expire=5",
    "https://u@[::1]:80/?expire=9",
    "https://x[::1]/?expire=9",
    "https://[::1]x/?expire=9",
    "https://[::ffff:1.2.3.4]/?expire=9",
    "https://[1:2:3:4:5:6:7:8]/?expire=9",
    "https://[1:2:3:4:5:6:7:8:9]/?expire=9",
    "https://[1::2::3]/?expire=9",
    "https://[:1:2:3:4:5:6:7]/?expire=9",
    "https://[12345::1]/?expire=9",
    "https://[" + "0:" * 20 + ":1]/?expire=9",
    "https://ex\u2100ample.com/?expire=4",
    "https://ex\uff0fample/?expire=4",
    "https://\u00e9xample.com/?expire=4",
    "mailto:x?expire=5",
    "1http://x?expire=5",
    "//host?expire=6",
    "https://ho#st/?expire=6",
    "?expire=10",
    "expire=10",
    "",
    "https://x/",
)


def test_url_expiry_matches_on_tiktok_urls_and_every_urlsplit_corner() -> None:
    urls_seen = [*EXPIRY_URLS]
    for item in fixture_items():
        urls_seen.extend(catalog.play_url_candidates(item, "best"))
    inputs: list[Any] = [*urls_seen, None, 5, ["https://x/?expire=1"]]
    values = js_values([call("catalog.urlExpiry", url) for url in inputs])
    assert_same(
        [(url, catalog.url_expiry(url), value) for url, value in zip(inputs, values, strict=True)]
    )
    assert sum(1 for value in values if value is not None) >= 20


# --------------------------------------------------------------------------- urls


#: What users paste: every accepted shape, case and scheme variants, Unicode the regexes must
#: treat as Python does (re.IGNORECASE's dotless i / long s / Kelvin sign, U+2028, U+0085, a BOM,
#: digits of other scripts), short links, single videos, junk and repr quoting.
INPUTS = (
    f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/1",
    f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}",
    f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/",
    f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/12?lang=en",
    f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/0",
    f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/0000",
    f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/12345",
    f"http://m.tiktok.com/shortdrama/episode/{SERIES_ID}/3#x",
    f"HTTPS://WWW.TIKTOK.COM/SHORTDRAMA/EPISODE/{SERIES_ID}/2",
    f"www.tiktok.com/shortdrama/episode/{SERIES_ID}/1",
    f"tiktok.com/shortdrama/{SERIES_ID}",
    f"M.TikTok.com/shortdrama/{SERIES_ID}",
    f"https://www.tiktok.com/shortdrama/detail/{SERIES_ID}",
    f"https://www.tiktok.com/shortdrama/series/{SERIES_ID}?x=1",
    f"https://www.tiktok.com/shortdrama/{SERIES_ID}/",
    f"<https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/1>",
    f"  {SERIES_ID}  ",
    SERIES_ID,
    "769939377025678",
    "76993937702567823541234",
    "\uff17\uff16\uff19\uff19\uff13\uff19\uff13\uff17\uff17\uff10\uff12\uff15\uff16\uff17\uff18",
    f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID[:-1]}\u0663/1",
    "https://www.tiktok.com/@muffin.drama/video/7699400000000000001",
    "https://www.tiktok.com/@M\u00fcffin_x-y/video/7699400000000000001?is_from_webapp=1",
    "https://www.tiktok.com/@\u0130stanbul/video/7699400000000000001",
    "https://www.tiktok.com/video/7699400000000000001",
    "https://www.tiktok.com/@user/video/123",
    "https://vm.tiktok.com/ZMabc/",
    "https://vt.tiktok.com/x",
    "https://www.tiktok.com/t/ZT8abc/",
    "vm.tiktok.com/ZMabc/",
    "",
    "   ",
    "<>",
    "< >",
    "junk",
    "x" * 200,
    f"https://example.com/shortdrama/episode/{SERIES_ID}/1",
    f"https://www.t\u0131ktok.com/shortdrama/episode/{SERIES_ID}/1",
    f"http\u017f://www.tiktok.com/shortdrama/episode/{SERIES_ID}/1",
    f"https://www.tikto\u212a.com/shortdrama/episode/{SERIES_ID}/1",
    f"https://www.t\u0130ktok.com/shortdrama/episode/{SERIES_ID}/1",
    f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/1?a\rb",
    f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/1?a\u2028b",
    f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/1\x85",
    f"\ufeffhttps://www.tiktok.com/shortdrama/episode/{SERIES_ID}/1",
    f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/1\nfoo",
    f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/1 trailing words",
    "a'b",
    'a"b',
    "a'\"b",
    "tab\there",
    "\x07bell\x7f",
    "nb\u00a0sp \u200b zw \u2028 ls \U0001f600 \udcff",
)


def python_ref(text: str) -> tuple[str, Any]:
    try:
        ref = urls.parse_input(text)
    except UnsupportedUrlError as exc:
        return "error", str(exc)
    if isinstance(ref, SeriesRef):
        return "ok", {
            "kind": "series",
            "seriesId": ref.series_id,
            "episodeHint": ref.episode_hint,
            "sourceUrl": ref.source_url,
        }
    return "ok", {
        "kind": "video",
        "itemId": ref.item_id,
        "author": ref.author,
        "sourceUrl": ref.source_url,
    }


def test_parse_input_and_the_page_urls_match() -> None:
    results = run_js([call("urls.parseInput", text) for text in INPUTS])
    assert_same(
        [
            (text, python_ref(text), js_outcome(result))
            for text, result in zip(INPUTS, results, strict=True)
        ]
    )
    accepted = [result for result in results if result["ok"]]
    assert len(accepted) >= 15 and len(accepted) < len(INPUTS) - 15
    pages = [
        (SERIES_ID, 1, models.TIKTOK_BASE_URL),
        (SERIES_ID, 0, "https://www.tiktok.com/"),
        (SERIES_ID, -3, "http://127.0.0.1:8123//"),
        (SERIES_ID, 12, "http://localhost"),
    ]
    videos = [
        ("7699400000000000001", None, models.TIKTOK_BASE_URL),
        ("1", "", "http://x/"),
        ("2", "me", "b"),
    ]
    values = js_values(
        [call("urls.seriesPageUrl", *args) for args in pages]
        + [call("urls.videoPageUrl", *args) for args in videos]
    )
    expected = [urls.series_page_url(*args) for args in pages] + [
        urls.video_page_url(*args) for args in videos
    ]
    assert_same(
        [(index, py, js) for index, (py, js) in enumerate(zip(expected, values, strict=True))]
    )


# --------------------------------------------------------------------------- naming

#: Names for safe_filename: reserved characters and device names (Python's own rule), dots and
#: spaces, controls, Python-only whitespace, long and astral text, case mappings that turn into a
#: device name (a dotless i upper-cases to I).
NAMES = (
    "The Billionaire's Secret Heiress",
    "  spaced   out  ",
    'a/b\\c:d*e?f"g<h>i|j',
    "CON",
    "con.txt",
    "Aux. Stories",
    "COM1",
    "lpt9.mp4",
    "CONIN$",
    "conout$.x",
    "NUL ",
    "nul .txt",
    "COM10",
    "co\u0131n$",
    "...",
    " . ",
    "",
    "dots...",
    "x" * 200,
    "\u00e9" * 100,
    "\U0001f600" * 90,
    "tab\tnew\nline\rret\x0bvt\x0cff",
    "\x00\x01ctrl\x7f",
    "\x1c\x1d\x1e\x1fsep",
    "nel\x85x",
    "nbsp\u00a0x",
    "\u3000ideo\u3000",
    "\ufeffbom",
    "zero\u200bwidth",
    "rtl\u202eover",
    "~tilde~",
    ".hidden",
    "trail. ",
    "\u0130stanbul",
    "stra\u00dfe",
    "\u01c5",
    "COM\u00b9",
    "\ufb00",
    "a" * 79 + " b",
    "a" * 79 + ".b",
)
MAX_LENS = (80, 60, 150, 10, 1, 0, -1, 3)
FORMATS = (
    models.DEFAULT_NAME_FORMAT,
    "{number}",
    "{series} {n}",
    "{title}",
    "{id}",
    "{series}",
    "{number:02d}",
    "{nope}",
    "{series",
    "series}",
    "{{number}}",
    "{}",
    "{number}}",
    "{ number }",
    "",
    "Ep {n} - {title} [{id}]",
    "{series} - {title} - Episode {number}",
    "x{number}y{number}",
    "Folder/{number}",
    "{series}.{number}",
    "CON{n}",
    "{n}.",
    "{series}\u00e9{number}",
)


def test_safe_filename_and_validate_name_format_match() -> None:
    cases = [(name, max_len) for name in NAMES for max_len in MAX_LENS]
    calls = [call("naming.safeFilename", name, max_len) for name, max_len in cases]
    calls += [call("naming.validateNameFormat", name_format) for name_format in FORMATS]
    calls += [call("naming.nameFormatProblem", name_format) for name_format in FORMATS]
    results = run_js(calls)
    safe = results[: len(cases)]
    validated = results[len(cases) : len(cases) + len(FORMATS)]
    problems = results[len(cases) + len(FORMATS) :]
    assert_same(
        [
            (case, ("ok", manifest.safe_filename(*case)), js_outcome(result))
            for case, result in zip(cases, safe, strict=True)
        ]
    )
    rows = []
    for name_format, result, problem in zip(FORMATS, validated, problems, strict=True):
        expected = outcome(manifest.validate_name_format, name_format)
        rows.append((name_format, expected, js_outcome(result)))
        rows.append(
            (name_format, expected[1] if expected[0] == "error" else None, problem["value"])
        )
    assert_same(rows)


def test_episode_stem_matches_with_the_python_length_and_no_shortening() -> None:
    episodes = [
        Episode(
            1,
            "7699400000000000001",
            "The Billionaire's Secret Heiress | Episode 1",
            SERIES_ID,
            series_name="The Billionaire's Secret Heiress",
        ),
        Episode(7, "7", "  spaced  title  ", "s", series_name=None),
        Episode(100, "100", "x" * 90, "", series_name=None),
        Episode(1234, "id/with:chars", "t?i*t<l>e", "s", series_name="CON"),
        Episode(2, "2", "\u00e9t\u00e9 \U0001f600" * 20, "s", series_name="\u00c9t\u00e9 " * 30),
        Episode(3, "3", "dots...", "s", series_name="..."),
    ]
    series_names = (None, "", "Given Name", "y" * 120, "Aux. Stories")
    formats = [
        f
        for f in FORMATS
        if manifest.validate_name_format.__name__
        and outcome(manifest.validate_name_format, f)[0] == "ok"
    ]
    cases = [
        (episode, name_format, series_name)
        for episode in episodes
        for name_format in formats
        for series_name in series_names
    ]
    calls = [
        call(
            "naming.episodeStem",
            {
                "number": e.number,
                "itemId": e.item_id,
                "title": e.title,
                "seriesId": e.series_id,
                "seriesName": e.series_name,
            },
            {
                "nameFormat": f,
                "seriesName": n,
                "maxLen": 150,
                "shortenSeries": False,
                "chromeSafe": False,
            },
        )
        for e, f, n in cases
    ]
    values = js_values(calls)
    assert_same(
        [
            (
                (e.number, f, n),
                manifest.episode_stem(e, DownloadOptions(name_format=f, series_name=n)),
                value,
            )
            for (e, f, n), value in zip(cases, values, strict=True)
        ]
    )
    assert len(cases) >= 300


# --------------------------------------------------------------------------- reports


def report_episode(
    number: int, access: str = "free", *, drm: bool = False, hints: tuple[str, ...] = ()
) -> Episode:
    paid = access == "unlocked" or "paid" in hints
    return Episode(
        number,
        f"id-{number}",
        f"t{number}",
        "S1",
        series_name="Name",
        access=access,
        paid=paid,
        drm=drm,
        lock_hints=hints,
    )


def generated_runs(
    rng: random.Random, count: int
) -> list[tuple[Series | None, list[DownloadResult], dict[str, Any]]]:
    """Synthetic series and results for series_report: every status, the three accesses, a DRM
    payload flag, gaps, announced totals, repeated rows, never-resolved series."""
    statuses = list(DownloadStatus)
    runs: list[tuple[Series | None, list[DownloadResult], dict[str, Any]]] = []
    for _ in range(count):
        whole = rng.random() < 0.4  # a run that obtained every downloadable episode of 1..n
        if whole:
            numbers = list(range(1, rng.randint(1, 10) + 1))
        else:
            numbers = sorted(rng.sample(range(1, 16), rng.randint(0, 10)))
        episodes = []
        for number in numbers:
            access = rng.choice(["free", "free", "unlocked", "locked"])
            drm = access == "locked" and rng.random() < 0.3
            if drm:
                hints: tuple[str, ...] = ("drmType=widevine",)
            else:
                hints = ("isLocked=True",) if access == "locked" else ()
            episodes.append(report_episode(number, access, drm=drm, hints=hints))
        total_hint = rng.choice(
            [None, None, 0, -1, len(episodes), len(episodes) + 2, max(len(episodes) - 1, 1), 15]
        )
        if whole:
            total_hint = rng.choice([None, len(episodes)])
        series = Series("S1", rng.choice(["Name", None]), episodes, total_hint=total_hint)
        results = []
        for episode in episodes:
            if whole:
                done = (DownloadStatus.DONE, DownloadStatus.SKIPPED_EXISTS)
                status = DownloadStatus.SKIPPED_LOCKED if episode.locked else rng.choice(done)
                results.append(DownloadResult(episode, status, message=f"m{episode.number}"))
                continue
            if rng.random() < 0.85:
                status = rng.choice(statuses)
                results.append(DownloadResult(episode, status, message=f"m{episode.number}"))
            if rng.random() < 0.1:
                results.append(DownloadResult(episode, rng.choice(statuses), message="again"))
        options: dict[str, Any] = {
            "stopped": rng.choice(
                [None, None, "episode 2 failed-rate-limited", "3 consecutive failures"]
            )
        }
        if rng.random() < 0.25:
            options.update(
                skipped_complete=rng.random() < 0.5,
                series_id=rng.choice(["", "S2", None]),
                name=rng.choice([None, "", "Other"]),
                checked_ago_s=rng.choice([None, 30.0, 61.5, 7200.0]),
            )
            runs.append((None, results, options))
        else:
            runs.append((series, results, options))
    return runs


def js_report_options(options: dict[str, Any]) -> dict[str, Any]:
    names = {
        "skipped_complete": "skippedComplete",
        "stopped": "stopped",
        "series_id": "seriesId",
        "name": "name",
        "checked_ago_s": "checkedAgoS",
    }
    return {names[key]: value for key, value in options.items()}


def test_series_report_report_line_and_report_to_dict_match_on_a_table_of_runs() -> None:
    rng = random.Random(FUZZ_SEED)
    runs = generated_runs(rng, 400)
    calls = [
        call(
            "parity.seriesReportToDict",
            js_series(series) if series else None,
            [js_result(r) for r in results],
            js_report_options(options),
        )
        for series, results, options in runs
    ]
    values = js_values(calls)
    rows = []
    for index, ((series, results, options), value) in enumerate(zip(runs, values, strict=True)):
        report = engine.series_report(series, results, **options)
        rows.append((index, engine.report_to_dict(report), value))
    assert_same(rows)
    lines = [value["line"] for value in values]
    assert any(line.startswith("complete: ") for line in lines)
    assert any("paid episode" in line and line.startswith("complete: ") for line in lines)
    assert any(
        line.startswith("incomplete: ") and "missing from TikTok's list" in line for line in lines
    )


def test_report_line_matches_on_the_documented_lines_and_the_complete_skip_with_locked_episodes() -> (
    None
):
    base = engine.SeriesReport(
        "S1",
        "Name",
        4,
        3,
        0,
        1,
        0,
        (),
        True,
        False,
        None,
        total=4,
        locked_numbers=(4,),
        unlocked=1,
        unlocked_numbers=(3,),
    )
    reports = [
        base,  # complete: 3 of 4 (3 downloaded) - 1 paid episode your account unlocked (3), 1 locked (4)
        replace(base, unlocked=2, unlocked_numbers=(2, 3)),
        replace(base, unlocked=0, unlocked_numbers=(), locked=0, locked_numbers=()),
        replace(
            base,
            complete=False,
            failed=1,
            failed_numbers=(2,),
            done=2,
            stopped="cooldown until 14:32",
        ),
        replace(
            base,
            complete=False,
            listed=0,
            done=0,
            locked=0,
            locked_numbers=(),
            unlocked=0,
            unlocked_numbers=(),
        ),
        replace(base, complete=False, gaps=(5,), total=5, total_hint=5),
        replace(base, complete=False, gaps=tuple(range(5, 40, 2)), total=40),
        replace(base, complete=False, listed=6, total_hint=4, total=6, done=1),
        engine.SeriesReport(
            "S1", None, 0, 0, 30, 0, 0, (), True, True, None, total=30, checked_ago_s=7200.0
        ),
        engine.SeriesReport(
            "S1", None, 0, 0, 1, 0, 0, (), True, True, None, total=1, checked_ago_s=59.9
        ),
        # the complete skip of a series whose manifest recorded locked episodes: RECHECK_HINT
        engine.SeriesReport(
            "S1",
            "Name",
            0,
            0,
            4,
            1,
            0,
            (),
            True,
            True,
            None,
            total=4,
            locked_numbers=(4,),
            checked_ago_s=7200.0,
        ),
        engine.SeriesReport(
            "S1",
            "Name",
            0,
            0,
            3,
            2,
            0,
            (),
            True,
            True,
            None,
            total=3,
            locked_numbers=(4, 5),
            checked_ago_s=None,
        ),
        engine.SeriesReport(
            "S1",
            "Name",
            0,
            0,
            3,
            2,
            0,
            (),
            True,
            True,
            None,
            total=3,
            locked_numbers=(4, 5),
            checked_ago_s=3599.9999,
        ),
        replace(base, locked=12, locked_numbers=tuple(range(1, 40, 3)), complete=False),
    ]
    values = js_values([call("report.reportLine", js_report(report)) for report in reports])
    assert_same(
        [
            (index, engine.report_line(report), value)
            for index, (report, value) in enumerate(zip(reports, values, strict=True))
        ]
    )
    assert (
        values[0]
        == "complete: 3 of 4 (3 downloaded) \u2014 1 paid episode your account unlocked (3), 1 locked (4)"
    )
    assert values[10].endswith(f" \u2014 {engine.RECHECK_HINT}")


def test_batch_status_not_started_and_dedupe_match() -> None:
    report = engine.series_report(None, [], series_id="S1")
    runs = [
        engine.SeriesRun(
            SeriesRef("S1"), None, [], report, "boom", True, 4, error_kind="discovery"
        ),
        engine.SeriesRun(
            SeriesRef("S1"), None, [], report, "not started: x", False, 5, error_kind="not-started"
        ),
        engine.SeriesRun(
            SeriesRef("S1"), None, [], replace(report, skipped_complete=True), None, False, 0
        ),
        engine.SeriesRun(SeriesRef("S1"), None, [], replace(report, complete=True), None, False, 0),
        engine.SeriesRun(SeriesRef("S1"), None, [], report, None, False, 0),
        engine.SeriesRun(
            SeriesRef("S1"),
            Series("S1", "Listed", []),
            [],
            replace(report, name=None, stopped="429"),
            None,
            True,
            5,
        ),
        engine.SeriesRun(SeriesRef("S9"), None, [], replace(report, name=None), "", True, 5),
        engine.SeriesRun(
            SeriesRef("S9"), None, [], replace(report, name="R", stopped=None), None, True, 5
        ),
    ]
    shapes = [
        {
            "ref": {"seriesId": run.ref.series_id},
            "series": js_series(run.series) if run.series else None,
            "report": js_report(run.report),
            "error": run.error,
            "errorKind": run.error_kind,
        }
        for run in runs
    ]
    rng = random.Random(FUZZ_SEED)
    ref_lists = [
        [SeriesRef(rng.choice(["1", "2", "3", "4"])) for _ in range(rng.randint(0, 8))]
        for _ in range(100)
    ]
    calls = [call("report.batchStatus", shape) for shape in shapes]
    calls += [call("report.notStartedMessage", shape) for shape in shapes]
    calls += [
        call("report.dedupeRefs", [{"kind": "series", "seriesId": r.series_id} for r in refs])
        for refs in ref_lists
    ]
    values = js_values(calls)
    count = len(shapes)
    assert_same(
        [
            (index, cli.batch_status(run), value)
            for index, (run, value) in enumerate(zip(runs, values[:count], strict=True))
        ]
    )
    assert_same(
        [
            (index, engine.not_started_message(run), value)
            for index, (run, value) in enumerate(zip(runs, values[count : 2 * count], strict=True))
        ]
    )
    rows = []
    for refs, value in zip(ref_lists, values[2 * count :], strict=True):
        kept, notes = engine.dedupe_refs(refs)
        rows.append(
            (
                [r.series_id for r in refs],
                ([r.series_id for r in kept], notes),
                ([r["seriesId"] for r in value["kept"]], value["notes"]),
            )
        )
    assert_same(rows)


def test_the_text_box_follows_the_from_file_rules(tmp_path: Path) -> None:
    import argparse

    texts = [
        f"# my list\n\n{SERIES_ID}\nhttps://www.tiktok.com/shortdrama/episode/{SECOND_SERIES_ID}/3  # second\n",
        f"\ufeff{SERIES_ID}\r\n{SERIES_ID}\r{PAID_SERIES_ID}\n   \n\t# tab comment\n",
        f"  {SERIES_ID}\t#x\n{SERIES_ID}#not a comment\n",
        f"{SERIES_ID}\u3000# ideographic space before the hash\n\x85{PAID_SERIES_ID}\x85\n",
        "",
        "\n\n# only comments\n",
    ]
    parser = argparse.ArgumentParser()
    values = js_values([call("urls.parseSeriesList", text) for text in texts])
    rows = []
    for index, (text, value) in enumerate(zip(texts, values, strict=True)):
        path = tmp_path / f"list{index}.txt"
        path.write_text(text, encoding="utf-8", newline="")
        lines = cli._read_series_file(path, parser)
        expected_refs: list[SeriesRef] = []
        problems = 0
        for _, line in lines:
            try:
                ref = urls.parse_input(line)
            except UnsupportedUrlError:
                problems += 1
                continue
            assert isinstance(ref, SeriesRef)
            expected_refs.append(ref)
        kept, notes = engine.dedupe_refs(expected_refs)
        rows.append(
            (
                index,
                ([r.series_id for r in kept], notes, len(lines), problems),
                (
                    [r["seriesId"] for r in value["refs"]],
                    value["notes"],
                    value["lines"],
                    len(value["errors"]),
                ),
            )
        )
    assert_same(rows)


# --------------------------------------------------------------------------- cooldown


@pytest.fixture
def half_hour_time_zone() -> Any:
    """Local time five and a half hours ahead of UTC, for this process and the node it starts:
    the HH:MM of the cooldown texts must be the same local clock in both."""
    import os

    previous = os.environ.get("TZ")
    os.environ["TZ"] = "Asia/Kolkata"
    time.tzset()
    try:
        yield
    finally:
        if previous is None:
            del os.environ["TZ"]
        else:
            os.environ["TZ"] = previous
        time.tzset()


def js_cooldown(value: cooldown.Cooldown) -> dict[str, Any]:
    return {
        "until": value.until,
        "reason": value.reason,
        "source": value.source,
        "recordedAt": value.recorded_at,
    }


@pytest.mark.usefixtures("half_hour_time_zone")
def test_the_cooldown_texts_and_records_match() -> None:
    start = 1761200000.0
    cooldowns = [
        cooldown.Cooldown(
            start + 1800, f"episode 2 failed-blocked: {BLOCKED_MESSAGE}", "browser", start
        ),
        cooldown.Cooldown(start + 1800.5, "rate limited", "discovery", None),
        cooldown.Cooldown(start + 59, "r", "web", start - 1741),
        cooldown.Cooldown(start + 7.25, "", "", start + 3),
    ]
    nows = (
        start,
        start + 0.5,
        start + 59,
        start + 60,
        start + 61,
        start + 1799.2,
        start + 1800,
        start + 1801,
        start + 9999,
    )
    lift = f"delete {cooldown.cooldown_path()} to lift it, at your own risk"
    cases = [(item, now) for item in cooldowns for now in nows]
    calls: list[dict[str, Any]] = []
    for item, now in cases:
        calls += [
            call("cooldown.cooldownMessage", js_cooldown(item), {"now": now, "lift": lift}),
            call("cooldown.cooldownSummary", js_cooldown(item), {"now": now}),
            call("cooldown.secondsLeft", js_cooldown(item), now),
            call("cooldown.minutesLeft", js_cooldown(item), now),
            call("cooldown.isActive", js_cooldown(item), now),
            call("cooldown.cooldownStopReason", js_cooldown(item)),
        ]
    epochs = [start + step * 977.3 for step in range(-30, 60)] + [0.0, 59.999, 86399.5]
    calls += [call("cooldown.clockTime", epoch) for epoch in epochs]
    values = js_values(calls)
    rows = []
    for index, (item, now) in enumerate(cases):
        got = values[index * 6 : index * 6 + 6]
        expected = [
            cooldown.cooldown_message(item, now=now),
            cooldown.cooldown_summary(item, now=now),
            item.seconds_left(now),
            item.minutes_left(now),
            item.active(now),
            f"cooldown until {cooldown.clock_time(item.until)}",
        ]
        rows.append(((index, now), expected, got))
    rows += [
        (epoch, cooldown.clock_time(epoch), got)
        for epoch, got in zip(epochs, values[len(cases) * 6 :], strict=True)
    ]
    assert_same(rows)
    assert values[0].endswith(lift) and "(30 min left)" in values[0]


@pytest.mark.usefixtures("half_hour_time_zone")
def test_recording_and_reading_a_cooldown_match() -> None:
    start = 1761200000.25
    reasons = (
        "blocked",
        "  multi\n\nline\treason  ",
        "",
        "   ",
        "x" * 300,
        "\u00e9" * 250,
        "\U0001f600" * 250,
        "nel\x85sep\x1cx",
        "bom\ufeffkept",
    )
    made = js_values(
        [
            call("cooldown.makeCooldown", reason, "browser", {"now": start, "minutes": 30})
            for reason in reasons
        ]
    )
    rows = []
    for reason, value in zip(reasons, made, strict=True):
        recorded = cooldown.record_block(reason, "browser", now=start)
        stored = json.loads(cooldown.cooldown_path().read_text(encoding="utf-8"))
        rows.append((reason, (js_cooldown(recorded), stored), (value["cooldown"], value["record"])))
    assert_same(rows)
    raws: list[Any] = [
        {"until": start + 1800, "reason": "a", "source": "web", "recorded_at": start},
        {"until": "x"},
        {"until": True},
        {},
        [],
        "text",
        None,
        {"until": 5, "reason": 7, "source": None, "recorded_at": False},
        {"until": 1e300, "reason": "  a\n b ", "source": "web", "recorded_at": 3},
        {"until": 12.5, "reason": "", "recorded_at": "5"},
    ]
    parsed = js_values([call("cooldown.parseCooldown", raw) for raw in raws])
    rows = []
    for raw, value in zip(raws, parsed, strict=True):
        cooldown.cooldown_path().write_text(json.dumps(raw), encoding="utf-8")
        read = cooldown.read_cooldown()
        rows.append((raw, js_cooldown(read) if read is not None else None, value))
    assert_same(rows)


# --------------------------------------------------------------------------- pacing


class ScriptedRandom(random.Random):
    """A random source whose ``random()`` returns the given draws in turn (``uniform(a, b)`` is
    ``a + (b - a) * random()``, the same arithmetic as the extension's Rng)."""

    def __init__(self, draws: list[float]) -> None:
        super().__init__(0)
        self.draws = list(draws)

    def random(self) -> float:
        return self.draws.pop(0)


PACING_OPTIONS = (
    DownloadOptions(),
    DownloadOptions(pace="human"),
    DownloadOptions(rest_every=3, long_rest_every=5),
    DownloadOptions(rest_every=0, long_rest_every=0, max_consecutive_failures=0),
    DownloadOptions(
        delay_min_s=6.5, delay_max_s=6.5, rest_min_s=90.0, rest_max_s=90.0, pace="human"
    ),
)
PACING_STATES = (
    (0, None, 0),
    (3, 100.0, 1),
    (5, 100.0, 2),
    (100, 100.0, 0),
    (200, 50.0, 2),
    (99, 0.0, 0),
)
CLOCKS = (105.0, 999.9, 1000.0, 5100.0)
DRAWS = (0.0, 0.25, 0.5, 0.999)


def test_the_pause_before_every_attempt_and_between_series_match() -> None:
    previous_episodes = (
        None,
        Episode(1, "1", "t", "s"),
        Episode(1, "1", "t", "s", duration_s=3),
        Episode(1, "1", "t", "s", duration_s=120),
        Episode(1, "1", "t", "s", duration_s=400),
    )
    rng = random.Random(FUZZ_SEED)
    cases = []
    for options in PACING_OPTIONS:
        for state in PACING_STATES:
            for now in CLOCKS:
                for _ in range(6):
                    cases.append(
                        (
                            options,
                            state,
                            now,
                            rng.choice((0, 1, 3, 9, 10, 20)),
                            rng.choice(previous_episodes),
                            rng.choice(DRAWS),
                        )
                    )
    calls: list[dict[str, Any]] = []
    for options, (attempts, last, streak), now, made, previous, draw in cases:
        pacing = {
            "$pacing": {
                "runAttempts": attempts,
                "lastNetworkAt": last,
                "consecutiveFailures": streak,
            }
        }
        prev = {"durationS": previous.duration_s} if previous is not None else None
        calls += [
            call(
                "parity.pauseBeforeAttempt",
                js_pacing_options(options),
                {"$rng": [draw]},
                pacing,
                {"$clock": [now]},
                made,
                prev,
            ),
            call(
                "parity.pauseBetweenSeries",
                js_pacing_options(options),
                {"$rng": [draw]},
                pacing,
                {"$clock": [now]},
            ),
            call("parity.longRestDue", js_pacing_options(options), pacing, {"$clock": [now]}),
        ]
    values = js_values(calls)
    rows = []
    for index, (options, (attempts, last, streak), now, made, previous, draw) in enumerate(cases):
        got = values[index * 3 : index * 3 + 3]
        before = engine.PacingState(attempts, last, streak)
        kind, seconds = engine._pause_before_attempt(
            options, ScriptedRandom([draw]), before, lambda: now, made, previous
        )
        rows.append(
            (
                (index, "before"),
                ({"kind": kind, "seconds": seconds}, js_pacing(before)),
                (got[0]["pause"], got[0]["pacing"]),
            )
        )
        between = engine.PacingState(attempts, last, streak)
        pauses: list[tuple[str, float]] = []
        engine._pause_between_series(
            options,
            ScriptedRandom([draw]),
            between,
            lambda: now,
            lambda k, s: pauses.append((k, s)),
            lambda _s: None,
        )
        js_between = dict(got[1]["pacing"])
        if got[1]["pause"]["kind"] == engine.LONG_REST:
            js_between["runAttempts"] = 0  # the caller's duty once the break is slept
        js_pause = got[1]["pause"]
        rows.append(
            (
                (index, "series"),
                (pauses, js_pacing(between)),
                (
                    [(js_pause["kind"], js_pause["seconds"])] if js_pause["seconds"] > 0 else [],
                    js_between,
                ),
            )
        )
        due = engine.PacingState(attempts, last, streak)
        rows.append(
            (
                (index, "due"),
                (engine.long_rest_due(options, due, lambda: now), js_pacing(due)),
                (got[2]["due"], got[2]["pacing"]),
            )
        )
    assert_same(rows)
    kinds = {row[1][0]["kind"] for row in rows if row[0][1] == "before"}
    assert kinds == {engine.PACE, engine.REST, engine.LONG_REST}


def test_the_stop_rules_of_download_series_match(tmp_path: Path) -> None:
    """Scripted downloads through engine.download_series and the same results through the
    extension's afterResult: the same stop, the same summary, the same `stopped: \u2026` reason."""
    S = DownloadStatus
    scripts = [
        [
            (S.DONE, "ok"),
            (S.FAILED, "f1"),
            (S.FAILED_UNAVAILABLE, "f2"),
            (S.FAILED, "f3"),
            (S.DONE, "x"),
        ],
        [(S.FAILED, ""), (S.DONE, "ok"), (S.FAILED, "a"), (S.FAILED, "b"), (S.FAILED, "c")],
        [(S.DONE, "ok"), (S.FAILED_RATE_LIMITED, "rate limited (HTTP 429)"), (S.DONE, "x")],
        [(S.FAILED_BLOCKED, BLOCKED_MESSAGE), (S.DONE, "x")],
        [(S.FAILED_LOGIN, ""), (S.DONE, "x")],
        [(S.FAILED, "a"), (S.FAILED, "b"), (S.DONE, "ok"), (S.FAILED, "c"), (S.DONE, "y")],
    ]
    for index, script in enumerate(scripts):
        cooldown.clear_cooldown()
        episodes = [Episode(n, f"i{n}", f"t{n}", "S1") for n in range(1, len(script) + 1)]
        series = Series("S1", "Name", episodes)
        queue = list(script)

        class Scripted:
            def download(self, episode: Episode, options: DownloadOptions) -> DownloadResult:
                status, message = queue.pop(0)
                return DownloadResult(episode, status, message=message)

        stops: list[str] = []
        pacing = engine.PacingState()
        results = engine.download_series(
            series,
            episodes,
            DownloadOptions(out_dir=tmp_path / str(index)),
            downloader=Scripted(),
            sleep=lambda _s: None,
            rng=random.Random(1),
            pacing=pacing,
            clock=lambda: 50.0,
            on_stop=stops.append,
        )
        made = len(script) - len(queue)
        replay = js_values(
            [
                call(
                    "parity.afterResult",
                    js_pacing_options(DownloadOptions()),
                    {
                        "$pacing": {
                            "runAttempts": 0,
                            "lastNetworkAt": None,
                            "consecutiveFailures": 0,
                        }
                    },
                    {"$clock": [50.0]},
                    {"episode": {"number": n}, "status": status.value, "message": message},
                )
                for n, (status, message) in enumerate(script[:made], start=1)
            ]
        )
        # each replayed call starts from a fresh state: chain them the way download_series does
        streak = 0
        js_stop = None
        for n, (status, message) in enumerate(script[:made], start=1):
            chained = js_values(
                [
                    call(
                        "parity.afterResult",
                        js_pacing_options(DownloadOptions()),
                        {
                            "$pacing": {
                                "runAttempts": n - 1,
                                "lastNetworkAt": None,
                                "consecutiveFailures": streak,
                            }
                        },
                        {"$clock": [50.0]},
                        {"episode": {"number": n}, "status": status.value, "message": message},
                    )
                ]
            )[0]
            streak = chained["pacing"]["consecutiveFailures"]
            if chained["stop"] is not None:
                js_stop = chained["stop"]
                break
        assert replay  # every scripted result went through the extension's rule too
        stopped_rows = [r.message for r in results if r.message.startswith(engine.STOPPED_PREFIX)]
        if js_stop is None:
            assert stops == [] and stopped_rows == [], index
            continue
        assert stops == [js_stop["summary"]], index
        assert all(
            message == f"{engine.STOPPED_PREFIX}{js_stop['reason']}" for message in stopped_rows
        ), index
        assert js_stop["block"] == (results[made - 1].status in engine.BLOCK_STATUSES)


def test_the_pacing_checks_descriptions_and_announcements_match(
    capsys: pytest.CaptureFixture[str],
) -> None:
    invalid = [
        {"delay_min_s": -1.0},
        {"delay_max_s": 2.0},
        {"rest_min_s": -0.5},
        {"long_rest_max_s": 10.0},
        {"rest_every": -1},
        {"long_rest_every": -2},
        {"pace": "slow"},
        {"pace": "Human"},
        {"pace": ""},
        {"delay_min_s": 1234567.0, "delay_max_s": 1.5},
        {"delay_min_s": 0.00001, "delay_max_s": 0.0},
        {},
        {"pace": "human", "delay_min_s": 0.5, "delay_max_s": 0.5, "rest_every": 0},
    ]
    described = [
        *PACING_OPTIONS,
        DownloadOptions(max_consecutive_failures=1),
        DownloadOptions(rest_min_s=75.5, rest_max_s=75.5),
    ]
    announcements = [
        (engine.PACE, 7.4, 0, 0),
        (engine.PACE, 6.5, 0, 0),
        (engine.PACE, 0.25, 0, 0),
        (engine.PACE, 0.0, 0, 0),
        (engine.REST, 95.5, 10, 10),
        (engine.REST, 60.0, 3, 3),
        (engine.SERIES_REST, 120.0, 0, 7),
        (engine.LONG_REST, 1350.0, 4, 100),
        (engine.LONG_REST, 990.0, 0, 200),
        (engine.LONG_REST, 2.5 * 60, 1, 0),
    ]
    calls = [
        call(
            "pacing.pacingProblem",
            js_pacing_options(replace(DownloadOptions(), **change)),
            {"testMode": True},
        )
        for change in invalid
    ]
    calls += [call("pacing.describePacing", js_pacing_options(options)) for options in described]
    calls += [
        call("pacing.describeBatchPacing", js_pacing_options(options)) for options in described
    ]
    calls += [
        call("pacing.pauseMessage", kind, seconds, {"downloads": d, "runAttempts": a})
        for kind, seconds, d, a in announcements
    ]
    values = js_values(calls)
    rows = []
    for change, value in zip(invalid, values[: len(invalid)], strict=True):
        expected = outcome(engine.validate_pacing, replace(DownloadOptions(), **change))
        rows.append((change, expected[1] if expected[0] == "error" else None, value))
    offset = len(invalid)
    for options, value in zip(described, values[offset : offset + len(described)], strict=True):
        rows.append((options.pace, cli.describe_pacing(options), value))
    offset += len(described)
    for options, value in zip(described, values[offset : offset + len(described)], strict=True):
        rows.append((options.pace, cli.describe_batch_pacing(options), value))
    offset += len(described)
    for (kind, seconds, downloads, attempts), value in zip(
        announcements, values[offset:], strict=True
    ):
        printer = cli._RunPrinter(engine.PacingState(run_attempts=attempts))
        printer._downloads = downloads
        printer.pause(kind, seconds)
        printed = capsys.readouterr().err
        rows.append(((kind, seconds), printed.removeprefix("  \u2026 ").rstrip("\n"), value))
    assert_same(rows)


# --------------------------------------------------------------------------- the per-series state

STATE_NAMES = ("a.mp4", "b.mp4", "c.mp4", "d.mp4")
STATE_MESSAGES = (
    models.DRM_MESSAGE,
    f"{models.DRM_MESSAGE} (more)",
    models.DRM_REMEMBERED_MESSAGE,
    PAYLOAD_DRM_MESSAGE,
    f"{models.DRM_MARK} (isDrm=True): DramaFetch does not decrypt it",
    "looks locked: isLocked=True",
    "",
    "boom",
)


def state_plans() -> list[dict[str, Any]]:
    """Seeded sequences of record / mark complete / clear complete over five episodes."""
    plans = []
    for seed in range(160):
        rng = random.Random(seed)
        existing = rng.sample(STATE_NAMES, rng.randint(0, len(STATE_NAMES)))
        ops: list[dict[str, Any]] = []
        for step in range(rng.randint(1, 14)):
            roll = rng.random()
            if roll < 0.8:
                number = rng.randint(1, 5)
                ops.append(
                    {
                        "op": "record",
                        "number": number,
                        "status": rng.choice(list(DownloadStatus)).value,
                        "path": rng.choice((None, *STATE_NAMES)),
                        "message": rng.choice(STATE_MESSAGES),
                        "now": 1761200000 + step,
                    }
                )
            elif roll < 0.93:
                ops.append(
                    {
                        "op": "markComplete",
                        "when": rng.choice((1761200000.0, 1761200000.75, 1761203600.9999996)),
                        "episodes": rng.randint(0, 5),
                    }
                )
            else:
                ops.append({"op": "clearComplete"})
        plans.append({"existing": existing, "ops": ops})
    return plans


def js_state_op(op: dict[str, Any]) -> dict[str, Any]:
    if op["op"] != "record":
        return op
    result = {
        "episode": {"number": op["number"], "itemId": f"id{op['number']}"},
        "status": op["status"],
        "path": op["path"],
        "message": op["message"],
    }
    return {"op": "record", "result": result, "now": op["now"]}


def python_state(directory: Path, plan: dict[str, Any]) -> manifest.Manifest:
    directory.mkdir(parents=True)
    for name in plan["existing"]:
        (directory / name).write_bytes(b"video")
    kept = manifest.Manifest(directory, "S1", "Name")
    for op in plan["ops"]:
        if op["op"] == "record":
            episode = Episode(op["number"], f"id{op['number']}", "t", "S1")
            path = directory / op["path"] if op["path"] else None
            kept.record(
                DownloadResult(
                    episode, DownloadStatus(op["status"]), path=path, message=op["message"]
                )
            )
        elif op["op"] == "markComplete":
            kept.mark_complete(op["when"], op["episodes"])
        else:
            kept.clear_complete()
    return kept


def entries_of(episodes: dict[str, Any]) -> dict[int, tuple[Any, ...]]:
    return {
        int(key): (e["number"], e["item_id"], e["status"], e["path"], e["message"])
        for key, e in episodes.items()
    }


def test_the_state_follows_the_manifest_rules(tmp_path: Path) -> None:
    plans = state_plans()
    numbers = [1, 2, 3, 4, 5, 6]
    values = js_values(
        [
            call(
                "parity.stateRun",
                {
                    "seriesId": "S1",
                    "seriesName": "Name",
                    "ops": [js_state_op(op) for op in plan["ops"]],
                    "existing": plan["existing"],
                    "numbers": numbers,
                },
            )
            for plan in plans
        ]
    )
    saved = []
    rows = []
    for index, (plan, value) in enumerate(zip(plans, values, strict=True)):
        directory = tmp_path / f"series{index}"
        kept = python_state(directory, plan)
        on_disk = (
            json.loads(manifest.manifest_path(directory).read_text(encoding="utf-8"))
            if kept.entries or kept.complete_at
            else None
        )
        saved.append(on_disk)
        expected = {
            "entries": {
                n: (e.number, e.item_id, e.status, e.path, e.message)
                for n, e in kept.entries.items()
            },
            "complete": (kept.complete_at, kept.complete_episodes),
            "doneEntries": [[n, path.name] for n, path in kept.done_entries()],
            "missingFiles": kept.missing_files(),
            "lockedNumbers": kept.locked_numbers(),
            "drmProtected": [kept.drm_protected(n) for n in numbers],
            "isDone": [kept.is_done(n) for n in numbers],
            "completeSince": kept.complete_since(),
        }
        state = value["state"]
        got = {
            "entries": entries_of(state["episodes"]),
            "complete": (state["complete_at"], state["complete_episodes"]),
            "doneEntries": value["doneEntries"],
            "missingFiles": value["missingFiles"],
            "lockedNumbers": value["lockedNumbers"],
            "drmProtected": value["drmProtected"],
            "isDone": value["isDone"],
            "completeSince": value["completeSince"],
        }
        rows.append((index, expected, got))
        # what the extension stores reads back as itself
        rows.append(
            (
                (index, "reread"),
                entries_of(state["episodes"]),
                entries_of(value["reread"]["episodes"]),
            )
        )
    assert_same(rows)
    assert sum(1 for value in values if any(value["drmProtected"])) >= 20
    assert sum(1 for value in values if value["state"]["complete_at"]) >= 20
    # the Python tool's dramafetch.json is a state the extension reads as the Python tool does
    readable = [(index, raw) for index, raw in enumerate(saved) if raw is not None]
    reread = js_values([call("state.readState", raw, "S1") for _, raw in readable])
    rows = []
    for (index, raw), value in zip(readable, reread, strict=True):
        read = manifest.read_manifest(tmp_path / f"series{index}", "S1")
        assert read is not None
        expected = (
            {
                n: (e.number, e.item_id, e.status, e.path, e.message)
                for n, e in read.entries.items()
            },
            read.complete_at,
            read.complete_episodes,
            read.series_name,
        )
        rows.append(
            (
                index,
                expected,
                (
                    entries_of(value["episodes"]),
                    value["complete_at"],
                    value["complete_episodes"],
                    value["series_name"],
                ),
            )
        )
    assert_same(rows)


def test_report_rows_and_the_complete_skip_match(tmp_path: Path) -> None:
    """report_rows over a manifest, and the complete skip (24 h, every file still there, the
    locked entries reported with RECHECK_HINT) over the same manifest, both through the state."""
    rng = random.Random(FUZZ_SEED)
    out_dir = tmp_path / "out"
    cases = []
    for index in range(60):
        series_id = f"77{index:017d}"
        directory = out_dir / f"Name {index} [{series_id}]"
        directory.mkdir(parents=True)
        kept = manifest.Manifest(directory, series_id, f"Name {index}")
        episodes = [
            report_episode(n, rng.choice(["free", "unlocked", "locked"])) for n in range(1, 7)
        ]
        episodes = [replace(e, series_id=series_id) for e in episodes]
        statuses = (
            DownloadStatus.DONE,
            DownloadStatus.SKIPPED_EXISTS,
            DownloadStatus.SKIPPED_LOCKED,
            DownloadStatus.FAILED_UNAVAILABLE,
            DownloadStatus.FAILED,
        )
        for episode in episodes:
            if rng.random() < 0.8:
                status = rng.choice(statuses)
                path = directory / f"E{episode.number:02d}.mp4"
                if (
                    status in (DownloadStatus.DONE, DownloadStatus.SKIPPED_EXISTS)
                    and rng.random() < 0.9
                ):
                    path.write_bytes(b"v")
                message = (
                    rng.choice(STATE_MESSAGES) if status is not DownloadStatus.DONE else "saved"
                )
                kept.record(
                    DownloadResult(
                        episode, status, path=path if status.ok else None, message=message
                    )
                )
        on_disk = [n for n, _ in kept.done_entries()]
        if rng.random() < 0.8:
            kept.mark_complete(1761200000.0, rng.choice([len(on_disk), len(on_disk) + 1, 0]))
        series = Series(series_id, f"Name {index}", episodes)
        covered = rng.sample(episodes, rng.randint(0, 3))
        results = [
            locked_result(e) if e.locked else DownloadResult(e, DownloadStatus.DONE, message="d")
            for e in covered
        ]
        cases.append(
            (
                series_id,
                directory,
                series,
                results,
                rng.choice([-5.0, 0.0, 3600.0, 86399.0, 86400.0]),
            )
        )
    calls: list[dict[str, Any]] = []
    for series_id, directory, series, results, age in cases:
        raw = json.loads(manifest.manifest_path(directory).read_text(encoding="utf-8"))
        present = sorted(str(Path(p.name)) for p in directory.iterdir() if p.suffix == ".mp4")
        calls.append(
            call(
                "parity.reportRows",
                js_series(series),
                [js_result(r) for r in results],
                raw,
                series_id,
                {"$exists": present},
            )
        )
        calls.append(
            call(
                "parity.completeSkip",
                raw,
                {"seriesId": series_id, "nowS": 1761200000.0 + age},
                {"$exists": present},
            )
        )
    values = js_values(calls)
    rows = []
    for index, (series_id, directory, series, results, age) in enumerate(cases):
        read = manifest.read_manifest(directory, series_id)
        expected_rows = [
            (r.episode.number, r.status.value, r.message, r.path.name if r.path else None)
            for r in engine.report_rows(series, results, read)
        ]
        got_rows = [
            (
                r["episode"]["number"],
                r["status"],
                r["message"],
                Path(r["path"]).name if r["path"] else None,
            )
            for r in values[index * 2]
        ]
        rows.append(((index, "rows"), expected_rows, got_rows))
        options = DownloadOptions(out_dir=out_dir)
        skipped = engine._skip_if_complete(
            SeriesRef(series_id), options, lambda age=age: 1761200000.0 + age
        )
        got = values[index * 2 + 1]
        if skipped is None:
            rows.append(((index, "skip"), None, got))
            continue
        run, start = skipped
        expected = {
            "results": [
                (r.episode.number, r.episode.item_id, r.episode.title, r.status.value, r.message)
                for r in run.results
            ],
            "report": engine.report_to_dict(run.report),
            "name": start.name,
        }
        rows.append(((index, "skip"), expected, got))
    assert_same(rows)
    assert sum(1 for value in values[1::2] if value is not None) >= 5
    assert any(
        value is not None and engine.RECHECK_HINT in value["report"]["line"]
        for value in values[1::2]
    )


# --------------------------------------------------------------------------- Python's text rules


def test_the_python_text_helpers_match() -> None:
    texts = [value for value in FUZZ_SCALARS if isinstance(value, str)] + list(NAMES) + list(INPUTS)
    texts += [
        "\x1c\x1d x \x1e\x1f",
        "\x85\u2028\u2029\u3000a\u3000",
        "'",
        '"',
        "'\"",
        "\\",
        "\ud800",
        "\U0010ffff",
    ]
    floats = [
        0.0,
        -0.0,
        4.0,
        9.0,
        0.5,
        1234567.0,
        999999.5,
        1e-05,
        0.0001,
        123456.0,
        1e16,
        2.5e-07,
        100.0,
        60.25,
        -2.5,
        1 / 3,
        15.0,
        30.0,
        0.00012345678,
    ]
    fixed = [
        (x, digits)
        for x in (
            6.5,
            7.5,
            0.25,
            0.75,
            2.675,
            1.5,
            0.5,
            95.4,
            22.5,
            -2.5,
            0.05,
            1e-07,
            1350.0,
            59.9999,
        )
        for digits in (0, 1, 2)
    ]
    fractions = [0.5, 1e-05, 2.5e-07, 0.0001, 123.456, 1 / 3, 1e-300, 4.5e15 + 0.5, -0.25]
    decimals = [
        "12",
        "-12",
        "--1",
        "+1",
        "-",
        "",
        "\u0663\u0664",
        "\u00b2",
        "1\u00b2",
        "\uff11\uff12",
        "1_0",
        "\U0001d7ce\U0001d7cf",
        "7" * 4301,
        "0",
        "-0",
    ]
    calls = [call("messages.pyStrip", text) for text in texts]
    calls += [call("messages.pyRepr", text) for text in texts]
    calls += [call("messages.pyFormatG", x) for x in floats]
    calls += [call("messages.pyFormatFixed", x, digits) for x, digits in fixed]
    calls += [call("messages.pyNumberText", x) for x in fractions]
    calls += [call("messages.pyDecimalInt", text) for text in decimals]
    values = js_values(calls)
    expected = [text.strip() for text in texts] + [repr(text) for text in texts]
    expected += [f"{x:g}" for x in floats] + [f"{x:.{digits}f}" for x, digits in fixed]
    expected += [repr(x) for x in fractions]

    def python_int(text: str) -> int | None:
        if not text.lstrip("-").isdigit():
            return None
        try:
            return int(text)
        except ValueError:
            return None

    expected += [python_int(text) for text in decimals]
    inputs = [*texts, *texts, *floats, *fixed, *fractions, *decimals]
    assert_same([(inp, py, js) for inp, py, js in zip(inputs, expected, values, strict=True)])
