"""The fake sites and the media fixtures on their own (no browser): every route, option, `Range`,
the CDN `Referer` checks and the request log, through `urllib` — so the end-to-end scenarios
stand on a fake that is itself tested. Needs ffmpeg/ffprobe (skipped without them, failed under
`STREAMFETCH_REQUIRE_TOOLS=1`)."""

from __future__ import annotations

import http.client
import json
import re
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from encrypted_mp4 import (
    child,
    encrypted_fragmented,
    pssh_box,
    sample_entries,
    top_level_types,
    with_pssh_after_moov,
)
from fake_sites import (
    B23_CODE,
    BILI_DOLBY_AUDIO,
    BILI_FLAC_AUDIO,
    BILI_MAIN,
    BILI_PREMIUM_QUALITY,
    BILI_SHARE,
    BILI_TITLES,
    BILI_UNICODE,
    BSTAR_FROM,
    BTV_AID,
    BTV_EPISODES,
    BTV_SEASON,
    BTV_SEASON_TITLE,
    CLAIMED_SECONDS,
    CUT_LINGER_S,
    DM_FMP4_ID,
    DM_LOW_VARIANT,
    DM_TITLES,
    DM_TS_ID,
    EXPIRING_SEGMENT,
    FAKE_SESSDATA,
    TRUNCATED_SEGMENT,
    FakeSites,
    applies,
    bili_cid,
    parts_of,
)
from media_fixtures import (
    COVER_JPEG_SIZE,
    COVER_PNG_SIZE,
    COVER_WEBP_SIZE,
    COVR_JPEG,
    DURATION_TOLERANCE_S,
    HEVC_TAG,
    LOW_HEIGHT,
    MEDIA_PATHS,
    SOURCE_HEIGHT,
    SOURCE_SECONDS,
    MediaSet,
    assert_cover,
    assert_no_cover,
    assert_primed_or_same,
    assert_same_audio,
    assert_saved_media,
    attached_pictures,
    av_framemd5,
    decoded_pcm,
    duration_of,
    ffmpeg,
    ffprobe,
    fixture_framemd5,
    framemd5,
    image_size,
    is_progressive,
    mp4_metadata,
    packet_hashes,
    sample_entry,
    start_edit,
    streams_of,
    title_tag,
    unapplied_start_skip,
    video_height,
)


@dataclass
class Answer:
    status: int
    headers: dict[str, str]
    body: bytes

    def json(self) -> Any:
        return json.loads(self.body)

    @property
    def text(self) -> str:
        return self.body.decode()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def fetch(url: str, headers: dict[str, str] | None = None) -> Answer:
    """GET `url` without following redirects; any status comes back as an `Answer`."""
    request = urllib.request.Request(url, headers=headers or {})
    try:
        with _OPENER.open(request, timeout=10) as response:
            return Answer(response.status, dict(response.headers), response.read())
    except urllib.error.HTTPError as error:
        return Answer(error.code, dict(error.headers), error.read())


def embedded_json(html: str, marker: str) -> Any:
    """The JSON object assigned to `window.<marker>` in a page (what the extension's brace
    matcher reads), or None."""
    match = re.search(rf"window\.{re.escape(marker)}\s*=\s*", html)
    if match is None:
        return None
    value, _ = json.JSONDecoder().raw_decode(html, match.end())
    return value


def query_of(url: str) -> dict[str, str]:
    return dict(pair.split("=", 1) for pair in url.split("?", 1)[1].split("&"))


def path_of(url: str) -> str:
    return url.split("?", 1)[0]


@pytest.fixture
def sites(media: MediaSet):
    with FakeSites(media) as running:
        yield running


# -- the media fixtures --------------------------------------------------------------------------


def test_the_media_fixtures_are_the_clips_spec_9_describes(media: MediaSet):
    probed = ffprobe(media.src)
    (video,) = streams_of(probed, "video")
    (audio,) = streams_of(probed, "audio")
    assert (video["codec_name"], video["width"], video["height"]) == ("h264", 320, SOURCE_HEIGHT)
    assert (audio["codec_name"], audio["sample_rate"]) == ("aac", "48000")
    assert abs(duration_of(probed) - 6) < 0.1
    assert video_height(media.low) == LOW_HEIGHT
    assert abs(duration_of(ffprobe(media.low)) - duration_of(probed)) < 0.1
    assert framemd5(media.low, "a:0") == framemd5(media.src, "a:0")  # the audio is copied
    assert framemd5(media.low, "v:0") != framemd5(media.src, "v:0")
    # HLS: MPEG-TS and fMP4, 2-second segments
    assert media.hls_ts.container == "ts" and media.hls_fmp4.container == "fmp4"
    assert len(media.hls_ts.segments) == len(media.hls_fmp4.segments) == 3
    assert media.hls_ts.segments[0].read_bytes()[0] == 0x47  # a TS sync byte
    assert "#EXT-X-ENDLIST" in media.hls_ts.playlist
    assert '#EXT-X-MAP:URI="init.mp4"' in media.hls_fmp4.playlist
    # DASH: one fragmented track per file
    for path, kind in (
        (media.dash_video, "video"),
        (media.dash_video_low, "video"),
        (media.dash_audio, "audio"),
    ):
        kinds = top_level_types(path.read_bytes())
        assert kinds[:2] == ["ftyp", "moov"] and "moof" in kinds, (path, kinds)
        assert [s["codec_type"] for s in ffprobe(path)["streams"]] == [kind]
    # the lower HLS variant's renditions: the 160x90 clip, segmented the same way
    for low, high in ((media.hls_ts_low, media.hls_ts), (media.hls_fmp4_low, media.hls_fmp4)):
        assert low.container == high.container and len(low.segments) == len(high.segments)
        assert video_height(low.joined) == LOW_HEIGHT
        assert framemd5(low.joined, "v:0") == framemd5(media.low, "v:0")
        assert framemd5(low.joined, "a:0") == framemd5(high.joined, "a:0")  # the same sound
    assert media.hls_fmp4_low.init is not None and media.hls_fmp4.init is not None
    assert media.hls_fmp4_low.init.read_bytes() != media.hls_fmp4.init.read_bytes()
    # the other codecs B.1 chooses between: HEVC (hvc1, B-frames), FLAC, E-AC-3 — one fragmented
    # track each, the source's length, other frames than the H.264 / AAC tracks'
    (hevc,) = ffprobe(media.dash_video_hevc)["streams"]
    assert (hevc["codec_name"], hevc["codec_tag_string"]) == ("hevc", HEVC_TAG)
    assert (hevc["width"], hevc["height"]) == (320, SOURCE_HEIGHT)
    assert int(hevc["has_b_frames"]) > 0  # composition offsets for the writer to keep
    hevc_frames = framemd5(media.dash_video_hevc, "v:0")
    assert len(hevc_frames) == len(framemd5(media.src, "v:0")) == 25 * SOURCE_SECONDS
    assert hevc_frames != framemd5(media.dash_video, "v:0")
    for path, codec, tag in (
        (media.dash_audio_flac, "flac", "fLaC"),
        (media.dash_audio_eac3, "eac3", "ec-3"),
    ):
        (stream,) = ffprobe(path)["streams"]
        assert (stream["codec_name"], stream["codec_tag_string"]) == (codec, tag), path
        assert stream["sample_rate"] == "48000", path
        assert abs(float(stream["duration"]) - SOURCE_SECONDS) <= DURATION_TOLERANCE_S, stream
        assert framemd5(path, "a:0") != framemd5(media.dash_audio, "a:0"), path
    for path in (media.dash_video_hevc, media.dash_audio_flac, media.dash_audio_eac3):
        kinds = top_level_types(path.read_bytes())
        assert kinds[:2] == ["ftyp", "moov"] and "moof" in kinds, (path, kinds)
    assert sample_entry(media.dash_video_hevc, "video")[4:8] == HEVC_TAG.encode()
    assert sample_entry(media.dash_audio_flac, "audio")[4:8] == b"fLaC"
    assert sample_entry(media.dash_audio_eac3, "audio")[4:8] == b"ec-3"
    # progressive: no moof, mdat BEFORE moov (ffmpeg's default; not "progressive" for spec 9)
    for path in (media.progressive_video, media.progressive_video_low, media.progressive_audio):
        kinds = top_level_types(path.read_bytes())
        assert "moof" not in kinds and kinds.index("mdat") < kinds.index("moov"), kinds
        assert not is_progressive(path)
    assert framemd5(media.progressive_video) == framemd5(media.src)
    # the covers: a JPEG, a PNG and a WebP, three sizes
    for path, codec, size in (
        (media.cover, "mjpeg", COVER_JPEG_SIZE),
        (media.cover_png, "png", COVER_PNG_SIZE),
        (media.cover_webp, "webp", COVER_WEBP_SIZE),
    ):
        (image,) = ffprobe(path)["streams"]
        assert (image["codec_name"], image["width"], image["height"]) == (codec, *size), path
    assert image_size(media.cover.read_bytes()) == COVER_JPEG_SIZE
    assert image_size(media.cover_png.read_bytes()) == COVER_PNG_SIZE
    with pytest.raises(ValueError, match="neither a JPEG nor a PNG"):
        image_size(media.cover_webp.read_bytes())


