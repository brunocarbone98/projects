// @ts-check
// Unit tests of the episode list's thumbnails (src/app/downloader.js CoverLoader): a thumbnail is
// wanted only once its row's cover cell is in view, the wanted ones go out in the list's order, one
// request at a time, each after its pause, allowed() asked before the pause and right before the
// request, every thumbnail kept by item id — over a fake IntersectionObserver and a fake fetch.
import assert from "node:assert/strict";
import { test } from "node:test";

import { COVER_MARGIN_PX, CoverLoader } from "../src/app/downloader.js";

/** A JPEG-looking cover of 600 bytes (the magic decides; nothing decodes it). */
const COVER = (() => {
  const out = new Uint8Array(600);
  out.set([0xff, 0xd8, 0xff, 0xe0]);
  out.set([0xff, 0xd9], 598);
  return out;
})();

/** A deferred: a promise and the function that settles it. */
function deferred() {
  /** @type {() => void} */
  let resolve = () => undefined;
  const promise = new Promise((done) => {
    resolve = () => done(undefined);
  });
  return { promise, resolve };
}

/** Let every queued promise job run. */
const settle = () => new Promise((done) => setTimeout(done, 0));

/**
 * A loader over fakes: a watcher whose callback the test calls, a fetch that logs (and may be held
 * back), scriptable `allowed()` and pauses.
 * @param {{allowed?: () => boolean, pause?: () => Promise<void>, hold?: boolean, failing?: Set<string>}} [options]
 */
function harness(options = {}) {
  /** @type {string[]} */
  const log = [];
  /** @type {string[]} */
  const events = [];
  /** @type {string[]} */
  const shown = [];
  let inFlight = 0;
  let most = 0;
  /** @type {(() => void)[]} */
  const held = [];
  /** @type {{callback: (entries: readonly {target: Element, isIntersecting: boolean}[]) => void, init: {rootMargin: string}, observed: Set<Element>, unobserved: Element[], disconnected: boolean}[]} */
  const watchers = [];
  const loader = new CoverLoader({
    hostPatterns: ["https://*.tiktokcdn.com/*"],
    allowed: async () => {
      events.push("allowed?");
      return options.allowed ? options.allowed() : true;
    },
    pause: async () => {
      events.push("pause");
      if (options.pause) await options.pause();
    },
    onCover: (itemId, url) => void shown.push(`${itemId} ${url}`),
    fetch: /** @type {typeof fetch} */ (
      async (input, init) => {
        const url = String(input);
        log.push(url);
        events.push(`GET ${url.slice(url.lastIndexOf("/") + 1)}`);
        assert.equal(init?.redirect, "manual");
        inFlight += 1;
        most = Math.max(most, inFlight);
        if (options.hold) await new Promise((done) => held.push(() => done(undefined)));
        else await settle();
        inFlight -= 1;
        if (options.failing?.has(url)) return new Response("no", { status: 404 });
        return new Response(COVER, { headers: { "content-type": "image/jpeg" } });
      }
    ),
    objectUrl: (blob) => `blob:${blob.type}:${blob.size}`,
    watcher: (callback, init) => {
      const watcher = { callback, init, observed: new Set(), unobserved: /** @type {Element[]} */ ([]), disconnected: false };
      watchers.push(watcher);
      return {
        observe: (target) => void watcher.observed.add(target),
        unobserve: (target) => {
          watcher.observed.delete(target);
          watcher.unobserved.push(target);
        },
        disconnect: () => {
          watcher.disconnected = true;
          watcher.observed.clear();
        },
      };
    },
  });
  return { loader, log, events, shown, watchers, held, most: () => most };
}

/** @param {number} n */
const cover = (n) => `https://p16.tiktokcdn.com/c/${n}.jpeg`;
/** The list: items i1…i6 with covers, i7 on a host the manifest does not cover, i8 without one. */
const LIST = [
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ itemId: `i${n}`, coverUrl: cover(n) })),
  { itemId: "i7", coverUrl: "https://evil.example.com/7.jpeg" },
  { itemId: "i8", coverUrl: null },
];

