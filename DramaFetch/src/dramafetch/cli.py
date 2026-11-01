"""Command-line front end: ``dramafetch info | download | video | doctor | serve``.

DramaFetch downloads the episodes of a TikTok short drama that the user's own account can already
watch, a whole series at a time, for personal offline viewing. The series URL is
``https://www.tiktok.com/shortdrama/episode/<series_id>/<n>``; yt-dlp does not understand it, so
``info``/``download`` first resolve the episode list (TikTok's ``/api/drama/episode/item_list/``)
and then hand each episode's ordinary ``/@user/video/<id>`` page to yt-dlp. A logged-in session
(``--cookies cookies.txt``) is normally required; cookie values are never printed. Locked (paid)
episodes are listed and skipped — nothing here unlocks or bypasses anything. Downloads are paced
like one person watching (see ``engine``): the pauses, rests and early stops are printed on stderr
as they happen, so stdout stays a clean list of results.

Exit codes: 0 ok · 2 usage/unsupported URL/some episode failed · 3 login required ·
4 discovery failed (captcha: try ``--headful``; an HTTP error for the series page) · 5 blocked
(HTTP 403, or a captcha met while ``--engine browser`` refreshed the list) or rate limited
(HTTP 429): wait 30-60 min, then run again to resume · 130 interrupted.
"""

from __future__ import annotations

import argparse
import codecs
import json
import os
import platform
import re
import shutil
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dramafetch import __version__, engine
from dramafetch.discovery.cookies import cookie_file_problems
from dramafetch.downloader import MAX_RETRIES, curl_cffi_available
from dramafetch.errors import (
    ChallengeError,
    DiscoveryError,
    DramaFetchError,
    LoginRequiredError,
    RateLimitedError,
    UnsupportedUrlError,
)
from dramafetch.manifest import NAME_PLACEHOLDERS, series_dir, validate_name_format
from dramafetch.models import (
    DEFAULT_NAME_FORMAT,
    DiscoveryOptions,
    DownloadOptions,
    DownloadResult,
    Episode,
    Series,
    SeriesRef,
    VideoRef,
)
from dramafetch.urls import parse_input

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_USAGE = 2
EXIT_LOGIN = 3
EXIT_DISCOVERY = 4
EXIT_RATE_LIMITED = 5
EXIT_INTERRUPTED = 130

DEFAULT_OUT_DIR = "downloads"
#: ``video`` names its one file after the title, which is the item id: ``<id>.mp4``.
VIDEO_NAME_FORMAT = "{title}"
PACES = engine.PACES
ENGINES = engine.ENGINES
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
SESSION_COOKIE_NAMES = frozenset({"sessionid", "sid_tt"})
BROWSER_INSTALL_HINT = (
    "run `playwright install chromium`, or pass --browser-channel chrome (uses your installed "
    "Chrome) or --browser-path <binary>"
)
LOGIN_HELP = (
    "TikTok only lists episodes for a logged-in session. In the browser where you are logged in, "
    "export cookies.txt in Netscape format (e.g. with the 'Get cookies.txt LOCALLY' extension) "
    "and rerun with --cookies cookies.txt. Keep that file private; it expires."
)
CHALLENGE_HELP = (
    "TikTok asked for a human check (captcha). Rerun with --headful to solve it in the browser "
    "window, then try again; fresh cookies from the same browser help too."
)
LEGAL_NOTICE = (
    "DramaFetch is for personal, offline viewing of episodes that your own TikTok account can "
    "already watch. It does not unlock paid episodes and does not bypass DRM or access controls; "
    "locked episodes are listed and skipped. Downloading may breach TikTok's Terms of Service, and "
    "the videos belong to their creators and studios — you are responsible for how you use this "
    "tool."
)

_MARKS = {"ok": "✓", "fail": "✗", "skip": "–"}  # noqa: RUF001 - the en dash is the spec's "n/a" mark
_ASCII_MARKS = {"ok": "OK", "fail": "X", "skip": "-"}
# Text TikTok controls (titles, series names, yt-dlp messages) is printed without C0/C1 control
# characters, DEL and the Unicode line/bidirectional controls: an escape sequence in a title could
# otherwise erase the "locked" column or retitle the terminal.
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]")


# --------------------------------------------------------------------------- argument parsing


