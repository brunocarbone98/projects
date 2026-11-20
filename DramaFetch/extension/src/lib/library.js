// @ts-check
/**
 * The library: the user's TikTok Bookmark (**Favorites** → **Drama** on their own profile) as the
 * DramaFetch tab shows it — DramaFetch 1.6.0, the owner's request of 2026-11-19. Pure: no
 * `chrome.*`, no DOM (`src/app/app.js` reads the list with `src/app/favorites.js`, shows the cards
 * and keeps the library in `chrome.storage.local`; `src/app/bookmark.js` removes a drama from the
 * Bookmark). An extension-only feature, like the favorites list: the Python tool has none, and
 * nothing here decides anything about a download — the library only puts series ids into the
 * existing engine (a `batch` job, the same as a paste of their ids into the box).
 *
 * What it decides:
 * - each drama's status from DramaFetch's OWN records ({@link progressOf}: `on-disk`, `partly`,
 *   `none` — `lib/favorites.progressStatus` —, with the episodes saved, the episodes it has — the
 *   list's count raised to what the records hold: the number its card shows, its status fraction,
 *   **Most episodes** and the selection's sum alike, so a card never disagrees with itself — and
 *   the locked ones the records hold (DramaFetch 1.7.0: no request, nothing unlocked)) and from the
 *   jobs: `queued` (in a waiting `batch` / `selection` job), `running` (the series the running job
 *   is downloading), `removed` (removed from the Bookmark by DramaFetch since the last listing) —
 *   {@link libraryStatus};
 * - the filters' counts ({@link chipCounts}: every drama not removed counted once, under its
 *   STORED status — a queued or running drama under the status its records give), the twins
 *   ({@link twinIds}: different series of the same title), the sort orders ({@link sortedItems};
 *   the one picked last kept across sessions, read back with {@link librarySortOf}) and the search
 *   ({@link titleMatches} of `lib/favorites.js`);
 * - the smart refresh's question ({@link unchangedSince}): is TikTok's list still the library's —
 *   TikTok's `total` equal to the library's dramas not removed AND the first page's series ids,
 *   in order, the library's first ones? Then one request was enough — while the library's episode
 *   counts are fresh ({@link countsFresh}: its whole list read less than `RECHECK_AFTER_S`, 24 h,
 *   ago — the engine's own trust in a complete series —: a series that gained episodes moves
 *   neither TikTok's total nor its first page, so only a whole read sees it);
 * - which cover addresses are still signed ({@link coverExpired}: TikTok's `x-expires`);
 * - what the library keeps across sessions ({@link libraryRecord} / {@link libraryOf}): the list's
 *   dramas (`seriesId`, `title`, `episodes`, `durationS`), TikTok's count, when it was read, the
 *   profile it was read from and the dramas DramaFetch removed since — NO cover URL, no address,
 *   nothing signed (those live in the page's memory and `chrome.storage.session` only);
 * - the facts the removal's confirmation shows ({@link removalFacts}): never a claim the records do
 *   not support (the cover line only when every saved episode's stored message says its cover was
 *   embedded).
 */

import { isDict } from "./catalog.js";
import { cleanTitle, knownEpisodes, progressStatus } from "./favorites.js";
import { DONE, RECHECK_AFTER_S } from "./messages.js";
import { completeSince, doneEntries, entryOf, lockedNumbers, readState, sortedEntries } from "./state.js";

/** The version of the stored library (`favoritesLibrary`): another one is no library. */
export const LIBRARY_VERSION = 1;
/** How many cards the grid adds at a time (the first ones shown, then **Show 60 more**). */
export const LIBRARY_PIECE = 60;
/** The status filters of the toolbar (`all` shows the removed dramas too, dashed). */
export const LIBRARY_FILTERS = Object.freeze(/** @type {const} */ (["all", "none", "partly", "on-disk"]));
/** The sort orders: the list's own (newest favorite first), title A–Z, most episodes first. */
export const LIBRARY_SORTS = Object.freeze(/** @type {const} */ (["recent", "title", "episodes"]));
/** The sort order of a library nobody sorted yet: the list's own. */
export const DEFAULT_LIBRARY_SORT = "recent";
/**
 * What a saved episode's stored message carries when its cover went into the MP4: the note of
 * `src/app/downloader.js` `Downloader.keep` (` + cover embedded`, ` + cover embedded + file`) —
 * `tests/library.test.js` keeps the two equal.
 */
