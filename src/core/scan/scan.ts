import { pipe, collect, flatMap, from } from "@culvert/stream";
import type { Host, ScannedFile, ScanProgress } from "../../host/host";
import type { AudioFile, Book, Chapter } from "../types";
import { bookId } from "../bookid";
import { natcompare } from "../natsort";
import { ODIO_DIR } from "./walk";
import { groupBooks, type BookGroup } from "./group";
import { probe } from "./probe";
import { orderKeys, parseNumbered, resolveMetadata } from "./metadata";
import { buildChapters, applyCorrections, rowsToCorrections } from "./chapters";
import { booksToBytes, bytesToBooks, bytesToChapters, bytesToFiles, chaptersToBytes, filesToBytes, filesToRows } from "./records";
import { bytesToRows, type Row } from "../csv";
import { coverArgs } from "./cover";

export interface ScannedBook {
  book: Book;
  files: AudioFile[];
  chapters: Chapter[];
}

export interface ScanOptions {
  signal?: AbortSignal;
  /** Live progress from the host scanner. */
  onProgress?: (p: ScanProgress) => void;
  /** Skip files whose size and mtime match `.odio/files.csv`. Default true. */
  incremental?: boolean;
  /** Write `.odio/*` records. Default true. */
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
}

/**
 * Scan a library folder. The host walks and reads tags in one call;
 * everything after that is a pure function of the file list. Chapter
 * markers are not read here: they are probed lazily by `ensureChapters`
 * the first time a book is opened, and cached in files.csv.
 */
export async function scanLibrary(host: Host, root: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const started = Date.now();
  const incremental = opts.incremental ?? true;
  const errors: ScanResult["errors"] = [];

  const previous = incremental ? await readPreviousFiles(host, root) : new Map<string, AudioFile>();
  const known = [...previous.values()].map((f) => ({ path: f.path, sizeBytes: f.sizeBytes, mtimeMs: f.mtimeMs }));
  const out = await host.scan(root, known, opts.onProgress);
  const stage = (text: string) => opts.onProgress?.({ walked: out.walked, done: out.walked, stage: text });
  const unreadable = out.files.filter((f) => f.kind === "audio" && f.fresh && f.durationMs <= 0).length;
  if (unreadable > 0) stage(`Checking ${unreadable.toLocaleString()} ${unreadable === 1 ? "file" : "files"} the tag reader could not read…`);
  const rescued = await rescueUnreadable(host, root, out.files, opts.signal);
  stage("Organizing books…");

  const groups = groupBooks(
    out.files.map((f) => ({ relPath: f.path, absPath: host.join(root, ...f.path.split("/")), name: f.name, sizeBytes: f.sizeBytes, mtimeMs: f.mtimeMs })),
  );
  const byPath = new Map(out.files.map((f) => [f.path, f]));
  const previousBooks = await readPreviousBooks(host, root);

  const scanned: ScannedBook[] = [];
  for (const group of groups) {
    const b = await buildBook(host, root, group, byPath, previous, previousBooks, errors);
    if (b) scanned.push(b);
  }

  if (opts.write ?? true) {
    stage("Saving the library…");
    await writeRecords(host, root, scanned);
  }
  return { books: scanned, errors, probed: out.probed, reused: out.reused, rescued, elapsedMs: Date.now() - started };
}

/**
 * Covers that still need ffmpeg: books with a picture in a file but no
 * cover image yet. Runs after the library is on screen, one book at a
 * time, and reports each book as its cover lands. Returns the books that
 * changed.
 */
