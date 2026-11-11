"""What StreamFetch does when a site refuses, end to end (spec 7, 8 and 9): every refusal named in
its row, no media request for a video the site will not serve, the polite stops (three failures
in a row; a 429, a 412 or a risk-control page → stop and a 30-minute cooldown; a login wall →
stop without one), the one refresh of an expired URL, the retry of a cut transfer, and the JSON
report — saved once, holding the right rows, causes and attempts, never a cookie value or a query
string; not saved with the setting off; saved again from the button.

Every scenario counts the fake sites' requests (`FakeSites.about`, `media_requests`)."""

from __future__ import annotations

import re
from pathlib import Path

from e2e_checks import (
    NEEDS_CHROMIUM,
    SECRET_COOKIE,
    assert_report_private,
    assert_report_shape,
    assert_sequential,
    load_report,
)
from extension_harness import ExtensionHarness
from fake_sites import (
    BILI_MAIN,
    CLAIMED_SECONDS,
    DM_SHORT_ID,
    DM_TITLES,
    DM_TS_ID,
    EXPIRING_SEGMENT,
    TRUNCATED_SEGMENT,
    FakeSites,
    bili_cid,
)
from media_fixtures import MediaSet, assert_saved_media

pytestmark = [NEEDS_CHROMIUM]

DM = "https://www.dailymotion.com/video/{}"
BILI = "https://www.bilibili.com/video/{}"
GEO, KEYED, LIVE, GONE, AFTER = "xgeo7b1", "xkey3m9", "xlive4q", "xgone8z", "xafter5"
LIMITED, LONGER = "xlimit2", "xlong6p"
LOGIN, DELETED, RISK, BANNED = "BV1Lo6G1nR3q", "BV1De7L1eT4d", "BV1Rk5D1aT2a", "BV1Ba4N1nE7d"
DRM, PREMIUM, TRIAL, UPOWER = "BV1Dr2M1aB3c", "BV1Pr3M1uM9x", "BV1Tr1A1lO6n", "BV1Up0W1eR5x"


def _links(template: str, *ids: str) -> str:
    return "\n".join(template.format(video_id) for video_id in ids)


def _statuses(ext: ExtensionHarness, *ids: str) -> list[str]:
    return [row.status for video_id in ids for row in ext.rows_of(video_id)]


def _assert_cooldown(ext: ExtensionHarness) -> None:
    record = ext.cooldown()
    assert record is not None, "no cooldown recorded"
    assert set(record) >= {"until", "reason", "source", "recordedAt"}, record
    ext.wait_for(lambda: ext.visible("#cooldown-banner"), 10, "no cooldown banner")
    banner = ext.text("#cooldown-banner")
    assert "min" in banner, banner  # the minutes left