def test_every_media_path_gives_the_writer_the_source_but_one_priming_frame(media: MediaSet):
    """What the writer gets on each path (B.1): the source's pictures, and its audio with the
    priming frame ffmpeg's segmenter/fragmenter keep — or without it (the progressive audio.mp4
    keeps the edit list that hides it)."""
    source_audio = framemd5(media.src, "a:0")
    for name in MEDIA_PATHS:
        expected = media.expected(name)
        assert expected.source == media.src
        low = name.endswith("-low")
        served_video = {
            "ts-hls": (media.hls_ts_low if low else media.hls_ts).joined,
            "fmp4-hls": (media.hls_fmp4_low if low else media.hls_fmp4).joined,
            "dash": media.dash_video_low if low else media.dash_video,
            "btv-progressive": media.progressive_video_low if low else media.progressive_video,
            "btv-fragmented": media.dash_video_low if low else media.dash_video,
        }.get(name.removesuffix("-low"), media.dash_video_hevc)
        assert expected.served_video == served_video, name
        if name.startswith("dash-hevc"):  # Bilibili's other codecs: the served tracks
            assert (expected.video, expected.video_codec) == (media.dash_video_hevc, "hevc")
            audio = {
                "dash-hevc": (media.dash_audio, "aac"),
                "dash-hevc-flac": (media.dash_audio_flac, "flac"),
                "dash-hevc-eac3": (media.dash_audio_eac3, "eac3"),
            }[name]
            assert (expected.audio, expected.audio_codec) == audio, name
            if expected.audio_codec != "aac":
                continue
        else:
            assert expected.video == (media.low if name.endswith("-low") else media.src), name
            assert (expected.video_codec, expected.audio_codec) == ("h264", "aac"), name
        given = fixture_framemd5(expected.audio, "a:0")
        assert_primed_or_same(given, source_audio, name)
        primed = name.removesuffix("-low") != "btv-progressive"
        assert len(given) == len(source_audio) + primed, name
    assert media.expected("ts-hls-low").audio == media.hls_ts_low.joined
    assert media.expected("fmp4-hls-low").audio == media.hls_fmp4_low.joined
    with pytest.raises(ValueError, match="no media path"):
        media.expected("dash-av1")
    # the joined HLS streams are the segments in playlist order: the source's pictures
    assert media.hls_ts.joined.read_bytes() == b"".join(
        path.read_bytes() for path in media.hls_ts.segments
    )
    assert media.hls_fmp4.init is not None
    assert media.hls_fmp4.joined.read_bytes().startswith(media.hls_fmp4.init.read_bytes())
    for joined in (media.hls_ts.joined, media.hls_fmp4.joined):
        assert framemd5(joined, "v:0") == framemd5(media.src, "v:0"), joined
    with pytest.raises(AssertionError, match="audio frames differ"):
        assert_primed_or_same(source_audio[1:], source_audio, "a frame missing")
    with pytest.raises(AssertionError, match="audio frames differ"):
        assert_primed_or_same(["0" * 32, "1" * 32, *source_audio], source_audio, "two extra")


def _remux(media: MediaSet, out: Path, *args: str) -> Path:
    """`ffmpeg -c copy` of the DASH pair (plus `args`) into `out`: a file shaped like one
    StreamFetch saves, made without the extension."""
    inputs = ["-i", str(media.dash_video), "-i", str(media.dash_audio)]
    ffmpeg([*inputs, *args, "-c", "copy", "-movflags", "+faststart", str(out)])
    return out


def test_the_saved_file_verification_on_files_ffmpeg_makes(media: MediaSet, tmp_path: Path):
    expected = media.expected("dash")
    plain = _remux(media, tmp_path / "plain.mp4", "-map", "0:v", "-map", "1:a")
    probed = assert_saved_media(plain, expected)
    assert_no_cover(plain, probed)
    assert mp4_metadata(plain).cover is None
    # with a cover and a non-ASCII title, as StreamFetch embeds them (B.2)
    title = BILI_TITLES[BILI_UNICODE]
    covered = tmp_path / "covered.mp4"
    ffmpeg(
        [
            *("-i", str(plain), "-i", str(media.cover), "-map", "0", "-map", "1", "-c", "copy"),
            *("-disposition:v:1", "attached_pic", "-metadata", f"title={title}"),
            *("-movflags", "+faststart", str(covered)),
        ]
    )
    probed = assert_saved_media(covered, expected)
    assert [s["codec_name"] for s in attached_pictures(probed)] == ["mjpeg"]
    assert [s["codec_name"] for s in streams_of(probed, "video")] == ["h264"]
    assert title_tag(probed) == title
    meta = assert_cover(covered, probed, media.cover)
    assert (meta.title, meta.cover_type, meta.cover) == (title, COVR_JPEG, media.cover.read_bytes())
    assert av_framemd5(covered, "video") == av_framemd5(plain, "video")
    assert av_framemd5(covered, "audio") == av_framemd5(plain, "audio")
    with pytest.raises(AssertionError, match="attached pictures"):
        assert_cover(plain, ffprobe(plain), media.cover)
    with pytest.raises(AssertionError, match="not the served"):
        assert_cover(covered, probed, media.cover_png)
    with pytest.raises(AssertionError, match="attached_pic"):
        assert_no_cover(covered, probed)
    # what the verification refuses: other pictures, another audio, a cut, a fragmented file
    with pytest.raises(AssertionError, match="video frames differ"):
        assert_saved_media(plain, media.expected("dash-low"))
    with pytest.raises(AssertionError, match="differ from the writer's input"):
        assert_saved_media(plain, media.expected("btv-progressive"))  # its audio has no priming
    short = _remux(media, tmp_path / "short.mp4", "-map", "0:v", "-map", "1:a", "-t", "5")
    with pytest.raises(AssertionError, match="duration"):
        assert_saved_media(short, expected)
    fragmented = tmp_path / "fragmented.mp4"
    ffmpeg(
        [
            *("-i", str(plain), "-c", "copy"),
            *("-movflags", "frag_keyframe+empty_moov+default_base_moof", str(fragmented)),
        ]
    )
    with pytest.raises(AssertionError, match="not progressive"):
        assert_saved_media(fragmented, expected)
    video_only = _remux(media, tmp_path / "video-only.mp4", "-map", "0:v")
    with pytest.raises(AssertionError, match="audio"):
        assert_saved_media(video_only, expected)
    # the same frames out of sync: the audio 40 ms late (one video frame) is refused
    late = tmp_path / "late-audio.mp4"
    delayed = ["-i", str(media.dash_video), "-itsoffset", "0.04", "-i", str(media.dash_audio)]
    ffmpeg(
        [*delayed, "-map", "0:v", "-map", "1:a", "-c", "copy", "-movflags", "+faststart", str(late)]
    )
    with pytest.raises(AssertionError, match=r"the video starts -40\.0 ms from the audio"):
        assert_saved_media(late, expected)

    # the other codecs, verified against the served tracks: files ffmpeg makes from them on the
    # served timeline (`-copyts`: the HEVC track's first picture is presented 80 ms in — its
    # B-frame delay, no edit list —, the audio at 0; without it ffmpeg moves each input to 0)
    def with_hevc(out: Path, audio: Path, *codec: str, copyts: bool = True) -> Path:
        inputs = ["-copyts"] if copyts else []
        inputs += ["-i", str(media.dash_video_hevc), "-i", str(audio), "-map", "0:v", "-map", "1:a"]
        ffmpeg([*inputs, *codec, "-tag:v", HEVC_TAG, "-movflags", "+faststart", str(out)])
        return out

    # E-AC-3 copied as served: every packet, and the edit list that skips its encoder delay
    eac3 = with_hevc(tmp_path / "hevc-eac3.mp4", media.dash_audio_eac3, "-c", "copy")
    assert start_edit(eac3, "audio") == (256, 48000)
    assert packet_hashes(eac3, "audio") == packet_hashes(media.dash_audio_eac3, "audio")
    assert_saved_media(eac3, media.expected("dash-hevc-eac3"))
    # FLAC encoded afresh from the source (deterministic: the served frames; ffmpeg 6's `-c copy`
    # of the fragmented FLAC track drops its last, short frame — below)
    flac = with_hevc(tmp_path / "hevc-flac.mp4", media.src, "-c:v", "copy", "-c:a", "flac")
    assert_saved_media(flac, media.expected("dash-hevc-flac"))
    assert sample_entry(flac, "video")[4:8] == HEVC_TAG.encode()  # ffmpeg rewrites the entry
    assert sample_entry(flac, "audio")[4:8] == b"fLaC"
    with pytest.raises(AssertionError, match="video"):
        assert_saved_media(flac, expected)  # HEVC where H.264 is expected
    with pytest.raises(AssertionError, match="video"):
        assert_saved_media(plain, media.expected("dash-hevc"))  # H.264 where HEVC is expected
    with pytest.raises(AssertionError, match="audio"):
        assert_saved_media(eac3, media.expected("dash-hevc-flac"))  # E-AC-3, not FLAC
    # a track one frame short is refused, whatever its duration says
    short = with_hevc(tmp_path / "hevc-flac-short.mp4", media.dash_audio_flac, "-c", "copy")
    with pytest.raises(AssertionError, match="audio frames differ"):
        assert_saved_media(short, media.expected("dash-hevc-flac"))
    # without `-copyts` ffmpeg reads the fragmented E-AC-3 track from its first packet (its
    # demuxer does not apply the edit list there) and writes no edit: every packet, but the 256
    # samples of encoder delay the served track hides would play — refused
    no_edit = with_hevc(
        tmp_path / "hevc-eac3-no-edit.mp4", media.dash_audio_eac3, "-c", "copy", copyts=False
    )
    assert packet_hashes(no_edit, "audio") == packet_hashes(media.dash_audio_eac3, "audio")
    assert start_edit(no_edit, "audio")[0] == 0
    with pytest.raises(AssertionError, match="does not play as the served"):
        assert_saved_media(no_edit, media.expected("dash-hevc-eac3"))
    # ...and with FLAC (no edit to lose) the same command moves the HEVC track to 0: out of sync
    moved = with_hevc(
        tmp_path / "hevc-flac-moved.mp4", media.src, "-c:v", "copy", "-c:a", "flac", copyts=False
    )
    with pytest.raises(AssertionError, match=r"the video starts \+0\.0 ms from the audio"):
        assert_saved_media(moved, media.expected("dash-hevc-flac"))


