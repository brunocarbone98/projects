"""thumbnails: image sniffing, the sidecar next to a video, embedding the cover into a COPY of the
MP4 that replaces it (never in place), extracting it back; every failure leaves the video byte for
byte as it was and no `.embed.part` behind."""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest
from mutagen.mp4 import MP4, MP4Cover

from dramafetch.errors import DramaFetchError, ThumbnailError
from dramafetch.thumbnails import (
    COVER_SUFFIXES,
    EMBED_SUFFIX,
    EMBEDDABLE_SUFFIXES,
    MAX_COVER_BYTES,
    MIN_IMAGE_BYTES,
    cover_sidecar,
    embed_cover,
    extension_for,
    extract_cover,
    format_size,
    has_embedded_cover,
    image_kind,
    image_problem,
    mime_type_for,
)

FIXTURE = Path(__file__).parent / "fixtures" / "tiny.mp4"
TINY_MP4 = FIXTURE.read_bytes()
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + b"j" * 600 + b"\xff\xd9"
PNG = b"\x89PNG\r\n\x1a\n" + b"p" * 600
WEBP = b"RIFF\x00\x10\x00\x00WEBPVP8 " + b"w" * 600
NOT_AN_MP4 = b"\x00\x00\x00\x18ftypmp42" + b"junk" * 2000  # the right first box, nothing behind it
NAME = "Heiress - Episode 01.mp4"


def _video(tmp_path: Path, name: str = NAME) -> Path:
    path = tmp_path / name
    shutil.copy(FIXTURE, path)
    return path


def _names(directory: Path) -> list[str]:
    return sorted(p.name for p in directory.iterdir())


# --- constants and sniffing ---------------------------------------------------------------------


def test_the_constants_the_engines_and_the_web_rely_on():
    assert COVER_SUFFIXES == (".jpg", ".jpeg", ".png", ".webp")
    assert MAX_COVER_BYTES == 5 * 1024 * 1024
    assert MIN_IMAGE_BYTES == 200
    assert sorted(EMBEDDABLE_SUFFIXES) == [".m4v", ".mov", ".mp4"]
    assert EMBED_SUFFIX == ".embed.part"
    assert issubclass(ThumbnailError, DramaFetchError)
    assert len(TINY_MP4) == 20_531 and TINY_MP4[4:8] == b"ftyp"


@pytest.mark.parametrize(
    ("data", "content_type", "kind"),
    [
        (JPEG, "", "jpeg"),
        (PNG, "", "png"),
        (WEBP, "", "webp"),
        (JPEG, "image/jpeg", "jpeg"),
        (JPEG, "Image/JPEG; charset=binary", "jpeg"),
        (PNG, "application/octet-stream", "png"),  # the type says nothing: the bytes decide
        (JPEG, "text/plain", "jpeg"),  # a wrong type never hides a real image
        (PNG, "image/jpeg", "png"),  # a conflict: the bytes win (what goes into the atom)
        (WEBP, "image/png", "webp"),
        (b"z" * 600, "image/jpg", "jpeg"),  # no known magic: the content type decides ...
        (b"z" * 600, "image/pjpeg", "jpeg"),
        (b"z" * 600, "image/png", "png"),
        (b"z" * 600, "image/webp", "webp"),
        (b"z" * 600, "image/avif", "jpeg"),  # ... and any other image type is taken for a JPEG
        (b"z" * 600, "text/html", None),
        (b"<html>no</html>", "", None),
        (b"", "", None),
    ],
)
def test_image_kind_sniffs_the_bytes_first_then_trusts_the_content_type(data, content_type, kind):
    assert image_kind(data, content_type) == kind


def test_extension_and_mime_type_follow_the_kind():
    assert [extension_for(k) for k in ("jpeg", "png", "webp")] == [".jpg", ".png", ".webp"]
    assert [mime_type_for(k) for k in ("jpeg", "png", "webp")] == [
        "image/jpeg",
        "image/png",
        "image/webp",
    ]
    with pytest.raises(ValueError, match="unknown image kind 'gif'"):
        extension_for("gif")
    with pytest.raises(ValueError, match="unknown image kind 'gif'"):
        mime_type_for("gif")


