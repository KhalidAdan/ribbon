import type { Host, ScanProgress } from "../host/host";
import { extractMissingCovers, type ScannedBook } from "../core/scan/scan";
import type { Bookmark, BookSettings, Position, SilenceRange } from "../core/types";
import type { Problem } from "../core/problems";
import { defaultChoices, detectSeries, mergeSeries, newSeriesRecord, normalizeChoices, uniqueKey, type SeriesChoice, type SeriesGroup, type SeriesRecord } from "../core/series";
import type { BookAbout } from "../core/about";
import { sameRoot, sourceFrom, type Source, type SourceEntry } from "../core/sources";
import { AboutLookup, type LookupStatus } from "./about";
import { PlayerEngine, type EngineState } from "../player/engine";
import { LibraryService } from "./library";
import { JobQueue, type JobStatus } from "./jobs";
import { installMediaSession, updateMediaMetadata, updateMediaPlayback } from "./media-session";
import { resumePosition, rewindFor } from "../core/resume";
import { snapSpeed } from "../core/speed";
import { clipRange } from "../core/bookmarks";
import { chapterAt } from "../core/scan/chapters";
import * as sleep from "../core/sleep";
import type { Correction } from "../core/scan/chapters";
import { log } from "./log";

export interface Platform {
  host: Host;
  /** Ask the user for a folder of books, opening near `near`. Null when cancelled. */
  pickFolder(near?: string | null): Promise<string | null>;
  /** Grant access to a folder before any read. */
  allowFolder(path: string): Promise<void>;
  /** Streamable URL for an absolute path. */
  fileUrl(absPath: string): string;
  /** The folders the library is populated from, wherever the platform keeps them. */
  sources: {
    load(): Promise<SourceEntry[]>;
    save(list: SourceEntry[]): Promise<void>;
  };
  /** A folder to add automatically without picking (dev harness, command line). */
  defaultRoot?: () => Promise<string | null>;
  /** Milliseconds since the host process started, when the host knows. */
  uptimeMs?: () => Promise<number>;
  /** App-level settings that outlive a library, when the platform keeps them. */
  appSettings?: {
    read(): Promise<Record<string, unknown>>;
    write(settings: Record<string, unknown>): Promise<void>;
  };
  /** The one folder the app owns on this machine, when there is one. */
  home?: {
    path(): Promise<string>;
    reveal(): Promise<void>;
    /** Asks first. Resolves true when the reset happened. */
    reset(): Promise<boolean>;
  };
}

export interface CurrentBook {
  book: ScannedBook;
  settings: BookSettings;
  bookmarks: Bookmark[];
  loudnessGainDb: number | null;
  silence: Map<number, SilenceRange[]> | null;
  corrections: Correction[];
}

export interface ScanStatus {
  /** Files seen so far and files finished; both zero while walking. */
  walked: number;
  done: number;
  /** Files discovered so far while the walk is still running. */
  found?: number;
  /** What is happening after the tag read. */
  stage?: string;
  /** True while a rescan runs behind an already visible library. */
  background: boolean;
}

/** What the shelf knows about one source beyond its books. */
export interface SourceStatus {
  scanning: ScanStatus | null;
  /** How long the last scan took, or null before the first finishes. */
  lastScanMs: number | null;
  /** Why the source could not be opened, or null. */
  error: string | null;
}

export interface AppState {
  phase: "boot" | "pick" | "loading" | "ready";
  /** The folders the library is populated from, in the order they were added. */
  sources: Source[];
  sourceStatus: Record<string, SourceStatus>;
  /** Every book from every source, in source order. */
  books: ScannedBook[];
  positions: Record<string, Position | null>;
  current: CurrentBook | null;
  player: EngineState;
  sleep: { state: sleep.SleepState; gain: number; remainingMs: number | null };
  resumeOffer: { chapterStartMs: number; awayMs: number } | null;
  /** The bookmark whose lead-in is playing through the main player. */
  previewing: number | null;
  jobs: Record<string, JobStatus>;
  /** Progress across every source being scanned, or null when none is. */
  scanning: ScanStatus | null;
  /** Files the last scans could not read. */
  scanErrors: { path: string; message: string }[];
  /** The same, as recorded beside the books, so yesterday's are still visible. */
  problems: Problem[];
  /** Series decisions beside the books, by key. */
  series: Record<string, SeriesRecord>;
  /** The series whose setup is open, or null. */
  seriesSetup: SeriesGroup | null;
  /** The dialog for making a series by hand is open. */
  seriesNew: boolean;
  /** What the book database said, by book id. */
  about: Record<string, BookAbout>;
  /** Whether descriptions are looked up online, and how the current run is going. */
  lookup: { enabled: boolean } & LookupStatus;
  /** How long the last scan to finish took, for the header. */
  lastScanMs: number | null;
  /**
   * True once the host will serve files from every source: covers and
   * audio. Granting that access canonicalises the folder, which on a
   * network volume is several round trips, so the shelf paints first.
   */
  assetsReady: boolean;
  /** Bumped when the set of locally mirrored covers changes. */
  coverVersion: number;
  error: string | null;
  /** What fills the window above the player bar. */
  pane: "library" | "settings" | "reader";
  /** The book the reader page shows. */
  readerBookId: string | null;
  /** The full player is open over everything. */
  playerExpanded: boolean;
  /** Which drawer the full player shows, if any. */
  playerDrawer: "chapters" | "bookmarks" | "speed" | null;
}

/**
 * The folder picker opens inside the last source, where `.ribbon` is the
 * first thing to click. Choosing it means the folder it belongs to.
 */
export function libraryRootOf(picked: string): string {
  const trimmed = picked.replace(/[\\/]+$/, "");
  const m = trimmed.match(/^(.*)[\\/]\.ribbon$/i);
  return m && m[1] ? m[1] : trimmed;
}

/** Tauri rejects with plain strings; everything else with Errors. */
function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

const SKIP_BACK_MS = 30_000;
const SKIP_FORWARD_MS = 30_000;
const POSITION_WRITE_INTERVAL_MS = 5_000;

/** One source, open: its records service and everything the shelf needs from it. */
interface Opened {
  source: Source;
  lib: LibraryService;
  books: ScannedBook[];
  positions: Map<string, Position>;
  /** Series keys whose record lives beside this source's books. */
  seriesKeys: Set<string>;
  assetsReady: boolean;
  scanning: ScanStatus | null;
  scanInFlight: boolean;
  /** The last scan's record write, which the shelf does not wait for. */
  saving: Promise<void>;
  coverJob: AbortController | null;
  lookup: AboutLookup | null;
  /** Covers copied into the local mirror, and where they are. */
  mirrorCovers: Set<string>;
  mirrorCoversDir: string | null;
}