def test_dailymotion_refusals_request_no_media_and_three_failures_in_a_row_stop_the_run(
    media: MediaSet, tmp_path: Path
):
    with (
        FakeSites(
            media,
            dm_geo_blocked=frozenset({GEO}),
            dm_key_protected=frozenset({KEYED}),
            dm_live=frozenset({LIVE}),
            dm_not_found=frozenset({GONE}),
        ) as sites,
        ExtensionHarness(tmp_path, sites) as ext,
    ):
        ext.add_cookie("SESSDATA", SECRET_COOKIE)
        ext.download_all(_links(DM, GEO, DM_TS_ID, KEYED, LIVE, GONE, AFTER))
        assert _statuses(ext, GEO, DM_TS_ID, KEYED, LIVE, GONE, AFTER) == [
            "failed-unavailable",
            "done",
            "failed-unavailable",
            "failed-unavailable",
            "failed-unavailable",
            "stopped",
        ]
        assert "not available in your country" in ext.row_of(GEO).message
        assert "key-protected" in ext.row_of(KEYED).message
        assert "live stream" in ext.row_of(LIVE).message
        assert "does not exist" in ext.row_of(GONE).message  # the site's own message
        assert "not attempted" in ext.row_of(AFTER).message
        # no media request for a refused video; never a key; nothing about the stopped one
        assert [r.route for r in sites.about(GEO)] == ["dm-metadata"]
        for xid in (KEYED, LIVE):
            assert [r.kind for r in sites.about(xid)] == ["page"] * 3, sites.about(xid)
        assert not sites.by_route("dm-key")
        assert [r.route for r in sites.about(GONE)] == ["dm-metadata"]
        assert sites.about(AFTER) == []
        (saved,) = ext.wait_saved(1)
        assert saved == f"StreamFetch/Dailymotion/{DM_TITLES[DM_TS_ID]} [{DM_TS_ID}].mp4"
        assert_saved_media(ext.saved_path(saved), media.expected("ts-hls"))
        assert_sequential(sites.site_requests())

        # the failed block: the five rows the run did not download, with the two buttons
        assert len(ext.failed_rows()) == 5
        assert ext.visible("#retry-button") and ext.visible("#report-button")
        # the report: saved once at the end (the setting is on by default)
        (path,) = ext.wait_reports(1)
        assert path.name.endswith(" - did not download.json")
        ext.wait_for(lambda: ext.text("#failed-report").startswith("Report saved: "), 10)
        assert path.name in ext.text("#failed-report")
        report = load_report(path)
        assert_report_shape(report)
        assert_report_private(path)
        assert report["downloaded_count"] == 1
        assert report["run"]["stop_reason"] == "consecutive_failures"
        rows = report["not_downloaded"]
        assert [row["id"] for row in rows] == [GEO, KEYED, LIVE, GONE, AFTER]
        assert [row["status"] for row in rows] == ["failed-unavailable"] * 4 + ["stopped"]
        codes = [row["failure"]["code"] for row in rows]
        assert (
            codes[:3] == ["geo_blocked", "key_protected", "live_stream"] and codes[4] == "stopped"
        )
        assert rows[0]["input"] == DM.format(GEO) and rows[0]["site"] == "dailymotion"
        assert "geo-restrictions" in rows[0]["probable_cause"]
        assert rows[0]["attempts"] and rows[0]["attempts"][0]["host"] == "127.0.0.1"
        assert rows[0]["raw"]["error"]["code"] == "DM007"  # the metadata as served
        assert rows[4]["attempts"] == []


def test_an_expired_segment_is_refreshed_once_and_a_cut_segment_retried(
    media: MediaSet, tmp_path: Path
):
    with (
        FakeSites(
            media,
            dm_expire_segment_once=frozenset({DM_TS_ID}),
            dm_truncate_segment=frozenset({DM_SHORT_ID}),
        ) as sites,
        ExtensionHarness(tmp_path, sites) as ext,
    ):
        ext.download_all(_links(DM, DM_TS_ID, DM_SHORT_ID))
        assert _statuses(ext, DM_TS_ID, DM_SHORT_ID) == ["done", "done"]
        for name in ext.wait_saved(2):
            assert_saved_media(ext.saved_path(name), media.expected("ts-hls"))
        # the expired segment: one refresh (master + media playlist again), then new URLs
        routes = [r.route for r in sites.about(DM_TS_ID)]
        assert routes.count("dm-master") == 2 and routes.count("dm-media-playlist") == 2, routes
        expiring = f"/dm/cdn/{DM_TS_ID}/seg{EXPIRING_SEGMENT:03d}.ts"
        asked = [(r.status, r.query.get("gen")) for r in sites.requests if r.path == expiring]
        assert asked == [(403, "1"), (200, "2")], asked
        # the cut segment: asked again whole (HLS segments are small: no Range)
        cut = f"/dm/cdn/{DM_SHORT_ID}/seg{TRUNCATED_SEGMENT:03d}.ts"
        asked_cut = [(r.cut, r.range) for r in sites.requests if r.path == cut]
        assert asked_cut == [(True, None), (False, None)], asked_cut
        assert [r.route for r in sites.about(DM_SHORT_ID)].count("dm-master") == 1
        assert_sequential(sites.site_requests())
        assert ext.reports() == []


