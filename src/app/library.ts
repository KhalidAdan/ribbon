import type { Host } from "../host/host";
import type { Bookmark, BookSettings, Position, SilenceRange, LoudnessMeasurement } from "../core/types";
import { RIBBON_DIR, LEGACY_DIR } from "../core/scan/walk";
import { scanLibrary, loadLibrary, ensureChapters, type ScannedBook, type ScanOptions, type ScanResult } from "../core/scan/scan";
import { mergePositions, nowIso, parsePositions, serializePosition } from "../core/position";
import { defaultSettings, parseSettings, serializeSettings } from "../core/settings";
import { clipArgs, clipName, clipRange, parseBookmarks, serializeBookmarks } from "../core/bookmarks";
import { applyCorrections, buildChapters, correctionsToRows, rowsToCorrections, CORRECTION_HEADERS, type Correction } from "../core/scan/chapters";
import { bytesToRows, rowsToBytes, num, int } from "../core/csv";
import { LOUDNESS_HEADERS, gainDb } from "../core/loudness";
import { locate } from "../core/timeline";

/**
 * Everything the UI needs from a library folder, over a Host. Each
 * durable fact is one small CSV in `.ribbon/`. No caching beyond the
 * device name: the files are the state.
 */
export class LibraryService {
  private device: string | null = null;

  constructor(
    readonly host: Host,
    readonly root: string,
  ) {}

  /** Absolute path for a library-relative path. */
  absPath(relPath: string): string {
    return this.host.join(this.root, ...relPath.split("/"));
  }

  private dir(...parts: string[]): string {
    return this.host.join(this.root, RIBBON_DIR, ...parts);
  }

  /**
   * Libraries recorded under the old folder name keep their positions,
   * bookmarks, and corrections: the folder is renamed once, in place.
   */
  async migrateLegacyRecords(): Promise<boolean> {
    const legacy = this.host.join(this.root, LEGACY_DIR);
    const current = this.host.join(this.root, RIBBON_DIR);
    if (!(await this.host.exists(legacy)) || (await this.host.exists(current))) return false;
    await this.host.rename(legacy, current);
    return true;
  }

  /** The last scan if there is one, else a fresh scan. */
  async open(opts: ScanOptions = {}): Promise<ScannedBook[]> {
    const cached = await this.loadCached();
    if (cached && cached.length > 0) return cached;
    return (await scanLibrary(this.host, this.root, opts)).books;
  }

  /** The last scan's records, without touching any audio file. Null when never scanned. */
  loadCached(): Promise<ScannedBook[] | null> {
    return loadLibrary(this.host, this.root);
  }

  async rescan(opts: ScanOptions = {}): Promise<ScannedBook[]> {
    return (await scanLibrary(this.host, this.root, opts)).books;
  }

  /** A scan with its error list and timings. */
  rescanDetailed(opts: ScanOptions = {}): Promise<ScanResult> {
    return scanLibrary(this.host, this.root, opts);
  }

  /** Probe embedded chapter markers once per book, on first open. */
  ensureChapters(book: ScannedBook, signal?: AbortSignal): Promise<ScannedBook> {
    return ensureChapters(this.host, this.root, book, signal);
  }

  async deviceName(): Promise<string> {
    if (this.device === null) this.device = (await this.host.deviceName()) || "unknown";
    return this.device;
  }

  // Positions ----------------------------------------------------------

  /**
   * Merge every position file for the book, including sync-conflict
   * copies (`<id> (conflict).csv` and the like), last write wins.
   */
  async readPosition(bookId: string): Promise<Position | null> {
    const dir = this.dir("positions");
    if (!(await this.host.exists(dir))) return null;
    const entries = await this.host.readDir(dir);
    const candidates: Position[] = [];
    for (const e of entries) {
      if (!e.isFile || !e.name.startsWith(bookId) || !e.name.endsWith(".csv")) continue;
      try {
        const { positions } = await parsePositions(await this.host.readFile(this.host.join(dir, e.name)));
        candidates.push(...positions);
      } catch {
        /* unreadable copy: ignore */
      }
    }
    return mergePositions(candidates, bookId);
  }