export async function extractMissingCovers(
  host: Host,
  root: string,
  books: readonly ScannedBook[],
  onCover?: (book: ScannedBook) => void,
  signal?: AbortSignal,
): Promise<ScannedBook[]> {
  const prefix = `${ODIO_DIR}/covers/`;
  const changed: ScannedBook[] = [];
  for (const b of books) {
    if (signal?.aborted) break;
    if (!b.book.cover.startsWith(prefix)) continue;
    const abs = host.join(root, ...b.book.cover.split("/"));
    if (await host.exists(abs)) continue;
    const src = b.files.find((f) => f.hasCover);
    if (!src) continue;
    await host.mkdir(host.join(root, ODIO_DIR, "covers"));
    const r = await host.run("ffmpeg", coverArgs(host.join(root, ...src.path.split("/")), abs), signal);
    if (r.code === 0) {
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

async function buildBook(
  host: Host,
  root: string,
  group: BookGroup,
  byPath: Map<string, ScannedFile>,
  previous: Map<string, AudioFile>,
  previousBooks: Map<string, Book>,
  errors: ScanResult["errors"],
): Promise<ScannedBook | null> {
  const files: AudioFile[] = [];
  const freshTags: Record<string, string>[] = [];
  for (const entry of group.audio) {
    const s = byPath.get(entry.relPath);
    if (!s) continue;
    if (!s.fresh) {
      const cached = previous.get(entry.relPath);
      if (cached) {
        files.push({ ...cached, sizeBytes: entry.sizeBytes, mtimeMs: entry.mtimeMs });
        continue;
      }
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
      : cachedMetadata(previousBooks.get(group.path), group.name, isLooseRootFile ? "" : parentName);

  const sizeBytes = files.reduce((s, f) => s + f.sizeBytes, 0);
  const durationMs = files.reduce((s, f) => s + f.durationMs, 0);
  const id = bookId(group.path, sizeBytes);
  const cover = group.covers[0]?.relPath ?? files.find((f) => f.coverFile)?.coverFile ?? (files.find((f) => f.hasCover) ? `${ODIO_DIR}/covers/${id}.jpg` : "");

  let chapters = buildChapters(files);
  const corrections = await readCorrections(host, root, id);
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
  return { book, files, chapters };
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
    const candidate = `${ODIO_DIR}/covers/${book.book.id}.jpg`;
    const done = await extractMissingCovers(host, root, [{ book: { ...book.book, cover: candidate }, files, chapters }], undefined, signal);
    if (done.length > 0) cover = candidate;
  }
  const updated: ScannedBook = { book: { ...book.book, durationMs, cover }, files, chapters };
  await updateFileRows(host, root, updated);
  await host.mkdir(host.join(root, ODIO_DIR, "chapters"));
  await host.writeFile(host.join(root, ODIO_DIR, "chapters", `${book.book.id}.csv`), await chaptersToBytes(chapters));
  return updated;
}

async function readPreviousFiles(host: Host, root: string): Promise<Map<string, AudioFile>> {
  const out = new Map<string, AudioFile>();
  const path = host.join(root, ODIO_DIR, "files.csv");
  if (!(await host.exists(path))) return out;
  try {
    const byBook = await bytesToFiles(await host.readFile(path));
    for (const list of byBook.values()) for (const f of list) out.set(f.path, f);
  } catch {
    /* a bad cache is just a full rescan */
  }
  return out;
}

async function readPreviousBooks(host: Host, root: string): Promise<Map<string, Book>> {
  const out = new Map<string, Book>();
  const path = host.join(root, ODIO_DIR, "library.csv");
  if (!(await host.exists(path))) return out;
  try {
    for (const b of await bytesToBooks(await host.readFile(path))) out.set(b.path, b);
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * Metadata for a book whose files are all unchanged. The folder-name
 * rule is re-applied here so a curated numbered folder wins even when
 * the record was written before that rule existed.
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
  const path = host.join(root, ODIO_DIR, "corrections", `${id}.csv`);
  if (!(await host.exists(path))) return [];
  try {
    const { rows } = await bytesToRows(await host.readFile(path));
    return rowsToCorrections(rows);
  } catch {
    return [];
  }
}

async function writeRecords(host: Host, root: string, books: readonly ScannedBook[]): Promise<void> {
  const dir = host.join(root, ODIO_DIR);
  await host.mkdir(dir);
  await host.writeFile(host.join(dir, "library.csv"), await booksToBytes(books.map((b) => b.book)));
  const fileRows: Row[] = [];
  for (const b of books) fileRows.push(...filesToRows(b.book.id, b.files));
  await host.writeFile(host.join(dir, "files.csv"), await filesToBytes(fileRows));
}

/** Rewrite files.csv and library.csv with one book's rows replaced. */
async function updateFileRows(host: Host, root: string, book: ScannedBook): Promise<void> {
  const path = host.join(root, ODIO_DIR, "files.csv");
  const byBook = (await host.exists(path)) ? await bytesToFiles(await host.readFile(path)) : new Map<string, AudioFile[]>();
  byBook.set(book.book.id, book.files);
  const rows: Row[] = [];
  for (const [id, files] of byBook) rows.push(...filesToRows(id, files));
  await host.writeFile(path, await filesToBytes(rows));
  const libPath = host.join(root, ODIO_DIR, "library.csv");
  if (await host.exists(libPath)) {
    const books = await bytesToBooks(await host.readFile(libPath));
    const i = books.findIndex((b) => b.id === book.book.id);
    if (i >= 0) {
      books[i] = book.book;
      await host.writeFile(libPath, await booksToBytes(books));
    }
  }
}

/**
 * Load the last scan without touching the audio files: library.csv,
 * files.csv, and the chapters folder in one call each. No per-book I/O.
 */
export async function loadLibrary(host: Host, root: string): Promise<ScannedBook[] | null> {
  const dir = host.join(root, ODIO_DIR);
  const libPath = host.join(dir, "library.csv");
  if (!(await host.exists(libPath))) return null;
  const books = await bytesToBooks(await host.readFile(libPath));
  const filesPath = host.join(dir, "files.csv");
  const files = (await host.exists(filesPath)) ? await bytesToFiles(await host.readFile(filesPath)) : new Map<string, AudioFile[]>();
  const chapterFiles = new Map((await host.readTextDir(host.join(dir, "chapters"))).map((t) => [t.name, t.text]));
  const encoder = new TextEncoder();
  const out: ScannedBook[] = [];
  for (const book of books) {
    const bookFiles = files.get(book.id) ?? [];
    const text = chapterFiles.get(`${book.id}.csv`);
    let chapters: Chapter[] = text ? await bytesToChapters(encoder.encode(text)) : [];
    if (chapters.length === 0) chapters = buildChapters(bookFiles);
    out.push({ book, files: bookFiles, chapters });
  }
  return out;
}