def build_parser() -> argparse.ArgumentParser:
    """The argparse parser (exposed for tests and shell-completion tools)."""
    parser = argparse.ArgumentParser(
        prog="dramafetch",
        description="Download the TikTok short-drama episodes you can watch, a whole series at a "
        "time, for personal offline viewing.",
        epilog=LEGAL_NOTICE,
    )
    parser.add_argument("--version", action="version", version=f"dramafetch {__version__}")
    commands = parser.add_subparsers(dest="command", metavar="COMMAND", required=True)

    info = commands.add_parser("info", help="resolve a series and list its episodes (no download)")
    info.add_argument(
        "url", metavar="URL", help="https://www.tiktok.com/shortdrama/episode/<id>/<n>"
    )
    info.add_argument(
        "--json", dest="as_json", action="store_true", help="print the series as JSON"
    )
    _add_out_flag(info)
    _add_cookies_flag(info)
    _add_discovery_flags(info)
    info.set_defaults(func=_cmd_info)

    download = commands.add_parser("download", help="resolve a series and download its episodes")
    download.add_argument("url", metavar="URL", help="series URL (or bare series id)")
    download.add_argument(
        "--episodes",
        metavar="SPEC",
        default=None,
        help='which episodes: "all" (default), "1-5,8,10-" (open range = to the last)',
    )
    _add_out_flag(download)
    _add_cookies_flag(download)
    _add_discovery_flags(download)
    _add_download_flags(download, series=True)
    download.set_defaults(func=_cmd_download)

    video = commands.add_parser(
        "video", help="download one ordinary /@user/video/<id> page without series discovery"
    )
    video.add_argument("url", metavar="URL", help="https://www.tiktok.com/@user/video/<id>")
    _add_out_flag(video)
    _add_cookies_flag(video)
    _add_download_flags(video, series=False)
    video.set_defaults(func=_cmd_video)

    doctor = commands.add_parser(
        "doctor", help="check Python, yt-dlp, curl_cffi, Playwright, browser, ffmpeg and cookies"
    )
    _add_cookies_flag(doctor)
    doctor.add_argument("--browser-channel", choices=("chrome", "msedge", "chromium"), default=None)
    doctor.add_argument("--browser-path", type=Path, default=None, metavar="PATH")
    doctor.set_defaults(func=_cmd_doctor)

    serve = commands.add_parser("serve", help="run the local web UI (stdlib http.server)")
    serve.add_argument(
        "--host",
        default=DEFAULT_HOST,
        help=f"bind address (default {DEFAULT_HOST}: this machine only); anything but loopback "
        "needs --token, because the whole network can then reach the page",
    )
    serve.add_argument(
        "--port", type=int, default=DEFAULT_PORT, help=f"port (default {DEFAULT_PORT})"
    )
    serve.add_argument(
        "--token",
        default=None,
        metavar="TOKEN",
        help="access token the page asks for once per device (also env DRAMAFETCH_TOKEN; the flag "
        "wins): at least 8 characters, no spaces or quotes. Required with a --host other than "
        "loopback, so that a phone or TV on your network can use the UI and nobody else can",
    )
    _add_out_flag(serve)
    _add_cookies_flag(serve)
    _add_discovery_flags(serve)
    _add_download_flags(serve, series=True)
    serve.set_defaults(func=_cmd_serve)
    return parser


def _add_out_flag(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--out",
        metavar="DIR",
        default=DEFAULT_OUT_DIR,
        help=f"output directory (default ./{DEFAULT_OUT_DIR}; series get their own subfolder)",
    )


def _add_cookies_flag(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--cookies",
        metavar="FILE",
        type=Path,
        default=None,
        help="Netscape cookies.txt exported from your logged-in browser (never printed)",
    )


def _add_discovery_flags(parser: argparse.ArgumentParser) -> None:
    group = parser.add_argument_group("discovery (how the episode list is fetched)")
    group.add_argument("--strategy", choices=("auto", "browser", "static"), default="auto")
    group.add_argument(
        "--browser-channel",
        choices=("chrome", "msedge", "chromium"),
        default=None,
        help="use an installed browser instead of Playwright's bundled Chromium",
    )
    group.add_argument("--browser-path", type=Path, default=None, metavar="PATH")
    group.add_argument("--headful", action="store_true", help="show the browser window")
    group.add_argument(
        "--dump-raw", type=Path, default=None, metavar="DIR", help="write raw payloads here"
    )
    group.add_argument(
        "--timeout", type=float, default=DiscoveryOptions.timeout_s, metavar="S", help="seconds"
    )
    group.add_argument("--base-url", default=DiscoveryOptions.base_url, help=argparse.SUPPRESS)
    # Pagination knobs, hidden like --base-url: tests and diagnostics point them at the fake server.
    group.add_argument(
        "--page-count", type=int, default=DiscoveryOptions.page_count, help=argparse.SUPPRESS
    )
    group.add_argument(
        "--max-pages", type=int, default=DiscoveryOptions.max_pages, help=argparse.SUPPRESS
    )
    group.add_argument(
        "--page-delay", type=float, default=DiscoveryOptions.page_delay_s, help=argparse.SUPPRESS
    )


def _add_download_flags(parser: argparse.ArgumentParser, *, series: bool) -> None:
    group = parser.add_argument_group("download")
    if series:
        _add_pacing_flags(parser)
        group.add_argument(
            "--include-locked",
            action="store_true",
            help="also try episodes that look locked (they usually have no formats)",
        )
    group.add_argument(
        "--engine",
        choices=ENGINES,
        default=DownloadOptions.engine,
        help="yt-dlp (default) downloads each episode's page; browser fetches the play URLs the "
        "episode list already carries, inside one browser session of its own (about half the "
        "requests; series only, uses the discovery browser flags and --cookies)",
    )
    group.add_argument(
        "--name-format",
        metavar="FORMAT",
        default=None,
        help="file name of each episode, without extension; placeholders: "
        + " ".join(f"{{{name}}}" for name in NAME_PLACEHOLDERS)
        + f" (default '{DEFAULT_NAME_FORMAT}' for a series, "
        f"'{VIDEO_NAME_FORMAT}' for video; {{number}} is zero-padded, {{n}} is not)",
    )
    group.add_argument(
        "--no-thumbnails",
        action="store_true",
        help="do not save the episode cover next to the video (default: <name>.jpg|png|webp)",
    )
    group.add_argument("--overwrite", action="store_true", help="re-download existing files")
    group.add_argument("--dry-run", action="store_true", help="list what would be downloaded")
    group.add_argument(
        "--no-impersonate", action="store_true", help="disable yt-dlp's curl_cffi impersonation"
    )
    group.add_argument(
        "--cookies-from-browser",
        metavar="NAME",
        default=None,
        help="yt-dlp --cookies-from-browser (chrome, firefox, edge, ...)",
    )
    group.add_argument(
        "--retries",
        type=int,
        default=DownloadOptions.retries,
        metavar="N",
        help=f"yt-dlp retries per download (default and maximum {MAX_RETRIES}; lower it to give "
        "up sooner)",
    )
    group.add_argument(
        "--extractor-args",
        metavar="KEY=VAL",
        action="append",
        default=None,
        help="yt-dlp extractor args, e.g. tiktok:api_hostname=api22-normal-c-useast2a.tiktokv.com "
        "(the tiktok: prefix is the default; repeatable)",
    )


