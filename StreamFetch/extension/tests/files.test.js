// @ts-check
// app/files.js over an in-memory OPFS: work files written chunk by chunk (committed on close),
// truncated for a restart, read back in slices, removed per download, swept after 24 h.
import assert from "node:assert/strict";
import { test } from "node:test";

import { SWEEP_AGE_MS, WorkFiles, workKey } from "../src/app/files.js";

/**
 * An in-memory OPFS directory with Chrome's semantics for what files.js uses: a writable writes
 * to a swap copy that replaces the file on `close()`, `abort()` drops it; the handle of a
 * directory that was removed — with everything under it — rejects every call.
 */
class FakeDir {
  constructor() {
    /** @type {"directory"} */
    this.kind = "directory";
    /** @type {Map<string, FakeDir | FakeFile>} */
    this.entriesMap = new Map();
    this.removed = false;
  }

  /** Chrome's answer to any use of a removed directory's handle. */
  check() {
    if (this.removed) throw new DOMException("A requested file or directory could not be found at the time an operation was processed.", "NotFoundError");
  }

  /**
   * @param {string} name
   * @param {{ create?: boolean }} [options]
   * @returns {Promise<FakeDir>}
   */
  async getDirectoryHandle(name, options = {}) {
    this.check();
    const found = this.entriesMap.get(name);
    if (found instanceof FakeDir) return found;
    if (found !== undefined || !options.create) throw new Error(`NotFoundError: ${name}`);
    const dir = new FakeDir();
    this.entriesMap.set(name, dir);
    return dir;
  }

  /**
   * @param {string} name
   * @param {{ create?: boolean }} [options]
   * @returns {Promise<FakeFile>}
   */
  async getFileHandle(name, options = {}) {
    this.check();
    const found = this.entriesMap.get(name);
    if (found instanceof FakeFile) return found;
    if (found !== undefined || !options.create) throw new Error(`NotFoundError: ${name}`);
    const file = new FakeFile(name);
    this.entriesMap.set(name, file);
    return file;
  }

  /**
   * @param {string} name
   * @param {{ recursive?: boolean }} [options]
   */
  async removeEntry(name, options = {}) {
    this.check();
    const found = this.entriesMap.get(name);
    if (found === undefined) throw new Error(`NotFoundError: ${name}`);
    if (found instanceof FakeDir) {
      if (found.entriesMap.size > 0 && !options.recursive) throw new Error(`InvalidModificationError: ${name}`);
      /** @param {FakeDir} dir */
      const remove = (dir) => {
        dir.removed = true;
        for (const entry of dir.entriesMap.values()) if (entry instanceof FakeDir) remove(entry);
      };
      remove(found);
    }
    this.entriesMap.delete(name);
  }

  /** @returns {AsyncIterable<[string, FakeDir | FakeFile]>} */
  entries() {
    this.check();
    const list = [...this.entriesMap.entries()];
    return (async function* () {
      yield* list;
    })();
  }
}

/** One in-memory file. */
class FakeFile {
  /** @param {string} name */
  constructor(name) {
    /** @type {"file"} */
    this.kind = "file";
    this.name = name;
    this.bytes = new Uint8Array(0);
    this.lastModified = Date.now();
  }

  async getFile() {
    return new File([this.bytes.slice()], this.name, { lastModified: this.lastModified });
  }

  /** @param {{ keepExistingData?: boolean }} [options] */
  async createWritable(options = {}) {
    let swap = options.keepExistingData ? this.bytes.slice() : new Uint8Array(0);
    let cursor = 0;
    const file = this;
    return {
      /** @param {Uint8Array | { type: "seek", position: number } | { type: "truncate", size: number }} data */
      async write(data) {
        if (data instanceof Uint8Array) {
          const end = cursor + data.length;
          if (end > swap.length) {
            const grown = new Uint8Array(end);
            grown.set(swap, 0);
            swap = grown;
          }
          swap.set(data, cursor);
          cursor = end;
        } else if (data.type === "seek") {
          cursor = data.position;
        } else {
          const cut = new Uint8Array(data.size);
          cut.set(swap.subarray(0, Math.min(data.size, swap.length)), 0);
          swap = cut;
          cursor = Math.min(cursor, data.size);
        }
      },
      async close() {
        file.bytes = swap;
        file.lastModified = Date.now();
      },
      async abort() {},
    };
  }
}

/**
 * @param {number} [now]
 * @returns {{ files: WorkFiles, root: FakeDir }}
 */
function workFiles(now) {
  const root = new FakeDir();
  const files = new WorkFiles({
    root: async () => root,
    now: now === undefined ? undefined : () => now,
    estimate: async () => ({ quota: 1000, usage: 250 }),
  });
  return { files, root };
}

test("workKey makes a target key file-safe", () => {
  assert.equal(workKey("bilibili:BV1GJ411x7h7:2"), "bilibili_BV1GJ411x7h7_2");
  assert.equal(workKey("bilibilitv:video:4801520000000001"), "bilibilitv_video_4801520000000001");
  assert.equal(workKey("a/../b c"), "a____b_c");
  assert.equal(workKey("x".repeat(300)).length, 120);
});