export class AppController {
  private state: AppState;
  private listeners = new Set<() => void>();
  private opened = new Map<string, Opened>();
  private jobs: JobQueue;
  private engine: PlayerEngine | null = null;
  private pausedAt: number | null = null;
  private lastWrite = 0;
  private sleepTimer: number | null = null;
  private uninstallMedia: (() => void) | null = null;
  private chapterProbe: AbortController | null = null;
  /** process uptime minus performance.now(), learned once at boot. */
  private clockOffset: number | null = null;
  /** Series offered for setup this session, so a skipped one stays skipped. */
  private seriesOffered = new Set<string>();
  /** The lookup pass over every source, while one runs. */
  private lookupRun: Promise<void> | null = null;
  private appSettings: Record<string, unknown> = {};

  constructor(private readonly platform: Platform) {
    this.state = {
      phase: "boot",
      sources: [],
      sourceStatus: {},
      books: [],
      positions: {},
      current: null,
      player: {
        bookId: null,
        positionMs: 0,
        durationMs: 0,
        playing: false,
        buffering: false,
        speed: 1,
        chapterIndex: -1,
        skippingGap: false,
        gain: 1,
        error: null,
      },
      sleep: { state: sleep.IDLE, gain: 1, remainingMs: null },
      resumeOffer: null,
      previewing: null,
      jobs: {},
      scanning: null,
      scanErrors: [],
      problems: [],
      series: {},
      seriesSetup: null,
      seriesNew: false,
      about: {},
      lookup: { enabled: false, running: false, done: 0, total: 0 },
      lastScanMs: null,
      assetsReady: false,
      coverVersion: 0,
      error: null,
      pane: "library",
      readerBookId: null,
      playerExpanded: false,
      playerDrawer: null,
    };
    this.jobs = new JobQueue((book) => this.libOf(book));
    this.jobs.onStatus((s, result) => this.onJob(s, result));
  }

  // Store plumbing ------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = (): AppState => this.state;

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  // Sources -------------------------------------------------------------

  /** The service for the source a book came from, or null when it is gone. */
  private libOf(book: ScannedBook): LibraryService | null {
    return this.openedOf(book)?.lib ?? null;
  }

  private openedOf(book: ScannedBook): Opened | null {
    return (book.source && this.opened.get(book.source)) || null;
  }

  private openedInOrder(): Opened[] {
    return this.state.sources.map((s) => this.opened.get(s.id)).filter((o): o is Opened => !!o);
  }

  private stamp(o: Opened, books: readonly ScannedBook[]): ScannedBook[] {
    return books.map((b) => (b.source === o.source.id ? b : { ...b, source: o.source.id }));
  }

  /** Every open source's books, in source order, and their positions; a duplicate id keeps its first book. */
  private publishBooks(extra: Partial<AppState> = {}): void {
    const seen = new Set<string>();
    const books: ScannedBook[] = [];
    const positions: Record<string, Position | null> = {};
    for (const o of this.openedInOrder()) {
      for (const b of o.books) {
        const id = b.book.id;
        if (seen.has(id)) {
          log.warn("two sources hold the same book id; keeping the first:", id, b.book.title);
          continue;
        }
        seen.add(id);
        books.push(b);
        positions[id] = o.positions.get(id) ?? this.state.positions[id] ?? null;
      }
    }
    // Keep the open book's live object if it still exists.
    const cur = this.state.current;
    const refreshed = cur ? books.find((b) => b.book.id === cur.book.book.id) : undefined;
    this.set({
      books,
      positions,
      current: cur && refreshed && refreshed !== cur.book ? { ...cur, book: { ...refreshed, chapters: cur.book.chapters } } : cur,
      ...extra,
    });
  }

  /** The scan status across every source, for the header. */
  private publishScanning(extra: Partial<AppState> = {}): void {
    const live = this.openedInOrder().filter((o) => o.scanning);
    let scanning: ScanStatus | null = null;
    if (live.length > 0) {
      scanning = { walked: 0, done: 0, background: true };
      for (const o of live) {
        const s = o.scanning!;
        scanning.walked += s.walked;
        scanning.done += s.done;
        if (s.found !== undefined) scanning.found = (scanning.found ?? 0) + s.found;
        if (s.stage && !scanning.stage) scanning.stage = s.stage;
        if (!s.background) scanning.background = false;
      }
    }
    const sourceStatus: Record<string, SourceStatus> = {};
    for (const s of this.state.sources) {
      const o = this.opened.get(s.id);
      sourceStatus[s.id] = { ...(this.state.sourceStatus[s.id] ?? { lastScanMs: null, error: null }), scanning: o?.scanning ?? null };
    }
    this.set({ scanning, sourceStatus, assetsReady: this.openedInOrder().every((o) => o.assetsReady), ...extra });
  }

  private setSourceStatus(id: string, patch: Partial<SourceStatus>): void {
    const prev = this.state.sourceStatus[id] ?? { scanning: null, lastScanMs: null, error: null };
    this.set({ sourceStatus: { ...this.state.sourceStatus, [id]: { ...prev, ...patch } } });
  }

  private saveSources(): Promise<void> {
    return this.platform.sources.save(this.state.sources.map((s) => ({ root: s.root, addedAt: s.addedAt }))).catch((e: unknown) => log.warn("could not save the sources:", describe(e)));
  }

  // Lifecycle -----------------------------------------------------------

  async boot(): Promise<void> {
    if (this.platform.appSettings) {
      this.appSettings = await this.platform.appSettings.read().catch(() => ({}));
      this.set({ lookup: { ...this.state.lookup, enabled: this.appSettings.lookupDescriptions === true } });
    }
    const asked = performance.now();
    void this.platform.uptimeMs?.().then((ms) => {
      this.clockOffset = ms - asked;
      log.info(`web side booted ${Math.round(ms)} ms after process start`);
    });
    const entries = await this.platform.sources.load().catch((e: unknown) => {
      log.warn("could not read the sources:", describe(e));
      return [] as SourceEntry[];
    });
    const given = (await this.platform.defaultRoot?.()) ?? null;
    if (given && !entries.some((e) => sameRoot(e.root, given))) {
      log.info("adding the folder given at launch", given);
      entries.push({ root: given, addedAt: new Date().toISOString() });
      await this.platform.sources.save(entries).catch((e: unknown) => log.warn("could not save the sources:", describe(e)));
    }
    if (entries.length === 0) {
      this.set({ phase: "pick" });
      return;
    }
    const sources = entries.map(sourceFrom);
    this.set({ phase: "loading", sources, sourceStatus: Object.fromEntries(sources.map((s) => [s.id, { scanning: null, lastScanMs: null, error: null }])) });
    await Promise.all(
      sources.map((s) =>
        this.openSource(s).catch((e: unknown) => {
          log.error("could not open", s.root, describe(e));
          this.setSourceStatus(s.id, { error: describe(e) });
        }),
      ),
    );
    if (this.opened.size === 0) {
      const first = sources[0]!;
      this.set({ phase: "pick", scanning: null, error: `Could not open ${first.root}: ${this.state.sourceStatus[first.id]?.error ?? "unknown error"}` });
      return;
    }
    this.publishScanning({ phase: "ready" });
  }

