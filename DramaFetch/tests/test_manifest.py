"""manifest: safe names, output layout, and the resumable JSON manifest."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from dramafetch.manifest import (
    MANIFEST_FILENAME,
    Manifest,
    ManifestEntry,
    episode_stem,
    manifest_path,
    safe_filename,
    series_dir,
)
from dramafetch.models import DownloadResult, DownloadStatus, Episode, Series


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
        ("com1.txt", "com1.txt_"),
        (
            "The Billionaire's Secret Heiress | Episode 1",
            "The Billionaire's Secret Heiress Episode 1",
        ),
        ("Épisode 1 — «ok»", "Épisode 1 — «ok»"),
    ],
)
def test_safe_filename(raw, expected):
    assert safe_filename(raw) == expected


def test_safe_filename_truncates_then_strips():
    assert safe_filename("a" * 100, max_len=10) == "a" * 10
    # truncation leaves a trailing dot, which is removed afterwards
    assert safe_filename("abcdefgh. x", max_len=9) == "abcdefgh"
    assert len(safe_filename("word " * 50)) <= 80
    assert safe_filename("x" * 10, max_len=0) == "x" * 10  # 0 disables truncation


def test_series_dir_and_episode_stem(tmp_path):
    series = Series(series_id="7699393770256782354", name="Heiress: Part 1/2", episodes=[])
    assert series_dir(tmp_path, series) == tmp_path / "Heiress Part 1 2 [7699393770256782354]"
    unnamed = Series(series_id="42", name=None, episodes=[])
    assert series_dir(tmp_path, unnamed).name == "series-42 [42]"
    assert episode_stem(_episode(1, "Ep | one")) == "E01 - Ep one"
    assert episode_stem(_episode(100, "x")) == "E100 - x"
    assert episode_stem(_episode(7, "t" * 100)) == "E07 - " + "t" * 60
    assert episode_stem(_episode(0, "7699400000000000001")) == "E00 - 7699400000000000001"
    assert manifest_path(tmp_path) == tmp_path / MANIFEST_FILENAME


# --------------------------------------------------------------------------- manifest


def test_roundtrip_relative_paths_and_sorted_json(tmp_path):
    path = tmp_path / MANIFEST_FILENAME
    manifest = Manifest(path, "123", "Name")
    assert manifest.entries == {}
    assert not path.exists()
    video = tmp_path / "E02 - Title.mp4"
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
    assert data["episodes"]["2"]["path"] == "E02 - Title.mp4"  # relative to the series dir
    assert data["episodes"]["1"]["path"] is None
    assert data["episodes"]["1"]["message"] == "boom"
    assert data["episodes"]["1"]["updated_at"].endswith("Z")
    text = path.read_text(encoding="utf-8")
    assert text == json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"

    loaded = Manifest.load(path, "123", None)
    assert loaded.series_name == "Name"
    assert loaded.entries[2] == ManifestEntry(
        2, "id2", "done", "E02 - Title.mp4", "saved", data["episodes"]["2"]["updated_at"]
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
    video = tmp_path / "E01 - Title.mp4"
    video.write_bytes(b"x")
    manifest.record(DownloadResult(_episode(1), DownloadStatus.DONE, video, ""))
    assert manifest.is_done(1)
    video.unlink()
    assert not manifest.is_done(1)
    assert not Manifest.load(path, "123", None).is_done(1)


def test_non_done_statuses_are_never_done(tmp_path):
    manifest = Manifest(tmp_path / MANIFEST_FILENAME, "1", None)
    existing = tmp_path / "E01 - x.mp4"
    existing.write_bytes(b"x")
    manifest.record(DownloadResult(_episode(1), DownloadStatus.SKIPPED_EXISTS, existing, ""))
    assert not manifest.is_done(1)  # only "done" counts


def test_record_replaces_the_previous_entry(tmp_path):
    manifest = Manifest(tmp_path / MANIFEST_FILENAME, "1", None)
    manifest.record(DownloadResult(_episode(3), DownloadStatus.FAILED, None, "first"))
    video = tmp_path / "E03 - Title.mp4"
    video.write_bytes(b"x")
    manifest.record(DownloadResult(_episode(3), DownloadStatus.DONE, video, "second"))
    assert len(manifest.entries) == 1
    assert manifest.entries[3].message == "second"
    assert Manifest.load(tmp_path / MANIFEST_FILENAME, "1", None).is_done(3)


def test_absolute_path_outside_the_series_dir_is_kept(tmp_path):
    other = tmp_path / "elsewhere" / "E01 - x.mp4"
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
    video = first / "E01 - x.mp4"
    video.write_bytes(b"x")
    Manifest(first / MANIFEST_FILENAME, "1", None).record(
        DownloadResult(_episode(1), DownloadStatus.DONE, video, "")
    )
    moved = tmp_path / "b"
    first.rename(moved)
    assert Manifest.load(moved / MANIFEST_FILENAME, "1", None).done_path(1) == moved / "E01 - x.mp4"
