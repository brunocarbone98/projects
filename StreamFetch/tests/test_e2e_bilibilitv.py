"""Bilibili.tv end to end (addendum A.5): a user video served as PROGRESSIVE files and an episode
served as FRAGMENTED files both download and verify — a fragmented transfer cut short resumes with
`Range` from where it stopped and the file is saved whole; a series link becomes one row per episode
under a group header and downloads in order; the playurl API's geo / login / premium codes fail
the row without any media request, in English and in Spanish; a media URL on a host the extension
has no permission for is never requested and the row and the report name the host; the per-row
quality selector picks what is saved; a quality the session cannot get shows as a disabled
option; covers load lazily — only for rows in view, one at a time, never during a job.

Every saved file passes B.1's proof for its media path (bilibili.tv's progressive or fragmented
MP4 pair; H.264 + AAC, the source's durations, framemd5-equal video, audio equal to the track as
served, progressive) and carries B.2's cover and title.

All aids and episode ids are INVENTED (16-digit aids of the owner's shape, A.7)."""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

import pytest

from e2e_checks import (
    NEEDS_CHROMIUM,
    assert_media_headers,
    assert_range_only_after_cut,
    assert_sequential,
)
from extension_harness import ExtensionHarness, Row
from fake_sites import (
    BTV_AID,
    BTV_EPISODES,
    BTV_SEASON,
    BTV_SEASON_TITLE,
    BTV_TITLES,
    FakeSites,
)
from media_fixtures import (
    LOW_HEIGHT,
    SOURCE_HEIGHT,
    MediaSet,
    assert_cover,
    assert_saved_media,
    title_tag,
    video_height,
)

pytestmark = [NEEDS_CHROMIUM]

VIDEO = "https://www.bilibili.tv/en/video/{}"
GEO, LOGIN, PREMIUM = "4801520000000101", "4801520000000102", "4801520000000103"
UNCOVERED, MISSING = "4801520000000201", "4801520000000202"
#: A user video served as fragmented files whose video transfer is cut short once.
CUT = "4801520000000301"
_PLACEHOLDER = re.compile(r"\$[A-Za-z0-9_@]+\$|\$\d")
#: Scroll the last item row into the middle of the window (the history and the settings are below
#: the table: the page's bottom is not the table's).
LAST_ROW_INTO_VIEW = """() => {
  const rows = document.querySelectorAll('#items-table tbody tr[data-key]');
  rows[rows.length - 1].scrollIntoView({ block: 'center' });
}"""


def _aid_of(row: Row) -> str:
    return row.key.rsplit(":", 1)[-1]


def _btv_media(sites: FakeSites, video_id: str) -> list[str]:
    """`<route> <file>` of the bilibili.tv media requests about one video, in order."""
    return [
        f"{r.route} {r.path.rsplit('/', 1)[-1]}" for r in sites.about(video_id) if r.kind == "media"
    ]


def test_a_user_video_served_as_progressive_files_downloads_and_verifies(
    media: MediaSet, tmp_path: Path
):
    with FakeSites(media) as sites, ExtensionHarness(tmp_path, sites) as ext:
        ext.download_all(VIDEO.format(BTV_AID))
        row = ext.row_of(BTV_AID)
        assert (row.status, row.site, row.title) == (
            "done",
            "Bilibili.tv",
            "Fake Bstation user video",
        )
        assert row.href == f"https://www.bilibili.tv/en/video/{BTV_AID}"
        (name,) = ext.wait_saved(1)
        assert name == f"StreamFetch/Bilibili.tv/Fake Bstation user video [{BTV_AID}].mp4"
        saved = ext.saved_path(name)
        probed = assert_saved_media(saved, media.expected("btv-progressive"))
        assert_cover(saved, probed, media.cover)
        assert title_tag(probed) == BTV_TITLES[BTV_AID]
        assert _btv_media(sites, BTV_AID) == ["btv-video 80.mp4", "btv-audio audio-30280.mp4"]
        assert_media_headers(sites, sites.media_requests())
        playurl = sites.by_route("btv-playurl")
        assert playurl and all(r.query == {"platform": "web", "aid": BTV_AID} for r in playurl)
        assert_sequential(sites.site_requests())


