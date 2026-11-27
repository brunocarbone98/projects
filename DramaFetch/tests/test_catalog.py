"""catalog: pure parsing of item_list/detail payloads, on the two fixtures and on edge cases."""

from __future__ import annotations

import copy
import json
import random
from dataclasses import replace
from pathlib import Path

import pytest

from dramafetch.catalog import (
    LEFT_OUT_HIGHLIGHT,
    LEFT_OUT_LATER,
    LEFT_OUT_LOCKED,
    LEFT_OUT_REASONS,
    LEFT_OUT_SHORTER,
    MAX_EXACT_INT,
    NO_PLAY_ADDRESS,
    SHORT_HEADER_HINT_PREFIX,
    SHORT_HEADER_MIN_GAP_S,
    SHORT_HEADER_RATIO,
    SKIP_NO_ID,
    SKIP_NO_NUMBER,
    SKIP_OTHER_DRAMA,
    SKIP_REASONS,
    UNCERTAIN_TEXT,
    VIDEO_ONLY_PATH_SUFFIX,
    AccessDecision,
    CountCheck,
    Duplicate,
    Listing,
    PagePayload,
    Rendition,
    access_of,
    catalog_warnings,
    choose_rendition,
    codec_name,
    count_check,
    cover_url_of,
    episode_from_item,
    fill_target,
    find_item_lists,
    is_drm_key,
    is_highlight,
    is_video_only_url,
    item_key,
    item_total_hint,
    key_words,
    listed_sizes,
    lock_hints,
    merge_episodes,
    merge_pages,
    missing_numbers,
    ordered_renditions,
    page_ends_list,
    parse_detail_payload,
    parse_item_list_payload,
    play_url_candidates,
    renditions,
    skip_reason,
    uncertain_text,
    url_expiry,
)
from dramafetch.models import (
    ACCESS_MODES,
    DRM_MARK,
    DRM_MESSAGE,
    QUALITY_MODES,
    Episode,
    SkippedItem,
)

SERIES_ID = "7699393770256782354"
OTHER_SERIES_ID = "7600000000000000000"
NAME = "The Billionaire's Secret Heiress"
COVER_CDN = "https://p16-sign-sg.tiktokcdn.com/"


def _episode(number, item_id=None, hints=(), title="t"):
    return Episode(
        number=number,
        item_id=item_id or f"id-{number}",
        title=title,
        series_id=SERIES_ID,
        lock_hints=tuple(hints),
    )


# --------------------------------------------------------------------------- find_item_lists


def test_find_item_lists_top_level_and_nested(item_list_pages):
    page1, page2 = item_list_pages
    lists1 = find_item_lists(page1)
    assert len(lists1) == 1
    assert len(lists1[0]) == 4
    lists2 = find_item_lists(page2)  # nested under "data"
    assert len(lists2) == 1
    assert [item["id"] for item in lists2[0]][:2] == ["7699400000000000002", "7699400000000000004"]


def test_find_item_lists_drops_non_dict_entries_and_respects_depth():
    assert find_item_lists({"a": {"itemList": [{"id": "1"}, "junk", 3]}}) == [[{"id": "1"}]]
    deep = {"itemList": [{"id": "x"}]}
    for _ in range(20):
        deep = {"level": deep}
    assert find_item_lists(deep) == []
    assert find_item_lists(deep, max_depth=50) == [[{"id": "x"}]]
    assert find_item_lists(None) == []
    assert find_item_lists("text") == []
    assert find_item_lists([{"itemList": []}, {"item_list": [{"id": "2"}]}]) == [[], [{"id": "2"}]]


# --------------------------------------------------------------------------- fixtures


def test_page1_parses_three_episodes_and_skips_the_trailer(item_list_pages):
    page = parse_item_list_payload(item_list_pages[0], SERIES_ID)
    assert isinstance(page, PagePayload)
    assert [e.number for e in page.episodes] == [1, 2, 3]
    assert page.cursor == 3
    assert page.has_more is True
    assert page.seen_items == 4
    assert page.skipped_items == 1
    first = page.episodes[0]
    assert first.item_id == "7699400000000000001"
    assert first.title == f"{NAME} | Episode 1"
    assert first.series_id == SERIES_ID
    assert first.series_name == NAME
    assert first.author == "muffindrama_us"
    assert first.duration_s == 92
    assert first.lock_hints == ()
    assert not first.locked
    assert first.raw is item_list_pages[0]["itemList"][0]
    assert first.page_url == "https://www.tiktok.com/@muffindrama_us/video/7699400000000000001"
    # the cover: originCover (the full frame) wins over cover (the cropped poster)
    assert first.cover_url == first.raw["video"]["originCover"]
    assert first.cover_url is not None
    assert first.cover_url.startswith(COVER_CDN) and "~tplv-tiktokx-origin.jpeg" in first.cover_url
    second = page.episodes[1]  # episode 2 carries no originCover: the cropped cover is next
    assert second.cover_url == second.raw["video"]["cover"]
    assert second.cover_url is not None and "cropcenter:300:400" in second.cover_url


def test_page2_nested_list_drops_the_other_series(item_list_pages):
    page = parse_item_list_payload(item_list_pages[1], SERIES_ID)
    assert [e.number for e in page.episodes] == [2, 4, 5]
    assert page.cursor == 6
    assert page.has_more is False
    assert page.seen_items == 4
    assert page.skipped_items == 1
    assert all(e.series_id == SERIES_ID for e in page.episodes)
    assert "7699400000000000777" not in {e.item_id for e in page.episodes}


def test_merging_the_fixture_pages_gives_episodes_1_to_5(item_list_pages):
    pages = [parse_item_list_payload(p, SERIES_ID).episodes for p in item_list_pages]
    merged = merge_episodes(pages)
    assert [e.number for e in merged] == [1, 2, 3, 4, 5]
    assert len({e.item_id for e in merged}) == 5
    # the duplicate episode 2 on page 2 lost: the first occurrence wins
    assert merged[1].title == f"{NAME} | Episode 2"
    assert [e.locked for e in merged[:4]] == [False, False, False, False]
    locked = merged[4]
    assert locked.locked
    assert "isFree=false" in locked.lock_hints
    assert "isLocked=True" in locked.lock_hints
    assert "unlockPrice=30" in locked.lock_hints
    assert "no play address" in locked.lock_hints
    assert catalog_warnings(merged, 5) == ["1 episode looks locked"]
    # every episode, the locked one included, has a cover on TikTok's image CDN, and the cover
    # fields never read as lock hints
    assert all(e.cover_url is not None and e.cover_url.startswith(COVER_CDN) for e in merged)
    assert len({e.cover_url for e in merged}) == 5
    assert not any("cover" in hint.lower() for e in merged for hint in e.lock_hints)


# --------------------------------------------------------------------------- merge


def test_merge_dedupes_by_item_id_then_number_first_wins():
    a = _episode(2, "a", title="from page 1")
    b = _episode(2, "b", title="same number, other id")
    assert merge_episodes([[a], [b]]) == [a]
    assert merge_episodes([[b], [a]]) == [b]
    same_id_twice = merge_episodes(
        [[_episode(1, "x", title="first")], [_episode(1, "x", title="later")]]
    )
    assert [e.title for e in same_id_twice] == ["first"]
    assert [e.number for e in merge_episodes([[_episode(3)], [_episode(1)], []])] == [1, 3]
    assert merge_episodes([]) == []


# --------------------------------------------------------------------------- lock_hints


def test_lock_hints_are_recursive_in_drama_info_shallow_in_video_and_ordered():
    item = {
        "video": {"playAddr": "", "bitrateInfo": [], "previewUrl": "x"},
        "dramaInfo": {
            "dramaID": SERIES_ID,
            "DramaVideoData": {
                "isFree": False,
                "isLocked": True,
                "unlockPrice": 30,
                "nested": {"needPay": 1, "coinCount": 0},
            },
        },
    }
    assert lock_hints(item) == (
        "isFree=false",
        "isLocked=True",
        "unlockPrice=30",
        "needPay=1",
        "no play address",  # `previewUrl` in video: `preview` is no lock word since 2026-11-06
    )
    assert lock_hints(item) == lock_hints(copy.deepcopy(item))


def test_lock_hints_free_playable_and_edge_cases():
    free = {
        "video": {"playAddr": "https://v/x", "bitrateInfo": []},
        "dramaInfo": {"DramaVideoData": {"isFree": True, "unlockPrice": 0}},
    }
    assert lock_hints(free) == ()
    # bitrateInfo alone counts as a play address
    assert lock_hints({"video": {"playAddr": "", "bitrateInfo": [{"PlayAddr": {}}]}}) == ()
    # no video object at all
    assert lock_hints({"id": "1"}) == ("no play address",)
    # string flags (a sold item with a real play URL: no "no play address" hint)
    strings = {
        "video": {"playAddr": "https://v/x"},
        "dramaInfo": {"isPaid": "true", "isFree": "false"},
    }
    assert lock_hints(strings) == ("isPaid=true", "isFree=false")
    # containers are scanned, never reported as values; None is ignored
    nested = {"video": {"playAddr": "u"}, "dramaInfo": {"lockInfo": {"status": 1}, "vip": None}}
    assert lock_hints(nested) == ()
    # the bitrateInfo entries of video are NOT scanned (shallow)
    deep_video = {"video": {"playAddr": "u", "bitrateInfo": [{"PlayAddr": {"isLocked": True}}]}}
    assert lock_hints(deep_video) == ()
    # long values are truncated
    long_value = {"video": {"playAddr": "https://v/x"}, "dramaInfo": {"unlockToken": "a" * 100}}
    (hint,) = lock_hints(long_value)
    assert hint.startswith("unlockToken=aaaa")
    assert len(hint) < 60


# --------------------------------------------------------------------------- episode_from_item


def _base_item():
    return {
        "id": "1",
        "desc": "  Title  ",
        "author": {"uniqueId": "a"},
        "video": {"duration": "95", "playAddr": "u"},
        "dramaInfo": {
            "dramaID": SERIES_ID,
            "dramaName": NAME,
            "DramaVideoData": {"EpisodeNumber": "7"},
        },
    }


def test_episode_from_item_reads_numeric_strings_and_strips_the_title():
    episode = episode_from_item(_base_item(), SERIES_ID)
    assert episode is not None
    assert episode.number == 7
    assert episode.title == "Title"
    assert episode.duration_s == 95
    assert episode.author == "a"
    assert episode.series_name == NAME
    assert episode.raw == _base_item()


def test_episode_from_item_accepts_item_struct_wrapper_and_int_ids():
    wrapped = {"itemStruct": {**_base_item(), "id": 123}}
    episode = episode_from_item(wrapped, SERIES_ID)
    assert episode is not None
    assert episode.item_id == "123"
    assert episode.number == 7


def test_episode_from_item_filters_other_series_in_every_spelling():
    for key in ("dramaID", "dramaId", "DramaID", "albumId"):
        other = _base_item()
        other["dramaInfo"] = {key: OTHER_SERIES_ID, "DramaVideoData": {"EpisodeNumber": 1}}
        assert episode_from_item(other, SERIES_ID) is None, key
        same = _base_item()
        same["dramaInfo"] = {key: int(SERIES_ID), "DramaVideoData": {"EpisodeNumber": 1}}
        assert episode_from_item(same, SERIES_ID) is not None, key
    no_id = _base_item()
    del no_id["dramaInfo"]["dramaID"]
    assert episode_from_item(no_id, SERIES_ID) is not None


def test_episode_from_item_skips_missing_or_invalid_numbers():
    for bad in (None, "x", 0, -1, True, 2.5, {}, ""):
        item = _base_item()
        item["dramaInfo"]["DramaVideoData"]["EpisodeNumber"] = bad
        assert episode_from_item(item, SERIES_ID) is None, repr(bad)
    trailer = _base_item()
    del trailer["dramaInfo"]["DramaVideoData"]
    assert episode_from_item(trailer, SERIES_ID) is None
    no_drama_info = _base_item()
    del no_drama_info["dramaInfo"]
    assert episode_from_item(no_drama_info, SERIES_ID) is None
    no_item_id = {"desc": "x", "dramaInfo": {"DramaVideoData": {"EpisodeNumber": 1}}}
    assert episode_from_item(no_item_id, SERIES_ID) is None


def test_episode_from_item_accepts_float_and_alternative_number_keys():
    item = _base_item()
    item["dramaInfo"]["DramaVideoData"] = {"episodeNumber": 3.0}
    episode = episode_from_item(item, SERIES_ID)
    assert episode is not None
    assert episode.number == 3
    flat = _base_item()
    flat["dramaInfo"] = {"EpisodeNumber": 9}
    episode = episode_from_item(flat, SERIES_ID)
    assert episode is not None
    assert episode.number == 9


def test_episode_title_fallbacks_and_missing_optionals():
    item = {
        "id": "1",
        "desc": "   ",
        "dramaInfo": {"dramaName": NAME, "DramaVideoData": {"EpisodeNumber": 4}},
    }
    episode = episode_from_item(item, SERIES_ID)
    assert episode is not None
    assert episode.title == f"{NAME} E4"
    item["dramaInfo"].pop("dramaName")
    episode = episode_from_item(item, SERIES_ID)
    assert episode is not None
    assert episode.title == "Episode 4"
    assert episode.series_name is None
    assert episode.author is None
    assert episode.duration_s is None
    assert episode.cover_url is None
    assert episode.page_url == "https://www.tiktok.com/@_/video/1"
    assert episode.lock_hints == ("no play address",)


# --------------------------------------------------------------------------- cover_url_of


def test_cover_url_precedence_origin_then_cover_then_dynamic():
    item = _base_item()
    item["video"].update(
        {
            "dynamicCover": "https://p16-sign-sg.tiktokcdn.com/obj/d~tplv-tiktokx-origin.image?x=1",
            "cover": "https://p16-sign-sg.tiktokcdn.com/c~tplv-tiktokx-cropcenter:300:400.jpeg?x=1",
            "originCover": "https://p16-sign-sg.tiktokcdn.com/o~tplv-tiktokx-origin.jpeg?x=1",
        }
    )
    assert cover_url_of(item) == item["video"]["originCover"]
    del item["video"]["originCover"]
    assert cover_url_of(item) == item["video"]["cover"]
    del item["video"]["cover"]
    assert cover_url_of(item) == item["video"]["dynamicCover"]
    del item["video"]["dynamicCover"]
    assert cover_url_of(item) is None
    episode = episode_from_item(_base_item(), SERIES_ID)
    assert episode is not None and episode.cover_url is None


def test_cover_url_accepts_lists_url_list_dicts_and_the_item_struct_wrapper():
    as_dict = _base_item()
    as_dict["video"]["originCover"] = {"UrlList": ["https://p16/a.jpeg", "https://p16/b.jpeg"]}
    assert cover_url_of(as_dict) == "https://p16/a.jpeg"
    as_list = _base_item()
    as_list["video"]["cover"] = ["", "https://p16/c.jpeg"]
    assert cover_url_of(as_list) == "https://p16/c.jpeg"
    snake = _base_item()
    snake["video"]["cover"] = {"url_list": [" https://p16/d.jpeg "]}
    assert cover_url_of(snake) == "https://p16/d.jpeg"
    wrapped = {"itemStruct": {**_base_item()}}
    wrapped["itemStruct"]["video"]["cover"] = "https://p16/e.jpeg"
    assert cover_url_of(wrapped) == "https://p16/e.jpeg"
    episode = episode_from_item(wrapped, SERIES_ID)
    assert episode is not None and episode.cover_url == "https://p16/e.jpeg"
    # an empty or junk originCover does not hide a usable cover
    skipped = _base_item()
    skipped["video"].update({"originCover": "", "cover": "https://p16/f.jpeg"})
    assert cover_url_of(skipped) == "https://p16/f.jpeg"
    junk = _base_item()
    junk["video"].update({"originCover": {"UrlList": [1, None]}, "cover": ["ftp://x", "nope"]})
    assert cover_url_of(junk) is None


