# CLAUDE.md — DramaFetch

Rules for agents working in `DramaFetch/`. The repo-wide rules in `../AGENTS.md` and `../CLAUDE.md` (guardrails, branches, PRs) still apply; this file adds what is specific to this project. Read it before touching anything here.

## Scope — what this tool is and is not

- DramaFetch downloads TikTok short-drama episodes that the user's own account can already watch, a whole series at a time, for personal offline viewing. That is the whole product. The legal notice in `README.md` is part of the contract: keep it verbatim in the README and in `web/static/index.html`.
- Never implement anything that unlocks paid episodes, bypasses a paywall, DRM or access controls, fakes entitlement, rotates proxies or hides automation. The only two deliberate measures are a Chrome user agent without `Headless` (`static.chrome_user_agent`, used by the discovery and the browser engine alike) and curl_cffi's Chrome TLS impersonation (`impersonate="chrome"` in `static.py` and yt-dlp's `impersonate` in `downloader.py`), which is how yt-dlp normally talks to TikTok. Chromium runs with its default flags (`navigator.webdriver` stays true); when TikTok asks for a verification the user passes it with `--headful`. No proxies, no stealth plugins, nothing else. Locked episodes are listed with their hints and skipped; `--include-locked` only _tries_ them.
- Cookies are a key to the user's account: never print, log, dump, assert on or send cookie values anywhere but TikTok. Diagnostics (`doctor`, `--dump-raw`, error messages, job snapshots) may show cookie **names**, counts and ages only.
- Be polite to TikTok by design: one download at a time, randomized 4–9 s pauses between episodes, a 60–120 s rest every 10 downloads, 0.8 s between list pages, a full stop on HTTP 403, HTTP 429 or three failures in a row (see Pacing below). Never add parallelism.
- The cloud sandbox and CI cannot reach tiktok.com — never try. Everything network-facing is thin, injectable and tested against `tests/fixtures/` or `tests/integration/fake_tiktok.py`.

## Pacing

The anti-bot strategy is to behave like one person watching, and it lives in `engine.download_series` with its knobs in `models.DownloadOptions`:

- The defaults are deliberate and are a floor: 4–9 s between episodes (`delay_min_s`/`delay_max_s`), a 60–120 s rest every 10 network attempts (`rest_every`, `rest_min_s`/`rest_max_s`; a failed attempt counts, skips do not), a stop after 3 consecutive failures (`max_consecutive_failures`), at most 3 yt-dlp retries (`downloader.MAX_RETRIES`) with `sleep_interval_requests: 1`, at most 4 media requests per episode in the browser engine (`downloader_browser.MAX_GETS_PER_EPISODE`). Never lower them in code, never make the code itself go below them, never make a pause conditional on "it worked last time". The existing flags accept lower values only so that tests against the fake server run fast; do not add further ways to go below the defaults. Users may raise them (`--pace human`, `--rest-every 5`, …); the only way to make a run lighter is fewer requests (`--engine browser`), never faster ones.
- Never parallelise: one download at a time in the engine, one job at a time in `web/jobs.py`, one browser context in the browser engine. No proxies, no rotation, no second instance.
- `DownloadStatus.FAILED_BLOCKED` (HTTP 403 / forbidden / access denied from yt-dlp; a captcha page met by the browser engine's in-session list refresh) and `FAILED_RATE_LIMITED` (HTTP 429) stop the run, like `FAILED_LOGIN`: the remaining episodes get the same status with `stopped: …` and no request is made (`engine._STOP_STATUSES`); `exit_code` returns 5 for both. Do not retry, wait-and-knock or switch engines automatically after one — the user waits 30–60 minutes and resumes with the manifest. Keep `downloader.classify_error` mapping 403 wordings to `FAILED_BLOCKED` and `\b429\b` to `FAILED_RATE_LIMITED`.
- Every pause goes through `on_pause(kind, seconds)` then the injectable `sleep`; skips (manifest, locked, existing file, dry run) never pause and never count. Tests use a fake `sleep` and a fixed `rng` — a test that really sleeps is a bug.

## Architecture (`src/dramafetch/`)

| Module | Role |
| --- | --- |
| `models.py` | Dataclasses (`SeriesRef`, `VideoRef`, `Episode`, `Series`, options, `DownloadStatus`, `DownloadResult`) and the `Discovery` / `Downloader` protocols — pure data, shared by everything |
| `errors.py` | Exception hierarchy; each class maps to one CLI exit code |
| `urls.py` | Parse pasted text into `SeriesRef` / `VideoRef`, build page URLs; its docstring holds the verified URL facts |
| `catalog.py` | Pure functions over TikTok's `item_list` / `detail` payloads: find lists, lock hints, episodes, merge, warnings |
| `discovery/` | `browser.py` (Playwright: open the series page, capture `/api/drama/episode/item_list/`, paginate; `discover_in_page` runs the same capture in a page of a context the browser engine already holds), `static.py` (embedded page JSON), `cookies.py` (Netscape `cookies.txt` → Playwright cookies, names-only report, malformed lines by line number), `__init__.py` (`choose_discovery`: `auto` = static, then browser) |
| `manifest.py` | `dramafetch.json` per series directory: resumable runs, safe file names, the series/episode naming |
| `downloader.py` | `YtDlpDownloader`: builds yt-dlp options (`%`-escaped output template, retries capped at `MAX_RETRIES`), classifies errors (403 → `FAILED_BLOCKED` with `BLOCKED_MESSAGE`, 429 → `FAILED_RATE_LIMITED`), refuses a cookies file with malformed lines (yt-dlp would print them), never raises per episode; its skip-rule helpers are shared with the browser engine |
| `downloader_browser.py` | `BrowserDownloader`: the `--engine browser` downloader — one lazily launched Chromium of its own (default flags, Chrome UA, the cookies file; set up like the discovery's, not shared with it) and one context for the whole run; fetches the play URLs the `item_list` payload already carries (`catalog.play_url_candidates`, expiry from `catalog.url_expiry`, `Referer: <base_url>/`), one `GET` at a time and at most `MAX_GETS_PER_EPISODE` (4) per episode; 403/404/410 or a non-video body → next URL → at most one in-session refresh of the episode list per episode (`PlaywrightDiscovery.discover_in_page`, cached per run so a long series refreshes once; an episode the fresh list carries without a play URL, or not at all, never costs another page load) → `FAILED_UNAVAILABLE`; any other HTTP status → `FAILED` at once (no next URL, no refresh); 429 → `FAILED_RATE_LIMITED`; a captcha page during the refresh → `FAILED_BLOCKED`; writes `.part` then renames; a failed launch is attempted once and never retried: every later episode fails with the same cached message until the 3-failure stop ends the run; `close()` at the end of the run; messages carry host names only |
| `engine.py` | The seam both front ends use: `resolve`, `select_episodes`, `download_series` (pacing, rests, early stops, `on_pause`), `make_downloader` (engine → downloader, closes it at the end), `validate_pacing`, `summarize`, `exit_code` |
| `cli.py` | argparse front end: `info`, `download`, `video`, `doctor`, `serve`; `doctor_as_dicts` feeds the web UI |
| `web/` | stdlib `http.server` UI: `server.py` (routes, limits, `run_server`), `jobs.py` (`JobManager`: one job at a time, polled snapshots), `static/index.html` (vanilla JS, no CDN) |

Dependencies flow downwards: `cli` / `web` → `engine` → `discovery` / `downloader` / `downloader_browser` / `manifest` / `catalog` → `models` / `urls` / `errors`. `engine` imports `downloader_browser` lazily (`make_downloader`), so the default engine never loads Playwright. `web` imports `engine` and `cli` lazily inside handlers so the package loads without Playwright or yt-dlp; `cli` imports `web.server` lazily for `serve`.

## Commands

| Command | What it does |
| --- | --- |
| `python -m venv .venv && .venv/bin/pip install -e ".[impersonate,dev]"` | One-time setup. The cloud sandbox already has the venv with everything — never `pip install` or `playwright install` there |
| `.venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy && .venv/bin/pytest` | The definition of done: ruff (line length 100, incl. `ANN`), mypy strict, unit tests against fixtures and the fake server |
| `.venv/bin/pytest -m integration` | A real Chromium against the fake TikTok server; skipped without `/opt/pw-browsers/chromium` or `DRAMAFETCH_CHROMIUM=<path>` |
| `.venv/bin/pytest tests/test_web.py -q` | One file while iterating (same for any `tests/test_*.py`) |
| `PYTHONPATH=src .venv/bin/python -m dramafetch doctor` | The CLI from the checkout without installing; makes no TikTok request |

CI runs the same sequence in the `dramafetch` job of `../.github/workflows/ci.yml` (Python 3.12, then `playwright install --with-deps chromium` and `pytest -m integration` with `DRAMAFETCH_CHROMIUM` pointing at the installed browser).

## Conventions

- English everywhere; conventional commits (`feat(dramafetch): …`, `fix(dramafetch): …`).
- Type hints on everything and `mypy --strict` green; `typing.Any` only for raw TikTok JSON. No `# type: ignore` without a reason in the comment.
- Parsing is pure functions over payloads, covered by the fixtures in `tests/fixtures/` (two consecutive `item_list` pages with a trailer, a duplicate, a locked episode and an item from another series). Keep fixtures realistic when extending them.
- The network layer is thin and injectable: the `Discovery` / `Downloader` protocols, the `fetch` / `playwright_factory` / `ydl_factory` constructor hooks, `DiscoveryOptions.base_url` for the fake server. Tests inject fakes; no test opens a socket to the internet.
- No new runtime dependencies beyond `yt-dlp` and `playwright` (`curl_cffi` is an optional extra). Stdlib only under `web/`; no CDN or external resource in `index.html`.
- Never weaken `pyproject.toml` (ruff rules, mypy strict, pytest markers/addopts) to get green; never skip or quarantine a test.
- Error messages are safe to print: no cookies, no tokens, no tracebacks in user-facing text (`logging.debug` the detail). Web responses never echo request bodies.

## Definition of done

1. `ruff check`, `ruff format --check`, `mypy` and `pytest` are green; `pytest -m integration` too when a Chromium is available. Report the real output.
2. Anything users see — flags, exit codes, output layout, statuses, API routes, pacing defaults — is reflected in `README.md` (flags table, exit codes, "Pacing and TikTok's protections"); a new or moved module appears in the table above.
3. No cookie value anywhere, no bypass of any kind, no parallel downloads, no new dependencies.
4. Fixtures and `tests/integration/fake_tiktok.py` were updated whenever TikTok's payload shape changed.

## Where the TikTok facts live and how to update them

The verified facts — the series URL shape, "the long number is the series id (`dramaID`)", `/api/drama/episode/item_list/`, `/api/drama/detail/`, "a logged-in session is required", yt-dlp issue #17725 — are written down in `urls.py` (module docstring) and `README.md` → "How it works", and encoded in `catalog.py` (field names, lock heuristics) and `discovery/browser.py` (URL substrings, pagination parameters). When TikTok changes something:

1. On a real machine run `dramafetch info URL --cookies cookies.txt --strategy browser --dump-raw raw/`; it writes `item_list_<n>.json`, `detail.json` and `page_url.txt` (never cookies). With `--strategy auto` or `static` the embedded page JSON lands in `hydration_<n>.json` instead, and `item_list_<n>.json`/`detail.json` appear only if the browser had to run.
2. Compare them with `tests/fixtures/item_list_page*.json`; update the fixtures to the new shape (anonymise ids) and adjust `catalog.py` / `discovery/` until `pytest` passes again.
3. Update the facts in `urls.py`, `README.md` and this file in the same PR, with the date they were verified.