def test_an_episode_served_as_fragmented_files_downloads_and_verifies(
    media: MediaSet, tmp_path: Path
):
    ep_id, title = BTV_EPISODES[1]
    with (
        FakeSites(media, btv_fragmented=frozenset({ep_id})) as sites,
        ExtensionHarness(tmp_path, sites) as ext,
    ):
        ext.download_all(f"https://www.bilibili.tv/es/play/{BTV_SEASON}/{ep_id}?t=12")
        (row,) = ext.rows_of(ep_id)
        assert row.status == "done", row
        (name,) = ext.wait_saved(1)
        folders = (BTV_SEASON_TITLE, f"season {BTV_SEASON}")  # the series title, when known
        assert name in {
            f"StreamFetch/Bilibili.tv/{folder}/{title} [{ep_id}].mp4" for folder in folders
        }
        saved = ext.saved_path(name)
        probed = assert_saved_media(saved, media.expected("btv-fragmented"))
        assert_cover(saved, probed, media.cover)
        assert title in (title_tag(probed) or ""), title_tag(probed)
        assert _btv_media(sites, ep_id) == ["btv-video 80.mp4", "btv-audio audio-30280.mp4"]
        playurl = sites.by_route("btv-playurl")
        assert playurl and all(r.query == {"platform": "web", "ep_id": ep_id} for r in playurl)


def test_a_cut_fragmented_transfer_resumes_with_range_and_the_whole_file_is_saved(
    media: MediaSet, tmp_path: Path
):
    """B.1 "complete": the fragmented video file stops half way (the connection drops after half
    the body); the download asks for the rest of the SAME file with `Range: bytes=<received>-`
    (never from the start, never another quality), then the audio, and the saved file is the
    whole source clip — every frame, the audio as served, the source's durations."""
    with (
        FakeSites(media, btv_fragmented=frozenset({CUT}), btv_cut_once=frozenset({CUT})) as sites,
        ExtensionHarness(tmp_path, sites) as ext,
    ):
        ext.download_all(VIDEO.format(CUT))
        assert ext.row_of(CUT).status == "done", ext.row_of(CUT)
        (name,) = ext.wait_saved(1)
        assert name == f"StreamFetch/Bilibili.tv/Fake Bstation video {CUT} [{CUT}].mp4"
        saved = ext.saved_path(name)
        probed = assert_saved_media(saved, media.expected("btv-fragmented"))
        assert_cover(saved, probed, media.cover)
        assert video_height(saved) == SOURCE_HEIGHT
        btv = sites.media_requests("bilibilitv")
        assert [(r.route, r.path.rsplit("/", 1)[-1], r.cut, r.status) for r in btv] == [
            ("btv-video", "80.mp4", True, 200),
            ("btv-video", "80.mp4", False, 206),
            ("btv-audio", "audio-30280.mp4", False, 200),
        ], btv
        assert assert_range_only_after_cut(btv) == 1
        cut, resumed = btv[0], btv[1]
        assert resumed.range == f"bytes={cut.sent_bytes}-", (resumed.range, cut.sent_bytes)
        assert cut.sent_bytes + resumed.sent_bytes == len(media.dash_video.read_bytes())
        assert resumed.query.get("sign") == cut.query.get("sign")  # the same signed URL
        assert_media_headers(sites, btv)
        assert_sequential(sites.site_requests())
        assert ext.reports() == [] and ext.failed_rows() == []


def test_a_series_link_lists_every_episode_under_a_header_and_downloads_them_in_order(
    media: MediaSet, tmp_path: Path
):
    with FakeSites(media) as sites, ExtensionHarness(tmp_path, sites) as ext:
        ext.analyze(f"https://www.bilibili.tv/en/play/{BTV_SEASON}", min_rows=3)
        (header,) = ext.group_headers()
        assert BTV_SEASON_TITLE in header["text"] and "3 episodes" in header["text"], header
        rows = ext.rows()
        assert [row.title for row in rows] == [title for _, title in BTV_EPISODES]
        assert len(sites.by_route("btv-season-info")) == 1
        assert len(sites.by_route("btv-episodes")) == 1
        assert sites.media_requests() == []
        sites.clear_log()

        ext.download_all()
        assert [row.status for row in ext.rows()] == ["done"] * 3
        expected = [
            f"StreamFetch/Bilibili.tv/{BTV_SEASON_TITLE}/{title} [{ep_id}].mp4"
            for ep_id, title in BTV_EPISODES
        ]
        assert ext.wait_saved(3) == sorted(expected)
        for name, (_, title) in zip(expected, BTV_EPISODES, strict=True):
            probed = assert_saved_media(ext.saved_path(name), media.expected("btv-progressive"))
            assert title in (title_tag(probed) or ""), (name, title_tag(probed))
        downloaded = [r.path.split("/")[2] for r in sites.by_route("btv-video")]
        assert downloaded == [ep_id for ep_id, _ in BTV_EPISODES]  # in order, once each
        assert_sequential(sites.site_requests())
        assert_media_headers(sites, sites.media_requests())