def test_start_edits_ffmpeg_does_not_apply_to_a_fragmented_track(media: MediaSet):
    """E-AC-3's fragmented track starts its presentation 256 samples in (its `elst`); ffmpeg
    decodes it from sample 0 — the frames a player plays are the PCM from sample 256 on. No
    other served track declares a start edit, and a progressive file's edits ffmpeg applies."""
    assert start_edit(media.dash_audio_eac3, "audio") == (256, 48000)
    assert unapplied_start_skip(media.dash_audio_eac3) == 256
    for track in (
        media.dash_audio,
        media.dash_audio_flac,
        media.hls_fmp4.joined,
        media.hls_ts.joined,
    ):
        assert unapplied_start_skip(track) == 0, track
    assert unapplied_start_skip(media.progressive_audio) == 0  # progressive: ffmpeg applies it
    assert start_edit(media.dash_video_hevc, "video") == (0, 12800)
    with pytest.raises(ValueError, match="no video track"):
        start_edit(media.dash_audio, "video")
    pcm = decoded_pcm(media.dash_audio_eac3)
    assert len(pcm) == 4 * 288_768  # mono f32le: 188 frames of 1536 samples
    assert len(packet_hashes(media.dash_audio_eac3, "audio")) == 188


def test_the_verification_accepts_the_source_and_one_priming_frame_only(media: MediaSet):
    assert_same_audio(media.src, media.src)
    # a DASH audio track decodes the AAC priming frame src.mp4's edit list hides: accepted
    primed = framemd5(media.dash_audio, "a:0")
    assert len(primed) == len(framemd5(media.src, "a:0")) + 1
    assert_same_audio(media.dash_audio, media.src)
    # other pictures, or a fragmented file, are refused
    with pytest.raises(AssertionError, match="video frames differ"):
        assert_saved_media(media.low, media.expected("btv-progressive"))
    assert not is_progressive(media.src)  # ffmpeg writes mdat first: not what StreamFetch saves


def test_the_encrypted_variant_is_a_structural_edit(media: MediaSet):
    plain = media.dash_video.read_bytes()
    encrypted = media.dash_video_encrypted.read_bytes()
    assert [kind for _, kind in sample_entries(plain)] == [b"avc1"]
    assert [kind for _, kind in sample_entries(encrypted)] == [b"encv"]
    kinds = top_level_types(encrypted)
    assert kinds[:3] == ["ftyp", "moov", "pssh"]
    assert len(encrypted) == len(plain) + len(pssh_box(b"streamfetch test key id"))
    pos, _size = child(encrypted, b"pssh")
    assert encrypted[pos + 12 : pos + 28] == bytes.fromhex("edef8ba979d64acea3c827dcd51d21ed")
    # the audio track renamed too, when asked
    audio = encrypted_fragmented(media.dash_audio.read_bytes(), video=False, audio=True)
    assert [kind for _, kind in sample_entries(audio)] == [b"enca"]
    # a progressive file is refused: its absolute chunk offsets would move
    with pytest.raises(ValueError, match="not a fragmented MP4"):
        with_pssh_after_moov(media.progressive_video.read_bytes())


def test_applies_names_ids_or_every_id():
    assert applies(frozenset({"a"}), "a") and not applies(frozenset({"a"}), "b")
    assert applies(frozenset({"*"}), "anything") and not applies(frozenset(), "a")


# -- Dailymotion ---------------------------------------------------------------------------------