def test_cover_url_never_raises_on_junk():
    for junk in (None, "x", 1, [], {}, {"video": None}, {"video": "s"}, {"video": {}}):
        assert cover_url_of(junk) is None
    assert cover_url_of({"video": {"cover": 7, "originCover": None, "dynamicCover": {}}}) is None
    deep = "https://p16/deep.jpeg"
    for _ in range(10):
        deep = [deep]
    assert cover_url_of({"video": {"cover": deep}}) is None  # depth-limited like play URLs


# --------------------------------------------------------------------------- parse payload


def test_parse_payload_odd_shapes():
    empty = parse_item_list_payload({"itemList": [], "hasMore": False, "statusCode": 0}, SERIES_ID)
    assert empty.episodes == []
    assert empty.cursor is None
    assert empty.has_more is False
    assert empty.seen_items == 0
    assert parse_item_list_payload(None, SERIES_ID).episodes == []
    assert parse_item_list_payload("<html>", SERIES_ID).seen_items == 0
    nested = {
        "data": {
            "page": {
                "cursor": "30",
                "has_more": "true",
                "itemList": [{"id": "9", "dramaInfo": {"DramaVideoData": {"EpisodeNumber": 9}}}],
            }
        }
    }
    page = parse_item_list_payload(nested, SERIES_ID)
    assert page.cursor == "30"
    assert page.has_more is True
    assert [e.number for e in page.episodes] == [9]
    assert parse_item_list_payload({"hasMore": 1, "itemList": []}, SERIES_ID).has_more is True
    assert parse_item_list_payload({"hasMore": "no", "itemList": []}, SERIES_ID).has_more is False
    assert parse_item_list_payload({"cursor": 12.0, "itemList": []}, SERIES_ID).cursor == 12
    assert parse_item_list_payload({"cursor": True, "itemList": []}, SERIES_ID).cursor is None


def test_cursor_is_not_taken_from_inside_items():
    payload = {
        "itemList": [
            {"id": "1", "cursor": 99, "dramaInfo": {"DramaVideoData": {"EpisodeNumber": 1}}}
        ]
    }
    assert parse_item_list_payload(payload, SERIES_ID).cursor is None


# --------------------------------------------------------------------------- warnings


def test_catalog_warnings_gaps_duplicates_total_and_locked():
    episodes = [_episode(n, f"id-{n}-{i}") for i, n in enumerate((1, 2, 3, 5, 8, 8))]
    # a list that still holds two items with one number: the duplicate is found by the merge's
    # rules (alike in every rule: the first listed stays) and named with both items
    assert catalog_warnings(episodes, 10) == [
        "episode 4 missing (gap)",
        "episodes 6-7 missing (gap)",
        "duplicate episode number 8: item id-8-5 left out (listed later), item id-8-4 kept",
        "TikTok announces 10 episodes, 5 listed",
    ]
    assert catalog_warnings([_episode(3), _episode(4)], None) == ["episodes 1-2 missing (gap)"]
    assert catalog_warnings([], None) == []
    assert catalog_warnings([], 3) == ["TikTok announces 3 episodes, 0 listed"]
    locked = [_episode(1, hints=("isLocked=True",)), _episode(2, hints=("x",))]
    assert catalog_warnings(locked, 2) == ["2 episodes look locked"]
    assert catalog_warnings([_episode(1)], 1) == []
    assert catalog_warnings([_episode(1), _episode(2)], 1) == [
        "TikTok announces 1 episodes, 2 listed"
    ]


# --------------------------------------------------------------------------- detail


def test_parse_detail_payload_shapes():
    assert parse_detail_payload({"dramaInfo": {"dramaName": NAME, "totalEpisode": 5}}) == (NAME, 5)
    nested = {
        "statusCode": 0,
        "title": "TikTok",
        "data": {"detail": {"name": "Inner", "episodeCount": "12"}},
    }
    assert parse_detail_payload(nested) == ("Inner", 12)
    assert parse_detail_payload({"title": "Top", "total": 3}) == ("Top", 3)
    assert parse_detail_payload({"dramaInfo": {"dramaName": "", "totalEpisodes": 0}}) == (
        None,
        None,
    )
    assert parse_detail_payload(None) == (None, None)
    assert parse_detail_payload("junk") == (None, None)
    assert parse_detail_payload([{"drama": {"dramaName": "L", "episodeTotal": 2}}]) == ("L", 2)
    # name from one container, total from another
    split = {"drama": {"dramaName": "Split"}, "detail": {"totalEpisode": 40}}
    assert parse_detail_payload(split) == ("Split", 40)


# --------------------------------------------------------------------------- play URLs

CDN = "https://v16-webapp-prime.tiktok.com/video/tos/useast2a"


def _entry(codec, bitrate, *urls):
    return {"Bitrate": bitrate, "CodecType": codec, "PlayAddr": {"UrlList": list(urls)}}


def test_play_url_candidates_on_the_fixtures(item_list_pages):
    page1 = item_list_pages[0]["itemList"]
    # episode 1 lists its 720p H.264 URL under bitrateInfo and playAddr (one candidate) and a
    # higher-bitrate 1080p bytevc1 rendition: compatible takes the H.264 first, best the bytevc1
    h264 = f"{CDN}/abc/?a=1988&expire=1761200000"
    bytevc1 = f"{CDN}/abc-1080/?a=1988&expire=1761200000"
    assert play_url_candidates(page1[0]) == [h264, bytevc1]
    assert play_url_candidates(page1[0], "compatible") == [h264, bytevc1]
    assert play_url_candidates(page1[0], "best") == [bytevc1, h264]
    assert play_url_candidates(page1[1]) == [f"{CDN}/def/"]
    assert play_url_candidates(page1[2]) == []  # the trailer has an empty playAddr
    locked = item_list_pages[1]["data"]["itemList"][2]
    assert play_url_candidates(locked) == []
    assert play_url_candidates(item_list_pages[1]["data"]["itemList"][1]) == [f"{CDN}/jkl/"]


def test_play_url_candidates_order_h264_by_bitrate_then_other_codecs_then_play_addr():
    item = {
        "video": {
            "playAddr": {"UrlList": ["https://c/play", "https://c/h264-hi"]},
            "bitrateInfo": [
                _entry("h265", 2_000_000, "https://c/h265-hi"),
                _entry("h264", 500_000, "https://c/h264-lo", "https://c/h264-lo-b"),
                _entry("bytevc1", 3_000_000, "https://c/bytevc1"),
                _entry("AVC1", 1_000_000, "https://c/h264-hi"),
                _entry("H.264", "1500000", "https://c/h264-str"),  # numeric string bitrate
                _entry("h264", 1_000_000, "https://c/h264-hi"),  # repeated URL: first position
            ],
        }
    }
    assert play_url_candidates(item) == [
        "https://c/h264-str",
        "https://c/h264-hi",
        "https://c/h264-lo",
        "https://c/h264-lo-b",
        "https://c/bytevc1",
        "https://c/h265-hi",
        "https://c/play",
    ]
    # a plain string playAddr, and the itemStruct wrapper
    assert play_url_candidates({"video": {"playAddr": " https://c/w "}}) == ["https://c/w"]
    wrapped = {"itemStruct": {"video": {"playAddr": "https://c/w", "bitrateInfo": []}}}
    assert play_url_candidates(wrapped) == ["https://c/w"]


def test_best_quality_orders_every_rendition_by_bitrate_across_codecs():
    item = {
        "video": {
            "playAddr": {"UrlList": ["https://c/play", "https://c/h264-hi"]},
            "bitrateInfo": [
                _entry("h265", 2_000_000, "https://c/h265-hi"),
                _entry("h264", 500_000, "https://c/h264-lo", "https://c/h264-lo-b"),
                _entry("bytevc1", 3_000_000, "https://c/bytevc1"),
                _entry("AVC1", 1_000_000, "https://c/h264-hi"),
                _entry("H.264", "1500000", "https://c/h264-str"),
                _entry("h264", 1_000_000, "https://c/h264-hi"),
            ],
        }
    }
    assert play_url_candidates(item, "best") == [
        "https://c/bytevc1",
        "https://c/h265-hi",
        "https://c/h264-str",
        "https://c/h264-hi",
        "https://c/h264-lo",
        "https://c/h264-lo-b",
        "https://c/play",
    ]
    assert [r.label for r in ordered_renditions(item, "best")] == [
        "?p bytevc1",
        "?p h265",
        "?p h264",
        "?p h264",
        "?p h264",
        "?p h264",
    ]
    assert choose_rendition(item, "best").codec == "bytevc1"
    assert choose_rendition(item).url_list == ["https://c/h264-str"]  # compatible: top H.264
    with pytest.raises(
        ValueError, match="unknown quality 'ultra': expected one of compatible, best"
    ):
        play_url_candidates(item, "ultra")
    assert QUALITY_MODES == ("compatible", "best")


def test_video_only_hevc_streams_are_never_candidates():
    """TikTok's `/media-video-hvc1/` streams carry no audio track (yt-dlp marks every such format
    `acodec: none`, yt-dlp/yt-dlp#16622 and #17372, and its `best` never takes one): `--quality
    best` must not pick one either — the saved file could only be quarantined as `no audio
    track`, three of them a stop — so such URLs leave the renditions and the candidates."""
    hvc1 = "https://v16-webapp-prime.tiktok.com/video/tos/x/media-video-hvc1/?a=1988&expire=1"
    item = {
        "video": {
            "playAddr": {"UrlList": ["https://c/play", "https://c/x/media-video-hvc1/"]},
            "bitrateInfo": [
                _entry("bytevc1", 3_000_000, hvc1, "https://c/mirror/media-video-hvc1/#f"),
                _entry("bytevc1", 2_500_000, "https://c/hevc-with-audio", hvc1),
                _entry("h264", 1_000_000, "https://c/h264"),
            ],
        }
    }
    assert [r.url_list for r in renditions(item)] == [
        ["https://c/hevc-with-audio"],
        ["https://c/h264"],
    ]
    assert choose_rendition(item, "best").url_list == ["https://c/hevc-with-audio"]
    assert play_url_candidates(item, "best") == [
        "https://c/hevc-with-audio",
        "https://c/h264",
        "https://c/play",
    ]
    assert play_url_candidates(item) == [
        "https://c/h264",
        "https://c/hevc-with-audio",
        "https://c/play",
    ]
    assert choose_rendition(item).label == "?p h264"  # compatible: the top H.264, as before
    assert VIDEO_ONLY_PATH_SUFFIX == "/media-video-hvc1/"
    assert is_video_only_url(hvc1) and is_video_only_url("https://c/media-video-hvc1/#frag")
    assert is_video_only_url("HTTPS://C/a/media-video-hvc1/?q=1#f")
    assert not is_video_only_url("https://c/media-video-hvc1")  # no trailing slash: not the path
    assert not is_video_only_url("https://c/?p=/media-video-hvc1/")  # the query is not the path
    assert not is_video_only_url("https://c/media-video-hvc1/x/")
    assert not is_video_only_url("")


def test_renditions_labels_codecs_and_the_quality_hint(item_list_pages):
    page1 = item_list_pages[0]["itemList"]
    found = renditions(page1[0])
    assert found == [
        Rendition([f"{CDN}/abc/?a=1988&expire=1761200000"], "h264", 1_138_000, 720, "720p h264"),
        Rendition(
            [f"{CDN}/abc-1080/?a=1988&expire=1761200000"],
            "bytevc1",
            1_652_000,
            1080,
            "1080p bytevc1",
        ),
    ]
    assert found[0].h264 and not found[1].h264
    assert choose_rendition(page1[0]) == found[0]
    assert choose_rendition(page1[0], "best") == found[1]
    assert episode_from_item(page1[0], SERIES_ID).quality_hint == "720p h264"
    # a bare playAddr is not a rendition: no hint, nothing chosen, the URL still a candidate
    assert renditions(page1[1]) == [] and choose_rendition(page1[1]) is None
    assert episode_from_item(page1[1], SERIES_ID).quality_hint is None
    # compatible falls back to the best of the other codecs when no H.264 is listed
    only_h265 = {"video": {"bitrateInfo": [_entry("h265", 900_000, "https://c/h265")]}}
    assert choose_rendition(only_h265).label == "?p h265"
    # the height: GearName first, then video.ratio, else "?p"
    gear = {
        "Bitrate": 1,
        "CodecType": "h264",
        "GearName": "adapt_lower_1080_1",
        "PlayAddr": "https://c/a",
    }
    by_ratio = {"Bitrate": 1, "CodecType": "h265", "PlayAddr": "https://c/b"}
    assert [
        r.label for r in renditions({"video": {"ratio": "720p", "bitrateInfo": [gear, by_ratio]}})
    ] == [
        "1080p h264",
        "720p h265",
    ]
    assert (
        renditions({"video": {"ratio": "default", "bitrateInfo": [by_ratio]}})[0].label == "?p h265"
    )
    assert renditions({"video": {"ratio": 720, "bitrateInfo": [by_ratio]}})[0].height_hint is None
    assert renditions({"video": {"bitrateInfo": [{**gear, "GearName": "lowest_540_0"}]}})[
        0
    ].label == ("540p h264")
    # codec names
    for raw, expected in (
        ("h264", "h264"),
        ("H.264", "h264"),
        ("avc1", "h264"),
        ("h265", "h265"),
        ("H.265", "h265"),
        ("hevc", "h265"),
        ("hvc1", "h265"),
        ("bytevc1", "bytevc1"),
        ("ByteVC1", "bytevc1"),
        ("bytevc2", "bytevc2"),
        ("VP9", "vp9"),
        ("", "unknown"),
        (None, "unknown"),
        (3, "unknown"),
    ):
        assert codec_name(raw) == expected, raw
    # junk never raises and yields nothing
    for junk in (None, "x", 1, [], {}, {"video": None}, {"video": {"bitrateInfo": "no"}}):
        assert renditions(junk) == [] and choose_rendition(junk) is None
    messy = {
        "video": {"bitrateInfo": [1, {"PlayAddr": 5}, {"Bitrate": True, "PlayAddr": "https://c/q"}]}
    }
    assert renditions(messy) == [Rendition(["https://c/q"], "unknown", 0, None, "?p unknown")]


def test_play_url_candidates_never_raises_on_junk():
    for junk in (None, "x", 1, [], {}, {"video": None}, {"video": "s"}, {"video": {}}):
        assert play_url_candidates(junk) == []
    assert play_url_candidates({"video": {"bitrateInfo": "no", "playAddr": 7}}) == []
    messy = {
        "video": {
            "bitrateInfo": [
                1,
                "x",
                None,
                {"PlayAddr": 5},
                {"PlayAddr": {"UrlList": "https://c/not-a-list"}},  # a string list: one URL
                {"PlayAddr": {"UrlList": [1, None, "ftp://x", "nope", " https://c/ok "]}},
                {"Bitrate": "high", "CodecType": None, "PlayAddr": {"UrlList": ["https://c/q"]}},
                {"Bitrate": True, "CodecType": 3, "PlayAddr": {"url_list": ["https://c/r"]}},
            ],
            "playAddr": ["https://c/list-addr", 3, ["https://c/nested"]],
        }
    }
    assert play_url_candidates(messy) == [
        "https://c/not-a-list",
        "https://c/ok",
        "https://c/q",
        "https://c/r",
        "https://c/list-addr",
        "https://c/nested",
    ]
    deep = "https://c/deep"
    for _ in range(10):
        deep = [deep]
    assert play_url_candidates({"video": {"playAddr": deep}}) == []  # depth-limited