  /** Ask for a folder and add it; a folder already in the library is checked for changes instead. */
  async pickLibrary(): Promise<void> {
    const near = this.state.sources[this.state.sources.length - 1]?.root ?? null;
    const root = await this.platform.pickFolder(near);
    if (!root) return;
    try {
      await this.addSource(root);
    } catch (e) {
      this.set({ phase: this.opened.size === 0 ? "pick" : this.state.phase, scanning: null, error: `Could not open ${root}: ${describe(e)}` });
    }
  }

  /** The same as `pickLibrary` without the dialog. */
  addFolder(root: string): Promise<void> {
    return this.addSource(root);
  }

  /**
   * Add a folder to the library and open it. If it has been scanned
   * before, its records paint immediately and a rescan runs behind them;
   * nothing before that paint waits on the share when the local mirror
   * has a copy. If not, the scan runs in the foreground with live counts.
   */
  async addSource(pickedRoot: string): Promise<void> {
    const root = libraryRootOf(pickedRoot);
    if (root !== pickedRoot) log.info("picked the records folder; using its parent", root);
    const existing = this.state.sources.find((s) => sameRoot(s.root, root));
    if (existing) {
      log.info("folder is already a source; checking it for changes", root);
      const o = this.opened.get(existing.id);
      if (o) await this.rescanSource(o, true);
      else await this.openSource(existing);
      return;
    }
    const source = sourceFrom({ root, addedAt: new Date().toISOString() });
    log.info("add source", root);
    this.set({
      phase: this.opened.size === 0 ? "loading" : this.state.phase,
      sources: [...this.state.sources, source],
      sourceStatus: { ...this.state.sourceStatus, [source.id]: { scanning: null, lastScanMs: null, error: null } },
      error: null,
    });
    try {
      await this.openSource(source);
    } catch (e) {
      const { [source.id]: _dropped, ...sourceStatus } = this.state.sourceStatus;
      this.set({ sources: this.state.sources.filter((s) => s.id !== source.id), sourceStatus, phase: this.opened.size === 0 ? "pick" : "ready" });
      throw e;
    }
    void this.saveSources();
  }

  private async openSource(source: Source): Promise<void> {
    const root = source.root;
    const marks: string[] = [];
    let last = performance.now();
    const mark = (what: string) => {
      const now = performance.now();
      marks.push(`${what} ${Math.round(now - last)}`);
      last = now;
    };
    const lib = new LibraryService(this.platform.host, root);
    const o: Opened = {
      source,
      lib,
      books: [],
      positions: new Map(),
      seriesKeys: new Set(),
      assetsReady: false,
      scanning: null,
      scanInFlight: false,
      saving: Promise.resolve(),
      coverJob: null,
      lookup: null,
      mirrorCovers: new Set(),
      mirrorCoversDir: null,
    };
    this.opened.set(source.id, o);
    this.ensureEngine();
    const alive = () => this.opened.get(source.id) === o;
    // Access to the folder's files is granted while the shelf paints from
    // the local mirror; covers appear the moment it lands.
    const allowed = this.platform.allowFolder(root).then(() => {
      mark("allow");
      o.assetsReady = true;
      if (alive()) this.publishScanning();
    });

    let migrated = false;
    const migrate = async () => {
      if (migrated) return;
      migrated = true;
      if (await lib.migrateLegacyRecords()) log.info("moved records from .odio to .ribbon", root);
    };
    try {
      let cached = await lib.loadCached();
      mark("records");
      if (!cached || cached.length === 0) {
        await migrate();
        cached = await lib.loadCached();
        mark("migrate+records");
      }
      log.info("cached records:", source.name, cached ? `${cached.length} books` : "none");
      if (cached && cached.length > 0) {
        const extras = await lib.readMirrorExtras();
        o.mirrorCovers = extras.covers;
        o.mirrorCoversDir = extras.coversDir;
        o.positions = extras.positions;
        o.books = this.stamp(o, cached);
        mark("positions");
        if (!alive()) return;
        this.publishBooks({ phase: "ready", coverVersion: this.state.coverVersion + 1 });
        this.publishScanning();
        mark("render");
        this.logPainted("from records", `; steps: ${marks.join(", ")} ms`);
        // Only now the share: the legacy folder, the positions written elsewhere, the rescan.
        await allowed;
        await migrate();
        const [positions, problems, series, about] = await Promise.all([lib.readAllPositions(), lib.readProblems(), lib.readSeries(), lib.readAbout()]);
        if (!alive()) return;
        o.positions = positions;
        this.absorb(o, problems, series, about);
        this.publishBooks();
        void this.rescanSource(o, true);
        return;
      }
      o.scanning = { walked: 0, done: 0, background: false };
      this.publishScanning();
      await allowed;
      await this.rescanSource(o, false);
      if (!alive()) return;
      this.offerSeriesSetup();
      this.publishScanning({ phase: "ready" });
      await o.saving;
    } catch (e) {
      if (alive()) {
        this.opened.delete(source.id);
        o.scanning = null;
        this.publishBooks();
        this.publishScanning();
      }
      throw e;
    }
  }

  /** Records read beside one source's books, merged into the shelf. */
  private absorb(o: Opened, problems: Problem[], series: Map<string, SeriesRecord>, about: Map<string, BookAbout>): void {
    for (const k of series.keys()) o.seriesKeys.add(k);
    this.set({
      problems: [...this.state.problems.filter((p) => p.source !== o.source.id), ...problems.map((p) => ({ ...p, source: o.source.id }))],
      series: { ...this.state.series, ...Object.fromEntries(series) },
      about: { ...this.state.about, ...Object.fromEntries(about) },
    });
  }

