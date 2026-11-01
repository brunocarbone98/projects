"""media: the integrity check of a saved video — mutagen probe, atom walk, audio, duration — the
`(incomplete)` quarantine naming, and the structural DRM check (encrypted tracks) with the deletion
of an encrypted file."""

from __future__ import annotations

import errno
import logging
import os
import random
import sys
from pathlib import Path

import pytest

from dramafetch import media
from dramafetch.downloader import existing_episode_file
from dramafetch.errors import MediaError
from dramafetch.media import (
    DURATION_TOLERANCE_RATIO,
    DURATION_TOLERANCE_S,
    ENCRYPTED_SAMPLE_ENTRIES,
    INCOMPLETE_MARK,
    INCOMPLETE_PREFIX,
    PSSH_BOX,
    RENAME_RETRIES,
    RENAME_RETRY_DELAY_S,
    VideoProbe,
    atom_problem,
    discard,
    discard_note,
    drm_problem,
    drm_problem_in,
    probe_video,
    quarantine,
    quarantine_note,
    verify_video,
)
from dramafetch.models import DRM_MARK, DRM_MESSAGE, DownloadOptions, Episode
from encrypted_mp4 import (
    child,
    encrypted_mp4,
    pssh_box,
    sample_entries,
    with_drm_words_in_mdat,
    with_moov_pssh,
    with_top_level_pssh,
)

FIXTURE = Path(__file__).parent / "fixtures" / "tiny.mp4"
TINY_MP4 = FIXTURE.read_bytes()  # 3 s of 160x120 H.264 + silent AAC; `moov` before `mdat`
# The fixture's top-level atoms: ftyp (32 bytes), moov (3363), free (8), mdat (17128).
MDAT_OFFSET, MDAT_SIZE = 3403, 17128


def _padded(size: int) -> bytes:
    """The fixture plus one `free` atom that pads it to `size` bytes, like the fake CDN's media."""
    box = size - len(TINY_MP4)
    return TINY_MP4 + box.to_bytes(4, "big") + b"free" + b"\0" * (box - 8)


def _atoms(data: bytes, start: int, end: int):
    pos = start
    while pos + 8 <= end:
        size = int.from_bytes(data[pos : pos + 4], "big")
        if size < 8:
            return
        yield pos, size, data[pos + 4 : pos + 8]
        pos += size


def _without_audio_track(data: bytes) -> bytes:
    """The fixture with its audio `trak` (the one whose `hdlr` says `soun`) replaced by a `free`
    atom of the same size: the `moov` keeps its size and the chunk offsets stay right, so the
    result is a valid, playable, video-only MP4 (ffmpeg decodes it) that mutagen reads with an
    empty `info.codec`."""
    moov_pos, moov_size = next((p, s) for p, s, k in _atoms(data, 0, len(data)) if k == b"moov")
    out = bytearray(data)
    replaced = 0
    for pos, size, kind in _atoms(data, moov_pos + 8, moov_pos + moov_size):
        if kind == b"trak" and b"soun" in data[pos : pos + size]:
            out[pos : pos + size] = size.to_bytes(4, "big") + b"free" + bytes(size - 8)
            replaced += 1
    assert replaced == 1
    return bytes(out)


def _write(tmp_path: Path, name: str, data: bytes) -> Path:
    path = tmp_path / name
    path.write_bytes(data)
    return path


# --------------------------------------------------------------------------- probe & verify


def test_the_fixture_probes_as_a_three_second_video_with_audio_and_verifies(tmp_path):
    path = _write(tmp_path, "ep.mp4", TINY_MP4)
    probe = probe_video(path)
    assert abs(probe.duration_s - 3.0) < 0.1
    assert probe.has_audio is True and probe.audio_codec is not None
    assert probe.audio_codec.startswith("mp4a")  # AAC
    assert verify_video(path, 3) is None
    assert verify_video(path, None) is None  # `dramafetch video`: no episode list, no duration
    assert verify_video(path, 0) is None  # a duration TikTok did not give is not judged
    assert verify_video(_write(tmp_path, "padded.mp4", _padded(128 * 1024)), 3) is None
    assert atom_problem(path) is None