  /** Every book's merged position in one directory read. */
  async readAllPositions(): Promise<Map<string, Position>> {
    const out = new Map<string, Position>();
    const files = await this.host.readTextDir(this.dir("positions"));
    const encoder = new TextEncoder();
    const byBook = new Map<string, Position[]>();
    for (const f of files) {
      if (!f.name.endsWith(".csv")) continue;
      try {
        const { positions } = await parsePositions(encoder.encode(f.text));
        for (const p of positions) {
          const list = byBook.get(p.bookId) ?? [];
          list.push(p);
          byBook.set(p.bookId, list);
        }
      } catch {
        /* unreadable copy: ignore */
      }
    }
    for (const [id, list] of byBook) {
      const best = mergePositions(list, id);
      if (best) out.set(id, best);
    }
    return out;
  }

  async writePosition(bookId: string, offsetMs: number, nowMs = Date.now()): Promise<Position> {
    const p: Position = { bookId, offsetMs: Math.max(0, Math.round(offsetMs)), updatedAt: nowIso(nowMs), device: await this.deviceName() };
    await this.host.mkdir(this.dir("positions"));
    await this.host.writeFile(this.dir("positions", `${bookId}.csv`), await serializePosition(p));
    return p;
  }

  // Settings -----------------------------------------------------------

  async readSettings(bookId: string): Promise<BookSettings> {
    const path = this.dir("settings", `${bookId}.csv`);
    if (!(await this.host.exists(path))) return defaultSettings(bookId);
    try {
      return await parseSettings(await this.host.readFile(path), bookId);
    } catch {
      return defaultSettings(bookId);
    }
  }

  async writeSettings(settings: BookSettings): Promise<void> {
    await this.host.mkdir(this.dir("settings"));
    await this.host.writeFile(this.dir("settings", `${settings.bookId}.csv`), await serializeSettings(settings));
  }

  // Bookmarks ----------------------------------------------------------

  async readBookmarks(bookId: string): Promise<Bookmark[]> {
    const path = this.dir("bookmarks", `${bookId}.csv`);
    if (!(await this.host.exists(path))) return [];
    try {
      return (await parseBookmarks(await this.host.readFile(path))).bookmarks;
    } catch {
      return [];
    }
  }

  /**
   * Add a bookmark and cut the previous thirty seconds into a small
   * Opus clip beside it. The clip is best effort: a failed cut still
   * saves the bookmark.
   */
  async addBookmark(book: ScannedBook, offsetMs: number, note: string, nowMs = Date.now()): Promise<Bookmark> {
    const id = book.book.id;
    const list = await this.readBookmarks(id);
    const clip = clipName(id, offsetMs);
    const bookmark: Bookmark = { bookId: id, offsetMs: Math.max(0, Math.round(offsetMs)), createdAt: nowIso(nowMs), note, clip: "" };

    const durations = book.files.map((f) => f.durationMs);
    const loc = locate(durations, offsetMs);
    const file = book.files[loc.fileIndex];
    if (file) {
      const range = clipRange(loc.fileOffsetMs);
      await this.host.mkdir(this.dir("bookmarks", "clips"));
      const out = this.dir("bookmarks", "clips", clip);
      const r = await this.host.run("ffmpeg", clipArgs(this.absPath(file.path), range.startMs, range.endMs, out));
      if (r.code === 0) bookmark.clip = `clips/${clip}`;
    }

    list.push(bookmark);
    await this.writeBookmarks(id, list);
    return bookmark;
  }

  async removeBookmark(bookId: string, offsetMs: number): Promise<void> {
    const list = await this.readBookmarks(bookId);
    const gone = list.filter((b) => b.offsetMs === offsetMs);
    for (const b of gone) if (b.clip) await this.host.remove(this.dir("bookmarks", ...b.clip.split("/"))).catch(() => undefined);
    await this.writeBookmarks(
      bookId,
      list.filter((b) => b.offsetMs !== offsetMs),
    );
  }

