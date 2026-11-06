# Changelog

One version for the whole of DramaFetch — the Python tool (`pyproject.toml`, `dramafetch --version`) and the Chrome extension (`extension/manifest.json`, shown in `chrome://extensions` and next to the title of the DramaFetch tab and the popup). Every change users can see ships with a new number: a new feature raises the middle number (1.2.0 → 1.3.0), a fix the last one (1.2.0 → 1.2.1). Dates are the day the pull request was merged.

## 1.2.0 — 2026-11-06

- The extension saves a report of the episodes a run did not download: `Downloads/DramaFetch/reports/<Series> - did not download <date time>.json`, written automatically at the end of a run with a failed episode (the setting **Save a report of the episodes that did not download**, on by default) or on **Save the report**. For each such episode — the failed ones, the ones a stop left `stopped`, the locked ones it skipped — its status, message and probable cause (a preview served for an episode the account has not unlocked, a cut transfer, DRM, a 429, …), every play URL considered with its HTTP status and sizes, every in-run re-discovery, and the list entry TikTok served to the session; plus one downloaded episode for comparison. Never a cookie, a token or a request header ([#81](https://github.com/brunocarbone98/projects/pull/81)).
- The version is shown next to the title of the DramaFetch tab and of the popup.

## 1.1.0 — 2026-11-06

- The episodes a run did not download are shown apart from the ones that completed, **Did not download (N)**, with **Retry the episodes that did not download (N)**: one job per series over exactly those episodes, the same as pasting the link and **Download selected** (the cooldown gate, the rest between jobs, a fresh list; locked episodes never asked for; a remembered DRM verdict skipped). Every past run with such episodes gets the same line and button in **Past runs** ([#80](https://github.com/brunocarbone98/projects/pull/80)).

## 1.0.0 — 2026-11-05

The first version the owner ran on a real Windows machine: the Python tool (`info`, `download`, `video`, `doctor`, `serve`) and the Chrome extension, with the audit fixes of [#79](https://github.com/brunocarbone98/projects/pull/79) — the full Chromium instead of the headless shell, consistent impersonated headers, no byte-offset resume, the video-only HEVC renditions left out, a captcha after the first list page treated as a stop, a private cookies copy for yt-dlp, the refused extractor arguments, one web server per port on Windows — and everything before it: whole series in batches, `<Series> - Episode NN.mp4` with the cover embedded, every file verified, the pacing floors and the 30-minute cooldown, paid episodes the account has unlocked and nothing more, DRM detected and never kept.