export const COVER_EMBEDDED_NOTE = " + cover embedded";
/** A profile's handle as TikTok's addresses carry it (`/@<handle>`). */
const HANDLE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ID_RE = /^[0-9]{15,22}$/;
const ENDED = /** @type {const} */ (["cap", "until", "empty", "cursor"]);

/**
 * @typedef {import("./favorites.js").FavoriteItem} FavoriteItem
 * @typedef {"on-disk" | "partly" | "none"} StoredStatus
 * @typedef {"on-disk" | "partly" | "none" | "queued" | "running" | "removed"} LibraryStatus
 * @typedef {typeof LIBRARY_FILTERS[number]} LibraryFilter
 * @typedef {typeof LIBRARY_SORTS[number]} LibrarySort
 *
 * @typedef {object} Progress What DramaFetch's own records say of a drama ({@link progressOf}).
 * @property {StoredStatus} status
 * @property {number} saved the episodes saved (a `done` entry, or one a run found on disk)
 * @property {number | null} total how many episodes it has: the list's count raised to the highest
 *   episode number the records hold, else what the records know, else null — the number its card
 *   shows and its status fraction counts against
 * @property {number} locked the episodes the records hold as locked (`skipped-locked`: a run listed
 *   them as episodes the account may not play — paid ones it has not unlocked, or one whose DRM a
 *   download found — and skipped them; `lib/state.lockedNumbers`), 0 for a drama never run
 *
 * @typedef {object} LibraryEntry One drama as the grid and the filters see it.
 * @property {FavoriteItem} item
 * @property {Progress} progress
 * @property {boolean} removed removed from the Bookmark by DramaFetch since the last listing
 *
 * @typedef {object} ChipCounts The filters' counts: every drama not removed once, under its stored
 *   status (`none + partly + onDisk === all`), and the removed ones apart.
 * @property {number} all
 * @property {number} none
 * @property {number} partly
 * @property {number} onDisk
 * @property {number} removed
 *
 * @typedef {object} StoredItem A drama as the library keeps it: no cover URL, nothing signed.
 * @property {string} seriesId
 * @property {string | null} title
 * @property {number | null} episodes
 * @property {number | null} durationS
 *
 * @typedef {object} StoredLibrary The library kept across sessions (`favoritesLibrary` in
 *   `chrome.storage.local`, a cache: best effort).
 * @property {typeof LIBRARY_VERSION} v
 * @property {number} listedAt when the list was read, seconds since the epoch
 * @property {number | null} total how many dramas TikTok counts, as last read
 * @property {number | null} countedAt when that count was read (a removal's first page reads it
 *   again), seconds since the epoch
 * @property {number | null} fullReadAt when a listing last read the WHOLE list — every drama's
 *   episode count with it —, seconds since the epoch; null when the list was not read to its end
 *   (the smart refresh's first page never changes it)
 * @property {boolean} unconfirmed the count is the last one minus the dramas DramaFetch removed
 *   since, not read from TikTok (no TikTok tab with the list was open)
 * @property {boolean} complete the list's end was reached
 * @property {boolean} short TikTok stopped sending the list before its end
 * @property {"cap" | "until" | "empty" | "cursor" | null} ended why the listing ended early
 * @property {string | null} profile the `@handle` of the TikTok tab the list was read from
 * @property {StoredItem[]} items the list's dramas, in its order, each once
 * @property {{seriesId: string, at: number}[]} removed the dramas DramaFetch removed from the
 *   Bookmark since the list was read
 *
 * @typedef {object} RemovalFacts What DramaFetch's records say of a drama it may remove from the
 *   Bookmark ({@link removalFacts}).
 * @property {number} saved episodes on disk per the records
 * @property {number | null} total the list's episodes, else what the records know
 * @property {boolean} verified every saved episode was downloaded by DramaFetch (`done`): each one
 *   passed its checks before it was saved
 * @property {boolean} coverEmbedded every saved episode's stored message says its cover was
 *   embedded ({@link COVER_EMBEDDED_NOTE})
 * @property {number | null} completeAt when a run found the series complete (seconds), else null
 */

