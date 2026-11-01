#!/usr/bin/env python3
"""DramaFetch's upstream watch: what changed in the projects its downloads depend on, read only
from primary sources, printed as one Markdown report for the maintenance agents.

Run it with any Python 3.11+ (standard library only), or through
``.claude/scripts/dramafetch-watch.sh`` from the repository root::

    python3 DramaFetch/tools/upstream_watch.py --python DramaFetch/.venv/bin/python

What it reads — public, primary sources, all reachable from the Claude Code cloud sessions
(measured 2026-11-01):

- PyPI's JSON API: ``https://pypi.org/pypi/<name>/json`` (the latest release and its upload
  date) and ``https://pypi.org/pypi/<name>/<version>/json`` (the ``vulnerabilities`` of that exact
  release, from the OSV database — the data ``pip-audit`` reads by default), for every
  distribution installed in DramaFetch's virtual environment;
- yt-dlp's own repository files, raw: ``Changelog.md`` (the entries about TikTok and the security
  notes of the releases newer than the installed one) and ``yt_dlp/extractor/tiktok.py`` at the
  installed version's git tag (``yt_dlp.version.__version__`` of the inspected interpreter, which
  keeps the zeros PyPI's version drops: ``2026.08.19``, not ``2026.8.19``) and at ``master`` (how
  many lines changed, and which of the names DramaFetch reads in TikTok's payload the extractor
  stopped or started using);
- Google's Chrome version history API: the current Stable version per desktop platform, next to
  the extension's ``minimum_chrome_version``.

It never contacts TikTok and never installs anything. A source that does not answer is listed
under "Unreachable" and the report goes on (one failure per host is enough: that host is skipped
for the rest of the run). Exit status 0 whenever a report was printed, 2 for bad arguments.
Whatever could not be checked — a host that did not answer, a direct dependency not installed or
not checked, the extractor not compared, Chrome Stable not read — is an Attention item too, so
"nothing new" is printed only when everything was compared and nothing changed: a skipped check
is never an all-clear.

The report is evidence, not a decision: the agents still read the cited sources, and nothing
found upstream may move the line in ``DramaFetch/CLAUDE.md`` (yt-dlp's TikTok extractor, for
instance, solves TikTok's JS challenges; DramaFetch's guard, ``downloader.YtDlpChallengeGuard``,
stops yt-dlp at one).
"""

from __future__ import annotations

import argparse
import ast
import difflib
import http.client
import json
import re
import subprocess
import sys
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

#: GET a URL and return its body; raises OSError / http.client.HTTPException when it fails.
Fetch = Callable[[str], bytes]

USER_AGENT = "DramaFetch-upstream-watch/1 (+https://github.com/brunocarbone98/projects)"
TIMEOUT_S = 20
PYPI_LATEST = "https://pypi.org/pypi/{name}/json"
PYPI_RELEASE = "https://pypi.org/pypi/{name}/{version}/json"
YTDLP_RAW = "https://raw.githubusercontent.com/yt-dlp/yt-dlp/{ref}/{path}"
YTDLP_CHANGELOG = "Changelog.md"
YTDLP_TIKTOK = "yt_dlp/extractor/tiktok.py"
CHROME_STABLE = (
    "https://versionhistory.googleapis.com/v1/chrome/platforms/{platform}"
    "/channels/stable/versions?pageSize=1"
)
CHROME_PLATFORMS = ("win", "mac", "linux")
#: The only hosts this tool may contact (a test holds every URL template to it).
ALLOWED_HOSTS = frozenset(
    {"pypi.org", "raw.githubusercontent.com", "versionhistory.googleapis.com"}
)
#: DramaFetch's direct dependencies, the ones whose new releases matter for the downloads.
DIRECT = ("yt-dlp", "playwright", "mutagen", "curl-cffi")
#: The DramaFetch files whose string literals name what it reads in TikTok's payload and pages.
WATCHED_SOURCES = (
    "src/dramafetch/catalog.py",
    "src/dramafetch/discovery/browser.py",
    "src/dramafetch/urls.py",
)
_LITERAL = re.compile(r"[A-Za-z_][A-Za-z0-9_]{2,}|/api/[A-Za-z0-9_/]+")
_HEADING = re.compile(r"^###\s+(\S+)\s*$")
_BULLET = re.compile(r"^(\s*)[-*]\s+(.*\S)\s*$")
_COMPONENT = re.compile(r"^\*\*([^*]+)\*\*(?::\s*(.*))?$")
_SECURITY = re.compile(r"\bsecurity\b|\bCVE-\d{4}-\d+|\bGHSA-[0-9a-z]{4}-", re.IGNORECASE)
_MAX_TEXT = 400


