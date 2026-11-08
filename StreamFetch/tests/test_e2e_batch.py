"""The owner's main flow end to end (spec 9, addenda A.7 and A.8): a batch of pasted links, Analyze,
Download all, every file verified against the source clip.

The batch: a Dailymotion video served as MPEG-TS HLS, one served as fMP4 HLS pasted WITH a
`?playlist=` parameter (A.8: the video downloads, the playlist is ignored and the row says so), a
two-part Bilibili video through a `b23.tv` short link, a `dai.ly` short link, and a bilibili.tv
user video pasted twice — once with the exact `bstar_from` tracking parameter of the owner's
links and once under another language segment (A.7: one row, one download). The first Bilibili
video file is cut short once on the CDN, so the download must resume it with `Range`.
"""

from __future__ import annotations

import re
from pathlib import Path

from e2e_checks import (
    NEEDS_CHROMIUM,
    assert_media_headers,
    assert_one_at_a_time,
    assert_range_only_after_cut,
    assert_sequential,
)
from extension_harness import ExtensionHarness
from fake_sites import (
    B23_CODE,
    BILI_MAIN,
    BSTAR_FROM,
    BTV_AID,
    DM_FMP4_ID,
    DM_PLAYLIST_ID,
    DM_SHORT_ID,
    DM_TITLES,
    DM_TS_ID,
    FakeSites,
)
from media_fixtures import MediaSet, assert_same_media

pytestmark = [NEEDS_CHROMIUM]

LINKS = "\n".join(
    [
        "# a comment line, ignored",
        f"https://www.dailymotion.com/video/{DM_TS_ID}",
        f"https://www.dailymotion.com/video/{DM_FMP4_ID}?playlist={DM_PLAYLIST_ID}",
        "",
        f"https://b23.tv/{B23_CODE}",
        f"https://dai.ly/{DM_SHORT_ID}   # the short link",
        f"https://www.bilibili.tv/en/video/{BTV_AID}?bstar_from={BSTAR_FROM}",
        f"https://www.bilibili.tv/es/video/{BTV_AID}",
    ]
)
EXPECTED_FILES = sorted(
    [
        f"StreamFetch/Dailymotion/{DM_TITLES[DM_TS_ID]} [{DM_TS_ID}].mp4",
        f"StreamFetch/Dailymotion/{DM_TITLES[DM_FMP4_ID]} [{DM_FMP4_ID}].mp4",
        f"StreamFetch/Dailymotion/{DM_TITLES[DM_SHORT_ID]} [{DM_SHORT_ID}].mp4",
        f"StreamFetch/Bilibili/Fake Bilibili two-part video [{BILI_MAIN}]/P01 - First half.mp4",
        f"StreamFetch/Bilibili/Fake Bilibili two-part video [{BILI_MAIN}]/P02 - Second half.mp4",
        f"StreamFetch/Bilibili.tv/Fake Bstation user video [{BTV_AID}].mp4",
    ]
)
DURATION_RE = re.compile(r"^0?0:06$")


def test_a_batch_of_links_is_analyzed_then_downloaded_and_every_file_verified(
    media: MediaSet, tmp_path: Path
):
    with (
        FakeSites(
            media,
            dm_fmp4=frozenset({DM_FMP4_ID}),
            bili_parts=2,
            bili_cut_once=frozenset({BILI_MAIN}),
        ) as sites,
        ExtensionHarness(tmp_path, sites) as ext,
    ):
        # -- Analyze: titles, durations, qualities; no media request ---------------------------
        ext.analyze(LINKS, min_rows=6)
        assert sites.media_requests() == [], "Analyze downloaded media"
        analysis = sites.site_requests()
        assert_sequential(analysis)
        for xid in (DM_TS_ID, DM_FMP4_ID, DM_SHORT_ID):
            row = ext.row_of(xid)
            assert row.site == "Dailymotion" and row.title == DM_TITLES[xid], row
            assert DURATION_RE.match(row.duration), row
            assert row.quality.startswith("1080p"), row
            assert row.href == f"https://www.dailymotion.com/video/{xid}", row
            assert row.target == "_blank", row
            # one metadata request, one master, one media playlist each
            routes = [r.route for r in sites.about(xid) if r.kind != "cover"]
            assert routes == ["dm-metadata", "dm-master", "dm-media-playlist"], (xid, routes)
        assert "playlist ignored" in ext.row_of(DM_FMP4_ID).message
        assert "playlist ignored" not in ext.row_of(DM_TS_ID).message
        parts = ext.rows_of(BILI_MAIN)
        assert len(parts) == 2, parts
        assert {row.site for row in parts} == {"Bilibili"}
        assert all(DURATION_RE.match(row.duration) for row in parts), parts
        assert all(row.quality.startswith("1080p") for row in parts), parts
        assert len(sites.by_route("b23")) == 1
        pages = sites.by_route("bili-page")
        assert sorted(r.query.get("p", "1") for r in pages) == ["1", "2"], pages
        bstation = ext.rows_of(BTV_AID)
        assert len(bstation) == 1, "the same bilibili.tv video pasted twice made two rows"
        assert bstation[0].site == "Bilibili.tv"
        assert bstation[0].title == "Fake Bstation user video"
        assert DURATION_RE.match(bstation[0].duration), bstation
        assert bstation[0].quality.startswith("1080p"), bstation
        assert len(sites.by_route("btv-playurl")) == 1
        assert all(r.query.get("aid") == BTV_AID for r in sites.by_route("btv-playurl"))
        assert len(ext.rows()) == 6
        sites.clear_log()

        # -- Download all: six files, one request at a time ------------------------------------
        ext.download_all()
        rows = ext.rows()
        assert [row.status for row in rows] == ["done"] * 6, rows
        assert ext.wait_saved(6) == EXPECTED_FILES
        for name in EXPECTED_FILES:
            assert_same_media(ext.saved_path(name), media.src)

        log = sites.requests
        assert_sequential(sites.site_requests())
        assert_one_at_a_time(
            [entry for entry in ext.own_fetches() if not entry["name"].endswith(".jpg")]
        )
        media_requests = sites.media_requests()
        assert_media_headers(sites, media_requests)
        # Dailymotion: every segment once (nothing failed), no key, no init for TS
        for xid in (DM_TS_ID, DM_SHORT_ID):
            segments = [r.path for r in sites.about(xid) if r.route == "dm-segment"]
            assert segments == [f"/dm/cdn/{xid}/seg{n:03d}.ts" for n in range(3)], segments
        fmp4 = [r.path for r in sites.about(DM_FMP4_ID) if r.kind == "media"]
        assert fmp4 == [f"/dm/cdn/{DM_FMP4_ID}/init.mp4"] + [
            f"/dm/cdn/{DM_FMP4_ID}/seg{n:03d}.m4s" for n in range(3)
        ], fmp4
        assert not sites.by_route("dm-key")
        # Bilibili: the cut file resumed with Range, nothing else asked with Range
        bili = sites.media_requests("bilibili")
        assert assert_range_only_after_cut(bili) == 1
        assert [r.route for r in bili if r.cut] == ["bili-video"]
        assert all(r.status in {200, 206} for r in bili), [(r.path, r.status) for r in bili]
        # bilibili.tv: ONE video file and ONE audio file (one row, one download)
        assert [r.route for r in sites.media_requests("bilibilitv")] == ["btv-video", "btv-audio"]
        assert all(r.range is None for r in sites.media_requests("bilibilitv"))
        assert not sites.uncovered_requests()
        # nothing failed: no report, nothing in the failed block
        assert ext.reports() == []
        assert ext.failed_rows() == []
        assert len(log) >= len(media_requests)