test("a work file is written in chunks, committed on close and read back in slices", async () => {
  const { files, root } = workFiles();
  const work = files.openWork("dailymotion:xbq9z2k");
  assert.equal(work.name("video.bin"), "dailymotion_xbq9z2k.video.bin");
  const writer = await files.appendWriter(work.name("video.bin"));
  await writer.write(Uint8Array.from([1, 2, 3]));
  await writer.write(Uint8Array.from([4, 5]));
  await writer.write(new Uint8Array(0));
  assert.equal(writer.size(), 5);
  await writer.close();
  const dir = await (await root.getDirectoryHandle("streamfetch")).getDirectoryHandle("work");
  assert.deepEqual([...(await dir.getFileHandle("dailymotion_xbq9z2k.video.bin")).bytes], [1, 2, 3, 4, 5]);
  const file = await files.slicer(work.name("video.bin"));
  assert.equal(file.size, 5);
  assert.equal(file.name, "dailymotion_xbq9z2k.video.bin");
  assert.deepEqual([...(await file.slice(1, 4))], [2, 3, 4]);
  assert.deepEqual([...(await file.slice(3, 99))], [4, 5], "a slice past the end is cut");
  assert.equal((await files.file(work.name("video.bin"))).size, 5);
});

test("truncate restarts a file (a 200 answer to a Range request) and keeps writing after it", async () => {
  const { files } = workFiles();
  const writer = await files.appendWriter("k.video.m4s");
  await writer.write(Uint8Array.from([9, 9, 9, 9]));
  await writer.truncate(0);
  assert.equal(writer.size(), 0);
  await writer.write(Uint8Array.from([1, 2]));
  await writer.truncate(1);
  await writer.write(Uint8Array.from([7]));
  await writer.close();
  assert.deepEqual([...(await (await files.slicer("k.video.m4s")).slice(0, 10))], [1, 7]);
  const again = await files.appendWriter("k.video.m4s");
  await again.close();
  assert.equal((await files.slicer("k.video.m4s")).size, 0, "a new writer starts the file afresh");
});

test("removeWork removes every file of one download and nothing else", async () => {
  const { files, root } = workFiles();
  for (const name of ["a_1.video.m4s", "a_1.audio.m4s", "a_1.final.mp4", "a_10.video.m4s", "b.video.m4s"]) {
    const writer = await files.appendWriter(name);
    await writer.write(Uint8Array.from([1]));
    await writer.close();
  }
  assert.equal(await files.removeWork("a:1"), 3);
  const dir = await (await root.getDirectoryHandle("streamfetch")).getDirectoryHandle("work");
  assert.deepEqual([...dir.entriesMap.keys()].sort(), ["a_10.video.m4s", "b.video.m4s"]);
  await files.remove("missing.bin");
  assert.equal(await files.removeWork("none"), 0);
});

test("the startup sweep deletes leftovers older than 24 h and keeps recent files", async () => {
  const now = Date.now();
  const { files, root } = workFiles(now);
  for (const name of ["old.video.m4s", "new.video.m4s"]) {
    const writer = await files.appendWriter(name);
    await writer.close();
  }
  const dir = await (await root.getDirectoryHandle("streamfetch")).getDirectoryHandle("work");
  const old = /** @type {FakeFile} */ (dir.entriesMap.get("old.video.m4s"));
  old.lastModified = now - SWEEP_AGE_MS - 1000;
  assert.equal(await files.sweep(), 1);
  assert.deepEqual([...dir.entriesMap.keys()], ["new.video.m4s"]);
});

test("after Chrome deleted the extension's file system under the open tab (a full disk), the work folder comes back: the next download works without a reload", async () => {
  const { files, root } = workFiles();
  const first = await files.appendWriter("a.video.m4s");
  await first.write(Uint8Array.from([1, 2, 3]));
  await first.close();
  assert.equal(await files.removeWork("a"), 1);
  const before = await (await root.getDirectoryHandle("streamfetch")).getDirectoryHandle("work");
  await root.removeEntry("streamfetch", { recursive: true }); // what Chrome does when the profile's disk is full
  await assert.rejects(before.getFileHandle("b.video.m4s", { create: true }), { name: "NotFoundError" }); // a handle kept from before
  const second = await files.appendWriter("b.video.m4s");
  await second.write(Uint8Array.from([4, 5]));
  await second.close();
  assert.deepEqual([...(await (await files.slicer("b.video.m4s")).slice(0, 9))], [4, 5]);
  assert.equal((await files.file("b.video.m4s")).size, 2);
  assert.equal(await files.sweep(), 0);
  assert.equal(await files.removeWork("b"), 1);
  await files.remove("b.video.m4s"); // already gone: no throw
  const work = await (await root.getDirectoryHandle("streamfetch")).getDirectoryHandle("work");
  assert.notEqual(work, before);
  assert.deepEqual([...work.entriesMap.keys()], []);
});

test("estimateFree: the quota minus the usage, null when unknown", async () => {
  const { files } = workFiles();
  assert.equal(await files.estimateFree(), 750);
  const unknown = new WorkFiles({
    root: async () => new FakeDir(),
    estimate: async () => {
      throw new Error("no storage manager");
    },
  });
  assert.equal(await unknown.estimateFree(), null);
});