@dataclass(frozen=True)
class Vulnerability:
    """One entry of PyPI's ``vulnerabilities`` list for a release (withdrawn ones are dropped)."""

    id: str
    aliases: tuple[str, ...]
    fixed_in: tuple[str, ...]
    link: str
    summary: str


@dataclass(frozen=True)
class ChangelogEntry:
    """One changelog line of a yt-dlp release, as written there (links kept: they cite)."""

    version: str
    text: str


@dataclass
class Report:
    """What one run gathered: the Markdown sections, the URLs read, what did not answer."""

    attention: list[str] = field(default_factory=list)
    #: what could not be checked (a host that did not answer, a dependency not installed or not
    #: checked, a comparison not made): Attention items too — never an all-clear
    gaps: list[str] = field(default_factory=list)
    sections: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    unreachable: list[str] = field(default_factory=list)
    failed_hosts: set[str] = field(default_factory=set)


# --------------------------------------------------------------------------- pure helpers


def normalize(name: str) -> str:
    """A distribution name as PyPI compares them (PEP 503)."""
    return re.sub(r"[-_.]+", "-", name).lower()


def version_key(version: str) -> tuple[int, ...]:
    """The leading numeric parts of a version: yt-dlp's dates (``2026.10.26``, ``2026.10.26.1``)
    and dotted versions compare as tuples; a part with letters ends the key (``1.64.1rc1`` ->
    ``(1, 64, 1)``)."""
    parts: list[int] = []
    for piece in version.strip().split("."):
        match = re.match(r"\d+", piece)
        if match is None:
            break
        parts.append(int(match.group()))
        if match.end() != len(piece):
            break
    return tuple(parts)


def tag_of(version: str) -> str:
    """yt-dlp's git tag for one of its release versions: PEP 440 (PyPI, the wheel's metadata)
    drops the zeros of its date — ``2026.8.19`` — while the tag keeps them, ``2026.08.19``. The
    month and the day get two digits, a further part (``2026.08.19.1``) stays as it is; anything
    else is returned unchanged."""
    parts = version.strip().split(".")
    if len(parts) < 3 or not all(part.isdigit() for part in parts[:3]):
        return version.strip()
    return ".".join([parts[0], f"{int(parts[1]):02d}", f"{int(parts[2]):02d}", *parts[3:]])


def one_line(text: str, limit: int = _MAX_TEXT) -> str:
    """``text`` on one line, cut at ``limit`` characters."""
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def pyproject_floors(text: str) -> dict[str, str]:
    """The ``name>=version`` floors of ``pyproject.toml``'s dependencies and extras."""
    project = tomllib.loads(text).get("project", {})
    specs: list[str] = list(project.get("dependencies", []))
    for extra in project.get("optional-dependencies", {}).values():
        specs.extend(extra)
    floors: dict[str, str] = {}
    for spec in specs:
        match = re.match(
            r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*>=\s*([^,;\s]+)", spec
        )
        if match is not None:
            floors[normalize(match.group(1))] = match.group(2)
    return floors


def vulnerabilities_of(release: Any) -> list[Vulnerability]:
    """The known, not withdrawn vulnerabilities of one release (PyPI's per-version JSON)."""
    found: list[Vulnerability] = []
    entries = release.get("vulnerabilities") if isinstance(release, dict) else None
    for entry in entries or []:
        if not isinstance(entry, dict) or entry.get("withdrawn"):
            continue
        found.append(
            Vulnerability(
                id=str(entry.get("id") or "?"),
                aliases=tuple(str(alias) for alias in entry.get("aliases") or ()),
                fixed_in=tuple(str(version) for version in entry.get("fixed_in") or ()),
                link=str(entry.get("link") or ""),
                summary=one_line(str(entry.get("summary") or entry.get("details") or ""), 160),
            )
        )
    return found