  private async writeBookmarks(bookId: string, list: Bookmark[]): Promise<void> {
    await this.host.mkdir(this.dir("bookmarks"));
    await this.host.writeFile(this.dir("bookmarks", `${bookId}.csv`), await serializeBookmarks(list));
  }

  // Chapter corrections ------------------------------------------------

  async readCorrections(bookId: string): Promise<Correction[]> {
    const path = this.dir("corrections", `${bookId}.csv`);
    if (!(await this.host.exists(path))) return [];
    try {
      return rowsToCorrections((await bytesToRows(await this.host.readFile(path))).rows);
    } catch {
      return [];
    }
  }

  /** Persist corrections and return the re-derived effective chapters. */
  async writeCorrections(book: ScannedBook, corrections: Correction[]): Promise<ScannedBook> {
    await this.host.mkdir(this.dir("corrections"));
    await this.host.writeFile(this.dir("corrections", `${book.book.id}.csv`), await rowsToBytes(correctionsToRows(corrections), CORRECTION_HEADERS));
    const base = buildChapters(book.files);
    const chapters = applyCorrections(base, corrections, book.book.durationMs).chapters;
    const { chaptersToBytes } = await import("../core/scan/records");
    await this.host.mkdir(this.dir("chapters"));
    await this.host.writeFile(this.dir("chapters", `${book.book.id}.csv`), await chaptersToBytes(chapters));
    return { ...book, chapters };
  }

  // Loudness -----------------------------------------------------------

  async readLoudness(bookId: string): Promise<{ measurement: LoudnessMeasurement; gainDb: number } | null> {
    const path = this.dir("loudness", `${bookId}.csv`);
    if (!(await this.host.exists(path))) return null;
    try {
      const { rows } = await bytesToRows(await this.host.readFile(path));
      const r = rows[0];
      if (!r || r.integrated_lufs === undefined || r.integrated_lufs === "") return null;
      const measurement = { integratedLufs: num(r.integrated_lufs), truePeakDbtp: r.true_peak_dbtp ? num(r.true_peak_dbtp) : null };
      return { measurement, gainDb: r.gain_db ? num(r.gain_db) : gainDb(measurement) };
    } catch {
      return null;
    }
  }

  async writeLoudness(bookId: string, m: LoudnessMeasurement): Promise<number> {
    const gain = gainDb(m);
    await this.host.mkdir(this.dir("loudness"));
    await this.host.writeFile(
      this.dir("loudness", `${bookId}.csv`),
      await rowsToBytes(
        [{ book_id: bookId, integrated_lufs: String(m.integratedLufs), true_peak_dbtp: m.truePeakDbtp === null ? "" : String(m.truePeakDbtp), gain_db: String(gain) }],
        LOUDNESS_HEADERS,
      ),
    );
    return gain;
  }

  // Silence ------------------------------------------------------------

  async readSilence(bookId: string): Promise<Map<number, SilenceRange[]> | null> {
    const path = this.dir("silence", `${bookId}.csv`);
    if (!(await this.host.exists(path))) return null;
    try {
      const { rows } = await bytesToRows(await this.host.readFile(path));
      const out = new Map<number, SilenceRange[]>();
      for (const r of rows) {
        const i = int(r.file_index);
        const list = out.get(i) ?? [];
        list.push({ startMs: int(r.start_ms), endMs: int(r.end_ms) });
        out.set(i, list);
      }
      for (const list of out.values()) list.sort((a, b) => a.startMs - b.startMs);
      return out;
    } catch {
      return null;
    }
  }

  async writeSilence(bookId: string, byFile: Map<number, SilenceRange[]>): Promise<void> {
    const rows: Record<string, string>[] = [];
    for (const [i, list] of [...byFile.entries()].sort((a, b) => a[0] - b[0])) {
      for (const r of list) rows.push({ file_index: String(i), start_ms: String(r.startMs), end_ms: String(r.endMs) });
    }
    await this.host.mkdir(this.dir("silence"));
    await this.host.writeFile(this.dir("silence", `${bookId}.csv`), await rowsToBytes(rows, ["file_index", "start_ms", "end_ms"]));
  }
}