/**
 * How many episodes DramaFetch's records know a series has, when the list names none: the episodes
 * a run found complete plus the ones it recorded locked, else the highest episode number recorded.
 * @param {import("./state.js").SeriesState} state
 * @returns {number | null}
 */
function recordedTotal(state) {
  if (completeSince(state) !== null && typeof state.complete_episodes === "number") {
    return state.complete_episodes + lockedNumbers(state).length;
  }
  const entries = sortedEntries(state);
  const last = entries[entries.length - 1];
  return last === undefined ? null : last.number;
}

/**
 * What DramaFetch's own records say of a drama — read-only, no request: its stored status
 * (`lib/favorites.progressStatus`: `on-disk`, `partly`, or `none` when nothing is saved or the
 * series was never run), the episodes saved, how many it has (the list's `episodes` raised to the
 * highest episode number the records hold — under a complete mark, one on disk or locked only:
 * `lib/favorites.knownEpisodes` —, else what the records know) and how many the records hold as
 * locked (none for a drama never run: nothing is asked of TikTok to learn it).
 * @param {unknown} raw the stored state (`series:<id>`)
 * @param {string} seriesId
 * @param {number | null} episodes the list's episode count
 * @returns {Progress}
 */
export function progressOf(raw, seriesId, episodes) {
  const status = progressStatus(raw, seriesId, episodes) ?? "none";
  const state = readState(raw, seriesId);
  const saved = state === null ? 0 : doneEntries(state, () => true).length;
  const listed = state === null ? (episodes !== null && episodes > 0 ? episodes : null) : knownEpisodes(state, episodes);
  const locked = state === null ? 0 : lockedNumbers(state).length;
  return { status, saved, total: listed ?? (state === null ? null : recordedTotal(state)), locked };
}

/**
 * A drama's status on its card: `removed` before anything (the Bookmark no longer holds it), then
 * `running` (the running job downloads it now), `queued` (a waiting job will), else what the
 * records say.
 * @param {Progress} progress
 * @param {{queued: boolean, running: boolean, removed: boolean}} jobs
 * @returns {LibraryStatus}
 */
export function libraryStatus(progress, jobs) {
  if (jobs.removed) return "removed";
  if (jobs.running) return "running";
  if (jobs.queued) return "queued";
  return progress.status;
}

/**
 * The library's dramas, each once, at its first place in the list (a drama the list holds twice
 * is one card).
 * @template {{seriesId: string}} T
 * @param {readonly T[]} items
 * @returns {T[]}
 */
export function distinctItems(items) {
  /** @type {Set<string>} */
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.seriesId)) return false;
    seen.add(item.seriesId);
    return true;
  });
}

/**
 * The filters' counts: every drama not removed once, under its stored status — a queued or running
 * drama counts where its records put it —, so `none + partly + onDisk === all`; the removed ones
 * apart (their own line), in no other count.
 * @param {readonly LibraryEntry[]} entries
 * @returns {ChipCounts}
 */
export function chipCounts(entries) {
  const counts = { all: 0, none: 0, partly: 0, onDisk: 0, removed: 0 };
  for (const entry of entries) {
    if (entry.removed) {
      counts.removed += 1;
      continue;
    }
    counts.all += 1;
    if (entry.progress.status === "on-disk") counts.onDisk += 1;
    else if (entry.progress.status === "partly") counts.partly += 1;
    else counts.none += 1;
  }
  return counts;
}

/**
 * Whether a drama is shown under a status filter: `all` shows every drama (the removed ones as
 * dashed cards); `none`, `partly` and `on-disk` the dramas not removed whose records say so.
 * @param {LibraryFilter} filter
 * @param {LibraryEntry} entry
 * @returns {boolean}
 */
export function inFilter(filter, entry) {
  if (filter === "all") return true;
  return !entry.removed && entry.progress.status === filter;
}

/**
 * The series of the library whose title (on one line, NFC: `cleanTitle`) another DIFFERENT series
 * of it bears too — the badge “Same title as another favorite”. A drama without a title has none.
 * @param {readonly FavoriteItem[]} items
 * @returns {Set<string>}
 */