def _releases(text: str, newer_than: str) -> Iterable[tuple[str, str]]:
    """``(version, line)`` for every line of the changelog releases newer than ``newer_than``."""
    floor = version_key(newer_than)
    version: str | None = None
    for line in text.splitlines():
        heading = _HEADING.match(line)
        if heading is not None:
            version = heading.group(1)
            continue
        if version is not None and version_key(version) > floor:
            yield version, line


def changelog_entries(
    text: str, *, newer_than: str, component: str = "tiktok"
) -> list[ChangelogEntry]:
    """The entries about ``component`` (matched case-insensitively inside a bullet's bold
    component, e.g. ``**tiktok**`` or ``**tiktok**: live``) in the releases newer than
    ``newer_than``, newest first as the changelog lists them: an inline entry
    ``**tiktok**: [Fix …](…)`` and every nested bullet under a bare ``**tiktok**`` bullet."""
    wanted = component.lower()
    entries: list[ChangelogEntry] = []
    parent: tuple[str, int] | None = None  # (component name, indentation) whose children we take
    current = ""
    for version, line in _releases(text, newer_than):
        if version != current:
            current, parent = version, None
        bullet = _BULLET.match(line)
        if bullet is None:
            if line.lstrip().startswith("#"):
                parent = None
            continue
        indent = len(bullet.group(1).expandtabs(4))
        body = bullet.group(2)
        if parent is not None:
            if indent > parent[1]:
                entries.append(ChangelogEntry(version, one_line(f"{parent[0]}: {body}")))
                continue
            parent = None
        found = _COMPONENT.match(body)
        if found is None or wanted not in found.group(1).lower():
            continue
        if found.group(2):
            entries.append(ChangelogEntry(version, one_line(f"{found.group(1)}: {found.group(2)}")))
        else:
            parent = (found.group(1), indent)
    return entries


def security_notes(text: str, *, newer_than: str) -> list[ChangelogEntry]:
    """The changelog bullets that mention security, a CVE or a GHSA advisory, in the releases
    newer than ``newer_than``."""
    notes: list[ChangelogEntry] = []
    for version, line in _releases(text, newer_than):
        bullet = _BULLET.match(line)
        if bullet is not None and _SECURITY.search(bullet.group(2)):
            notes.append(ChangelogEntry(version, one_line(bullet.group(2))))
    return notes


def watched_literals(sources: Iterable[str]) -> set[str]:
    """The string constants of DramaFetch's payload readers that look like a field name or an
    API path (``itemStruct``, ``playAddr``, ``/api/drama/detail/`` …)."""
    names: set[str] = set()
    for source in sources:
        for node in ast.walk(ast.parse(source)):
            if (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and _LITERAL.fullmatch(node.value)
            ):
                names.add(node.value)
    return names


def quoted_in(source: str, literal: str) -> bool:
    """Whether ``source`` holds ``literal`` as a quoted string (``'x'`` or ``"x"``)."""
    return re.search(r"(['\"])" + re.escape(literal) + r"\1", source) is not None


def literal_drift(watched: Iterable[str], old: str, new: str) -> tuple[list[str], list[str]]:
    """``(gone, added)``: the watched literals the extractor quoted in ``old`` but not in ``new``,
    and the other way round."""
    names = sorted(set(watched))
    gone = [name for name in names if quoted_in(old, name) and not quoted_in(new, name)]
    added = [name for name in names if quoted_in(new, name) and not quoted_in(old, name)]
    return gone, added


def changed_lines(old: str, new: str) -> int:
    """How many lines a unified diff of ``old`` -> ``new`` adds or removes (trailing blanks
    ignored)."""
    diff = difflib.unified_diff(
        [line.rstrip() for line in old.splitlines()],
        [line.rstrip() for line in new.splitlines()],
        lineterm="",
        n=0,
    )
    return sum(1 for line in diff if line[:1] in "+-" and not line.startswith(("+++", "---")))


# ------------------------------------------------------------------------------ network