def test_url_expiry():
    assert url_expiry(f"{CDN}/abc/?a=1988&expire=1761200000") == 1761200000
    assert url_expiry("https://v/x/?expire=0") == 0
    assert url_expiry("https://v/x/?expire=-5") == -5
    assert url_expiry("https://v/x/?expire=12&expire=99") == 12
    assert url_expiry("https://v/x/?expire=%2B7") is None  # a decoded "+7" is not a number
    assert url_expiry("https://v/x/?expire=+7") == 7  # parse_qs decodes "+" as a space
    assert url_expiry("https://v/x/") is None
    assert url_expiry("https://v/x/?expire=") is None
    assert url_expiry("https://v/x/?expire=abc") is None
    assert url_expiry("https://v/x/?expire=1.5") is None
    assert url_expiry("https://v/x/?x-expires=5") is None
    assert url_expiry("") is None
    assert url_expiry("http://[::1/?expire=1") is None  # not even a URL
    assert url_expiry("https://v/x/?expire=" + "9" * 5000) is None  # too long for int()
    assert url_expiry(None) is None


# --------------------------------------------------------------------------- build 7: access

PAID_SERIES_ID = "7699393770256782388"
FIXTURES = Path(__file__).parent / "fixtures"
#: A play address in THIS session's payload (what TikTok's own web player would play).
PLAYABLE = {"playAddr": "https://v16-webapp-prime.tiktok.com/video/tos/x/?a=1988&expire=1"}


def _paid_page(name):
    text = (FIXTURES / f"item_list_series3_{name}.json").read_text(encoding="utf-8")
    return parse_item_list_payload(json.loads(text), PAID_SERIES_ID).episodes


def _item(drama=None, video=PLAYABLE, **top):
    item = {"id": "1", **top}
    if video is not None:
        item["video"] = dict(video)
    if drama is not None:
        item["dramaInfo"] = {"DramaVideoData": {"EpisodeNumber": 1, **drama}}
    return item


def test_the_episode_access_model_and_its_constants():
    assert ACCESS_MODES == ("free", "unlocked", "locked")
    assert DRM_MARK == "protected by DRM"
    assert DRM_MESSAGE == "protected by DRM (encrypted tracks): DramaFetch does not decrypt it"
    assert DRM_MESSAGE.startswith(DRM_MARK)
    plain = Episode(1, "1", "t", "s")
    assert (plain.access, plain.paid, plain.drm, plain.locked) == ("free", False, False, False)
    # back-compat: an Episode built with lock_hints only (every test before build 7) is locked
    assert Episode(1, "1", "t", "s", lock_hints=("isFree=false",)).access == "locked"
    assert Episode(1, "1", "t", "s", drm=True).locked
    bought = Episode(1, "1", "t", "s", lock_hints=("isFree=false",), access="unlocked", paid=True)
    assert not bought.locked and bought.paid
    with pytest.raises(ValueError, match="free, unlocked, locked"):
        Episode(1, "1", "t", "s", access="paid")
    with pytest.raises(ValueError, match="never decrypts"):
        Episode(1, "1", "t", "s", drm=True, access="unlocked")


def test_a_derived_access_follows_later_assignments_an_explicit_one_does_not():
    episode = Episode(1, "1", "t", "s")
    episode.lock_hints = ("isLocked=True",)  # how the build-6 tests made an episode locked
    assert episode.locked
    episode.lock_hints = ()
    assert episode.access == "free"
    copied = replace(episode, title="copy")  # a dataclasses.replace copy follows as well
    copied.lock_hints = ("x",)
    assert copied.locked and not episode.locked
    copied.drm = True
    assert copied.access == "locked"
    bought = Episode(1, "1", "t", "s", lock_hints=("isFree=false",), access="unlocked", paid=True)
    bought.lock_hints = ("isFree=false", "unlockPrice=30")
    assert bought.access == "unlocked"  # what catalog decided stays
    bought.lock_hints = ()
    assert bought.access == "unlocked"


def test_the_third_series_with_the_session_of_the_account_that_bought_episode_3():
    episodes = _paid_page("logged_in")
    assert [e.number for e in episodes] == [1, 2, 3, 4]
    assert [e.access for e in episodes] == ["free", "free", "unlocked", "locked"]
    assert [e.paid for e in episodes] == [False, False, True, True]
    assert not any(e.drm for e in episodes)
    assert [e.locked for e in episodes] == [False, False, False, True]
    assert episodes[2].lock_hints == ("isFree=false", "unlockPrice=30", "isUnlocked=True")
    # episode 4 also says isLocked at the top level of the item: scanned first, then dramaInfo
    assert episodes[3].lock_hints == (
        "isLocked=True",
        "isFree=false",
        "unlockPrice=30",
        NO_PLAY_ADDRESS,
    )
    assert play_url_candidates(episodes[2].raw) and not play_url_candidates(episodes[3].raw)
    assert episodes[2].quality_hint == "720p h264"
    assert catalog_warnings(episodes, 4) == ["1 episode looks locked"]


def test_the_third_series_without_the_session_locks_the_paid_episode():
    episodes = _paid_page("logged_out")
    assert [e.access for e in episodes] == ["free", "free", "locked", "locked"]
    assert [e.paid for e in episodes] == [False, False, True, True]
    assert episodes[2].lock_hints == (
        "isFree=false",
        "unlockPrice=30",
        "isLocked=True",
        NO_PLAY_ADDRESS,
    )
    assert not play_url_candidates(episodes[2].raw)
    assert catalog_warnings(episodes, 4) == ["2 episodes look locked"]


LIMITED_FREE_SERIES_ID = "7699393770256782366"


def _limited_free_page():
    text = (FIXTURES / "item_list_series4_limited_free.json").read_text(encoding="utf-8")
    return parse_item_list_payload(json.loads(text), LIMITED_FREE_SERIES_ID)


def _music(duration, original=True, **more):
    music = {"id": "7699400000000000501", "title": "original sound", "duration": duration, **more}
    if original is not None:
        music["original"] = original
    return music


def test_the_limited_free_series_as_the_owner_s_real_payload_reads(item_list_pages):
    """The fixture is modeled on the real run of 2026-11-06: `isLimitedFree: true` on every item,
    `IsFreeIntro: false`, `IsPreview` / `PreviewType` on fully served episodes — no clue, no hint —
    and, on episode 3, a `music.duration` far shorter than `video.duration`: the short header
    the list alone gives away, locked before any request."""
    page = _limited_free_page()
    assert (page.seen_items, page.skipped_items, page.has_more) == (3, 0, False)
    episodes = page.episodes
    assert [e.number for e in episodes] == [1, 2, 3]
    assert [e.access for e in episodes] == ["free", "free", "locked"]
    assert [e.paid for e in episodes] == [False, False, False]
    assert not any(e.drm for e in episodes)
    assert episodes[0].lock_hints == () and episodes[1].lock_hints == ()
    assert episodes[2].lock_hints == (f"{SHORT_HEADER_HINT_PREFIX}2 s of 3 s",)
    assert episodes[2].lock_hints == ("plays 2 s of 3 s",)
    assert [e.duration_s for e in episodes] == [3, 3, 3]
    assert [e.quality_hint for e in episodes] == ["540p h264"] * 3
    assert all(play_url_candidates(e.raw) for e in episodes)  # every episode has play URLs
    assert [e.series_name for e in episodes] == ["Limited Free Drama"] * 3
    assert catalog_warnings(episodes, 3) == ["1 episode looks locked"]
    # the raw items keep the fields that gave no clue, for diagnosis
    data = episodes[0].raw["dramaInfo"]["DramaVideoData"]
    assert (data["IsFreeIntro"], data["IsPreview"], data["PreviewType"]) == (False, True, 4)
    assert episodes[0].raw["dramaInfo"]["isLimitedFree"] is True
    # and the sizes the engines compare a saved file against
    assert listed_sizes(episodes[0].raw) == (129700, 272300)
    assert listed_sizes(episodes[2].raw) == (130800, 274400)


@pytest.mark.parametrize(
    ("item", "expected", "hints"),
    [
        # IsFreeIntro ("is this the free intro teaser") gives no clue, whatever its value
        (_item({"IsFreeIntro": False}), ("free", False, False), ()),
        (_item({"IsFreeIntro": True}), ("free", False, False), ()),
        (_item({"is_free_intro": False, "unlockPrice": 30}), ("unlocked", True, False), None),
        # a truthy free key is FREE: it beats a price (a sold series the payload calls free is free)
        # and its hint is listed next to the price it beats
        (
            _item({"isLimitedFree": True, "unlockPrice": 30}),
            ("free", True, False),
            ("isLimitedFree=True", "unlockPrice=30"),
        ),
        (_item({"isFree": False, "isLimitedFree": True}), ("free", True, False), None),
        (_item({"limitedFree": 1}), ("free", False, False), ()),
        (_item(None, isLimitedFree="true"), ("free", False, False), ()),
        # ... alone, a free flag says nothing about a price or a lock: no hint (as `isFree: true`)
        (_item({"isLimitedFree": True}), ("free", False, False), ()),
        # IsPreview / PreviewType / isTrial: no clue, no hint
        (_item({"isPreview": True}), ("free", False, False), ()),
        (_item({"IsPreview": False, "PreviewType": 1}), ("free", False, False), ()),
        (_item({"isTrial": True, "trial": 1}), ("free", False, False), ()),
        # a DRM negation is not a free flag either
        (_item({"isDrmFree": True, "unlockPrice": 30}), ("unlocked", True, False), None),
        # FREE does not beat a lock, a missing play address, an entitlement or DRM
        (_item({"isLimitedFree": True, "isLocked": True}), ("locked", False, False), None),
        (_item({"isLimitedFree": True}, video={}), ("locked", False, False), None),
        (_item({"isLimitedFree": True, "isUnlocked": True}), ("unlocked", True, False), None),
        (_item({"isLimitedFree": True, "drmType": "cenc"}), ("locked", False, True), None),
    ],
)
def test_free_keys_intro_and_preview_flags(item, expected, hints):
    access, paid, drm, found = access_of(item)[:4]
    assert (access, paid, drm) == expected
    if hints is not None:
        assert found == hints


def _windowed(video_duration, music_duration, original=True, **drama):
    """An item with a play URL, `video.duration` and a `music` block."""
    item = _item(drama or None, video={**PLAYABLE, "duration": video_duration})
    item["music"] = _music(music_duration, original)
    return item


def test_the_short_header_rule_locks_before_any_request():
    """The real tell (2026-11-06): `music.duration` (the episode's own sound) far shorter than
    `video.duration` — 69 s of 106 s — on an item TikTok serves short."""
    assert (SHORT_HEADER_RATIO, SHORT_HEADER_MIN_GAP_S) == (0.85, 1)
    assert SHORT_HEADER_HINT_PREFIX == "plays "
    assert access_of(_windowed(106, 69)) == (
        "locked",
        False,
        False,
        ("plays 69 s of 106 s",),
        True,  # 3.0.1: locked only by the SHORT-HEADER guess
    )
    # the hint prints numbers like Python's str(): an int as it is, a float as it is
    assert access_of(_windowed(106, 69.5))[3] == ("plays 69.5 s of 106 s",)
    assert access_of(_windowed("106", 69))[3] == ("plays 69 s of 106 s",)  # digits
    # a whole float prints as an int: the extension cannot tell 69.0 from 69 after JSON.parse
    assert access_of(_windowed(106, 69.0))[3] == ("plays 69 s of 106 s",)
    # `video.duration` is read up to MAX_EXACT_INT; a longer number is junk, never an OverflowError
    assert access_of(_windowed(2**53 - 1, 69))[3] == (f"plays 69 s of {2**53 - 1} s",)
    assert access_of(_windowed(2**53, 69)) == ("free", False, False, (), False)
    assert access_of(_windowed(int("1" * 400), 69)) == ("free", False, False, (), False)
    assert access_of(_windowed("1" * 400, 69)) == ("free", False, False, (), False)
    assert access_of(_windowed(106, 10**400))[0] == "free"  # a huge sound: longer than the video
    # the boundary: at most 85 % and at least 1 s shorter
    assert access_of(_windowed(100, 85))[0] == "locked"
    assert access_of(_windowed(100, 85.5))[0] == "free"
    assert access_of(_windowed(3, 2))[0] == "locked"  # the fixture's E03: 2 of 3
    assert access_of(_windowed(3, 2.5))[0] == "free"  # not 1 s apart
    assert access_of(_windowed(1, 0.5))[0] == "free"
    assert access_of(_windowed(69, 69)) == ("free", False, False, (), False)  # a full episode
    # without `music.original` truthy, or without either duration, the rule never fires
    assert access_of(_windowed(106, 69, original=False)) == ("free", False, False, (), False)
    assert access_of(_windowed(106, 69, original=None)) == ("free", False, False, (), False)
    assert access_of(_windowed(106, 69, original=0))[0] == "free"
    assert access_of(_windowed(106, 69, original="false"))[0] == "free"
    assert access_of(_windowed(106, "69"))[0] == "free"  # music.duration must be a number
    assert access_of(_windowed(106, None))[0] == "free"
    assert access_of(_windowed(106, True))[0] == "free"
    assert access_of(_windowed(106, 0))[0] == "free"
    assert access_of(_windowed(None, 69))[0] == "free"
    assert access_of(_windowed(0, 69))[0] == "free"
    assert access_of(_windowed(2.5, 1))[0] == "free"  # video.duration must be a whole number
    no_music = _item(None, video={**PLAYABLE, "duration": 106})
    assert access_of(no_music) == ("free", False, False, (), False)
    no_music["music"] = "x"
    assert access_of(no_music) == ("free", False, False, (), False)
    # the item may be wrapped in itemStruct
    wrapped = {"itemStruct": _windowed(106, 69)}
    assert access_of(wrapped)[0] == "locked" and access_of(wrapped)[3][0].startswith("plays")


def test_the_short_header_rule_in_the_decision_order():
    # an entitlement beats a short header (the account is entitled; the downloader finds out)
    assert access_of(_windowed(106, 69, isUnlocked=True)) == (
        "unlocked",
        True,
        False,
        ("isUnlocked=True", "plays 69 s of 106 s"),
        False,
    )
    # DRM beats everything
    assert access_of(_windowed(106, 69, drmType="widevine"))[:3] == ("locked", False, True)
    # a short header beats FREE and PRICING-with-a-play-URL
    assert access_of(_windowed(106, 69, isLimitedFree=True))[0] == "locked"
    assert access_of(_windowed(106, 69, isFree=False, unlockPrice=30)) == (
        "locked",
        True,
        False,
        ("isFree=false", "unlockPrice=30", "plays 69 s of 106 s"),
        False,  # 3.0.1: sold, so no guess of DramaFetch's alone
    )
    # the window hint comes before NO_PLAY_ADDRESS
    item = _windowed(106, 69)
    item["video"] = {"duration": 106}
    assert access_of(item)[3] == ("plays 69 s of 106 s", NO_PLAY_ADDRESS)
    # the real items of 2026-11-06, reduced to their fields: fully served and windowed
    served = _windowed(69, 69, isLimitedFree=True)
    served["dramaInfo"]["DramaVideoData"].update(
        {"IsFreeIntro": False, "IsHighlight": False, "IsPreview": True, "PreviewType": 4}
    )
    assert access_of(served) == ("free", False, False, (), False)
    windowed = _windowed(106, 69, isLimitedFree=True)
    windowed["dramaInfo"]["DramaVideoData"].update({"IsFreeIntro": False, "PreviewType": 1})
    assert access_of(windowed) == ("locked", False, False, ("plays 69 s of 106 s",), True)