def _add_pacing_flags(parser: argparse.ArgumentParser) -> None:
    """The anti-bot pacing: one download at a time, pauses, rests, early stops (see README)."""
    group = parser.add_argument_group(
        "pacing (behave like one person watching; the defaults are a floor, raise them for long "
        "series)"
    )
    group.add_argument(
        "--delay-min",
        type=float,
        default=DownloadOptions.delay_min_s,
        metavar="S",
        help="random pause between episodes, lower bound "
        f"(default {DownloadOptions.delay_min_s:g})",
    )
    group.add_argument(
        "--delay-max",
        type=float,
        default=DownloadOptions.delay_max_s,
        metavar="S",
        help="random pause between episodes, upper bound "
        f"(default {DownloadOptions.delay_max_s:g})",
    )
    group.add_argument(
        "--pace",
        choices=PACES,
        default=DownloadOptions.pace,
        help="fixed (default): a random --delay-min..--delay-max pause; human: about as long as "
        f"the previous episode lasted (at least --delay-min, plus 0-{engine.HUMAN_JITTER_S:g} s, "
        f"at most {engine.MAX_HUMAN_PAUSE_S:g} s)",
    )
    group.add_argument(
        "--rest-every",
        type=int,
        default=DownloadOptions.rest_every,
        metavar="N",
        help="take a longer rest after every N downloads, failed attempts included "
        f"(default {DownloadOptions.rest_every}; 0 disables)",
    )
    group.add_argument(
        "--rest-min",
        type=float,
        default=DownloadOptions.rest_min_s,
        metavar="S",
        help=f"rest length, lower bound (default {DownloadOptions.rest_min_s:g})",
    )
    group.add_argument(
        "--rest-max",
        type=float,
        default=DownloadOptions.rest_max_s,
        metavar="S",
        help=f"rest length, upper bound (default {DownloadOptions.rest_max_s:g})",
    )
    group.add_argument(
        "--max-consecutive-failures",
        type=int,
        default=DownloadOptions.max_consecutive_failures,
        metavar="N",
        help="stop the run after N failures in a row "
        f"(default {DownloadOptions.max_consecutive_failures}; 0 disables)",
    )


def parse_extractor_args(values: list[str]) -> dict[str, dict[str, list[str]]]:
    """``["tiktok:a=1;b=x,y", "c=2"]`` -> ``{"tiktok": {"a": ["1"], "b": ["x", "y"], "c": ["2"]}}``.

    Accepts yt-dlp's ``IE:key=val;key2=val2`` syntax and bare ``key=val`` (extractor ``tiktok``).
    """
    result: dict[str, dict[str, list[str]]] = {}
    for raw in values:
        text = raw.strip()
        if not text:
            raise ValueError("empty --extractor-args value")
        ie_key, separator, rest = text.partition(":")
        if not separator or "=" in ie_key:
            ie_key, rest = "tiktok", text
        ie_key = ie_key.strip().lower()
        if not ie_key or not rest.strip():
            raise ValueError(
                f"invalid --extractor-args {raw!r}: expected IE:key=value[;key2=value2]"
            )
        for pair in rest.split(";"):
            pair = pair.strip()
            if not pair:
                continue
            name, equals, value = pair.partition("=")
            if not equals or not name.strip():
                raise ValueError(
                    f"invalid --extractor-args {raw!r}: expected IE:key=value[;key2=value2]"
                )
            values_for_key = result.setdefault(ie_key, {}).setdefault(name.strip(), [])
            values_for_key.extend(part for part in value.split(",") if part != "")
    return result


