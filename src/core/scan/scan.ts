import { pipe, collect, flatMap, from } from "@culvert/stream";
import type { Host, ScannedFile, ScanProgress } from "../../host/host";
import type { AudioFile, Book, Chapter } from "../types";
import { bookId } from "../bookid";
import { natcompare } from "../natsort";
import { RIBBON_DIR } from "./walk";
import { groupBooks, type BookGroup } from "./group";
import { probe } from "./probe";
import { orderKeys, parseNumbered, resolveMetadata } from "./metadata";
import { buildChapters, applyCorrections, rowsToCorrections, type Correction } from "./chapters";
import { booksToBytes, bytesToBooks, bytesToChapters, bytesToFiles, chaptersToBytes, filesToBytes, filesToRows } from "./records";
import { bytesToRows, type Row } from "../csv";
import { coverArgs } from "./cover";

export interface ScannedBook {
  book: Book;
  files: AudioFile[];
  chapters: Chapter[];
  /** Files found but not yet read. Absent once the book is complete. */
  pending?: number;
}

export interface ScanOptions {
  signal?: AbortSignal;
  /** Live progress from the host scanner. */
  onProgress?: (p: ScanProgress) => void;
  /**
   * The library as it takes shape: first from folder names alone, then
   * with each book's tags, then durations, a few times a second. The
   * returned result is the complete list; this is what to paint before it
   * arrives.
   */
  onBooks?: (books: ScannedBook[]) => void;
  /** Skip files whose size and mtime match `.ribbon/files.csv`. Default true. */
  incremental?: boolean;
  /** Write `.ribbon/*` records. Default true. */
  write?: boolean;
}

export interface ScanResult {
  books: ScannedBook[];
  errors: { path: string; message: string }[];
  probed: number;
  reused: number;
  /** Files the fast reader rejected that ffprobe then read. */
  rescued: number;
  elapsedMs: number;
  /**
   * Write the records. Already done when the scan ran with `write` on;
   * with it off, the caller decides when, so the shelf need not wait for
   * a slow share to accept two files.
   */
  save: () => Promise<void>;
  /** Where the time went, for the log. */
  timings: { recordsMs: number; scanMs: number; rescueMs: number; buildMs: number; writeMs: number; publishes: number; publishMs: number };
}

/** How often, at most, the streamed books are rebuilt and published. */
const PUBLISH_INTERVAL_MS = 120;

/** Everything on disk from the last scan, read once up front. */
interface Records {
  previous: Map<string, AudioFile>;
  previousBooks: Map<string, Book>;
  corrections: Map<string, Correction[]>;
  filesCsv: Uint8Array | null;
  libraryCsv: Uint8Array | null;
}

/**
 * Scan a library folder. The host walks and reads tags, streaming files
 * back as it goes; everything after that is a pure function of the file
 * list, so the books are rebuilt from whatever has arrived and published
 * through `onBooks` while the read continues. Chapter markers are not
 * read here: they are probed lazily by `ensureChapters` the first time a
 * book is opened, and cached in files.csv.
 */