def test_the_guessed_lock_is_locked_by_dramafetchs_own_guesses_only():
    """3.0.1 (the owner's report of 2026-11-27): an episode locked ONLY by the SHORT-HEADER rule
    and/or no play address — no DRM, no price or entitlement clue, no lock flag of TikTok's — is a
    guessed lock: the decision does not change (``locked``), the flag says DramaFetch guessed."""
    short = access_of(_windowed(106, 69))
    assert isinstance(short, AccessDecision)
    assert (short.access, short.paid, short.drm, short.guessed_lock) == (
        "locked",
        False,
        False,
        True,
    )
    assert access_of(_item(None, video={})).guessed_lock  # no play address alone
    assert access_of({"id": "1"}).guessed_lock  # no video at all
    no_address = _windowed(106, 69)
    no_address["video"] = {"duration": 106}
    assert access_of(no_address).guessed_lock  # both structural rules
    assert access_of(_windowed(106, 69, isLimitedFree=True)).guessed_lock  # the owner's shape
    assert access_of(
        _item({"payStatus": 1}, video={})
    ).guessed_lock  # an ambiguous hint decides nothing
    # what is not DramaFetch's guess alone: a whole episode, a price, an entitlement, TikTok's own
    # lock flags, DRM
    assert not access_of(_windowed(106, 106)).guessed_lock
    assert not access_of(_item({"unlockPrice": 30}, video={})).guessed_lock
    assert not access_of(_windowed(106, 69, unlockPrice=30)).guessed_lock
    assert not access_of(_windowed(106, 69, isFree=False)).guessed_lock
    assert not access_of(_windowed(106, 69, isVip=True)).guessed_lock
    assert not access_of(_item({"isUnlocked": True}, video={})).guessed_lock  # unlocked
    assert not access_of(_item({"isUnlocked": False}, video={})).guessed_lock  # NOT-ENTITLED
    assert not access_of(_item({"isLocked": True})).guessed_lock
    assert not access_of(_item({"needPay": 1}, video={})).guessed_lock
    assert not access_of(_item({"lockStatus": "locked"})).guessed_lock
    assert not access_of(_item({"isDrm": True})).guessed_lock
    assert not access_of(_windowed(106, 69, drmType="widevine")).guessed_lock


def test_the_guessed_lock_rides_on_the_episode_and_the_owners_series():
    """3.0.1: ``episode_from_item`` carries the flag; fixture series 4 (the owner's real shape,
    ``isLimitedFree``) guesses E03 locked (its own sound: 2 s of 3 s), E01 and E02 are free."""
    page = json.loads((FIXTURES / "item_list_series4_limited_free.json").read_text("utf-8"))
    parsed = parse_item_list_payload(page, "7699393770256782366")
    assert [(e.number, e.access, e.guessed_lock) for e in parsed.episodes] == [
        (1, "free", False),
        (2, "free", False),
        (3, "locked", True),
    ]
    assert parsed.episodes[2].lock_hints == ("plays 2 s of 3 s",)
    # an Episode refuses a guessed lock that is not locked, or is DRM or sold
    assert Episode(1, "1", "t", "s", access="locked", guessed_lock=True).guessed_lock
    for wrong in (
        {"access": "free"},
        {"access": "unlocked", "paid": True},
        {"access": "locked", "drm": True},
        {"access": "locked", "paid": True},
    ):
        with pytest.raises(ValueError, match="guessed lock"):
            Episode(1, "1", "t", "s", guessed_lock=True, **wrong)


def test_listed_sizes_reads_video_size_and_every_data_size():
    item = {
        "id": "1",
        "video": {
            "size": 9676471,
            "bitrateInfo": [
                {"PlayAddr": {"DataSize": 9676471, "UrlList": ["https://v/x"]}},
                {"PlayAddr": {"DataSize": "4609304"}},
                {"PlayAddr": {"DataSize": " 4609304 "}},  # a digit string, stripped: the same
                {"PlayAddr": {"DataSize": 0}},
                {"PlayAddr": {"DataSize": -5}},
                {"PlayAddr": {"DataSize": True}},
                {"PlayAddr": {"DataSize": 2.5}},
                {"PlayAddr": {"DataSize": 8.0}},  # a whole float: an int, as `_as_int` reads it
                {"PlayAddr": {"DataSize": "x"}},
                {"PlayAddr": {"DataSize": "٣"}},  # a digit of another script: 3, as int() reads it
                {"PlayAddr": {"DataSize": None}},
                {"PlayAddr": "https://v/y"},
                {"PlayAddr": {}},
                {},
                "x",
                None,
            ],
        },
    }
    assert listed_sizes(item) == (3, 8, 4609304, 9676471)
    assert listed_sizes({"itemStruct": item}) == (3, 8, 4609304, 9676471)
    assert listed_sizes({"id": "1", "video": {"size": "12"}}) == (12,)
    assert listed_sizes({"id": "1", "video": {"size": True, "bitrateInfo": "x"}}) == ()
    assert listed_sizes({"id": "1", "video": {"bitrateInfo": [{"PlayAddr": {"DataSize": 7}}]}}) == (
        7,
    )
    for junk in ({}, {"video": None}, {"video": "x"}, {"video": {}}, {"video": []}, [], None, 5):
        assert listed_sizes(junk) == ()
    # an int both front ends read exactly is kept; anything above MAX_EXACT_INT (2**53 - 1) is junk
    assert MAX_EXACT_INT == 2**53 - 1
    assert listed_sizes({"video": {"size": 2**53 - 1}}) == (2**53 - 1,)
    over = {"video": {"size": 2**53, "bitrateInfo": [{"PlayAddr": {"DataSize": 8}}]}}
    assert listed_sizes(over) == (8,)
    assert listed_sizes({"video": {"size": 10**40}}) == ()
    assert listed_sizes({"video": {"size": "1" * 400}}) == ()  # the extension parses it as Infinity


@pytest.mark.parametrize(
    ("item", "expected"),
    [
        # 6. nothing says it is sold: free
        (_item({"isFree": True}), ("free", False, False)),
        (_item({"isFree": True, "unlockPrice": 0, "coinCount": 0}), ("free", False, False)),
        # 4. no play address in this session's payload: locked, free-looking or not
        (
            _item({"isFree": True}, video={"playAddr": "", "bitrateInfo": []}),
            ("locked", False, False),
        ),
        (_item({"isFree": True}, video=None), ("locked", False, False)),
        # 5. sold, and TikTok gave this session a play address: unlocked
        (_item({"isFree": False, "unlockPrice": 30}), ("unlocked", True, False)),
        (_item({"isPaid": True}), ("unlocked", True, False)),
        (_item({"isVip": "true"}), ("unlocked", True, False)),
        (_item({"cost": 5}), ("unlocked", True, False)),
        (_item({"chargeType": "coins"}), ("unlocked", True, False)),
        (_item({"unlockType": 1}), ("unlocked", True, False)),  # the old heuristic's leftover
        (_item({"cost": -1}), ("free", False, False)),  # not a price
        # ... and without a play address: locked, whatever its price says
        (_item({"isFree": False, "unlockPrice": 30}, video={}), ("locked", True, False)),
        # 3. a viewer lock wins over a play address
        (_item({"isLocked": True}), ("locked", False, False)),
        (_item({"is_locked": 1, "isFree": False}), ("locked", True, False)),
        (_item({"needPay": 1}), ("locked", False, False)),
        (_item({"need_unlock": "yes"}), ("locked", False, False)),
        (_item({"paywall": "on"}), ("locked", False, False)),
        # ... but `preview` and `trial` keys are no lock since 2026-11-06: a real free series with
        # conditions carries IsPreview=true / PreviewType on fully served episodes (no clue, no
        # hint)
        (_item({"isPreview": True}), ("free", False, False)),
        (_item({"IsPreview": True, "PreviewType": 4}), ("free", False, False)),
        (_item({"trialClip": True}), ("free", False, False)),
        (_item({"isTrial": 1, "isFree": False}), ("unlocked", True, False)),
        (_item({"lockStatus": 1}), ("locked", False, False)),
        (_item({"payStatus": "need_pay"}), ("locked", False, False)),
        (_item({"unlockStatus": "UNPAID"}), ("locked", False, False)),
        (_item({"purchaseStatus": "unpurchased"}), ("locked", False, False)),
        (_item({"lockStatus": 0, "isLocked": False}), ("free", False, False)),
        # 2. an entitlement wins over a lock and over a missing play address
        (
            _item({"isFree": False, "unlockPrice": 30, "isUnlocked": True}),
            ("unlocked", True, False),
        ),
        (_item({"isLocked": True, "isUnlocked": True}), ("unlocked", True, False)),
        (_item({"hasPaid": True}, video={}), ("unlocked", True, False)),
        (_item({"paidByUser": 1}), ("unlocked", True, False)),
        (_item({"is_purchased": "true"}), ("unlocked", True, False)),
        (_item({"hasAccess": True}), ("unlocked", True, False)),
        (_item({"entitled": True}), ("unlocked", True, False)),
        (_item({"unlockStatus": "unlocked"}, video={}), ("unlocked", True, False)),
        (_item({"payStatus": "Paid"}), ("unlocked", True, False)),
        (_item({"hasPaid": False}), ("free", False, False)),  # not an entitlement, not a price
        (_item({"isUnlocked": False}), ("free", False, False)),  # nothing says it is sold
        # 5. ... but on a sold episode an entitlement flag that says no is the paywall's flag
        (_item({"isUnlocked": False, "isFree": False}), ("locked", True, False)),
        (_item({"hasPaid": 0, "unlockPrice": 30}), ("locked", True, False)),
        (_item({"is_purchased": "false", "coinCount": 5}), ("locked", True, False)),
        (_item({"isUnlocked": True, "hasPaid": False, "isFree": False}), ("unlocked", True, False)),
        # 1. DRM wins over everything, entitlement included: locked, never decrypted
        (_item({"isUnlocked": True, "drmType": "widevine"}), ("locked", True, True)),
        (_item(None, video={**PLAYABLE, "isEncrypted": True}), ("locked", False, True)),
        (_item({"encryption": 1}), ("locked", False, True)),
        (_item({"drm": 0, "drmType": "none"}), ("free", False, False)),  # falsy: no clue
        # the top level of the item counts too, wrapped in itemStruct or not (the outer key wins)
        (_item(None, isLocked=True), ("locked", False, False)),
        (_item(None, video={}, isUnlocked=True), ("unlocked", True, False)),
        (
            {"itemStruct": {"id": "1", "video": PLAYABLE, "isLocked": True}},
            ("locked", False, False),
        ),
        (
            {"isLocked": False, "itemStruct": {"id": "1", "video": PLAYABLE, "isLocked": True}},
            ("free", False, False),
        ),
        # video is scanned at its top level only: its renditions' fields are not clues
        (_item(None, video={**PLAYABLE, "isLocked": 1}), ("locked", False, False)),
        (
            _item(None, video={"bitrateInfo": [{"PlayAddr": {"isLocked": True}}]}),
            ("free", False, False),
        ),
    ],
)
def test_access_of_follows_the_clue_table_and_the_decision_order(item, expected):
    access, paid, drm, hints = access_of(item)[:4]
    assert (access, paid, drm) == expected
    assert hints == lock_hints(item)
    if not _has_play(item):
        assert hints[-1] == NO_PLAY_ADDRESS


def _has_play(item):
    video = item.get("video", item.get("itemStruct", {}).get("video"))
    return isinstance(video, dict) and (
        bool(video.get("playAddr")) or bool(video.get("bitrateInfo"))
    )


#: Play addresses that hold no URL at all — renditions without one, a placeholder string — and
#: what a FREE-looking item with that address is: free as in build 6 when the address has the
#: payload's shape (renditions, a playAddr string), locked when it has none.
URL_LESS_VIDEOS = [
    pytest.param(
        {
            "playAddr": "",
            "bitrateInfo": [
                {"Bitrate": 0, "CodecType": "h264", "GearName": "normal_720_0", "PlayAddr": {}}
            ],
        },
        "free",
        id="rendition-without-UrlList",
    ),
    pytest.param(
        {"playAddr": "", "bitrateInfo": [{"Bitrate": 1088000, "PlayAddr": {"UrlList": []}}]},
        "free",
        id="empty-UrlList",
    ),
    pytest.param({"playAddr": "", "bitrateInfo": [{}]}, "free", id="empty-rendition"),
    pytest.param({"bitrateInfo": [{"PlayAddr": None}]}, "free", id="PlayAddr-null"),
    pytest.param({"playAddr": "null", "bitrateInfo": []}, "free", id="playAddr-null-string"),
    pytest.param({"playAddr": "about:blank"}, "free", id="playAddr-not-http"),
    pytest.param({"playAddr": {"UrlList": ["/relative/path"]}}, "locked", id="playAddr-relative"),
]


@pytest.mark.parametrize(("video", "free_access"), URL_LESS_VIDEOS)
def test_a_sold_episode_needs_a_real_play_url_to_count_as_unlocked(tmp_path, video, free_access):
    """Rule 5 is about the URL TikTok gave THIS session for a sold episode: a play address that
    holds none — renditions without a URL, a placeholder string — is no address, so the episode
    is locked with the `no play address` hint and never handed to yt-dlp unless
    `--include-locked`. An entitlement flag still wins, and a free-looking item keeps its
    build-6 meaning (the yt-dlp engine never needed the payload's URLs for it)."""
    from dramafetch.downloader import YtDlpDownloader
    from dramafetch.engine import download_series
    from dramafetch.models import DownloadOptions, DownloadStatus, Series

    sold = _item({"isFree": False, "unlockPrice": 30}, video=video)
    access, paid, drm, hints = access_of(sold)[:4]
    assert (access, paid, drm) == ("locked", True, False)
    assert hints[-1] == NO_PLAY_ADDRESS and hints.count(NO_PLAY_ADDRESS) == 1
    assert hints[:2] == ("isFree=false", "unlockPrice=30")
    assert play_url_candidates(sold) == [] and lock_hints(sold) == hints
    assert access_of(_item({"isFree": False, "isUnlocked": True}, video=video))[0] == "unlocked"
    assert access_of(_item({"isFree": True}, video=video))[0] == free_access

    item = {**sold, "id": "7699400000000000203"}
    item["dramaInfo"]["DramaVideoData"]["EpisodeNumber"] = 3
    episode = episode_from_item(item, PAID_SERIES_ID)
    assert episode is not None and episode.locked
    asked = []

    def ydl_factory(params):
        asked.append(params)
        raise AssertionError("a locked episode is never handed to yt-dlp")

    series = Series(series_id=PAID_SERIES_ID, name="Paid Love Story", episodes=[episode])
    (result,) = download_series(
        series,
        [episode],
        DownloadOptions(out_dir=tmp_path),
        downloader=YtDlpDownloader(ydl_factory),
        sleep=lambda seconds: pytest.fail("a skip never pauses"),
    )
    assert result.status is DownloadStatus.SKIPPED_LOCKED and asked == []
    assert result.message == f"looks locked: isFree=false; unlockPrice=30; {NO_PLAY_ADDRESS}"