def _validate(args: argparse.Namespace, parser: argparse.ArgumentParser) -> None:
    """Cheap argument checks that must fail with exit 2 before any network access."""
    delay_min = getattr(args, "delay_min", None)
    delay_max = getattr(args, "delay_max", None)
    if delay_min is not None and delay_max is not None:
        if delay_min < 0 or delay_max < 0:
            parser.error("--delay-min/--delay-max must not be negative")
        if delay_max < delay_min:
            parser.error("--delay-max must be >= --delay-min")
    rest_min = getattr(args, "rest_min", None)
    rest_max = getattr(args, "rest_max", None)
    if rest_min is not None and rest_max is not None:
        if rest_min < 0 or rest_max < 0:
            parser.error("--rest-min/--rest-max must not be negative")
        if rest_max < rest_min:
            parser.error("--rest-max must be >= --rest-min")
    rest_every = getattr(args, "rest_every", None)
    if rest_every is not None and rest_every < 0:
        parser.error("--rest-every must not be negative (0 disables the long rests)")
    max_failures = getattr(args, "max_consecutive_failures", None)
    if max_failures is not None and max_failures < 0:
        parser.error("--max-consecutive-failures must not be negative (0 disables the stop)")
    retries = getattr(args, "retries", None)
    if retries is not None and not 0 <= retries <= MAX_RETRIES:
        parser.error(
            f"--retries must be between 0 and {MAX_RETRIES}: after a refusal every retry is one "
            "more request against the same address"
        )
    if getattr(args, "command", None) == "video" and getattr(args, "engine", None) == "browser":
        parser.error(
            "--engine browser works on a series (it reuses the play URLs from the episode list); "
            "a single video is downloaded by the default yt-dlp engine"
        )
    if getattr(args, "engine", None) == "browser" and getattr(args, "cookies_from_browser", None):
        parser.error(
            "--engine browser reads cookies from --cookies FILE only; --cookies-from-browser is a "
            "yt-dlp option (drop it, or use the default engine)"
        )
    port = getattr(args, "port", None)
    if port is not None and not 0 <= port <= 65535:
        parser.error("--port must be between 0 and 65535")
    host = getattr(args, "host", None)
    if host is not None and not host.strip().strip("[]").strip():
        parser.error("--host must name an address (127.0.0.1 keeps the UI private to this machine)")
    if getattr(args, "command", None) == "serve":
        _validate_serve_token(args, parser)
    page_count = getattr(args, "page_count", None)
    if page_count is not None and page_count < 1:
        parser.error("--page-count must be at least 1")
    max_pages = getattr(args, "max_pages", None)
    if max_pages is not None and max_pages < 1:
        parser.error("--max-pages must be at least 1")
    page_delay = getattr(args, "page_delay", None)
    if page_delay is not None and page_delay < 0:
        parser.error("--page-delay must not be negative")
    raw_extractor_args = getattr(args, "extractor_args", None)
    args.extractor_args_parsed = None
    if raw_extractor_args:
        try:
            args.extractor_args_parsed = parse_extractor_args(raw_extractor_args) or None
        except ValueError as exc:
            parser.error(str(exc))
    spec = getattr(args, "episodes", None)
    if spec is not None:
        try:
            engine.parse_episode_spec(spec)
        except ValueError as exc:
            parser.error(str(exc))
    if hasattr(args, "name_format"):
        try:
            validate_name_format(name_format_for(args))
        except ValueError as exc:
            parser.error(f"--name-format: {exc}")


def name_format_for(args: argparse.Namespace) -> str:
    """The name format in force: ``--name-format`` when given, else ``"{title}"`` for ``video``
    (one file, named after its item id) and ``models.DEFAULT_NAME_FORMAT`` for a series."""
    given = getattr(args, "name_format", None)
    if given is not None:
        return str(given)
    if getattr(args, "command", None) == "video":
        return VIDEO_NAME_FORMAT
    return DEFAULT_NAME_FORMAT


def _validate_serve_token(args: argparse.Namespace, parser: argparse.ArgumentParser) -> None:
    """``serve``: resolve the access token (``--token``, else ``DRAMAFETCH_TOKEN``) into
    ``args.token`` and refuse — before anything is bound — a token the web layer cannot use, or a
    ``--host`` off loopback without one. The token value never appears in a message."""
    from dramafetch.web.server import is_loopback_host, token_problem  # lazy: serve only

    token: str | None = args.token
    if token is None:
        token = os.environ.get("DRAMAFETCH_TOKEN") or None
    if token is not None:
        problem = token_problem(token)
        if problem is not None:
            parser.error(f"--token (or DRAMAFETCH_TOKEN): {problem}")
    args.token = token
    if token is None and not is_loopback_host(args.host):
        parser.error(
            f"--host {args.host} needs --token (or DRAMAFETCH_TOKEN): without it the UI would be "
            "open to everyone on the network"
        )


def _discovery_options(args: argparse.Namespace) -> DiscoveryOptions:
    return DiscoveryOptions(
        cookies_file=args.cookies,
        browser_channel=args.browser_channel,
        executable_path=args.browser_path,
        headful=args.headful,
        base_url=args.base_url,
        page_count=args.page_count,
        max_pages=args.max_pages,
        timeout_s=args.timeout,
        page_delay_s=args.page_delay,
        dump_dir=args.dump_raw,
        strategy=args.strategy,
    )


