"""urls.parse_input and the page-URL builders: every accepted form and every rejection."""

from __future__ import annotations

import pytest

from dramafetch.errors import UnsupportedUrlError
from dramafetch.models import SeriesRef, VideoRef
from dramafetch.urls import parse_input, series_page_url, video_page_url

SERIES_ID = "7675706520839033876"
ITEM_ID = "7699400000000000001"


@pytest.mark.parametrize(
    ("text", "hint"),
    [
        (f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/8", 8),
        (f"http://tiktok.com/shortdrama/episode/{SERIES_ID}/1/", 1),
        (f"https://m.tiktok.com/shortdrama/episode/{SERIES_ID}/12?lang=en&is_from_webapp=1", 12),
        (f"HTTPS://WWW.TIKTOK.COM/shortdrama/episode/{SERIES_ID}/3#top", 3),
        (f"  <https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/2>  ", 2),
        (f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}", None),
        # "/0" is not an episode: the hint is dropped, the series is still recognised
        (f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/0", None),
    ],
)
def test_series_episode_urls(text, hint):
    ref = parse_input(text)
    assert isinstance(ref, SeriesRef)
    assert ref.series_id == SERIES_ID
    assert ref.episode_hint == hint
    assert ref.source_url == text.strip().strip("<>").strip()


@pytest.mark.parametrize(
    "text",
    [
        f"https://www.tiktok.com/shortdrama/{SERIES_ID}",
        f"https://www.tiktok.com/shortdrama/detail/{SERIES_ID}",
        f"https://www.tiktok.com/shortdrama/series/{SERIES_ID}/",
        f"https://www.tiktok.com/shortdrama/{SERIES_ID}?enter_from=share",
        SERIES_ID,
        f"  {SERIES_ID}\n",
    ],
)
def test_series_without_episode_segment_and_bare_ids(text):
    ref = parse_input(text)
    assert isinstance(ref, SeriesRef)
    assert ref.series_id == SERIES_ID
    assert ref.episode_hint is None


def test_video_urls():
    with_user = f"https://www.tiktok.com/@muffin.drama_us/video/{ITEM_ID}?is_copy_url=1"
    ref = parse_input(with_user)
    assert ref == VideoRef(item_id=ITEM_ID, author="muffin.drama_us", source_url=with_user)
    anonymous = parse_input(f"https://m.tiktok.com/video/{ITEM_ID}/")
    assert isinstance(anonymous, VideoRef)
    assert anonymous.item_id == ITEM_ID
    assert anonymous.author is None


@pytest.mark.parametrize(
    "text",
    [
        "",
        "   ",
        "<>",
        "https://vm.tiktok.com/ZMabc123/",
        "https://vt.tiktok.com/ZSabc123",
        "https://www.tiktok.com/t/ZTabc123/",
        "https://www.youtube.com/watch?v=abc",
        "https://www.tiktok.com/@user",
        "https://www.tiktok.com/shortdrama/episode/12345/1",  # id too short
        "12345",
        "https://www.tiktok.com/@user/video/" + "9" * 23,  # id too long
        "https://www.tiktok.com/shortdrama/episode/" + SERIES_ID + "/abc",
        "not a url at all",
    ],
)
def test_rejections(text):
    with pytest.raises(UnsupportedUrlError):
        parse_input(text)


def _digits(text: str, zero: int) -> str:
    """``text`` with every ASCII digit replaced by the digit of another script whose zero is the
    code point ``zero``."""
    return "".join(chr(zero + int(char)) if char.isdigit() else char for char in text)


#: The series id in full-width digits (what an IME types: U+FF10…) and Arabic-Indic (U+0660…).
FULL_WIDTH_ID = _digits(SERIES_ID, 0xFF10)
ARABIC_INDIC_ID = _digits(SERIES_ID, 0x0660)


@pytest.mark.parametrize(
    "text",
    [
        FULL_WIDTH_ID,
        ARABIC_INDIC_ID,
        f"https://www.tiktok.com/shortdrama/episode/{FULL_WIDTH_ID}/1",
        f"https://www.tiktok.com/shortdrama/episode/{ARABIC_INDIC_ID}/1",
        f"https://www.tiktok.com/shortdrama/{FULL_WIDTH_ID}",
        f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/{_digits('1', 0xFF10)}",
        f"https://www.tiktok.com/@user/video/{FULL_WIDTH_ID}",
    ],
)
def test_only_ascii_digits_make_an_id(text):
    """Python's \\d takes any Unicode digit: such text would pass for an id TikTok cannot have,
    escape the de-duplication and cost a request that stops a batch. Ids are [0-9] only."""
    with pytest.raises(UnsupportedUrlError):
        parse_input(text)


def test_short_link_message_tells_the_user_what_to_paste():
    with pytest.raises(UnsupportedUrlError, match="Short links"):
        parse_input("https://vm.tiktok.com/ZMabc123/")


def test_empty_input_message_shows_the_expected_shape():
    with pytest.raises(UnsupportedUrlError, match="shortdrama/episode"):
        parse_input("")


def test_generic_rejection_quotes_the_input():
    with pytest.raises(UnsupportedUrlError, match=r"youtube\.com"):
        parse_input("https://www.youtube.com/watch?v=abc")


def test_page_url_builders():
    assert series_page_url(SERIES_ID) == f"https://www.tiktok.com/shortdrama/episode/{SERIES_ID}/1"
    assert (
        series_page_url(SERIES_ID, 7, "http://127.0.0.1:8000/")
        == f"http://127.0.0.1:8000/shortdrama/episode/{SERIES_ID}/7"
    )
    assert series_page_url(SERIES_ID, 0).endswith(f"/{SERIES_ID}/1")
    assert series_page_url(SERIES_ID, -3).endswith(f"/{SERIES_ID}/1")
    assert video_page_url(ITEM_ID) == f"https://www.tiktok.com/@_/video/{ITEM_ID}"
    assert (
        video_page_url(ITEM_ID, "ana", "http://localhost:1/")
        == f"http://localhost:1/@ana/video/{ITEM_ID}"
    )
