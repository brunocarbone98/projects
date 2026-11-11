// @ts-check
/**
 * The work files of a download in the Origin Private File System (OPFS), the extension's own
 * private disk space: segments, sample files and the finished MP4 are streamed to disk as they
 * arrive and read back in slices, so a one-hour video never sits in memory. Everything lives in
 * `streamfetch/work/` as `<key>.<part>` files (`<key>.video.m4s`, `<key>.video.bin`,
 * `<key>.final.mp4`, …), `<key>` a file-safe form of the target's key ({@link workKey}); a
 * download removes its files when it ends, saved or not ({@link WorkFiles#removeWork}), and the
 * startup sweep removes what a closed tab left behind for more than 24 h ({@link WorkFiles#sweep}).
 *
 * The OPFS handles are reached through the small {@link DirLike} / {@link FileLike} surfaces
 * (what Chrome's `FileSystemDirectoryHandle` / `FileSystemFileHandle` offer), so the unit tests
 * run the same code over an in-memory fake.
 */

/** The OPFS directory of everything StreamFetch keeps. */
export const ROOT_DIR = "streamfetch";
/** The directory of the work files, inside {@link ROOT_DIR}. */
export const WORK_DIR = "work";
/** Leftovers older than this are deleted at startup. */
export const SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {{ type: "seek", position: number } | { type: "truncate", size: number }} WriteCommand
 *
 * @typedef {object} WritableLike What `FileSystemFileHandle.createWritable()` gives.
 * @property {(data: Uint8Array | WriteCommand) => Promise<void>} write
 * @property {() => Promise<void>} close
 * @property {() => Promise<void>} [abort]
 *
 * @typedef {object} FileLike A file handle.
 * @property {"file"} kind
 * @property {() => Promise<Blob & { lastModified?: number }>} getFile
 * @property {(options?: { keepExistingData?: boolean }) => Promise<WritableLike>} createWritable
 *
 * @typedef {object} DirLike A directory handle.
 * @property {"directory"} kind
 * @property {(name: string, options?: { create?: boolean }) => Promise<DirLike>} getDirectoryHandle
 * @property {(name: string, options?: { create?: boolean }) => Promise<FileLike>} getFileHandle
 * @property {(name: string, options?: { recursive?: boolean }) => Promise<void>} removeEntry
 * @property {() => AsyncIterable<[string, FileLike | DirLike]>} entries
 *
 * @typedef {object} AppendWriter A work file being written from the start, chunk after chunk.
 * @property {string} name the work file's name (what a `SampleRef.data.file` names)
 * @property {() => number} size bytes written so far
 * @property {(bytes: Uint8Array) => Promise<void>} write appends
 * @property {(size: number) => Promise<void>} truncate cuts the file to `size` bytes (0: restart)
 * @property {() => Promise<void>} close commits the file (OPFS writes land on close)
 * @property {() => Promise<void>} abort drops what was not committed
 *
 * @typedef {import("../lib/mp4.js").Mp4File} Mp4File
 *
 * @typedef {object} WorkOptions
 * @property {() => Promise<DirLike>} [root] the OPFS root (`navigator.storage.getDirectory()`)
 * @property {() => number} [now] milliseconds since the epoch
 * @property {() => Promise<{ quota?: number, usage?: number }>} [estimate]
 *   `navigator.storage.estimate()`
 */

/**
 * A file-safe form of a target's key: every character outside `[A-Za-z0-9_-]` becomes `_`
 * (`bilibili:BV1GJ411x7h7:2` → `bilibili_BV1GJ411x7h7_2`), at most 120 characters.
 * @param {string} key
 * @returns {string}
 */
export function workKey(key) {
  return String(key).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) || "work";
}

/**
 * The OPFS root of this page, as a {@link DirLike}.
 * @returns {Promise<DirLike>}
 */
async function opfsRoot() {
  const root = await navigator.storage.getDirectory();
  return /** @type {DirLike} */ (/** @type {unknown} */ (root));
}

/** The work files of the running page (one instance per page; tests make their own). */
export class WorkFiles {
  /** @param {WorkOptions} [options] */
  constructor(options = {}) {
    this.root = options.root ?? opfsRoot;
    this.now = options.now ?? (() => Date.now());
    this.estimate =
      options.estimate ??
      (async () => {
        const estimate = await navigator.storage.estimate();
        return { quota: estimate.quota, usage: estimate.usage };
      });
    /** @type {Promise<DirLike> | null} */
    this.dir = null;
  }

  /**
   * `streamfetch/work/`, created when missing.
   * @returns {Promise<DirLike>}
   */
  workDir() {
    if (this.dir === null) {
      this.dir = (async () => {
        const root = await this.root();
        const own = await root.getDirectoryHandle(ROOT_DIR, { create: true });
        return own.getDirectoryHandle(WORK_DIR, { create: true });
      })();
      this.dir.catch(() => {
        this.dir = null;
      });
    }
    return this.dir;
  }

  /**
   * The names of a download's work files: `<key>.<part>`.
   * @param {string} key the target's key (made file-safe here)
   * @returns {{ key: string, name: (part: string) => string }}
   */
  openWork(key) {
    const safe = workKey(key);
    return { key: safe, name: (part) => `${safe}.${part}` };
  }