  /** Check every source for changes. */
  async rescan(background = this.state.phase === "ready"): Promise<void> {
    await Promise.all(this.openedInOrder().map((o) => this.rescanSource(o, background)));
  }

  /** Check one source for changes. */
  async rescanSourceById(id: string): Promise<void> {
    const o = this.opened.get(id);
    if (o) await this.rescanSource(o, true);
  }

  /**
   * Scan one source. Books appear as the scan streams them: the shelf
   * paints from folder names as soon as the walk is done, then fills in
   * authors, then durations, and the complete list lands last.
   */
  private async rescanSource(o: Opened, background: boolean, forget: string[] = []): Promise<void> {
    if (o.scanInFlight) return;
    const { lib, source } = o;
    const alive = () => this.opened.get(source.id) === o;
    o.scanInFlight = true;
    o.scanning = { walked: 0, done: 0, background };
    this.publishScanning({ scanErrors: this.state.scanErrors.filter((e) => !e.path.startsWith(`${source.id}:`)) });
    const started = Date.now();
    log.info("scan start", source.root, background ? "(background)" : "(foreground)");
    // Positions are one directory read; start it now and apply it to
    // every set of books that comes through.
    const positionsReady = lib
      .readAllPositions()
      .catch(() => new Map<string, Position>())
      .then((m) => (o.positions = m));
    let painted = false;
    let lastTick = 0;
    try {
      const result = await lib.rescanDetailed({
        write: false,
        forget,
        onProgress: (p: ScanProgress) => {
          // Batches can land many times a second; the header need not.
          const now = Date.now();
          const final = p.stage !== undefined || (p.walked > 0 && p.done >= p.walked);
          if (!final && now - lastTick < 100) return;
          lastTick = now;
          if (!alive()) return;
          o.scanning = { ...p, background };
          this.publishScanning();
        },
        onBooks: (books: ScannedBook[]) => {
          if (books.length === 0 || !alive()) return;
          if (!painted) {
            painted = true;
            log.info("first paint:", source.name, books.length, "books,", Date.now() - started, "ms after scan start");
            this.logPainted("from the walk");
          }
          o.books = this.stamp(o, books);
          this.publishBooks(this.state.phase === "loading" ? { phase: "ready" } : {});
        },
      });
      const books = this.stamp(o, result.books);
      log.info("scan done:", source.name, books.length, "books,", result.probed, "probed,", result.reused, "reused,", result.rescued, "rescued by ffprobe,", result.errors.length, "errors,", result.elapsedMs, "ms");
      const t = result.timings;
      log.info(`scan timings: records ${t.recordsMs} ms, scan ${t.scanMs} ms, rescue ${t.rescueMs} ms, build ${t.buildMs} ms, write ${t.writeMs} ms; ${t.publishes} interim builds took ${t.publishMs} ms`);
      for (const e of result.errors) log.warn("scan:", source.name, e.path, e.message);
      await positionsReady;
      if (!alive()) return;
      o.books = books;
      o.scanning = null;
      const elapsed = Date.now() - started;
      // Every scan is a full walk, so its errors are the whole current list for this source.
      const at = new Date().toISOString();
      const problems: Problem[] = result.errors.map((e) => ({ path: e.path, message: e.message, at, source: source.id }));
      this.publishBooks({
        scanErrors: [...this.state.scanErrors, ...result.errors],
        problems: [...this.state.problems.filter((p) => p.source !== source.id), ...problems],
        lastScanMs: elapsed,
      });
      this.setSourceStatus(source.id, { lastScanMs: elapsed, error: null });
      this.publishScanning();
      void lib.writeProblems(problems.map(({ path, message, at }) => ({ path, message, at }))).catch((e: unknown) => log.warn("could not save problems:", describe(e)));
      const saveStarted = Date.now();
      o.saving = result.save().then(
        () => log.info("records saved in", Date.now() - saveStarted, "ms", source.name),
        (e: unknown) => log.warn("could not save records:", describe(e)),
      );
      void this.fetchCovers(o).then(() => this.mirrorCoversFor(o));
      if (background) this.offerSeriesSetup();
      this.maybeLookup();
    } catch (e) {
      log.error("scan failed:", source.name, describe(e));
      o.scanning = null;
      if (alive()) {
        this.setSourceStatus(source.id, { error: describe(e) });
        this.publishScanning({ error: describe(e) });
      }
      if (!background) throw e;
    } finally {
      o.scanInFlight = false;
    }
  }

  /** Covers ffmpeg still has to cut, after the library is visible. */
  private async fetchCovers(o: Opened): Promise<void> {
    o.coverJob?.abort();
    const abort = new AbortController();
    o.coverJob = abort;
    const done = await extractMissingCovers(o.lib.host, o.lib.root, o.books, () => this.publishBooks(), abort.signal);
    if (done.length > 0) log.info("covers extracted:", done.length, o.source.name);
  }

  /** How long the listener waited from launch to a shelf, when the host can say. */
  private logPainted(how: string, detail = ""): void {
    if (this.clockOffset === null) return;
    const offset = this.clockOffset;
    // Let the frame that shows the shelf go out first.
    requestAnimationFrame(() => {
      log.info(`shelf painted ${how}: ${Math.round(performance.now() + offset)} ms after process start (window ${document.visibilityState})${detail}`);
    });
  }

  /**
   * Take a folder out of the library. Nothing on disk changes: its
   * records stay beside its books and its mirror stays in the Ribbon
   * folder, so adding it back is instant.
   */
  async removeSource(id: string): Promise<void> {
    const o = this.opened.get(id);
    const source = this.state.sources.find((s) => s.id === id);
    if (!source) return;
    log.info("remove source", source.root);
    const cur = this.state.current;
    if (cur && cur.book.source === id) {
      if (this.state.player.playing) {
        this.engine?.pause();
        await this.persistPosition();
      }
      this.chapterProbe?.abort();
      this.engine?.pause();
      this.set({ current: null, playerExpanded: false, playerDrawer: null, resumeOffer: null, previewing: null });
    }
    this.jobs.cancelWhere((b) => b.source === id);
    if (o) {
      o.coverJob?.abort();
      o.lookup?.stop();
      this.opened.delete(id);
    }
    const gone = new Set((o?.books ?? []).map((b) => b.book.id));
    const { [id]: _dropped, ...sourceStatus } = this.state.sourceStatus;
    const series = Object.fromEntries(Object.entries(this.state.series).filter(([k]) => !o?.seriesKeys.has(k)));
    const about = Object.fromEntries(Object.entries(this.state.about).filter(([k]) => !gone.has(k)));
    const jobs = Object.fromEntries(Object.entries(this.state.jobs).filter(([k]) => !gone.has(k)));
    this.set({
      sources: this.state.sources.filter((s) => s.id !== id),
      sourceStatus,
      problems: this.state.problems.filter((p) => p.source !== id),
      series,
      about,
      jobs,
      seriesSetup: this.state.seriesSetup && this.state.seriesSetup.bookIds.some((b) => gone.has(b)) ? null : this.state.seriesSetup,
      readerBookId: this.state.readerBookId && gone.has(this.state.readerBookId) ? null : this.state.readerBookId,
      pane: this.state.pane === "reader" && this.state.readerBookId && gone.has(this.state.readerBookId) ? "library" : this.state.pane,
    });
    this.publishBooks();
    this.publishScanning(this.state.sources.length === 0 ? { phase: "pick", pane: "library", playerExpanded: false } : {});
    await this.saveSources();
  }