def _download_options(args: argparse.Namespace) -> DownloadOptions:
    """``DownloadOptions`` from the parsed flags. With ``--engine browser`` the discovery browser
    flags (``--browser-channel``, ``--browser-path``, ``--headful``, ``--base-url``) are copied
    over, so the download engine's own Chromium is launched and set up like the discovery's."""
    engine_name = getattr(args, "engine", DownloadOptions.engine)
    browser = engine_name == "browser"
    return DownloadOptions(
        out_dir=Path(args.out),
        cookies_file=args.cookies,
        cookies_from_browser=args.cookies_from_browser,
        delay_min_s=getattr(args, "delay_min", DownloadOptions.delay_min_s),
        delay_max_s=getattr(args, "delay_max", DownloadOptions.delay_max_s),
        pace=getattr(args, "pace", DownloadOptions.pace),
        rest_every=getattr(args, "rest_every", DownloadOptions.rest_every),
        rest_min_s=getattr(args, "rest_min", DownloadOptions.rest_min_s),
        rest_max_s=getattr(args, "rest_max", DownloadOptions.rest_max_s),
        max_consecutive_failures=getattr(
            args, "max_consecutive_failures", DownloadOptions.max_consecutive_failures
        ),
        engine=engine_name,
        browser_channel=getattr(args, "browser_channel", None) if browser else None,
        browser_executable=getattr(args, "browser_path", None) if browser else None,
        browser_headful=bool(getattr(args, "headful", False)) if browser else False,
        base_url=getattr(args, "base_url", DownloadOptions.base_url)
        if browser
        else DownloadOptions.base_url,
        name_format=name_format_for(args),
        thumbnails=not getattr(args, "no_thumbnails", False),
        impersonate=not args.no_impersonate,
        retries=args.retries,
        overwrite=args.overwrite,
        include_locked=getattr(args, "include_locked", False),
        dry_run=args.dry_run,
        extractor_args=getattr(args, "extractor_args_parsed", None),
    )


# --------------------------------------------------------------------------- commands


def _series_ref(text: str) -> SeriesRef:
    ref = parse_input(text)
    if isinstance(ref, VideoRef):
        raise UnsupportedUrlError(
            f"{text.strip()!r} is a single video, not a series: use `dramafetch video URL`."
        )
    return ref


def _cmd_info(args: argparse.Namespace) -> int:
    ref = _series_ref(args.url)
    series = engine.resolve(ref, _discovery_options(args))
    target_dir = series_dir(Path(args.out), series)
    if args.as_json:
        data = engine.series_to_dict(series)
        data["output_dir"] = str(target_dir)
        # A non-UTF-8 stdout (Windows pipes default to cp1252) gets \uXXXX escapes: exact JSON.
        print(json.dumps(data, indent=2, ensure_ascii=not _stream_is_utf8(sys.stdout)))
        return EXIT_OK
    _print_series_table(series, target_dir)
    return EXIT_OK


def _cmd_download(args: argparse.Namespace) -> int:
    ref = _series_ref(args.url)
    options = _download_options(args)
    series = engine.resolve(ref, _discovery_options(args))
    for warning in series.warnings:
        _stderr(f"warning: {warning}")
    if not series.episodes:
        _stderr(f"no episodes listed for series {series.series_id}; try `info --dump-raw DIR`")
        return EXIT_DISCOVERY
    selected = engine.select_episodes(series, args.episodes)
    missing = engine.missing_from_selection(series, args.episodes)
    if missing:
        _stderr(
            "requested episodes the series does not list (ignored): "
            + engine.format_ranges(missing)
        )
    if not selected:
        _stderr("no episodes match --episodes; nothing to do")
        return EXIT_OK
    target_dir = series_dir(options.out_dir, series)
    print(
        _printable(
            f"{series.display_name} [{series.series_id}]: {len(selected)} episode(s) -> "
            f"{target_dir}"
        ),
        flush=True,
    )
    if len(selected) > 1 and not options.dry_run:
        _stderr(f"  pace: {describe_pacing(options)}")
    printer = _RunPrinter()
    results = engine.download_series(
        series, selected, options, on_result=printer.result, on_pause=printer.pause
    )
    print(_summary_line(results), flush=True)
    return engine.exit_code(results)


def _cmd_video(args: argparse.Namespace) -> int:
    ref = parse_input(args.url)
    if isinstance(ref, SeriesRef):
        raise UnsupportedUrlError(
            f"{args.url.strip()!r} is a series, not a single video: use `dramafetch download URL`."
        )
    options = _download_options(args)
    episode = Episode(
        number=0, item_id=ref.item_id, title=ref.item_id, series_id="", author=ref.author
    )
    options.out_dir.mkdir(parents=True, exist_ok=True)
    downloader = engine.make_downloader(options)
    try:
        result = downloader.download(episode, options)
    finally:
        engine.close_downloader(downloader)
    _print_result(result)
    return engine.exit_code([result])


def _cmd_doctor(args: argparse.Namespace) -> int:
    checks = doctor_checks(
        browser_channel=args.browser_channel,
        browser_path=args.browser_path,
        cookies_file=args.cookies,
    )
    # The pacing defaults, as information (neither ok nor fail): the web UI's doctor omits them.
    checks.append(DoctorCheck("pace", "skip", describe_pacing()))
    # A stdout that cannot encode the check marks (a Windows pipe in cp1252) gets ASCII ones.
    lines = format_doctor(checks, ascii_marks=not _stream_is_utf8(sys.stdout))
    try:
        print("\n".join(lines))
    except UnicodeEncodeError:  # an exotic encoding that cannot even take the ASCII marks' text
        print("\n".join(format_doctor(checks, ascii_marks=True)))
    return EXIT_OK