export async function scanLibrary(host: Host, root: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const started = Date.now();
  let mark = started;
  const lap = () => {
    const now = Date.now();
    const ms = now - mark;
    mark = now;
    return ms;
  };
  const records = await readRecords(host, root, opts.incremental ?? true);
  const recordsMs = lap();
  const known = [...records.previous.values()].map((f) => ({ path: f.path, sizeBytes: f.sizeBytes, mtimeMs: f.mtimeMs }));

  const arrived = new Map<string, ScannedFile>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastPublish = 0;
  let publishes = 0;
  let publishMs = 0;
  const publish = () => {
    timer = null;
    const t = Date.now();
    const books = buildBooks(host, root, [...arrived.values()], records, []);
    opts.onBooks?.(books);
    publishes++;
    publishMs += Date.now() - t;
    lastPublish = Date.now();
  };
  const onFiles = (files: ScannedFile[]) => {
    for (const f of files) arrived.set(f.path, f);
    if (!opts.onBooks || timer !== null) return;
    timer = setTimeout(publish, Math.max(0, PUBLISH_INTERVAL_MS - (Date.now() - lastPublish)));
  };

  const out = await host.scan(root, known, opts.onProgress, onFiles);
  if (timer !== null) clearTimeout(timer);
  timer = null;
  const scanMs = lap();

  const stage = (text: string) => opts.onProgress?.({ walked: out.walked, done: out.walked, stage: text });
  const unreadable = out.files.filter((f) => f.kind === "audio" && f.fresh && f.durationMs <= 0).length;
  if (unreadable > 0) stage(`Checking ${unreadable.toLocaleString()} ${unreadable === 1 ? "file" : "files"} the tag reader could not read…`);
  const rescued = await rescueUnreadable(host, root, out.files, opts.signal);
  const rescueMs = lap();
  stage("Organizing books…");
  const errors: ScanResult["errors"] = [];
  const books = buildBooks(host, root, out.files, records, errors);
  const buildMs = lap();

  let saving: Promise<void> | null = null;
  const save = () => (saving ??= writeRecords(host, root, books, records));
  if (opts.write ?? true) {
    stage("Saving the library…");
    await save();
  }
  const writeMs = lap();
  return {
    books,
    errors,
    probed: out.probed,
    reused: out.reused,
    rescued,
    elapsedMs: Date.now() - started,
    save,
    timings: { recordsMs, scanMs, rescueMs, buildMs, writeMs, publishes, publishMs },
  };
}

/** Group a file list into books. Pure, apart from `errors` collecting the unreadable. */
function buildBooks(host: Host, root: string, files: readonly ScannedFile[], records: Records, errors: ScanResult["errors"]): ScannedBook[] {
  const groups = groupBooks(files.map((f) => ({ relPath: f.path, absPath: host.join(root, ...f.path.split("/")), name: f.name, sizeBytes: f.sizeBytes, mtimeMs: f.mtimeMs })));
  const byPath = new Map(files.map((f) => [f.path, f]));
  const out: ScannedBook[] = [];
  for (const group of groups) {
    const b = buildBook(group, byPath, records, errors);
    if (b) out.push(b);
  }
  return out;
}

/**
 * Covers that still need extracting: books with a picture in a file but
 * no cover image yet. Runs after the library is on screen, one book at a
 * time, and reports each book as its cover lands. The host copies the
 * picture bytes out of the tag when it can; ffmpeg is the fallback.
 * Returns the books that changed.
 */
