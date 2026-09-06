import { pipe, collect, flatMap, from } from "@culvert/stream";
import type { Host } from "../../host/host";
import type { AudioFile, Book, Chapter } from "../types";
import { bookId } from "../bookid";
import { natcompare } from "../natsort";
import { walk, type FileEntry, ODIO_DIR } from "./walk";
import { groupBooks, type BookGroup } from "./group";
import { probe, type ProbeResult } from "./probe";
import { orderKeys, resolveMetadata } from "./metadata";
import { buildChapters, applyCorrections, rowsToCorrections } from "./chapters";
import { booksToBytes, bytesToBooks, bytesToFiles, chaptersToBytes, filesToBytes, filesToRows, isStale } from "./records";
import { bytesToRows, type Row } from "../csv";

export interface ScannedBook {
  book: Book;
  files: AudioFile[];
  chapters: Chapter[];
}

export interface ScanOptions {
  /** Parallel ffprobe processes. Default 4. */
  concurrency?: number;
  signal?: AbortSignal;
  /** Called as each book finishes probing. */
  onBook?: (book: ScannedBook, index: number, total: number) => void;
  /** Called for each file that could not be probed. Scan continues. */
  onError?: (relPath: string, error: unknown) => void;
  /** Skip probing files whose size and mtime match `.odio/files.csv`. Default true. */
  incremental?: boolean;
  /** Write `.odio/*` records. Default true. */
  write?: boolean;
}

export interface ScanResult {
  books: ScannedBook[];
  errors: { path: string; message: string }[];
  probed: number;
  reused: number;
}

/**
 * Scan a library folder. Walk, group, probe (with concurrency), resolve,
 * write records. Everything but ffprobe is a pure function of the file
 * list, and ffprobe results are cached in files.csv keyed on size+mtime.
 */
export async function scanLibrary(host: Host, root: string, opts: ScanOptions = {}): Promise<ScanResult> {
  const concurrency = opts.concurrency ?? 4;
  const incremental = opts.incremental ?? true;
  const errors: ScanResult["errors"] = [];
  let probed = 0;
  let reused = 0;

  const entries = await pipe(walk(host, root), collect());
  const groups = groupBooks(entries);
  const previous = incremental ? await readPreviousFiles(host, root) : new Map<string, AudioFile>();
  const total = groups.length;

  const scanned = await pipe(
    from(groups),
    flatMap(
      (group: BookGroup) =>
        (async function* () {
          const result = await scanGroup(host, root, group, previous, {
            ...(opts.signal ? { signal: opts.signal } : {}),
            onProbe: () => probed++,
            onReuse: () => reused++,
            onError: (path, err) => {
              errors.push({ path, message: err instanceof Error ? err.message : String(err) });
              opts.onError?.(path, err);
            },
          });
          if (result) yield result;
        })(),
      { concurrency },
    ),
    collect(),
  );

  // Preserve walk order regardless of which book finished probing first.
  const order = new Map(groups.map((g, i) => [g.path, i]));
  scanned.sort((a, b) => (order.get(a.book.path) ?? 0) - (order.get(b.book.path) ?? 0));
  scanned.forEach((b, i) => opts.onBook?.(b, i, total));

  if (opts.write ?? true) await writeRecords(host, root, scanned);
  return { books: scanned, errors, probed, reused };
}

interface GroupCallbacks {
  signal?: AbortSignal;
  onProbe: () => void;
  onReuse: () => void;
  onError: (relPath: string, err: unknown) => void;
}

