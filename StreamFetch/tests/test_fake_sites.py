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
    BILI_MAIN,
    BILI_PREMIUM_QUALITY,
    BSTAR_FROM,
    BTV_AID,
    BTV_EPISODES,
    BTV_SEASON,
    BTV_SEASON_TITLE,
    DM_FMP4_ID,
    DM_TITLES,
    DM_TS_ID,
    EXPIRING_SEGMENT,
    FAKE_SESSDATA,
    TRUNCATED_SEGMENT,
    FakeSites,
    applies,
    bili_cid,
)
from media_fixtures import (
    LOW_HEIGHT,
    SOURCE_HEIGHT,
    MediaSet,
    assert_same_audio,
    assert_same_media,
    duration_of,
    ffprobe,
    framemd5,
    is_progressive,
    streams_of,
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
    # progressive: no moof, mdat BEFORE moov (ffmpeg's default; not "progressive" for spec 9)
    for path in (media.progressive_video, media.progressive_video_low, media.progressive_audio):
        kinds = top_level_types(path.read_bytes())
        assert "moof" not in kinds and kinds.index("mdat") < kinds.index("moov"), kinds
        assert not is_progressive(path)
    assert framemd5(media.progressive_video) == framemd5(media.src)
    assert media.cover.read_bytes()[:2] == b"\xff\xd8"


def test_the_verification_accepts_the_source_and_one_priming_frame_only(media: MediaSet):
    assert_same_audio(media.src, media.src)
    # a DASH audio track decodes the AAC priming frame src.mp4's edit list hides: accepted
    primed = framemd5(media.dash_audio, "a:0")
    assert len(primed) == len(framemd5(media.src, "a:0")) + 1
    assert_same_audio(media.dash_audio, media.src)
    # other pictures, or a fragmented file, are refused
    with pytest.raises(AssertionError, match="video frames differ"):
        assert_same_media(media.low, media.src)
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
    assert fetch(sites.url("/dm/player/metadata/video/BAD!")).status == 404
    assert fetch(sites.url("/elsewhere")).status == 404


def test_dailymotion_fmp4_option_serves_an_init_and_m4s_segments(media: MediaSet):
    with FakeSites(media, dm_fmp4=frozenset({DM_FMP4_ID})) as sites:
        playlist = fetch(sites.url(f"/dm/cdn/{DM_FMP4_ID}/media-480.m3u8")).text
        assert '#EXT-X-MAP:URI="init.mp4?gen=1"' in playlist
        assert "seg000.m4s?gen=1" in playlist
        init = fetch(sites.url(f"/dm/cdn/{DM_FMP4_ID}/init.mp4?gen=1"))
        assert init.status == 200 and init.body == media.hls_fmp4.init.read_bytes()
        segment = fetch(sites.url(f"/dm/cdn/{DM_FMP4_ID}/seg001.m4s?gen=1"))
        assert segment.body == media.hls_fmp4.segments[1].read_bytes()
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
    assert fetch(dash["video"][3]["baseUrl"], referer).body == media.dash_video_low.read_bytes()
    assert fetch(dash["audio"][0]["baseUrl"], referer).body == media.dash_audio.read_bytes()
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
