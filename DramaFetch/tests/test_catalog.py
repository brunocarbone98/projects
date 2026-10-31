"""catalog: pure parsing of item_list/detail payloads, on the two fixtures and on edge cases."""

from __future__ import annotations

import copy

from dramafetch.catalog import (
    PagePayload,
    catalog_warnings,
    episode_from_item,
    find_item_lists,
    lock_hints,
    merge_episodes,
    parse_detail_payload,
    parse_item_list_payload,
)
from dramafetch.models import Episode

SERIES_ID = "7699393770256782354"
OTHER_SERIES_ID = "7600000000000000000"
NAME = "The Billionaire's Secret Heiress"


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
        "previewUrl=x",
        "no play address",
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
    # string flags
    strings = {"video": {"playAddr": "u"}, "dramaInfo": {"isPaid": "true", "isFree": "false"}}
    assert lock_hints(strings) == ("isPaid=true", "isFree=false")
    # containers are scanned, never reported as values; None is ignored
    nested = {"video": {"playAddr": "u"}, "dramaInfo": {"lockInfo": {"status": 1}, "vip": None}}
    assert lock_hints(nested) == ()
    # the bitrateInfo entries of video are NOT scanned (shallow)
    deep_video = {"video": {"playAddr": "u", "bitrateInfo": [{"PlayAddr": {"isLocked": True}}]}}
    assert lock_hints(deep_video) == ()
    # long values are truncated
    long_value = {"video": {"playAddr": "u"}, "dramaInfo": {"unlockToken": "a" * 100}}
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
    assert episode.page_url == "https://www.tiktok.com/@_/video/1"
    assert episode.lock_hints == ("no play address",)


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
    assert catalog_warnings(episodes, 10) == [
        "episode 4 missing (gap)",
        "episodes 6-7 missing (gap)",
        "duplicate episode number 8",
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