/**
 * Show the list and watch every row's cell (what renderSeries does).
 * @param {CoverLoader} loader
 * @returns {Map<string, Element>} the fake cells by item id
 */
function render(loader) {
  loader.show(LIST);
  /** @type {Map<string, Element>} */
  const cells = new Map();
  for (const { itemId } of LIST) {
    const cell = /** @type {Element} */ (/** @type {unknown} */ ({ itemId }));
    cells.set(itemId, cell);
    loader.watch(cell, itemId);
  }
  return cells;
}

/**
 * The watcher reports cells coming into view (true) or leaving it (false).
 * @param {ReturnType<typeof harness>} h
 * @param {Map<string, Element>} cells
 * @param {[string, boolean][]} changes
 */
function report(h, cells, changes) {
  const watcher = h.watchers.at(-1);
  assert.ok(watcher !== undefined);
  watcher.callback(changes.map(([itemId, isIntersecting]) => ({ target: /** @type {Element} */ (cells.get(itemId)), isIntersecting })));
}

test("nothing is wanted before its row is in view; the rows in view go out in the list's order", async () => {
  const h = harness();
  const cells = render(h.loader);
  await h.loader.idle();
  assert.deepEqual(h.log, []); // the list shown: no request yet
  const watcher = h.watchers[0];
  assert.ok(watcher !== undefined);
  assert.equal(watcher.init.rootMargin, `${COVER_MARGIN_PX}px 0px`);
  assert.equal(watcher.observed.size, 7); // every row with a cover URL; i8 has none
  report(h, cells, [["i3", true], ["i1", true], ["i5", true], ["i8", true]]);
  assert.deepEqual(h.loader.wanted(), ["i1", "i3", "i5"]);
  await h.loader.idle();
  assert.deepEqual(h.log, [cover(1), cover(3), cover(5)]);
  assert.deepEqual(h.shown, ["i1 blob:image/jpeg:600", "i3 blob:image/jpeg:600", "i5 blob:image/jpeg:600"]);
  // each asked for once, then no longer watched
  assert.deepEqual(watcher.unobserved.map((cell) => /** @type {{itemId: string}} */ (/** @type {unknown} */ (cell)).itemId), ["i1", "i3", "i5"]);
  // scrolling on: the rows that come into view next
  report(h, cells, [["i1", false], ["i3", false], ["i5", false], ["i6", true], ["i4", true]]);
  await h.loader.idle();
  assert.deepEqual(h.log.slice(3), [cover(4), cover(6)]);
});

test("one request at a time, each after its own pause; allowed() before the pause and right before the request", async () => {
  const h = harness({ hold: true });
  const cells = render(h.loader);
  report(h, cells, [["i1", true], ["i2", true], ["i3", true]]);
  for (let round = 0; round < 3; round += 1) {
    while (h.held.length === 0) await settle();
    assert.equal(h.held.length, 1); // one request in flight, never two
    /** @type {() => void} */ (h.held.shift())();
  }
  await h.loader.idle();
  assert.equal(h.most(), 1);
  assert.deepEqual(h.events, [
    ...["allowed?", "pause", "allowed?", "GET 1.jpeg"],
    ...["allowed?", "pause", "allowed?", "GET 2.jpeg"],
    ...["allowed?", "pause", "allowed?", "GET 3.jpeg"],
  ]);
});