def test_dailymotion_metadata_master_media_playlist_and_segments(sites: FakeSites, media):
    metadata = fetch(sites.url(f"/dm/player/metadata/video/{DM_TS_ID}?app=com.dailymotion.neon"))
    assert metadata.status == 200
    info = metadata.json()
    assert info["id"] == DM_TS_ID and info["title"] == DM_TITLES[DM_TS_ID]
    assert info["duration"] == 6 and info["owner"]["screenname"] == "Fake Channel"
    assert set(info["posters"]) == {"120", "360", "720"}
    auto = info["qualities"]["auto"]
    assert [entry["type"] for entry in auto] == [
        "application/x-mpegURL",
        "application/vnd.lumberjack.manifest",
    ]
    master_url = auto[0]["url"]
    assert path_of(master_url) == sites.url(f"/dm/cdn/manifest/{DM_TS_ID}.m3u8")
    assert "sec" in query_of(master_url)
    poster = fetch(info["posters"]["720"])
    assert poster.status == 200 and poster.headers["Content-Type"] == "image/jpeg"

    master = fetch(master_url)
    assert master.status == 200
    assert master.headers["Content-Type"] == "application/vnd.apple.mpegurl"
    lines = master.text.splitlines()
    assert lines[0] == "#EXTM3U"
    variants = [line for line in lines if line.startswith("#EXT-X-STREAM-INF:")]
    assert len(variants) == 2
    assert 'NAME="1080"' in variants[0] and "RESOLUTION=1920x1080" in variants[0]
    assert 'NAME="480"' in variants[1] and "RESOLUTION=854x480" in variants[1]
    uris = [line for line in lines if line and not line.startswith("#")]
    assert uris == [f"../{DM_TS_ID}/media-1080.m3u8?gen=1", f"../{DM_TS_ID}/media-480.m3u8?gen=1"]
    assert "gen=2" in fetch(master_url).text  # every master starts a new URL generation

    playlist = fetch(sites.url(f"/dm/cdn/{DM_TS_ID}/media-1080.m3u8?gen=2")).text
    assert "#EXT-X-ENDLIST" in playlist and "#EXT-X-KEY" not in playlist
    assert "#EXT-X-MAP" not in playlist
    segments = [line for line in playlist.splitlines() if line and not line.startswith("#")]
    assert segments == ["seg000.ts?gen=2", "seg001.ts?gen=2", "seg002.ts?gen=2"]
    for index, name in enumerate(segments):
        answer = fetch(sites.url(f"/dm/cdn/{DM_TS_ID}/{name}"))
        assert answer.status == 200 and answer.headers["Content-Type"] == "video/mp2t"
        assert answer.body == media.hls_ts.segments[index].read_bytes()
    assert fetch(sites.url(f"/dm/cdn/{DM_TS_ID}/seg003.ts")).status == 404
    assert fetch(sites.url(f"/dm/cdn/{DM_TS_ID}/seg000.m4s")).status == 404  # TS, not fMP4
    assert fetch(sites.url(f"/dm/cdn/{DM_TS_ID}/init.mp4")).status == 404
    assert fetch(sites.url(f"/dm/cdn/{DM_TS_ID}/media-720.m3u8")).status == 404
    # the 480 variant is OTHER media: the 160x90 clip's segments, under `480/`
    low = fetch(sites.url(f"/dm/cdn/{DM_TS_ID}/media-480.m3u8?gen=2")).text
    assert "#EXT-X-ENDLIST" in low
    low_segments = [line for line in low.splitlines() if line and not line.startswith("#")]
    assert low_segments == [f"{DM_LOW_VARIANT}/seg00{n}.ts?gen=2" for n in range(3)]
    for index, name in enumerate(low_segments):
        answer = fetch(sites.url(f"/dm/cdn/{DM_TS_ID}/{name}"))
        assert answer.status == 200 and answer.headers["Content-Type"] == "video/mp2t"
        assert answer.body == media.hls_ts_low.segments[index].read_bytes()
        assert answer.body != media.hls_ts.segments[index].read_bytes()
    assert fetch(sites.url(f"/dm/cdn/{DM_TS_ID}/720/seg000.ts")).status == 404
    assert fetch(sites.url(f"/dm/cdn/{DM_TS_ID}/480/init.mp4")).status == 404  # TS: no init
    assert fetch(sites.url("/dm/player/metadata/video/BAD!")).status == 404
    assert fetch(sites.url("/elsewhere")).status == 404


def test_dailymotion_fmp4_option_serves_an_init_and_m4s_segments(media: MediaSet):
    with FakeSites(media, dm_fmp4=frozenset({DM_FMP4_ID})) as sites:
        playlist = fetch(sites.url(f"/dm/cdn/{DM_FMP4_ID}/media-1080.m3u8")).text
        assert '#EXT-X-MAP:URI="init.mp4?gen=1"' in playlist
        assert "\nseg000.m4s?gen=1" in playlist
        init = fetch(sites.url(f"/dm/cdn/{DM_FMP4_ID}/init.mp4?gen=1"))
        assert init.status == 200 and init.body == media.hls_fmp4.init.read_bytes()
        segment = fetch(sites.url(f"/dm/cdn/{DM_FMP4_ID}/seg001.m4s?gen=1"))
        assert segment.body == media.hls_fmp4.segments[1].read_bytes()
        # the 480 variant: the 160x90 clip's own init and segments
        low = fetch(sites.url(f"/dm/cdn/{DM_FMP4_ID}/media-480.m3u8")).text
        assert f'#EXT-X-MAP:URI="{DM_LOW_VARIANT}/init.mp4?gen=1"' in low
        assert f"\n{DM_LOW_VARIANT}/seg000.m4s?gen=1" in low
        assert media.hls_fmp4_low.init is not None
        init = fetch(sites.url(f"/dm/cdn/{DM_FMP4_ID}/{DM_LOW_VARIANT}/init.mp4?gen=1"))
        assert init.status == 200 and init.body == media.hls_fmp4_low.init.read_bytes()
        segment = fetch(sites.url(f"/dm/cdn/{DM_FMP4_ID}/{DM_LOW_VARIANT}/seg001.m4s"))
        assert segment.body == media.hls_fmp4_low.segments[1].read_bytes()
        # another id keeps MPEG-TS
        assert "seg000.ts" in fetch(sites.url(f"/dm/cdn/{DM_TS_ID}/media-480.m3u8")).text


def test_dailymotion_refusal_options(media: MediaSet):
    options = {
        "dm_geo_blocked": frozenset({"xgeo001"}),
        "dm_not_found": frozenset({"xgone01"}),
        "dm_key_protected": frozenset({"xkey001"}),
        "dm_live": frozenset({"xlive01"}),
        "dm_rate_limit_manifest": frozenset({"xlimit1"}),
    }
    with FakeSites(media, **options) as sites:
        geo = fetch(sites.url("/dm/player/metadata/video/xgeo001")).json()
        assert geo["error"]["code"] == "DM007" and "geo-restricted" in geo["error"]["title"]
        assert "qualities" not in geo
        gone = fetch(sites.url("/dm/player/metadata/video/xgone01"))
        assert gone.status == 200 and gone.json()["error"]["code"] == "DM002"
        keyed = fetch(sites.url("/dm/cdn/xkey001/media-1080.m3u8")).text
        assert '#EXT-X-KEY:METHOD=AES-128,URI="key.bin?gen=1"' in keyed
        assert keyed.index("#EXT-X-KEY") < keyed.index("#EXTINF")
        assert fetch(sites.url("/dm/cdn/xkey001/key.bin")).status == 404
        live = fetch(sites.url("/dm/cdn/xlive01/media-1080.m3u8")).text
        assert "#EXT-X-ENDLIST" not in live and "#EXT-X-PLAYLIST-TYPE" not in live
        assert "#EXTINF" in live
        limited = fetch(sites.url("/dm/cdn/manifest/xlimit1.m3u8"))
        assert limited.status == 429
        assert fetch(sites.url("/dm/cdn/manifest/xgeo001.m3u8")).status == 200  # others: fine


def test_dailymotion_claims_longer_option_changes_only_the_metadata_duration(media: MediaSet):
    with FakeSites(media, dm_claims_longer=frozenset({"xlong01"})) as sites:
        longer = fetch(sites.url("/dm/player/metadata/video/xlong01")).json()
        assert longer["duration"] == CLAIMED_SECONDS > SOURCE_SECONDS
        assert "error" not in longer and longer["qualities"]["auto"]
        assert fetch(sites.url("/dm/player/metadata/video/xother1")).json()["duration"] == 6
        playlist = fetch(sites.url("/dm/cdn/xlong01/media-1080.m3u8")).text
        assert "#EXT-X-ENDLIST" in playlist  # the same 6 s clip as every other video