  /**
   * A writer for a work file, from the start (an existing file of that name is emptied).
   * @param {string} name
   * @returns {Promise<AppendWriter>}
   */
  async appendWriter(name) {
    const dir = await this.workDir();
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    let size = 0;
    let open = true;
    return {
      name,
      size: () => size,
      write: async (bytes) => {
        if (bytes.length === 0) return;
        await writable.write(bytes);
        size += bytes.length;
      },
      truncate: async (to) => {
        await writable.write({ type: "truncate", size: to });
        await writable.write({ type: "seek", position: to });
        size = to;
      },
      close: async () => {
        if (!open) return;
        open = false;
        await writable.close();
      },
      abort: async () => {
        if (!open) return;
        open = false;
        if (writable.abort) await writable.abort().catch(() => undefined);
        else await writable.close().catch(() => undefined);
      },
    };
  }

  /**
   * A committed work file as a `Blob` (Chrome's `File`): what is handed to `chrome.downloads` and
   * read back in slices.
   * @param {string} name
   * @returns {Promise<Blob>}
   */
  async file(name) {
    const dir = await this.workDir();
    const handle = await dir.getFileHandle(name);
    return handle.getFile();
  }

  /**
   * A committed work file read in slices, as `lib/mp4.js` reads files ({@link Mp4File}): only the
   * bytes asked for are read.
   * @param {string} name
   * @returns {Promise<Mp4File>}
   */
  async slicer(name) {
    const blob = await this.file(name);
    return {
      name,
      size: blob.size,
      slice: async (start, end) => {
        const from = Math.max(0, Math.min(start, blob.size));
        const to = Math.max(from, Math.min(end, blob.size));
        return new Uint8Array(await blob.slice(from, to).arrayBuffer());
      },
    };
  }

  /**
   * Remove one work file; a missing one is not an error.
   * @param {string} name
   * @returns {Promise<void>}
   */
  async remove(name) {
    const dir = await this.workDir();
    await dir.removeEntry(name).catch(() => undefined);
  }

  /**
   * Remove every work file of a download (`<key>.*`).
   * @param {string} key the target's key (made file-safe here)
   * @returns {Promise<number>} how many files were removed
   */
  async removeWork(key) {
    const prefix = `${workKey(key)}.`;
    const dir = await this.workDir();
    /** @type {string[]} */
    const names = [];
    for await (const [name] of dir.entries()) if (name.startsWith(prefix)) names.push(name);
    for (const name of names) {
      await dir.removeEntry(name, { recursive: true }).catch(() => undefined);
    }
    return names.length;
  }

  /**
   * The startup sweep: work files last modified more than `maxAgeMs` ago (a tab closed in the
   * middle of a download) are deleted; recent ones are kept — another StreamFetch tab may be using
   * them.
   * @param {number} [maxAgeMs]
   * @returns {Promise<number>} how many entries were removed
   */
  async sweep(maxAgeMs = SWEEP_AGE_MS) {
    const dir = await this.workDir();
    const limit = this.now() - maxAgeMs;
    /** @type {string[]} */
    const stale = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== "file") {
        stale.push(name); // nothing of ours is a directory here
        continue;
      }
      const file = await handle.getFile().catch(() => null);
      const modified = file?.lastModified ?? 0;
      if (modified < limit) stale.push(name);
    }
    for (const name of stale) {
      await dir.removeEntry(name, { recursive: true }).catch(() => undefined);
    }
    return stale.length;
  }

  /**
   * The free space the browser grants this extension's storage, in bytes, or null when unknown.
   * @returns {Promise<number | null>}
   */
  async estimateFree() {
    try {
      const { quota, usage } = await this.estimate();
      if (typeof quota !== "number" || !Number.isFinite(quota)) return null;
      return Math.max(0, quota - (typeof usage === "number" ? usage : 0));
    } catch {
      return null;
    }
  }
}

/** @type {WorkFiles | null} */
let pageFiles = null;

/**
 * The page's work files (one shared instance over the real OPFS).
 * @returns {WorkFiles}
 */
export function defaultWorkFiles() {
  if (pageFiles === null) pageFiles = new WorkFiles();
  return pageFiles;
}

/**
 * {@link WorkFiles#openWork} of the page's work files.
 * @param {string} key
 */
export function openWork(key) {
  return defaultWorkFiles().openWork(key);
}

/**
 * {@link WorkFiles#appendWriter} of the page's work files.
 * @param {string} name
 */
export function appendWriter(name) {
  return defaultWorkFiles().appendWriter(name);
}

/**
 * {@link WorkFiles#slicer} of the page's work files.
 * @param {string} name
 */
export function slicer(name) {
  return defaultWorkFiles().slicer(name);
}

/**
 * {@link WorkFiles#removeWork} of the page's work files.
 * @param {string} key
 */
export function removeWork(key) {
  return defaultWorkFiles().removeWork(key);
}

/** {@link WorkFiles#estimateFree} of the page's work files. */
export function estimateFree() {
  return defaultWorkFiles().estimateFree();
}
