"""The media the fake sites serve, built ONCE per test session by the system's ffmpeg (spec 9), and
the ffprobe / framemd5 checks every saved file goes through. No binary fixture is committed: every
file is made here from ffmpeg's lavfi test sources; ffmpeg and ffprobe are the only external tools
the tests call.

`build_media(root)` writes, under `root`:

- `src.mp4` — the source clip, exactly spec 9's command: 6 s of `testsrc` 320x180 at 25 fps
  (H.264, GOP 25) and a 440 Hz sine at 48 kHz (AAC 64k);
- `low.mp4` — the same clip scaled to 160x90 (the video re-encoded, the audio copied): the "lower
  quality" a quality selector can pick, told apart from the source by its height;
- `hls-ts/` — `ffmpeg -c copy -f hls -hls_time 2 -hls_playlist_type vod` of `src.mp4`:
  `media.m3u8` and `seg000.ts`, `seg001.ts`, … (MPEG-TS segments);
- `hls-fmp4/` — the same with `-hls_segment_type fmp4`: `init.mp4` and `seg000.m4s`, …;
- `hls-ts-low/`, `hls-fmp4-low/` — the same two renditions of `low.mp4`: what the lower HLS
  variant serves, so a saved file tells by its pictures which variant it came from;
- `dash/` — one fragmented file per track, as Bilibili's m4s: `video.m4s`, `audio.m4s` (spec 9's
  `-movflags frag_keyframe+empty_moov+default_base_moof -frag_duration 1000000`), `video-low.m4s`
  (from `low.mp4`) and `video-encrypted.m4s` (`encrypted_mp4.encrypted_fragmented`: `avc1`
  renamed `encv` and a `pssh` after the `moov`); and the other codecs B.1's `codec` setting
  chooses between: `video-hevc.m4s` (the source's pictures encoded by libx265 — B-frames, so
  composition offsets — with an `hvc1` sample entry: other pictures than the H.264 track's, told
  apart by framemd5), `audio-flac.m4s` (FLAC, a `fLaC` sample entry) and `audio-eac3.m4s`
  (E-AC-3, Dolby's `ec-3`; ffmpeg needs `delay_moov` to write its `dec3`), all made from
  `src.mp4`;
- `progressive/` — one NON-fragmented file per track (`-c copy`, ffmpeg's default layout: `mdat`
  before `moov`), as bilibili.tv serves them by default: `video.mp4`, `audio.mp4`,
  `video-low.mp4`;
- the covers the fake sites serve: `cover.jpg` (16x16 JPEG, every cover by default), `cover.png`
  (24x16 PNG) and `cover.webp` (32x18 WebP, the one StreamFetch must convert to JPEG, B.2) — three
  sizes, so a saved cover tells which one it came from.

What the progressive writer is GIVEN on each media path (`Expected`, `MediaSet.expected`): the
pictures are the clip's (`src.mp4`, or `low.mp4` for a lower quality — `-low`), or, on the HEVC
paths (`dash-hevc…`), the served `video-hevc.m4s`'s; the audio is the track as served — the TS
segments joined (`hls-ts/joined.ts`, `hls-ts-low/joined.ts`), the fMP4 init and segments joined
(`hls-fmp4/joined.mp4`, …), the DASH `audio.m4s` (or `audio-flac.m4s`, `audio-eac3.m4s`) or
bilibili.tv's `audio.mp4`. ffmpeg's segmenter and fragmenter keep the AAC encoder's priming frame
and drop the edit list that hides it in `src.mp4` (as `extension/tests/helpers/media.js`
documents: compare with `-ignore_editlist 1`, or drop the first frame); the progressive
`audio.mp4` keeps the edit list. So a saved file's audio must equal its writer input frame for
frame, and an AAC input must be the source's audio, or the source's audio after ONE priming frame
— nothing else (`assert_saved_media`); a FLAC or E-AC-3 input is another encoding of the source's
sound, proven by its own frames.

Checks: `ffprobe(path)`, `framemd5(path, stream)` (the hash column of ffmpeg's `framemd5` muxer
over the DECODED frames, bit-exact flags — as `extension/tests/helpers/media.js` does),
`is_progressive(path)` (top-level boxes: `moov` before `mdat`, no `moof`), `mp4_metadata(path)`
(the `moov/udta/meta/ilst` items StreamFetch writes, B.2: `©nam` and `covr`), `sample_entry`
(one track's sample entry, byte for byte: what was served is what is saved), `start_edit` /
`unapplied_start_skip` (a served fragmented track's edit list, which ffmpeg does not apply when it
decodes that file: E-AC-3's encoder delay), `packet_hashes` / `decoded_pcm`, `assert_av_offset`
(the video's start next to the audio's, as served: framemd5 is blind to timestamps) and
`assert_saved_media(saved, expected)` — the whole verification of a saved file.
"""

from __future__ import annotations

import functools
import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from encrypted_mp4 import boxes, child, encrypted_fragmented, sample_entries, top_level_types