def test_dailymotion_expired_segment_once_and_truncated_segment_once(media: MediaSet):
    with FakeSites(
        media,
        dm_expire_segment_once=frozenset({DM_TS_ID}),
        dm_truncate_segment=frozenset({DM_TS_ID}),
    ) as sites:
        expiring = sites.url(f"/dm/cdn/{DM_TS_ID}/seg{EXPIRING_SEGMENT:03d}.ts?gen=1")
        assert fetch(expiring).status == 403
        assert fetch(expiring.replace("gen=1", "gen=2")).status == 200  # once only
        truncated = sites.url(f"/dm/cdn/{DM_TS_ID}/seg{TRUNCATED_SEGMENT:03d}.ts?gen=1")
        full = media.hls_ts.segments[TRUNCATED_SEGMENT].read_bytes()
        with pytest.raises(http.client.IncompleteRead) as cut:
            fetch(truncated)
        assert len(cut.value.partial) == len(full) // 2
        assert fetch(truncated).body == full  # once only
        records = sites.by_route("dm-segment")
        assert [(r.status, r.cut) for r in records] == [
            (403, False),
            (200, False),
            (200, True),
            (200, False),
        ]
        assert records[2].sent_bytes == len(full) // 2
        assert records[2].finished - records[2].started >= CUT_LINGER_S  # bytes, then the drop
        assert records[3].sent_bytes == len(full)


# -- Bilibili ------------------------------------------------------------------------------------


def _bili_page(sites: FakeSites, bvid: str = BILI_MAIN, query: str = "") -> tuple[Answer, Any]:
    answer = fetch(sites.url(f"/bili/video/{bvid}{query}"))
    return answer, embedded_json(answer.text, "__INITIAL_STATE__")


def test_bilibili_page_embeds_the_state_and_the_playinfo(sites: FakeSites, media: MediaSet):
    answer, state = _bili_page(sites)
    assert answer.status == 200 and answer.headers["Content-Type"].startswith("text/html")
    assert f"SESSDATA={FAKE_SESSDATA}" in answer.headers["Set-Cookie"]
    video = state["videoData"]
    assert video["bvid"] == BILI_MAIN and video["title"] == "Fake Bilibili two-part video"
    assert video["duration"] == 6 and video["rights"]["is_stein_gate"] == 0
    assert [page["page"] for page in video["pages"]] == [1]
    assert video["pic"] == sites.url(f"/bili/cover/{BILI_MAIN}.jpg")
    assert state["upData"]["name"] == "Fake Uploader"
    data = embedded_json(answer.text, "__playinfo__")["data"]
    assert data["timelength"] == 6000 and data["accept_quality"] == [80, 64, 32]
    assert [f["quality"] for f in data["support_formats"]] == [80, 64, 32]
    assert not any("试看" in text for text in data["accept_description"])
    dash = data["dash"]
    assert [(v["id"], v["codecs"][:4]) for v in dash["video"]] == [
        (80, "avc1"),
        (80, "hev1"),
        (64, "avc1"),
        (32, "avc1"),
    ]
    assert [a["id"] for a in dash["audio"]] == [30280, 30216]
    cid = bili_cid(BILI_MAIN, 1)
    first = dash["video"][0]
    assert path_of(first["baseUrl"]) == sites.url(f"/bili/cdn/{cid}/80.m4s")
    assert path_of(dash["video"][1]["baseUrl"]) == sites.url(f"/bili/cdn/{cid}/80-hevc.m4s")
    query = query_of(first["baseUrl"])
    assert int(query["deadline"]) > time.time() + 3000 and len(query["upsig"]) == 32
    assert first["backupUrl"] == first["backup_url"] and "mirror=2" in first["backupUrl"][0]
    assert (first["width"], first["height"], first["mimeType"]) == (1920, 1080, "video/mp4")
    # the CDN serves the fixtures behind the fake site's Referer
    referer = {"Referer": sites.expected_referer("bilibili")}
    assert sites.expected_referer("bilibili") == sites.url("/bili/")
    assert fetch(first["baseUrl"], referer).body == media.dash_video.read_bytes()
    hevc = dash["video"][1]
    assert fetch(hevc["baseUrl"], referer).body == media.dash_video_hevc.read_bytes()
    assert hevc["bandwidth"] < first["bandwidth"]  # by default: half its AVC's
    assert fetch(dash["video"][3]["baseUrl"], referer).body == media.dash_video_low.read_bytes()
    assert fetch(dash["audio"][0]["baseUrl"], referer).body == media.dash_audio.read_bytes()
    assert dash["dolby"] == {"type": 0, "audio": None} and dash["flac"] is None
    # an audio id the page does not offer is not served (FLAC and Dolby are options)
    for audio_id in (BILI_FLAC_AUDIO[0], BILI_DOLBY_AUDIO[0], 30232):
        missing = dash["audio"][0]["baseUrl"].replace("audio-30280", f"audio-{audio_id}")
        assert fetch(missing, referer).status == 404, audio_id
    assert fetch(first["backupUrl"][0], referer).status == 200
    assert fetch(sites.url(f"/bili/cover/{BILI_MAIN}.jpg")).status == 200
    assert fetch(sites.url("/bili/video/not-a-bvid")).status == 404


def test_bilibili_cdn_wants_the_referer_honours_range_and_the_deadline(
    sites: FakeSites, media: MediaSet
):
    _, state = _bili_page(sites)
    full = media.dash_video.read_bytes()
    url = sites.url(f"/bili/cdn/{bili_cid(BILI_MAIN, 1)}/80.m4s?deadline={int(time.time()) + 60}")
    assert fetch(url).status == 403  # no Referer: like the real CDN
    assert fetch(url, {"Referer": "https://www.bilibili.com/"}).status == 403  # not the fake's
    referer = {"Referer": sites.expected_referer("bilibili")}
    whole = fetch(url, referer)
    assert whole.status == 200 and whole.headers["Accept-Ranges"] == "bytes"
    assert whole.headers["Content-Length"] == str(len(full))
    part = fetch(url, {**referer, "Range": "bytes=100-199"})
    assert part.status == 206 and part.body == full[100:200]
    assert part.headers["Content-Range"] == f"bytes 100-199/{len(full)}"
    rest = fetch(url, {**referer, "Range": "bytes=1000-"})
    assert rest.status == 206 and rest.body == full[1000:]
    assert rest.headers["Content-Range"] == f"bytes 1000-{len(full) - 1}/{len(full)}"
    beyond = fetch(url, {**referer, "Range": f"bytes={len(full)}-"})
    assert beyond.status == 416 and beyond.headers["Content-Range"] == f"bytes */{len(full)}"
    assert fetch(url, {**referer, "Range": "items=1-2"}).status == 416
    expired = url.split("?")[0] + f"?deadline={int(time.time()) - 10}"
    assert fetch(expired, referer).status == 403
    assert fetch(url.split("?")[0], referer).status == 403  # no deadline at all
    assert fetch(sites.url("/bili/cdn/123/80.m4s?deadline=9999999999"), referer).status == 404
    assert state is not None


def test_bilibili_two_parts_and_the_part_query(media: MediaSet):
    with FakeSites(media, bili_parts=2) as sites:
        answer, state = _bili_page(sites, query="?p=2")
        video = state["videoData"]
        assert [(p["page"], p["part"]) for p in video["pages"]] == [
            (1, "First half"),
            (2, "Second half"),
        ]
        assert [p["cid"] for p in video["pages"]] == [
            int(bili_cid(BILI_MAIN, 1)),
            int(bili_cid(BILI_MAIN, 2)),
        ]
        assert state["p"] == 2 and video["duration"] == 12
        dash = embedded_json(answer.text, "__playinfo__")["data"]["dash"]
        assert f"/bili/cdn/{bili_cid(BILI_MAIN, 2)}/" in dash["video"][0]["baseUrl"]
        _, state = _bili_page(sites, query="/")
        assert state["p"] == 1


def test_bilibili_part_412_refuses_one_part_page_only(media: MediaSet):
    with FakeSites(media, bili_parts=2, bili_part_412=((BILI_MAIN, 2),)) as sites:
        refused = fetch(sites.url(f"/bili/video/{BILI_MAIN}?p=2"))
        assert refused.status == 412 and b"Request is blocked by server (412)" in refused.body
        _, state = _bili_page(sites)
        assert state["p"] == 1 and len(state["videoData"]["pages"]) == 2
        _, state = _bili_page(sites, query="?p=1")
        assert state["p"] == 1


def test_b23_short_links_redirect_to_the_video_page(sites: FakeSites):
    answer = fetch(sites.url(f"/b23/{B23_CODE}"))
    assert answer.status == 302
    assert answer.headers["Location"] == sites.url(f"/bili/video/{BILI_MAIN}?share_source=copy_web")
    assert fetch(sites.url("/b23/unknown")).status == 404