def http_fetch(url: str) -> bytes:
    """The real fetch: one GET with a plain user agent and a timeout (HTTPS_PROXY honoured)."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
        body: bytes = response.read()
    return body


def fetch_text(fetch: Fetch, url: str, report: Report) -> str | None:
    """The body of ``url`` as text, or None (listed under Unreachable; a host that failed once is
    not asked again in this run). A 404 is an answer, not an outage: None, nothing listed."""
    host = urllib.parse.urlsplit(url).hostname or "?"
    if host not in ALLOWED_HOSTS:
        raise ValueError(f"{host} is not a source this tool may read")
    if host in report.failed_hosts:
        return None
    try:
        text = fetch(url).decode("utf-8")
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        report.failed_hosts.add(host)
        report.unreachable.append(f"{url} (HTTP {error.code})")
        return None
    except (OSError, ValueError, http.client.HTTPException) as error:
        report.failed_hosts.add(host)
        report.unreachable.append(f"{url} ({type(error).__name__}: {one_line(str(error), 120)})")
        return None
    report.sources.append(url)
    return text


def fetch_json(fetch: Fetch, url: str, report: Report) -> Any:
    """``fetch_text`` parsed as JSON, or None."""
    text = fetch_text(fetch, url, report)
    if text is None:
        return None
    try:
        return json.loads(text)
    except ValueError:
        report.unreachable.append(f"{url} (not JSON)")
        return None


def installed_distributions(python: Path) -> dict[str, str]:
    """``{normalized name: version}`` of every distribution the interpreter ``python`` sees."""
    code = (
        "import importlib.metadata as m, json; print(json.dumps(sorted({(d.metadata['Name'], "
        "d.version) for d in m.distributions() if d.metadata['Name']})))"
    )
    done = subprocess.run(
        [str(python), "-c", code], capture_output=True, text=True, check=True, timeout=120
    )
    return {normalize(name): version for name, version in json.loads(done.stdout)}


def installed_ytdlp_tag(python: Path) -> str | None:
    """``yt_dlp.version.__version__`` as the interpreter ``python`` sees it — the git tag of the
    installed release, zeros kept (``2026.08.19``) — or None when it cannot be read."""
    code = "import yt_dlp.version as v; print(v.__version__)"
    try:
        done = subprocess.run(
            [str(python), "-c", code], capture_output=True, text=True, check=False, timeout=120
        )
    except (OSError, subprocess.SubprocessError):
        return None
    tag = done.stdout.strip()
    return tag if done.returncode == 0 and re.fullmatch(r"[0-9][0-9.]*", tag) else None


# ------------------------------------------------------------------------------- report


def _python_section(
    fetch: Fetch,
    report: Report,
    installed: dict[str, str],
    floors: dict[str, str],
    own_name: str,
) -> None:
    rows = [
        "## Python dependencies",
        "",
        "| Package | Installed | Floor in pyproject.toml | Latest on PyPI | "
        "Known vulnerabilities in the installed version |",
        "| --- | --- | --- | --- | --- |",
    ]
    others: list[str] = []
    checked = total = unchecked_others = 0
    direct = {normalize(name) for name in DIRECT}
    for name in sorted(installed):
        if name == normalize(own_name):
            continue
        version = installed[name]
        release = fetch_json(fetch, PYPI_RELEASE.format(name=name, version=version), report)
        vulns = vulnerabilities_of(release) if release is not None else []
        total += 1
        checked += release is not None
        described = "; ".join(
            f"[{v.id}]({v.link or 'https://osv.dev/vulnerability/' + v.id})"
            + (f" ({', '.join(v.aliases)})" if v.aliases else "")
            + (f", fixed in {', '.join(v.fixed_in)}" if v.fixed_in else ", no fixed version")
            for v in vulns
        )
        if vulns:
            report.attention.append(
                f"{name} {version}: {len(vulns)} known vulnerabilit"
                f"{'y' if len(vulns) == 1 else 'ies'} ({', '.join(v.id for v in vulns)})"
            )
        if name not in direct:
            if vulns:
                others.append(f"- {name} {version}: {described}")
            unchecked_others += release is None
            continue
        if release is None:
            report.gaps.append(f"{name} {version}: not checked against PyPI's vulnerability data")
        latest = fetch_json(fetch, PYPI_LATEST.format(name=name), report)
        latest_text = "?"
        if isinstance(latest, dict):
            newest = str(latest.get("info", {}).get("version") or "?")
            uploads = [str(u.get("upload_time", ""))[:10] for u in latest.get("urls") or []]
            latest_text = newest + (f" ({uploads[0]})" if uploads and uploads[0] else "")
            if version_key(newest) > version_key(version):
                report.attention.append(f"{name} {newest} is out (installed {version})")
        else:
            report.gaps.append(f"{name}: its latest release on PyPI not read")
        rows.append(
            f"| {name} | {version} | {floors.get(name, '-')} | {latest_text} | "
            f"{described or ('none' if release is not None else 'not checked')} |"
        )
    for name in (normalize(name) for name in DIRECT):
        if name not in installed:
            rows.append(f"| {name} | not installed | {floors.get(name, '-')} | - | - |")
            report.gaps.append(
                f"{name}: not installed in the inspected environment "
                f"(floor {floors.get(name, '-')}): nothing compared"
            )
    if unchecked_others:
        report.gaps.append(
            f"{unchecked_others} other installed distribution{'' if unchecked_others == 1 else 's'}"
            " not checked against PyPI's vulnerability data"
        )
    rows += ["", "### Other installed distributions with known vulnerabilities", ""]
    rows += others or ["none"]
    rows += ["", f"{checked} of {total} installed distributions checked against PyPI."]
    report.sections.append("\n".join(rows))


def _ytdlp_section(
    fetch: Fetch,
    report: Report,
    installed: str | None,
    watched: set[str],
    tag: str | None = None,
) -> None:
    """The yt-dlp section; ``tag`` is the installed release's git tag (``tag_of(installed)`` when
    not given: PyPI's version drops the zeros the tag keeps)."""
    rows = ["## yt-dlp"]
    if installed is None:
        rows.append("\nyt-dlp is not installed in the inspected environment: nothing compared.")
        report.sections.append("\n".join(rows))
        return
    ref = tag or tag_of(installed)
    raw_host = urllib.parse.urlsplit(YTDLP_RAW).hostname or "?"
    changelog = fetch_text(fetch, YTDLP_RAW.format(ref="master", path=YTDLP_CHANGELOG), report)
    if changelog is None:
        rows += ["", "### Changelog", "", "not read"]
        report.gaps.append("yt-dlp's changelog not read: its TikTok entries and security notes")
    else:
        entries = changelog_entries(changelog, newer_than=installed)
        notes = security_notes(changelog, newer_than=installed)
        rows += ["", f"### Changelog entries about TikTok since {installed}", ""]
        rows += [f"- {e.version} — {e.text}" for e in entries] or ["none"]
        rows += ["", f"### Security notes since {installed}", ""]
        rows += [f"- {n.version} — {n.text}" for n in notes] or ["none"]
        if entries:
            report.attention.append(
                f"yt-dlp's changelog has {len(entries)} TikTok entr"
                f"{'y' if len(entries) == 1 else 'ies'} newer than {installed}"
            )
        if notes:
            report.attention.append(f"yt-dlp's changelog has security notes newer than {installed}")
    old = fetch_text(fetch, YTDLP_RAW.format(ref=ref, path=YTDLP_TIKTOK), report)
    new = fetch_text(fetch, YTDLP_RAW.format(ref="master", path=YTDLP_TIKTOK), report)
    rows += ["", f"### The TikTok extractor: {ref} -> master", ""]
    if old is None or new is None:
        if raw_host in report.failed_hosts:
            why = f"{raw_host} did not answer"
        else:  # an answer all the same: no such file at that ref
            why = f"no {YTDLP_TIKTOK} at {'tag ' + ref if old is None else 'master'}"
        rows.append(f"not compared ({why})")
        report.gaps.append(f"yt-dlp's TikTok extractor not compared: {why}")
    else:
        gone, added = literal_drift(watched, old, new)
        count = changed_lines(old, new)
        rows += [
            f"- {count} changed lines.",
            "- Names DramaFetch reads that the extractor quoted at "
            f"{ref} but no longer quotes at master: {', '.join(gone) or 'none'}.",
            "- Names DramaFetch reads that the extractor quotes at master but did not at "
            f"{ref}: {', '.join(added) or 'none'}.",
        ]
        if count:
            report.attention.append(
                f"yt-dlp's TikTok extractor changed ({count} lines) since {ref}"
            )
        if gone:
            report.attention.append(
                f"the TikTok extractor stopped using names DramaFetch reads: {', '.join(gone)}"
            )
    report.sections.append("\n".join(rows))


