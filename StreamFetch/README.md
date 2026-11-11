# StreamFetch for Chrome

[![CI](https://github.com/brunocarbone98/projects/actions/workflows/ci.yml/badge.svg)](https://github.com/brunocarbone98/projects/actions/workflows/ci.yml)

StreamFetch is a Chrome extension that saves videos from **Dailymotion**, **Bilibili.tv** and **Bilibili** as ordinary MP4 files, for your own offline viewing — the way a site like SnapAny works, but inside your own Chrome and with your own session. You paste several links at once; every video appears as a row with its cover, title, duration and a quality selector; **Download all** saves them one after the other, each a complete file with picture and sound, in the highest quality your browser session is served, with the video's cover and title embedded. Anything that did not download is listed apart, can be retried, and is described in a JSON report you can send when asking for help.

It downloads only what your own logged-in Chrome session can already play on those sites. It never bypasses DRM, paywalls, geo-restrictions, logins or any other access control.

> **Built without access to the sites.** StreamFetch was written in a sandbox that cannot reach dailymotion.com, bilibili.com or bilibili.tv. Every site fact it relies on was read on 2026-11-08 from the extractors of yt-dlp 2026.10.26 (see [How it works](#how-it-works)), and every behaviour is tested against local fake sites that serve those shapes — never against the real ones. Your first real run is the real check: start with one short video per site, and if anything does not download, save the report and send it.

## What it is and what it is not

- **It is** a personal tool: it reads the page or the JSON each site sends to your browser, and fetches the media files that document offers to your session, with your browser's own cookies — exactly what the site's own player does when you press play.
- **It is not** a way around anything: no DRM decryption (encrypted media is detected and never saved), no paywall, premium, login, age or region bypass, no forged or replayed request signatures, no spoofed browser identity, no proxies or IP rotation, nothing injected into the sites' pages. It does not hide that it is a download tool.
- **It is polite by design**: one video at a time, one request at a time, pauses between requests, and a full stop with a 30-minute cooldown as soon as a site refuses — see [Pacing and the cooldown](#pacing-and-the-cooldown).
- Its only change to a request is on its own requests to the sites' media hosts: the `Referer` header set to the site's address and `Origin` removed — what the site's own player sends. Dailymotion's player data and playlists live on the same `dailymotion.com` domain as its media, and Bilibili.tv's API wants the same header, so StreamFetch's own requests there carry it too; nobody else's requests are touched.

## Install (Windows first; macOS and Linux work the same way)

1. Download this repository as a ZIP (on GitHub: **Code → Download ZIP**) and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked** and select the folder that DIRECTLY contains `manifest.json`: `StreamFetch/extension` (with Windows' **Extract all**, usually `<destination>\projects-main\projects-main\StreamFetch\extension`). Leave **Developer mode** on: turning it off disables unpacked extensions.
3. In `chrome://settings/downloads`, turn off **Ask where to save each file before downloading**: StreamFetch asks for no dialog, but while that setting is on Chrome opens one for every file and the run waits on it.
4. Pin StreamFetch to the toolbar (the puzzle-piece button → the pin).

**Update:** replace the files in the SAME folder and press the reload arrow on StreamFetch's card in `chrome://extensions` while no run is going. Never load a second copy: two copies are two engines with separate pauses and cooldowns. Chrome 116 or later is required.

## How to use it

1. Click the toolbar button → **Open StreamFetch** (on a Dailymotion, Bilibili.tv or Bilibili video page the popup also offers **Download this video**, which puts that page's link into the box). One StreamFetch tab works at a time; a second one opens read-only.
2. Paste links into the box, **one per line** — up to 100 per batch. Blank lines and `#` comments are ignored; the same video pasted twice (even with different tracking parameters or language segments) is taken once; a link StreamFetch cannot handle is refused with the reason, before anything starts.
3. **Analyze** reads every link, one at a time and paced, without downloading: each row shows the cover, the title (a link to the page), the site, the duration and a **quality selector**. A Bilibili.tv series becomes one row per episode under a header row with the series title and its episode count; a Bilibili video with several parts becomes one row per part. Hints appear in the message column, for example `1080P60 needs a premium membership` or `playlist ignored: only this video is downloaded`.
4. Change a row's quality if you want; the pre-selected option is the highest the settings allow (see [Quality](#quality-and-codecs)). Qualities the site lists but does not serve to your session appear disabled, as `1080P60 — premium only`, so you can see what exists.
5. **Download all** downloads every row with its own selection, one after the other (rows not analysed yet are read first). Each row shows its status badge, the progress (`12.3 MB · 1.2 MB/s`) and a message. The summary line counts `N videos · M detected · K failed`.
6. **Stop** ends the current request at once and marks the rest `stopped`.
7. At the end, the rows that did not download move to **Did not download**, with **Retry** (a new run over exactly those links) and **Save the report**. **Last runs** keeps the last 20 runs with their counts and a **Retry** of their failures.

Keep the StreamFetch tab open while it works; it may sit in the background. Enter in the box starts nothing — **Analyze** and **Download all** do.

### The links it reads

| Site | Accepted | One item per |
| --- | --- | --- |
| **Dailymotion** | `https://www.dailymotion.com/video/<id>` (also `<id>_<slug>`, `/embed/video/<id>`, `touch.` and other `dailymotion.<tld>` hosts), `https://dai.ly/<id>`, `https://geo.dailymotion.com/player….html?video=<id>`; ids are `x` + letters and digits (`x8vu47w`) or `k…` ids | video |
| **Bilibili.tv** (Bstation, also `biliintl.com`) | `https://www.bilibili.tv/<lang>/video/<aid>` (a user video), `…/play/<season_id>/<ep_id>` (one episode), `…/play/<season_id>` or `…/media/<season_id>` (a whole series, up to 200 episodes); the language segment (`en`, `es`, `id`, `th`, `vi`, `zh`, any case) is optional; bare `bilibili.tv`, `www.biliintl.com` and `http://` are accepted | video, episode or series |
| **Bilibili** | `https://www.bilibili.com/video/<BV…\|av…>[/]` (also `m.bilibili.com`, bare `bilibili.com`, `http://` or no scheme; the `BV` / `av` prefix in any case), `https://b23.tv/<code>` (followed to its page; the target must be a bilibili.com video page) | video (all its parts) or, with `?p=N`, that part only |

- **Query parameters are ignored**, except Bilibili's `?p=N`: Bilibili.tv's `bstar_from`, Bilibili's `vd_source`, `spm_id_from`, `share_source`, `share_medium`, `t`, … and every fragment select nothing. A Dailymotion video link that also carries `?playlist=…` downloads that video only and says so.
- **Bilibili.tv ids stay text end to end.** A user video's id has 16 digits, more than a JavaScript number holds exactly, so StreamFetch never turns it into a number.
- **Refused, with the reason:** playlists and channels (`dailymotion.com/playlist/…`), Bilibili bangumi, courses (cheese), festival pages (paste the video's own `…/video/BV…` link), user spaces, lists and favourites, audio, live streams, other Bilibili.tv pages (trending, search, spaces), and `bili.im/…` share links — open one in Chrome and paste the full `bilibili.tv/…/video/…` link from the address bar.

## Where the files go

Into Chrome's download folder, under `StreamFetch/`:

```text
Downloads/StreamFetch/Dailymotion/<title> [<id>].mp4
Downloads/StreamFetch/Bilibili/<title> [<bvid>].mp4                          a video with one part
Downloads/StreamFetch/Bilibili/<title> [<bvid>]/P01 - <part title>.mp4       a video with several parts
Downloads/StreamFetch/Bilibili.tv/<title> [<aid>].mp4                        a user video
Downloads/StreamFetch/Bilibili.tv/<series title>/<episode title> [<ep_id>].mp4   an episode (folder `season <season_id>` when the series title is unknown)
Downloads/StreamFetch/reports/<YYYY-MM-DD HHMM> - did not download.json
```

Names are made safe for Windows (forbidden characters become `_`, reserved names such as `CON` are suffixed, long titles are shortened so the whole path stays inside Windows' limits). A file already saved under its name is skipped (`already on disk`) without a request; Chrome never overwrites a file — a clash gets ` (1)`.

## Quality and codecs

- **Quality** (Settings): **Best the session can play** (the default) takes the highest resolution the site serves to your session; **At most 1080p / 720p / 480p** cap it. The cap is the only thing that lowers the resolution.
- **Video codec** (Settings) only chooses among streams of that resolution — it never lowers the resolution to get H.264. **Compatible** (the default) prefers H.264 (`avc1`), then HEVC, then AV1: H.264 plays in every player. **Best** takes the highest-bandwidth stream at that resolution, whatever its codec (HEVC or AV1 may need a recent player).
- **Audio**: with **Compatible**, the highest-bandwidth AAC track; with **Best**, Bilibili's FLAC (Hi-Res) track when your session gets one, then Dolby (E-AC-3), then the best AAC.
- **Per row**: the quality selector of each row overrides the global choice for that video; changing it re-picks the audio by the same rules. Labels read `1080p · avc1 · 2.3 Mbit/s`.
- Bilibili lists qualities your session may not be served (8K, 4K, 1080P60, 1080P+ usually need a premium membership): they are never requested, and the row's hint names them.

## Complete files, cover and title embedded

Every video is downloaded to the extension's private disk space first (so a long video never sits in memory), then written as one **progressive MP4** — the layout every player opens: index first, then the picture and sound interleaved. The picture and sound are copied as the site served them; nothing is re-encoded.

- **Verified before it is saved.** The finished file must be a progressive MP4 with one video track and one audio track (unless the source has no sound at all — the message then says `no audio in the source`), and its duration — and each track's — must be within max(3 s, 5 %) of the duration the site states (for Bilibili.tv: the video page's, else the series list's, else the one in the stream answer; if none of them states one, the tracks are checked against each other and each transfer against the size the server announced, when it announces one), with no hole inside a track (a piece of the picture or sound that never arrived fails the file even when the total duration still matches: `video: 2.0 s missing at 8.0 s`). A file that fails is **not saved** (`the finished file failed verification (duration 41.0 s, expected 60.0 s)`) and nothing incomplete is ever left under the video's name. A segment that comes back as an error page or empty is retried like a failed transfer, never used as media. Chrome's own video decoder then opens the file as a last check; when it cannot read the duration (a codec it does not play, for example), the row only says so.
- **A trial clip is never saved as the video.** When Bilibili serves only a preview (`试看`) or a supporter-only video, the row is refused with that reason.
- **Cover and title embedded.** The video's title is written into the file (`©nam`) and, with the setting **Cover in each saved file: Embed** (the default), its cover image too (`covr`, JPEG or PNG; a WebP cover is converted to JPEG). The cover costs one more request per file, made after the video and never retried; when it fails, the video is still saved without a cover and the message ends `; cover: <reason>`. **Title only, no cover request** makes no cover request at all. The thumbnails in the list are loaded only when a row is in view, one at a time, and never while a download runs; a 429 or 412 on one stops the thumbnails for the rest of the page and starts the cooldown, like any other refusal (only the one cover request a file embeds is exempt).
- **Encrypted media is refused.** An encrypted HLS playlist, or an MP4 with DRM boxes (`encv`, `enca`, `pssh`), is refused before anything is saved.
- Work files are deleted when a download ends, saved or not; leftovers of a closed tab are swept after 24 hours.

## Pacing and the cooldown

Sites protect themselves against bulk downloading. StreamFetch does not try to defeat that protection; it behaves like one person watching:

3–6 s between videos, 1–2 s between page requests, 100–300 ms between media requests; 3 retries (1, 2, 4 s back-off), 30 s stall timeout; stop after 3 failures in a row or any 429 / 412 / 403, then a 30 min cooldown

- **One video at a time, one request at a time.** Never two videos, never two segments at once. Each link is read right before its own downloads, so the sites' signed media addresses never wait and expire.
- **Retries** happen on network errors, server errors (5xx) and stalls (no byte for 30 s); a cut DASH transfer resumes where it stopped (`Range`). An expired media address (a 403 on a segment or a media file) is refreshed **once** per video by reading the page again — never in a loop.
- **A refusal stops the run.** HTTP 429 or 412 anywhere (a list thumbnail included), a 403 on a page, a manifest or an API answer, or Bilibili's risk-control page: the run stops at once (the rest is `stopped`), a banner appears, and for **30 minutes** every new run is refused with the minutes left. A refusal met while a link's later parts or episodes are being read stops the run before ANY of that link's files is downloaded — the parts read before it are `stopped` too. **Wait** — knocking again right away is what makes a site block you for longer. A login wall stops the run without a cooldown: log in, then retry. Three ordinary failures in a row also stop the run.
- The pauses are **floors**: in Settings you may only make them longer. The cooldown can be deleted in Settings (**Delete the cooldown (at your own risk)**); nothing in StreamFetch skips it on its own.

## The report of what did not download

When a run ends with a failed or stopped row and **Save a report of what did not download** is on (the default), StreamFetch saves `Downloads/StreamFetch/reports/<YYYY-MM-DD HHMM> - did not download.json` and says `Report saved: <file>` under the failed block; **Save the report** saves it again on demand. For each row: the link you pasted, the site, the id, the title, the status, the failure in English, a probable cause, every request StreamFetch made for it (address without its query string, host, HTTP status, content type, sizes, outcome), the streams it chose and the ones available, and the site's metadata as served.

**Privacy.** The report never contains a cookie, a token, an `Authorization` value or any request header, and every address in it has its query string removed (the sites sign their media addresses there). It does contain what the sites served about the videos — titles, ids, uploaders, hosts — so **read it before sharing it**. StreamFetch never reads, logs, stores or exports your cookies: the browser sends them with its requests, as it does for the site's own player. The history of the last 20 runs keeps, for its **Retry**, the plain address of each video that did not download (`https://www.bilibili.com/video/<id>?p=2`, `https://www.bilibili.tv/en/video/<aid>`): never the parameters a share link adds (`vd_source`, `buvid`, `mid`, `bstar_from`, …).

## Troubleshooting

| The row says | What it means | What to do |
| --- | --- | --- |
| `failed-unavailable` · geo-blocked (`Dailymotion says: …`, Bilibili.tv code 10004001) | The site does not serve this video in your country | Nothing: StreamFetch never bypasses geo-restrictions |
| `failed-unavailable` · login required (Bilibili `-403`; Bilibili.tv codes 10004004, 10004005, 10023006) | The session is not logged in, or (Bilibili.tv) the episode is premium-only | Log in to the site in a normal tab of this Chrome profile, then **Retry**; a premium episode stays unavailable |
| `… needs a premium membership` (hint) / `premium only` | Some qualities exist but are not served to your session | Nothing to do; the best quality you are served is downloaded |
| `failed-unavailable` · trial only / supporter only | Bilibili served only a preview (`试看`), or the video is for the uploader's paying supporters | Nothing: a clip is never saved as the video |
| `failed-unavailable` · encrypted (DRM) / key-protected | The media is encrypted | Nothing: StreamFetch never decrypts |
| `failed-unavailable` · live stream / discontinuous stream | A live broadcast, or a spliced playlist (often ads) | Out of scope in 1.0 |
| `failed-unavailable` · legacy stream | Bilibili served an old FLV/MP4 stream instead of DASH | Out of scope in 1.0; being logged in usually gets DASH |
| `failed-unavailable` · deleted / interactive | The video is gone or private; or an interactive (branching) video | Nothing to retry |
| `failed` · **host not covered** (`… on <host>`) | The site served its media from a host the extension has no permission for (Bilibili.tv's media hosts are not documented); nothing was requested there | **Save the report and send it**: the host it names is what a later version adds |
| `failed` · HTTP 403/404 on a segment or media file, after one refresh | The media address expired twice | **Retry** later |
| `failed` · no answer / transfer cut short / stalled | A network problem; the retries did not help | **Retry** |
| `failed` · the server sent `text/html (not MPEG-TS)` / `an empty body` where a video was expected | A segment came back as an error page or empty, four times in a row | **Retry** later |
| `failed` · failed verification (`duration … s, expected … s`, `video: … s missing at … s`) | The finished file was shorter than the site says, or a piece of it never arrived; it was not saved | **Retry**; if it repeats, send the report |
| `failed` · Chrome could not save the file (not enough free disk space …) | The disk is full: a video needs about twice its size free until it is saved | Free some space, then **Retry** |
| `failed-rate-limited` / `failed-blocked` + the cooldown banner | The site refused requests (429, 412, a 403 on a page, a risk-control page) | **Wait** for the cooldown, then **Retry** |
| `done` · `(the browser could not read the file's duration: <codec>)` | The file was verified, but Chrome's own player does not decode its codec | Play it with VLC or another player, or choose **Compatible** codecs |
| `done` · `; cover: <reason>` | The video is saved; its cover could not be embedded | Nothing to do |

## Legal notice

StreamFetch is a personal tool for saving, for your own offline viewing, videos that Dailymotion and Bilibili already play in your own browser session. It never bypasses DRM, paywalls, geo-restrictions, logins or any other access control, and it does not hide that it is a download tool. Downloading may be restricted by the sites' terms of service and by copyright law in your country; you are responsible for how you use it. Not affiliated with Dailymotion or Bilibili.

## How it works

Site facts read on **2026-11-08** from the extractors of **yt-dlp 2026.10.26** (`dailymotion.py`, `bilibili.py`: `DailymotionIE`, `BiliBiliIE`, `BiliIntlBaseIE`, `BiliIntlIE`, `BiliIntlSeriesIE`) — except Bilibili.tv's durations, named under Bilibili.tv below. The sandbox StreamFetch was built in cannot reach the sites, so none of this has been checked against them yet: the owner's first real run is the check, and the report of a failed row is the evidence that updates these facts.

- **Dailymotion.** StreamFetch reads `https://www.dailymotion.com/player/metadata/video/<id>?app=com.dailymotion.neon` with your session (its family filter and login decide what is offered): the title, duration, uploader, posters, and under `qualities.auto` the HLS master playlist (`application/x-mpegURL`). An `error` answer refuses the row (`DM007` is geo-blocking). The master lists the variants (`RESOLUTION`, `CODECS`, `BANDWIDTH`, `NAME`); StreamFetch picks one, then reads its media playlist. Segments are MPEG-TS or fragmented MP4 (`#EXT-X-MAP`); both are handled. A playlist without `#EXT-X-ENDLIST` is live (refused); an `#EXT-X-KEY` other than `NONE` is encrypted (refused). Hosts: `*.dailymotion.com`, `*.dmcdn.net`, `dai.ly`.
- **Bilibili.** The video page embeds `window.__INITIAL_STATE__` (the video: `bvid`, `title`, `pic`, `duration`, `pages[]` with each part's `cid`, `rights.is_stein_gate`, `is_upower_exclusive`, `error.trueCode` -403 / -404) and `window.__playinfo__` (the DASH answer the page itself requested for the part shown: `dash.video[]` with a quality id — 127 8K, 126 Dolby Vision, 125 HDR, 120 4K, 116 1080P60, 112 1080P+, 80 1080P, 64 720P, 32 480P, 16 360P —, codecs, size, `baseUrl` and backups; `dash.audio[]`, `dash.dolby`, `dash.flac`; `support_formats` and `accept_quality`, which may list more than your session is served). StreamFetch extracts both with a brace-matching reader — never by running the page's script — and reads one page per part (`?p=N`). A page carrying `window._riskdata_` with `v_voucher` instead of the state is Bilibili's risk control: a stop and the cooldown. Each DASH file is a complete fragmented MP4 of one track, served with `Range` support; the CDN wants `Referer: https://www.bilibili.com/` and answers 412 to a client it bans. A `durl` answer (legacy FLV/MP4) is refused. Hosts: `*.bilibili.com`, `b23.tv`, `*.bilivideo.com`, `*.bilivideo.cn`, `upos-hz-mirrorakam.akamaized.net`, covers on `*.hdslb.com`.
- **Bilibili.tv.** A different service from bilibili.com, with its own pages, API and CDN. The streams come from `https://api.bilibili.tv/intl/gateway/web/playurl?platform=web&aid=<aid>` (a user video) or `…&ep_id=<ep_id>` (an episode), with your session: video-only and audio-only MP4 files, fragmented or not (both are handled). `code` 0 is success; 10004001 is geo-blocking; 10004004, 10004005 and 10023006 mean a login is needed or the episode is premium-only. The title and cover come from the page's embedded state (`__INITIAL_DATA__` / `__INITIAL_STATE__`: `OgvVideo.epDetail`, `UgcVideo.videoData`), else its `og:` tags and JSON-LD. **Durations are not yt-dlp's facts here**: yt-dlp reads only a JSON-LD `duration` on these pages. StreamFetch also reads the embedded state's and the series list's `duration` / `duration_ms` / `video_duration` (a bare number counts as milliseconds from 10 000 on, as seconds below; the JSON-LD duration decides when the page has one) and, when neither states a duration, the stream answer's `playurl.duration`, read as milliseconds and only from 10 000 on. Each file is checked against the first of these that exists; a wrong reading fails the file with both durations in the message instead of saving it wrongly, and the report shows the raw values, so the first run settles them. A series is read from `…/web/v2/ogv/play/season_info` and `…/web/v2/ogv/play/episodes`. Hosts: `*.bilibili.tv`, `*.biliintl.com`, covers on `*.bstarstatic.com`; **the media hosts are not documented** — StreamFetch covers `*.bilivideo.com`, `*.bilivideo.cn`, `upos-bstar1-mirrorakam.akamaized.net` and `*.bstarstatic.com`, and a media address on any other host is never requested: the row and the report name the host (`host not covered`), so the first real run tells which host to add.
- **Every byte of the extension is this repository's own code.** No library, no npm dependency, no vendored or remote code: the HLS and DASH readers, the MPEG-TS demuxer (H.264 and AAC) and the progressive MP4 writer are written here and proven in the tests against ffmpeg and ffprobe — the saved files' video is frame-for-frame identical (`framemd5`) to the source for every path (MPEG-TS HLS, fragmented-MP4 HLS, Bilibili DASH, Bilibili.tv progressive and fragmented MP4), and the audio equal to what the writer was given.
- **Permissions** (and why): `downloads` (save the files), `storage` (settings, history, cooldown), `declarativeNetRequestWithHostAccess` (the one `Referer` / `Origin` rule on the extension's own requests to the sites' media hosts — and Dailymotion's and Bilibili.tv's own domains, see above), and host access to the three sites' pages, APIs and media hosts listed above. No `tabs`, `scripting`, `webRequest`, `cookies`, `debugger` or access to all sites. The popup reads only the active tab's address, which Chrome gives for those hosts.

## Limits of 1.0

- Video pages only: no playlists, channels, searches, favourites or lists; no Bilibili bangumi (anime), courses, festival pages or audio; no live streams; no other sites.
- No subtitles; no FLV / legacy Bilibili streams; no interactive (branching) videos; no HLS streams spliced with discontinuities; MPEG-TS streams carry H.264 video and AAC audio only (what Dailymotion serves).
- `bili.im` share links are not expanded (paste the full link); a Bilibili.tv series is limited to 200 episodes, a batch to 100 links.
- No parallel downloads and no scheduling, by design. A run lives in the StreamFetch tab: closing it stops the run.
- Nothing premium, paid, region-locked or encrypted is ever downloaded unless your own session is served it in the clear.
- Built and tested without access to the sites; the facts above are dated, and the sites change without notice.

## Development

```bash
cd StreamFetch/extension
STREAMFETCH_REQUIRE_TOOLS=1 node --test                      # unit tests (Node 22; ffmpeg and ffprobe for the media proofs)
npx -y -p typescript@5.9.3 tsc -p jsconfig.json             # strict checkJs type check
cd .. && python -m venv .venv && .venv/bin/pip install -r tests/requirements.txt   # once: pytest, Playwright, ruff
STREAMFETCH_CHROMIUM=/path/to/chromium STREAMFETCH_REQUIRE_TOOLS=1 .venv/bin/pytest   # the end-to-end suite against the fake sites
.venv/bin/ruff check tests && .venv/bin/ruff format --check tests
```

The rules for working on StreamFetch — scope, acceptance criteria, architecture, conventions, definition of done — are in [`CLAUDE.md`](./CLAUDE.md); what changed in each version is in [`CHANGELOG.md`](./CHANGELOG.md).