def _holds(message: str, template: str) -> bool:
    """Whether `message` holds every literal piece of one Spanish template."""
    chunks = [c.strip() for c in _PLACEHOLDER.split(template) if len(c.strip()) >= 4]
    return bool(chunks) and all(c in message for c in chunks)


@pytest.mark.parametrize("language", ["en", "es"])
def test_geo_login_and_premium_codes_fail_the_row_without_a_media_request(
    language: str, media: MediaSet, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setenv("LANGUAGE", language)
    with (
        FakeSites(
            media,
            btv_geo=frozenset({GEO}),
            btv_login=frozenset({LOGIN}),
            btv_premium=frozenset({PREMIUM}),
        ) as sites,
        ExtensionHarness(tmp_path, sites) as ext,
    ):
        ext.download_all(f"{VIDEO.format(GEO)}\n{VIDEO.format(LOGIN)}")
        ext.download_all(VIDEO.format(PREMIUM))  # the login stopped the first run
        rows = {aid: ext.row_of(aid) for aid in (GEO, LOGIN, PREMIUM)}
        assert {row.status for row in rows.values()} == {"failed-unavailable"}, rows
        assert sites.media_requests() == []
        assert ext.cooldown() is None  # a login is no refusal of the session
        if language == "en":
            assert "not available in your country" in rows[GEO].message
            for aid in (LOGIN, PREMIUM):
                assert "log in" in rows[aid].message and "premium" in rows[aid].message, rows[aid]
        else:
            es = ext.messages("es")
            # each row its own Spanish text: geo-blocking for GEO, the login text and the
            # login-or-premium hint for LOGIN and PREMIUM — never the other one
            geo, login = es["failure_geo_blocked"], es["failure_login_required"]
            assert _holds(rows[GEO].message, geo), rows[GEO].message
            assert not _holds(rows[GEO].message, login), rows[GEO].message
            for aid in (LOGIN, PREMIUM):
                message = rows[aid].message
                assert _holds(message, login) and _holds(message, es["hint_login_or_premium"])
                assert not _holds(message, geo), message
            for row in rows.values():
                assert "not available" not in row.message and "log in" not in row.message


def test_a_media_url_on_an_uncovered_host_is_never_requested_and_the_host_is_named(
    media: MediaSet, tmp_path: Path
):
    with (
        FakeSites(media, btv_uncovered_host=frozenset({UNCOVERED})) as sites,
        ExtensionHarness(tmp_path, sites) as ext,
    ):
        ext.download_all(VIDEO.format(UNCOVERED))
        row = ext.row_of(UNCOVERED)
        assert row.status.startswith("failed"), row
        assert "localhost" in row.message, row
        assert sites.uncovered_requests() == []
        assert sites.media_requests() == []
        (path,) = ext.wait_reports(1)
        (entry,) = json.loads(path.read_text(encoding="utf-8"))["not_downloaded"]
        assert entry["failure"]["code"] == "host_not_covered"
        assert "localhost" in entry["message_en"]
        assert any(a["host"] == "localhost" and a["requested"] is False for a in entry["attempts"])


def test_the_quality_selector_chooses_what_is_saved(media: MediaSet, tmp_path: Path):
    with FakeSites(media) as sites, ExtensionHarness(tmp_path, sites) as ext:
        ext.analyze(VIDEO.format(BTV_AID))
        row = ext.row_of(BTV_AID)
        labels = [option["text"] for option in row.options]
        assert [label.split(" ")[0] for label in labels] == ["1080p", "720p", "480p"], labels
        assert row.quality.startswith("1080p")  # the policy's choice, pre-selected
        assert "avc" in labels[0] and re.search(r"\d\.\d M(?:B|bit)/s", labels[0]), labels
        chosen = ext.select_quality(BTV_AID, "480p")
        assert ext.row_of(BTV_AID).quality == chosen
        ext.download_all()
        assert ext.row_of(BTV_AID).status == "done"
        (name,) = ext.wait_saved(1)
        saved = ext.saved_path(name)
        assert video_height(saved) == LOW_HEIGHT  # the 480P file (the fake's 160x90 clip)
        assert_saved_media(saved, media.expected("btv-progressive-low"))
        assert _btv_media(sites, BTV_AID) == ["btv-video 32.mp4", "btv-audio audio-30280.mp4"]


def test_a_quality_without_a_url_shows_as_a_disabled_option(media: MediaSet, tmp_path: Path):
    with (
        FakeSites(media, btv_missing_quality=frozenset({MISSING})) as sites,
        ExtensionHarness(tmp_path, sites) as ext,
    ):
        ext.analyze(VIDEO.format(MISSING))
        row = ext.row_of(MISSING)
        disabled = [o for o in row.options if o["disabled"]]
        assert len(disabled) == 1 and "1080P+" in disabled[0]["text"], row.options
        assert "premium" in disabled[0]["text"], disabled  # `1080P+ — premium only`
        selected = [o for o in row.options if o["selected"]]
        assert len(selected) == 1 and not selected[0]["disabled"]
        assert selected[0]["text"].startswith("1080p"), selected
        ext.download_all()
        assert ext.row_of(MISSING).status == "done"
        assert _btv_media(sites, MISSING) == ["btv-video 80.mp4", "btv-audio audio-30280.mp4"]


def test_covers_load_only_in_view_one_at_a_time_and_never_during_a_job(
    media: MediaSet, tmp_path: Path
):
    """The rows' thumbnails (A.4, A.5): none before its row is in view, one request at a time,
    each once, none during a job. `cover: "none"` (B.2): the job itself asks for no cover to
    embed, so every cover request the fake sees is a thumbnail's."""
    aids = [f"48015200000100{n:02d}" for n in range(1, 41)]
    height = 360
    with (
        FakeSites(media, media_delay_s=0.3) as sites,
        ExtensionHarness(tmp_path, sites, viewport={"width": 1280, "height": height}) as ext,
    ):
        ext.update_settings(cover="none")
        ext.page.evaluate("() => window.scrollTo(0, 0)")
        ext.analyze("\n".join(VIDEO.format(aid) for aid in aids), min_rows=len(aids))
        time.sleep(1.5)  # whatever would load has had time to
        rows = ext.rows()
        far = [row for row in rows if row.top > height + 1200]
        assert far, f"the rows never leave the window ({rows[-1].top} px): no lazy loading to test"
        assert not {f"/btv-cover/{_aid_of(row)}.jpg" for row in far} & {
            r.path for r in sites.cover_requests()
        }, "a cover was asked for before its row was in view"

        # the table scrolled into view: its first rows' covers, and only theirs
        ext.page.evaluate("() => document.querySelector('#items-table').scrollIntoView()")
        ext.wait_for(lambda: sites.cover_requests(), 20, "no cover was loaded")
        time.sleep(1.5)  # whatever else would load has had time to
        rows = ext.rows()
        asked = [r.path for r in sites.cover_requests()]
        assert len(asked) == len(set(asked)), "a cover was asked for twice"
        far = [row for row in rows if row.top > height + 1200]
        assert far, "the rows never leave the window: no lazy loading to test"
        assert f"/btv-cover/{_aid_of(rows[0])}.jpg" in asked
        assert not {f"/btv-cover/{_aid_of(row)}.jpg" for row in far} & set(asked)
        assert_sequential(sites.cover_requests())  # one at a time

        # a job: the rows scrolled into view meanwhile wait for its end
        start = time.monotonic()
        mark = ext.start("#download-all-button")
        ext.wait_for(lambda: sites.media_requests(), 60, "the job asked for no media")
        ext.page.evaluate(LAST_ROW_INTO_VIEW)
        # the job goes on for two more media answers with the last rows in view: a loader that
        # ignored the job would have asked for their covers meanwhile
        asked = len(sites.media_requests())
        ext.wait_for(
            lambda: len([r for r in sites.media_requests() if r.finished]) >= asked + 2,
            30,
            "the job did not go on",
        )
        # Stop by script: a pointer click would scroll the button, and the window, back up
        ext.page.evaluate("() => document.querySelector('#stop-button').click()")
        ext.finish(mark, 60)
        job = [r for r in sites.site_requests() if r.started >= start]
        end = max(r.finished for r in job)
        during = [r.path for r in sites.cover_requests() if start <= r.started <= end]
        assert during == [], f"covers asked for during the job: {during}"
        last = f"/btv-cover/{_aid_of(rows[-1])}.jpg"
        ext.wait_for(
            lambda: last in [r.path for r in sites.cover_requests()],
            20,
            "the rows scrolled into view got no cover after the job",
        )
        asked = [r.path for r in sites.cover_requests()]
        assert len(asked) == len(set(asked)), "a cover was asked for twice"
        assert_sequential(sites.cover_requests())