#: The duration of the source clip, seconds.
SOURCE_SECONDS = 6
SOURCE_WIDTH, SOURCE_HEIGHT = 320, 180
LOW_WIDTH, LOW_HEIGHT = 160, 90
#: The covers' sizes (width, height): three, so a saved cover tells which one it came from.
COVER_JPEG_SIZE, COVER_PNG_SIZE, COVER_WEBP_SIZE = (16, 16), (24, 16), (32, 18)
#: `covr` data types (the `ilst` well-known types): JPEG, PNG.
COVR_JPEG, COVR_PNG = 13, 14
JPEG_SIGNATURE = b"\xff\xd8\xff"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
#: How far a saved file's duration may be from the source's (spec 9: within 0.1 s).
DURATION_TOLERANCE_S = 0.1
#: How far a saved file's A/V offset (its video's start minus its audio's) may be from the served
#: tracks': well under one AAC frame (21.3 ms) and one video frame (40 ms) — a lost edit list or
#: composition shift moves a stream by whole frames — and over the writer's millisecond rounding.
SYNC_TOLERANCE_S = 0.002
_MD5 = re.compile(r"[0-9a-f]{32}")
#: The message a test is skipped with when ffmpeg or ffprobe is missing (spec 9).
FFMPEG_MISSING = "ffmpeg not found: media tests not run"


def ffmpeg_path() -> str | None:
    """`ffmpeg` on the PATH (the sandbox's is `/usr/bin/ffmpeg`), else None."""
    return shutil.which("ffmpeg")


def ffprobe_path() -> str | None:
    return shutil.which("ffprobe")


def have_media_tools() -> bool:
    """Whether both ffmpeg and ffprobe are on the PATH."""
    return ffmpeg_path() is not None and ffprobe_path() is not None


def _run(tool: str, args: list[str], cwd: Path | None = None) -> bytes:
    """Run `tool` (ffmpeg or ffprobe) quietly; its stdout. Raises with stderr on a failure."""
    path = shutil.which(tool)
    if path is None:
        raise FileNotFoundError(f"{tool} is not on the PATH")
    quiet = ["-hide_banner", "-loglevel", "error"]
    if tool == "ffmpeg":
        quiet += ["-nostdin", "-y"]
    done = subprocess.run(  # the system's ffmpeg/ffprobe, fixed arguments
        [path, *quiet, *args], cwd=cwd, capture_output=True, check=False
    )
    if done.returncode != 0:
        command = " ".join([tool, *args])
        raise RuntimeError(f"{command} failed: {done.stderr.decode(errors='replace').strip()}")
    return done.stdout


def ffmpeg(args: list[str], cwd: Path | None = None) -> bytes:
    return _run("ffmpeg", args, cwd)


_FRAGMENTED = ["-movflags", "frag_keyframe+empty_moov+default_base_moof"]
_FRAGMENTED += ["-frag_duration", "1000000", "-f", "mp4"]


@dataclass(frozen=True)
class HlsFixture:
    """One ffmpeg HLS rendition: its media playlist as ffmpeg wrote it, the segment files in
    order, for fMP4 the init file, and `joined` — the init (fMP4) and every segment in one file:
    the stream a client that downloads the playlist in order holds."""

    folder: Path
    playlist: str
    segments: tuple[Path, ...]
    init: Path | None
    joined: Path

    @property
    def container(self) -> str:
        return "fmp4" if self.init is not None else "ts"


@dataclass(frozen=True)
class Expected:
    """What a file saved from one media path must decode to (see the module docstring)."""

    #: The media path's name, for the failure messages.
    path: str
    #: The clip (or the served video track) whose decoded pictures the saved file must have,
    #: frame for frame.
    video: Path
    #: The audio track as served — what the writer was given — whose decoded frames the saved
    #: file must have, frame for frame.
    audio: Path
    #: The source clip: its durations are the saved file's, and an AAC `audio` must be its audio
    #: (or its audio after one AAC priming frame).
    source: Path
    #: The video track as served (the joined HLS stream, the DASH or bilibili.tv video file):
    #: its start next to `audio`'s is the A/V offset the saved file keeps.
    served_video: Path
    #: ffprobe's `codec_name` of the saved video and audio streams (nothing is re-encoded).
    video_codec: str = "h264"
    audio_codec: str = "aac"


#: The media paths of B.1 (`MediaSet.expected`): `-low` = the lower quality's clip; `dash-hevc`
#: = Bilibili's HEVC track with the AAC one, `-flac` / `-eac3` with the FLAC or Dolby (E-AC-3)
#: track instead.
MEDIA_PATHS = (
    "ts-hls",
    "ts-hls-low",
    "fmp4-hls",
    "fmp4-hls-low",
    "dash",
    "dash-low",
    "dash-hevc",
    "dash-hevc-flac",
    "dash-hevc-eac3",
    "btv-progressive",
    "btv-progressive-low",
    "btv-fragmented",
    "btv-fragmented-low",
)
#: The `codec_tag_string` (sample entry) of the HEVC fixture: ffmpeg's `-tag:v hvc1`.
HEVC_TAG = "hvc1"