  /** Copy covers into the local mirror once the shelf is settled, then show them from there. */
  private async mirrorCoversFor(o: Opened): Promise<void> {
    if (!o.lib.host.recordsMirror) return;
    const present = await o.lib.mirrorCovers(o.books);
    if (this.opened.get(o.source.id) !== o) return;
    if (!o.mirrorCoversDir) o.mirrorCoversDir = (await o.lib.readMirrorExtras()).coversDir;
    o.mirrorCovers = present;
    this.set({ coverVersion: this.state.coverVersion + 1 });
  }

  /**
   * The cover's URL. From the local mirror when it has a copy; otherwise
   * from the source, but only once its files may be served and no scan
   * of it is running, because a read across the network stalls the
   * host's main thread and a scan keeps the volume busy. Null means
   * show initials.
   */
  coverUrl(book: ScannedBook): string | null {
    const o = this.openedOf(book);
    if (!o || !book.book.cover) return null;
    const name = LibraryService.mirrorCoverName(book);
    if (name && o.mirrorCoversDir && o.mirrorCovers.has(name)) return this.platform.fileUrl(o.lib.host.join(o.mirrorCoversDir, name));
    if (!o.assetsReady || o.scanning) return null;
    return this.platform.fileUrl(o.lib.absPath(book.book.cover));
  }

  /** The source a book came from, for the page. */
  sourceOf(book: ScannedBook): Source | null {
    return this.state.sources.find((s) => s.id === book.source) ?? null;
  }

  private onJob(s: JobStatus, result: { gainDb: number | null; silence: Map<number, SilenceRange[]> } | null): void {
    this.set({ jobs: { ...this.state.jobs, [s.bookId]: s } });
    const cur = this.state.current;
    if (result && cur && cur.book.book.id === s.bookId) {
      this.set({ current: { ...cur, loudnessGainDb: result.gainDb, silence: result.silence } });
      if (result.gainDb !== null) this.engine?.setLoudnessGainDb(result.gainDb);
      if (cur.settings.trimSilence) this.engine?.setSilence(result.silence);
    }
  }

  // Playback ------------------------------------------------------------

  private ensureEngine(): PlayerEngine | null {
    if (this.engine) return this.engine;
    if (typeof Audio === "undefined") return null;
    this.engine = new PlayerEngine({
      resolveUrl: (rel) => {
        const cur = this.state.current;
        const lib = (cur && this.libOf(cur.book)) ?? this.openedInOrder()[0]?.lib;
        return lib ? this.platform.fileUrl(lib.absPath(rel)) : "";
      },
      onState: (player) => this.onPlayerState(player),
      onEnded: () => this.onBookEnded(),
    });
    this.uninstallMedia = installMediaSession({
      play: () => void this.play(),
      pause: () => this.pause(),
      seekBackward: () => this.skip(-SKIP_BACK_MS),
      seekForward: () => this.skip(SKIP_FORWARD_MS),
      previousChapter: () => this.previousChapter(),
      nextChapter: () => this.nextChapter(),
      seekTo: (ms) => this.seek(ms),
    });
    return this.engine;
  }

  private onPlayerState(player: EngineState): void {
    const prev = this.state.player;
    this.set({ player });
    if (this.state.previewing !== null && prev.playing && !player.playing) {
      this.set({ previewing: null });
      this.pausedAt = Date.now();
      void this.persistPosition();
    }
    if (player.playing && Date.now() - this.lastWrite > POSITION_WRITE_INTERVAL_MS) void this.persistPosition();
    if (player.chapterIndex !== prev.chapterIndex || player.bookId !== prev.bookId) this.refreshMediaMetadata();
    if (player.playing !== prev.playing || Math.abs(player.positionMs - prev.positionMs) > 900) {
      updateMediaPlayback(player.playing, player.positionMs, player.durationMs, player.speed);
    }
  }

  /**
   * Open a book. Playback is ready as soon as the cached records are
   * read; embedded chapter markers are probed behind it the first time
   * and swapped in when they arrive.
   */
  async openBook(book: ScannedBook, opts: { expand?: boolean; autoplay?: boolean } = {}): Promise<void> {
    const lib = this.libOf(book);
    if (!lib) return;
    const engine = this.ensureEngine();
    if (!engine) return;
    const expand = opts.expand ?? true;
    if (this.state.current?.book.book.id === book.book.id) {
      if (expand) this.expandPlayer();
      if (opts.autoplay && !this.state.player.playing) await this.play();
      return;
    }
    if (this.state.player.playing) {
      engine.pause();
      await this.persistPosition();
    }
    this.chapterProbe?.abort();
    const [settings, bookmarks, loudness, silence, corrections] = await Promise.all([
      lib.readSettings(book.book.id),
      lib.readBookmarks(book.book.id),
      lib.readLoudness(book.book.id),
      lib.readSilence(book.book.id),
      lib.readCorrections(book.book.id),
    ]);
    const position = this.state.positions[book.book.id] ?? (await lib.readPosition(book.book.id));
    const current: CurrentBook = { book, settings, bookmarks, loudnessGainDb: loudness?.gainDb ?? null, silence, corrections };
    this.set({ current, playerExpanded: expand, playerDrawer: null, resumeOffer: null });
    const startMs = position ? Math.min(position.offsetMs, book.book.durationMs) : 0;
    await engine.load({ id: book.book.id, files: book.files, chapters: book.chapters, silence: settings.trimSilence ? (silence ?? undefined) : undefined }, startMs);
    engine.setSpeed(settings.speed);
    engine.setLoudnessGainDb(loudness?.gainDb ?? 0);
    this.pausedAt = position ? Date.parse(position.updatedAt) : null;
    this.refreshMediaMetadata();
    if (!loudness || !silence) this.jobs.enqueue(book, true);
    void this.probeChapters(book);
    if (opts.autoplay) await this.play();
  }