def test_bytes_that_are_not_an_mp4_are_reported_as_such(tmp_path):
    cut_inside_the_index = _write(tmp_path, "cut.mp4", TINY_MP4[:2000])  # inside the moov
    with pytest.raises(MediaError) as excinfo:
        probe_video(cut_inside_the_index)
    assert str(excinfo.value).startswith("not a valid MP4 (")
    assert verify_video(cut_inside_the_index, 3) == str(excinfo.value)
    garbage = _write(tmp_path, "garbage.mp4", os.urandom(70_000))
    assert verify_video(garbage, 3) == "not a valid MP4 (not a MP4 file)"
    assert verify_video(_write(tmp_path, "empty.mp4", b""), 3).startswith("not a valid MP4 (")
    assert verify_video(tmp_path / "missing.mp4", 3).startswith("not a valid MP4 (")


def test_a_file_cut_after_its_index_is_a_truncated_mp4(tmp_path):
    """mutagen reads the `moov` at the front and is happy with a file whose `mdat` stops early;
    the atom walk is what catches a transfer that ended before the samples did."""
    cut_in_the_samples = _write(tmp_path, "cut.mp4", TINY_MP4[:12000])
    assert probe_video(cut_in_the_samples).has_audio  # mutagen does not notice
    have = 12000 - MDAT_OFFSET
    assert atom_problem(cut_in_the_samples) == (
        f"truncated MP4 (mdat atom cut short: {have} of {MDAT_SIZE} bytes)"
    )
    assert verify_video(cut_in_the_samples, 3) == atom_problem(cut_in_the_samples)
    # the fake CDN's `truncate_media`: 60 % of a 128 KiB padded file cuts the padding atom
    full = _padded(128 * 1024)
    short = _write(tmp_path, "short.mp4", full[: int(len(full) * 0.6)])
    box = 128 * 1024 - len(TINY_MP4)
    have = int(len(full) * 0.6) - len(TINY_MP4)
    assert verify_video(short, 3) == f"truncated MP4 (free atom cut short: {have} of {box} bytes)"
    # a header cut in half, a 64-bit size, and a size of 0 ("to the end of the file")
    assert atom_problem(_write(tmp_path, "h.mp4", TINY_MP4 + b"\0\0\0\x10fr")) is None  # junk
    big = TINY_MP4 + b"\0\0\0\x01mdat" + (16 + 100).to_bytes(8, "big") + b"\0" * 10
    assert atom_problem(_write(tmp_path, "big.mp4", big)) == (
        "truncated MP4 (mdat atom cut short: 26 of 116 bytes)"
    )
    assert atom_problem(_write(tmp_path, "zero.mp4", TINY_MP4 + b"\0\0\0\0mdat" + b"x")) is None


def test_trailing_junk_and_unknown_atoms_are_not_condemned(tmp_path):
    """Only an atom type a real MP4 is made of is trusted: whatever follows the last known atom
    ends the walk without a verdict, so a CDN that appends bytes does not fail every download."""
    assert atom_problem(_write(tmp_path, "junk.mp4", TINY_MP4 + b"JUNK" * 40)) is None
    fake_header = TINY_MP4 + (1_000_000).to_bytes(4, "big") + b"zzzz" + b"\0" * 16
    assert atom_problem(_write(tmp_path, "unknown.mp4", fake_header)) is None
    assert verify_video(_write(tmp_path, "ok.mp4", TINY_MP4 + b"JUNK" * 40), 3) is None


def test_duration_mismatch_reason_and_tolerance(tmp_path, monkeypatch):
    path = _write(tmp_path, "ep.mp4", TINY_MP4)
    assert verify_video(path, 120) == "duration 3 s, expected 120 s"
    assert verify_video(path, 6) is None  # |3 - 6| = 3 = the 3 s tolerance
    assert verify_video(path, 7) == "duration 3 s, expected 7 s"
    assert (DURATION_TOLERANCE_S, DURATION_TOLERANCE_RATIO) == (3.0, 0.05)
    # 5 % of a long episode is wider than 3 s: 400 s ± 20 s
    monkeypatch.setattr(media, "probe_video", lambda p: VideoProbe(385.0, True, "mp4a.40.2"))
    assert verify_video(path, 400) is None
    monkeypatch.setattr(media, "probe_video", lambda p: VideoProbe(370.4, True, "mp4a.40.2"))
    assert verify_video(path, 400) == "duration 370 s, expected 400 s"
    monkeypatch.setattr(media, "probe_video", lambda p: VideoProbe(0.0, True, "mp4a.40.2"))
    assert verify_video(path, None) == "no playable duration"
    assert INCOMPLETE_PREFIX == "download looks incomplete or wrong: "