def _chrome_section(fetch: Fetch, report: Report, minimum: str | None) -> None:
    rows = ["## Chrome Stable", "", "| Platform | Version |", "| --- | --- |"]
    unread: list[str] = []
    for platform in CHROME_PLATFORMS:
        data = fetch_json(fetch, CHROME_STABLE.format(platform=platform), report)
        try:
            version = str(data["versions"][0]["version"])
        except (TypeError, KeyError, IndexError):
            version = "not read"
            unread.append(platform)
        rows.append(f"| {platform} | {version} |")
    if unread:
        report.gaps.append(f"Chrome Stable not read for {', '.join(unread)}")
    rows += ["", f"The extension's `minimum_chrome_version`: {minimum or 'not set'}."]
    report.sections.append("\n".join(rows))


def build_report(
    project: Path,
    *,
    installed: dict[str, str],
    fetch: Fetch,
    now: datetime,
    ytdlp_tag: str | None = None,
) -> str:
    """The whole Markdown report for the DramaFetch checkout ``project``; ``ytdlp_tag`` is the
    installed yt-dlp's git tag (:func:`installed_ytdlp_tag`; else derived from its version).
    Attention lists what changed, then what could not be checked; "nothing new" only when it is
    empty."""
    report = Report()
    pyproject = (project / "pyproject.toml").read_text(encoding="utf-8")
    own_name = str(tomllib.loads(pyproject).get("project", {}).get("name", "dramafetch"))
    _python_section(fetch, report, installed, pyproject_floors(pyproject), own_name)
    sources = [
        (project / path).read_text(encoding="utf-8")
        for path in WATCHED_SOURCES
        if (project / path).is_file()
    ]
    _ytdlp_section(fetch, report, installed.get("yt-dlp"), watched_literals(sources), ytdlp_tag)
    manifest_path = project / "extension" / "manifest.json"
    minimum = None
    if manifest_path.is_file():
        minimum = json.loads(manifest_path.read_text(encoding="utf-8")).get(
            "minimum_chrome_version"
        )
    _chrome_section(fetch, report, None if minimum is None else str(minimum))
    unreachable_urls = (item.split(" ", 1)[0] for item in report.unreachable)
    silent = sorted({urllib.parse.urlsplit(url).hostname or "?" for url in unreachable_urls})
    if silent:
        report.gaps.insert(
            0,
            f"not an all-clear: {', '.join(silent)} did not answer — see Unreachable; what "
            f"{'it serves' if len(silent) == 1 else 'they serve'} was not compared",
        )
    stamp = now.strftime("%Y-%m-%d %H:%M UTC")
    head = [
        f"# DramaFetch upstream watch — {stamp}",
        "",
        "Primary sources only: PyPI's JSON API, yt-dlp's repository files, Google's Chrome "
        "version history. TikTok is never contacted. This is evidence, not a decision.",
        "",
        "## Attention",
        "",
        *([f"- {item}" for item in [*report.attention, *report.gaps]] or ["nothing new"]),
    ]
    tail = [
        "## Unreachable",
        "",
        *([f"- {item}" for item in report.unreachable] or ["none"]),
        "",
        f"## Sources read ({stamp})",
        "",
        *[f"- <{url}>" for url in report.sources],
    ]
    return "\n\n".join(["\n".join(head), *report.sections, "\n".join(tail)]) + "\n"


def main(argv: Sequence[str] | None = None, fetch: Fetch = http_fetch) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    here = Path(__file__).resolve().parent.parent
    parser.add_argument(
        "--project", type=Path, default=here, help="the DramaFetch directory (default: this one)"
    )
    parser.add_argument(
        "--python",
        type=Path,
        default=None,
        help="the interpreter of DramaFetch's environment (default: <project>/.venv/bin/python, "
        "else this interpreter)",
    )
    args = parser.parse_args(argv)
    project: Path = args.project.resolve()
    if not (project / "pyproject.toml").is_file():
        parser.error(f"{project} has no pyproject.toml")
    python: Path = args.python or project / ".venv" / "bin" / "python"
    if not python.exists():
        python = Path(sys.executable)
    installed = installed_distributions(python)
    tag = installed_ytdlp_tag(python) if "yt-dlp" in installed else None
    report = build_report(
        project, installed=installed, fetch=fetch, now=datetime.now(UTC), ytdlp_tag=tag
    )
    sys.stdout.write(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