async function scanGroup(host: Host, root: string, group: BookGroup, previous: Map<string, AudioFile>, cb: GroupCallbacks): Promise<ScannedBook | null> {
  const probes: { entry: FileEntry; result: ProbeResult | null; cached: AudioFile | null }[] = [];
  for (const entry of group.audio) {
    const cached = previous.get(entry.relPath);
    if (cached && !isStale(cached, entry)) {
      cb.onReuse();
      probes.push({ entry, result: null, cached });
      continue;
    }
    try {
      const result = await probe(host, entry.absPath, cb.signal);
      cb.onProbe();
      probes.push({ entry, result, cached: null });
    } catch (err) {
      cb.onError(entry.relPath, err);
    }
  }
  if (probes.length === 0) return null;

  const files: AudioFile[] = probes.map(({ entry, result, cached }) => {
    if (cached) return { ...cached, path: entry.relPath };
    const r = result!;
    const keys = orderKeys(r.tags);
    return {
      path: entry.relPath,
      order: 0,
      durationMs: r.durationMs,
      sizeBytes: entry.sizeBytes,
      mtimeMs: entry.mtimeMs,
      title: r.tags.title ?? "",
      disc: keys.disc,
      track: keys.track,
      hasCover: r.hasCover,
      chapters: r.chapters,
    };
  });

  orderFiles(files);

  const liveProbes = probes.filter((p) => p.result).map((p) => p.result!);
  const meta =
    liveProbes.length > 0
      ? resolveMetadata(liveProbes, group.audio.length === 1 && group.covers.length === 0 && !group.path.includes("/") ? "" : group.name, group.name)
      : await cachedMetadata(host, root, group);

  const sizeBytes = files.reduce((s, f) => s + f.sizeBytes, 0);
  const durationMs = files.reduce((s, f) => s + f.durationMs, 0);
  const id = bookId(group.path, sizeBytes);

  const cover = group.covers[0]?.relPath ?? (files.find((f) => f.hasCover) ? `${ODIO_DIR}/covers/${id}.jpg` : "");

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

/** Disc, then track, then natural filename. Files with no track sort after tagged ones only if all lack tags. */
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

async function cachedMetadata(host: Host, root: string, group: BookGroup) {
  const path = host.join(root, ODIO_DIR, "library.csv");
  const fallback = { title: group.name, rawTitle: group.name, author: "", narrator: "", series: "", seriesIndex: null, year: null };
  if (!(await host.exists(path))) return fallback;
  try {
    const books = await bytesToBooks(await host.readFile(path));
    const b = books.find((x) => x.path === group.path);
    return b ? { title: b.title, rawTitle: b.rawTitle, author: b.author, narrator: b.narrator, series: b.series, seriesIndex: b.seriesIndex, year: b.year } : fallback;
  } catch {
    return fallback;
  }
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
  await host.mkdir(host.join(dir, "chapters"));
  await host.writeFile(host.join(dir, "library.csv"), await booksToBytes(books.map((b) => b.book)));
  const fileRows: Row[] = [];
  for (const b of books) fileRows.push(...filesToRows(b.book.id, b.files));
  await host.writeFile(host.join(dir, "files.csv"), await filesToBytes(fileRows));
  for (const b of books) {
    await host.writeFile(host.join(dir, "chapters", `${b.book.id}.csv`), await chaptersToBytes(b.chapters));
  }
}

/** Load the last scan without touching ffprobe. */
export async function loadLibrary(host: Host, root: string): Promise<ScannedBook[] | null> {
  const dir = host.join(root, ODIO_DIR);
  const libPath = host.join(dir, "library.csv");
  if (!(await host.exists(libPath))) return null;
  const books = await bytesToBooks(await host.readFile(libPath));
  const filesPath = host.join(dir, "files.csv");
  const files = (await host.exists(filesPath)) ? await bytesToFiles(await host.readFile(filesPath)) : new Map<string, AudioFile[]>();
  const out: ScannedBook[] = [];
  for (const book of books) {
    const bookFiles = files.get(book.id) ?? [];
    const chPath = host.join(dir, "chapters", `${book.id}.csv`);
    let chapters: Chapter[] = [];
    if (await host.exists(chPath)) {
      const { bytesToChapters } = await import("./records");
      chapters = await bytesToChapters(await host.readFile(chPath));
    }
    if (chapters.length === 0) chapters = buildChapters(bookFiles);
    out.push({ book, files: bookFiles, chapters });
  }
  return out;
}