@pytest.mark.parametrize("value", [0, 1, 2, -1, 1.0, True, False])
def test_an_ambiguous_status_number_is_a_hint_and_never_decides(value):
    for key in ("unlockStatus", "pay_status", "purchaseStatus"):
        access, paid, drm, hints = access_of(_item({key: value}))[:4]
        assert (access, paid, drm) == ("free", False, False)
        assert hints == (f"{key}={value}",)
        # with a price it is the price that decides, without a play address the address does
        assert access_of(_item({key: value, "isFree": False}))[0] == "unlocked"
        assert access_of(_item({key: value}, video={}))[0] == "locked"


def test_hints_name_every_clue_in_payload_order_and_drm_ones_too():
    item = _item({"isFree": False, "unlockPrice": 30, "isUnlocked": True, "drmType": "fairplay"})
    assert access_of(item) == (
        "locked",
        True,
        True,
        ("isFree=false", "unlockPrice=30", "isUnlocked=True", "drmType=fairplay"),
        False,
    )
    status = _item({"unlockStatus": " unlocked "})
    assert access_of(status)[3] == ("unlockStatus=unlocked",)
    # an oversized number is still a hint (Python refuses to print an int of 5000 digits)
    huge = _item({"unlockPrice": 10**5000})
    assert access_of(huge)[:3] == ("unlocked", True, False)
    assert access_of(huge)[3] == ("unlockPrice=…",)


# --------------------------------------------------------------------------- build 7b: DRM keys
# A DRM clue locks the episode whatever else the payload says, and it only saves a download that
# would be refused anyway (media.drm_problem is the real guard): so a key must NAME DRM in whole
# words. Builds 1-6 never looked at these keys; a substring match would lock every episode of a
# real payload that carries an HDR flag, a "DRM-free" flag or an encrypted user id.

#: The spec's "must be DRM" list: each locks the episode as DRM, wherever access_of scans it.
DRM_KEYS = [
    ("isDrm", True),
    ("drm", 1),
    ("drmType", "widevine"),
    ("DRMType", "fairplay"),
    ("is_encrypted", True),
    ("encrypted", True),
    ("videoEncrypted", 1),
    ("encryption", "cenc"),
    ("encryptType", 2),
]
#: What TikTok's encrypted user ids (`secUid`) look like.
ENCRYPTED_UID = "MS4wLjABAAAAv7iSuuXDJGDvJkmH_vz1qkDZYo1apxgzaxdBSeIuPiM"
#: The spec's "must NOT be DRM" list: HDR flags, negations and identifiers — no clue of any class.
NOT_DRM_KEYS = [
    ("hdrMode", 1),
    ("HDRType", 1),
    ("isHdr", True),
    ("isDrmFree", True),
    ("drm_free", 1),
    ("nonEncrypted", True),
    ("no_drm", 1),
    ("notEncrypted", True),
    ("encryptedUid", ENCRYPTED_UID),
    ("encrypted_id", "x"),
    ("unencrypted", True),
    # their camelCase spellings too: an acronym's plural is one word, `un` a negation
    ("encryptedIDs", "x"),
    ("encryptedUIDs", f"{ENCRYPTED_UID},{ENCRYPTED_UID}"),
    ("encryptedUserIDs", "x"),
    ("unEncrypted", True),
    ("isUnEncrypted", True),
    ("un_encrypted", True),
]


def _everywhere(key, value):
    """The item with `key: value` in each place access_of scans: `dramaInfo` (nested), `video`'s
    top level, the item's own top level, an `itemStruct` wrapper's top level."""
    return [
        _item({key: value}),
        _item(None, video={**PLAYABLE, key: value}),
        _item(None, **{key: value}),
        {"itemStruct": {"id": "1", "video": dict(PLAYABLE), key: value}},
    ]


@pytest.mark.parametrize(("key", "value"), DRM_KEYS)
def test_a_key_that_names_drm_in_whole_words_locks_the_episode_as_drm(key, value):
    assert is_drm_key(key)
    for item in _everywhere(key, value):
        assert access_of(item) == ("locked", False, True, (f"{key}={value}",), False), item
    episode = episode_from_item(_item({key: value}), "s")
    assert episode is not None and episode.drm and episode.locked
    assert episode.lock_hints == (f"{key}={value}",)
    # DRM still wins over an entitlement: DramaFetch never decrypts
    assert access_of(_item({"isUnlocked": True, key: value}))[:3] == ("locked", True, True)


@pytest.mark.parametrize(("key", "value"), NOT_DRM_KEYS)
def test_hdr_flags_negations_and_identifiers_are_not_drm_nor_any_clue(key, value):
    assert not is_drm_key(key)
    for item in _everywhere(key, value):
        assert access_of(item) == ("free", False, False, (), False), item
    # they hide nothing either: a real DRM flag next to one still locks
    assert access_of(_item({key: value, "isDrm": True}))[:3] == ("locked", False, True)
    # and on a sold episode TikTok gave this session a play URL for, rule 5 decides as before
    assert access_of(_item({key: value, "isFree": False, "unlockPrice": 30}))[:3] == (
        "unlocked",
        True,
        False,
    )


@pytest.mark.parametrize(("key", "value"), [("isDrm", False), ("drmType", "none"), ("drmType", 0)])
def test_a_falsy_drm_value_is_never_a_clue(key, value):
    assert is_drm_key(key)
    for item in _everywhere(key, value):
        assert access_of(item) == ("free", False, False, (), False)


@pytest.mark.parametrize(
    ("key", "words"),
    [
        ("DRMType", ("drm", "type")),  # an acronym run before a capitalised word
        ("HDRBit", ("hdr", "bit")),
        ("isDrmFree", ("is", "drm", "free")),  # camelCase
        ("VideoEncrypted", ("video", "encrypted")),  # PascalCase
        ("drm_free", ("drm", "free")),  # snake_case
        ("no-drm", ("no", "drm")),  # kebab-case
        ("drm2Type", ("drm", "2", "type")),  # digits
        ("HDR10Plus", ("hdr", "10", "plus")),
        ("isDRM", ("is", "drm")),
        ("DRM", ("drm",)),
        ("unencrypted", ("unencrypted",)),
        ("encryptedIDs", ("encrypted", "ids")),  # an acronym's plural stays one word
        ("encryptedUIDs", ("encrypted", "uids")),
        ("encryptedUserIDs", ("encrypted", "user", "ids")),
        ("IDsList", ("ids", "list")),
        ("unEncrypted", ("un", "encrypted")),
        ("IsDrmFree", ("is", "drm", "free")),  # a capital and an `s` before a capital: a word
        ("", ()),
        ("__", ()),
        ("ü", ()),
    ],
)
def test_key_words_split_camel_pascal_acronyms_snake_kebab_and_digits(key, words):
    assert key_words(key) == words


def test_a_real_payload_with_hdr_flags_and_encrypted_ids_keeps_its_accesses():
    """The paid fixture with an HDR flag, a "DRM-free" flag and TikTok's encrypted user ids added
    to every item — in `video`, in `dramaInfo` and in a block nested in it: before build 7b every
    episode of such a payload was locked as DRM; now nothing changes."""
    text = (FIXTURES / "item_list_series3_logged_in.json").read_text(encoding="utf-8")
    payload = json.loads(text)
    expected = [(e.access, e.paid, e.drm, e.lock_hints) for e in _paid_page("logged_in")]
    for item in payload["itemList"]:
        item["video"].update({"hdrMode": 1, "HDRType": 1, "isDrmFree": True})
        item["dramaInfo"]["encryptedUid"] = ENCRYPTED_UID
        item["dramaInfo"]["authorInfo"] = {"encrypted_id": "x", "no_drm": 1, "nonEncrypted": True}
    episodes = parse_item_list_payload(payload, PAID_SERIES_ID).episodes
    assert [(e.access, e.paid, e.drm, e.lock_hints) for e in episodes] == expected
    assert [e.access for e in episodes] == ["free", "free", "unlocked", "locked"]
    assert not any(e.drm for e in episodes)


@pytest.mark.parametrize(("key", "value"), [("blockStatus", 1), ("isBlocked", True)])
def test_block_is_not_lock(key, value):
    """`lock_?status` and the old heuristic's leftovers do not match `block…` keys: no clue at
    all — where `lockStatus: 1` and `isLocked: true` lock the episode."""
    for item in _everywhere(key, value):
        assert access_of(item) == ("free", False, False, (), False)
    for variant in (key.upper(), key[0].upper() + key[1:], f"un{key}"):
        assert access_of(_item({variant: value})) == ("free", False, False, (), False), variant
    unblocked = key.replace("block", "lock").replace("Block", "Lock")
    assert access_of(_item({unblocked: value}))[0] == "locked"


UNLOCKED = ("unlocked", True, False)
LOCKED = ("locked", False, False)
FREE = ("free", False, False)


@pytest.mark.parametrize(
    ("key", "value", "expected"),
    [
        # a `lock_?status` key whose word before `Lock` merely ends in b: a lock, as before 7b
        ("subLockStatus", 1, LOCKED),
        ("subLockStatus", "locked", LOCKED),
        ("webLockStatus", True, LOCKED),
        ("clubLockStatus", "1", LOCKED),
        ("dubLockStatus", 1, LOCKED),
        ("WEBLockStatus", 1, LOCKED),  # an acronym run that ends in B
        ("blockLockStatus", 1, LOCKED),  # a lock word next to a block word
        # the old heuristic's leftovers: a pricing clue, as before 7b
        ("isSubLocked", True, UNLOCKED),
        ("subLock", 1, UNLOCKED),
        ("webLock", 1, UNLOCKED),
        ("DBLock", 1, UNLOCKED),
        ("isBlockLocked", True, UNLOCKED),
    ],
)
def test_a_word_that_ends_in_b_before_lock_is_not_block(key, value, expected):
    """Only a word that CONTAINS `block` is no lock word (`test_block_is_not_lock`): `subLock…`,
    `webLock…` and `DBLock` are two words, the second a lock — such an episode is never
    attempted on a lock flag's account, nor a sold one without a play URL."""
    access, paid, drm, hints = access_of(_item({key: value}))[:4]
    assert (access, paid, drm) == expected
    assert hints == (f"{key}={value}",)
    if expected == UNLOCKED:  # sold, and no real play URL: locked, as for any sold episode
        assert access_of(_item({key: value}, video={"playAddr": "null"})) == (
            "locked",
            True,
            False,
            (f"{key}={value}", NO_PLAY_ADDRESS),
            False,  # 3.0.1: sold, so no guess of DramaFetch's alone
        )


@pytest.mark.parametrize(
    ("value", "expected", "hint"),
    [
        # a STRING value is read like an (unlock|pay|purchase)_?status one: ENTITLED ...
        *[(text, UNLOCKED, text) for text in ("unlocked", "paid", "purchased", "bought")],
        ("entitled", UNLOCKED, "entitled"),
        (" Unlocked ", UNLOCKED, "Unlocked"),
        # ... VIEWER-LOCK ...
        *[(text, LOCKED, text) for text in ("locked", "lock", "need_pay", "needpay", "unpaid")],
        ("unpurchased", LOCKED, "unpurchased"),
        ("NEED_PAY", LOCKED, "NEED_PAY"),
        # ... and any other non-falsy string is AMBIGUOUS: a hint that never decides
        ("pending", FREE, "pending"),
        ("on", FREE, "on"),
        # a bool or a number stays a lock when truthy (unchanged) ...
        (True, LOCKED, "True"),
        (1, LOCKED, "1"),
        (2, LOCKED, "2"),
        # ... and so does a string that spells one, the way `_truthy` reads "0" and "false"
        ("1", LOCKED, "1"),
        ("2", LOCKED, "2"),
        (" 1 ", LOCKED, "1"),
        ("-1", LOCKED, "-1"),
        ("1.5", LOCKED, "1.5"),
        ("true", LOCKED, "true"),
        ("TRUE", LOCKED, "TRUE"),
        ("yes", LOCKED, "yes"),
        # falsy: no clue at all
        (False, FREE, None),
        (0, FREE, None),
        ("0", FREE, None),
        ("false", FREE, None),
        ("no", FREE, None),
        ("none", FREE, None),
        ("", FREE, None),
    ],
)
def test_a_lock_status_string_reads_like_a_status(value, expected, hint):
    for key in ("lockStatus", "lock_status", "LockStatus", "episodeLockStatus"):
        access, paid, drm, hints = access_of(_item({key: value}))[:4]
        assert (access, paid, drm) == expected, key
        assert hints == ((f"{key}={hint}",) if hint is not None else ()), key


def test_lock_status_unlocked_with_a_play_address_is_unlocked_and_an_unknown_one_never_decides():
    assert access_of(_item({"lockStatus": "unlocked"})) == (
        "unlocked",
        True,
        False,
        ("lockStatus=unlocked",),
        False,
    )
    # an entitlement needs no play address; without one the episode is still the account's
    assert access_of(_item({"lockStatus": "unlocked"}, video={}))[0] == "unlocked"
    # an unknown string decides nothing: the price, then the play address, do
    assert access_of(_item({"lockStatus": "pending", "isFree": False}))[:3] == (
        "unlocked",
        True,
        False,
    )
    assert access_of(_item({"lockStatus": "pending"}, video={}))[0] == "locked"
    assert access_of(_item({"lockStatus": "pending", "isLocked": True}))[0] == "locked"
    # a lock spelled as a string still locks a sold episode TikTok gave this session a URL for
    assert access_of(_item({"isFree": False, "unlockPrice": 30, "lockStatus": "1"})) == (
        "locked",
        True,
        False,
        ("isFree=false", "unlockPrice=30", "lockStatus=1"),
        False,
    )


#: Keys the fuzz test draws from: every clue class, the containers access_of walks, and noise.
_FUZZ_KEYS = (
    "isLocked",
    "isUnlocked",
    "is_locked",
    "locked",
    "hasPaid",
    "paidByUser",
    "isFree",
    "free",
    "unlockPrice",
    "price",
    "coin",
    "cost",
    "charge",
    "vip",
    "isPaid",
    "needPay",
    "preview",
    "trial",
    "paywall",
    "lockStatus",
    "unlockStatus",
    "payStatus",
    "purchaseStatus",
    "drm",
    "isEncrypted",
    "DRMType",
    "isDrmFree",
    "encryptedUid",
    "hdrMode",
    "blockStatus",
    "lock_status",
    "unlockType",
    "dramaInfo",
    "video",
    "itemStruct",
    "playAddr",
    "bitrateInfo",
    "DramaVideoData",
    "EpisodeNumber",
    "id",
    "",
    "  ",
    "ü",
    "😀",
    "None",
    "0",
)
_FUZZ_SCALARS = (
    None,
    True,
    False,
    0,
    1,
    -1,
    2**63,
    10**5000,
    0.0,
    -0.0,
    1.5,
    float("nan"),
    float("inf"),
    "",
    " ",
    "0",
    "false",
    "true",
    "none",
    "null",
    "unlocked",
    "locked",
    "need_pay",
    "x" * 500,
    "\u202e",
    "https://v16-webapp-prime.tiktok.com/v/?expire=1",
    "²",  # a digit to str.isdigit(), not to int()
    "7" * 5000,  # more digits than int() converts
)


