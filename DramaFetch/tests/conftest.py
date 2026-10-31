"""Shared pytest fixtures: payloads shaped like TikTok's `/api/drama/episode/item_list/` answers."""

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
