"""manifest: safe names, output layout, and the resumable JSON manifest."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from dramafetch.manifest import (
    MANIFEST_FILENAME,
    MAX_STEM_LEN,
    Manifest,
    ManifestEntry,
    episode_stem,
    manifest_path,
    read_manifest,
    safe_filename,
    series_dir,
    validate_name_format,
)
from dramafetch.downloader import (
    BLOCKED_MESSAGE,
    PAYLOAD_DRM_MESSAGE,
    YtDlpDownloader,
    describe_failure,
    locked_result,
)
from dramafetch.models import (
    DEFAULT_NAME_FORMAT,
    DRM_MARK,
    DRM_MESSAGE,
    DRM_REMEMBERED_MESSAGE,
    DownloadOptions,
    DownloadResult,
    DownloadStatus,
    Episode,
    Series,
)


def _episode(number, title="Title"):
    return Episode(number=number, item_id=f"id{number}", title=title, series_id="123")


# --------------------------------------------------------------------------- names and layout


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("plain", "plain"),
        ('a<b>c:d"e/f\\g|h?i*j', "a b c d e f g h i j"),
        ("tabs\tand\nnewlines  collapsed", "tabs and newlines collapsed"),
        ("trailing dots... ", "trailing dots"),
        ("   ", "untitled"),
        ("", "untitled"),
        ("...", "untitled"),
        ("ctrl\x00\x1fchars\x7f", "ctrlchars"),
        ("CON", "CON_"),
        # Windows reserves a device name followed by any extension too, so the `_` goes on the
        # device-name segment, not at the end of the name.
        ("com1.txt", "com1_.txt"),
        ("Aux. Stories", "Aux_. Stories"),
        ("nul.mp4", "nul_.mp4"),
        ("COM1 .txt", "COM1_.txt"),
        ("CONOUT$", "CONOUT$_"),
        ("console.txt", "console.txt"),  # not a device name
        (
            "The Billionaire's Secret Heiress | Episode 1",
            "The Billionaire's Secret Heiress Episode 1",
        ),
        ("Épisode 1 — «ok»", "Épisode 1 — «ok»"),
    ],
)
def test_safe_filename(raw, expected):
    assert safe_filename(raw) == expected


@pytest.mark.parametrize(
    "raw", ["CON", "con", "com1.txt", "Aux. Stories", "nul.mp4", "LPT9.tar.gz", "CONIN$", "prn."]
)
def test_safe_filename_results_are_not_reserved_on_windows(raw):
    import ntpath

    isreserved = getattr(ntpath, "isreserved", None)  # Python 3.13+: Microsoft's rules
    if isreserved is None:
        pytest.skip("ntpath.isreserved needs Python 3.13")
    assert isreserved(raw)
    assert not isreserved(safe_filename(raw))
    assert not isreserved(series_dir(Path("o"), Series("123", raw, [])).name)


def test_safe_filename_truncates_then_strips():
    assert safe_filename("a" * 100, max_len=10) == "a" * 10
    # truncation leaves a trailing dot, which is removed afterwards
    assert safe_filename("abcdefgh. x", max_len=9) == "abcdefgh"
    assert len(safe_filename("word " * 50)) <= 80
    assert safe_filename("x" * 10, max_len=0) == "x" * 10  # 0 disables truncation


def test_series_dir_and_manifest_path(tmp_path):
    series = Series(series_id="7699393770256782354", name="Heiress: Part 1/2", episodes=[])
    assert series_dir(tmp_path, series) == tmp_path / "Heiress Part 1 2 [7699393770256782354]"
    unnamed = Series(series_id="42", name=None, episodes=[])
    assert series_dir(tmp_path, unnamed).name == "series-42 [42]"
    assert manifest_path(tmp_path) == tmp_path / MANIFEST_FILENAME


# --------------------------------------------------------------------------- episode_stem

NAME = "The Billionaire's Secret Heiress"


def _named(number, title="Title", series_name=NAME, series_id="7699393770256782354"):
    return Episode(
        number=number,
        item_id=f"76994000000000000{number:02d}",
        title=title,
        series_id=series_id,
        series_name=series_name,
    )


def test_default_name_format_is_series_dash_episode_number():
    assert DEFAULT_NAME_FORMAT == "{series} - Episode {number}"
    options = DownloadOptions(series_name=NAME)
    assert episode_stem(_named(1), options) == f"{NAME} - Episode 01"
    assert episode_stem(_named(9), options) == f"{NAME} - Episode 09"
    assert episode_stem(_named(10), options) == f"{NAME} - Episode 10"
    assert episode_stem(_named(100), options) == f"{NAME} - Episode 100"  # no third digit forced
    assert episode_stem(_named(0), options) == f"{NAME} - Episode 00"


def test_series_placeholder_prefers_the_run_name_then_the_episode_then_the_id():
    episode = _named(1, series_name="From the episode")
    assert episode_stem(episode, DownloadOptions(series_name="From the run")).startswith(
        "From the run - "
    )
    assert episode_stem(episode, DownloadOptions()).startswith("From the episode - ")
    anonymous = _named(1, series_name=None)
    assert episode_stem(anonymous, DownloadOptions()) == "series-7699393770256782354 - Episode 01"
    bare_video = _named(0, series_name=None, series_id="")
    assert episode_stem(bare_video, DownloadOptions()) == "video - Episode 00"
    # the series name is made safe and cut to 80 characters before it is used
    options = DownloadOptions(series_name="Heiress: Part 1/2 " + "x" * 100)
    stem = episode_stem(_named(1), options)
    assert stem.startswith("Heiress Part 1 2 xxx")
    assert stem.endswith(" - Episode 01")
    assert len(stem) == 80 + len(" - Episode 01")


@pytest.mark.parametrize(
    ("name_format", "expected"),
    [
        ("{series} - Episode {number}", f"{NAME} - Episode 07"),
        ("{series} - Episode {n} - {title}", f"{NAME} - Episode 7 - Ep seven"),
        ("{n}", "7"),
        ("{number}", "07"),
        ("{id}", "7699400000000000007"),
        ("{title}", "Ep seven"),
        ("E{number} - {title}", "E07 - Ep seven"),
        ("{title} ({id}) [{series}]", f"Ep seven (7699400000000000007) [{NAME}]"),
        ("{number}{number}", "0707"),  # a placeholder may repeat
        ("  {n}  ", "7"),  # surrounding whitespace is stripped like any file name
        ("{n}.", "7"),  # a trailing dot would be a problem on Windows
        ("{n}/{title}", "7 Ep seven"),  # no sub-directories: the slash becomes a space
    ],
)
def test_episode_stem_expands_each_placeholder(name_format, expected):
    episode = _named(7, title="Ep | seven")
    assert episode_stem(episode, DownloadOptions(name_format=name_format)) == expected


def test_episode_stem_title_is_cut_to_60_and_the_whole_stem_to_150():
    options = DownloadOptions(name_format="{number} - {title}")
    assert episode_stem(_named(7, title="t" * 100), options) == "07 - " + "t" * 60
    long_format = "{title} " + "y" * 200
    stem = episode_stem(_named(1, title="short"), DownloadOptions(name_format=long_format))
    assert len(stem) == MAX_STEM_LEN == 150
    assert stem.startswith("short yyy")


def test_episode_stem_never_formats_user_input():
    """A format is user input: no attribute or index access, no str.format at all."""
    hostile = "{series.__class__} {title[0]} {id!r} {number:02d}"
    for piece in hostile.split():
        with pytest.raises(ValueError, match="unknown placeholder"):
            episode_stem(_named(1), DownloadOptions(name_format=piece + " {n}"))
    # a percent sign is plain text here (the yt-dlp template escaping happens downstream)
    assert episode_stem(_named(1), DownloadOptions(name_format="100% {n}")) == "100% 1"


@pytest.mark.parametrize(
    ("name_format", "match"),
    [
        ("{nope}", r"unknown placeholder \{nope\} in name format '\{nope\}': use \{series\}, "),
        ("{series} - {episode}", r"unknown placeholder \{episode\}"),
        ("{number:02d}", r"unknown placeholder \{number:02d\}"),
        ("{Number}", r"unknown placeholder \{Number\}"),  # case matters
        ("{}", r"unknown placeholder \{\}"),
        ("{series} - Episode {number", "unmatched brace"),
        ("{series}} - {n}", "unmatched brace"),
        ("{{n}}", "unmatched brace"),
        ("", "does not tell episodes apart"),
        ("   ", "does not tell episodes apart"),
        ("{series}", "does not tell episodes apart"),
        ("Episode", "does not tell episodes apart"),
    ],
)
def test_unusable_name_formats_are_refused_with_the_allowed_set(name_format, match):
    with pytest.raises(ValueError, match=match) as info:
        validate_name_format(name_format)
    assert "{series}, {number}, {n}, {title}, {id}" in str(info.value) or "tell episodes" in str(
        info.value
    )
    with pytest.raises(ValueError, match=match):
        episode_stem(_named(1), DownloadOptions(name_format=name_format))
    validate_name_format(DEFAULT_NAME_FORMAT)  # the default is fine
    validate_name_format("{title}")  # and so is the bare video default


def test_episode_stem_output_is_safe_on_windows():
    """A device name as the series name, a device name as the title, a trailing dot in the
    format: nothing a format can produce is a reserved Windows name."""
    import ntpath

    isreserved = getattr(ntpath, "isreserved", None)
    con = episode_stem(_named(1), DownloadOptions(series_name="CON"))
    assert con == "CON_ - Episode 01"
    title_only = episode_stem(_named(1, title="aux"), DownloadOptions(name_format="{title}"))
    assert title_only == "aux_"
    dotted = episode_stem(_named(1, title="com1.part"), DownloadOptions(name_format="{title}"))
    assert dotted == "com1_.part"
    trailing = episode_stem(_named(1), DownloadOptions(name_format="{series} - {n}..."))
    assert trailing == f"{NAME} - 1"
    if isreserved is not None:  # Python 3.13+: Microsoft's rules
        for stem in (con, title_only, dotted, trailing):
            assert not isreserved(stem + ".mp4")
            assert not isreserved(stem + ".jpg")


# --------------------------------------------------------------------------- manifest


def test_roundtrip_relative_paths_and_sorted_json(tmp_path):
    path = tmp_path / MANIFEST_FILENAME
    manifest = Manifest(path, "123", "Name")
    assert manifest.entries == {}
    assert not path.exists()
    video = tmp_path / "Title - Episode 02.mp4"
    video.write_bytes(b"x")
    manifest.record(DownloadResult(_episode(2), DownloadStatus.DONE, video, "saved"))
    manifest.record(DownloadResult(_episode(1), DownloadStatus.FAILED, None, "boom"))
    assert path.exists()
    assert not list(tmp_path.glob("*.tmp"))

    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["version"] == 1
    assert data["series_id"] == "123"
    assert data["series_name"] == "Name"
    assert list(data["episodes"]) == ["1", "2"]
    assert data["episodes"]["2"]["status"] == "done"
    assert data["episodes"]["2"]["path"] == "Title - Episode 02.mp4"  # relative to the series dir
    assert data["episodes"]["1"]["path"] is None
    assert data["episodes"]["1"]["message"] == "boom"
    assert data["episodes"]["1"]["updated_at"].endswith("Z")
    text = path.read_text(encoding="utf-8")
    assert text == json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"

    loaded = Manifest.load(path, "123", None)
    assert loaded.series_name == "Name"
    assert loaded.entries[2] == ManifestEntry(
        2, "id2", "done", "Title - Episode 02.mp4", "saved", data["episodes"]["2"]["updated_at"]
    )
    assert loaded.is_done(2)
    assert not loaded.is_done(1)
    assert not loaded.is_done(99)
    assert loaded.done_path(2) == video
    assert loaded.done_path(1) is None


def test_given_series_name_wins_over_the_stored_one(tmp_path):
    path = tmp_path / MANIFEST_FILENAME
    Manifest(path, "1", "Old").save()
    assert Manifest.load(path, "1", "New").series_name == "New"
    assert Manifest.load(path, "1", None).series_name == "Old"


def test_is_done_requires_the_file_to_exist(tmp_path):
    path = tmp_path / MANIFEST_FILENAME
    manifest = Manifest(path, "123", None)
    video = tmp_path / "Title - Episode 01.mp4"
    video.write_bytes(b"x")
    manifest.record(DownloadResult(_episode(1), DownloadStatus.DONE, video, ""))
    assert manifest.is_done(1)
    video.unlink()
    assert not manifest.is_done(1)
    assert not Manifest.load(path, "123", None).is_done(1)


def test_non_done_statuses_are_never_done(tmp_path):
    manifest = Manifest(tmp_path / MANIFEST_FILENAME, "1", None)
    existing = tmp_path / "x - Episode 01.mp4"
    existing.write_bytes(b"x")
    manifest.record(DownloadResult(_episode(1), DownloadStatus.SKIPPED_EXISTS, existing, ""))
    assert not manifest.is_done(1)  # only "done" counts


def test_record_replaces_the_previous_entry(tmp_path):
    manifest = Manifest(tmp_path / MANIFEST_FILENAME, "1", None)
    manifest.record(DownloadResult(_episode(3), DownloadStatus.FAILED, None, "first"))
    video = tmp_path / "Title - Episode 03.mp4"
    video.write_bytes(b"x")
    manifest.record(DownloadResult(_episode(3), DownloadStatus.DONE, video, "second"))
    assert len(manifest.entries) == 1
    assert manifest.entries[3].message == "second"
    assert Manifest.load(tmp_path / MANIFEST_FILENAME, "1", None).is_done(3)


def test_skips_and_dry_runs_never_downgrade_a_done_entry(tmp_path):
    path = tmp_path / MANIFEST_FILENAME
    manifest = Manifest(path, "1", None)
    video = tmp_path / "Title - Episode 01.mp4"
    video.write_bytes(b"x")
    manifest.record(DownloadResult(_episode(1), DownloadStatus.DONE, video, "saved"))
    done_entry = manifest.entries[1]
    for status in (
        DownloadStatus.SKIPPED_EXISTS,
        DownloadStatus.SKIPPED_LOCKED,
        DownloadStatus.DRY_RUN,
    ):
        manifest.record(DownloadResult(_episode(1), status, video, "a later run"))
        assert manifest.entries[1] == done_entry  # untouched, including updated_at
        assert manifest.is_done(1)
    assert Manifest.load(path, "1", None).is_done(1)  # and the file on disk says so too
    # a real attempt does replace it ...
    manifest.record(DownloadResult(_episode(1), DownloadStatus.FAILED, None, "boom"))
    assert manifest.entries[1].status == "failed"
    assert not manifest.is_done(1)
    # ... and so does a skip once the downloaded file is gone (the done entry was stale)
    manifest.record(DownloadResult(_episode(1), DownloadStatus.DONE, video, "saved again"))
    video.unlink()
    manifest.record(DownloadResult(_episode(1), DownloadStatus.DRY_RUN, None, "would download"))
    assert manifest.entries[1].status == "dry-run"


def test_absolute_path_outside_the_series_dir_is_kept(tmp_path):
    other = tmp_path / "elsewhere" / "x - Episode 01.mp4"
    other.parent.mkdir()
    other.write_bytes(b"x")
    manifest = Manifest(tmp_path / "series" / MANIFEST_FILENAME, "1", None)
    manifest.record(DownloadResult(_episode(1), DownloadStatus.DONE, other, ""))
    assert manifest.entries[1].path == str(other)
    assert manifest.is_done(1)
    assert (tmp_path / "series" / MANIFEST_FILENAME).exists()  # save created the directory


def test_missing_file_gives_an_empty_manifest(tmp_path):
    missing = Manifest.load(tmp_path / "nope" / MANIFEST_FILENAME, "1", "N")
    assert missing.entries == {}
    assert missing.series_name == "N"
    assert not (tmp_path / "nope").exists()


def test_corrupt_file_is_kept_as_bak_and_replaced_on_save(tmp_path):
    path = tmp_path / MANIFEST_FILENAME
    path.write_text("{not json", encoding="utf-8")
    manifest = Manifest.load(path, "1", None)
    assert manifest.entries == {}
    backup = tmp_path / (MANIFEST_FILENAME + ".bak")
    assert backup.read_text(encoding="utf-8") == "{not json"
    assert not path.exists()
    manifest.save()
    assert json.loads(path.read_text(encoding="utf-8"))["episodes"] == {}
    assert backup.exists()


@pytest.mark.parametrize(
    "content",
    [
        "[]",
        '{"version": 2, "series_id": "1", "episodes": {}}',
        '{"version": 1, "series_id": "other", "episodes": {}}',
        '{"version": 1, "series_id": "1", "episodes": []}',
        "",
    ],
)
def test_foreign_or_wrong_shape_is_backed_up(tmp_path, content):
    path = tmp_path / MANIFEST_FILENAME
    path.write_text(content, encoding="utf-8")
    assert Manifest.load(path, "1", None).entries == {}
    assert (tmp_path / (MANIFEST_FILENAME + ".bak")).exists()


def test_bad_entries_are_skipped_not_fatal(tmp_path):
    path = tmp_path / MANIFEST_FILENAME
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "series_id": "1",
                "series_name": None,
                "episodes": {
                    "x": {},
                    "2": "junk",
                    "3": {"status": 5},
                    "4": {"status": "failed", "item_id": "i4"},
                },
            }
        ),
        encoding="utf-8",
    )
    manifest = Manifest.load(path, "1", None)
    assert list(manifest.entries) == [4]
    assert manifest.entries[4] == ManifestEntry(4, "i4", "failed", None, "", "")
    assert not (tmp_path / (MANIFEST_FILENAME + ".bak")).exists()


def test_directory_path_is_accepted(tmp_path):
    manifest = Manifest(tmp_path, "1", None)
    assert manifest.path == tmp_path / MANIFEST_FILENAME
    manifest.save()
    assert (tmp_path / MANIFEST_FILENAME).exists()


def test_save_is_atomic(tmp_path, monkeypatch):
    path = tmp_path / MANIFEST_FILENAME
    manifest = Manifest(path, "1", None)
    manifest.save()
    original = path.read_text(encoding="utf-8")

    def boom(self, target):
        raise OSError("disk full")

    monkeypatch.setattr(Path, "replace", boom)
    manifest.entries[1] = ManifestEntry(1, "i", "done", None, "", "")
    with pytest.raises(OSError, match="disk full"):
        manifest.save()
    assert path.read_text(encoding="utf-8") == original


def test_relative_paths_survive_moving_the_folder(tmp_path):
    first = tmp_path / "a"
    first.mkdir()
    video = first / "x - Episode 01.mp4"
    video.write_bytes(b"x")
    Manifest(first / MANIFEST_FILENAME, "1", None).record(
        DownloadResult(_episode(1), DownloadStatus.DONE, video, "")
    )
    moved = tmp_path / "b"
    first.rename(moved)
    assert (
        Manifest.load(moved / MANIFEST_FILENAME, "1", None).done_path(1)
        == moved / "x - Episode 01.mp4"
    )


# --------------------------------------------------------------------------- completeness


WHEN = 1_800_000_000.0  # 2027-01-15T08:00:00Z


def _complete_manifest(tmp_path, numbers=(1, 2)):
    path = tmp_path / MANIFEST_FILENAME
    manifest = Manifest(path, "123", "Name")
    for number in numbers:
        video = tmp_path / f"Name - Episode {number:02d}.mp4"
        video.write_bytes(b"x")
        manifest.record(DownloadResult(_episode(number), DownloadStatus.DONE, video, "saved"))
    manifest.mark_complete(WHEN + 0.75, len(numbers))
    return manifest


def test_mark_complete_is_saved_loaded_and_written_only_while_set(tmp_path):
    path = tmp_path / MANIFEST_FILENAME
    plain = Manifest(path, "123", "Name")
    plain.save()
    assert "complete_at" not in json.loads(path.read_text(encoding="utf-8"))  # optional keys
    manifest = _complete_manifest(tmp_path)
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["complete_at"] == "2027-01-15T08:00:00Z"  # UTC, whole seconds
    assert data["complete_episodes"] == 2
    assert manifest.complete_since() == WHEN
    loaded = Manifest.load(path, "123", None)
    assert (loaded.complete_at, loaded.complete_episodes) == ("2027-01-15T08:00:00Z", 2)
    assert loaded.complete_since() == WHEN
    assert Manifest(path, "123", None).complete_since() is None  # a new manifest knows nothing
    loaded.clear_complete()
    assert "complete_at" not in json.loads(path.read_text(encoding="utf-8"))
    assert Manifest.load(path, "123", None).complete_at is None


@pytest.mark.parametrize(
    ("status", "clears"),
    [
        (DownloadStatus.DONE, True),
        (DownloadStatus.FAILED, True),
        (DownloadStatus.FAILED_RATE_LIMITED, True),
        (DownloadStatus.SKIPPED_EXISTS, False),
        (DownloadStatus.SKIPPED_LOCKED, False),
        (DownloadStatus.DRY_RUN, False),
    ],
)
def test_recording_an_attempt_clears_the_complete_mark_and_a_skip_does_not(
    tmp_path, status, clears
):
    manifest = _complete_manifest(tmp_path)
    path = tmp_path / ("Name - Episode 03.mp4" if status is DownloadStatus.DONE else "none")
    if status is DownloadStatus.DONE:
        path.write_bytes(b"x")
    manifest.record(
        DownloadResult(_episode(3), status, path if status.ok else None, "a new attempt")
    )
    reloaded = Manifest.load(tmp_path / MANIFEST_FILENAME, "123", None)
    if clears:
        assert manifest.complete_at is None and reloaded.complete_at is None
        assert reloaded.complete_episodes is None
    else:
        assert reloaded.complete_since() == WHEN and reloaded.complete_episodes == 2


def test_done_entries_count_what_is_on_disk_and_missing_files_what_is_gone(tmp_path):
    manifest = _complete_manifest(tmp_path, numbers=(1, 2, 4))
    found = tmp_path / "Name - Episode 05.mp4"  # a file a run found already there
    found.write_bytes(b"x")
    manifest.record(DownloadResult(_episode(5), DownloadStatus.SKIPPED_EXISTS, found, "exists"))
    manifest.record(DownloadResult(_episode(6), DownloadStatus.FAILED, None, "boom"))
    manifest.record(DownloadResult(_episode(7), DownloadStatus.SKIPPED_LOCKED, None, "locked"))
    assert manifest.done_entries() == [
        (1, tmp_path / "Name - Episode 01.mp4"),
        (2, tmp_path / "Name - Episode 02.mp4"),
        (4, tmp_path / "Name - Episode 04.mp4"),
        (5, found),
    ]
    assert manifest.missing_files() == []
    (tmp_path / "Name - Episode 02.mp4").unlink()
    found.unlink()
    assert [number for number, _ in manifest.done_entries()] == [1, 4]
    assert manifest.missing_files() == [2, 5]


def test_read_manifest_reads_without_side_effects(tmp_path):
    _complete_manifest(tmp_path)
    manifest = read_manifest(tmp_path, "123")
    assert manifest is not None and manifest.series_name == "Name"
    assert sorted(manifest.entries) == [1, 2] and manifest.complete_episodes == 2
    assert read_manifest(tmp_path, "other") is None  # another series' manifest
    assert read_manifest(tmp_path / "missing", "123") is None
    assert not (tmp_path / "missing").exists()


@pytest.mark.parametrize(
    "content",
    [b"{not json", b"[]", b'{"version": 2, "series_id": "1", "episodes": {}}', b"\xff\xfe\x00"],
)
def test_read_manifest_never_moves_a_corrupt_file(tmp_path, content):
    path = tmp_path / MANIFEST_FILENAME
    path.write_bytes(content)
    assert read_manifest(tmp_path, "1") is None
    assert path.read_bytes() == content  # untouched
    assert not (tmp_path / (MANIFEST_FILENAME + ".bak")).exists()


def test_load_backs_up_a_manifest_that_is_not_utf8(tmp_path):
    path = tmp_path / MANIFEST_FILENAME
    path.write_bytes(b"\xff\xfe\x00 not text")
    assert Manifest.load(path, "1", None).entries == {}  # no UnicodeDecodeError
    assert (tmp_path / (MANIFEST_FILENAME + ".bak")).read_bytes() == b"\xff\xfe\x00 not text"


@pytest.mark.parametrize(
    ("complete_at", "complete_episodes"),
    [
        ("yesterday", 3),
        (12345, 3),
        ("2027-01-15T08:00:00Z", -1),
        ("2027-01-15T08:00:00Z", True),
        ("2027-01-15T08:00:00Z", "3"),
        ("2027-01-15T08:00:00Z", None),
    ],
)
def test_an_odd_complete_mark_is_forgotten_not_a_corrupt_manifest(
    tmp_path, complete_at, complete_episodes
):
    path = tmp_path / MANIFEST_FILENAME
    data = {
        "version": 1,
        "series_id": "1",
        "series_name": "N",
        "episodes": {"1": {"status": "failed", "item_id": "i1"}},
        "complete_at": complete_at,
        "complete_episodes": complete_episodes,
    }
    path.write_text(json.dumps(data), encoding="utf-8")
    manifest = Manifest.load(path, "1", None)
    assert list(manifest.entries) == [1]  # the manifest itself is fine
    assert manifest.complete_at is None and manifest.complete_episodes is None
    assert not (tmp_path / (MANIFEST_FILENAME + ".bak")).exists()
    assert read_manifest(tmp_path, "1").complete_since() is None


# --------------------------------------------------------------------------- build 7: DRM memory


#: yt-dlp's own words for DRM, and what describe_failure stores for them.
YT_DLP_DRM = "ERROR: [TikTok] 7699400000000000007: This video is DRM protected"


def test_drm_protected_needs_a_download_verdict_in_a_failed_unavailable_or_skipped_locked_entry(
    tmp_path,
):
    """A DRM verdict of a DOWNLOAD does not change by retrying: the manifest remembers it in the
    message, and ``drm_protected`` reads it back — from the two statuses a DRM outcome is recorded
    with, and only for a message that starts with ``DRM_MESSAGE`` (an encrypted file, both
    engines; yt-dlp's own "DRM protected") or ``DRM_REMEMBERED_MESSAGE`` (the memory's own skip).
    A payload's DRM flag is not remembered: the payload is read again on every run."""
    manifest = Manifest(tmp_path / MANIFEST_FILENAME, "123", "Show")
    flagged = Episode(9, "id9", "t", "123", lock_hints=("isDrm=True",), drm=True)
    yt_dlp = describe_failure(DownloadStatus.FAILED_UNAVAILABLE, YT_DLP_DRM)
    blocked_text = "HTTP Error 403: Forbidden (DRM protected?)"
    blocked = YtDlpDownloader.classify_error(blocked_text)
    fresh = (
        f"{DRM_MARK} (in a fresh episode list: isFree=false; drmType=widevine): "
        "DramaFetch does not decrypt it"
    )
    cases = {
        1: (DownloadStatus.FAILED_UNAVAILABLE, DRM_MESSAGE, True),  # the download was encrypted
        2: (DownloadStatus.SKIPPED_LOCKED, locked_result(flagged).message, False),  # payload DRM
        3: (DownloadStatus.FAILED_UNAVAILABLE, "no video formats found", False),
        4: (DownloadStatus.SKIPPED_LOCKED, "looks locked: isLocked=True", False),
        5: (DownloadStatus.FAILED, DRM_MESSAGE, False),  # not a status a DRM verdict uses
        6: (DownloadStatus.DONE, DRM_MESSAGE, False),
        7: (DownloadStatus.FAILED_UNAVAILABLE, yt_dlp, True),  # yt-dlp: "DRM protected"
        8: (DownloadStatus.SKIPPED_LOCKED, DRM_REMEMBERED_MESSAGE, True),  # the memory's skip
        9: (DownloadStatus.FAILED_UNAVAILABLE, fresh, False),  # a fresh list's flag: the payload
        10: (DownloadStatus.FAILED_UNAVAILABLE, f"{DRM_MESSAGE} (could not delete E.mp4)", True),
        11: (blocked, describe_failure(blocked, blocked_text), False),  # a refusal, not DRM
        12: (DownloadStatus.SKIPPED_LOCKED, PAYLOAD_DRM_MESSAGE, False),  # payload, no hints
        13: (DownloadStatus.SKIPPED_LOCKED, DRM_MESSAGE, True),
    }
    assert locked_result(flagged).message.startswith(DRM_MARK)  # DRM wording, not a verdict
    assert yt_dlp == f"{DRM_MESSAGE}: {YT_DLP_DRM}"
    assert blocked is DownloadStatus.FAILED_BLOCKED
    assert cases[11][1].startswith(BLOCKED_MESSAGE)
    for number, (status, message, _) in cases.items():
        path = None
        if status is DownloadStatus.DONE:
            path = tmp_path / f"E{number}.mp4"
            path.write_bytes(b"video")
        manifest.record(DownloadResult(_episode(number), status, path, message))
    assert DRM_MESSAGE.startswith(DRM_MARK) and DRM_REMEMBERED_MESSAGE.startswith(DRM_MARK)
    for number, (_, _, expected) in cases.items():
        assert manifest.drm_protected(number) is expected, number
    assert manifest.drm_protected(99) is False  # no entry at all
    # the verdict survives a save and a side-effect-free read
    again = read_manifest(tmp_path, "123")
    assert again is not None
    assert [n for n in cases if again.drm_protected(n)] == [1, 7, 8, 10, 13]
    assert DRM_REMEMBERED_MESSAGE == (
        "protected by DRM (found by an earlier run): DramaFetch does not decrypt it; "
        "--include-locked tries again"
    )


def test_locked_numbers_are_the_skipped_locked_entries_read_only(tmp_path):
    manifest = Manifest(tmp_path / MANIFEST_FILENAME, "123", "Show")
    video = tmp_path / "E1.mp4"
    video.write_bytes(b"video")
    manifest.record(DownloadResult(_episode(1), DownloadStatus.DONE, video, "saved"))
    manifest.record(DownloadResult(_episode(5), DownloadStatus.SKIPPED_LOCKED, None, "locked"))
    manifest.record(DownloadResult(_episode(3), DownloadStatus.SKIPPED_LOCKED, None, DRM_MESSAGE))
    manifest.record(DownloadResult(_episode(4), DownloadStatus.FAILED, None, "boom"))
    before = (tmp_path / MANIFEST_FILENAME).read_text(encoding="utf-8")
    assert manifest.locked_numbers() == [3, 5]
    assert manifest.done_entries() == [(1, video)]
    assert (tmp_path / MANIFEST_FILENAME).read_text(encoding="utf-8") == before  # nothing written
    assert Manifest(tmp_path / "empty.json", "123", None).locked_numbers() == []
