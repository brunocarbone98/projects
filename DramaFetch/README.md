# DramaFetch

[![CI](https://github.com/brunocarbone98/projects/actions/workflows/ci.yml/badge.svg)](https://github.com/brunocarbone98/projects/actions/workflows/ci.yml)

DramaFetch downloads the episodes of a TikTok short drama that your own TikTok account can already watch — a whole series at a time instead of one video after another — for personal offline viewing. You paste the series URL; it discovers the episode list the way TikTok's own web app does, hands each episode to [yt-dlp](https://github.com/yt-dlp/yt-dlp), paces itself politely, remembers what it already has so interrupted runs resume, and lists (then skips) the episodes that are locked. There is a CLI and a small local web UI; both drive the same engine.

> **Legal notice.** DramaFetch is for personal, offline viewing of episodes that your own TikTok account can already watch. It does not unlock paid episodes and does not bypass DRM or access controls; locked episodes are listed and skipped. Downloading may breach TikTok's Terms of Service, and the videos belong to their creators and studios — you are responsible for how you use this tool.

> **Built without access to TikTok.** This tool was written in a sandbox that cannot reach tiktok.com. Every network-facing piece is thin and injectable, tested against hand-written payload fixtures that follow the documented `item_list` shape and a local fake TikTok server — never against TikTok itself. The first real run is the real test: start with `dramafetch doctor`, then `dramafetch info URL --cookies cookies.txt --dump-raw raw/`, and read [Troubleshooting](#troubleshooting) if the episode list looks wrong.

## How it works

Verified facts (October 2026) that the code depends on. They are also recorded in the docstring of `src/dramafetch/urls.py`; when TikTok changes, update both (see [`CLAUDE.md`](./CLAUDE.md)).

- A series URL looks like `https://www.tiktok.com/shortdrama/episode/7675706520839033876/8`. The long number is the **series id** (TikTok calls it `dramaID` in its API), _not_ a video id; the trailing number is only the 1-based episode you were watching.
- yt-dlp does not recognise `/shortdrama/` URLs ([yt-dlp/yt-dlp#17725](https://github.com/yt-dlp/yt-dlp/issues/17725), open) — that gap is why this tool exists. yt-dlp _does_ download each episode's ordinary video page, `https://www.tiktok.com/@<user>/video/<item_id>`; the `@user` segment is not checked, so `@_` works.
- TikTok's web app lists episodes through `GET /api/drama/episode/item_list/?dramaID=<series_id>&cursor=<c>&count=<n>&…` (plus its usual web parameters and signatures). Each item carries the episode's video id, `dramaInfo.dramaID` and `dramaInfo.DramaVideoData.EpisodeNumber`; episode order comes from `EpisodeNumber`, never from upload time, and items whose `dramaID` differs from the series are dropped. `GET /api/drama/detail/` adds the series name and the announced total, which is how gaps are detected.
- DramaFetch therefore opens the series page in a real Chromium (Playwright), captures those API responses as the page makes them, paginates the way the page does — same request, next `cursor` — and builds the episode list. A static strategy reads the JSON TikTok embeds in the page (`__UNIVERSAL_DATA_FOR_REHYDRATION__`) when that is enough; `--strategy auto` tries static first and falls back to the browser.
- Without a logged-in TikTok session the list endpoints return nothing and the videos have no play address; yt-dlp then reports "No video formats found" or lands on `/login`. A `cookies.txt` exported from your logged-in browser is the normal way to run (see [Cookies](#cookies-you-will-need-them)). Cookie values are never printed, logged, dumped or sent anywhere but TikTok.
- Paid episodes: TikTok sells later episodes for coins. Items that look locked (`isFree=false`, `isLocked`, a price, an empty play address) are listed with those hints and skipped by default. Nothing in DramaFetch unlocks, bypasses or fakes entitlement.
- Politeness: one download at a time, a random 3–7 s pause between episodes, 0.8 s between list pages, and a full stop on HTTP 429 with the advice to wait 30–60 minutes.

## Install

Python 3.11 or newer.

```bash
cd DramaFetch
python -m venv .venv && . .venv/bin/activate
pip install -e ".[impersonate,dev]"   # impersonate: curl_cffi so yt-dlp presents a real browser's TLS fingerprint; dev: pytest, ruff, mypy
playwright install chromium           # the browser that discovers the episode list …
dramafetch doctor                     # … or skip it and use the Chrome/Edge you have: --browser-channel chrome|msedge
```

`ffmpeg` is optional: TikTok episodes are single progressive files, nothing needs merging.

## Cookies (you will need them)

1. Log in to tiktok.com in your browser and open an episode of the series to make sure you can watch it.
2. Export the site's cookies in Netscape `cookies.txt` format with a browser extension such as "Get cookies.txt LOCALLY" (Chrome/Edge) or "cookies.txt" (Firefox). Export only tiktok.com.
3. Save the file where you run DramaFetch (`cookies.txt` is gitignored here) and pass `--cookies cookies.txt` to every command.

The file is a key to your TikTok account: keep it private, never share or commit it, and expect it to expire after some weeks — when discovery starts failing with login errors, export a fresh one. `dramafetch doctor --cookies cookies.txt` reports its age, how many `.tiktok.com` lines it has and whether a session cookie (`sessionid` / `sid_tt`) is present — names only, never values. It also flags malformed lines (not seven tab-separated fields, or a non-numeric expiry) by line number: yt-dlp would skip such a line with a warning that quotes it whole, cookie value included, so `download` and `video` refuse a file with malformed lines until it is fixed or re-exported. For the download step yt-dlp can alternatively read cookies straight from a browser profile with `--cookies-from-browser chrome`; the discovery step still needs the file.

## Usage

```bash
dramafetch doctor --cookies cookies.txt                   # environment check: Python, yt-dlp, curl_cffi, Playwright, browser, ffmpeg, cookies
dramafetch info URL --cookies cookies.txt                 # list the episodes: #, item id, duration, title, free|locked + hints, warnings, target folder
dramafetch info URL --cookies cookies.txt --json          # the same as JSON (feed it to scripts)
dramafetch download URL --cookies cookies.txt             # every free episode into ./downloads/<Series name> [<series id>]/
dramafetch download URL --cookies cookies.txt --episodes 1-10,12,20-   # a selection: ranges, single numbers, open-ended "20-"
dramafetch download URL --cookies cookies.txt --dry-run   # show what would be downloaded, touch nothing
dramafetch video https://www.tiktok.com/@user/video/<id> --cookies cookies.txt   # one ordinary video, no discovery
dramafetch serve --cookies cookies.txt                    # the web UI on http://127.0.0.1:8765/
```

`URL` is the series URL (any episode of it) or just the bare series id. Short links (`vm.tiktok.com/…`) are not expanded: open them in the browser and paste the full address.

### Flags

| Flag | Commands | What it does |
| --- | --- | --- |
| `--cookies FILE` | all | Netscape `cookies.txt` from your logged-in browser (never printed) |
| `--out DIR` | info, download, video, serve | Output directory (default `./downloads`); each series gets its own subfolder, `info` only prints it |
| `--episodes SPEC` | download | Which episodes: `1-5`, `8`, `10-` (to the last), comma-separated; default all; numbers above 10000 are rejected. Numbers the series does not list are reported and ignored |
| `--delay-min S` / `--delay-max S` | download, serve | Random pause between episodes (default 3–7 s) |
| `--include-locked` | download, serve | Also _try_ episodes that look locked — they usually have no formats; nothing is unlocked |
| `--overwrite` | download, video, serve | Re-download files that exist (ignores the manifest) |
| `--dry-run` | download, video, serve | List what would happen, touch nothing |
| `--no-impersonate` | download, video, serve | Disable yt-dlp's curl_cffi browser impersonation |
| `--cookies-from-browser NAME` | download, video, serve | yt-dlp reads cookies from `chrome`, `firefox`, `edge`, … (download step only) |
| `--retries N` | download, video, serve | yt-dlp retries per episode (default 3) |
| `--extractor-args KEY=VAL` | download, video, serve | Passed to yt-dlp's TikTok extractor, e.g. `api_hostname=…`; repeatable |
| `--strategy {auto,browser,static}` | info, download, serve | How the episode list is fetched: `browser` opens Chromium, `static` reads the embedded page JSON, `auto` (default) tries static then browser |
| `--browser-channel {chrome,msedge,chromium}` | info, download, serve, doctor | Use an installed browser instead of Playwright's bundled Chromium |
| `--browser-path PATH` | info, download, serve, doctor | An explicit browser binary (CI, sandboxes) |
| `--headful` | info, download, serve | Show the browser window — lets you pass a captcha or log in |
| `--dump-raw DIR` | info, download, serve | Write every raw API payload there (`item_list_<n>.json`, `detail.json`, `page_url.txt`; the static strategy writes the embedded page JSON as `hydration_<n>.json`; never cookies) — review them before sharing, then attach them to a bug report |
| `--timeout S` | info, download, serve | How long to wait for the first episode list, and for each further page of it (default 45 s) |
| `--host`, `--port` | serve | Bind address and port (default `127.0.0.1`, `8765`); only pass `--host 0.0.0.0` on a network you trust — the UI has no login |
| `--version` | — | Print the version |

### Output layout and resuming

```text
downloads/
└── The Billionaire's Secret Heiress [7699393770256782354]/
    ├── E01 - The Billionaire's Secret Heiress Episode 1.mp4
    ├── E02 - ….mp4
    └── dramafetch.json        ← the manifest: status, path and message per episode
```

File names are sanitised for every OS (reserved characters such as `|` are removed); episodes from 100 up get three digits. `dramafetch.json` is written after every episode, so an interrupted run — Ctrl+C, a 429, a dropped connection — resumes where it stopped: run the same command again and the finished episodes are reported as `skipped-exists` without touching TikTok. `--overwrite` ignores the manifest.

Per-episode statuses: `done` · `skipped-exists` · `skipped-locked` · `dry-run` · `failed-login-required` · `failed-unavailable` (locked, region-restricted, removed or private) · `failed-rate-limited` · `failed`. A login or rate-limit failure stops the run; the remaining episodes are marked `stopped: …` without contacting TikTok.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Everything selected is done, skipped (exists / locked) or dry-run |
| 1 | Another DramaFetch error (the message says what) |
| 2 | Usage error, unsupported URL, or at least one episode failed |
| 3 | TikTok wants a login: export fresh cookies and pass `--cookies` |
| 4 | Discovery failed: a captcha / "verify you are human" page (try `--headful`) or no episode list arrived |
| 5 | Rate limited (HTTP 429) while listing or downloading episodes: wait 30–60 minutes before trying again (no other strategy is tried after a 429) |
| 130 | Interrupted with Ctrl+C — the manifest is saved, run again to resume |

### Web UI

`dramafetch serve [--host 127.0.0.1] [--port 8765] [--out DIR] --cookies cookies.txt` starts a single-page UI — stdlib `http.server`, vanilla JS, no CDN, works on a phone-sized screen, follows your light/dark preference. Paste the URL → **Resolve** → tick episodes (locked ones are unticked and marked with their hints) → **Download selected** → a progress table polled every 2 s, plus a **Doctor** panel and the legal notice. Resolving runs synchronously inside the request and takes 10–40 s while Chromium opens TikTok; the page says so while it waits. The output directory is fixed by `--out` on the command line — the page cannot choose paths. Jobs run one at a time; more are queued. The server binds to `127.0.0.1` unless you pass `--host`, requires `Content-Type: application/json` on every POST and only answers requests whose `Host` header names the bound host or localhost; it has no authentication, so do not expose it.

JSON API, for scripts: `POST /api/resolve {"url"}` → the series and its episodes; `POST /api/download {"url", "episodes": "1-5" | null, "include_locked": bool}` → `202 {"job_id"}`; `GET /api/jobs/<id>` → `{state: queued|running|done|error, results: [{number, title, status, message, path}], …}`; `GET /api/doctor`. Bodies are capped at 64 KiB; errors are `{"error", "kind", "hint"?}` with a 4xx/5xx status (401 login needed, 429 TikTok rate limit, 502 discovery failed, 503 captcha).

## Troubleshooting

| Symptom | Likely cause → what to do |
| --- | --- |
| `No video formats found` (status `failed-unavailable`) | Not logged in, the episode is locked, or it is not available in your region → check that `info` says `free`, refresh `cookies.txt`; `--include-locked` only confirms that a locked episode fails |
| Discovery ends on `/login`, exit 3 | TikTok wants a session → export `cookies.txt` from the logged-in browser and pass `--cookies`; cookies also expire, export again |
| HTTP 429 / `failed-rate-limited`, exit 5 | Too many requests → wait 30–60 min, keep (or raise) the default delays, never run two instances |
| `cookies file … has malformed lines (line N: …)`, status `failed` | A line of `cookies.txt` is not seven tab-separated fields (or has a non-numeric expiry); yt-dlp would print it, value included → delete or fix that line, or export the file again |
| Captcha / "Verify to continue", exit 4 | TikTok's bot check → run with `--headful`, solve it in the window, retry |
| `Unsupported URL` from plain `yt-dlp` | yt-dlp does not know `/shortdrama/` pages (yt-dlp/yt-dlp#17725) — that is why this tool exists; use `dramafetch download` |
| "no episode list within N s" | The page did not load the list → `--timeout 90`, `--headful` to watch, `--strategy browser`; then `--dump-raw raw/` and open an issue with the files |
| Episodes missing / "gap" warning | TikTok paginated differently or hides locked items → `info` prints the warnings; `--dump-raw` shows what the API returned |
| Short link `vm.tiktok.com/…` rejected | Short links are not resolved → open it in the browser and paste the full `/shortdrama/episode/` address |

## Limitations

- No paywall, DRM or entitlement bypass, ever: locked episodes are listed and skipped (or tried and failed with `--include-locked`).
- Short links (`vm.tiktok.com`, `vt.tiktok.com`, `tiktok.com/t/…`) are not expanded.
- TikTok changes its web app without notice, and the field names that mark an episode as locked are heuristics (`catalog.lock_hints`). When something breaks, `info --dump-raw raw/` saves the raw payloads to adjust the parsers against.
- Built without network access to TikTok: the fixtures mirror payloads observed in October 2026 and the integration test drives a real Chromium against a fake TikTok. The first real run is the real test.
- No parallel downloads, by design.

## Development

```bash
cd DramaFetch && . .venv/bin/activate
ruff check . && ruff format --check . && mypy && pytest   # the definition of done
pytest -m integration                                      # a real Chromium against tests/integration/fake_tiktok.py
PYTHONPATH=src python -m dramafetch doctor                 # run the CLI from the checkout without installing
```

`pytest -m integration` runs only when `DRAMAFETCH_CHROMIUM` points at a Chromium binary or `/opt/pw-browsers/chromium` exists (the cloud sandbox); after `playwright install chromium`, export it the way CI does: `DRAMAFETCH_CHROMIUM="$(python -c 'from playwright.sync_api import sync_playwright; p = sync_playwright().start(); print(p.chromium.executable_path); p.stop()')"`. Without it the browser tests are skipped, not passed. CI runs all of this in the `dramafetch` job of [`../.github/workflows/ci.yml`](../.github/workflows/ci.yml). Rules for agents and the module map: [`CLAUDE.md`](./CLAUDE.md).

Hidden flags on `info`, `download` and `serve`, for tests and diagnostics (not in `--help`): `--base-url URL` points discovery at another host such as the fake TikTok server, `--page-count N` (default 30) and `--max-pages N` (default 60) bound the `item_list` pagination, `--page-delay S` (default 0.8) is the pause between pages. To drive the CLI against the fake server from a checkout: start `tests/integration/fake_tiktok.py`'s `FakeTikTok` in a Python shell, then `PYTHONPATH=src python -m dramafetch info 7699393770256782354 --strategy browser --base-url http://127.0.0.1:<port> --browser-path /opt/pw-browsers/chromium --page-count 10`.

Layout: `src/dramafetch/` — `urls` (parse what is pasted), `discovery/` (browser, static, cookies), `catalog` (pure parsing of TikTok payloads), `manifest` (resumable runs), `downloader` (yt-dlp), `engine` (the seam shared by both front ends), `cli`, `web/` (stdlib server, job queue, `static/index.html`). Tests live in `tests/`, payload fixtures in `tests/fixtures/`, the fake TikTok server in `tests/integration/`.