@dataclass(frozen=True)
class MediaSet:
    """Everything `build_media` writes (see the module docstring)."""

    root: Path
    src: Path
    low: Path
    hls_ts: HlsFixture
    hls_fmp4: HlsFixture
    hls_ts_low: HlsFixture
    hls_fmp4_low: HlsFixture
    dash_video: Path
    dash_video_low: Path
    dash_audio: Path
    dash_video_encrypted: Path
    dash_video_hevc: Path
    dash_audio_flac: Path
    dash_audio_eac3: Path
    progressive_video: Path
    progressive_video_low: Path
    progressive_audio: Path
    cover: Path
    cover_png: Path
    cover_webp: Path

    def read(self, path: Path) -> bytes:
        return path.read_bytes()

    def expected(self, media_path: str) -> Expected:
        """What a file saved from `media_path` (one of `MEDIA_PATHS`) must decode to: the
        Dailymotion HLS paths (TS segments; fMP4 init + segments), Bilibili's DASH m4s pair and
        bilibili.tv's progressive or fragmented MP4 pair, at the source's quality or the lower
        one (`-low`, the 160x90 clip); Bilibili's HEVC track with its AAC, FLAC or E-AC-3 one
        (`dash-hevc`, `dash-hevc-flac`, `dash-hevc-eac3`)."""
        if media_path not in MEDIA_PATHS:
            raise ValueError(f"no media path {media_path!r}: one of {MEDIA_PATHS}")
        if media_path.startswith("dash-hevc"):
            codec = media_path.removeprefix("dash-hevc").removeprefix("-") or "aac"
            audio = {
                "aac": self.dash_audio,
                "flac": self.dash_audio_flac,
                "eac3": self.dash_audio_eac3,
            }[codec]
            hevc = self.dash_video_hevc
            return Expected(media_path, hevc, audio, self.src, hevc, "hevc", codec)
        low = media_path.endswith("-low")
        video = self.low if low else self.src
        hls_ts, hls_fmp4 = (
            (self.hls_ts_low, self.hls_fmp4_low) if low else (self.hls_ts, self.hls_fmp4)
        )
        dash_video = self.dash_video_low if low else self.dash_video
        progressive_video = self.progressive_video_low if low else self.progressive_video
        served_video, audio = {
            "ts-hls": (hls_ts.joined, hls_ts.joined),
            "fmp4-hls": (hls_fmp4.joined, hls_fmp4.joined),
            "dash": (dash_video, self.dash_audio),
            "btv-progressive": (progressive_video, self.progressive_audio),
            "btv-fragmented": (dash_video, self.dash_audio),
        }[media_path.removesuffix("-low")]
        return Expected(media_path, video, audio, self.src, served_video)


def make_source_clip(folder: Path) -> Path:
    """Spec 9's `makeSourceClip`: `src.mp4`, 6 s, 320x180 at 25 fps + 48 kHz sine, H.264 + AAC."""
    out = folder / "src.mp4"
    ffmpeg(
        [
            *("-f", "lavfi", "-i", f"testsrc=size={SOURCE_WIDTH}x{SOURCE_HEIGHT}:rate=25"),
            *("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"),
            *("-t", str(SOURCE_SECONDS), "-c:v", "libx264", "-preset", "ultrafast"),
            *("-pix_fmt", "yuv420p", "-g", "25", "-c:a", "aac", "-b:a", "64k", "-shortest"),
            str(out),
        ]
    )
    return out