export function twinIds(items) {
  /** @type {Map<string, Set<string>>} title → the series bearing it */
  const byTitle = new Map();
  for (const item of items) {
    const title = item.title === null ? "" : cleanTitle(item.title);
    if (title === "") continue;
    const bearing = byTitle.get(title) ?? new Set();
    bearing.add(item.seriesId);
    byTitle.set(title, bearing);
  }
  /** @type {Set<string>} */
  const twins = new Set();
  for (const bearing of byTitle.values()) if (bearing.size > 1) for (const seriesId of bearing) twins.add(seriesId);
  return twins;
}

/**
 * Titles compared as people read them: letter case and accents aside (`Á` sorts with `A`), numbers
 * by value (`Episode 2` before `Episode 10`).
 */
const TITLE_ORDER = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/**
 * A sort order as the library keeps it across sessions (`librarySort` in `chrome.storage.local`)
 * or as its menu holds it: one of {@link LIBRARY_SORTS}, else — nothing kept yet, or anything else
 * — the list's own ({@link DEFAULT_LIBRARY_SORT}).
 * @param {unknown} value
 * @returns {LibrarySort}
 */
export function librarySortOf(value) {
  return typeof value === "string" && /** @type {readonly string[]} */ (LIBRARY_SORTS).includes(value) ? /** @type {LibrarySort} */ (value) : DEFAULT_LIBRARY_SORT;
}

/**
 * The library in a sort order, a new array: `recent` the list's own order (newest favorite first),
 * `title` A–Z ({@link TITLE_ORDER}: letter case and accents aside, numbers by value; a drama
 * without a title last), `episodes` most first — the number each card shows, `progress.total` (a
 * drama whose count is unknown last); ties keep the list's order.
 * @template {{item: FavoriteItem, progress: Progress}} T
 * @param {readonly T[]} entries in the list's order
 * @param {LibrarySort} sort
 * @returns {T[]}
 */
export function sortedItems(entries, sort) {
  const indexed = entries.map((entry, index) => ({ entry, index }));
  if (sort === "title") {
    indexed.sort((a, b) => {
      const left = a.entry.item.title === null ? null : cleanTitle(a.entry.item.title);
      const right = b.entry.item.title === null ? null : cleanTitle(b.entry.item.title);
      if (left === null || right === null) return left === right ? a.index - b.index : left === null ? 1 : -1;
      return TITLE_ORDER.compare(left, right) || a.index - b.index;
    });
  } else if (sort === "episodes") {
    indexed.sort((a, b) => {
      const left = a.entry.progress.total;
      const right = b.entry.progress.total;
      if (left === null || right === null) return left === right ? a.index - b.index : left === null ? 1 : -1;
      return right - left || a.index - b.index;
    });
  }
  return indexed.map(({ entry }) => entry);
}

/**
 * The episodes a selection adds up to: the sum of the selected dramas' episode counts as their
 * cards show them (`progress.total`: the list's count raised to what the records hold; a drama
 * whose count is unknown adds none), each drama once.
 * @param {readonly {item: FavoriteItem, progress: Progress}[]} entries
 * @param {ReadonlySet<string>} selected series ids
 * @returns {number}
 */
export function selectionEpisodes(entries, selected) {
  /** @type {Set<string>} */
  const counted = new Set();
  let sum = 0;
  for (const { item, progress } of entries) {
    if (!selected.has(item.seriesId) || counted.has(item.seriesId)) continue;
    counted.add(item.seriesId);
    sum += progress.total ?? 0;
  }
  return sum;
}

/**
 * The smart refresh's question, asked of the first page of TikTok's list: is the library still
 * TikTok's list? Yes when TikTok's `total` equals the library's dramas not removed AND the first
 * page's series ids are, in order, the library's first ones (not removed) — a favorite added sits
 * at the top (newest first) and changes that page, one removed changes the total. Anything else —
 * no total, a page longer than the library, an id out of place — reads the list on.
 * @param {readonly string[]} kept the library's series ids not removed, in its order
 * @param {readonly string[]} firstPage the series ids of TikTok's first page, in order
 * @param {number | null} total TikTok's count on that page
 * @returns {boolean}
 */
export function unchangedSince(kept, firstPage, total) {
  if (total === null || total !== kept.length || firstPage.length > kept.length) return false;
  if (firstPage.length === 0) return total === 0;
  return firstPage.every((seriesId, index) => kept[index] === seriesId);
}