export async function extractMissingCovers(
  host: Host,
  root: string,
  books: readonly ScannedBook[],
  onCover?: (book: ScannedBook) => void,
  signal?: AbortSignal,
): Promise<ScannedBook[]> {
  const prefix = `${RIBBON_DIR}/covers/`;
  const coversDir = host.join(root, RIBBON_DIR, "covers");
  let existing: Set<string> | null = null;
  const changed: ScannedBook[] = [];
  for (const b of books) {
    if (signal?.aborted) break;
    if (!b.book.cover.startsWith(prefix) || b.pending) continue;
    if (existing === null) {
      // One listing for the whole pass instead of one existence check per book.
      try {
        existing = new Set((await host.readDir(coversDir)).filter((e) => e.isFile).map((e) => e.name));
      } catch {
        existing = new Set();
      }
    }
    const name = b.book.cover.slice(prefix.length);
    if (existing.has(name)) continue;
    const src = b.files.find((f) => f.hasCover);
    if (!src) continue;
    const abs = host.join(root, ...b.book.cover.split("/"));
    const srcAbs = host.join(root, ...src.path.split("/"));
    let ok = false;
    if (host.extractCover) {
      try {
        ok = await host.extractCover(srcAbs, abs);
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      await host.mkdir(coversDir);
      ok = (await host.run("ffmpeg", coverArgs(srcAbs, abs), signal)).code === 0;
    }
    if (ok) {
      existing.add(name);
      changed.push(b);
      onCover?.(b);
    }
  }
  return changed;
}

/**
 * The fast tag reader is strict; ffmpeg is not. Any fresh audio file it
 * could not read gets one ffprobe pass here, eight at a time, so a book
 * with an odd header is still a book. Returns how many were rescued.
 */
async function rescueUnreadable(host: Host, root: string, files: ScannedFile[], signal?: AbortSignal): Promise<number> {
  const failed = files.filter((f) => f.kind === "audio" && f.fresh && f.durationMs <= 0);
  if (failed.length === 0) return 0;
  const results = await pipe(
    from(failed),
    flatMap(
      (f: ScannedFile) =>
        (async function* () {
          try {
            const r = await probe(host, host.join(root, ...f.path.split("/")), signal);
            if (r.durationMs > 0) {
              f.durationMs = r.durationMs;
              f.tags = { ...r.tags, ...f.tags };
              f.hasCover = f.hasCover || r.hasCover;
              f.chapters = r.chapters;
              f.chaptersKnown = true;
              yield true;
              return;
            }
          } catch {
            /* still unreadable: the caller reports it */
          }
          yield false;
        })(),
      { concurrency: 8 },
    ),
    collect(),
  );
  return results.filter(Boolean).length;
}

function buildBook(group: BookGroup, byPath: Map<string, ScannedFile>, records: Records, errors: ScanResult["errors"]): ScannedBook | null {
  const files: AudioFile[] = [];
  const freshTags: Record<string, string>[] = [];
  let pending = 0;
  for (const entry of group.audio) {
    const s = byPath.get(entry.relPath);
    if (!s) continue;
    if (!s.fresh && !s.pending) {
      const cached = records.previous.get(entry.relPath);
      if (cached) {
        files.push({ ...cached, sizeBytes: entry.sizeBytes, mtimeMs: entry.mtimeMs });
        continue;
      }
    }
    if (s.pending) {
      pending++;
      files.push({ path: entry.relPath, order: 0, durationMs: 0, sizeBytes: entry.sizeBytes, mtimeMs: entry.mtimeMs, title: "", disc: 1, track: 0, hasCover: false, coverFile: "", chapters: [], chaptersProbed: false });
      continue;
    }
    if (s.durationMs <= 0 && Object.keys(s.tags).length === 0) {
      errors.push({ path: entry.relPath, message: "could not read this file" });
      continue;
    }
    const keys = orderKeys(s.tags);
    freshTags.push(s.tags);
    files.push({
      path: entry.relPath,
      order: 0,
      durationMs: s.durationMs,
      sizeBytes: entry.sizeBytes,
      mtimeMs: entry.mtimeMs,
      title: s.tags.title ?? "",
      disc: keys.disc,
      track: keys.track,
      hasCover: s.hasCover,
      coverFile: s.cover,
      chapters: s.chapters,
      chaptersProbed: s.chaptersKnown,
    });
  }
  if (files.length === 0) return null;
  orderFiles(files);

  const isLooseRootFile = group.audio.length === 1 && group.covers.length === 0 && !group.path.includes("/");
  const parentName = group.path.includes("/") ? group.path.slice(0, group.path.lastIndexOf("/")).split("/").pop() ?? "" : "";
  const meta =
    freshTags.length > 0
      ? resolveMetadata(
          freshTags.map((tags) => ({ durationMs: 0, tags, hasCover: false, chapters: [], codec: "", sampleRate: 0, channels: 0 })),
          isLooseRootFile ? "" : group.name,
          group.name,
          isLooseRootFile ? "" : parentName,
        )
      : cachedMetadata(records.previousBooks.get(group.path), group.name, isLooseRootFile ? "" : parentName);

  const sizeBytes = files.reduce((s, f) => s + f.sizeBytes, 0);
  const durationMs = files.reduce((s, f) => s + f.durationMs, 0);
  const id = bookId(group.path, sizeBytes);
  const cover = group.covers[0]?.relPath ?? files.find((f) => f.coverFile)?.coverFile ?? (files.find((f) => f.hasCover) ? `${RIBBON_DIR}/covers/${id}.jpg` : "");

  let chapters = buildChapters(files);
  const corrections = records.corrections.get(id) ?? [];
  if (corrections.length > 0) chapters = applyCorrections(chapters, corrections, durationMs).chapters;

  const book: Book = {
    id,
    path: group.path,
    title: meta.title,
    rawTitle: meta.rawTitle,
    author: meta.author,
    narrator: meta.narrator,
    series: meta.series,
    seriesIndex: meta.seriesIndex,
    year: meta.year,
    cover,
    durationMs,
    sizeBytes,
    fileCount: files.length,
  };
  return pending > 0 ? { book, files, chapters, pending } : { book, files, chapters };
}

/** Disc, then track, then natural filename. Untracked files sort last only when some files are tracked. */
export function orderFiles(files: AudioFile[]): void {
  const anyTrack = files.some((f) => f.track > 0);
  files.sort((a, b) => {
    if (a.disc !== b.disc) return a.disc - b.disc;
    if (anyTrack && a.track !== b.track) {
      if (a.track === 0) return 1;
      if (b.track === 0) return -1;
      return a.track - b.track;
    }
    return natcompare(a.path, b.path);
  });
  files.forEach((f, i) => (f.order = i));
}

/**
 * Read embedded chapter markers with ffprobe for any file of the book
 * that has not been probed yet, then rebuild and persist the chapters.
 * Returns the book unchanged when nothing was pending.
 */
export async function ensureChapters(host: Host, root: string, book: ScannedBook, signal?: AbortSignal): Promise<ScannedBook> {
  const pending = book.files.filter((f) => !f.chaptersProbed);
  if (pending.length === 0) return book;
  const files = book.files.map((f) => ({ ...f }));
  let changed = false;
  for (const f of files) {
    if (f.chaptersProbed) continue;
    if (signal?.aborted) return book;
    try {
      const r = await probe(host, host.join(root, ...f.path.split("/")), signal);
      f.chapters = r.chapters;
      if (r.durationMs > 0 && Math.abs(r.durationMs - f.durationMs) > 2000) f.durationMs = r.durationMs;
      // ffprobe sees pictures the tag reader can miss (second ID3 tags, odd containers).
      if (r.hasCover) f.hasCover = true;
      f.chaptersProbed = true;
      changed = true;
    } catch {
      // Leave it unprobed; the inferred chapter stands.
    }
  }
  if (!changed) return book;
  const durationMs = files.reduce((s, f) => s + f.durationMs, 0);
  let chapters = buildChapters(files);
  const corrections = await readCorrections(host, root, book.book.id);
  if (corrections.length > 0) chapters = applyCorrections(chapters, corrections, durationMs).chapters;
  let cover = book.book.cover;
  if (!cover && files.some((f) => f.hasCover)) {
    const candidate = `${RIBBON_DIR}/covers/${book.book.id}.jpg`;
    const done = await extractMissingCovers(host, root, [{ book: { ...book.book, cover: candidate }, files, chapters }], undefined, signal);
    if (done.length > 0) cover = candidate;
  }
  const updated: ScannedBook = { book: { ...book.book, durationMs, cover }, files, chapters };
  await updateFileRows(host, root, updated);
  await host.mkdir(host.join(root, RIBBON_DIR, "chapters"));
  await host.writeFile(host.join(root, RIBBON_DIR, "chapters", `${book.book.id}.csv`), await chaptersToBytes(chapters));
  return updated;
}

/** The file's bytes, or null when it cannot be read. One round trip, not two. */
async function readIfExists(host: Host, path: string): Promise<Uint8Array | null> {
  try {
    return await host.readFile(path);
  } catch {
    return null;
  }
}

/** Every record the scan needs, read concurrently and once. */
async function readRecords(host: Host, root: string, incremental: boolean): Promise<Records> {
  const dir = host.join(root, RIBBON_DIR);
  const encoder = new TextEncoder();
  const [filesCsv, libraryCsv, correctionFiles] = await Promise.all([
    incremental ? readIfExists(host, host.join(dir, "files.csv")) : Promise.resolve(null),
    readIfExists(host, host.join(dir, "library.csv")),
    host.readTextDir(host.join(dir, "corrections")),
  ]);
  const previous = new Map<string, AudioFile>();
  if (filesCsv) {
    try {
      for (const list of (await bytesToFiles(filesCsv)).values()) for (const f of list) previous.set(f.path, f);
    } catch {
      /* a bad cache is just a full rescan */
    }
  }
  const previousBooks = new Map<string, Book>();
  if (libraryCsv) {
    try {
      for (const b of await bytesToBooks(libraryCsv)) previousBooks.set(b.path, b);
    } catch {
      /* ignore */
    }
  }
  const corrections = new Map<string, Correction[]>();
  for (const f of correctionFiles) {
    if (!f.name.endsWith(".csv")) continue;
    try {
      const list = rowsToCorrections((await bytesToRows(encoder.encode(f.text))).rows);
      if (list.length > 0) corrections.set(f.name.slice(0, -4), list);
    } catch {
      /* ignore */
    }
  }
  return { previous, previousBooks, corrections, filesCsv, libraryCsv };
}

/**
 * Metadata for a book whose files are all unchanged, or not yet read. The
 * folder-name rule is re-applied here so a curated numbered folder wins
 * even when the record was written before that rule existed.
 */
function cachedMetadata(b: Book | undefined, folderName: string, parentFolderName = "") {
  const numbered = parseNumbered(folderName);
  const parent = parentFolderName ? (parseNumbered(parentFolderName)?.name ?? parentFolderName) : "";
  const verbatim = folderName.trim();
  if (!b) {
    return { title: verbatim, rawTitle: verbatim, author: "", narrator: "", series: numbered ? parent : "", seriesIndex: numbered ? numbered.index : null, year: null };
  }
  if (!numbered) return { title: b.title, rawTitle: b.rawTitle, author: b.author, narrator: b.narrator, series: b.series, seriesIndex: b.seriesIndex, year: b.year };
  return { title: verbatim, rawTitle: verbatim, author: b.author, narrator: b.narrator, series: b.series || parent, seriesIndex: numbered.index, year: b.year };
}

async function readCorrections(host: Host, root: string, id: string) {
  const bytes = await readIfExists(host, host.join(root, RIBBON_DIR, "corrections", `${id}.csv`));
  if (!bytes) return [];
  try {
    return rowsToCorrections((await bytesToRows(bytes)).rows);
  } catch {
    return [];
  }
}

function sameBytes(a: Uint8Array | null, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Write library.csv and files.csv, but only the ones that changed. */
async function writeRecords(host: Host, root: string, books: readonly ScannedBook[], records: Records): Promise<void> {
  const dir = host.join(root, RIBBON_DIR);
  const library = await booksToBytes(books.map((b) => b.book));
  const fileRows: Row[] = [];
  for (const b of books) fileRows.push(...filesToRows(b.book.id, b.files));
  const files = await filesToBytes(fileRows);
  const writeLibrary = !sameBytes(records.libraryCsv, library);
  const writeFiles = !sameBytes(records.filesCsv, files);
  if (!writeLibrary && !writeFiles) {
    await mirrorRecords(host, root, library, files);
    return;
  }
  if (host.writeTextFiles) {
    const decoder = new TextDecoder();
    const batch: { path: string; text: string }[] = [];
    if (writeLibrary) batch.push({ path: host.join(dir, "library.csv"), text: decoder.decode(library) });
    if (writeFiles) batch.push({ path: host.join(dir, "files.csv"), text: decoder.decode(files) });
    await host.writeTextFiles(batch);
  } else {
    await host.mkdir(dir);
    if (writeLibrary) await host.writeFile(host.join(dir, "library.csv"), library);
    if (writeFiles) await host.writeFile(host.join(dir, "files.csv"), files);
  }
  await mirrorRecords(host, root, library, files);
}

/** Keep the local mirror current. Best effort: a failure changes nothing. */
async function mirrorRecords(host: Host, root: string, library: Uint8Array, files: Uint8Array): Promise<void> {
  if (!host.recordsMirror) return;
  try {
    const decoder = new TextDecoder();
    await host.recordsMirror.write(root, { library: decoder.decode(library), files: decoder.decode(files) });
  } catch {
    /* the mirror is a convenience */
  }
}

/** Rewrite files.csv and library.csv with one book's rows replaced. */
async function updateFileRows(host: Host, root: string, book: ScannedBook): Promise<void> {
  const path = host.join(root, RIBBON_DIR, "files.csv");
  const existing = await readIfExists(host, path);
  const byBook = existing ? await bytesToFiles(existing) : new Map<string, AudioFile[]>();
  byBook.set(book.book.id, book.files);
  const rows: Row[] = [];
  for (const [id, files] of byBook) rows.push(...filesToRows(id, files));
  await host.writeFile(path, await filesToBytes(rows));
  const libPath = host.join(root, RIBBON_DIR, "library.csv");
  const lib = await readIfExists(host, libPath);
  if (lib) {
    const books = await bytesToBooks(lib);
    const i = books.findIndex((b) => b.id === book.book.id);
    if (i >= 0) {
      books[i] = book.book;
      await host.writeFile(libPath, await booksToBytes(books));
    }
  }
}

/**
 * Load the last scan without touching the audio files. The local mirror
 * is tried first, because it answers in a millisecond where a network
 * volume takes hundreds; otherwise library.csv, files.csv and the
 * chapters folder come from beside the books, all read at once. No
 * per-book I/O either way.
 */
export async function loadLibrary(host: Host, root: string): Promise<ScannedBook[] | null> {
  const mirror = await host.recordsMirror?.read(root).catch(() => null);
  if (mirror) {
    const encoder = new TextEncoder();
    return assemble(await bytesToBooks(encoder.encode(mirror.library)), await bytesToFiles(encoder.encode(mirror.files)), new Map());
  }
  const dir = host.join(root, RIBBON_DIR);
  const [lib, filesCsv, chapterFiles] = await Promise.all([
    readIfExists(host, host.join(dir, "library.csv")),
    readIfExists(host, host.join(dir, "files.csv")),
    host.readTextDir(host.join(dir, "chapters")),
  ]);
  if (!lib) return null;
  const books = await bytesToBooks(lib);
  const files = filesCsv ? await bytesToFiles(filesCsv) : new Map<string, AudioFile[]>();
  return assemble(books, files, new Map(chapterFiles.map((t) => [t.name, t.text])));
}

async function assemble(books: Book[], files: Map<string, AudioFile[]>, chaptersByName: Map<string, string>): Promise<ScannedBook[]> {
  const encoder = new TextEncoder();
  const out: ScannedBook[] = [];
  for (const book of books) {
    const bookFiles = files.get(book.id) ?? [];
    const text = chaptersByName.get(`${book.id}.csv`);
    let chapters: Chapter[] = text ? await bytesToChapters(encoder.encode(text)) : [];
    if (chapters.length === 0) chapters = buildChapters(bookFiles);
    out.push({ book, files: bookFiles, chapters });
  }
  return out;
}