def test_image_problem_and_format_size():
    assert image_problem(b"<html>no</html>", "text/html") == (
        "15 bytes of text/html instead of an image"
    )
    assert image_problem(b"x" * 199, "image/jpeg; charset=binary") == (
        "199 bytes of image/jpeg instead of an image"
    )
    assert image_problem(b"x" * 600, "text/html") == "text/html instead of an image"
    assert image_problem(b"x" * 600, "") == "an untyped body instead of an image"
    assert format_size(999) == "999 bytes"
    assert format_size(20_531) == "20.0 KiB"
    assert format_size(1536) == "1.5 KiB"
    assert format_size(5 * 1024 * 1024 + 3) == "5.0 MiB"


# --- the sidecar --------------------------------------------------------------------------------


def test_cover_sidecar_precedence_and_absence(tmp_path):
    video = tmp_path / NAME
    assert cover_sidecar(video) is None  # not even the video needs to exist
    video.write_bytes(b"v")
    assert cover_sidecar(video) is None
    (tmp_path / "Heiress - Episode 01.webp").write_bytes(WEBP)
    assert cover_sidecar(video) == tmp_path / "Heiress - Episode 01.webp"
    (tmp_path / "Heiress - Episode 01.png").write_bytes(PNG)
    assert cover_sidecar(video) == tmp_path / "Heiress - Episode 01.png"
    (tmp_path / "Heiress - Episode 01.jpeg").write_bytes(JPEG)
    assert cover_sidecar(video) == tmp_path / "Heiress - Episode 01.jpeg"
    (tmp_path / "Heiress - Episode 01.jpg").write_bytes(JPEG)
    assert cover_sidecar(video) == tmp_path / "Heiress - Episode 01.jpg"
    (tmp_path / "Heiress - Episode 01.jpg.part").write_bytes(b"")
    assert cover_sidecar(video) == tmp_path / "Heiress - Episode 01.jpg"  # a .part never counts
    assert cover_sidecar(Path()) is None  # no name at all
    # a directory named like a cover is not a cover
    (tmp_path / "Other - Episode 01.jpg").mkdir()
    assert cover_sidecar(tmp_path / "Other - Episode 01.mp4") is None


# --- embedding ----------------------------------------------------------------------------------


def test_embed_a_jpeg_then_extract_it_equal(tmp_path):
    video = _video(tmp_path)
    assert extract_cover(video) is None and not has_embedded_cover(video)
    embed_cover(video, JPEG)
    assert extract_cover(video) == (JPEG, "image/jpeg")
    assert has_embedded_cover(video)
    assert _names(tmp_path) == [NAME]  # no .embed.part, no sidecar
    tagged = MP4(video)
    assert abs(tagged.info.length - 3.0) < 0.2  # still the 3-second video
    assert tagged.tags["©too"] == ["Lavf60.16.100"]  # the fixture's own tag survived
    assert tagged.tags["covr"][0].imageformat == MP4Cover.FORMAT_JPEG


def test_embed_a_png_and_replace_an_earlier_cover(tmp_path):
    video = _video(tmp_path)
    embed_cover(video, JPEG)
    embed_cover(video, PNG)
    assert extract_cover(video) == (PNG, "image/png")
    assert MP4(video).tags["covr"] == [MP4Cover(PNG, imageformat=MP4Cover.FORMAT_PNG)]
    assert _names(tmp_path) == [NAME]


@pytest.mark.parametrize("suffix", [".mp4", ".m4v", ".mov", ".MP4"])
def test_every_mp4_family_suffix_is_embeddable(tmp_path, suffix):
    video = _video(tmp_path, f"ep{suffix}")
    embed_cover(video, JPEG)
    assert extract_cover(video) == (JPEG, "image/jpeg")


def test_embed_goes_through_a_copy_that_replaces_the_video_atomically(tmp_path, monkeypatch):
    video = _video(tmp_path)
    replaced: list[tuple[str, str]] = []
    original = Path.replace

    def recording(self: Path, target: Path) -> Path:
        assert self.read_bytes() != TINY_MP4 and target.read_bytes() == TINY_MP4  # untouched so far
        assert self.parent == target.parent  # same directory: an atomic rename
        replaced.append((self.name, target.name))
        return original(self, target)

    monkeypatch.setattr(Path, "replace", recording)
    embed_cover(video, JPEG)
    assert replaced == [(f"{NAME}{EMBED_SUFFIX}", NAME)]
    assert extract_cover(video) == (JPEG, "image/jpeg")