test("the gates: nothing goes out while a job runs or a cooldown lasts, before the pause or after it", async () => {
  let allowed = false;
  const h = harness({ allowed: () => allowed });
  const cells = render(h.loader);
  report(h, cells, [["i1", true], ["i2", true]]);
  await h.loader.idle();
  assert.deepEqual(h.events, ["allowed?"]); // refused before the pause: no pause, no request
  assert.deepEqual(h.log, []);
  // allowed before the pause, refused right before the request (a job queued during the pause)
  const pause = deferred();
  const h2 = harness({ allowed: () => allowed, pause: () => pause.promise });
  const cells2 = render(h2.loader);
  allowed = true;
  report(h2, cells2, [["i1", true]]);
  while (!h2.events.includes("pause")) await settle();
  allowed = false;
  pause.resolve();
  await h2.loader.idle();
  assert.deepEqual(h2.events, ["allowed?", "pause", "allowed?"]);
  assert.deepEqual(h2.log, []);
  assert.deepEqual(h2.loader.wanted(), ["i1"]); // still wanted: the job's end resumes it
  allowed = true;
  h2.loader.resume();
  await h2.loader.idle();
  assert.deepEqual(h2.log, [cover(1)]);
});

test("a row that leaves the view before its request is not fetched; the view decides after the pause", async () => {
  const pause = deferred();
  let pauses = 0;
  const h = harness({
    pause: async () => {
      pauses += 1;
      if (pauses === 1) await pause.promise;
    },
  });
  const cells = render(h.loader);
  report(h, cells, [["i1", true], ["i2", true]]);
  while (pauses === 0) await settle();
  report(h, cells, [["i1", false], ["i2", false], ["i5", true]]); // scrolled during the first pause
  pause.resolve();
  await h.loader.idle();
  assert.deepEqual(h.log, [cover(5)]); // one pause, one request: the row in view now
  assert.equal(pauses, 1);
  report(h, cells, [["i2", true]]); // scrolled back
  await h.loader.idle();
  assert.deepEqual(h.log, [cover(5), cover(2)]);
});

test("a host the manifest does not cover is never asked for (no pause either); a failure is not asked again", async () => {
  const h = harness({ failing: new Set([cover(2)]) });
  const cells = render(h.loader);
  report(h, cells, [["i7", true], ["i2", true]]);
  await h.loader.idle();
  assert.deepEqual(h.log, [cover(2)]);
  assert.deepEqual(h.events.filter((event) => event === "pause"), ["pause"]);
  assert.deepEqual(h.shown, []);
  assert.equal(h.loader.urlOf("i2"), null);
  report(h, cells, [["i2", false], ["i7", false]]);
  report(h, cells, [["i2", true], ["i7", true]]);
  await h.loader.idle();
  assert.deepEqual(h.log, [cover(2)]);
});

test("every thumbnail is kept by item id: the list shown again costs no request and watches nothing fetched", async () => {
  const h = harness();
  let cells = render(h.loader);
  report(h, cells, [["i1", true], ["i2", true]]);
  await h.loader.idle();
  assert.equal(h.loader.urlOf("i1"), "blob:image/jpeg:600");
  cells = render(h.loader); // after a job: the list rendered again
  const [first, second] = h.watchers;
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(first.disconnected, true); // the old list's watcher is gone
  assert.equal(second.observed.size, 5); // i3-i7: i1 and i2 are fetched already
  report(h, cells, [["i3", true]]);
  await h.loader.idle();
  assert.deepEqual(h.log, [cover(1), cover(2), cover(3)]);
});

test("a job waits for the thumbnail in flight: idle() settles only once it is done", async () => {
  const h = harness({ hold: true });
  const cells = render(h.loader);
  report(h, cells, [["i1", true], ["i2", true]]);
  while (h.held.length === 0) await settle();
  let idle = false;
  void h.loader.idle().then(() => {
    idle = true;
  });
  await settle();
  assert.equal(idle, false); // the request still in flight
  /** @type {() => void} */ (h.held.shift())();
  while (h.held.length === 0 && !idle) await settle();
  if (h.held.length > 0) /** @type {() => void} */ (h.held.shift())();
  await h.loader.idle();
  assert.equal(idle, true);
});
