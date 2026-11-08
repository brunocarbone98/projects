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
- `dash/` — one fragmented file per track, as Bilibili's m4s: `video.m4s`, `audio.m4s` (spec 9's
  `-movflags frag_keyframe+empty_moov+default_base_moof -frag_duration 1000000`), `video-low.m4s`
  (from `low.mp4`) and `video-encrypted.m4s` (`encrypted_mp4.encrypted_fragmented`: `avc1`
  renamed `encv` and a `pssh` after the `moov`);
- `progressive/` — one NON-fragmented file per track (`-c copy`, ffmpeg's default layout: `mdat`
  before `moov`), as bilibili.tv serves them by default: `video.mp4`, `audio.mp4`,
  `video-low.mp4`;
- `cover.jpg` — a 16x16 JPEG, every fake cover.

Checks: `ffprobe(path)`, `framemd5(path, stream)` (the hash column of ffmpeg's `framemd5` muxer
over the DECODED frames, bit-exact flags — as `extension/tests/helpers/media.js` does),
`is_progressive(path)` (top-level boxes: `moov` before `mdat`, no `moof`) and
`assert_same_media(saved, source)` — the whole verification of a saved file.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from encrypted_mp4 import encrypted_fragmented, top_level_types

#: The duration of the source clip, seconds.
SOURCE_SECONDS = 6
SOURCE_WIDTH, SOURCE_HEIGHT = 320, 180
LOW_WIDTH, LOW_HEIGHT = 160, 90
#: How far a saved file's duration may be from the source's (spec 9: within 0.1 s).
DURATION_TOLERANCE_S = 0.1
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
    order and, for fMP4, the init file."""

    folder: Path
    playlist: str
    segments: tuple[Path, ...]
    init: Path | None

    @property
    def container(self) -> str:
        return "fmp4" if self.init is not None else "ts"


@dataclass(frozen=True)
class MediaSet:
    """Everything `build_media` writes (see the module docstring)."""

    root: Path
    src: Path
    low: Path
    hls_ts: HlsFixture
    hls_fmp4: HlsFixture
    dash_video: Path
    dash_video_low: Path
    dash_audio: Path
    dash_video_encrypted: Path
    progressive_video: Path
    progressive_video_low: Path
    progressive_audio: Path
    cover: Path

    def read(self, path: Path) -> bytes:
        return path.read_bytes()


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
    return HlsFixture(folder, playlist, segments, init)


def make_dash_track(src: Path, out: Path, *, kind: str) -> Path:
    """Spec 9's `makeDash`: one track of `src` as a fragmented MP4 (Bilibili's m4s layout)."""
    drop = "-an" if kind == "video" else "-vn"
    codec = "-c:v" if kind == "video" else "-c:a"
    ffmpeg(["-i", str(src), drop, codec, "copy", *_FRAGMENTED, str(out)])
    return out


def make_progressive_track(src: Path, out: Path, *, kind: str) -> Path:
    """One track of `src` as a NON-fragmented MP4, ffmpeg's default layout (`moov` after
    `mdat`): what bilibili.tv serves by default (addendum A.5)."""
    drop = "-an" if kind == "video" else "-vn"
    codec = "-c:v" if kind == "video" else "-c:a"
    ffmpeg(["-i", str(src), drop, codec, "copy", "-f", "mp4", str(out)])
    return out


def make_cover(out: Path) -> Path:
    """A 16x16 JPEG (every decoder reads it): the image of every fake cover and poster."""
    ffmpeg(["-f", "lavfi", "-i", "color=c=0x3366cc:s=16x16", "-frames:v", "1", str(out)])
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
        dash_video=dash_video,
        dash_video_low=dash_video_low,
        dash_audio=dash_audio,
        dash_video_encrypted=encrypted,
        progressive_video=make_progressive_track(src, progressive / "video.mp4", kind="video"),
        progressive_video_low=make_progressive_track(
            low, progressive / "video-low.mp4", kind="video"
        ),
        progressive_audio=make_progressive_track(src, progressive / "audio.mp4", kind="audio"),
        cover=make_cover(root / "cover.jpg"),
    )


# -- verification ------------------------------------------------------------------------------


def ffprobe(path: Path) -> dict[str, Any]:
    """`ffprobe -show_streams -show_format` as JSON: `{"streams": [...], "format": {...}}`."""
    out = _run("ffprobe", ["-print_format", "json", "-show_streams", "-show_format", str(path)])
    probed: dict[str, Any] = json.loads(out)
    return probed


def streams_of(probed: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    """The probed streams of one `codec_type` (`video` / `audio`)."""
    return [s for s in probed.get("streams", []) if s.get("codec_type") == kind]


def duration_of(probed: dict[str, Any]) -> float:
    return float(probed["format"]["duration"])


def framemd5(path: Path, stream: str = "v:0") -> list[str]:
    """The hash column of ffmpeg's `framemd5` muxer for one stream (`v:0` / `a:0`): one MD5 per
    decoded frame. Two files whose lists are equal decode to the same pictures / samples."""
    out = ffmpeg(
        [
            *("-i", str(path), "-map", f"0:{stream}"),
            *("-flags", "+bitexact", "-fflags", "+bitexact", "-f", "framemd5", "-"),
        ]
    ).decode()
    rows = [line for line in out.splitlines() if line and not line.startswith("#")]
    hashes = [row.rsplit(",", 1)[-1].strip() for row in rows]
    return [digest for digest in hashes if _MD5.fullmatch(digest)]


def is_progressive(path: Path) -> bool:
    """`moov` before `mdat` among the top-level boxes, and no `moof` (spec 9)."""
    kinds = top_level_types(path.read_bytes())
    if "moof" in kinds or "moov" not in kinds or "mdat" not in kinds:
        return False
    return kinds.index("moov") < kinds.index("mdat")


def video_height(path: Path) -> int:
    """The height of the one video stream of `path`."""
    (video,) = streams_of(ffprobe(path), "video")
    return int(video["height"])


def assert_same_audio(saved: Path, source: Path) -> None:
    """Every decoded audio frame of `saved` equals the source's (framemd5) — allowing ONE extra
    frame first: the AAC encoder's priming frame (1024 samples). `src.mp4` hides it with an edit
    list; the HLS segments and DASH tracks ffmpeg cuts from it (spec 9's own commands) carry it
    with none, so a file remuxed from them decodes it too (as `extension/tests/remux.test.js`
    accepts: `audio.slice(1)` equals the source). Anything else — a frame missing, changed or
    another one added — fails."""
    got, want = framemd5(saved, "a:0"), framemd5(source, "a:0")
    primed = len(got) == len(want) + 1 and got[1:] == want
    assert got == want or primed, (
        f"{saved}: audio frames differ ({len(got)} frames, the source has {len(want)})"
    )


def assert_same_media(saved: Path, source: Path) -> None:
    """The whole verification of a saved file against the clip it was made from (spec 9): one
    video and one audio stream, the duration within `DURATION_TOLERANCE_S` of the source's, every
    decoded video frame equal (framemd5), every audio frame equal but for the encoder's priming
    frame (`assert_same_audio`), and a progressive layout."""
    probed, expected = ffprobe(saved), ffprobe(source)
    videos, audios = streams_of(probed, "video"), streams_of(probed, "audio")
    assert len(videos) == 1 and len(audios) == 1, f"{saved}: streams {probed.get('streams')}"
    assert len(probed["streams"]) == 2, f"{saved}: {len(probed['streams'])} streams"
    gap = abs(duration_of(probed) - duration_of(expected))
    assert gap <= DURATION_TOLERANCE_S, (
        f"{saved}: duration {duration_of(probed)} s, source {duration_of(expected)} s"
    )
    assert framemd5(saved, "v:0") == framemd5(source, "v:0"), f"{saved}: video frames differ"
    assert_same_audio(saved, source)
    assert is_progressive(saved), (
        f"{saved}: not progressive ({top_level_types(saved.read_bytes())})"
    )
