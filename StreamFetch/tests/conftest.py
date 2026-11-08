"""Shared pytest setup of StreamFetch's end-to-end suite.

- Every test is marked `e2e` (spec 10: the suite is `-m e2e`); `pytest` runs them all.
- `media` (session scope): the ffmpeg fixtures of `media_fixtures.build_media`, built ONCE per
  session; without ffmpeg/ffprobe a test that needs them skips with `ffmpeg not found: media tests
  not run`.
- `STREAMFETCH_REQUIRE_TOOLS=1` (CI) turns every skip for a missing tool — ffmpeg/ffprobe, or the
  Chromium a browser scenario's module skips without (`no Chromium at …`) — into a FAILURE naming
  the tool. Unset (or any other value), such a test skips with its reason; never a silent pass.
- The autouse `isolated_environment`: every test gets its own Downloads folder for Chromium's
  defaults (`XDG_DOWNLOAD_DIR`), and Chrome's UI language is pinned to English (`LANGUAGE=en`;
  Chrome on Linux takes its UI language from it) unless the test sets `LANGUAGE=es` itself — so
  nothing depends on the host's locale or writes into the real home. The browser's whole state
  (storage, cooldown, history, cookies, downloads) lives in a profile under the test's `tmp_path`
  (`extension_harness.ExtensionHarness`): no test sees another's.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path
from typing import NoReturn

import pytest

from media_fixtures import FFMPEG_MISSING, MediaSet, build_media, have_media_tools

#: Set to "1" (CI's `streamfetch` job sets it): a test that would skip for a missing tool fails.
REQUIRE_TOOLS_ENV = "STREAMFETCH_REQUIRE_TOOLS"
#: The reason a browser scenario's module skips without a browser starts with this.
NO_CHROMIUM = "no Chromium at "


def tools_required() -> bool:
    """Whether the tools CI installs are mandatory in this run (`STREAMFETCH_REQUIRE_TOOLS=1`)."""
    return os.environ.get(REQUIRE_TOOLS_ENV) == "1"


def missing_tool(tool: str, reason: str) -> NoReturn:
    """Skip with `reason` — or, when the tools are required, fail naming `tool`."""
    if tools_required():
        pytest.fail(f"{tool} is required ({REQUIRE_TOOLS_ENV}=1): {reason}", pytrace=False)
    pytest.skip(reason)


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    """Every test of this suite is an `e2e` test."""
    for item in items:
        item.add_marker(pytest.mark.e2e)


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_setup(item: pytest.Item) -> None:
    """Under `STREAMFETCH_REQUIRE_TOOLS=1`, a browser scenario its module would skip for want of a
    Chromium (`skipif(..., reason="no Chromium at …")`) fails instead, naming the tool — before
    the skip marks are evaluated, which this hook precedes."""
    if not tools_required():
        return
    for mark in item.iter_markers("skipif"):
        condition = mark.args[0] if mark.args else mark.kwargs.get("condition")
        reason = str(mark.kwargs.get("reason", ""))
        if condition is True and reason.startswith(NO_CHROMIUM):
            pytest.fail(f"Chromium is required ({REQUIRE_TOOLS_ENV}=1): {reason}", pytrace=False)


_MEDIA: dict[str, MediaSet | BaseException] = {}


@pytest.fixture(scope="session")
def media(tmp_path_factory: pytest.TempPathFactory) -> MediaSet:
    """The ffmpeg fixtures, built once per session (a build failure is reported once and then
    re-raised for every test that asks)."""
    if not have_media_tools():
        missing_tool("ffmpeg", FFMPEG_MISSING)
    if "media" not in _MEDIA:
        try:
            _MEDIA["media"] = build_media(tmp_path_factory.mktemp("media"))
        except BaseException as error:  # ffmpeg failed: every test that needs it fails the same
            _MEDIA["media"] = error
    built = _MEDIA["media"]
    if isinstance(built, BaseException):
        raise RuntimeError(f"the media fixtures could not be built: {built}") from built
    return built


@pytest.fixture(autouse=True)
def isolated_environment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Chromium's default Downloads folder under this test's `tmp_path`, and Chrome's UI language
    English unless a test sets `LANGUAGE` itself (after this fixture, which runs first)."""
    downloads = tmp_path / "xdg-downloads"
    downloads.mkdir()
    monkeypatch.setenv("XDG_DOWNLOAD_DIR", str(downloads))
    monkeypatch.setenv("LANGUAGE", "en")
    monkeypatch.delenv("LC_ALL", raising=False)
    yield tmp_path