def test_a_video_only_mp4_has_no_audio_track(tmp_path):
    path = _write(tmp_path, "silent.mp4", _without_audio_track(TINY_MP4))
    probe = probe_video(path)  # mutagen gives an empty codec instead of raising
    assert probe == VideoProbe(duration_s=probe.duration_s, has_audio=False, audio_codec=None)
    assert abs(probe.duration_s - 3.0) < 0.1
    assert verify_video(path, 3) == "no audio track"


def test_other_containers_are_not_judged(tmp_path):
    for name in ("ep.webm", "ep.mkv", "ep.MKV"):
        assert verify_video(_write(tmp_path, name, b"not even close"), 3) is None
    assert verify_video(_write(tmp_path, "EP.MP4", TINY_MP4), 3) is None  # the suffix check is
    assert verify_video(_write(tmp_path, "ep.m4v", TINY_MP4[:2000]), 3).startswith(  # case-blind
        "not a valid MP4 ("
    )


def test_without_mutagen_only_the_atom_walk_runs_and_a_warning_says_so(
    tmp_path, monkeypatch, caplog
):
    monkeypatch.setitem(sys.modules, "mutagen.mp4", None)  # `from mutagen.mp4 import MP4` fails
    monkeypatch.setattr(media, "_warned_about_mutagen", False)
    with pytest.raises(MediaError, match="mutagen is not installed: pip install mutagen"):
        probe_video(_write(tmp_path, "ep.mp4", TINY_MP4))
    with caplog.at_level(logging.WARNING, logger="dramafetch.media"):
        assert verify_video(tmp_path / "ep.mp4", 120) is None  # cannot be judged: not condemned
        cut = _write(tmp_path, "cut.mp4", TINY_MP4[:12000])
        assert verify_video(cut, 3).startswith("truncated MP4 (mdat atom cut short")
    assert [r.getMessage() for r in caplog.records].count(
        "mutagen is not installed (pip install mutagen): saved videos are checked for "
        "truncation only, not parsed"
    ) == 1  # once per process, not once per episode


# --------------------------------------------------------------------------- quarantine


def test_quarantine_renames_uniquely_and_never_overwrites(tmp_path):
    assert INCOMPLETE_MARK == " (incomplete)"
    first = quarantine(_write(tmp_path, "Heiress - Episode 01.mp4", b"one"))
    assert first == tmp_path / "Heiress - Episode 01 (incomplete).mp4"
    second = quarantine(_write(tmp_path, "Heiress - Episode 01.mp4", b"two"))
    assert second == tmp_path / "Heiress - Episode 01 (incomplete 2).mp4"
    third = quarantine(_write(tmp_path, "Heiress - Episode 01.mp4", b"three"))
    assert third.name == "Heiress - Episode 01 (incomplete 3).mp4"
    assert (first.read_bytes(), second.read_bytes(), third.read_bytes()) == (
        b"one",
        b"two",
        b"three",
    )
    assert not (tmp_path / "Heiress - Episode 01.mp4").exists()
    # a dotted stem keeps its extension right, and the mark goes before it
    assert quarantine(_write(tmp_path, "Dr. Who v1.2 - E03.mp4", b"x")).name == (
        "Dr. Who v1.2 - E03 (incomplete).mp4"
    )