def _junk(rng, depth=0):
    roll = rng.random()
    if depth > 6 or roll < 0.45:
        return rng.choice(_FUZZ_SCALARS)
    if roll < 0.75:
        return {rng.choice(_FUZZ_KEYS): _junk(rng, depth + 1) for _ in range(rng.randint(0, 6))}
    return [_junk(rng, depth + 1) for _ in range(rng.randint(0, 4))]


def test_access_of_never_raises_and_is_deterministic_on_junk():
    rng = random.Random(7)
    seen = set()
    for _ in range(3000):
        item = _junk(rng)
        if not isinstance(item, dict):
            item = {"dramaInfo": item, "video": _junk(rng), rng.choice(_FUZZ_KEYS): _junk(rng)}
        access, paid, drm, hints, guessed = access_of(item)
        seen.add(access)
        assert access in ACCESS_MODES
        assert isinstance(paid, bool) and isinstance(drm, bool)
        assert not drm or access == "locked"
        # 3.0.1: a guessed lock is a locked episode with no DRM, price or entitlement clue
        assert isinstance(guessed, bool) and (
            not guessed or (access, paid, drm) == ("locked", False, False)
        )
        assert isinstance(hints, tuple) and all(isinstance(hint, str) for hint in hints)
        assert len(set(hints)) == len(hints)
        assert access_of(copy.deepcopy(item)) == (access, paid, drm, hints, guessed)
        assert lock_hints(item) == hints
        episode = episode_from_item(item, "s")  # builds an Episode: its checks never trip
        assert episode is None or (
            episode.access,
            episode.paid,
            episode.drm,
            episode.guessed_lock,
        ) == (
            access,
            paid,
            drm,
            guessed,
        )
    assert seen == set(ACCESS_MODES)
    for junk in (None, [], "x", 5, 1.5, ["isLocked", True]):
        assert access_of(junk) == ("locked", False, False, (NO_PLAY_ADDRESS,), True)
    deep: dict = {"isUnlocked": True}
    for _ in range(50):
        deep = {"inner": deep}  # deeper than MAX_DEPTH: cut, never a RecursionError
    assert access_of(_item(deep))[0] == "free"


# --------------------------------------------------------------------------- the whole list (3.0.1)
#
# The owner's report of 2026-11-27: some dramas lost one or two free episodes without a word.
# TikTok's own count (dramaInfo.numVideos), an episode number that falls through to the next key,
# duplicates found BEFORE the number merge (the episode over a highlight, free or unlocked over
# locked, the longer over the shorter, the first listed) and every item that is no episode, kept
# with its reason and said.

FIFTH_SERIES_ID = "7699393770256782377"
E2_ID = "7699400000000000602"
HIGHLIGHT_OF_E2 = "7699400000000000692"
TRAILER_ID = "7699400000000000690"
FOREIGN_ID = "7699400000000000778"
#: The fifth series' duplicate, as the warnings name it.
HIGHLIGHT_WARNING = (
    f"duplicate episode number 2: item {HIGHLIGHT_OF_E2} left out (a highlight), item {E2_ID} kept"
)


def _series5_pages():
    """The fifth series' two pages (fixtures/item_list_series5_page{1,2}.json): the series-4
    capture's item shape, with a highlight of episode 2 numbered 2 and listed before it, an
    episode whose EpisodeNumber is 0 and whose number is in dramaInfo, a trailer, another drama's
    item, and TikTok's count (numVideos 7: five episodes, the highlight and the trailer)."""
    fixtures = Path(__file__).parent / "fixtures"
    return [
        json.loads((fixtures / f"item_list_series5_page{n}.json").read_text(encoding="utf-8"))
        for n in (1, 2)
    ]


def _numbered(page):
    return [(e.number, e.item_id[-3:]) for e in page]


def test_the_fifth_series_reads_like_the_real_captures():
    first, second = (parse_item_list_payload(page, FIFTH_SERIES_ID) for page in _series5_pages())
    # page 1: E1, the highlight of E2 (numbered 2, listed first), E2, E3 (EpisodeNumber 0: its
    # number is dramaInfo's episodeNumber), the trailer (EpisodeNumber 0 and nothing else)
    assert _numbered(first.episodes) == [(1, "601"), (2, "692"), (2, "602"), (3, "603")]
    assert (first.cursor, first.has_more, first.seen_items, first.skipped_items) == (5, True, 5, 1)
    assert first.skipped == [SkippedItem(SKIP_NO_NUMBER, TRAILER_ID)]
    assert first.total_hint == 7  # TikTok's count: numVideos
    # page 2: another drama's item first — its numVideos (12) is no count of this drama
    assert _numbered(second.episodes) == [(4, "604"), (5, "605")]
    assert (second.cursor, second.has_more, second.seen_items) == (8, False, 3)
    assert second.skipped == [SkippedItem(SKIP_OTHER_DRAMA, FOREIGN_ID)]
    assert second.total_hint == 7
    assert all(not e.locked and e.access == "free" for e in [*first.episodes, *second.episodes])

    listing = merge_pages([first, second])
    assert isinstance(listing, Listing)
    # the episode, never its highlight, is episode 2
    assert _numbered(listing.episodes) == [
        (1, "601"),
        (2, "602"),
        (3, "603"),
        (4, "604"),
        (5, "605"),
    ]
    assert listing.episodes[1].duration_s == 98
    ((duplicate,),) = [listing.duplicates]
    assert isinstance(duplicate, Duplicate)
    assert (duplicate.number, duplicate.kept.item_id, duplicate.left_out.item_id) == (
        2,
        E2_ID,
        HIGHLIGHT_OF_E2,
    )
    assert duplicate.why == LEFT_OUT_HIGHLIGHT
    assert listing.skipped == [
        SkippedItem(SKIP_NO_NUMBER, TRAILER_ID),
        SkippedItem(SKIP_OTHER_DRAMA, FOREIGN_ID),
    ]
    # five episodes, the highlight and the trailer: TikTok's 7 all came (another drama's item is
    # not this drama's). 3.0.1, the lead's decision D2 (changed on purpose): whether TikTok counts
    # the highlight and the trailer is not known, so no number past 5 is named missing — and the
    # list is UNCERTAIN: TikTok counts 7, the drama certainly has 5, its 2 other items may be in
    # the count. Said (the count and the uncertainty), never complete.
    assert (listing.items_received, listing.total_hint) == (7, 7)
    numbers = [e.number for e in listing.episodes]
    assert count_check(numbers, 7, listing.items_received) == CountCheck(5, 2, True)
    assert missing_numbers(numbers, 7, listing.items_received, limit=10_000) == []
    assert catalog_warnings(
        listing.episodes,
        listing.total_hint,
        duplicates=listing.duplicates,
        skipped=listing.skipped,
        items_received=listing.items_received,
    ) == [
        HIGHLIGHT_WARNING,
        "TikTok listed 1 item DramaFetch could not read (another drama's id)",
        "TikTok listed 1 item DramaFetch could not read (no episode number)",
        "TikTok announces 7 episodes, 5 listed",
        uncertain_text(7, 5, 2),
    ]

    # the list ended after page 1: five of TikTok's seven items came, three episodes and two other
    # items (the highlight, the trailer): numbers 4 and 5 are certainly missing (7 - 2), 6 and 7
    # are not named (3.0.1, D2: no phantom episode) — the list is uncertain past 5
    early = merge_pages([first])
    assert (early.items_received, early.total_hint) == (5, 7)
    assert count_check([1, 2, 3], 7, early.items_received) == CountCheck(5, 2, True)
    assert missing_numbers([1, 2, 3], 7, early.items_received, limit=10_000) == [4, 5]
    assert catalog_warnings(
        early.episodes,
        early.total_hint,
        duplicates=early.duplicates,
        skipped=early.skipped,
        items_received=early.items_received,
    ) == [
        HIGHLIGHT_WARNING,
        "TikTok listed 1 item DramaFetch could not read (no episode number)",
        "TikTok announces 7 episodes, 3 listed",
        uncertain_text(7, 3, 2),
    ]
    # the highlight listed AFTER its episode changes nothing
    page = _series5_pages()[0]
    page["itemList"][1], page["itemList"][2] = page["itemList"][2], page["itemList"][1]
    reordered = merge_pages([parse_item_list_payload(page, FIFTH_SERIES_ID)])
    assert reordered.episodes[1].item_id == E2_ID
    assert [d.left_out.item_id for d in reordered.duplicates] == [HIGHLIGHT_OF_E2]


def test_num_videos_is_tiktok_s_count_and_the_first_total_key_of_the_detail():
    assert parse_detail_payload({"dramaInfo": {"dramaName": "D", "numVideos": 62}}) == ("D", 62)
    # TikTok's own key wins over the older guesses in the same object
    assert parse_detail_payload({"dramaInfo": {"numVideos": 62, "totalEpisode": 60}}) == (None, 62)
    assert parse_detail_payload({"dramaInfo": {"numVideos": 0, "totalEpisode": 60}}) == (None, 60)
    assert parse_detail_payload({"drama": {"numVideos": "62"}}) == (None, 62)
    # with the series' id, a related drama's object gives neither its name nor its count
    related = {
        "data": {
            "recommended": {"dramaInfo": {"dramaID": "1", "dramaName": "Other", "numVideos": 12}},
            "dramaInfo": {"dramaID": FIFTH_SERIES_ID, "dramaName": "Mine", "numVideos": 7},
        }
    }
    assert parse_detail_payload(related) == ("Other", 12)  # without the id: the first found
    assert parse_detail_payload(related, FIFTH_SERIES_ID) == ("Mine", 7)
    assert parse_detail_payload(related, int(FIFTH_SERIES_ID)) == ("Mine", 7)
    unnamed = {"dramaInfo": {"dramaName": "No id", "numVideos": 5}}
    assert parse_detail_payload(unnamed, FIFTH_SERIES_ID) == ("No id", 5)  # no id: not another's
    assert parse_detail_payload({"dramaInfo": {"albumId": "9", "numVideos": 5}}, "8") == (
        None,
        None,
    )


@pytest.mark.parametrize(
    ("drama", "expected"),
    [
        ({"numVideos": 62}, 62),
        ({"numVideos": "62"}, 62),
        ({"numVideos": " 62 "}, 62),
        ({"numVideos": 62.0}, 62),
        ({"numVideos": 0}, None),
        ({"numVideos": -3}, None),
        ({"numVideos": 2.5}, None),
        ({"numVideos": True}, None),
        ({"numVideos": "x"}, None),
        ({"numVideos": None}, None),
        ({"numVideos": [62]}, None),
        ({"numVideos": MAX_EXACT_INT + 1}, None),
        ({}, None),
        ({"dramaID": OTHER_SERIES_ID, "numVideos": 12}, None),  # another drama's count
        ({"dramaID": FIFTH_SERIES_ID, "numVideos": 7}, 7),
        ({"DramaVideoData": {"numVideos": 7}}, None),  # dramaInfo's own key only
    ],
)
def test_item_total_hint_reads_the_series_num_videos(drama, expected):
    assert item_total_hint({"id": "1", "dramaInfo": drama}, FIFTH_SERIES_ID) == expected
    wrapped = {"itemStruct": {"id": "1", "dramaInfo": drama}}
    assert item_total_hint(wrapped, FIFTH_SERIES_ID) == expected


def test_item_total_hint_and_the_page_count_never_raise_on_junk():
    for junk in (None, "x", 5, [], {"dramaInfo": "x"}, {"dramaInfo": [1]}):
        assert item_total_hint(junk, "s") is None
    # the page's count is its first positive one, from an item of the series, wherever it is
    items = [
        {"id": "a", "dramaInfo": {"dramaID": "other", "numVideos": 40}},
        {"id": "b", "dramaInfo": {"numVideos": 0, "DramaVideoData": {"EpisodeNumber": 1}}},
        {"id": "c", "dramaInfo": {"dramaID": "s", "DramaVideoData": {}, "numVideos": "9"}},
        {"id": "d", "dramaInfo": {"numVideos": 11, "DramaVideoData": {"EpisodeNumber": 2}}},
    ]
    page = parse_item_list_payload({"itemList": items}, "s")
    assert page.total_hint == 9  # the trailer "c" carries it too: an item of the series
    assert parse_item_list_payload({"itemList": items[:2]}, "s").total_hint is None
    assert parse_item_list_payload({"itemList": []}, "s").total_hint is None


@pytest.mark.parametrize("junk", [0, None, "", " ", "x", -1, 2.5, True, {}, [3], "²"])
def test_an_unusable_episode_number_falls_through_to_the_next_key(junk):
    # DramaVideoData's other number keys first...
    item = _base_item()
    item["dramaInfo"]["DramaVideoData"] = {"EpisodeNumber": junk, "episodeNumber": 6}
    episode = episode_from_item(item, SERIES_ID)
    assert episode is not None and episode.number == 6
    # ... then dramaInfo's own keys
    item = _base_item()
    item["dramaInfo"]["DramaVideoData"] = {"EpisodeNumber": junk, "episode_number": junk}
    item["dramaInfo"]["episodeNumber"] = 17
    episode = episode_from_item(item, SERIES_ID)
    assert episode is not None and episode.number == 17
    assert skip_reason(item, SERIES_ID) is None
    # nothing usable anywhere: a trailer, skipped with its reason
    item["dramaInfo"]["episodeNumber"] = junk
    assert episode_from_item(item, SERIES_ID) is None
    assert skip_reason(item, SERIES_ID) == SKIP_NO_NUMBER


def test_the_first_usable_number_wins_in_key_order():
    item = _base_item()
    item["dramaInfo"]["DramaVideoData"] = {"EpisodeNumber": 4, "episodeNumber": 9}
    item["dramaInfo"]["EpisodeNumber"] = 12
    episode = episode_from_item(item, SERIES_ID)
    assert episode is not None and episode.number == 4
    item["dramaInfo"]["DramaVideoData"] = "not a dict"
    episode = episode_from_item(item, SERIES_ID)
    assert episode is not None and episode.number == 12


def test_skip_reason_says_why_an_item_is_no_episode_in_order():
    assert SKIP_REASONS == (SKIP_OTHER_DRAMA, SKIP_NO_ID, SKIP_NO_NUMBER)
    assert (SKIP_OTHER_DRAMA, SKIP_NO_ID, SKIP_NO_NUMBER) == (
        "another drama's id",
        "no id",
        "no episode number",
    )
    assert skip_reason(_base_item(), SERIES_ID) is None
    other = _base_item()
    other["dramaInfo"]["dramaID"] = OTHER_SERIES_ID
    assert skip_reason(other, SERIES_ID) == SKIP_OTHER_DRAMA
    del other["id"]  # another drama's item without an id is another drama's first
    assert skip_reason(other, SERIES_ID) == SKIP_OTHER_DRAMA
    no_id = _base_item()
    no_id["id"] = "  "
    assert skip_reason(no_id, SERIES_ID) == SKIP_NO_ID
    del no_id["dramaInfo"]["DramaVideoData"]  # no id before no number
    assert skip_reason(no_id, SERIES_ID) == SKIP_NO_ID
    trailer = _base_item()
    del trailer["dramaInfo"]["DramaVideoData"]
    assert skip_reason(trailer, SERIES_ID) == SKIP_NO_NUMBER
    assert skip_reason({"itemStruct": trailer}, SERIES_ID) == SKIP_NO_NUMBER
    for junk in (None, "x", 5, []):
        assert skip_reason(junk, SERIES_ID) == SKIP_NO_ID
    # the page keeps each skipped item with its reason and its id, in page order
    page = parse_item_list_payload({"itemList": [no_id, _base_item(), trailer, other]}, SERIES_ID)
    assert [e.number for e in page.episodes] == [7]
    assert page.skipped == [
        SkippedItem(SKIP_NO_ID, None),
        SkippedItem(SKIP_NO_NUMBER, "1"),
        SkippedItem(SKIP_OTHER_DRAMA, None),
    ]
    assert (page.seen_items, page.skipped_items) == (4, 3)


