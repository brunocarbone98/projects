"""B.1 "the highest quality the session gets", proven by the SAVED files, not by which URL was
asked for: every quality and every codec the fake sites offer is DIFFERENT media, so a saved
file's pictures, sound and sample entries tell which stream it came from.

- Dailymotion's master lists two variants that are different media — `1080` the source clip,
  `480` the 160x90 clip (`fake_sites.DM_LOW_VARIANT`) — and Bilibili's and bilibili.tv's 480P
  entries serve the 160x90 clip too. The same links (a TS-HLS and an fMP4-HLS Dailymotion video, a
  Bilibili video, a bilibili.tv video) are downloaded twice: with the default settings every file
  is the source clip (its height and framemd5), and with the global cap `quality: "480"` — chosen
  in the settings form, as a user does — every file is the 160x90 clip; the low variant's media
  is never asked for in the first run, the high one's never in the second.
- Bilibili's codecs (B.1): pages whose HEVC entry (a real libx265 track, `hvc1`, other pictures
  than the H.264 one) has the highest bandwidth at 1080P, one offering FLAC and Dolby E-AC-3 next
  to AAC, one Dolby and AAC, one AAC only. With the default `codec: "compatible"` every file is
  H.264 + the highest-bandwidth AAC; with `codec: "best"` every file is HEVC with FLAC, then Dolby,
  then AAC — each saved stream framemd5-equal to the served track and its sample entry the served
  one byte for byte (nothing re-encoded).

All ids are invented, of the real shapes.
"""

from __future__ import annotations

from pathlib import Path

from e2e_checks import NEEDS_CHROMIUM, assert_media_headers, assert_sequential
from extension_harness import ExtensionHarness
from fake_sites import (
    BILI_DOLBY_AUDIO,
    BILI_FLAC_AUDIO,
    BTV_AID,
    DM_FMP4_ID,
    DM_LOW_VARIANT,
    DM_TS_ID,
    FakeSites,
    RequestRecord,
    bili_cid,
    bili_title,
    btv_title,
    dm_title,
)
from media_fixtures import (
    HEVC_TAG,
    LOW_HEIGHT,
    SOURCE_HEIGHT,
    MediaSet,
    assert_saved_media,
    sample_entry,
    streams_of,
    video_height,
)

pytestmark = [NEEDS_CHROMIUM]

DM = "https://www.dailymotion.com/video/{}"
BILI = "https://www.bilibili.com/video/{}"
BTV = "https://www.bilibili.tv/en/video/{}"
#: A one-part Bilibili video for the quality runs.
BILI_VIDEO = "BV1Qa8L1tY4z"
#: Bilibili pages for the codec runs: FLAC + Dolby + AAC, Dolby + AAC, AAC only.
FLAC_DOLBY, DOLBY_ONLY, AAC_ONLY = "BV1Hv3F1lAc5", "BV1Hv4D1oLb6", "BV1Hv5A1aCc7"
CODEC_VIDEOS = (FLAC_DOLBY, DOLBY_ONLY, AAC_ONLY)


def _dm_file(xid: str) -> str:
    return f"StreamFetch/Dailymotion/{dm_title(xid)} [{xid}].mp4"


def _bili_file(bvid: str) -> str:
    return f"StreamFetch/Bilibili/{bili_title(bvid)} [{bvid}].mp4"


def _btv_file(aid: str) -> str:
    return f"StreamFetch/Bilibili.tv/{btv_title(aid)} [{aid}].mp4"


def _files_of(sites: FakeSites, video_id: str, key: str | None = None) -> list[str]:
    """What one video's run asked for from its CDN, in order: the path after the segment that
    names it (`key`: its xid, aid, or a Bilibili cid) — `media-480.m3u8`, `480/seg000.ts`,
    `80-hevc.m4s`, `audio-30251.m4s`, … (media playlists, init segments, segments, tracks)."""
    name = key or video_id
    found: list[str] = []
    for record in sites.about(video_id):
        if record.kind != "media" and record.route != "dm-media-playlist":
            continue
        parts = record.path.split("/")
        found.append("/".join(parts[parts.index(name) + 1 :]))
    return found


def _expected_files(low: bool) -> dict[str, list[str]]:
    """The CDN files each video of the quality runs must ask for — and nothing else."""
    folder = f"{DM_LOW_VARIANT}/" if low else ""
    segments = [f"{folder}seg00{n}" for n in range(3)]
    quality = "32" if low else "80"
    return {
        DM_TS_ID: [f"media-{DM_LOW_VARIANT if low else '1080'}.m3u8"]
        + [f"{segment}.ts" for segment in segments],
        DM_FMP4_ID: [f"media-{DM_LOW_VARIANT if low else '1080'}.m3u8", f"{folder}init.mp4"]
        + [f"{segment}.m4s" for segment in segments],
        BILI_VIDEO: [f"{quality}.m4s", "audio-30280.m4s"],
        BTV_AID: [f"{quality}.mp4", "audio-30280.mp4"],
    }


