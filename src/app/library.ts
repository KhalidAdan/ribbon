import type { Host } from "../host/host";
import type { Bookmark, BookSettings, Position, SilenceRange, LoudnessMeasurement } from "../core/types";
import { RIBBON_DIR, LEGACY_DIR } from "../core/scan/walk";
import { scanLibrary, loadLibrary, ensureChapters, type ScannedBook, type ScanOptions, type ScanResult } from "../core/scan/scan";
import { nowIso, parsePositions, serializePosition, serializePositions } from "../core/position";
import { claimsFor, compact, COMPACT_BYTES, deviceFileName, encodeRecord, FORMAT, fromLegacy, locatorFor, LOG_EXT, logName, mergePlaces, nextSeq, parseLog, ribbonClaim, toPosition, type DeviceInfo, type LogRecord } from "../core/poslog";
import { defaultSettings, parseSettings, serializeSettings } from "../core/settings";
import { clipArgs, clipName, clipRange, parseBookmarks, serializeBookmarks } from "../core/bookmarks";
import { applyCorrections, buildChapters, correctionsToRows, rowsToCorrections, CORRECTION_HEADERS, type Correction } from "../core/scan/chapters";
import { bytesToRows, rowsToBytes, num, int } from "../core/csv";
import { LOUDNESS_HEADERS, gainDb } from "../core/loudness";
import { bytesToProblems, problemsToBytes, type Problem } from "../core/problems";
import { bytesToSeries, seriesToBytes, type SeriesRecord } from "../core/series";
import { aboutToBytes, bytesToAbout, type BookAbout } from "../core/about";
import { locate } from "../core/timeline";
import { bytesToEdits, editsToBytes, type BookEdits } from "../core/edits";
import { bytesToNameRecords, nameRecordsToBytes, type NameRecord } from "./chapternames";

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
  //
  // The position log (docs/POSITION-FORMAT.md): this device appends to its
  // own file beside the books and reads everyone's. The per-book CSV of
  // earlier versions is still read, and still written, so Ribbon 0.4 on
  // another machine keeps up.

  private identity: DeviceInfo | null = null;
  private lastSeq = 0;
  private deviceFileWritten = false;
  /** Every log write, one at a time: appends and compaction never interleave. */
  private logQueue: Promise<unknown> = Promise.resolve();
  /** What a book looks like, for the claims and the locator on each record. Set by the app. */
  bookInfo: ((bookId: string) => ScannedBook | undefined) | null = null;

  /** Who this device is in the log: a random id made once per install, and a name people read. */
  setDevice(id: string, app = "ribbon"): void {
    this.deviceId = id.startsWith("urn:uuid:") ? id : `urn:uuid:${id}`;
    this.app = app;
    this.identity = null;
  }

  private deviceId: string | null = null;
  private app = "ribbon";

  private async me(): Promise<DeviceInfo> {
    if (!this.identity) this.identity = { id: this.deviceId ?? `urn:uuid:${crypto.randomUUID()}`, name: await this.deviceName(), app: this.app, format: FORMAT };
    return this.identity;
  }

  /**
   * Everything in the positions folder, merged: the place in every book,
   * every record (for history), and who the devices are. One directory
   * read. Rejects when the folder cannot be read, so a share that is away
   * is never mistaken for a library with no positions.
   */
  async readPositionLog(nowMs = Date.now()): Promise<{ places: Map<string, Position>; records: LogRecord[]; devices: Map<string, DeviceInfo> }> {
    const files = await this.host.readTextDir(this.dir("positions"));
    // An empty answer from a folder that is not there is a share that is away.
    if (files.length === 0 && !(await this.host.exists(this.root))) throw new Error(`${this.root} is not reachable`);
    const me = await this.me();
    const encoder = new TextEncoder();
    const records: LogRecord[] = [];
    const devices = new Map<string, DeviceInfo>();
    for (const f of files) {
      if (f.name.endsWith(LOG_EXT)) {
        const { records: rs } = parseLog(f.text);
        records.push(...rs);
        if (f.name === logName(me.id)) {
          for (const r of rs) if (r.dev === me.id && r.seq > this.lastSeq) this.lastSeq = r.seq;
          if (f.text.length > COMPACT_BYTES) void this.compactOwnLog();
        }
      } else if (f.name.endsWith(".json")) {
        try {
          const d = JSON.parse(f.text) as DeviceInfo;
          if (typeof d.id === "string") devices.set(d.id, d);
        } catch {
          /* not a device file */
        }
      } else if (f.name.endsWith(".csv")) {
        try {
          for (const p of (await parsePositions(encoder.encode(f.text))).positions) records.push(fromLegacy(p, f.name));
        } catch {
          /* unreadable copy: ignore */
        }
      }
    }
    const names = new Map([...devices].map(([id, d]) => [id, d.name || "another device"]));
    names.set(me.id, me.name);
    const places = new Map<string, Position>();
    for (const [id, r] of mergePlaces(records, nowMs)) places.set(id, toPosition(id, r, names));
    return { places, records, devices };
  }

  /** Every book's place, merged from every device. */
  async readAllPositions(): Promise<Map<string, Position>> {
    return (await this.readPositionLog()).places;
  }

  /** One book's place, or null when there is none or the folder cannot be read. */
  async readPosition(bookId: string): Promise<Position | null> {
    try {
      return (await this.readAllPositions()).get(bookId) ?? null;
    } catch {
      return null;
    }
  }

  /** True when positions can be kept on this machine as well as beside the books. */
  get keepsLocalPositions(): boolean {
    return !!this.host.recordsMirror;
  }

  /**
   * Keep every position of this folder on this machine, in the local
   * mirror, flushed to disk. This copy is written first and survives the
   * share being away, the app quitting, and the machine losing power.
   */
  async writeLocalPositions(all: readonly Position[]): Promise<void> {
    const mirror = this.host.recordsMirror;
    if (!mirror) return;
    await mirror.write(this.root, { positions: new TextDecoder().decode(await serializePositions(all)) });
  }

  /** What the local mirror holds beyond the records: positions for the first paint, and covers. */
  async readMirrorExtras(): Promise<{ positions: Map<string, Position>; coversDir: string | null; covers: Set<string> }> {
    const positions = new Map<string, Position>();
    const mirror = await this.host.recordsMirror?.read(this.root).catch(() => null);
    if (!mirror) return { positions, coversDir: null, covers: new Set() };
    if (mirror.positions) {
      try {
        for (const p of (await parsePositions(new TextEncoder().encode(mirror.positions))).positions) positions.set(p.bookId, p);
      } catch {
        /* ignore */
      }
    }
    return { positions, coversDir: this.host.join(mirror.dir, "covers"), covers: new Set(mirror.covers) };
  }

  /** The mirror's cover file name for a book: its id plus the cover's extension. */
  static mirrorCoverName(book: ScannedBook): string | null {
    const cover = book.book.cover;
    if (!cover) return null;
    // A cover chosen by hand has its own name each time, so the mirror copies the new picture.
    const edited = cover.match(/edited-[^/]*-([0-9a-z]+)\.(\w+)$/i);
    if (edited) return `${book.book.id}-${edited[1]}.${edited[2]!.toLowerCase()}`;
    const dot = cover.lastIndexOf(".");
    const ext = dot > cover.lastIndexOf("/") ? cover.slice(dot + 1).toLowerCase() : "jpg";
    return `${book.book.id}.${ext}`;
  }

  /**
   * Copy every book's cover into the local mirror, so the shelf never
   * loads a picture across the network. Returns the names now present.
   */
  async mirrorCovers(books: readonly ScannedBook[]): Promise<Set<string>> {
    const mirror = this.host.recordsMirror;
    if (!mirror) return new Set();
    const wanted: { name: string; src: string }[] = [];
    for (const b of books) {
      const name = LibraryService.mirrorCoverName(b);
      if (name && !b.pending) wanted.push({ name, src: this.absPath(b.book.cover) });
    }
    try {
      return new Set(await mirror.covers(this.root, wanted));
    } catch {
      return new Set();
    }
  }

  /** A position for this device, now. Not written anywhere. */
  async positionAt(bookId: string, offsetMs: number, nowMs = Date.now(), why?: Position["why"]): Promise<Position> {
    const p: Position = { bookId, offsetMs: Math.max(0, Math.round(Number.isFinite(offsetMs) ? offsetMs : 0)), updatedAt: nowIso(nowMs), device: await this.deviceName() };
    if (why) p.why = why;
    return p;
  }

  async writePosition(bookId: string, offsetMs: number, nowMs = Date.now()): Promise<Position> {
    const p = await this.positionAt(bookId, offsetMs, nowMs);
    await this.writePositionRecord(p);
    return p;
  }

  /** Write one position beside the books: a record in this device's log, and the legacy per-book file. */
  async writePositionRecord(p: Position): Promise<void> {
    const b = this.bookInfo?.(p.bookId);
    const loc = b ? locatorFor(b.files, p.offsetMs, b.book.durationMs) : undefined;
    await this.appendRecord({
      k: "pos",
      t: p.updatedAt,
      book: b ? { ids: claimsFor(b.book), dur_ms: b.book.durationMs } : { ids: [ribbonClaim(p.bookId)] },
      why: p.why ?? "periodic",
      ms: p.offsetMs,
      ...(loc ? { loc } : {}),
    });
    await this.host.writeFile(this.dir("positions", `${p.bookId}.csv`), await serializePosition(p));
  }

  /** Add a record to this device's log, stamped with the device and the next sequence number. */
  appendRecord(r: { k: LogRecord["k"]; t: string; book: { ids: string[]; dur_ms?: number } } & Record<string, unknown>): Promise<void> {
    return this.serialLog(async () => {
      const me = await this.me();
      await this.host.mkdir(this.dir("positions"));
      if (!this.deviceFileWritten) {
        await this.host.writeFile(this.dir("positions", deviceFileName(me.id)), new TextEncoder().encode(`${JSON.stringify(me)}\n`));
        this.deviceFileWritten = true;
      }
      this.lastSeq = nextSeq(this.lastSeq);
      const line = encodeRecord({ v: 1, ...r, dev: me.id, seq: this.lastSeq });
      await this.appendBytes(this.dir("positions", logName(me.id)), new TextEncoder().encode(line));
    });
  }

  private serialLog<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.logQueue.then(fn, fn);
    this.logQueue = run.catch(() => undefined);
    return run;
  }

  private async appendBytes(path: string, data: Uint8Array): Promise<void> {
    if (this.host.appendFile) return this.host.appendFile(path, data);
    let before: Uint8Array = new Uint8Array();
    try {
      before = await this.host.readFile(path);
    } catch {
      /* a new log */
    }
    const both = new Uint8Array(before.length + data.length);
    both.set(before);
    both.set(data, before.length);
    await this.host.writeFile(path, both);
  }

  /** Rewrite this device's log with only the latest place per book and every other record. */
  compactOwnLog(): Promise<void> {
    return this.serialLog(async () => {
      const me = await this.me();
      const path = this.dir("positions", logName(me.id));
      const text = new TextDecoder().decode(await this.host.readFile(path));
      const { raw } = parseLog(text);
      const kept = compact(raw);
      if (kept.length === raw.length) return;
      await this.host.writeFile(path, new TextEncoder().encode(kept.map((r) => encodeRecord(r)).join("")));
    }).catch(() => undefined);
  }

  // Problems -----------------------------------------------------------

  /** Files the last scan could not read, as recorded beside the books. */
  async readProblems(): Promise<Problem[]> {
    try {
      return await bytesToProblems(await this.host.readFile(this.dir("problems.csv")));
    } catch {
      return [];
    }
  }

  /** Replace the record with this scan's list. An empty list clears it. */
  async writeProblems(list: readonly Problem[]): Promise<void> {
    const path = this.dir("problems.csv");
    if (list.length === 0) {
      await this.host.remove(path).catch(() => undefined);
      return;
    }
    await this.host.mkdir(this.dir());
    await this.host.writeFile(path, await problemsToBytes(list));
  }

  // About --------------------------------------------------------------

  /** What the book database said about each book, by id. */
  async readAbout(): Promise<Map<string, BookAbout>> {
    try {
      return new Map((await bytesToAbout(await this.host.readFile(this.dir("about.csv")))).map((a) => [a.bookId, a]));
    } catch {
      return new Map();
    }
  }

  async writeAbout(list: readonly BookAbout[]): Promise<void> {
    await this.host.mkdir(this.dir());
    await this.host.writeFile(this.dir("about.csv"), await aboutToBytes(list));
  }

  // Series -------------------------------------------------------------

  /** Every series decision beside the books, by key, in one directory read. */
  async readSeries(): Promise<Map<string, SeriesRecord>> {
    const out = new Map<string, SeriesRecord>();
    const encoder = new TextEncoder();
    for (const f of await this.host.readTextDir(this.dir("series"))) {
      if (!f.name.endsWith(".csv")) continue;
      try {
        const r = await bytesToSeries(f.name.slice(0, -4), encoder.encode(f.text));
        if (r) out.set(r.key, r);
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  async writeSeries(record: SeriesRecord): Promise<void> {
    await this.host.mkdir(this.dir("series"));
    await this.host.writeFile(this.dir("series", `${record.key}.csv`), await seriesToBytes(record));
  }

  /** Forget a series decision. True when there was one here. */
  async deleteSeries(key: string): Promise<boolean> {
    const path = this.dir("series", `${key}.csv`);
    if (!(await this.host.exists(path))) return false;
    await this.host.remove(path);
    return true;
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

  /**
   * The rows of a book's bookmarks CSV, as every version writes them.
   * The bookmarks themselves are these merged with the `mark` records of
   * the position log (`bookmarksOf`).
   */
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
   * Cut the thirty seconds before an offset into a small Opus clip in
   * `bookmarks/clips/`. Best effort: the clip's name relative to
   * `bookmarks/`, or empty when the cut failed.
   */
  async cutClip(book: ScannedBook, offsetMs: number): Promise<string> {
    const id = book.book.id;
    const clip = clipName(id, offsetMs);
    const durations = book.files.map((f) => f.durationMs);
    const loc = locate(durations, offsetMs);
    const file = book.files[loc.fileIndex];
    if (!file) return "";
    const range = clipRange(loc.fileOffsetMs);
    await this.host.mkdir(this.dir("bookmarks", "clips"));
    const out = this.dir("bookmarks", "clips", clip);
    const r = await this.host.run("ffmpeg", clipArgs(this.absPath(file.path), range.startMs, range.endMs, out));
    return r.code === 0 ? `clips/${clip}` : "";
  }

  async removeClip(clip: string): Promise<void> {
    if (clip) await this.host.remove(this.dir("bookmarks", ...clip.split("/"))).catch(() => undefined);
  }

  /** A book's bookmarks as a CSV, for earlier versions on other machines. */
  async writeBookmarks(bookId: string, list: readonly Bookmark[]): Promise<void> {
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
    const chapters = applyCorrections(base, corrections, book.book.durationMs, book.files).chapters;
    const { chaptersToBytes } = await import("../core/scan/records");
    await this.host.mkdir(this.dir("chapters"));
    await this.host.writeFile(this.dir("chapters", `${book.book.id}.csv`), await chaptersToBytes(chapters));
    return { ...book, chapters };
  }

  // Chapter names ------------------------------------------------------

  /** What came of asking about each book's chapter names, by book id. */
  async readNameRecords(): Promise<Map<string, NameRecord>> {
    try {
      return new Map((await bytesToNameRecords(await this.host.readFile(this.dir("chapter-names.csv")))).map((r) => [r.bookId, r]));
    } catch {
      return new Map();
    }
  }

  async writeNameRecords(list: readonly NameRecord[]): Promise<void> {
    await this.host.mkdir(this.dir());
    await this.host.writeFile(this.dir("chapter-names.csv"), await nameRecordsToBytes(list));
  }

  // Edits --------------------------------------------------------------

  /** Every book's hand edits, in one directory read. */
  async readAllEdits(): Promise<Map<string, BookEdits>> {
    const out = new Map<string, BookEdits>();
    const encoder = new TextEncoder();
    for (const f of await this.host.readTextDir(this.dir("edits"))) {
      if (!f.name.endsWith(".csv")) continue;
      try {
        const e = await bytesToEdits(f.name.slice(0, -4), encoder.encode(f.text));
        if (Object.keys(e.values).length > 0) out.set(e.bookId, e);
      } catch {
        /* an unreadable edit is no edit */
      }
    }
    return out;
  }

  /** Keep a book's edits beside it; no edits removes the file. */
  async writeEdits(edits: BookEdits): Promise<void> {
    const path = this.dir("edits", `${edits.bookId}.csv`);
    if (Object.keys(edits.values).length === 0) {
      await this.host.remove(path).catch(() => undefined);
      return;
    }
    await this.host.mkdir(this.dir("edits"));
    await this.host.writeFile(path, await editsToBytes(edits));
  }

  /**
   * Put a cover chosen by hand beside the books, under a new name each
   * time so every copy of it (the local mirror, the webview's cache)
   * sees a new picture. Returns its library-relative path.
   */
  async writeEditedCover(bookId: string, bytes: Uint8Array, ext: string, nowMs = Date.now()): Promise<string> {
    const clean = ext.toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const name = `edited-${bookId}-${nowMs.toString(36)}.${clean}`;
    await this.host.mkdir(this.dir("covers"));
    await this.host.writeFile(this.dir("covers", name), bytes);
    return `${RIBBON_DIR}/covers/${name}`;
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
