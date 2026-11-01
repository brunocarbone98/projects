"""Shared pytest fixtures: payloads shaped like TikTok's `/api/drama/episode/item_list/` answers,
the autouse state directory that keeps every test (unit or integration) out of ~/.dramafetch, and
`tools` — what a missing tool means: a skip with its reason, or, under `DRAMAFETCH_REQUIRE_TOOLS=1`
(CI), a failure naming the tool."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import NoReturn

import pytest

FIXTURES = Path(__file__).parent / "fixtures"
#: Set to "1" (CI's `dramafetch` job sets it), every test that would skip — or leave a check out —
#: because a tool CI installs is missing (node, a full ffmpeg, Chromium) FAILS instead, naming the
#: tool. Unset (or any other value), nothing changes: such a test skips with its reason. A skip for
#: the environment rather than a tool (no IPv6 loopback, no symlinks, …) stays a skip either way.
REQUIRE_TOOLS_ENV = "DRAMAFETCH_REQUIRE_TOOLS"


def tools_required() -> bool:
    """Whether the tools CI installs are mandatory in this run (``DRAMAFETCH_REQUIRE_TOOLS=1``)."""
    return os.environ.get(REQUIRE_TOOLS_ENV) == "1"


class Tools:
    """The ``tools`` fixture: what a test does about a tool it cannot find."""

    def __init__(self, required: bool) -> None:
        self.required = required

    def missing(self, tool: str, reason: str) -> NoReturn:
        """Skip with ``reason`` — or, when the tools are required, fail naming ``tool``."""
        if self.required:
            pytest.fail(f"{tool} is required ({REQUIRE_TOOLS_ENV}=1): {reason}", pytrace=False)
        pytest.skip(reason)

    def need(self, tool: str, present: bool, reason: str) -> None:
        """A test (or the rest of one) that cannot run without ``tool``: see :meth:`missing`."""
        if not present:
            self.missing(tool, reason)

    def want(self, tool: str, present: bool, reason: str) -> bool:
        """A check that a test leaves out without ``tool``, the rest of the test running anyway:
        ``present`` — and, when the tools are required, a failure naming ``tool`` instead."""
        if not present and self.required:
            pytest.fail(f"{tool} is required ({REQUIRE_TOOLS_ENV}=1): {reason}", pytrace=False)
        return present


@pytest.fixture
def tools() -> Tools:
    """See :class:`Tools` and :data:`REQUIRE_TOOLS_ENV`."""
    return Tools(tools_required())


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_setup(item: pytest.Item) -> None:
    """Under ``DRAMAFETCH_REQUIRE_TOOLS=1``, a browser scenario its module would skip for want of a
    Chromium (``skipif(not CHROMIUM.is_file(), reason="no Chromium at …")``) fails instead, naming
    the tool — before the skip marks are evaluated, which this hook precedes."""
    if not tools_required() or item.get_closest_marker("integration") is None:
        return
    for mark in item.iter_markers("skipif"):
        condition = mark.args[0] if mark.args else mark.kwargs.get("condition")
        reason = str(mark.kwargs.get("reason", ""))
        if condition is True and reason.startswith("no Chromium at "):
            pytest.fail(f"Chromium is required ({REQUIRE_TOOLS_ENV}=1): {reason}", pytrace=False)


@pytest.fixture
def item_list_pages() -> list[dict[str, object]]:
    """Two consecutive pages of the same series (fixtures/item_list_page{1,2}.json)."""
    return [
        json.loads((FIXTURES / "item_list_page1.json").read_text(encoding="utf-8")),
        json.loads((FIXTURES / "item_list_page2.json").read_text(encoding="utf-8")),
    ]


@pytest.fixture(autouse=True)
def dramafetch_state_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point ``DRAMAFETCH_STATE_DIR`` (the cooldown file's directory, see ``dramafetch.cooldown``)
    at this test's ``tmp_path``: no test — and no CLI subprocess a test starts, since the
    environment is inherited — ever reads or writes ``~/.dramafetch``."""
    monkeypatch.setenv("DRAMAFETCH_STATE_DIR", str(tmp_path))
    return tmp_path
