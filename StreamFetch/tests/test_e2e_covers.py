"""The cover and the title embedded in every saved file, end to end (addendum B.2 — parity with
DramaFetch's acceptance criterion 4).

After a target's media is complete and before the writer runs, StreamFetch asks once for the
cover the page or the metadata names: a JPEG or a PNG is embedded as served, anything else (a
WebP here) is converted to JPEG; a cover that cannot be had (a 404, a 429, a 403) leaves the video
saved without one, its row's message ending `; cover: <reason>` — a cover is never worth a stop or
a cooldown. ffprobe sees the cover as an attached picture and the title as the `title` tag (`©nam`,
UTF-8: one title here is not ASCII). The same downloads with the setting `cover: "none"` ask for
no cover and save the same audio and video, sample for sample — on every media path that embeds a
cover here: TS-HLS, fMP4-HLS, Bilibili's DASH and bilibili.tv's progressive files.

Thumbnails and the embed request are the extension's own `fetch` of the same URL; the window is
tall enough for every row to be in view, so every thumbnail is asked for after Analyze
(`settle_thumbnails`) and the cover requests of the download runs are the embed requests. The
refused covers are refused only from then on (`set_options`): a 429 on a list thumbnail is a
refusal like any other — the thumbnails stop for the page and the cooldown starts (the last
scenario) —, only the one cover request a file embeds is exempt (B.2)."""

from __future__ import annotations

from pathlib import Path

from e2e_checks import NEEDS_CHROMIUM, assert_sequential
from extension_harness import ExtensionHarness
from fake_sites import (
    BILI_TITLES,
    BILI_UNICODE,
    BTV_AID,
    BTV_TITLES,
    DM_FMP4_ID,
    DM_TS_ID,
    FakeSites,
    dm_title,
)
from media_fixtures import (
    MediaSet,
    assert_cover,
    assert_no_cover,
    assert_saved_media,
    av_framemd5,
    mdat_payload,
    mp4_metadata,
    title_tag,
)

pytestmark = [NEEDS_CHROMIUM]

#: Dailymotion videos whose cover the site refuses (invented xids).
COVER_429, COVER_404, COVER_403 = "xcv429r", "xcv404m", "xcv403f"
#: video id → (link, saved file, media path, the `MediaSet` cover served or None, cover route)
VIDEOS: dict[str, tuple[str, str, str, str | None, str]] = {
    DM_TS_ID: (
        f"https://www.dailymotion.com/video/{DM_TS_ID}",
        f"StreamFetch/Dailymotion/{dm_title(DM_TS_ID)} [{DM_TS_ID}].mp4",
        "ts-hls",
        "cover",
        "dm-poster",
    ),
    DM_FMP4_ID: (
        f"https://www.dailymotion.com/video/{DM_FMP4_ID}",
        f"StreamFetch/Dailymotion/{dm_title(DM_FMP4_ID)} [{DM_FMP4_ID}].mp4",
        "fmp4-hls",
        "cover",
        "dm-poster",
    ),
    COVER_429: (
        f"https://www.dailymotion.com/video/{COVER_429}",
        f"StreamFetch/Dailymotion/{dm_title(COVER_429)} [{COVER_429}].mp4",
        "ts-hls",
        None,
        "dm-poster",
    ),
    BILI_UNICODE: (
        f"https://www.bilibili.com/video/{BILI_UNICODE}",
        f"StreamFetch/Bilibili/{BILI_TITLES[BILI_UNICODE]} [{BILI_UNICODE}].mp4",
        "dash",
        "cover_webp",
        "bili-cover",
    ),
    BTV_AID: (
        f"https://www.bilibili.tv/en/video/{BTV_AID}",
        f"StreamFetch/Bilibili.tv/{BTV_TITLES[BTV_AID]} [{BTV_AID}].mp4",
        "btv-progressive",
        "cover_png",
        "btv-cover",
    ),
    COVER_404: (
        f"https://www.dailymotion.com/video/{COVER_404}",
        f"StreamFetch/Dailymotion/{dm_title(COVER_404)} [{COVER_404}].mp4",
        "ts-hls",
        None,
        "dm-poster",
    ),
    COVER_403: (
        f"https://www.dailymotion.com/video/{COVER_403}",
        f"StreamFetch/Dailymotion/{dm_title(COVER_403)} [{COVER_403}].mp4",
        "ts-hls",
        None,
        "dm-poster",
    ),
}
TITLES = {
    DM_TS_ID: dm_title(DM_TS_ID),
    DM_FMP4_ID: dm_title(DM_FMP4_ID),
    COVER_429: dm_title(COVER_429),
    BILI_UNICODE: BILI_TITLES[BILI_UNICODE],
    BTV_AID: BTV_TITLES[BTV_AID],
    COVER_404: dm_title(COVER_404),
    COVER_403: dm_title(COVER_403),
}
REFUSED = {COVER_429: 429, COVER_404: 404, COVER_403: 403}
#: Every row in view (see the module docstring).
TALL = {"width": 1280, "height": 2400}


def _download(
    ext: ExtensionHarness, sites: FakeSites, ids: list[str], refuse: dict[str, int] | None = None
) -> None:
    """Analyze `ids`' links, let every row's thumbnail load, forget the log, refuse the covers
    of `refuse` from now on (the embed requests), Download all."""
    sites.clear_log()
    ext.analyze("\n".join(VIDEOS[video_id][0] for video_id in ids), min_rows=len(ids))
    ext.settle_thumbnails(len(ids))
    assert ext.cooldown() is None
    if refuse is not None:
        sites.set_options(cover_status=tuple(refuse.items()))
    sites.clear_log()
    ext.download_all()
    assert [ext.row_of(video_id).status for video_id in ids] == ["done"] * len(ids), ext.rows()
    assert ext.wait_saved(len(ids)) == sorted(VIDEOS[video_id][1] for video_id in ids)