  /** Start or continue a book from its page: the bar appears, the page stays. */
  playBook(book: ScannedBook): Promise<void> {
    return this.openBook(book, { expand: false, autoplay: true });
  }

  /** Show a book's page, with its series along the side when it has one. */
  openReader(bookId: string): void {
    this.set({ pane: "reader", readerBookId: bookId, playerExpanded: false });
  }

  private async probeChapters(book: ScannedBook): Promise<void> {
    const o = this.openedOf(book);
    if (!o || book.files.every((f) => f.chaptersProbed)) return;
    const abort = new AbortController();
    this.chapterProbe = abort;
    // The chapter probe rewrites files.csv; let the scan's own write land first.
    await o.saving;
    if (abort.signal.aborted) return;
    const probed = await o.lib.ensureChapters(book, abort.signal);
    if (abort.signal.aborted || probed === book) return;
    const updated = this.stamp(o, [probed])[0]!;
    const cur = this.state.current;
    if (!cur || cur.book.book.id !== book.book.id) return;
    this.replaceBook(o, updated);
    this.set({ current: { ...cur, book: updated } });
    this.engine?.setChapters(updated.chapters);
    this.refreshMediaMetadata();
  }

  /** Swap one book's object in its source and on the shelf. */
  private replaceBook(o: Opened, updated: ScannedBook): void {
    o.books = o.books.map((b) => (b.book.id === updated.book.id ? updated : b));
    this.set({ books: this.state.books.map((b) => (b.book.id === updated.book.id ? updated : b)) });
  }

  /** Play, applying the scaled resume rewind for the time we were away. */
  async play(): Promise<void> {
    const engine = this.engine;
    const cur = this.state.current;
    if (!engine || !cur) return;
    engine.setStopAt(null);
    if (this.state.previewing !== null) this.set({ previewing: null });
    const now = Date.now();
    const gap = this.pausedAt === null ? 0 : Math.max(0, now - this.pausedAt);
    const pos = engine.positionMs();
    const chIndex = chapterAt(cur.book.chapters, pos);
    const chapterStart = chIndex >= 0 ? cur.book.chapters[chIndex]!.startMs : 0;
    const target = resumePosition(pos, gap, chapterStart);
    if (target !== pos) engine.seek(target);
    const policy = rewindFor(gap);
    this.set({ resumeOffer: policy.offerChapterRestart && chapterStart < target ? { chapterStartMs: chapterStart, awayMs: gap } : null });
    this.pausedAt = null;
    await engine.play();
  }

  pause(): void {
    if (!this.engine) return;
    this.engine.pause();
    this.pausedAt = Date.now();
    this.set({ previewing: null });
    void this.persistPosition();
  }

  togglePlay(): void {
    if (this.state.player.playing) this.pause();
    else void this.play();
  }

  seek(positionMs: number): void {
    if (!this.engine) return;
    this.engine.setStopAt(null);
    this.engine.seek(positionMs);
    this.set({ resumeOffer: null, previewing: null });
    void this.persistPosition();
  }

  skip(deltaMs: number): void {
    if (!this.engine) return;
    this.seek(this.engine.positionMs() + deltaMs);
  }

  restartChapter(): void {
    const offer = this.state.resumeOffer;
    if (offer) this.seek(offer.chapterStartMs);
    this.set({ resumeOffer: null });
  }

  dismissResumeOffer(): void {
    this.set({ resumeOffer: null });
  }

  goToChapter(index: number): void {
    const cur = this.state.current;
    const ch = cur?.book.chapters[index];
    if (ch) this.seek(ch.startMs);
  }

  nextChapter(): void {
    const cur = this.state.current;
    if (!cur) return;
    const i = this.state.player.chapterIndex;
    if (i + 1 < cur.book.chapters.length) this.goToChapter(i + 1);
    else this.seek(cur.book.book.durationMs);
  }

  /** Within the first three seconds of a chapter, go to the previous one. */
  previousChapter(): void {
    const cur = this.state.current;
    if (!cur) return;
    const i = this.state.player.chapterIndex;
    const ch = cur.book.chapters[i];
    if (!ch) return;
    if (this.state.player.positionMs - ch.startMs > 3000 || i === 0) this.seek(ch.startMs);
    else this.goToChapter(i - 1);
  }

  async setSpeed(speed: number): Promise<void> {
    const cur = this.state.current;
    const lib = cur && this.libOf(cur.book);
    if (!cur || !this.engine || !lib) return;
    const s = snapSpeed(speed);
    this.engine.setSpeed(s);
    const settings = { ...cur.settings, speed: s };
    this.set({ current: { ...cur, settings } });
    await lib.writeSettings(settings);
  }

  /** Turn pause trimming on or off for the open book; the analysis is already there or on its way. */
  async setTrimSilence(on: boolean): Promise<void> {
    const cur = this.state.current;
    const lib = cur && this.libOf(cur.book);
    if (!cur || !this.engine || !lib) return;
    const settings = { ...cur.settings, trimSilence: on };
    this.set({ current: { ...cur, settings } });
    this.engine.setSilence(on ? cur.silence : null);
    await lib.writeSettings(settings);
  }

  private async persistPosition(): Promise<void> {
    const cur = this.state.current;
    const o = cur && this.openedOf(cur.book);
    if (!cur || !o || !this.engine) return;
    this.lastWrite = Date.now();
    const pos = await o.lib.writePosition(cur.book.book.id, this.engine.positionMs());
    o.positions.set(cur.book.book.id, pos);
    this.set({ positions: { ...this.state.positions, [cur.book.book.id]: pos } });
  }

  private onBookEnded(): void {
    void this.persistPosition();
    this.pausedAt = Date.now();
  }

  private refreshMediaMetadata(): void {
    const cur = this.state.current;
    if (!cur) {
      updateMediaMetadata(null, "", null);
      return;
    }
    const ch = cur.book.chapters[this.state.player.chapterIndex];
    updateMediaMetadata(cur.book, ch?.title ?? "", this.coverUrl(cur.book));
  }

  // Sleep timer ---------------------------------------------------------

  startSleep(mode: sleep.SleepMode): void {
    this.set({ sleep: { state: sleep.start(mode, Date.now()), gain: 1, remainingMs: null } });
    this.startSleepLoop();
  }