def test_a_file_shorter_than_the_site_says_is_never_saved_and_no_work_file_is_left(
    media: MediaSet, tmp_path: Path
):
    """B.1 "complete": every segment arrives and the MP4 is written, but the site says 60 s and
    the file holds 6 s — the verification refuses it, nothing is saved, the run goes on, and the
    origin private file system holds no work file afterwards."""
    with (
        FakeSites(media, dm_claims_longer=frozenset({LONGER})) as sites,
        ExtensionHarness(tmp_path, sites) as ext,
    ):
        ext.download_all(_links(DM, LONGER, DM_TS_ID))
        assert _statuses(ext, LONGER, DM_TS_ID) == ["failed", "done"]
        message = ext.row_of(LONGER).message
        expected = rf"failed verification \(duration 6\.\d s, expected {CLAIMED_SECONDS}\.0 s\)"
        assert re.search(expected + "; it was not saved", message), message
        # the whole media was asked for, exactly as for the video that was saved
        segments = [
            r.path.rsplit("/", 1)[1] for r in sites.about(LONGER) if r.route == "dm-segment"
        ]
        saved_segments = [
            r.path.rsplit("/", 1)[1] for r in sites.about(DM_TS_ID) if r.route == "dm-segment"
        ]
        assert segments and segments == saved_segments, (segments, saved_segments)
        (saved,) = ext.wait_saved(1)
        assert saved == f"StreamFetch/Dailymotion/{DM_TITLES[DM_TS_ID]} [{DM_TS_ID}].mp4"
        assert_saved_media(ext.saved_path(saved), media.expected("ts-hls"))
        assert ext.private_files() == ["streamfetch/", "streamfetch/work/"]  # used, then emptied
        (path,) = ext.wait_reports(1)
        (row,) = load_report(path)["not_downloaded"]
        assert (row["id"], row["status"]) == (LONGER, "failed")
        assert row["failure"]["code"] == "verify_failed"
        assert re.search(expected, row["message_en"]), row["message_en"]
        assert sum(1 for a in row["attempts"] if a["requested"]) >= len(segments)
        assert_sequential(sites.site_requests())


def test_a_429_on_a_manifest_stops_the_run_and_starts_a_cooldown_that_refuses_new_runs(
    media: MediaSet, tmp_path: Path
):
    with (
        FakeSites(media, dm_rate_limit_manifest=frozenset({LIMITED})) as sites,
        ExtensionHarness(tmp_path, sites) as ext,
    ):
        ext.download_all(_links(DM, DM_TS_ID, LIMITED, DM_SHORT_ID))
        assert _statuses(ext, DM_TS_ID, LIMITED, DM_SHORT_ID) == [
            "done",
            "failed-rate-limited",
            "stopped",
        ]
        assert "rate-limiting" in ext.row_of(LIMITED).message
        assert [r.status for r in sites.about(LIMITED)] == [200, 429]  # metadata, master
        assert sites.about(DM_SHORT_ID) == []
        _assert_cooldown(ext)
        (path,) = ext.wait_reports(1)
        report = load_report(path)
        assert [row["id"] for row in report["not_downloaded"]] == [LIMITED, DM_SHORT_ID]
        assert report["run"]["stop_reason"] == "rate_limited"
        assert report["not_downloaded"][0]["failure"]["code"] == "rate_limited"

        # a new run during the cooldown is refused: nothing is asked of the sites
        before = len(sites.site_requests())
        ext.paste(DM.format(DM_SHORT_ID))
        ext.click_and_settle("#download-all-button")
        assert len(sites.site_requests()) == before, sites.site_requests()[before:]
        assert ext.visible("#cooldown-banner")
        assert ext.saved_files() == [
            f"StreamFetch/Dailymotion/{DM_TITLES[DM_TS_ID]} [{DM_TS_ID}].mp4"
        ]


def test_a_bilibili_login_wall_stops_the_run_without_a_cooldown(media: MediaSet, tmp_path: Path):
    with (
        FakeSites(media, bili_login_wall=frozenset({LOGIN})) as sites,
        ExtensionHarness(tmp_path, sites) as ext,
    ):
        ext.download_all(_links(BILI, LOGIN, BILI_MAIN))
        assert _statuses(ext, LOGIN, BILI_MAIN) == ["failed-unavailable", "stopped"]
        assert "log in" in ext.row_of(LOGIN).message
        assert [r.route for r in sites.about(LOGIN)] == ["bili-page"]
        assert sites.about(BILI_MAIN) == []
        assert ext.cooldown() is None
        assert not ext.visible("#cooldown-banner")


def test_a_deleted_bilibili_video_fails_and_the_run_goes_on(media: MediaSet, tmp_path: Path):
    with (
        FakeSites(media, bili_deleted=frozenset({DELETED})) as sites,
        ExtensionHarness(tmp_path, sites) as ext,
    ):
        ext.download_all(_links(BILI, DELETED, BILI_MAIN))
        assert _statuses(ext, DELETED, BILI_MAIN) == ["failed-unavailable", "done"]
        assert "gone" in ext.row_of(DELETED).message
        assert [r.route for r in sites.about(DELETED)] == ["bili-page"]
        (name,) = ext.wait_saved(1)
        assert name == f"StreamFetch/Bilibili/Fake Bilibili two-part video [{BILI_MAIN}].mp4"
        assert_saved_media(ext.saved_path(name), media.expected("dash"))


