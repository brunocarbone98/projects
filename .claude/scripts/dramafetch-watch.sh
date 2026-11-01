#!/usr/bin/env bash
# dramafetch-watch.sh — DramaFetch's upstream watch, one Markdown report on stdout:
#   - every Python distribution installed in DramaFetch/.venv: known vulnerabilities of the
#     installed version (PyPI's per-version JSON, from the OSV database, as pip-audit reads it),
#     and for yt-dlp, playwright, mutagen and curl_cffi the latest release next to the floor in
#     DramaFetch/pyproject.toml;
#   - yt-dlp: the changelog entries about TikTok and the security notes newer than the installed
#     release, and how its TikTok extractor changed between that release and master (including
#     which names DramaFetch reads in TikTok's payload it stopped or started using);
#   - Chrome Stable per desktop platform next to the extension's minimum_chrome_version.
#
# Usage (from anywhere):  .claude/scripts/dramafetch-watch.sh
# Sources: pypi.org, raw.githubusercontent.com/yt-dlp/yt-dlp, versionhistory.googleapis.com —
# primary sources only; TikTok is never contacted. When DramaFetch/.venv is missing it is created
# first (python3 -m venv + pip install -e "DramaFetch[impersonate,dev]") so the versions are the
# ones the checks run with. A source that does not answer is listed under "Unreachable"; the
# script still exits 0 with a report. Exit 2: bad arguments (passed to the tool).
# The logic lives in DramaFetch/tools/upstream_watch.py (standard library only, unit-tested in
# DramaFetch/tests/test_upstream_watch.py).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DF="$ROOT/DramaFetch"

if [[ ! -x "$DF/.venv/bin/python" ]]; then
  echo "dramafetch-watch: creating DramaFetch/.venv (first run)" >&2
  python3 -m venv "$DF/.venv"
  "$DF/.venv/bin/pip" install -q -e "$DF[impersonate,dev]" >&2
fi

exec "$DF/.venv/bin/python" "$DF/tools/upstream_watch.py" --project "$DF" --python "$DF/.venv/bin/python" "$@"