@pytest.mark.parametrize(
    ("video_data", "expected"),
    [
        ({"IsHighlight": False, "LinkedEpisodeID": "0"}, False),  # every captured episode
        ({}, False),
        ({"IsHighlight": True}, True),
        ({"IsHighlight": 1}, True),
        ({"IsHighlight": "true"}, True),
        ({"IsHighlight": "false"}, False),
        ({"IsHighlight": "0"}, False),
        ({"IsHighlight": 0}, False),
        ({"IsHighlight": None}, False),
        ({"IsHighlight": {"x": 1}}, False),  # a container never counts
        ({"IsHighlight": [1]}, False),
        ({"LinkedEpisodeID": "7699400000000000602"}, True),
        ({"LinkedEpisodeID": 7699400000000000602}, True),
        ({"LinkedEpisodeID": " 0 "}, False),
        ({"LinkedEpisodeID": 0}, False),
        ({"LinkedEpisodeID": ""}, False),
        ({"LinkedEpisodeID": None}, False),
        ({"LinkedEpisodeID": True}, False),
        ({"LinkedEpisodeID": 1.5}, False),
        ({"IsHighlight": False, "LinkedEpisodeID": "12"}, True),
    ],
)
def test_is_highlight_reads_is_highlight_and_linked_episode_id(video_data, expected):
    item = {"id": "1", "dramaInfo": {"DramaVideoData": {"EpisodeNumber": 2, **video_data}}}
    assert is_highlight(item) is expected
    assert is_highlight({"itemStruct": item}) is expected
    # dramaInfo's own keys count too
    flat = {"id": "1", "dramaInfo": {"DramaVideoData": {"EpisodeNumber": 2}, **video_data}}
    assert is_highlight(flat) is expected


def test_is_highlight_never_raises_on_junk():
    for junk in (None, "x", 5, [], {}, {"dramaInfo": "x"}, {"dramaInfo": {"DramaVideoData": 3}}):
        assert is_highlight(junk) is False


def _candidate(item_id, *, highlight=False, locked=False, duration=None, number=2):
    raw = {"id": item_id, "dramaInfo": {"DramaVideoData": {"EpisodeNumber": number}}}
    if highlight:
        raw["dramaInfo"]["DramaVideoData"]["IsHighlight"] = True
    return Episode(
        number=number,
        item_id=item_id,
        title=item_id,
        series_id="s",
        duration_s=duration,
        access="locked" if locked else "free",
        raw=raw,
    )


def _kept_and_left_out(*candidates):
    listing = merge_pages([PagePayload(list(candidates), None, False, len(candidates), 0)])
    return listing.episodes[0].item_id, [(d.left_out.item_id, d.why) for d in listing.duplicates]


def test_the_merge_keeps_one_episode_per_number_by_the_preference_order():
    assert LEFT_OUT_REASONS == (
        LEFT_OUT_HIGHLIGHT,
        LEFT_OUT_LOCKED,
        LEFT_OUT_SHORTER,
        LEFT_OUT_LATER,
    )
    clip = _candidate("clip", highlight=True, duration=99)
    episode = _candidate("ep", duration=40)
    # no highlight over a highlight — whatever the order, the access or the length
    assert _kept_and_left_out(clip, episode) == ("ep", [("clip", LEFT_OUT_HIGHLIGHT)])
    assert _kept_and_left_out(episode, clip) == ("ep", [("clip", LEFT_OUT_HIGHLIGHT)])
    locked = _candidate("locked-ep", locked=True, duration=99)
    assert _kept_and_left_out(locked, clip) == ("locked-ep", [("clip", LEFT_OUT_HIGHLIGHT)])
    # then free or unlocked over locked
    free = _candidate("free", duration=10)
    assert _kept_and_left_out(locked, free) == ("free", [("locked-ep", LEFT_OUT_LOCKED)])
    unlocked = replace(_candidate("unlocked", duration=10), access="unlocked", paid=True)
    assert _kept_and_left_out(locked, unlocked) == ("unlocked", [("locked-ep", LEFT_OUT_LOCKED)])
    # then the longer video.duration — an unknown one is the shortest
    short, long = _candidate("short", duration=41), _candidate("long", duration=98)
    assert _kept_and_left_out(short, long) == ("long", [("short", LEFT_OUT_SHORTER)])
    unknown = _candidate("unknown", duration=None)
    assert _kept_and_left_out(unknown, short) == ("short", [("unknown", LEFT_OUT_SHORTER)])
    zero = _candidate("zero", duration=0)
    assert _kept_and_left_out(unknown, zero) == ("zero", [("unknown", LEFT_OUT_SHORTER)])
    # then the first listed
    twin_a, twin_b = _candidate("a", duration=90), _candidate("b", duration=90)
    assert _kept_and_left_out(twin_a, twin_b) == ("a", [("b", LEFT_OUT_LATER)])
    assert _kept_and_left_out(twin_b, twin_a) == ("b", [("a", LEFT_OUT_LATER)])
    # three items with one number: every one left out is named, as listed
    kept, left = _kept_and_left_out(clip, short, locked, long)
    assert kept == "long"
    assert left == [
        ("clip", LEFT_OUT_HIGHLIGHT),
        ("short", LEFT_OUT_SHORTER),
        ("locked-ep", LEFT_OUT_LOCKED),
    ]
    # the same item served twice is one item, never a duplicate
    listing = merge_pages(
        [
            PagePayload([short], None, False, 1, 0),
            PagePayload([replace(short, title="again")], None, False, 1, 0),
        ]
    )
    assert [e.title for e in listing.episodes] == ["short"] and listing.duplicates == []
    # merge_episodes is the same merge
    assert merge_episodes([[clip, short], [long]]) == [long]
    # a hand-built episode without its payload is no highlight
    assert _kept_and_left_out(replace(clip, raw=None), episode)[0] == "clip"


def test_merge_pages_counts_the_items_received_and_keeps_the_skipped_reasons():
    one, two = _candidate("e1", number=1), _candidate("e2", number=2)
    pages = [
        PagePayload(
            [one],
            3,
            True,
            4,
            3,
            [
                SkippedItem(SKIP_NO_NUMBER, "trailer"),
                SkippedItem(SKIP_NO_ID),
                SkippedItem(SKIP_OTHER_DRAMA, "foreign"),
            ],
            0,
        ),
        PagePayload(
            [two],
            None,
            False,
            5,
            4,
            [
                SkippedItem(SKIP_NO_NUMBER, "trailer"),  # the same trailer again: once
                SkippedItem(SKIP_NO_NUMBER, "e1"),  # read as an episode on page 1: no skip
                SkippedItem(SKIP_NO_ID),  # no id: each one counts
                SkippedItem(SKIP_OTHER_DRAMA, "foreign-2"),
            ],
            9,
        ),
        PagePayload([], None, False, 0, 0, [], 4),
    ]
    listing = merge_pages(pages)
    assert listing.skipped == [
        SkippedItem(SKIP_NO_NUMBER, "trailer"),
        SkippedItem(SKIP_NO_ID),
        SkippedItem(SKIP_OTHER_DRAMA, "foreign"),
        SkippedItem(SKIP_NO_ID),
        SkippedItem(SKIP_OTHER_DRAMA, "foreign-2"),
    ]
    # two episodes, the trailer and two items without an id; another drama's items do not count
    assert listing.items_received == 5
    assert listing.total_hint == 9  # the first positive count (page 1 said 0)
    assert merge_pages([]) == Listing([], [], [], 0, None)


#: The owner's report of 2026-11-27 (4.0.1, "y los episodios existen"): a drama of 66 episodes whose
#: list TikTok serves whole — 66 items, TikTok's count 66 (``numVideos``) — where the items of
#: episodes 9 and 17 carry TikTok's highlight marks and no other item holds 9 or 17. Both are full
#: episodes that play on TikTok; 3.0.1 read them "missing (gap)". Ids and name anonymised.
OWNERS_DRAMA_ID = "7699393770256782381"
OWNERS_MARKED = (9, 17)


def _owners_drama(marks):
    """The owner's drama as TikTok's one ``item_list`` answer, in the captured item shape: 66
    items (``7699400000000000701`` … ``…766``), ``numVideos`` 66 on each, ``marks`` on the
    ``DramaVideoData`` of episodes 9 and 17, ``IsHighlight: false`` and ``LinkedEpisodeID: "0"``
    on every other one."""
    items = []
    for number in range(1, 67):
        video_data = {"EpisodeNumber": number, "IsHighlight": False, "LinkedEpisodeID": "0"}
        if number in OWNERS_MARKED:
            video_data.update(marks)
        items.append(
            {
                "id": f"7699400000000000{700 + number}",
                "desc": f"Episode {number}",
                "dramaInfo": {
                    "dramaID": OWNERS_DRAMA_ID,
                    "dramaName": "The Owner's Drama",
                    "numVideos": 66,
                    "DramaVideoData": video_data,
                },
                "video": {"duration": 95, **PLAYABLE},
            }
        )
    return {"statusCode": 0, "itemList": items, "cursor": 66, "hasMore": False}


@pytest.mark.parametrize(
    "marks", [{"IsHighlight": True}, {"LinkedEpisodeID": "7699400000000000999"}]
)
def test_an_episode_tiktok_marks_as_a_highlight_is_the_episode_of_its_number(marks):
    """4.0.1, the owner's drama (66 items for 66 episodes, TikTok counts 66, episodes 9 and 17
    marked as highlights and alone with their numbers): TikTok marks some full episodes as
    highlights, so a number only highlights hold keeps one of them as its episode — every episode
    listed, nothing missing, nothing uncertain, no warning; it downloads like any other."""
    page = parse_item_list_payload(_owners_drama(marks), OWNERS_DRAMA_ID)
    assert (page.seen_items, page.skipped_items, page.total_hint) == (66, 0, 66)
    listing = merge_pages([page])
    assert [e.number for e in listing.episodes] == list(range(1, 67))
    for number in OWNERS_MARKED:
        episode = listing.episodes[number - 1]
        assert episode.item_id == f"7699400000000000{700 + number}"
        assert is_highlight(episode.raw)
        assert (episode.access, episode.locked) == ("free", False)
    assert (listing.duplicates, listing.skipped) == ([], [])
    assert (listing.items_received, listing.total_hint) == (66, 66)
    numbers = [e.number for e in listing.episodes]
    assert count_check(numbers, 66, listing.items_received) == CountCheck(66, 0, False)
    assert missing_numbers(numbers, 66, listing.items_received, limit=10_000) == []
    assert fill_target(numbers, 66, listing.items_received, early_end=False, limit=10_000) is None
    assert (
        catalog_warnings(
            listing.episodes,
            listing.total_hint,
            duplicates=listing.duplicates,
            skipped=listing.skipped,
            items_received=listing.items_received,
        )
        == []
    )
    assert merge_episodes([page.episodes]) == listing.episodes


def test_a_number_only_highlights_hold_keeps_one_of_them_as_its_episode():
    """4.0.1 (the owner's report of 2026-11-27; 3.0.1's "a highlight never stands for an episode"
    withdrawn): TikTok marks some full episodes as highlights, so a highlight no other item of its
    number came with is that number's episode — listed, downloaded, counted among the episode
    numbers (never among the drama's other items), no skipped item, its number never missing —;
    of several such highlights the merge keeps one by its usual order (free or unlocked, then the
    longer, then the first listed), the others the duplicates it left out; a highlight beside an
    item that is no highlight stays the duplicate left out, as before."""
    first, second = (parse_item_list_payload(page, FIFTH_SERIES_ID) for page in _series5_pages())
    lone = [e for e in first.episodes if e.item_id != E2_ID]  # TikTok lists the highlight, not E02
    listing = merge_pages([replace(first, episodes=lone), second])
    assert [e.number for e in listing.episodes] == [1, 2, 3, 4, 5]
    assert listing.episodes[1].item_id == HIGHLIGHT_OF_E2
    assert is_highlight(listing.episodes[1].raw) and not listing.episodes[1].locked
    assert listing.duplicates == []
    assert listing.skipped == [
        SkippedItem(SKIP_NO_NUMBER, TRAILER_ID),
        SkippedItem(SKIP_OTHER_DRAMA, FOREIGN_ID),
    ]
    # E01, the highlight (E02 now), E03-E05 and the trailer: 6 items, 5 numbers, 1 other item —
    # the trailer alone; TikTok's 7 then places E06 (7 - 1), the count rule as ever (3.0.1)
    assert listing.items_received == 6
    numbers = [e.number for e in listing.episodes]
    assert count_check(numbers, 7, listing.items_received) == CountCheck(6, 1, True)
    assert missing_numbers(numbers, 7, listing.items_received, limit=10_000) == [6]
    assert catalog_warnings(
        listing.episodes,
        7,
        duplicates=listing.duplicates,
        skipped=listing.skipped,
        items_received=listing.items_received,
    ) == [
        "TikTok listed 1 item DramaFetch could not read (another drama's id)",
        "TikTok listed 1 item DramaFetch could not read (no episode number)",
        "TikTok announces 7 episodes, 5 listed",
        uncertain_text(7, 5, 1),
    ]
    # with no count, nothing is missing and nothing is said but the skipped items
    assert missing_numbers(numbers, None, listing.items_received, limit=10_000) == []
    assert catalog_warnings(listing.episodes, None, skipped=listing.skipped) == [
        "TikTok listed 1 item DramaFetch could not read (another drama's id)",
        "TikTok listed 1 item DramaFetch could not read (no episode number)",
    ]
    # two highlights of one number and no other item: the longer is the episode, the shorter the
    # duplicate left out — no skipped item
    clip_a = _candidate("clip-a", highlight=True, duration=40)
    clip_b = _candidate("clip-b", highlight=True, duration=50)
    one = _candidate("e1", number=1)
    both = merge_pages([PagePayload([one, clip_a, clip_b], None, False, 3, 0)])
    assert [e.item_id for e in both.episodes] == ["e1", "clip-b"]
    assert both.duplicates == [Duplicate(2, clip_b, clip_a, LEFT_OUT_SHORTER)]
    assert both.skipped == [] and both.items_received == 3
    assert missing_numbers([e.number for e in both.episodes], None, 3, limit=10_000) == []
    assert merge_episodes([[one, clip_a]]) == [one, clip_a]
    # among highlights only, the usual order from its second rule on: free over locked, then the
    # first listed
    locked_clip = _candidate("locked-clip", highlight=True, locked=True, duration=99)
    assert _kept_and_left_out(locked_clip, clip_a) == ("clip-a", [("locked-clip", LEFT_OUT_LOCKED)])
    twin = _candidate("clip-a2", highlight=True, duration=40)
    assert _kept_and_left_out(clip_a, twin) == ("clip-a", [("clip-a2", LEFT_OUT_LATER)])
    assert _kept_and_left_out(twin, clip_a) == ("clip-a2", [("clip-a", LEFT_OUT_LATER)])
    # the paired case is unchanged: the episode kept, the highlight the duplicate left out
    paired = merge_pages([first, second])
    assert [(d.left_out.item_id, d.why) for d in paired.duplicates] == [
        (HIGHLIGHT_OF_E2, LEFT_OUT_HIGHLIGHT)
    ]
    assert paired.episodes[1].item_id == E2_ID
    assert paired.skipped == listing.skipped
    assert paired.items_received == 7