def test_bilibili_page_options(media: MediaSet):
    login, deleted, risk, premium = "BV1Lo6G1nR3q", "BV1De7L1eT4d", "BV1Rk5D1aT2a", "BV1Pr3M1uM9x"
    upower, trial = "BV1Up0W1eR5x", "BV1Tr1A1lO6n"
    with FakeSites(
        media,
        bili_login_wall=frozenset({login}),
        bili_deleted=frozenset({deleted}),
        bili_riskdata=frozenset({risk}),
        bili_missing_premium=frozenset({premium}),
        bili_upower_no_dash=frozenset({upower}),
        bili_trial=frozenset({trial}),
    ) as sites:
        _, state = _bili_page(sites, login)
        assert state["error"]["trueCode"] == -403 and state["videoData"] == {}
        answer, state = _bili_page(sites, deleted)
        assert state["error"]["trueCode"] == -404
        assert embedded_json(answer.text, "__playinfo__") is None
        answer, state = _bili_page(sites, risk)
        assert state is None
        assert embedded_json(answer.text, "_riskdata_")["v_voucher"].startswith("voucher_")
        answer, _ = _bili_page(sites, premium)
        data = embedded_json(answer.text, "__playinfo__")["data"]
        assert BILI_PREMIUM_QUALITY in data["accept_quality"]
        assert BILI_PREMIUM_QUALITY in [f["quality"] for f in data["support_formats"]]
        assert BILI_PREMIUM_QUALITY not in [v["id"] for v in data["dash"]["video"]]
        answer, state = _bili_page(sites, upower)
        assert state["videoData"]["is_upower_exclusive"] is True
        assert "dash" not in embedded_json(answer.text, "__playinfo__")["data"]
        answer, state = _bili_page(sites, trial)
        data = embedded_json(answer.text, "__playinfo__")["data"]
        assert all("试看" in text for text in data["accept_description"]) and data["dash"]
        _, state = _bili_page(sites)  # any other video: untouched
        assert state["videoData"]["is_upower_exclusive"] is False


def test_bilibili_cdn_options(media: MediaSet):
    banned, drm, expiring, cut = "BV1Ba4N1nE7d", "BV1Dr2M1aB3c", "BV1Ex9P1rE4d", "BV1Cu5T1oN6e"
    with FakeSites(
        media,
        bili_cdn_412=frozenset({banned}),
        bili_drm=frozenset({drm}),
        bili_expire_once=frozenset({expiring}),
        bili_cut_once=frozenset({cut}),
    ) as sites:
        referer = {"Referer": sites.expected_referer("bilibili")}

        def urls(bvid: str) -> tuple[str, str]:
            answer, _ = _bili_page(sites, bvid)
            dash = embedded_json(answer.text, "__playinfo__")["data"]["dash"]
            return dash["video"][0]["baseUrl"], dash["audio"][0]["baseUrl"]

        video, _ = urls(banned)
        blocked = fetch(video, referer)
        assert blocked.status == 412 and b"Request is blocked by server (412)" in blocked.body
        assert fetch(video).status == 412  # banned whatever the headers
        video, _ = urls(drm)
        body = fetch(video, referer).body
        assert body == media.dash_video_encrypted.read_bytes()
        assert "pssh" in top_level_types(body)
        video, audio = urls(expiring)
        assert fetch(audio, referer).status == 403
        assert fetch(audio, referer).body == media.dash_audio.read_bytes()  # once only
        assert fetch(video, referer).status == 200
        video, _ = urls(cut)
        whole = media.dash_video.read_bytes()
        with pytest.raises(http.client.IncompleteRead) as error:
            fetch(video, referer)
        received = len(error.value.partial)
        assert received == len(whole) // 2
        resumed = fetch(video, {**referer, "Range": f"bytes={received}-"})
        assert resumed.status == 206 and error.value.partial + resumed.body == whole
        record = sites.by_route("bili-video")[-2]
        assert record.cut and record.sent_bytes == received and record.range is None


def test_bilibili_codec_options_flac_dolby_and_a_top_bandwidth_hevc(media: MediaSet):
    flac_dolby, dolby_only = "BV1Fl4C1aD7b", "BV1Do5L1bY8e"
    with FakeSites(
        media,
        bili_flac=frozenset({flac_dolby}),
        bili_dolby=frozenset({flac_dolby, dolby_only}),
        bili_hevc_top_bandwidth=frozenset({flac_dolby}),
        bili_qualities=((80, "avc"), (80, "hevc"), (64, "hevc")),
    ) as sites:
        referer = {"Referer": sites.expected_referer("bilibili")}

        def dash_of(bvid: str) -> dict[str, Any]:
            answer, _ = _bili_page(sites, bvid)
            return embedded_json(answer.text, "__playinfo__")["data"]["dash"]

        dash = dash_of(flac_dolby)
        avc, hevc, low_hevc = dash["video"]
        assert (avc["codecs"][:4], hevc["codecs"][:4]) == ("avc1", "hev1")
        assert hevc["bandwidth"] == avc["bandwidth"] * 3 // 2  # the highest at 1080P
        assert fetch(hevc["baseUrl"], referer).body == media.dash_video_hevc.read_bytes()
        assert fetch(low_hevc["baseUrl"], referer).status == 404  # no HEVC below 80
        flac = dash["flac"]
        assert flac["display"] is True
        assert (flac["audio"]["id"], flac["audio"]["codecs"]) == (BILI_FLAC_AUDIO[0], "fLaC")
        assert flac["audio"]["bandwidth"] == BILI_FLAC_AUDIO[1]
        assert fetch(flac["audio"]["baseUrl"], referer).body == media.dash_audio_flac.read_bytes()
        assert fetch(flac["audio"]["backupUrl"][0], referer).status == 200
        (dolby,) = dash["dolby"]["audio"]
        assert dash["dolby"]["type"] == 2
        assert (dolby["id"], dolby["codecs"]) == (BILI_DOLBY_AUDIO[0], "ec-3")
        assert fetch(dolby["baseUrl"], referer).body == media.dash_audio_eac3.read_bytes()
        assert [a["id"] for a in dash["audio"]] == [30280, 30216]  # the AAC tracks stay
        # Dolby alone: no FLAC entry, its id not served; the HEVC at its default bandwidth
        dash = dash_of(dolby_only)
        assert dash["flac"] is None and dash["dolby"]["audio"][0]["id"] == BILI_DOLBY_AUDIO[0]
        assert dash["video"][1]["bandwidth"] == dash["video"][0]["bandwidth"] // 2
        flac_url = dash["audio"][0]["baseUrl"].replace("audio-30280", "audio-30251")
        assert fetch(flac_url, referer).status == 404
        assert fetch(dash["dolby"]["audio"][0]["baseUrl"]).status == 403  # no Referer


def test_bilibili_qualities_option(media: MediaSet):
    with FakeSites(media, bili_qualities=((64, "avc"), (32, "avc"))) as sites:
        answer, _ = _bili_page(sites)
        data = embedded_json(answer.text, "__playinfo__")["data"]
        assert [v["id"] for v in data["dash"]["video"]] == [64, 32]
        cid = bili_cid(BILI_MAIN, 1)
        referer = {"Referer": sites.expected_referer("bilibili")}
        missing = sites.url(f"/bili/cdn/{cid}/80.m4s?deadline={int(time.time()) + 60}")
        assert fetch(missing, referer).status == 404


# -- Bilibili.tv ---------------------------------------------------------------------------------