/**
 * Whether what was read at `readAt` — the library's whole list (its episode counts), or a run
 * that found a series complete — is still trusted at `nowS`: less than `RECHECK_AFTER_S` (24 h)
 * ago, the engine's own window for a complete series (a time in the future is not trusted). A
 * series gains episodes without moving TikTok's count or the list's first page.
 * @param {number | null} readAt seconds since the epoch, or null (never)
 * @param {number} nowS
 * @returns {boolean}
 */
export function countsFresh(readAt, nowS) {
  if (readAt === null) return false;
  const age = nowS - readAt;
  return age >= 0 && age < RECHECK_AFTER_S;
}

/**
 * Whether a cover's signed address has expired at `nowS`: TikTok signs its image addresses for a
 * while (`x-expires`, seconds since the epoch, in the query — about two days in the owner's
 * capture), and refuses them after. An address without that parameter (or with another value than
 * whole seconds) is not judged: not expired.
 * @param {string} url
 * @param {number} nowS
 * @returns {boolean}
 */
export function coverExpired(url, nowS) {
  let expires;
  try {
    expires = new URL(url).searchParams.get("x-expires");
  } catch {
    return false;
  }
  return expires !== null && /^[0-9]{1,15}$/.test(expires) && Number(expires) <= nowS;
}

/**
 * The `@handle` of a TikTok profile page's address (`https://www.tiktok.com/@<handle>…`, or the
 * fake TikTok's `/@<handle>` in test mode), or null when the address names none DramaFetch can
 * read (letters, digits, `.`, `_` and `-`, as TikTok's handles are).
 * @param {string} url
 * @returns {string | null}
 */