@pytest.mark.parametrize(
    ("image", "message"),
    [
        (WEBP, "webp cannot be embedded"),
        (b"<html>denied</html>" * 50, "not a JPEG or PNG image"),
        (b"", "not a JPEG or PNG image"),
        (
            b"\xff\xd8\xff" + b"\0" * MAX_COVER_BYTES,
            "5,242,883 bytes is above the 5 MiB cover limit",
        ),
    ],
)
def test_images_that_cannot_go_into_a_covr_atom_are_refused_and_the_video_untouched(
    tmp_path, image, message
):
    video = _video(tmp_path)
    with pytest.raises(ThumbnailError, match=message):
        embed_cover(video, image)
    assert video.read_bytes() == TINY_MP4
    assert _names(tmp_path) == [NAME]


def test_non_mp4_bytes_are_refused_and_the_file_left_byte_for_byte(tmp_path):
    video = tmp_path / NAME
    video.write_bytes(NOT_AN_MP4)
    with pytest.raises(ThumbnailError) as info:
        embed_cover(video, JPEG)
    assert str(info.value).startswith(
        f"could not write the cover into {NAME} (MP4StreamInfoError: "
    )
    assert video.read_bytes() == NOT_AN_MP4
    assert _names(tmp_path) == [NAME]
    assert extract_cover(video) is None


@pytest.mark.parametrize("name", ["ep.mkv", "ep.webm", "ep", "ep.jpg", "ep.mp4.part"])
def test_other_containers_are_refused_without_being_read(tmp_path, name):
    with pytest.raises(ThumbnailError, match="is not an MP4 container"):
        embed_cover(tmp_path / name, JPEG)  # the file does not even exist
    assert list(tmp_path.iterdir()) == []


def test_a_missing_video_is_a_thumbnail_error_not_a_crash(tmp_path):
    with pytest.raises(ThumbnailError, match=r"could not write the cover into gone\.mp4 \("):
        embed_cover(tmp_path / "gone.mp4", JPEG)
    assert list(tmp_path.iterdir()) == []


def test_a_mutagen_failure_leaves_the_original_intact_and_no_temp_file(tmp_path, monkeypatch):
    video = _video(tmp_path)

    def failing_save(self: MP4, *args: object, **kwargs: object) -> None:
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(MP4, "save", failing_save)
    with pytest.raises(ThumbnailError) as info:
        embed_cover(video, JPEG)
    assert str(info.value) == f"could not write the cover into {NAME} (RuntimeError: disk on fire)"
    assert video.read_bytes() == TINY_MP4
    assert _names(tmp_path) == [NAME]


def test_a_keyboard_interrupt_during_the_embed_still_cleans_up(tmp_path, monkeypatch):
    video = _video(tmp_path)

    def interrupted(self: MP4, *args: object, **kwargs: object) -> None:
        raise KeyboardInterrupt

    monkeypatch.setattr(MP4, "save", interrupted)
    with pytest.raises(KeyboardInterrupt):
        embed_cover(video, JPEG)
    assert video.read_bytes() == TINY_MP4
    assert _names(tmp_path) == [NAME]


def test_a_directory_in_the_way_of_the_working_copy_is_a_thumbnail_error(tmp_path):
    """`shutil.copy2` would copy the video INTO a directory named `<name>.embed.part`, and the
    cleanup could not remove it: refused up front, so the engines' `except ThumbnailError` sees it
    (an `IsADirectoryError` escaping here would end the whole run after a successful download)."""
    video = _video(tmp_path)
    in_the_way = tmp_path / f"{NAME}{EMBED_SUFFIX}"
    in_the_way.mkdir()
    with pytest.raises(
        ThumbnailError, match="is a directory in the way of the working copy"
    ) as info:
        embed_cover(video, JPEG)
    assert str(info.value).startswith(in_the_way.name)
    assert video.read_bytes() == TINY_MP4
    assert list(in_the_way.iterdir()) == []  # no stray copy of the video inside it
    assert _names(tmp_path) == [NAME, in_the_way.name]