def _cmd_serve(args: argparse.Namespace) -> int:
    from dramafetch.web.server import run_server  # lazy: the web package is optional at runtime

    discovery_options = _discovery_options(args)
    download_options = _download_options(args)
    token: str | None = args.token  # the flag, else DRAMAFETCH_TOKEN; checked by _validate
    try:
        server = run_server(
            host=args.host.strip(),
            port=args.port,
            out_dir=download_options.out_dir,
            discovery_options=discovery_options,
            download_options=download_options,
            token=token,
            serve_forever=False,
        )
    except (OSError, ValueError) as exc:  # port in use, unknown host, unsupported address family
        _stderr(f"error: cannot start the web UI on {args.host}:{args.port}: {exc}")
        return EXIT_ERROR
    bound_host, bound_port = str(server.server_address[0]), int(server.server_address[1])
    shown_host = f"[{bound_host}]" if ":" in bound_host else bound_host
    # Announced only after the bind succeeded, with the port actually bound (--port 0 picks one).
    token_note = "token: set" if token is not None else "token: none (loopback only)"
    _stderr(
        f"DramaFetch web UI on http://{shown_host}:{bound_port}/ — downloads go to "
        f"{download_options.out_dir}; {token_note} (Ctrl+C to stop)"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return EXIT_OK


# --------------------------------------------------------------------------- output helpers


def _printable(text: str) -> str:
    """``text`` without control characters (see ``_CONTROL_CHARS_RE``); safe for one terminal
    line. Applied to everything TikTok or yt-dlp may have written: titles, names, messages."""
    return _CONTROL_CHARS_RE.sub("", text)


def _stream_is_utf8(stream: Any) -> bool:
    """Whether the text stream encodes UTF-8 (so any title can be written to it as is)."""
    encoding = getattr(stream, "encoding", None)
    if not encoding:
        return False
    try:
        return codecs.lookup(encoding).name == "utf-8"
    except LookupError:
        return False


def _tolerate_encoding_errors(stream: Any) -> None:
    """Make a non-UTF-8 text stream escape what it cannot encode instead of raising.

    TikTok titles are frequently CJK while a redirected or piped stdout on Windows defaults to the
    ANSI code page (cp1252), so without this every ``info``/``download``/``video`` run with such a
    title would die with UnicodeEncodeError. ``backslashreplace`` keeps the information
    (``\\u9738``) rather than printing ``?``; streams without ``reconfigure`` are left alone.
    """
    if _stream_is_utf8(stream):
        return
    reconfigure = getattr(stream, "reconfigure", None)
    if reconfigure is None:
        return
    try:
        reconfigure(errors="backslashreplace")
    except (ValueError, TypeError, OSError):  # a closed or exotic stream: nothing to be done
        return


def _stderr(message: str) -> None:
    print("\n".join(_printable(line) for line in message.split("\n")), file=sys.stderr, flush=True)


def _format_duration(seconds: int | None) -> str:
    if seconds is None:
        return "-"
    return f"{seconds // 60}:{seconds % 60:02d}"


def _truncate(text: str, width: int) -> str:
    if len(text) <= width:
        return text
    return text[: max(width - 1, 1)] + "…"


def _print_series_table(series: Series, target_dir: Path) -> None:
    episodes = sorted(series.episodes, key=lambda episode: episode.number)
    count = len(episodes)
    header = f"Series: {_printable(series.display_name)} [{series.series_id}] — {count} episode"
    header += "s listed" if count != 1 else " listed"
    if series.total_hint is not None:
        header += f" (TikTok announces {series.total_hint})"
    print(header)
    print(f"Output: {_printable(str(target_dir))}")
    print()
    titles = {episode.item_id: _printable(episode.title) for episode in episodes}
    id_width = max(7, max((len(episode.item_id) for episode in episodes), default=7))
    title_width = min(50, max(5, max((len(title) for title in titles.values()), default=5)))
    print(f"{'#':>4}  {'item id':<{id_width}}  {'duration':>8}  {'title':<{title_width}}  status")
    for episode in episodes:
        status = "free" if not episode.locked else "locked: " + "; ".join(episode.lock_hints)
        print(
            f"{episode.number:>4}  {_printable(episode.item_id):<{id_width}}  "
            f"{_format_duration(episode.duration_s):>8}  "
            f"{_truncate(titles[episode.item_id], title_width):<{title_width}}  "
            f"{_printable(status)}"
        )
    if series.warnings:
        print()
        print("Warnings:")
        for warning in series.warnings:
            print(f"  - {_printable(warning)}")


def _print_result(result: DownloadResult) -> None:
    detail = str(result.path) if result.path is not None else result.message
    print(
        _printable(f"E{result.episode.number:02d}  {result.status.value:<22} {detail}"), flush=True
    )


def _summary_line(results: list[DownloadResult]) -> str:
    counts = engine.summarize(results)
    if not counts:
        return "Summary: nothing to do"
    return "Summary: " + ", ".join(f"{count} {status}" for status, count in counts.items())


def _format_seconds(seconds: float) -> str:
    return f"{seconds:.0f} s" if seconds >= 1 else f"{seconds:.1f} s"


class _RunPrinter:
    """Prints one line per result on stdout and, on stderr, every pause as it happens and the
    reason the run stopped early (once), so that a quiet terminal is never a stuck one."""

    def __init__(self) -> None:
        self._downloads = 0
        self._stopped = False

    def result(self, result: DownloadResult) -> None:
        _print_result(result)
        stopped = result.message.startswith(engine.STOPPED_PREFIX)
        if result.status not in engine.NO_NETWORK_STATUSES and not stopped:
            self._downloads += 1
        if stopped and not self._stopped:
            self._stopped = True
            _stderr(f"  … {result.message}")

    def pause(self, kind: str, seconds: float) -> None:
        if kind == "rest":
            _stderr(f"  … resting {_format_seconds(seconds)} after {self._downloads} downloads")
        else:
            _stderr(f"  … pausing {_format_seconds(seconds)}")


def describe_pacing(options: DownloadOptions | None = None) -> str:
    """One line with the pacing in force (the defaults when ``options`` is None), e.g.
    ``4-9 s between episodes, 60-120 s rest every 10; stop after 3 failures / 403 / 429`` (the
    ranges are printed with an en dash, as in the README)."""
    pacing = options if options is not None else DownloadOptions()
    if pacing.pace == "human":
        between = (
            f"human pace (about one episode's length, at least {pacing.delay_min_s:g} s) "
            "between episodes"
        )
    else:
        between = f"{_describe_range(pacing.delay_min_s, pacing.delay_max_s)} s between episodes"
    if pacing.rest_every > 0:
        rest = (
            f"{_describe_range(pacing.rest_min_s, pacing.rest_max_s)} s rest every "
            f"{pacing.rest_every}"
        )
    else:
        rest = "no long rests"
    if pacing.max_consecutive_failures > 0:
        noun = "failure" if pacing.max_consecutive_failures == 1 else "failures"
        stop = f"stop after {pacing.max_consecutive_failures} {noun} / 403 / 429"
    else:
        stop = "stop on 403 / 429"
    return f"{between}, {rest}; {stop}"


def _describe_range(low: float, high: float) -> str:
    return f"{low:g}" if low == high else f"{low:g}–{high:g}"  # noqa: RUF001 - a range, as in the README


# --------------------------------------------------------------------------- doctor


@dataclass
class DoctorCheck:
    """One environment fact: ``state`` is ``ok`` (check), ``fail`` (cross) or ``skip`` (dash)."""

    name: str
    state: str
    detail: str

    def as_dict(self) -> dict[str, str]:
        return {"name": self.name, "state": self.state, "detail": self.detail}


def doctor_checks(
    *,
    browser_channel: str | None = None,
    browser_path: Path | None = None,
    cookies_file: Path | None = None,
) -> list[DoctorCheck]:
    """The facts behind ``dramafetch doctor`` (also served by the web UI as JSON). Never raises,
    never reveals cookie values — only counts and the names ``sessionid``/``sid_tt``."""
    return [
        _check_python(),
        _check_yt_dlp(),
        _check_curl_cffi(),
        _check_playwright(),
        _check_browser(browser_channel, browser_path),
        _check_ffmpeg(),
        _check_cookies(cookies_file),
    ]


def format_doctor(checks: list[DoctorCheck], *, ascii_marks: bool = False) -> list[str]:
    """One line per check: ``✓ name: detail``."""
    marks = _ASCII_MARKS if ascii_marks else _MARKS
    return [f"{marks[check.state]} {check.name}: {check.detail}" for check in checks]


def _check_python() -> DoctorCheck:
    version = platform.python_version()
    state = "ok" if sys.version_info >= (3, 11) else "fail"
    detail = f"Python {version}" + ("" if state == "ok" else " (3.11 or newer is required)")
    return DoctorCheck("python", state, detail)


def _check_yt_dlp() -> DoctorCheck:
    try:
        from yt_dlp.version import __version__ as yt_dlp_version
    except Exception as exc:
        return DoctorCheck(
            "yt-dlp", "fail", f"not importable ({exc.__class__.__name__}): pip install yt-dlp"
        )
    return DoctorCheck("yt-dlp", "ok", f"yt-dlp {yt_dlp_version}")


def _check_curl_cffi() -> DoctorCheck:
    if curl_cffi_available():
        return DoctorCheck(
            "curl_cffi", "ok", "importable: yt-dlp impersonates Chrome's TLS fingerprint"
        )
    return DoctorCheck(
        "curl_cffi",
        "skip",
        "not installed: impersonation off (optional: pip install 'dramafetch[impersonate]')",
    )


def _check_playwright() -> DoctorCheck:
    try:
        import playwright  # noqa: F401 - importability is the check
    except Exception as exc:
        return DoctorCheck(
            "playwright",
            "fail",
            f"not importable ({exc.__class__.__name__}): pip install playwright",
        )
    return DoctorCheck("playwright", "ok", "importable (browser discovery available)")


def _check_browser(browser_channel: str | None, browser_path: Path | None) -> DoctorCheck:
    if browser_path is not None:
        if browser_path.is_file():
            return DoctorCheck("browser", "ok", f"--browser-path {browser_path}")
        return DoctorCheck("browser", "fail", f"--browser-path {browser_path} does not exist")
    if browser_channel:
        return DoctorCheck(
            "browser",
            "skip",
            f"channel {browser_channel!r}: Playwright locates the installed browser at launch "
            "(not verified here)",
        )
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright_instance:
            executable = Path(playwright_instance.chromium.executable_path)
    except Exception as exc:
        return DoctorCheck(
            "browser",
            "fail",
            f"Playwright could not start ({exc.__class__.__name__}); {BROWSER_INSTALL_HINT}",
        )
    if executable.exists():
        return DoctorCheck("browser", "ok", f"Playwright Chromium at {executable}")
    return DoctorCheck(
        "browser", "fail", f"Playwright Chromium missing ({executable}); {BROWSER_INSTALL_HINT}"
    )


def _check_ffmpeg() -> DoctorCheck:
    found = shutil.which("ffmpeg")
    if found:
        return DoctorCheck("ffmpeg", "ok", f"{found} (optional)")
    return DoctorCheck(
        "ffmpeg",
        "skip",
        "not on PATH (optional: TikTok episodes are single progressive files, nothing to merge)",
    )


def _check_cookies(cookies_file: Path | None) -> DoctorCheck:
    if cookies_file is None:
        return DoctorCheck(
            "cookies",
            "skip",
            "no --cookies given; TikTok usually needs a logged-in session to list episodes",
        )
    if not cookies_file.is_file():
        return DoctorCheck("cookies", "fail", f"{cookies_file} not found")
    try:
        stat = cookies_file.stat()
        tiktok_lines, names = _scan_cookie_names(cookies_file)
        problems = cookie_file_problems(cookies_file)
    except OSError as exc:
        return DoctorCheck("cookies", "fail", f"{cookies_file} unreadable: {exc.strerror}")
    age_days = max(0.0, (time.time() - stat.st_mtime) / 86400)
    detail = (
        f"{cookies_file.name}: {stat.st_size} bytes, {age_days:.1f} days old, "
        f"{tiktok_lines} tiktok.com cookie line(s)"
    )
    if problems:
        # Line numbers only: yt-dlp would skip these lines with a warning that quotes them whole,
        # cookie values included, so DramaFetch refuses to pass such a file on until it is fixed.
        return DoctorCheck(
            "cookies",
            "fail",
            f"{detail}; malformed ({'; '.join(problems)}): yt-dlp would print those lines, "
            "cookie values included — fix or re-export the file",
        )
    if tiktok_lines == 0:
        return DoctorCheck("cookies", "fail", detail + "; no tiktok.com cookies in the file")
    if not names:
        return DoctorCheck(
            "cookies",
            "fail",
            detail
            + "; no sessionid/sid_tt cookie: log in to TikTok in the browser and export again",
        )
    return DoctorCheck(
        "cookies", "ok", detail + ", session cookie names present: " + ", ".join(sorted(names))
    )


def _scan_cookie_names(path: Path) -> tuple[int, set[str]]:
    """Count ``tiktok.com`` lines of a Netscape cookies file and collect the session cookie NAMES
    found; values are never read into anything that is returned."""
    tiktok_lines = 0
    names: set[str] = set()
    with path.open(encoding="utf-8", errors="replace") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if line.startswith("#HttpOnly_"):
                line = line[len("#HttpOnly_") :]
            if not line or line.startswith("#"):
                continue
            fields = line.split("\t")
            if len(fields) < 7:
                fields = line.split()
            if len(fields) < 7:
                continue
            domain, name = fields[0].lower(), fields[5]
            if "tiktok.com" not in domain:
                continue
            tiktok_lines += 1
            if name in SESSION_COOKIE_NAMES:
                names.add(name)
    return tiktok_lines, names


# --------------------------------------------------------------------------- entry point


def _system_exit_code(exc: SystemExit) -> int:
    if exc.code is None:
        return EXIT_OK
    if isinstance(exc.code, int):
        return exc.code
    return EXIT_ERROR


def main(argv: list[str] | None = None) -> int:
    """Run the CLI; returns the exit code instead of raising SystemExit."""
    _tolerate_encoding_errors(sys.stdout)
    _tolerate_encoding_errors(sys.stderr)
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
        _validate(args, parser)
    except SystemExit as exc:
        return _system_exit_code(exc)
    command: Callable[[argparse.Namespace], int] = args.func
    try:
        return command(args)
    except UnsupportedUrlError as exc:
        _stderr(f"error: {exc}")
        return EXIT_USAGE
    except LoginRequiredError as exc:
        _stderr(f"error: {exc}\n{LOGIN_HELP}")
        return EXIT_LOGIN
    except ChallengeError as exc:
        _stderr(f"error: {exc}\n{CHALLENGE_HELP}")
        return EXIT_DISCOVERY
    except RateLimitedError as exc:
        _stderr(f"error: {exc}")
        return EXIT_RATE_LIMITED
    except DiscoveryError as exc:
        _stderr(f"error: {exc}")
        return EXIT_DISCOVERY
    except DramaFetchError as exc:
        _stderr(f"error: {exc}")
        return EXIT_ERROR
    except KeyboardInterrupt:
        _stderr(
            "\ninterrupted: results so far are recorded in dramafetch.json; "
            "run the same command again to resume"
        )
        return EXIT_INTERRUPTED


def doctor_as_dicts(
    *,
    browser_channel: str | None = None,
    browser_path: Path | None = None,
    cookies_file: Path | None = None,
) -> list[dict[str, Any]]:
    """JSON-ready doctor facts for the web UI (same checks as the ``doctor`` command)."""
    checks = doctor_checks(
        browser_channel=browser_channel, browser_path=browser_path, cookies_file=cookies_file
    )
    return [check.as_dict() for check in checks]