def test_a_risk_control_page_stops_the_run_and_starts_the_cooldown(media: MediaSet, tmp_path: Path):
    with (
        FakeSites(media, bili_riskdata=frozenset({RISK})) as sites,
        ExtensionHarness(tmp_path, sites) as ext,
    ):
        ext.download_all(_links(BILI, RISK, BILI_MAIN))
        assert _statuses(ext, RISK, BILI_MAIN) == ["failed-rate-limited", "stopped"]
        assert sites.about(BILI_MAIN) == []
        _assert_cooldown(ext)


def test_a_412_from_the_bilibili_cdn_stops_the_run_and_starts_the_cooldown(
    media: MediaSet, tmp_path: Path
):
    with (
        FakeSites(media, bili_cdn_412=frozenset({BANNED})) as sites,
        ExtensionHarness(tmp_path, sites) as ext,
    ):
        ext.download_all(_links(BILI, BANNED, BILI_MAIN))
        assert _statuses(ext, BANNED, BILI_MAIN) == ["failed-rate-limited", "stopped"]
        banned_media = [r for r in sites.about(BANNED) if r.kind == "media"]
        assert [r.status for r in banned_media] == [412], banned_media  # never asked twice
        assert sites.about(BILI_MAIN) == []
        _assert_cooldown(ext)
        assert ext.saved_files() == []


def test_a_412_on_a_later_parts_page_stops_the_run_before_any_part_is_downloaded(
    media: MediaSet, tmp_path: Path
):
    """Every part of a multi-part video is resolved before its downloads: when the page of part 2
    answers 412, part 1 — resolved fine — is not downloaded either; the run stops at once and the
    cooldown starts (spec 7: a 412 anywhere)."""
    with (
        FakeSites(media, bili_parts_of=((BILI_MAIN, 2),), bili_part_412=((BILI_MAIN, 2),)) as sites,
        ExtensionHarness(tmp_path, sites) as ext,
    ):
        ext.download_all(f"{BILI.format(BILI_MAIN)}\n{DM.format(AFTER)}")
        assert _statuses(ext, BILI_MAIN, AFTER) == ["stopped", "failed-rate-limited", "stopped"]
        pages = [(r.route, r.status) for r in sites.about(BILI_MAIN)]
        assert pages == [("bili-page", 200), ("bili-page", 412)], pages
        assert sites.media_requests() == [], "a media request after the site refused the session"
        assert sites.about(AFTER) == []
        _assert_cooldown(ext)
        record = ext.cooldown()
        assert record is not None and record["reason"] == "HTTP 412 (page)", record
        assert ext.saved_files() == []


def test_encrypted_bilibili_media_is_refused_and_nothing_is_saved(media: MediaSet, tmp_path: Path):
    with (
        FakeSites(media, bili_drm=frozenset({DRM})) as sites,
        ExtensionHarness(tmp_path, sites) as ext,
    ):
        ext.download_all(_links(BILI, DRM, BILI_MAIN))
        assert _statuses(ext, DRM, BILI_MAIN) == ["failed-unavailable", "done"]
        assert "encrypted" in ext.row_of(DRM).message
        drm_cdn = [r.route for r in sites.about(DRM) if r.kind == "media"]
        assert drm_cdn == ["bili-video"], drm_cdn  # refused before the audio was asked for
        assert ext.wait_saved(1) == [
            f"StreamFetch/Bilibili/Fake Bilibili two-part video [{BILI_MAIN}].mp4"
        ]
        (path,) = ext.wait_reports(1)
        (row,) = load_report(path)["not_downloaded"]
        assert row["failure"]["code"] == "encrypted"