def test_bilibilitv_user_video_page_in_any_language(sites: FakeSites):
    for path in (f"/btv/en/video/{BTV_AID}", f"/btv/ES/video/{BTV_AID}", f"/btv/video/{BTV_AID}"):
        answer = fetch(sites.url(f"{path}?bstar_from={BSTAR_FROM}"))
        assert answer.status == 200, path
        data = embedded_json(answer.text, "__INITIAL_DATA__")
        video = data["UgcVideo"]["videoData"]
        assert video["title_display"] == video["title"] == "Fake Bstation user video"
        assert str(video["aid"]) == BTV_AID and video["duration"] == 6
        assert video["cover"] == sites.url(f"/btv-cover/{BTV_AID}.jpg")
        assert '<meta property="og:title" content="Fake Bstation user video">' in answer.text
        assert 'class="bstar-meta__title"' in answer.text
        ld = json.loads(
            re.search(r'<script type="application/ld\+json">(.*?)</script>', answer.text)[1]
        )
        assert ld["@type"] == "VideoObject" and ld["duration"] == "PT6S"
    assert fetch(sites.url(f"/btv-cover/{BTV_AID}.jpg")).status == 200


def test_bilibilitv_episode_pages_episodes_and_season_info(sites: FakeSites):
    ep_id, title = BTV_EPISODES[1]
    answer = fetch(sites.url(f"/btv/en/play/{BTV_SEASON}/{ep_id}"))
    episode = embedded_json(answer.text, "__INITIAL_DATA__")["OgvVideo"]["epDetail"]
    assert episode["title_display"] == title and str(episode["episode_id"]) == ep_id
    assert fetch(sites.url(f"/btv/en/play/{BTV_SEASON}/99")).status == 404
    assert fetch(sites.url(f"/btv/en/play/1/{ep_id}")).status == 404
    episodes = fetch(
        sites.url(f"/btv-api/intl/gateway/web/v2/ogv/play/episodes?season_id={BTV_SEASON}")
    ).json()
    sections = episodes["data"]["sections"]
    assert episodes["code"] == 0 and len(sections) == 2
    listed = [(str(e["episode_id"]), e["title_display"]) for s in sections for e in s["episodes"]]
    assert listed == list(BTV_EPISODES)
    season = fetch(
        sites.url(f"/btv-api/intl/gateway/web/v2/ogv/play/season_info?season_id={BTV_SEASON}")
    ).json()
    assert season["data"]["season"]["title"] == BTV_SEASON_TITLE
    other = fetch(sites.url("/btv-api/intl/gateway/web/v2/ogv/play/season_info?season_id=7"))
    assert other.json()["code"] == -404


def _playurl(sites: FakeSites, query: str) -> Any:
    return fetch(sites.url(f"/btv-api/intl/gateway/web/playurl?platform=web&{query}")).json()


def test_bilibilitv_playurl_serves_progressive_files_by_default(sites: FakeSites, media):
    answer = _playurl(sites, f"aid={BTV_AID}")
    assert answer["code"] == 0
    playurl = answer["data"]["playurl"]
    videos = playurl["video"]
    assert [(v["stream_info"]["quality"], v["stream_info"]["desc_words"]) for v in videos] == [
        (80, "1080P"),
        (64, "720P"),
        (32, "480P"),
    ]
    assert [v["video_resource"]["height"] for v in videos] == [1080, 720, 480]
    assert [a["quality"] for a in playurl["audio_resource"]] == [30280, 30216]
    referer = {"Referer": sites.expected_referer("bilibilitv")}
    assert sites.expected_referer("bilibilitv") == sites.url("/btv/")
    top = videos[0]["video_resource"]["url"]
    assert path_of(top) == sites.url(f"/btv-cdn/{BTV_AID}/80.mp4") and "sign" in query_of(top)
    assert fetch(top).status == 403  # no Referer
    body = fetch(top, referer).body
    assert body == media.progressive_video.read_bytes()
    assert top_level_types(body).index("mdat") < top_level_types(body).index("moov")
    low = fetch(videos[2]["video_resource"]["url"], referer).body
    assert low == media.progressive_video_low.read_bytes()
    audio = fetch(playurl["audio_resource"][0]["url"], referer)
    assert audio.body == media.progressive_audio.read_bytes()
    assert audio.headers["Content-Type"] == "audio/mp4"
    part = fetch(top, {**referer, "Range": "bytes=10-19"})
    assert part.status == 206 and part.body == media.progressive_video.read_bytes()[10:20]
    expired = path_of(top) + f"?deadline={int(time.time()) - 1}"
    assert fetch(expired, referer).status == 403
    # episodes are served the same way, by ep_id
    ep_id = BTV_EPISODES[0][0]
    assert _playurl(sites, f"ep_id={ep_id}")["data"]["playurl"]["video"][0]["video_resource"][
        "url"
    ].startswith(sites.url(f"/btv-cdn/{ep_id}/80.mp4"))
    bad = fetch(sites.url("/btv-api/intl/gateway/web/playurl?aid=1")).json()
    assert bad["code"] == -400  # no platform=web


def test_bilibilitv_playurl_options(media: MediaSet):
    ids = {name: f"48015200000001{n:02d}" for n, name in enumerate(("geo", "login", "premium"))}
    empty, fragmented, missing, uncovered = (f"48015200000002{n:02d}" for n in range(4))
    with FakeSites(
        media,
        btv_geo=frozenset({ids["geo"]}),
        btv_login=frozenset({ids["login"]}),
        btv_premium=frozenset({ids["premium"]}),
        btv_empty=frozenset({empty}),
        btv_fragmented=frozenset({fragmented}),
        btv_missing_quality=frozenset({missing}),
        btv_uncovered_host=frozenset({uncovered}),
    ) as sites:
        for name, code in (("geo", 10004001), ("login", 10004004), ("premium", 10023006)):
            answer = _playurl(sites, f"aid={ids[name]}")
            assert (answer["code"], answer["data"]) == (code, None), name
        playurl = _playurl(sites, f"aid={empty}")["data"]["playurl"]
        assert playurl["video"] == [] and playurl["audio_resource"] == []
        playurl = _playurl(sites, f"aid={fragmented}")["data"]["playurl"]
        referer = {"Referer": sites.expected_referer("bilibilitv")}
        body = fetch(playurl["video"][0]["video_resource"]["url"], referer).body
        assert body == media.dash_video.read_bytes() and "moof" in top_level_types(body)
        audio = fetch(playurl["audio_resource"][0]["url"], referer).body
        assert audio == media.dash_audio.read_bytes()
        videos = _playurl(sites, f"aid={missing}")["data"]["playurl"]["video"]
        assert videos[0]["video_resource"]["url"] == ""
        assert videos[0]["stream_info"]["desc_words"] == "1080P+"
        assert all(v["video_resource"]["url"] for v in videos[1:])
        url = _playurl(sites, f"aid={uncovered}")["data"]["playurl"]["video"][0]["video_resource"]
        assert url["url"].startswith(f"http://localhost:{sites.port}/btv-cdn/{uncovered}/")


def test_bilibilitv_cut_once_cuts_the_first_video_request_only(media: MediaSet):
    cut, other = "4801520000000301", "4801520000000302"
    with FakeSites(
        media, btv_cut_once=frozenset({cut}), btv_fragmented=frozenset({cut, other})
    ) as sites:
        referer = {"Referer": sites.expected_referer("bilibilitv")}
        playurl = _playurl(sites, f"aid={cut}")["data"]["playurl"]
        video = playurl["video"][0]["video_resource"]["url"]
        whole = media.dash_video.read_bytes()
        with pytest.raises(http.client.IncompleteRead) as error:
            fetch(video, referer)
        received = len(error.value.partial)
        assert received == len(whole) // 2
        resumed = fetch(video, {**referer, "Range": f"bytes={received}-"})
        assert resumed.status == 206 and error.value.partial + resumed.body == whole
        assert fetch(video, referer).body == whole  # once only
        audio = fetch(playurl["audio_resource"][0]["url"], referer)
        assert audio.body == media.dash_audio.read_bytes()  # the audio is never cut
        other_video = _playurl(sites, f"aid={other}")["data"]["playurl"]["video"][0]
        assert fetch(other_video["video_resource"]["url"], referer).body == whole
        records = sites.by_route("btv-video")
        assert [(r.cut, r.range, r.status) for r in records] == [
            (True, None, 200),
            (False, f"bytes={received}-", 206),
            (False, None, 200),
            (False, None, 200),
        ]
        assert records[0].sent_bytes == received


# -- the request log -----------------------------------------------------------------------------