def make_low_clip(src: Path, folder: Path) -> Path:
    """`low.mp4`: the source scaled to 160x90 (video re-encoded with the same settings, audio
    copied, so its audio decodes exactly like the source's)."""
    out = folder / "low.mp4"
    ffmpeg(
        [
            *("-i", str(src), "-map", "0", "-vf", f"scale={LOW_WIDTH}:{LOW_HEIGHT}"),
            *("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "25"),
            *("-c:a", "copy", str(out)),
        ]
    )
    return out


def make_hls(src: Path, folder: Path, *, fmp4: bool) -> HlsFixture:
    """Spec 9's `makeHlsTs` / `makeHlsFmp4`: ffmpeg's own VOD playlist and 2-second segments."""
    folder.mkdir(parents=True, exist_ok=True)
    args = ["-i", str(src), "-c", "copy", "-f", "hls", "-hls_time", "2"]
    args += ["-hls_playlist_type", "vod"]
    if fmp4:
        args += ["-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4"]
        args += ["-hls_segment_filename", "seg%03d.m4s"]
    else:
        args += ["-hls_segment_filename", "seg%03d.ts"]
    args.append("media.m3u8")
    ffmpeg(args, cwd=folder)
    playlist = (folder / "media.m3u8").read_text(encoding="utf-8")
    names = [line for line in playlist.splitlines() if line and not line.startswith("#")]
    segments = tuple(folder / name for name in names)
    if not segments or not all(path.is_file() for path in segments):
        raise RuntimeError(f"ffmpeg wrote no usable HLS in {folder}: {playlist!r}")
    init = folder / "init.mp4" if fmp4 else None
    joined = folder / ("joined.mp4" if fmp4 else "joined.ts")
    parts = [*([init] if init is not None else []), *segments]
    joined.write_bytes(b"".join(path.read_bytes() for path in parts))
    return HlsFixture(folder, playlist, segments, init, joined)


def make_dash_track(src: Path, out: Path, *, kind: str) -> Path:
    """Spec 9's `makeDash`: one track of `src` as a fragmented MP4 (Bilibili's m4s layout)."""
    drop = "-an" if kind == "video" else "-vn"
    codec = "-c:v" if kind == "video" else "-c:a"
    ffmpeg(["-i", str(src), drop, codec, "copy", *_FRAGMENTED, str(out)])
    return out


def make_hevc_track(src: Path, out: Path) -> Path:
    """`src`'s pictures encoded as HEVC by libx265 (GOP 25 like the H.264 clip; x265's default
    B-frames, so the track carries composition offsets) with an `hvc1` sample entry (parameter
    sets in its `hvcC`), as one fragmented track — Bilibili's HEVC m4s."""
    x265 = "keyint=25:min-keyint=25:log-level=error"
    args = ["-i", str(src), "-an", "-c:v", "libx265", "-preset", "ultrafast"]
    args += ["-x265-params", x265, "-pix_fmt", "yuv420p", "-tag:v", HEVC_TAG]
    ffmpeg([*args, *_FRAGMENTED, str(out)])
    return out


def make_audio_track(src: Path, out: Path, *, codec: str) -> Path:
    """`src`'s sound encoded as `codec` (`flac`, or `eac3` at 192 kb/s — Dolby's E-AC-3), as one
    fragmented track — Bilibili's `dash.flac.audio` / `dash.dolby.audio[]` m4s. ffmpeg cannot
    write E-AC-3's `dec3` before it has parsed a packet: `delay_moov` writes the `moov` then."""
    bitrate = ["-b:a", "192k"] if codec == "eac3" else []
    flags = ["-movflags", "frag_keyframe+empty_moov+default_base_moof+delay_moov"]
    flags += ["-frag_duration", "1000000", "-f", "mp4"]
    ffmpeg(["-i", str(src), "-vn", "-c:a", codec, *bitrate, *flags, str(out)])
    return out


def make_progressive_track(src: Path, out: Path, *, kind: str) -> Path:
    """One track of `src` as a NON-fragmented MP4, ffmpeg's default layout (`moov` after
    `mdat`): what bilibili.tv serves by default (addendum A.5)."""
    drop = "-an" if kind == "video" else "-vn"
    codec = "-c:v" if kind == "video" else "-c:a"
    ffmpeg(["-i", str(src), drop, codec, "copy", "-f", "mp4", str(out)])
    return out


def make_cover(out: Path, size: tuple[int, int] = COVER_JPEG_SIZE, color: str = "0x3366cc") -> Path:
    """A one-colour still image of `size`; ffmpeg picks the format from the name (`.jpg` JPEG,
    `.png` PNG, `.webp` WebP through libwebp)."""
    source = f"color=c={color}:s={size[0]}x{size[1]}"
    codec = ["-c:v", "libwebp"] if out.suffix == ".webp" else []
    ffmpeg(["-f", "lavfi", "-i", source, "-frames:v", "1", *codec, str(out)])
    return out


def build_media(root: Path) -> MediaSet:
    """Build every fixture under `root` (see the module docstring); raises when ffmpeg fails."""
    root.mkdir(parents=True, exist_ok=True)
    src = make_source_clip(root)
    low = make_low_clip(src, root)
    hls_ts = make_hls(src, root / "hls-ts", fmp4=False)
    hls_fmp4 = make_hls(src, root / "hls-fmp4", fmp4=True)
    dash = root / "dash"
    dash.mkdir(exist_ok=True)
    dash_video = make_dash_track(src, dash / "video.m4s", kind="video")
    dash_video_low = make_dash_track(low, dash / "video-low.m4s", kind="video")
    dash_audio = make_dash_track(src, dash / "audio.m4s", kind="audio")
    encrypted = dash / "video-encrypted.m4s"
    encrypted.write_bytes(encrypted_fragmented(dash_video.read_bytes(), video=True))
    progressive = root / "progressive"
    progressive.mkdir(exist_ok=True)
    return MediaSet(
        root=root,
        src=src,
        low=low,
        hls_ts=hls_ts,
        hls_fmp4=hls_fmp4,
        hls_ts_low=make_hls(low, root / "hls-ts-low", fmp4=False),
        hls_fmp4_low=make_hls(low, root / "hls-fmp4-low", fmp4=True),
        dash_video=dash_video,
        dash_video_low=dash_video_low,
        dash_audio=dash_audio,
        dash_video_encrypted=encrypted,
        dash_video_hevc=make_hevc_track(src, dash / "video-hevc.m4s"),
        dash_audio_flac=make_audio_track(src, dash / "audio-flac.m4s", codec="flac"),
        dash_audio_eac3=make_audio_track(src, dash / "audio-eac3.m4s", codec="eac3"),
        progressive_video=make_progressive_track(src, progressive / "video.mp4", kind="video"),
        progressive_video_low=make_progressive_track(
            low, progressive / "video-low.mp4", kind="video"
        ),
        progressive_audio=make_progressive_track(src, progressive / "audio.mp4", kind="audio"),
        cover=make_cover(root / "cover.jpg"),
        cover_png=make_cover(root / "cover.png", COVER_PNG_SIZE, "0xcc6633"),
        cover_webp=make_cover(root / "cover.webp", COVER_WEBP_SIZE, "0x33cc66"),
    )


# -- verification ------------------------------------------------------------------------------


def ffprobe(path: Path) -> dict[str, Any]:
    """`ffprobe -show_streams -show_format` as JSON: `{"streams": [...], "format": {...}}`."""
    out = _run("ffprobe", ["-print_format", "json", "-show_streams", "-show_format", str(path)])
    probed: dict[str, Any] = json.loads(out)
    return probed


def is_attached_picture(stream: dict[str, Any]) -> bool:
    """Whether a probed stream is an attached picture (a cover: `disposition.attached_pic`)."""
    return int(stream.get("disposition", {}).get("attached_pic", 0)) == 1


def streams_of(probed: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    """The probed audio/video streams of one `codec_type` (`video` / `audio`) — an attached
    picture (a cover, which ffprobe lists as a video stream) is not one of them."""
    return [
        s
        for s in probed.get("streams", [])
        if s.get("codec_type") == kind and not is_attached_picture(s)
    ]


def attached_pictures(probed: dict[str, Any]) -> list[dict[str, Any]]:
    """The probed streams that are attached pictures (the embedded cover, B.2)."""
    return [s for s in probed.get("streams", []) if is_attached_picture(s)]


def title_tag(probed: dict[str, Any]) -> str | None:
    """The `title` tag ffprobe reads from the file (StreamFetch writes it as `©nam`, B.2)."""
    tags = probed.get("format", {}).get("tags", {})
    title = tags.get("title")
    return title if isinstance(title, str) else None


def duration_of(probed: dict[str, Any]) -> float:
    return float(probed["format"]["duration"])


def stream_duration(probed: dict[str, Any], kind: str) -> float:
    """The duration of the one audio/video stream of `kind`."""
    (stream,) = streams_of(probed, kind)
    return float(stream["duration"])


def framemd5(path: Path, stream: str = "v:0") -> list[str]:
    """The hash column of ffmpeg's `framemd5` muxer for one stream of input 0 (`v:0`, `a:0`, or
    an absolute index such as `0`): one MD5 per decoded frame. Two files whose lists are equal
    decode to the same pictures / samples."""
    out = ffmpeg(
        [
            *("-i", str(path), "-map", f"0:{stream}"),
            *("-flags", "+bitexact", "-fflags", "+bitexact", "-f", "framemd5", "-"),
        ]
    ).decode()
    rows = [line for line in out.splitlines() if line and not line.startswith("#")]
    hashes = [row.rsplit(",", 1)[-1].strip() for row in rows]
    return [digest for digest in hashes if _MD5.fullmatch(digest)]


#: `framemd5` of a fixture file (built once per session and never changed): computed once.
fixture_framemd5 = functools.cache(framemd5)


def av_framemd5(path: Path, kind: str, probed: dict[str, Any] | None = None) -> list[str]:
    """`framemd5` of the one audio/video stream of `kind` (`video` / `audio`) of `path`, chosen
    by its index — so a saved file's attached picture is never hashed in its place."""
    (stream,) = streams_of(probed or ffprobe(path), kind)
    return framemd5(path, str(stream["index"]))


def is_progressive(path: Path) -> bool:
    """`moov` before `mdat` among the top-level boxes, and no `moof` (spec 9)."""
    kinds = top_level_types(path.read_bytes())
    if "moof" in kinds or "moov" not in kinds or "mdat" not in kinds:
        return False
    return kinds.index("moov") < kinds.index("mdat")


def video_height(path: Path) -> int:
    """The height of the one video stream of `path` (an attached picture is not one)."""
    (video,) = streams_of(ffprobe(path), "video")
    return int(video["height"])


def assert_primed_or_same(given: list[str], source: list[str], what: str) -> None:
    """`given` (decoded audio frames) is the source's, or the source's after ONE extra first
    frame — the AAC encoder's priming frame (1024 samples) that ffmpeg's segmenter and fragmenter
    keep without the edit list hiding it in `src.mp4` (spec 9's own commands; see
    `extension/tests/helpers/media.js` and `remux.test.js`: `audio.slice(1)` equals the source).
    Anything else — a frame missing, changed or another one added — fails."""
    primed = len(given) == len(source) + 1 and given[1:] == source
    assert given == source or primed, (
        f"{what}: audio frames differ from the source's ({len(given)} frames, the source has "
        f"{len(source)})"
    )


def assert_same_audio(saved: Path, source: Path) -> None:
    """Every decoded audio frame of `saved` is the source's, but for one priming frame first
    (`assert_primed_or_same`)."""
    assert_primed_or_same(av_framemd5(saved, "audio"), fixture_framemd5(source, "a:0"), str(saved))


_HANDLERS = {"video": b"vide", "audio": b"soun"}


def start_edit(path: Path, kind: str) -> tuple[int, int]:
    """`(media_time, timescale)` of the one `kind` track's (`video` / `audio`, told by its
    `hdlr`) first non-empty edit (`moov/trak/edts/elst`; an empty edit, media_time -1, only
    delays): the media time its presentation starts at, in the track's `mdhd` timescale —
    `(0, timescale)` without an edit list."""
    data = path.read_bytes()
    moov, moov_size = child(data, b"moov")
    for trak, size, box in boxes(data, moov + 8, moov + moov_size):
        if box != b"trak":
            continue
        mdia, mdia_size = child(data, b"mdia", trak + 8, trak + size)
        hdlr, _ = child(data, b"hdlr", mdia + 8, mdia + mdia_size)
        if data[hdlr + 16 : hdlr + 20] != _HANDLERS[kind]:
            continue
        mdhd, _ = child(data, b"mdhd", mdia + 8, mdia + mdia_size)
        at = mdhd + (28 if data[mdhd + 8] == 1 else 20)
        timescale = int.from_bytes(data[at : at + 4], "big")
        try:
            edts, edts_size = child(data, b"edts", trak + 8, trak + size)
            elst, _ = child(data, b"elst", edts + 8, edts + edts_size)
        except ValueError:
            return 0, timescale
        width = 8 if data[elst + 8] == 1 else 4
        pos = elst + 16
        for _ in range(int.from_bytes(data[elst + 12 : elst + 16], "big")):
            media_time = int.from_bytes(data[pos + width : pos + 2 * width], "big", signed=True)
            if media_time != -1:
                return media_time, timescale
            pos += 2 * width + 4
        return 0, timescale
    raise ValueError(f"{path.name}: no {kind} track")


def unapplied_start_skip(served: Path) -> int:
    """The samples at the start of a served FRAGMENTED audio track that its edit list tells
    players to skip (E-AC-3's encoder delay: ffmpeg's fragmenter writes `elst` media_time 256)
    and that ffmpeg's demuxer does NOT skip when it decodes the fragmented file (it only shifts
    the timestamps); 0 for a progressive file (ffmpeg applies its edit list) or a track without
    a start edit. A file that carries the served track and its edit, as StreamFetch writes it,
    plays from that sample — ffmpeg, reading it, skips them too (`Skip Samples`). 0 for an
    MPEG-TS stream (no boxes)."""
    try:
        kinds = top_level_types(served.read_bytes())
    except ValueError:  # no ISO BMFF boxes (an MPEG-TS stream): no edit list
        return 0
    if "moof" not in kinds:
        return 0
    media_time, timescale = start_edit(served, "audio")
    if media_time <= 0:
        return 0
    (stream,) = streams_of(ffprobe(served), "audio")
    return round(media_time * int(stream["sample_rate"]) / timescale)


def packet_hashes(path: Path, kind: str) -> list[str]:
    """The MD5 of every coded packet (sample) of the one `kind` stream, in order, as stored —
    nothing decoded: equal lists are the same samples, byte for byte."""
    (stream,) = streams_of(ffprobe(path), kind)
    args = ["-select_streams", str(stream["index"]), "-show_packets"]
    args += ["-show_data_hash", "md5", "-show_entries", "packet=data_hash", "-of", "json"]
    packets = json.loads(_run("ffprobe", [*args, str(path)])).get("packets", [])
    return [str(packet["data_hash"]) for packet in packets]


def decoded_pcm(path: Path, kind: str = "audio") -> bytes:
    """The one audio stream of `path` decoded, as interleaved 32-bit float samples (`f32le`)."""
    (stream,) = streams_of(ffprobe(path), kind)
    return ffmpeg(["-i", str(path), "-map", f"0:{stream['index']}", "-f", "f32le", "-"])


def assert_played_from_start_edit(saved: Path, served: Path, skip: int, where: str) -> None:
    """`saved` carries the served fragmented audio track whose edit list starts its
    presentation `skip` samples in (`unapplied_start_skip`): every coded sample is the served
    one, byte for byte, and the decoded sound is the served track's from sample `skip` on —
    what a player plays from either file, exactly."""
    saved_packets, served_packets = packet_hashes(saved, "audio"), packet_hashes(served, "audio")
    assert saved_packets == served_packets, (
        f"{where}: audio samples differ from the served {served.name}'s ({len(saved_packets)} "
        f"samples, {len(served_packets)} served)"
    )
    (stream,) = streams_of(ffprobe(served), "audio")
    played = decoded_pcm(served)[skip * 4 * int(stream["channels"]) :]
    assert decoded_pcm(saved) == played, (
        f"{where}: the audio does not play as the served {served.name} does from its edit list's "
        f"start ({skip} samples in)"
    )


def stream_start(probed: dict[str, Any], kind: str) -> float:
    """The `start_time` ffprobe reads for the one audio/video stream of `kind`."""
    (stream,) = streams_of(probed, kind)
    return float(stream["start_time"])


def assert_av_offset(saved: Path, probed: dict[str, Any], expected: Expected, skip: int) -> None:
    """The saved file's video starts as far from its audio as the served video track's from
    the served audio track's — the sync a player keeps (B.1: complete, with audio — in sync).
    A served audio track whose start edit ffmpeg does not apply (`skip` samples, see
    `unapplied_start_skip`) starts, as players present it, `skip` samples later than ffmpeg
    reads it."""
    served_audio = ffprobe(expected.audio)
    (stream,) = streams_of(served_audio, "audio")
    audio_start = stream_start(served_audio, "audio") + skip / int(stream["sample_rate"])
    served = stream_start(ffprobe(expected.served_video), "video") - audio_start
    offset = stream_start(probed, "video") - stream_start(probed, "audio")
    assert abs(offset - served) <= SYNC_TOLERANCE_S, (
        f"{saved.name} ({expected.path}): the video starts {offset * 1000:+.1f} ms from the "
        f"audio, the served tracks {served * 1000:+.1f} ms"
    )


def assert_saved_media(saved: Path, expected: Expected) -> dict[str, Any]:
    """The whole audio/video verification of a file StreamFetch saved from one media path
    (spec 9 and B.1); the file's ffprobe answer, for further checks:

    - one video stream and one audio stream of the path's codecs (H.264 and AAC, or HEVC and
      AAC / FLAC / E-AC-3); the only other stream allowed is ONE attached picture (the embedded
      cover, B.2 — checked by `assert_cover`);
    - the file's duration and each stream's within `DURATION_TOLERANCE_S` of the source's;
    - every decoded video frame equal to the clip's or the served track's (framemd5);
    - every decoded audio frame equal to the writer's input (the track as served); an AAC input
      is the source's audio but for one AAC priming frame (`assert_primed_or_same`); a served
      fragmented track whose edit list starts its presentation later (E-AC-3's encoder delay) is
      compared as players present it (`assert_played_from_start_edit`);
    - the A/V offset (video start minus audio start) the served tracks have, within
      `SYNC_TOLERANCE_S` — framemd5 is blind to timestamps (`assert_av_offset`);
    - a progressive layout (`moov` before `mdat`, no `moof`)."""
    probed, source = ffprobe(saved), ffprobe(expected.source)
    where = f"{saved.name} ({expected.path})"
    videos, audios = streams_of(probed, "video"), streams_of(probed, "audio")
    codecs = [s.get("codec_name") for s in videos], [s.get("codec_name") for s in audios]
    assert codecs[0] == [expected.video_codec], f"{where}: video {videos}"
    assert codecs[1] == [expected.audio_codec], f"{where}: audio {audios}"
    others = [s for s in probed["streams"] if s not in videos and s not in audios]
    assert len(others) <= 1 and all(is_attached_picture(s) for s in others), (
        f"{where}: unexpected streams {others}"
    )
    for got, want, what in (
        (duration_of(probed), duration_of(source), "duration"),
        (stream_duration(probed, "video"), stream_duration(source, "video"), "video duration"),
        (stream_duration(probed, "audio"), stream_duration(source, "audio"), "audio duration"),
    ):
        assert abs(got - want) <= DURATION_TOLERANCE_S, f"{where}: {what} {got} s, source {want} s"
    video = av_framemd5(saved, "video", probed)
    clip = fixture_framemd5(expected.video, "v:0")
    assert video == clip, (
        f"{where}: video frames differ from {expected.video.name}'s ({len(video)} frames, "
        f"{expected.video.name} has {len(clip)})"
    )
    skip = unapplied_start_skip(expected.audio)
    if skip > 0:
        assert_played_from_start_edit(saved, expected.audio, skip, where)
    else:
        audio = av_framemd5(saved, "audio", probed)
        given = fixture_framemd5(expected.audio, "a:0")
        assert audio == given, (
            f"{where}: audio frames differ from the writer's input {expected.audio.name} "
            f"({len(audio)} frames, the input has {len(given)})"
        )
    assert_av_offset(saved, probed, expected, skip)
    if expected.audio_codec == "aac":
        given = fixture_framemd5(expected.audio, "a:0")
        source_audio = fixture_framemd5(expected.source, "a:0")
        assert_primed_or_same(given, source_audio, expected.audio.name)
    assert is_progressive(saved), (
        f"{where}: not progressive ({top_level_types(saved.read_bytes())})"
    )
    return probed


# -- the metadata StreamFetch embeds (B.2) -------------------------------------------------------


@dataclass(frozen=True)
class Mp4Metadata:
    """The `moov/udta/meta/ilst` items of a file: `©nam` (the title) and `covr` (the cover's
    `data` type — 13 JPEG, 14 PNG — and its bytes); None for what the file does not have."""

    title: str | None
    cover_type: int | None
    cover: bytes | None


def _data_item(data: bytes, start: int, end: int) -> tuple[int, bytes] | None:
    """The (type, payload) of the first `data` box between `start` and `end`."""
    for pos, size, kind in boxes(data, start, end):
        if kind == b"data":
            well_known = int.from_bytes(data[pos + 8 : pos + 12], "big") & 0xFFFFFF
            return well_known, data[pos + 16 : pos + size]
    return None


def mp4_metadata(path: Path) -> Mp4Metadata:
    """Read `moov/udta/meta/ilst` the way players do: `meta` as an ISO full box (version and
    flags before its children) or a QuickTime one (children at once); `©nam` as UTF-8 (type 1) or
    UTF-16BE (type 2)."""
    data = path.read_bytes()
    none = Mp4Metadata(None, None, None)
    moov, moov_size = child(data, b"moov")
    try:
        udta, udta_size = child(data, b"udta", moov + 8, moov + moov_size)
        meta, meta_size = child(data, b"meta", udta + 8, udta + udta_size)
    except ValueError:
        return none
    ilst: tuple[int, int] | None = None
    for skip in (12, 8):  # ISO full box first, then QuickTime
        try:
            ilst = child(data, b"ilst", meta + skip, meta + meta_size)
            break
        except ValueError:
            continue
    if ilst is None:
        return none
    title: str | None = None
    cover_type: int | None = None
    cover: bytes | None = None
    for pos, size, kind in boxes(data, ilst[0] + 8, ilst[0] + ilst[1]):
        item = _data_item(data, pos + 8, pos + size)
        if item is None:
            continue
        if kind == b"\xa9nam":
            title = item[1].decode("utf-16-be" if item[0] == 2 else "utf-8")
        elif kind == b"covr":
            cover_type, cover = item
    return Mp4Metadata(title, cover_type, cover)


def image_size(data: bytes) -> tuple[int, int]:
    """(width, height) of a JPEG (its first SOF segment) or a PNG (its IHDR)."""
    if data.startswith(PNG_SIGNATURE):
        return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    if not data.startswith(JPEG_SIGNATURE):
        raise ValueError("neither a JPEG nor a PNG")
    pos = 2
    while pos + 9 <= len(data):
        if data[pos] != 0xFF:
            raise ValueError(f"no JPEG marker at {pos}")
        marker = data[pos + 1]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            height = int.from_bytes(data[pos + 5 : pos + 7], "big")
            return int.from_bytes(data[pos + 7 : pos + 9], "big"), height
        pos += 2 + int.from_bytes(data[pos + 2 : pos + 4], "big")
    raise ValueError("a JPEG without a frame header")


def assert_cover(saved: Path, probed: dict[str, Any], served: Path) -> Mp4Metadata:
    """The file carries the cover StreamFetch fetched from `served` (B.2): ffprobe lists one
    attached picture (`disposition.attached_pic == 1`); the `covr` item holds a JPEG (type 13) or
    a PNG (type 14) — the served bytes as they were for a JPEG or a PNG, a JPEG of the same size
    for anything else (a WebP is converted)."""
    pictures = attached_pictures(probed)
    assert len(pictures) == 1, f"{saved.name}: attached pictures {pictures}"
    meta = mp4_metadata(saved)
    assert meta.cover is not None and meta.cover_type is not None, f"{saved.name}: no covr item"
    original = served.read_bytes()
    if original.startswith((JPEG_SIGNATURE, PNG_SIGNATURE)):
        jpeg = original.startswith(JPEG_SIGNATURE)
        assert meta.cover == original, f"{saved.name}: the cover is not the served {served.name}"
        want = COVR_JPEG if jpeg else COVR_PNG
        assert meta.cover_type == want, f"{saved.name}: covr type {meta.cover_type}, not {want}"
        assert pictures[0].get("codec_name") == ("mjpeg" if jpeg else "png"), pictures
    else:
        assert meta.cover_type == COVR_JPEG, f"{saved.name}: covr type {meta.cover_type}"
        assert meta.cover.startswith(JPEG_SIGNATURE), f"{saved.name}: the cover is no JPEG"
        assert pictures[0].get("codec_name") == "mjpeg", pictures
        (image,) = ffprobe(served)["streams"]
        size = (int(image["width"]), int(image["height"]))
        assert image_size(meta.cover) == size, f"{saved.name}: {image_size(meta.cover)} != {size}"
    return meta


def sample_entry(path: Path, kind: str) -> bytes:
    """The whole sample entry box (`avc1`, `hvc1`, `mp4a`, `fLaC`, `ec-3`, …, with its
    configuration boxes) of the one track of `kind` (`video` / `audio`) in `path`: a file that
    carries a served track as served has the served entry byte for byte (B.1: nothing is
    re-encoded). The kind is told by ffprobe's codec_tag_string of the file's streams."""
    data = path.read_bytes()
    (stream,) = streams_of(ffprobe(path), kind)
    tag = str(stream["codec_tag_string"]).encode("latin-1")
    found = [pos for pos, entry in sample_entries(data) if entry == tag]
    assert len(found) == 1, f"{path.name}: {len(found)} {tag!r} sample entries"
    size = int.from_bytes(data[found[0] : found[0] + 4], "big")
    return data[found[0] : found[0] + size]


def mdat_payload(path: Path) -> bytes:
    """The payload of the file's (first) top-level `mdat`: every audio and video sample's bytes,
    as the writer interleaved them."""
    data = path.read_bytes()
    pos, size = child(data, b"mdat")
    return data[pos + 8 : pos + size]


def assert_no_cover(saved: Path, probed: dict[str, Any]) -> None:
    """The file carries no cover: no attached picture, no `covr` item."""
    assert attached_pictures(probed) == [], f"{saved.name}: {attached_pictures(probed)}"
    assert mp4_metadata(saved).cover is None, f"{saved.name}: a covr item"