  extendSleep(byMs: number): void {
    this.set({ sleep: { ...this.state.sleep, state: sleep.extend(this.state.sleep.state, byMs, Date.now()), gain: 1 } });
    this.engine?.setSleepGain(1);
    this.startSleepLoop();
  }

  cancelSleep(): void {
    this.stopSleepLoop();
    this.set({ sleep: { state: sleep.cancel(), gain: 1, remainingMs: null } });
    this.engine?.setSleepGain(1);
  }

  private startSleepLoop(): void {
    if (this.sleepTimer !== null) return;
    this.sleepTimer = window.setInterval(() => this.sleepTick(), 250);
  }

  private stopSleepLoop(): void {
    if (this.sleepTimer !== null) window.clearInterval(this.sleepTimer);
    this.sleepTimer = null;
  }

  private sleepTick(): void {
    const cur = this.state.current;
    const st = this.state.sleep.state;
    if (!st.mode) return this.stopSleepLoop();
    const ch = cur?.book.chapters[this.state.player.chapterIndex] ?? null;
    let paused = st;
    if (!this.state.player.playing && st.pausedAt === null) paused = sleep.pause(st, Date.now());
    else if (this.state.player.playing && st.pausedAt !== null) paused = sleep.resume(st, Date.now());
    const [next, out] = sleep.tick(paused, {
      nowMs: Date.now(),
      positionMs: this.state.player.positionMs,
      chapterEndMs: ch ? ch.endMs : null,
      speed: this.state.player.speed,
      playing: this.state.player.playing,
    });
    this.engine?.setSleepGain(out.gain);
    this.set({ sleep: { state: next, gain: out.gain, remainingMs: out.remainingMs } });
    if (out.fire) {
      this.pause();
      this.stopSleepLoop();
      this.set({ sleep: { state: sleep.cancel(), gain: 1, remainingMs: null } });
      this.engine?.setSleepGain(1);
    }
  }

  // Bookmarks -----------------------------------------------------------

  async addBookmark(note: string): Promise<void> {
    const cur = this.state.current;
    const lib = cur && this.libOf(cur.book);
    if (!cur || !lib || !this.engine) return;
    const bm = await lib.addBookmark(cur.book, this.engine.positionMs(), note);
    const bookmarks = [...cur.bookmarks, bm].sort((a, b) => a.offsetMs - b.offsetMs);
    this.set({ current: { ...this.state.current!, bookmarks } });
  }

  /**
   * Hear the thirty seconds before a bookmark, through the one player:
   * seek back, play, and stop at the mark. No second audio element.
   */
  async previewBookmark(bm: Bookmark): Promise<void> {
    const cur = this.state.current;
    if (!cur || !this.engine || cur.book.book.id !== bm.bookId) return;
    if (this.state.previewing === bm.offsetMs) {
      this.pause();
      return;
    }
    const { startMs } = clipRange(bm.offsetMs);
    this.engine.seek(startMs);
    this.engine.setStopAt(bm.offsetMs);
    this.pausedAt = null;
    this.set({ previewing: bm.offsetMs, resumeOffer: null });
    await this.engine.play();
  }

  async removeBookmark(offsetMs: number): Promise<void> {
    const cur = this.state.current;
    const lib = cur && this.libOf(cur.book);
    if (!cur || !lib) return;
    if (this.state.previewing === offsetMs) this.pause();
    await lib.removeBookmark(cur.book.book.id, offsetMs);
    this.set({ current: { ...this.state.current!, bookmarks: cur.bookmarks.filter((b) => b.offsetMs !== offsetMs) } });
  }

  bookmarkClipUrl(bm: Bookmark): string | null {
    const cur = this.state.current;
    const lib = cur && this.libOf(cur.book);
    if (!lib || !bm.clip) return null;
    return this.platform.fileUrl(lib.host.join(lib.root, ".ribbon", "bookmarks", ...bm.clip.split("/")));
  }

  // Chapter corrections -------------------------------------------------

  async correctChapters(corrections: Correction[]): Promise<void> {
    const cur = this.state.current;
    const o = cur && this.openedOf(cur.book);
    if (!cur || !o) return;
    const updated = this.stamp(o, [await o.lib.writeCorrections(cur.book, corrections)])[0]!;
    this.replaceBook(o, updated);
    this.set({ current: { ...cur, book: updated, corrections } });
    this.engine?.setChapters(updated.chapters);
  }

  // Navigation ----------------------------------------------------------

  showLibrary(): void {
    this.set({ pane: "library", playerExpanded: false });
  }

  /** Open the full player over the shelf, optionally straight onto one of its drawers. */
  expandPlayer(drawer: AppState["playerDrawer"] = null): void {
    if (!this.state.current) return;
    this.set({ playerExpanded: true, playerDrawer: drawer });
  }

  collapsePlayer(): void {
    this.set({ playerExpanded: false, playerDrawer: null });
  }

  setPlayerDrawer(drawer: AppState["playerDrawer"]): void {
    this.set({ playerDrawer: drawer });
  }

  showSettings(): void {
    this.set({ pane: "settings" });
  }

  homePath(): Promise<string | null> {
    return this.platform.home ? this.platform.home.path().catch(() => null) : Promise.resolve(null);
  }

  revealHome(): Promise<void> {
    return this.platform.home ? this.platform.home.reveal().catch((e: unknown) => log.warn("could not open the folder:", describe(e))) : Promise.resolve();
  }

  /** Wipe the app's own folder (mirror, sources) and go back to the first screen. */
  async resetHome(): Promise<void> {
    if (!this.platform.home) return;
    if (!(await this.platform.home.reset())) return;
    this.engine?.pause();
    for (const o of this.opened.values()) {
      o.coverJob?.abort();
      o.lookup?.stop();
    }
    this.opened.clear();
    this.jobs.cancelAll();
    this.set({ phase: "pick", sources: [], sourceStatus: {}, books: [], positions: {}, current: null, pane: "library", playerExpanded: false, assetsReady: false, series: {}, problems: [], about: {}, scanning: null });
  }

  // Series ----------------------------------------------------------------

  /**
   * The series on the shelf: what tags and folder numbers suggest,
   * source by source, plus what the records beside the books say. Books
   * numbered straight under a source's folder make a series named after
   * that folder. A series named the same in two sources is one series.
   * A record can add books to a series, or be a series on its own.
   */
  detectedSeries(): SeriesGroup[] {
    const byKey = new Map<string, SeriesGroup>();
    for (const o of this.openedInOrder()) {
      for (const g of detectSeries(
        o.books.map((b) => b.book),
        o.source.name,
      )) {
        const have = byKey.get(g.key);
        if (have) have.bookIds.push(...g.bookIds.filter((id) => !have.bookIds.includes(id)));
        else byKey.set(g.key, { ...g, bookIds: [...g.bookIds] });
      }
    }
    return mergeSeries([...byKey.values()], Object.values(this.state.series), new Set(this.state.books.map((b) => b.book.id)));
  }