def test_covers_and_titles_are_embedded_and_the_audio_and_video_are_untouched(
    media: MediaSet, tmp_path: Path
):
    with FakeSites(
        media,
        dm_fmp4=frozenset({DM_FMP4_ID}),
        cover_webp=frozenset({BILI_UNICODE}),
        cover_png=frozenset({BTV_AID}),
    ) as sites:
        # -- the default setting: every cover embedded (or the reason it is not) ---------------
        with ExtensionHarness(tmp_path / "embed", sites, viewport=TALL) as ext:
            ids = list(VIDEOS)
            _download(ext, sites, ids, REFUSED)
            for video_id, (_, name, media_path, served, _) in VIDEOS.items():
                saved = ext.saved_path(name)
                probed = assert_saved_media(saved, media.expected(media_path))
                assert title_tag(probed) == TITLES[video_id], (name, title_tag(probed))
                assert mp4_metadata(saved).title == TITLES[video_id]  # `©nam`, UTF-8
                message = ext.row_of(video_id).message
                if served is None:
                    assert_no_cover(saved, probed)
                    assert "; cover:" in message and str(REFUSED[video_id]) in message, message
                else:
                    meta = assert_cover(saved, probed, getattr(media, served))
                    assert "cover:" not in message, message
                    if served == "cover_webp":  # converted: a JPEG, not the WebP bytes
                        assert meta.cover != media.cover_webp.read_bytes()
            # one cover request per file, after its media, in order, never retried; a refused
            # cover stops nothing and starts no cooldown
            fetched = [
                (r.route, r.path.rsplit(".", 1)[-1], r.status) for r in sites.cover_requests()
            ]
            assert fetched == [
                ("dm-poster", "jpg", 200),
                ("dm-poster", "jpg", 200),
                ("dm-poster", "jpg", 429),
                ("bili-cover", "webp", 200),
                ("btv-cover", "png", 200),
                ("dm-poster", "jpg", 404),
                ("dm-poster", "jpg", 403),
            ], fetched
            for video_id in ids:
                media_done = max(r.finished for r in sites.about(video_id) if r.kind == "media")
                (cover,) = [r for r in sites.cover_requests() if f"/{video_id}." in r.path]
                assert cover.started >= media_done, (video_id, "the cover before the media")
            assert_sequential(sites.site_requests() + sites.cover_requests())
            assert ext.cooldown() is None
            assert ext.failed_rows() == [] and ext.reports() == []
            embedded = {video_id: ext.saved_path(VIDEOS[video_id][1]) for video_id in ids}

        # -- `cover: "none"`: no cover request, the same audio and video ----------------------
        covered = [video_id for video_id in ids if VIDEOS[video_id][3] is not None]
        assert {VIDEOS[video_id][2] for video_id in covered} == {
            "ts-hls",
            "fmp4-hls",
            "dash",
            "btv-progressive",
        }
        with ExtensionHarness(tmp_path / "none", sites, viewport=TALL) as ext:
            ext.update_settings(cover="none")
            _download(ext, sites, covered)
            assert sites.cover_requests() == [], "a cover was asked for with cover: none"
            for video_id in covered:
                _, name, media_path, _, _ = VIDEOS[video_id]
                saved = ext.saved_path(name)
                probed = assert_saved_media(saved, media.expected(media_path))
                assert_no_cover(saved, probed)
                assert title_tag(probed) == TITLES[video_id], (name, title_tag(probed))
                assert "cover:" not in ext.row_of(video_id).message
                with_cover = embedded[video_id]
                for kind in ("video", "audio"):
                    assert av_framemd5(saved, kind) == av_framemd5(with_cover, kind), (name, kind)
                assert mdat_payload(saved) == mdat_payload(with_cover), name


def test_a_429_on_a_list_thumbnail_stops_the_thumbnails_and_starts_the_cooldown(
    media: MediaSet, tmp_path: Path
):
    """A 429 on a row's thumbnail is a refusal (spec 7: a 429 anywhere): no other thumbnail is
    asked for, the cooldown starts and its banner names the cover request, in the page's
    language; nothing is asked of the sites until it ends."""
    ids = [COVER_429, DM_TS_ID, COVER_404]
    with (
        FakeSites(media, cover_status=((COVER_429, 429),)) as sites,
        ExtensionHarness(tmp_path, sites, viewport=TALL) as ext,
    ):
        ext.update_settings(language="es")
        ext.analyze("\n".join(VIDEOS[video_id][0] for video_id in ids), min_rows=len(ids))
        ext.wait_for(lambda: ext.cooldown() is not None, 20, "no cooldown after the 429")
        ext.wait_for(lambda: ext.visible("#cooldown-banner"), 10, "no cooldown banner")
        assert [(r.path.rsplit("/", 1)[-1], r.status) for r in sites.cover_requests()] == [
            (f"{COVER_429}.jpg", 429)
        ], "a thumbnail asked for after the 429"
        record = ext.cooldown()
        assert record is not None and record["reason"] == "HTTP 429 (cover)", record
        banner = ext.text("#cooldown-banner")
        assert "HTTP 429 (portada)" in banner, banner  # the reason in the page's language
        assert "the site" not in banner, banner
        before = len(sites.requests)
        ext.page.click("#download-all-button")
        ext.wait_for(lambda: "espera" in ext.text("#activity"), 10, "the start was not refused")
        assert len(sites.requests) == before, sites.requests[before:]
