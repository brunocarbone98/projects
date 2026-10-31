"""DramaFetch — download the TikTok short-drama episodes you can watch, a whole series at a time.

The package is split by responsibility: `urls` parses what the user pastes, `discovery` turns a
series into its episode list (TikTok's web app does this through `/api/drama/episode/item_list/`),
`catalog` holds the pure parsing and validation logic for those payloads, `downloader` hands each
episode to yt-dlp, `manifest` makes runs resumable, `cli` and `web` are the two front ends.
"""

__version__ = "0.1.0"