def test_premium_hint_trial_clip_and_supporter_only_videos(media: MediaSet, tmp_path: Path):
    with (
        FakeSites(
            media,
            bili_missing_premium=frozenset({PREMIUM}),
            bili_trial=frozenset({TRIAL}),
            bili_upower_no_dash=frozenset({UPOWER}),
        ) as sites,
        ExtensionHarness(tmp_path, sites) as ext,
    ):
        links = _links(BILI, TRIAL, UPOWER, PREMIUM)
        ext.analyze(links, min_rows=3)
        premium = ext.row_of(PREMIUM)
        hint = f"{premium.quality} {premium.message} {' '.join(o['text'] for o in premium.options)}"
        assert "premium" in hint and "1080P" in hint, premium  # 1080P60 needs a premium membership
        assert sites.media_requests() == []
        ext.download_all()
        assert _statuses(ext, TRIAL, UPOWER, PREMIUM) == [
            "failed-unavailable",
            "failed-unavailable",
            "done",
        ]
        assert "trial" in ext.row_of(TRIAL).message
        assert "supporters" in ext.row_of(UPOWER).message
        for video_id in (TRIAL, UPOWER):
            assert [r.kind for r in sites.about(video_id) if r.kind == "media"] == []
        # the premium quality is never asked for: only what the session is served
        premium_media = [r.path for r in sites.about(PREMIUM) if r.route == "bili-video"]
        assert premium_media == [f"/bili/cdn/{bili_cid(PREMIUM, 1)}/80.m4s"], premium_media
        assert ext.wait_saved(1) == [
            f"StreamFetch/Bilibili/Fake Bilibili video {PREMIUM} [{PREMIUM}].mp4"
        ]


def test_a_part_query_selects_that_part_only(media: MediaSet, tmp_path: Path):
    with FakeSites(media, bili_parts=2) as sites, ExtensionHarness(tmp_path, sites) as ext:
        ext.download_all(f"https://www.bilibili.com/video/{BILI_MAIN}?p=2")
        (row,) = ext.rows_of(BILI_MAIN)
        assert row.status == "done", row
        pages = sites.by_route("bili-page")
        assert [r.query.get("p") for r in pages] == ["2"] * len(pages), pages
        videos = [r.path for r in sites.by_route("bili-video")]
        assert videos == [f"/bili/cdn/{bili_cid(BILI_MAIN, 2)}/80.m4s"], videos
        (name,) = ext.wait_saved(1)
        folder = f"StreamFetch/Bilibili/Fake Bilibili two-part video [{BILI_MAIN}]"
        assert name == f"{folder}/P02 - Second half.mp4"
        assert_saved_media(ext.saved_path(name), media.expected("dash"))


def test_an_expired_audio_url_rereads_the_page_once_and_the_download_completes(
    media: MediaSet, tmp_path: Path
):
    with (
        FakeSites(media, bili_expire_once=frozenset({BILI_MAIN})) as sites,
        ExtensionHarness(tmp_path, sites) as ext,
    ):
        ext.download_all(BILI.format(BILI_MAIN))
        assert _statuses(ext, BILI_MAIN) == ["done"]
        assert len(sites.by_route("bili-page")) == 2  # the page, then one refresh
        assert [r.status for r in sites.by_route("bili-audio")] == [403, 200]
        assert [r.status for r in sites.by_route("bili-video")] == [200]  # not asked again
        (name,) = ext.wait_saved(1)
        assert_saved_media(ext.saved_path(name), media.expected("dash"))
        assert_sequential(sites.site_requests())


def test_the_report_is_saved_once_not_with_the_setting_off_and_again_from_the_button(
    media: MediaSet, tmp_path: Path
):
    second = "xgeo2c5"
    with (
        FakeSites(media, dm_geo_blocked=frozenset({GEO, second})) as sites,
        ExtensionHarness(tmp_path, sites) as ext,
    ):
        ext.add_cookie("SESSDATA", SECRET_COOKIE)
        ext.download_all(DM.format(GEO))
        (first,) = ext.wait_reports(1)
        assert [row["id"] for row in load_report(first)["not_downloaded"]] == [GEO]
        assert_report_private(first)

        ext.set_report_setting(False)
        ext.download_all(DM.format(second))
        assert ext.row_of(second).status == "failed-unavailable"
        assert not ext.text("#failed-report").startswith("Report saved: ")

        # the positive end signal: the report saved on demand, AFTER the run — one the run had
        # saved on its own would have been asked for before it, and be on disk by then too
        ext.page.click("#report-button")
        ext.wait_for(
            lambda: ext.text("#failed-report").startswith("Report saved: "),
            15,
            "the report on demand was not saved",
        )
        reports = ext.reports()
        assert len(reports) == 2, reports  # the first run's and the one on demand: no other
        (new,) = [path for path in reports if path != first]
        assert [row["id"] for row in load_report(new)["not_downloaded"]] == [second]
        assert_report_private(new)
        assert_report_shape(load_report(new))
        assert sites.media_requests() == []