export function profileHandleOf(url) {
  if (typeof url !== "string") return null;
  const match = /^https?:\/\/[^/?#\s]+\/@([^/?#\s]+)/i.exec(url);
  if (match === null) return null;
  let handle = String(match[1]);
  try {
    handle = decodeURIComponent(handle);
  } catch {
    return null;
  }
  return HANDLE_RE.test(handle) ? `@${handle}` : null;
}

/**
 * `value` when it is a profile's `@handle` as {@link profileHandleOf} gives one, else null: what a
 * stored handle is read back as.
 * @param {unknown} value
 * @returns {string | null}
 */
export function storedHandle(value) {
  return typeof value === "string" && value.startsWith("@") && HANDLE_RE.test(value.slice(1)) ? value : null;
}

/**
 * How long ago `then` was, in the largest whole unit: `now` under a minute, else minutes under an
 * hour, hours under a day, days.
 * @param {number} now seconds since the epoch
 * @param {number} then seconds since the epoch
 * @returns {{unit: "now" | "minutes" | "hours" | "days", count: number}}
 */
export function ageOf(now, then) {
  const seconds = Math.max(0, now - then);
  if (seconds < 60) return { unit: "now", count: 0 };
  if (seconds < 3600) return { unit: "minutes", count: Math.floor(seconds / 60) };
  if (seconds < 86_400) return { unit: "hours", count: Math.floor(seconds / 3600) };
  return { unit: "days", count: Math.floor(seconds / 86_400) };
}

/**
 * @param {unknown} value
 * @returns {number | null} a finite number, else null
 */
function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * @param {unknown} value
 * @returns {number | null} a whole count from 0, else null
 */
function count(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * A drama as the library keeps it — its id, title, episodes and length, nothing else (no cover
 * URL) —, or null without a valid series id.
 * @param {unknown} raw
 * @returns {StoredItem | null}
 */
function storedItemOf(raw) {
  if (!isDict(raw)) return null;
  const seriesId = raw["seriesId"];
  if (typeof seriesId !== "string" || !ID_RE.test(seriesId)) return null;
  const title = raw["title"];
  const durationS = finite(raw["durationS"]);
  return {
    seriesId,
    title: typeof title === "string" && cleanTitle(title) ? cleanTitle(title) : null,
    episodes: count(raw["episodes"]),
    durationS: durationS !== null && durationS >= 0 ? durationS : null,
  };
}

/**
 * What the library keeps of a listing (`favoritesLibrary`): the dramas each once, in the list's
 * order, stripped to their id, title, episodes and length — no cover URL, nothing signed —, the
 * removed ones that are still in it, and the rest as given.
 * @param {{listedAt: number, total: number | null, countedAt?: number | null, fullReadAt?: number | null, unconfirmed?: boolean, complete: boolean, short: boolean, ended: StoredLibrary["ended"], profile: string | null, items: readonly FavoriteItem[] | readonly StoredItem[], removed: ReadonlyMap<string, number>}} library
 * @returns {StoredLibrary}
 */
export function libraryRecord(library) {
  /** @type {StoredItem[]} */
  const items = [];
  for (const item of distinctItems(library.items)) {
    const stored = storedItemOf(item);
    if (stored !== null) items.push(stored);
  }
  const listed = new Set(items.map((item) => item.seriesId));
  return {
    v: LIBRARY_VERSION,
    listedAt: library.listedAt,
    total: library.total,
    countedAt: library.countedAt ?? null,
    fullReadAt: library.fullReadAt ?? null,
    unconfirmed: library.unconfirmed === true,
    complete: library.complete,
    short: library.short,
    ended: library.ended,
    profile: library.profile,
    items,
    removed: [...library.removed].filter(([seriesId]) => listed.has(seriesId)).map(([seriesId, at]) => ({ seriesId, at })),
  };
}

/**
 * The library as `chrome.storage.local` holds it, checked (a cache: anything malformed is no
 * library, a drama without a valid series id is left out), or null.
 * @param {unknown} raw
 * @returns {StoredLibrary | null}
 */
export function libraryOf(raw) {
  if (!isDict(raw) || raw["v"] !== LIBRARY_VERSION || !Array.isArray(raw["items"])) return null;
  const listedAt = finite(raw["listedAt"]);
  if (listedAt === null) return null;
  /** @type {StoredItem[]} */
  const items = [];
  for (const entry of /** @type {unknown[]} */ (raw["items"])) {
    const item = storedItemOf(entry);
    if (item !== null) items.push(item);
  }
  const listed = new Set(items.map((item) => item.seriesId));
  /** @type {{seriesId: string, at: number}[]} */
  const removed = [];
  for (const entry of Array.isArray(raw["removed"]) ? /** @type {unknown[]} */ (raw["removed"]) : []) {
    if (!isDict(entry)) continue;
    const seriesId = entry["seriesId"];
    const at = finite(entry["at"]);
    if (typeof seriesId === "string" && listed.has(seriesId) && at !== null) removed.push({ seriesId, at });
  }
  const profile = raw["profile"];
  const ended = raw["ended"];
  return {
    v: LIBRARY_VERSION,
    listedAt,
    total: count(raw["total"]),
    countedAt: finite(raw["countedAt"]),
    fullReadAt: finite(raw["fullReadAt"]),
    unconfirmed: raw["unconfirmed"] === true,
    complete: raw["complete"] === true,
    short: raw["short"] === true,
    ended: typeof ended === "string" && /** @type {readonly string[]} */ (ENDED).includes(ended) ? /** @type {StoredLibrary["ended"]} */ (ended) : null,
    profile: storedHandle(profile),
    items: distinctItems(items),
    removed,
  };
}

/**
 * What the confirmation of **Remove from Favorites** says of a drama — only what DramaFetch's own
 * records support: the episodes on disk and how many it has, whether every one of them was
 * downloaded by DramaFetch (checked before it was saved), whether every one's stored message says
 * its cover was embedded, and when a run found the series complete.
 * @param {unknown} raw the stored state (`series:<id>`)
 * @param {string} seriesId
 * @param {number | null} episodes the list's episode count
 * @returns {RemovalFacts}
 */
export function removalFacts(raw, seriesId, episodes) {
  const progress = progressOf(raw, seriesId, episodes);
  const state = readState(raw, seriesId);
  /** @type {import("./state.js").StateEntry[]} the entries of the episodes on disk */
  const saved = [];
  if (state !== null) {
    for (const [number] of doneEntries(state, () => true)) {
      const entry = entryOf(state, number);
      if (entry !== null) saved.push(entry);
    }
  }
  return {
    saved: progress.saved,
    total: progress.total,
    verified: saved.length > 0 && saved.every((entry) => entry.status === DONE),
    coverEmbedded: saved.length > 0 && saved.every((entry) => entry.status === DONE && entry.message.includes(COVER_EMBEDDED_NOTE)),
    completeAt: state === null ? null : completeSince(state),
  };
}