def _quality_run(
    ext: ExtensionHarness, sites: FakeSites, media: MediaSet, *, low: bool
) -> list[RequestRecord]:
    """Download the four links; every saved file is the clip of the quality asked for (`low`:
    the 160x90 clip, else the source clip), checked by its pictures and its height."""
    links = "\n".join(
        [DM.format(DM_TS_ID), DM.format(DM_FMP4_ID), BILI.format(BILI_VIDEO), BTV.format(BTV_AID)]
    )
    sites.clear_log()
    ext.download_all(links)
    rows = [ext.row_of(video_id) for video_id in (DM_TS_ID, DM_FMP4_ID, BILI_VIDEO, BTV_AID)]
    assert [row.status for row in rows] == ["done"] * len(rows), rows
    label = "480p" if low else "1080p"  # the chosen stream, as the row shows it
    assert all(row.quality.startswith(label) for row in rows), rows
    suffix = "-low" if low else ""
    saved = {
        _dm_file(DM_TS_ID): f"ts-hls{suffix}",
        _dm_file(DM_FMP4_ID): f"fmp4-hls{suffix}",
        _bili_file(BILI_VIDEO): f"dash{suffix}",
        _btv_file(BTV_AID): f"btv-progressive{suffix}",
    }
    assert ext.wait_saved(len(saved)) == sorted(saved)
    for name, media_path in saved.items():
        path = ext.saved_path(name)
        assert video_height(path) == (LOW_HEIGHT if low else SOURCE_HEIGHT), name
        assert_saved_media(path, media.expected(media_path))  # the clip's own pictures
    for video_id, files in _expected_files(low).items():
        key = bili_cid(video_id, 1) if video_id == BILI_VIDEO else None
        assert _files_of(sites, video_id, key) == files, video_id
    records = sites.site_requests()
    assert_sequential(records)
    assert_media_headers(sites, sites.media_requests())
    return records


def test_the_default_saves_the_highest_quality_and_a_global_cap_the_capped_one(
    media: MediaSet, tmp_path: Path
):
    with FakeSites(media, dm_fmp4=frozenset({DM_FMP4_ID})) as sites:
        # -- the default `quality: "best"`: the source clip from every site -------------------
        with ExtensionHarness(tmp_path / "best", sites) as ext:
            records = _quality_run(ext, sites, media, low=False)
            assert not [r.path for r in records if f"/{DM_LOW_VARIANT}/" in r.path]
            assert not [r.path for r in records if r.path.endswith("/32.m4s")]

        # -- `quality: "480"`, saved in the settings form: the 160x90 clip from every site -----
        with ExtensionHarness(tmp_path / "capped", sites) as ext:
            ext.save_settings_form(quality="480")
            records = _quality_run(ext, sites, media, low=True)
            assert not [r.path for r in records if "media-1080" in r.path]
            assert not [r.path for r in records if r.path.endswith(("/80.m4s", "/80.mp4"))]
            assert ext.stored_settings()["quality"] == "480"


def _codec_run(ext: ExtensionHarness, sites: FakeSites) -> None:
    sites.clear_log()
    ext.download_all("\n".join(BILI.format(bvid) for bvid in CODEC_VIDEOS))
    assert [ext.row_of(bvid).status for bvid in CODEC_VIDEOS] == ["done"] * 3, ext.rows()
    assert ext.wait_saved(len(CODEC_VIDEOS)) == sorted(_bili_file(b) for b in CODEC_VIDEOS)
    assert_sequential(sites.site_requests())
    assert_media_headers(sites, sites.media_requests())
    assert ext.failed_rows() == [] and ext.reports() == []


def test_codec_best_saves_hevc_with_flac_then_dolby_then_aac_and_compatible_h264_with_aac(
    media: MediaSet, tmp_path: Path
):
    with FakeSites(
        media,
        bili_flac=frozenset({FLAC_DOLBY}),
        bili_dolby=frozenset({FLAC_DOLBY, DOLBY_ONLY}),
        bili_hevc_top_bandwidth=frozenset(CODEC_VIDEOS),
    ) as sites:
        # -- the default `codec: "compatible"`: H.264 at 1080P and the highest AAC, whatever
        # else the page offers ------------------------------------------------------------------
        with ExtensionHarness(tmp_path / "compatible", sites) as ext:
            _codec_run(ext, sites)
            for bvid in CODEC_VIDEOS:
                saved = ext.saved_path(_bili_file(bvid))
                assert_saved_media(saved, media.expected("dash"))
                assert sample_entry(saved, "video") == sample_entry(media.dash_video, "video")
                assert sample_entry(saved, "audio") == sample_entry(media.dash_audio, "audio")
                cid = bili_cid(bvid, 1)
                assert _files_of(sites, bvid, cid) == ["80.m4s", "audio-30280.m4s"], bvid
                assert ext.row_of(bvid).quality.startswith("1080p · avc1"), ext.row_of(bvid)

        # -- `codec: "best"`, saved in the settings form: the highest bandwidth at 1080P (the
        # HEVC track) and FLAC, then Dolby, then AAC ---------------------------------------------
        best = {
            FLAC_DOLBY: (
                "dash-hevc-flac",
                f"audio-{BILI_FLAC_AUDIO[0]}.m4s",
                media.dash_audio_flac,
            ),
            DOLBY_ONLY: (
                "dash-hevc-eac3",
                f"audio-{BILI_DOLBY_AUDIO[0]}.m4s",
                media.dash_audio_eac3,
            ),
            AAC_ONLY: ("dash-hevc", "audio-30280.m4s", media.dash_audio),
        }
        with ExtensionHarness(tmp_path / "best", sites) as ext:
            ext.save_settings_form(codec="best")
            _codec_run(ext, sites)
            for bvid, (media_path, audio_file, served_audio) in best.items():
                saved = ext.saved_path(_bili_file(bvid))
                probed = assert_saved_media(saved, media.expected(media_path))
                (video,) = streams_of(probed, "video")
                assert video["codec_tag_string"] == HEVC_TAG, (bvid, video)
                assert sample_entry(saved, "video") == sample_entry(media.dash_video_hevc, "video")
                assert sample_entry(saved, "audio") == sample_entry(served_audio, "audio")
                cid = bili_cid(bvid, 1)
                assert _files_of(sites, bvid, cid) == ["80-hevc.m4s", audio_file], bvid
                assert ext.row_of(bvid).quality.startswith("1080p · hev1"), ext.row_of(bvid)
            assert ext.stored_settings()["codec"] == "best"
