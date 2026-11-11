"""The owner's main flow end to end (spec 9, addenda A.7, A.8, B.1, B.2 and B.3): a batch of pasted
links, Analyze, Download all, every file verified against what the site served.

The batch: a Dailymotion video served as MPEG-TS HLS, one served as fMP4 HLS pasted WITH a
`?playlist=` parameter (A.8: the video downloads, the playlist is ignored and the row says so), a
two-part Bilibili video through a `b23.tv` short link, a `dai.ly` short link, a one-part Bilibili
video pasted as a share link carrying `vd_source` and `spm_id_from` (B.3: ignored), and a
bilibili.tv user video pasted twice — once with the exact `bstar_from` tracking parameter of the
owner's links and once under another language segment (A.7: one row, one download). The first
Bilibili video file is cut short once on the CDN, so the download must resume it with `Range`.

Every saved file passes B.1's proof for its media path (TS-HLS, fMP4-HLS, DASH m4s, bilibili.tv
progressive MP4): H.264 + AAC with the source's durations, the video framemd5-equal to the source
clip, the audio framemd5-equal to the track as served, a progressive layout — and carries B.2's
cover (the served JPEG, as served) and the title tag. All ids are invented, of the real shapes.
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
    BILI_PART_TITLES,
    BILI_SHARE,
    BILI_TITLES,
    BSTAR_FROM,
    BTV_AID,
    BTV_TITLES,
    DM_FMP4_ID,
    DM_PLAYLIST_ID,
    DM_SHORT_ID,
    DM_TITLES,
    DM_TS_ID,
    FakeSites,
)
from media_fixtures import MediaSet, assert_cover, assert_saved_media, mp4_metadata, title_tag

pytestmark = [NEEDS_CHROMIUM]

#: The parameters a bilibili.com share link carries (B.3), with invented values.
SHARE_QUERY = "vd_source=0f1e2d3c4b5a69788796a5b4c3d2e1f0&spm_id_from=333.788.videopod.sections"
LINKS = "\n".join(
    [
        "# a comment line, ignored",
        f"https://www.dailymotion.com/video/{DM_TS_ID}",
        f"https://www.dailymotion.com/video/{DM_FMP4_ID}?playlist={DM_PLAYLIST_ID}",
        "",
        f"https://b23.tv/{B23_CODE}",
        f"https://dai.ly/{DM_SHORT_ID}   # the short link",
        f"https://www.bilibili.com/video/{BILI_SHARE}/?{SHARE_QUERY}",
        f"https://www.bilibili.tv/en/video/{BTV_AID}?bstar_from={BSTAR_FROM}",
        f"https://www.bilibili.tv/es/video/{BTV_AID}",
    ]
)
#: Query parameters that select nothing (A.7, A.8, B.3): no request of the run may carry one.
IGNORED_PARAMETERS = {"playlist", "vd_source", "spm_id_from", "bstar_from"}
MAIN_FOLDER = f"StreamFetch/Bilibili/{BILI_TITLES[BILI_MAIN]} [{BILI_MAIN}]"
#: Saved file → (media path, the titles the `title` tag may hold: the video's, or its part's).
EXPECTED: dict[str, tuple[str, tuple[str, ...]]] = {
    f"StreamFetch/Dailymotion/{DM_TITLES[DM_TS_ID]} [{DM_TS_ID}].mp4": (
        "ts-hls",
        (DM_TITLES[DM_TS_ID],),
    ),
    f"StreamFetch/Dailymotion/{DM_TITLES[DM_FMP4_ID]} [{DM_FMP4_ID}].mp4": (
        "fmp4-hls",
        (DM_TITLES[DM_FMP4_ID],),
    ),
    f"StreamFetch/Dailymotion/{DM_TITLES[DM_SHORT_ID]} [{DM_SHORT_ID}].mp4": (
        "ts-hls",
        (DM_TITLES[DM_SHORT_ID],),
    ),
    f"{MAIN_FOLDER}/P01 - {BILI_PART_TITLES[0]}.mp4": (
        "dash",
        (BILI_TITLES[BILI_MAIN], BILI_PART_TITLES[0]),
    ),
    f"{MAIN_FOLDER}/P02 - {BILI_PART_TITLES[1]}.mp4": (
        "dash",
        (BILI_TITLES[BILI_MAIN], BILI_PART_TITLES[1]),
    ),
    f"StreamFetch/Bilibili/{BILI_TITLES[BILI_SHARE]} [{BILI_SHARE}].mp4": (
        "dash",
        (BILI_TITLES[BILI_SHARE],),
    ),
    f"StreamFetch/Bilibili.tv/{BTV_TITLES[BTV_AID]} [{BTV_AID}].mp4": (
        "btv-progressive",
        (BTV_TITLES[BTV_AID],),
    ),
}
DURATION_RE = re.compile(r"^0?0:06$")
#: A window tall enough for every row to be in view: their thumbnails all load after Analyze.
TALL = {"width": 1280, "height": 2400}


def test_a_batch_of_links_is_analyzed_then_downloaded_and_every_file_verified(
    media: MediaSet, tmp_path: Path
):
    with (
        FakeSites(
            media,
            dm_fmp4=frozenset({DM_FMP4_ID}),
            bili_parts=2,
            bili_parts_of=((BILI_SHARE, 1),),
            bili_cut_once=frozenset({BILI_MAIN}),
        ) as sites,
        ExtensionHarness(tmp_path, sites, viewport=TALL) as ext,
    ):
        # -- Analyze: titles, durations, qualities; no media request ---------------------------
        ext.analyze(LINKS, min_rows=len(EXPECTED))
        assert sites.media_requests() == [], "Analyze downloaded media"
        analysis = sites.site_requests()
        assert_sequential(analysis)
        # every row is in view: one thumbnail each, once Analyze is over, one at a time (A.4)
        ext.settle_thumbnails(len(EXPECTED))
        thumbnails = sites.cover_requests()
        assert min(r.started for r in thumbnails) >= max(r.finished for r in analysis)
        assert_sequential(thumbnails)
        for xid in (DM_TS_ID, DM_FMP4_ID, DM_SHORT_ID):
            row = ext.row_of(xid)
            assert row.site == "Dailymotion" and row.title == DM_TITLES[xid], row
            assert DURATION_RE.match(row.duration), row
            assert row.quality.startswith("1080p"), row
            assert row.href == f"https://www.dailymotion.com/video/{xid}", row
            assert row.target == "_blank", row
            # one metadata request, one master, one media playlist each
            routes = [r.route for r in sites.about(xid)]
            assert routes == ["dm-metadata", "dm-master", "dm-media-playlist"], (xid, routes)
        assert "playlist ignored" in ext.row_of(DM_FMP4_ID).message
        assert "playlist ignored" not in ext.row_of(DM_TS_ID).message
        parts = ext.rows_of(BILI_MAIN)
        assert len(parts) == 2, parts
        assert {row.site for row in parts} == {"Bilibili"}
        assert all(DURATION_RE.match(row.duration) for row in parts), parts
        assert all(row.quality.startswith("1080p") for row in parts), parts
        assert len(sites.by_route("b23")) == 1
        main_pages = [r for r in sites.by_route("bili-page") if BILI_MAIN in r.path]
        assert sorted(r.query.get("p", "1") for r in main_pages) == ["1", "2"], main_pages
        share = ext.row_of(BILI_SHARE)
        assert (share.site, share.title) == ("Bilibili", BILI_TITLES[BILI_SHARE]), share
        assert DURATION_RE.match(share.duration) and share.quality.startswith("1080p"), share
        assert share.href == f"https://www.bilibili.com/video/{BILI_SHARE}", share
        assert [r.route for r in sites.about(BILI_SHARE)] == ["bili-page"]
        bstation = ext.rows_of(BTV_AID)
        assert len(bstation) == 1, "the same bilibili.tv video pasted twice made two rows"
        assert bstation[0].site == "Bilibili.tv"
        assert bstation[0].title == BTV_TITLES[BTV_AID]
        assert bstation[0].href == f"https://www.bilibili.tv/en/video/{BTV_AID}"
        assert DURATION_RE.match(bstation[0].duration), bstation
        assert bstation[0].quality.startswith("1080p"), bstation
        assert len(sites.by_route("btv-playurl")) == 1
        assert all(r.query.get("aid") == BTV_AID for r in sites.by_route("btv-playurl"))
        assert len(ext.rows()) == len(EXPECTED)
        for record in analysis:
            assert not IGNORED_PARAMETERS & set(record.query), (record.path, record.query)
        sites.clear_log()  # from here on, a cover request is one B.2 makes to embed a cover

        # -- Download all: seven files, one request at a time ----------------------------------
        ext.download_all()
        rows = ext.rows()
        assert [row.status for row in rows] == ["done"] * len(EXPECTED), rows
        assert ext.wait_saved(len(EXPECTED)) == sorted(EXPECTED)
        for name, (media_path, titles) in EXPECTED.items():
            saved = ext.saved_path(name)
            probed = assert_saved_media(saved, media.expected(media_path))
            assert_cover(saved, probed, media.cover)  # the served JPEG, as served (B.2)
            title = title_tag(probed)
            assert title and any(t in title for t in titles), (name, title)
            assert mp4_metadata(saved).title == title  # `©nam`, UTF-8

        assert_sequential(sites.site_requests() + sites.cover_requests())
        assert_one_at_a_time(
            [e for e in ext.own_fetches() if not re.search(r"(poster|cover)/", e["name"])]
        )
        for record in sites.requests:
            assert not IGNORED_PARAMETERS & set(record.query), (record.path, record.query)
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
        # B.2: each file's cover asked for once (one request per file at most — a two-part video
        # may reuse its one cover), answered, never retried
        fetched = [r.path for r in sites.cover_requests()]
        assert all(r.status == 200 for r in sites.cover_requests()), fetched
        for video_id, files in (
            (DM_TS_ID, 1),
            (DM_FMP4_ID, 1),
            (DM_SHORT_ID, 1),
            (BILI_MAIN, 2),
            (BILI_SHARE, 1),
            (BTV_AID, 1),
        ):
            asked = [path for path in fetched if f"/{video_id}." in path]
            assert 1 <= len(asked) <= files, (video_id, fetched)
        assert len(fetched) <= len(EXPECTED), fetched
        # nothing failed: no report, nothing in the failed block, no cooldown
        assert ext.reports() == []
        assert ext.failed_rows() == []
        assert ext.cooldown() is None
