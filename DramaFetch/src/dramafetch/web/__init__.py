"""The local web UI: a stdlib ``http.server`` front end over the same engine the CLI uses.

`server.run_server` serves one HTML page (`static/index.html`, vanilla JS, no CDN) and a small JSON
API; `jobs.JobManager` runs downloads in the background, one at a time, and exposes snapshots for
the page to poll. Nothing here talks to TikTok directly: discovery and downloads go through
`dramafetch.engine`, which is imported lazily so the package can be loaded without Playwright.
"""