def test_a_cleanup_that_fails_never_hides_the_real_error(tmp_path, monkeypatch):
    """When the copy cannot be deleted after a failed write (Windows: an indexer still holds it),
    the error reported is mutagen's, as a ThumbnailError — never the cleanup's own OSError."""
    video = _video(tmp_path)

    def failing_save(self: MP4, *args: object, **kwargs: object) -> None:
        raise RuntimeError("disk on fire")

    def failing_unlink(self: Path, missing_ok: bool = False) -> None:
        raise PermissionError(32, "The process cannot access the file")

    monkeypatch.setattr(MP4, "save", failing_save)
    monkeypatch.setattr(Path, "unlink", failing_unlink)
    with pytest.raises(ThumbnailError) as info:
        embed_cover(video, JPEG)
    assert str(info.value) == f"could not write the cover into {NAME} (RuntimeError: disk on fire)"
    assert video.read_bytes() == TINY_MP4
    assert _names(tmp_path) == [NAME, f"{NAME}{EMBED_SUFFIX}"]  # the copy stays: nothing more to do


def test_without_mutagen_embedding_says_how_to_install_it_and_extraction_finds_nothing(
    tmp_path, monkeypatch
):
    video = _video(tmp_path)
    embed_cover(video, JPEG)
    monkeypatch.setitem(sys.modules, "mutagen.mp4", None)  # `import mutagen.mp4` now fails
    with pytest.raises(ThumbnailError, match=r"^mutagen is not installed: pip install mutagen$"):
        embed_cover(video, PNG)
    assert extract_cover(video) is None and not has_embedded_cover(video)
    assert _names(tmp_path) == [NAME]
    assert extract_cover(video) is None


# --- extracting ---------------------------------------------------------------------------------


def test_extract_on_the_cover_less_fixture_a_missing_file_junk_and_other_containers_is_none(
    tmp_path,
):
    assert extract_cover(FIXTURE) is None
    assert extract_cover(tmp_path / "missing.mp4") is None
    junk = tmp_path / "junk.mp4"
    junk.write_bytes(NOT_AN_MP4)
    assert extract_cover(junk) is None
    assert extract_cover(tmp_path / "ep.mkv") is None
    assert not has_embedded_cover(tmp_path / "missing.mp4")
    (tmp_path / "dir.mp4").mkdir()
    assert extract_cover(tmp_path / "dir.mp4") is None


def _write_covr(video: Path, *covers: MP4Cover) -> None:
    """Put `covers` into the video's `covr` atom with mutagen directly (what other tools do)."""
    tagged = MP4(video)
    if tagged.tags is None:
        tagged.add_tags()
    tagged.tags["covr"] = list(covers)
    tagged.save()


def test_extract_takes_the_first_cover_and_lets_the_bytes_decide_the_type(tmp_path):
    video = _video(tmp_path)
    # a wrong flag (PNG bytes declared JPEG): the bytes win
    _write_covr(video, MP4Cover(PNG, imageformat=MP4Cover.FORMAT_JPEG), MP4Cover(JPEG))
    assert extract_cover(video) == (PNG, "image/png")
    # bytes without a known magic: the declared format is trusted
    _write_covr(video, MP4Cover(b"z" * 600, imageformat=MP4Cover.FORMAT_PNG))
    assert extract_cover(video) == (b"z" * 600, "image/png")


def test_extract_ignores_covers_it_could_never_have_written(tmp_path):
    video = _video(tmp_path)
    _write_covr(video, MP4Cover(WEBP, imageformat=MP4Cover.FORMAT_JPEG))
    assert extract_cover(video) is None  # a WEBP is not a covr image, whatever the flag says
    _write_covr(video, MP4Cover(b"", imageformat=MP4Cover.FORMAT_JPEG))
    assert extract_cover(video) is None
    _write_covr(video, MP4Cover(b"\xff\xd8\xff" + b"\0" * MAX_COVER_BYTES))
    assert extract_cover(video) is None  # over MAX_COVER_BYTES: the web never serves it
    assert not has_embedded_cover(video)