def test_a_highlight_alone_with_its_number_at_the_top_of_the_list_is_the_last_episode():
    """4.0.1: TikTok lists the drama's last episode (66) only as an item it marks as a highlight —
    that item is episode 66: listed, nothing missing whether TikTok's count is unknown or 66, no
    filling request, no warning; the same for one alone with its number below the highest (30)."""
    episodes = [_candidate(f"e{number}", number=number) for number in range(1, 66)]
    clip = _candidate("clip-66", highlight=True, number=66)
    listing = merge_pages([PagePayload([*episodes, clip], None, False, 66, 0)])
    assert [e.number for e in listing.episodes] == list(range(1, 67))
    assert listing.episodes[-1] is clip
    assert (listing.duplicates, listing.skipped, listing.items_received) == ([], [], 66)
    numbers = [e.number for e in listing.episodes]
    for total in (None, 66):
        assert count_check(numbers, total, 66) == CountCheck(66, 0, False)
        assert missing_numbers(numbers, total, 66, limit=10_000) == []
        assert fill_target(numbers, total, 66, early_end=False, limit=10_000) is None
        assert catalog_warnings(listing.episodes, total, items_received=66) == []
    middle = [e for e in episodes if e.number != 30]
    alone = _candidate("clip-30", highlight=True, number=30)
    below = merge_pages([PagePayload([*middle, alone], None, False, 65, 0)])
    assert [e.number for e in below.episodes] == list(range(1, 66))
    assert below.episodes[29] is alone
    below_numbers = [e.number for e in below.episodes]
    assert missing_numbers(below_numbers, 65, 65, limit=10_000) == []
    assert catalog_warnings(below.episodes, 65, items_received=65) == []


def test_an_item_without_an_id_counts_once_per_listing():
    """3.0.1, the lead's decision D4 (the review's L4): the same id-less item served again — a
    gap filling overlaps the pages read before it — is one item: one skipped item, counted once in
    the items received and in the warning; two different id-less items stay two."""
    idless = {"dramaInfo": {"dramaID": SERIES_ID, "DramaVideoData": {"EpisodeNumber": 14}}}
    other = {"dramaInfo": {"dramaID": SERIES_ID, "DramaVideoData": {"EpisodeNumber": 15}}}
    episode = _base_item()
    first = parse_item_list_payload({"itemList": [episode, idless], "hasMore": True}, SERIES_ID)
    # the same item again, its keys in another order and a whole float for an int
    again = json.loads(json.dumps(idless))
    again["dramaInfo"] = {"DramaVideoData": {"EpisodeNumber": 14.0}, "dramaID": SERIES_ID}
    refill = parse_item_list_payload({"itemList": [again], "hasMore": False}, SERIES_ID)
    assert first.skipped_keys == [item_key(idless)]
    assert refill.skipped_keys == [item_key(again)] == [item_key(idless)]
    listing = merge_pages([first, refill])
    assert listing.skipped == [SkippedItem(SKIP_NO_ID)]
    assert listing.items_received == 2  # the episode and the one id-less item
    assert catalog_warnings(listing.episodes, None, skipped=listing.skipped) == [
        "episodes 1-6 missing (gap)",
        "TikTok listed 1 item DramaFetch could not read (no id)",
    ]
    distinct = parse_item_list_payload({"itemList": [other], "hasMore": False}, SERIES_ID)
    assert merge_pages([first, distinct]).items_received == 3
    # an item with an id gets no key; a page built by hand has none: each id-less item counts
    assert (
        parse_item_list_payload({"itemList": [episode, _base_item()]}, SERIES_ID).skipped_keys == []
    )
    hand = PagePayload([], None, False, 1, 1, [SkippedItem(SKIP_NO_ID)])
    assert merge_pages([hand, hand]).items_received == 2


def test_item_key_is_canonical_and_never_raises():
    assert item_key({"b": 1, "a": [2.0, {"d": None, "c": "é"}]}) == item_key(
        {"a": [2, {"c": "é", "d": None}], "b": 1.0}
    )
    assert item_key({"a": 1}) != item_key({"a": "1"})
    assert item_key({"a": True}) != item_key({"a": 1})
    assert item_key({"a": 2.5}) != item_key({"a": 2})
    assert item_key({"a": float("nan")}) == item_key({"a": None})
    assert item_key({"a": -0.0}) == item_key({"a": 0})
    deep: dict[str, object] = {}
    node = deep
    for _ in range(200):
        node["x"] = {}
        node = node["x"]  # type: ignore[assignment]
    assert isinstance(item_key(deep), str)
    for junk in (None, "x", 5, [], 2.0**80):
        assert isinstance(item_key(junk), str)


def test_an_answer_with_no_item_of_the_series_ends_nothing_when_more_was_expected():
    """3.0.1, the lead's decision D5 (the review's L5): an answer with no item of the series and
    hasMore false ends the list — unless it answers a cursor an earlier page announced with hasMore
    true, or a filling request (``expected_more``); a last page that brings items of the series
    still ends it, and a repeat never does."""
    empty = parse_item_list_payload({"itemList": [], "hasMore": False}, SERIES_ID)
    foreign = _base_item()
    foreign["dramaInfo"]["dramaID"] = OTHER_SERIES_ID
    only_other = parse_item_list_payload({"itemList": [foreign], "hasMore": False}, SERIES_ID)
    last = parse_item_list_payload({"itemList": [_base_item()], "hasMore": False}, SERIES_ID)
    for page in (empty, only_other):
        assert page_ends_list(page, []) is True
        assert page_ends_list(page, [], expected_more=True) is False
    assert page_ends_list(last, [], expected_more=True) is True
    assert page_ends_list(last, ["1"], expected_more=True) is False  # a repeat
    assert page_ends_list(last, [], listed=False) is False


@pytest.mark.parametrize(
    ("numbers", "total", "received", "expected"),
    [
        ([], None, None, CountCheck(0, 0, False)),
        ([1, 2, 3], None, 5, CountCheck(3, 2, False)),  # no count: the highest listed
        ([1, 2, 3], 0, None, CountCheck(3, 0, False)),
        ([1, 2, 3], -1, 0, CountCheck(3, 0, False)),
        ([1, 2, 3], 7, None, CountCheck(7, 0, False)),  # unknown items: the count stands
        ([1, 2, 3], 7, 3, CountCheck(7, 0, False)),  # no other item: 4-7 certainly missing
        ([1, 2, 3], 7, 5, CountCheck(5, 2, True)),  # 4-5 certain, 6-7 uncertain
        ([1, 2, 3], 7, 7, CountCheck(3, 4, True)),  # the count may be the items' alone
        ([1, 2, 3], 3, 5, CountCheck(3, 2, False)),  # the count placed: nothing uncertain
        ([1, 2, 3], 2, 5, CountCheck(3, 2, False)),  # more listed than announced
        ([1, 2, 5], 5, 4, CountCheck(5, 1, False)),  # a hole below the highest, the count met
        # the review's three cases: 66 episodes + a trailer, E66 never listed — uncertain, no
        # phantom; 6 + a trailer counted 7, E04 never listed — [4] only, uncertain; and no
        # other item, E66 never listed — 66 certainly missing, as before
        (list(range(1, 66)), 66, 66, CountCheck(65, 1, True)),
        ([1, 2, 3, 5, 6], 7, 6, CountCheck(6, 1, True)),
        (list(range(1, 66)), 66, 65, CountCheck(66, 0, False)),
    ],
)
def test_count_check_is_the_one_count_rule(numbers, total, received, expected):
    """3.0.1, the lead's decision D2: certain_top = max(H, C - S), uncertain when C is known and
    above it; S = items received - distinct numbers listed (the drama's other items)."""
    assert count_check(numbers, total, received) == expected
    assert count_check(iter(numbers), total, received) == expected


def test_the_review_cases_name_no_phantom_and_ask_once_past_the_highest():
    """3.0.1 (the review's L2 and V2): (a) 66 episodes and a trailer, TikTok counts 66, E66 never
    listed: nothing certainly missing, uncertain, one filling request for the page after 65; (b) 6
    episodes and a trailer, TikTok counts 7, E04 never listed: [4] only — no phantom 7 —, also
    uncertain; (c) no other item, TikTok counts 66, E66 never listed: [66], as before."""
    sixty_five = list(range(1, 66))
    assert missing_numbers(sixty_five, 66, 66, limit=10_000) == []
    assert fill_target(sixty_five, 66, 66, early_end=False, limit=10_000) == 66
    assert (
        fill_target(sixty_five, 66, 66, early_end=False, covered=[(66, None)], limit=10_000) is None
    )
    assert (
        fill_target(sixty_five, 66, 66, early_end=False, covered=[(66, 95)], limit=10_000) is None
    )
    six = [1, 2, 3, 5, 6]
    assert missing_numbers(six, 7, 6, limit=10_000) == [4]
    assert fill_target(six, 7, 6, early_end=False, limit=10_000) == 4
    # an answer from cursor 3 that says the list is over covers the page after 6 too: once
    assert fill_target(six, 7, 6, early_end=False, covered=[(4, None)], limit=10_000) is None
    assert fill_target(six, 7, 6, early_end=False, covered=[(4, 6)], limit=10_000) == 7
    assert missing_numbers(sixty_five, 66, 65, limit=10_000) == [66]
    assert fill_target(sixty_five, 66, 65, early_end=False, limit=10_000) == 66
    # a count everything listed accounts for asks nothing past the highest
    assert fill_target([1, 2, 3], 3, 5, early_end=True, limit=10_000) is None
    # the main fake series' shape (TikTok counts 5, five episodes and a trailer) is no question
    assert count_check([1, 2, 3, 4, 5], 5, 6) == CountCheck(5, 1, False)
    assert fill_target([1, 2, 3, 4, 5], 5, 6, early_end=False, limit=10_000) is None
    # ... and with E05 lost: uncertain, the page after 4 asked for once
    assert count_check([1, 2, 3, 4], 5, 5) == CountCheck(4, 1, True)
    assert fill_target([1, 2, 3, 4], 5, 5, early_end=False, limit=10_000) == 5


def test_missing_numbers_are_the_holes_and_the_numbers_up_to_an_unmet_count():
    assert missing_numbers([1, 2, 3, 5, 7], None, None, limit=100) == [4, 6]  # 5 → 7 without 6
    assert missing_numbers([1, 2, 3], 5, 3, limit=100) == [4, 5]  # the last ones
    assert missing_numbers([1, 2, 3], 5, 5, limit=100) == []  # 5 items came: nothing past 3
    assert missing_numbers([1, 2, 3], 5, None, limit=100) == [4, 5]  # unknown items
    assert missing_numbers([2, 4], 6, 2, limit=100) == [1, 3, 5, 6]
    assert missing_numbers([], 3, 0, limit=100) == [1, 2, 3]
    assert missing_numbers([], None, None, limit=100) == []
    assert missing_numbers([1, 9], 2**40, 2, limit=12) == [2, 3, 4, 5, 6, 7, 8, 10, 11, 12]
    assert missing_numbers(iter([3, 1]), 2, 9, limit=100) == [2]
    # 3.0.1, D2: never past TikTok's count less the drama's other items received
    assert missing_numbers([1, 2, 3], 7, 5, limit=100) == [4, 5]
    assert missing_numbers([1, 2, 3, 5, 6], 7, 6, limit=100) == [4]


def test_catalog_warnings_name_the_duplicates_the_skipped_items_and_the_count():
    e1, e2, e3 = (_candidate(f"e{n}", number=n, duration=90) for n in (1, 2, 3))
    clip = _candidate("clip", number=2, highlight=True)
    duplicate = Duplicate(2, e2, clip, LEFT_OUT_HIGHLIGHT)
    skipped = [
        SkippedItem(SKIP_NO_NUMBER, "t1"),
        SkippedItem("an odd reason", "x"),
        SkippedItem(SKIP_NO_NUMBER, "t2"),
        SkippedItem(SKIP_NO_ID),
        SkippedItem(SKIP_OTHER_DRAMA, "f"),
    ]
    # 3.0.1, the lead's decision D2 (changed on purpose): seven items for TikTok's six no longer
    # silence the count — four of them are other items, so the list is uncertain and says so
    assert catalog_warnings(
        [e1, e2, e3], 6, duplicates=[duplicate], skipped=skipped, items_received=7
    ) == [
        "duplicate episode number 2: item clip left out (a highlight), item e2 kept",
        "TikTok listed 1 item DramaFetch could not read (another drama's id)",
        "TikTok listed 1 item DramaFetch could not read (no id)",
        "TikTok listed 2 items DramaFetch could not read (no episode number)",
        "TikTok listed 1 item DramaFetch could not read (an odd reason)",
        "TikTok announces 6 episodes, 3 listed",
        uncertain_text(6, 3, 4),
    ]
    assert uncertain_text(6, 3, 4) == (
        "TikTok's list may be incomplete: TikTok counts 6 episodes; 3 episodes and 4 other items "
        "(trailers or highlights) were listed, so DramaFetch cannot tell whether an episode is "
        "missing — paste the drama again later to check again"
    )
    assert uncertain_text(66, 65, 1).startswith(
        f"{UNCERTAIN_TEXT}: TikTok counts 66 episodes; 65 episodes and 1 other item (a trailer or "
        "a highlight) were listed"
    )
    # the count: fewer numbers than TikTok counts, or more listed than it announces
    assert catalog_warnings([e1, e2, e3], 6, items_received=5) == [
        "TikTok announces 6 episodes, 3 listed",
        uncertain_text(6, 3, 2),  # 4 certainly missing (6 - 2); 5-6 may be the 2 others
    ]
    # 3.0.1, the lead's decision D2 (changed on purpose): six items for TikTok's six no longer
    # silence the count — three of them are other items DramaFetch cannot place
    assert catalog_warnings([e1, e2, e3], 6, items_received=6) == [
        "TikTok announces 6 episodes, 3 listed",
        uncertain_text(6, 3, 3),
    ]
    assert catalog_warnings([e1, e2, e3], 6, items_received=3) == [
        "TikTok announces 6 episodes, 3 listed"
    ]
    assert catalog_warnings([e1, e2, e3], 2, items_received=3) == [
        "TikTok announces 2 episodes, 3 listed"
    ]
    assert catalog_warnings([e1, e2, e3], 3, items_received=3) == []
    # without the items received, the numbers listed are held against the count (as before)
    assert catalog_warnings([e1, e2, e3], 6) == ["TikTok announces 6 episodes, 3 listed"]
    assert catalog_warnings([e1, e2, e3], 3) == []
    # a list that still holds two items with one number is merged by the same rules
    assert catalog_warnings([clip, e1, e2], None) == [
        "duplicate episode number 2: item clip left out (a highlight), item e2 kept",
    ]
    # the duplicates come by number, those of the list first
    later = Duplicate(1, e1, _candidate("dup1", number=1), LEFT_OUT_LATER)
    assert catalog_warnings([clip, e1, e2], None, duplicates=[duplicate, later]) == [
        "duplicate episode number 1: item dup1 left out (listed later), item e1 kept",
        "duplicate episode number 2: item clip left out (a highlight), item e2 kept",
        "duplicate episode number 2: item clip left out (a highlight), item e2 kept",
    ]