  openNewSeries(): void {
    this.set({ seriesNew: true, seriesSetup: null });
  }

  closeNewSeries(): void {
    this.set({ seriesNew: false });
  }

  /** Make a series by hand: these books, in this order. Its record goes beside them. */
  async createSeries(name: string, bookIds: readonly string[]): Promise<void> {
    const onShelf = new Set(this.state.books.map((b) => b.book.id));
    const ids = bookIds.filter((id) => onShelf.has(id));
    if (!name.trim() || ids.length === 0) return;
    const key = uniqueKey(name, [...Object.keys(this.state.series), ...this.detectedSeries().map((g) => g.key)]);
    const record = newSeriesRecord(key, name, ids);
    log.info("new series:", record.name, ids.length, "books");
    this.set({ series: { ...this.state.series, [key]: record }, seriesNew: false });
    await this.writeSeriesRecord(record);
  }

  /** Forget a series: its record goes, its books stay. Detection may still find it. */
  async deleteSeries(key: string): Promise<void> {
    const { [key]: gone, ...series } = this.state.series;
    if (!gone) return;
    log.info("delete series:", gone.name);
    this.seriesOffered.add(key);
    this.set({ series, seriesSetup: this.state.seriesSetup?.key === key ? null : this.state.seriesSetup });
    for (const o of this.openedInOrder()) {
      o.seriesKeys.delete(key);
      try {
        await o.lib.deleteSeries(key);
      } catch (e) {
        log.warn("could not delete series:", o.source.name, describe(e));
      }
    }
  }

  /** Write a record beside the books in every source that holds one of its members. */
  private async writeSeriesRecord(record: SeriesRecord): Promise<void> {
    const members = new Set(record.choices.map((c) => c.bookId));
    const holders = this.openedInOrder().filter((o) => o.books.some((b) => members.has(b.book.id)));
    for (const o of holders) {
      o.seriesKeys.add(record.key);
      try {
        await o.lib.writeSeries(record);
      } catch (e) {
        log.warn("could not save series:", o.source.name, describe(e));
      }
    }
  }

  /** After a scan: open the setup for the first series with no record, once per session. */
  private offerSeriesSetup(): void {
    if (this.state.seriesSetup) return;
    if (this.openedInOrder().some((o) => o.scanning)) return;
    for (const g of this.detectedSeries()) {
      if (this.state.series[g.key] || this.seriesOffered.has(g.key)) continue;
      this.seriesOffered.add(g.key);
      log.info("offering series setup:", g.name, g.bookIds.length, "books");
      this.set({ seriesSetup: g });
      return;
    }
  }

  // Descriptions --------------------------------------------------------

  /** Turn the online lookup on or off; on starts it for the books that lack an answer. */
  async setLookup(enabled: boolean): Promise<void> {
    this.appSettings = { ...this.appSettings, lookupDescriptions: enabled };
    this.set({ lookup: { ...this.state.lookup, enabled } });
    await this.platform.appSettings?.write(this.appSettings).catch((e: unknown) => log.warn("could not save settings:", describe(e)));
    if (enabled) this.maybeLookup();
    else {
      for (const o of this.opened.values()) o.lookup?.stop();
      this.set({ lookup: { ...this.state.lookup, running: false } });
    }
  }

  /**
   * Ask about the books with no answer yet, one at a time, source after
   * source, after every shelf is settled. One conversation with the
   * database at a time, however many folders there are.
   */
  private maybeLookup(): void {
    if (!this.state.lookup.enabled || this.lookupRun) return;
    if (this.state.books.some((b) => b.pending) || this.openedInOrder().some((o) => o.scanning)) return;
    this.lookupRun = (async () => {
      for (const o of this.openedInOrder()) {
        if (this.opened.get(o.source.id) !== o || !this.state.lookup.enabled) continue;
        o.lookup ??= new AboutLookup(o.lib);
        await o.lookup.run(o.books, new Map(Object.entries(this.state.about)), (about, status) => {
          if (this.opened.get(o.source.id) !== o) return;
          this.set({
            about: about ? { ...this.state.about, [about.bookId]: about } : this.state.about,
            lookup: { ...this.state.lookup, ...status },
          });
        });
      }
    })().finally(() => {
      this.lookupRun = null;
    });
  }

  /** The description for a book, or null. */
  aboutFor(book: ScannedBook): BookAbout | null {
    const a = this.state.about[book.book.id];
    return a && a.source === "openlibrary" ? a : null;
  }

  openSeriesSetup(key: string): void {
    const g = this.detectedSeries().find((x) => x.key === key);
    if (g) this.set({ seriesSetup: g });
  }

  closeSeriesSetup(): void {
    this.set({ seriesSetup: null });
  }

  /** Save the decisions beside the books, in every source that holds one, and apply them to the shelf. */
  async saveSeries(choices: SeriesChoice[]): Promise<void> {
    const g = this.state.seriesSetup;
    if (!g) return;
    const record: SeriesRecord = { key: g.key, name: g.name, choices: normalizeChoices(choices), decidedAt: new Date().toISOString() };
    this.set({ series: { ...this.state.series, [g.key]: record }, seriesSetup: null });
    await this.writeSeriesRecord(record);
  }

  /** Skip: everything stays on the shelf in detected order, and the question is not asked again. */
  skipSeriesSetup(): Promise<void> {
    const g = this.state.seriesSetup;
    return g ? this.saveSeries(defaultChoices(g)) : Promise.resolve();
  }

  /** Read every file under a folder of one source again, whether or not it changed. */
  async rescanFolder(sourceId: string, folder: string): Promise<void> {
    const o = this.opened.get(sourceId);
    if (o) await this.rescanSource(o, true, [folder]);
  }

  showPlayer(): void {
    this.expandPlayer();
  }

  clearError(): void {
    this.set({ error: null });
  }

  destroy(): void {
    for (const o of this.opened.values()) {
      o.lookup?.stop();
      o.coverJob?.abort();
    }
    this.stopSleepLoop();
    this.uninstallMedia?.();
    this.engine?.destroy();
    this.jobs.cancelAll();
    this.chapterProbe?.abort();
  }
}