def test_the_request_log_keeps_names_and_three_values_never_a_cookie_value(sites: FakeSites):
    secret = "do-not-log-this-0123"
    url = sites.url(f"/bili/video/{BILI_MAIN}?p=1")
    fetch(
        url,
        {
            "Cookie": f"SESSDATA={secret}; buvid3=also-secret",
            "Referer": "http://example.test/ref",
            "Origin": "http://example.test",
            "X-Custom-Token": secret,
        },
    )
    fetch(sites.url(f"/bili/cdn/{bili_cid(BILI_MAIN, 1)}/80.m4s"), {"Range": "bytes=0-9"})
    page, cdn = sites.requests
    assert secret not in repr(sites.requests) and "also-secret" not in repr(sites.requests)
    assert page.method == "GET" and page.path == f"/bili/video/{BILI_MAIN}"
    assert page.query == {"p": "1"} and page.host == "127.0.0.1"
    assert page.route == "bili-page" and (page.site, page.kind) == ("bilibili", "page")
    assert page.cookie_names == ("SESSDATA", "buvid3")
    assert {"cookie", "referer", "origin", "x-custom-token", "host"} <= set(page.header_names)
    assert page.header_names == tuple(sorted(page.header_names))
    assert (page.referer, page.origin, page.range) == (
        "http://example.test/ref",
        "http://example.test",
        None,
    )
    assert page.status == 200 and page.sent_bytes > 1000 and not page.cut
    assert page.started <= page.finished <= cdn.started <= cdn.finished
    assert cdn.route == "bili-video" and cdn.kind == "media" and cdn.range == "bytes=0-9"
    assert cdn.status == 403  # no Referer
    assert sites.about(BILI_MAIN) == [page, cdn]
    assert sites.media_requests("bilibili") == [cdn] and sites.page_requests() == [page]
    assert sites.site_requests() == [page, cdn] and sites.cover_requests() == []
    sites.clear_log()
    assert sites.requests == []


def test_the_log_tells_hosts_apart_and_options_change_while_running(sites: FakeSites):
    response = fetch(f"http://localhost:{sites.port}/dm/player/metadata/video/{DM_TS_ID}")
    assert response.status == 200
    (record,) = sites.uncovered_requests()
    assert record.host == "localhost"
    assert "error" not in response.json()
    sites.set_options(dm_geo_blocked=frozenset({DM_TS_ID}))
    assert sites.options.dm_geo_blocked == frozenset({DM_TS_ID})
    geo = fetch(sites.url(f"/dm/player/metadata/video/{DM_TS_ID}")).json()
    assert geo["error"]["code"] == "DM007"
    covers = (f"/dm/poster/{DM_TS_ID}.jpg", f"/bili/cover/{BILI_MAIN}.jpg", "/btv-cover/1.jpg")
    for path in covers:
        assert fetch(sites.url(path)).status == 200
    assert [r.site for r in sites.cover_requests()] == ["dailymotion", "bilibili", "bilibilitv"]


def test_covers_png_webp_refused_and_one_extension_each(media: MediaSet):
    png, webp, gone, limited = BILI_MAIN, BTV_AID, "xcv404m", BILI_UNICODE
    with FakeSites(
        media,
        cover_png=frozenset({png}),
        cover_webp=frozenset({webp, DM_TS_ID}),
        cover_status=((gone, 404), (limited, 429)),
    ) as sites:
        # the URLs the sites' documents give
        _, state = _bili_page(sites, png)
        assert state["videoData"]["pic"] == sites.url(f"/bili/cover/{png}.png")
        page = fetch(sites.url(f"/btv/en/video/{webp}")).text
        cover = embedded_json(page, "__INITIAL_DATA__")["UgcVideo"]["videoData"]["cover"]
        assert cover == sites.url(f"/btv-cover/{webp}.webp")
        assert f'content="{cover}"' in page  # og:image
        info = fetch(sites.url(f"/dm/player/metadata/video/{DM_TS_ID}")).json()
        assert all(path_of(url).endswith(f"/{DM_TS_ID}.webp") for url in info["posters"].values())
        # the answers
        answer = fetch(sites.url(f"/bili/cover/{png}.png"))
        assert answer.status == 200 and answer.headers["Content-Type"] == "image/png"
        assert answer.body == media.cover_png.read_bytes()
        answer = fetch(cover)
        assert answer.headers["Content-Type"] == "image/webp"
        assert answer.body == media.cover_webp.read_bytes()
        assert fetch(sites.url(f"/dm/poster/{DM_TS_ID}.webp?h=720")).status == 200
        assert fetch(sites.url(f"/bili/cover/{png}.jpg")).status == 404  # not its extension
        assert fetch(sites.url(f"/btv-cover/{webp}.jpg")).status == 404
        assert fetch(sites.url(f"/dm/poster/{gone}.jpg?h=720")).status == 404
        refused = fetch(sites.url(f"/bili/cover/{limited}.jpg"))
        assert refused.status == 429 and b"cover refused" in refused.body
        default = fetch(sites.url(f"/dm/poster/{DM_FMP4_ID}.jpg?h=360"))
        assert default.headers["Content-Type"] == "image/jpeg"
        assert default.body == media.cover.read_bytes()
        episodes = fetch(
            sites.url(f"/btv-api/intl/gateway/web/v2/ogv/play/episodes?season_id={BTV_SEASON}")
        ).json()
        covers = [e["cover"] for s in episodes["data"]["sections"] for e in s["episodes"]]
        assert all(url.endswith(".jpg") for url in covers)
        answered = [(r.route, r.status) for r in sites.cover_requests()]
        assert answered == [
            ("bili-cover", 200),
            ("btv-cover", 200),
            ("dm-poster", 200),
            ("bili-cover", 404),
            ("btv-cover", 404),
            ("dm-poster", 404),
            ("bili-cover", 429),
            ("dm-poster", 200),
        ], answered


def test_part_counts_per_video(media: MediaSet):
    with FakeSites(media, bili_parts=2, bili_parts_of=((BILI_SHARE, 1),)) as sites:
        assert parts_of(sites.options, BILI_MAIN) == 2
        assert parts_of(sites.options, BILI_SHARE) == 1
        _, state = _bili_page(sites, BILI_SHARE, "/?vd_source=0123&spm_id_from=333.788")
        assert [p["page"] for p in state["videoData"]["pages"]] == [1]
        assert state["videoData"]["title"] == BILI_TITLES[BILI_SHARE]
        _, state = _bili_page(sites)
        assert [p["page"] for p in state["videoData"]["pages"]] == [1, 2]
        _, state = _bili_page(sites, BILI_SHARE, "?p=2")  # no part 2: part 1 is shown
        assert state["p"] == 1


def test_base_urls_for_the_test_settings(sites: FakeSites):
    base = sites.base_url
    assert base.startswith("http://127.0.0.1:")
    assert sites.base_urls() == {
        "dailymotion": f"{base}/dm",
        "dmcdn": f"{base}/dm/cdn",
        "bilibili": f"{base}/bili",
        "b23": f"{base}/b23",
        "bilibilitv": f"{base}/btv",
        "bilibilitvApi": f"{base}/btv-api",
    }
    assert sites.expected_referer("dailymotion") == f"{base}/dm/"


def test_media_delay_holds_media_answers_and_started_paths_sees_them_start(media: MediaSet):
    with FakeSites(media, media_delay_s=0.6) as sites:
        path = f"/dm/cdn/{DM_TS_ID}/seg000.ts"
        done: list[Answer] = []
        worker = threading.Thread(target=lambda: done.append(fetch(sites.url(path))))
        started = time.monotonic()
        worker.start()
        deadline = started + 5
        while path not in sites.started_paths() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert path in sites.started_paths() and not done  # started, not answered yet
        worker.join(10)
        assert done and done[0].status == 200 and time.monotonic() - started >= 0.6
        (record,) = sites.requests
        assert record.path == path and record.finished - record.started >= 0.6
        assert fetch(sites.url(f"/dm/player/metadata/video/{DM_TS_ID}")).status == 200
        sites.clear_log()
        assert sites.requests == [] and sites.started_paths() == []
