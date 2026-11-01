"""Shared pytest fixtures: payloads shaped like TikTok's `/api/drama/episode/item_list/` answers,
and the autouse state directory that keeps every test (unit or integration) out of ~/.dramafetch."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"


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