def test_a_quarantined_file_never_counts_as_the_episode(tmp_path):
    """The stem differs, so `existing_episode_file` ignores it and a rerun downloads the episode
    again (the manifest records the failure with its reason)."""
    episode = Episode(number=1, item_id="1", title="Ep 1", series_id="s", series_name="Heiress")
    options = DownloadOptions(out_dir=tmp_path)
    video = _write(tmp_path, "Heiress - Episode 01.mp4", TINY_MP4)
    assert existing_episode_file(tmp_path, episode, options) == video
    quarantine(video)
    assert existing_episode_file(tmp_path, episode, options) is None
    assert sorted(p.name for p in tmp_path.iterdir()) == ["Heiress - Episode 01 (incomplete).mp4"]


def test_quarantine_retries_a_refused_rename_before_giving_up(tmp_path, monkeypatch):
    """A rename the OS refuses (on Windows, a just-written file an antivirus or indexer still
    holds) is tried again RENAME_RETRIES times, RENAME_RETRY_DELAY_S apart, through the injected
    sleep — no test waits for real; refused for good, the last OSError propagates."""
    real_rename = Path.rename
    refusals = {"left": 2}

    def flaky(self, target):
        if refusals["left"]:
            refusals["left"] -= 1
            raise PermissionError(errno.EACCES, "Permission denied", str(self))
        return real_rename(self, target)

    monkeypatch.setattr(Path, "rename", flaky)
    pauses = []
    kept = quarantine(_write(tmp_path, "Heiress - Episode 01.mp4", b"x"), sleep=pauses.append)
    assert kept == tmp_path / "Heiress - Episode 01 (incomplete).mp4" and kept.read_bytes() == b"x"
    assert (RENAME_RETRIES, RENAME_RETRY_DELAY_S) == (2, 0.5) and pauses == [0.5, 0.5]
    refusals["left"], pauses[:] = 10, []
    with pytest.raises(PermissionError):
        quarantine(_write(tmp_path, "Heiress - Episode 02.mp4", b"y"), sleep=pauses.append)
    assert pauses == [RENAME_RETRY_DELAY_S] * RENAME_RETRIES
    assert (tmp_path / "Heiress - Episode 02.mp4").read_bytes() == b"y"


def test_quarantine_note_names_the_kept_file(tmp_path):
    video = _write(tmp_path, "Heiress - Episode 01.mp4", b"x")
    assert quarantine_note(video) == "kept as Heiress - Episode 01 (incomplete).mp4"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["Heiress - Episode 01 (incomplete).mp4"]


def test_quarantine_note_deletes_a_file_the_os_will_not_rename(tmp_path, monkeypatch, caplog):
    """The one case in which a download is deleted: left under the episode's name, the bad file
    would be taken for the episode and the next run would skip it as done. Logged at WARNING."""

    def refuse(path, **_):
        raise PermissionError(errno.EACCES, "Permission denied", str(path))

    monkeypatch.setattr(media, "quarantine", refuse)
    video = _write(tmp_path, "Heiress - Episode 01.mp4", b"x")
    with caplog.at_level(logging.WARNING, logger="dramafetch.media"):
        note = quarantine_note(video)
    assert note == (
        "could not rename Heiress - Episode 01.mp4: Permission denied; deleted, so that it does "
        "not pass for the episode"
    )
    assert not video.exists() and list(tmp_path.iterdir()) == []
    assert "deleted, so that it does not pass for the episode" in caplog.text


def test_quarantine_note_says_what_to_do_when_the_file_cannot_be_deleted_either(
    tmp_path, monkeypatch, caplog
):
    def refuse(path, **_):
        raise PermissionError(errno.EACCES, "Permission denied", str(path))

    def refuse_unlink(self, missing_ok=False):
        raise PermissionError(errno.EACCES, "Permission denied", str(self))

    monkeypatch.setattr(media, "quarantine", refuse)
    monkeypatch.setattr(Path, "unlink", refuse_unlink)
    video = _write(tmp_path, "Heiress - Episode 01.mp4", b"x")
    with caplog.at_level(logging.WARNING, logger="dramafetch.media"):
        note = quarantine_note(video)
    assert note == (
        "could not rename or delete Heiress - Episode 01.mp4: Permission denied — delete it by "
        "hand, or the next run skips the episode as already downloaded"
    )
    assert video.read_bytes() == b"x"  # still there, under the episode's name
    assert "it would pass for the episode" in caplog.text
