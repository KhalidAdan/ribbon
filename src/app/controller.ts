import type { Host, ScanProgress } from "../host/host";
import { extractMissingCovers, type ScannedBook } from "../core/scan/scan";
import type { Bookmark, BookSettings, Position, SilenceRange } from "../core/types";
import type { Problem } from "../core/problems";
import { defaultChoices, detectSeries, mergeSeries, newSeriesRecord, normalizeChoices, uniqueKey, type SeriesChoice, type SeriesGroup, type SeriesRecord } from "../core/series";
import type { BookAbout } from "../core/about";
import { sameRoot, sourceFrom, type Source, type SourceEntry } from "../core/sources";
import { AboutLookup, type LookupStatus } from "./about";
import { ChapterNamer, wantsNames, type NameRecord } from "./chapternames";
import { PlayerEngine, type EngineState } from "../player/engine";
import { LibraryService } from "./library";
import { PositionKeeper, type KeeperStatus } from "./positions";
import { applyEdits, diffEdits, type BookEdits, type EditField } from "../core/edits";
import { DEFAULT_VIEW, parseView, type LibraryView } from "../core/view";
import { claimsFor, mergeById, type LogRecord, type ReadRecord, type SessionRecord } from "../core/poslog";
import { finishedByRead, openRead } from "../core/stats";
import { chaptersUrl, parseChapters, type LookedUp, type Region } from "../core/audnexus";
import { JobQueue, type JobStatus } from "./jobs";
import { installMediaSession, updateMediaMetadata, updateMediaPlayback } from "./media-session";
import { resumePosition, rewindFor } from "../core/resume";
import { snapSpeed } from "../core/speed";
import { defaultSettings } from "../core/settings";
import { bookmarksOf, clipRange, markFields, markId, type MarkFields } from "../core/bookmarks";
import { chapterAt } from "../core/scan/chapters";
import { partAt } from "../core/scan/parts";
import * as sleep from "../core/sleep";
import type { Correction } from "../core/scan/chapters";
import { log } from "./log";
import { openEbook, readerOnly, type Ebook } from "../core/ebook";
import type { Why } from "../core/poslog";
import type { TextPlace } from "../core/reading/place";
import { parseReading, type ReadingSettings } from "../core/reading/typography";
import { openingPlace, parseKeptPlaces, ReadingKeeper, type KeptPlace, type ReadingState } from "./reading";
import { alignBook, globalOffset, msToText, placeAtGlobal, textToMs, type Alignment, type PairingFix } from "../core/reading/align";
import { generatedTitles } from "../core/chapternames";
import { locate as locate_ } from "../core/timeline";
import { locate, wordIndex, type Anchor, type WordAt } from "../core/reading/anchors";

/** How much of each chapter's start is heard: a heading and a sentence or two. */
const HEAR_SECONDS = 8;
/** A pairing this sure of every pair is not worth hearing. */
const DOUBT = 0.6;
/** Checkpoints inside chapters this far apart. */
const CHECK_MS = 90_000;
/** No checkpoint this close to a chapter's end: its next start is one. */
const CHECK_END_MS = 20_000;
/** A place heard this close to another needs no hearing. */
const HEARD_NEAR_MS = 20_000;
/** Heard words are looked for this far either side of where the pairing puts them. */
const SEARCH_MS = 4 * 60_000;
/** A clip heard this fast (a GPU) is cheap enough to hear the whole book. */
const FAST_CLIP_MS = 1_200;
/** Most places heard in one go. */
const MAX_HEARD = 800;
/** "Listen from here" and "Go to the narrator" hear the place first unless a checkpoint is this close. */
const PINPOINT_MS = 45_000;

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
  /** Ask for one file, of the given kinds. Hosts without a file dialog leave it out. */
  pickFile?: (title: string, filters: { name: string; extensions: string[] }[]) => Promise<string | null>;
  /**
   * Run `flush` before the window closes, and wait for it. Returns an
   * unsubscribe. Hosts without a window of their own leave it out.
   */
  onWindowClose?: (flush: () => Promise<void>) => () => void;
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
  pane: "library" | "settings" | "reader" | "stats";
  /** The book the reader page shows. */
  readerBookId: string | null;
  /** The full player is open over everything. */
  playerExpanded: boolean;
  /** Which drawer the full player shows, if any. */
  playerDrawer: "chapters" | "bookmarks" | "speed" | null;
  /** Where the open book's place is kept right now, for the player's footer. */
  placeKept: KeeperStatus | null;
  /** The book whose details are open for editing, or null. */
  editBook: string | null;
  /** How the shelf is filtered and sorted; remembered between sessions. */
  view: LibraryView;
  /** Listen-throughs and listening sessions from every device's log. */
  history: { reads: ReadRecord[]; sessions: SessionRecord[]; recording: boolean };
  /** Books whose chapter names came from Audible's data, by book id, with the ASIN. */
  namedChapters: Record<string, string>;
  /** The book open in the reader, over everything but the player bar. */
  reading: ReadingState | null;
  /** How the reader sets text on this machine. */
  readingSettings: ReadingSettings;
  /** The whisper.cpp model this machine hears narrators with (#65), and a download while it runs. */
  speech: { model: string | null; downloading: { done: number; total: number } | null };
}

/** The same history record, written here and read back from the log. */
function sameRecord(a: LogRecord, b: LogRecord): boolean {
  if (a.k !== b.k || a.t !== b.t) return false;
  if (a.k === "read" && b.k === "read") return a.id === b.id && a.finished === b.finished && a.started === b.started;
  if (a.k === "del" && b.k === "del") return a.of === b.of;
  if (a.k === "session" && b.k === "session") return a.start === b.start;
  if (a.k === "mark" && b.k === "mark") return a.id === b.id && a.modified === b.modified && a.body === b.body;
  return false;
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
/** How often a playing book hands its place to the keeper, which throttles the writes. */
const POSITION_WRITE_INTERVAL_MS = 1_000;

/** One source, open: its records service and everything the shelf needs from it. */
interface Opened {
  source: Source;
  lib: LibraryService;
  books: ScannedBook[];
  /** Every position of this source's books, kept on this machine first and beside the books after. */
  keeper: PositionKeeper;
  /** Hand edits to books' details, by book id. */
  edits: Map<string, BookEdits>;
  /** The position log's records other than places: listen-throughs, sessions, marks, deletions. */
  log: LogRecord[];
  /** What came of asking about each book's chapter names; read once, on the first ask. */
  names: Map<string, NameRecord> | null;
  /** Records written here that a read of the log has not shown yet. */
  pendingLog: LogRecord[];
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
  /** Bumped by every openBook, so a slow open that lost the race stops. */
  private openSeq = 0;
  /** Sequence for history shown before the log is read back; only ever increases. */
  private localSeq = 0;
  /** Rows of each book's bookmarks CSV, by book id, once read. */
  private bookmarkRows = new Map<string, Bookmark[]>();
  /** The stretch of playing going on now, for the session record. */
  private listening: { bookId: string; start: number; fromMs: number; speed: number } | null = null;
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
  /** This installation in the position log: a random id, made once and kept in the app's settings. */
  private deviceId: string = globalThis.crypto.randomUUID();

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
        reconnecting: false,
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
      placeKept: null,
      editBook: null,
      view: DEFAULT_VIEW,
      history: { reads: [], sessions: [], recording: true },
      namedChapters: {},
      reading: null,
      readingSettings: parseReading(undefined),
      speech: { model: null, downloading: null },
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

  /** Mark books with their source and lay that source's hand edits over them. */
  private stamp(o: Opened, books: readonly ScannedBook[]): ScannedBook[] {
    return books.map((b) => {
      const { original, edits: _was, ...rest } = b;
      const base = original ?? b.book;
      const e = o.edits.get(base.id);
      const sourced = { ...rest, source: o.source.id };
      if (!e) return original || b.source !== o.source.id ? { ...sourced, book: base } : b;
      return { ...sourced, book: applyEdits(base, e.values), original: base, edits: e.values };
    });
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
        positions[id] = o.keeper.get(id) ?? this.state.positions[id] ?? null;
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
      this.set({ lookup: { ...this.state.lookup, enabled: this.appSettings.lookupDescriptions === true }, view: parseView(this.appSettings.libraryView), history: { ...this.state.history, recording: this.appSettings.recordSessions !== false }, readingSettings: parseReading(this.appSettings.reading), speech: { model: typeof this.appSettings.speechModel === "string" && this.appSettings.speechModel ? this.appSettings.speechModel : null, downloading: null } });
      if (typeof this.appSettings.deviceId === "string" && this.appSettings.deviceId) this.deviceId = this.appSettings.deviceId;
      else {
        this.appSettings = { ...this.appSettings, deviceId: this.deviceId };
        await this.platform.appSettings.write(this.appSettings).catch((e: unknown) => log.warn("could not save settings:", describe(e)));
      }
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
    lib.setDevice(this.deviceId);
    const o: Opened = {
      source,
      lib,
      books: [],
      edits: new Map(),
      log: [],
      pendingLog: [],
      names: null,
      keeper: new PositionKeeper({
        local: lib.keepsLocalPositions ? (all) => lib.writeLocalPositions(all) : undefined,
        share: (p) => lib.writePositionRecord(p),
        log: (m) => log.warn(source.name + ":", m),
        onStatus: (status) => {
          if (this.state.current?.book.source === source.id) this.set({ placeKept: status });
        },
      }),
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
    // The position log describes each book by its claims and its files.
    lib.bookInfo = (id) => o.books.find((b) => b.book.id === id);
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
        o.keeper.absorb(extras.positions.values(), { fromLocal: true });
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
        const [positions, problems, series, about] = await Promise.all([
          lib.readPositionLog().catch((e: unknown) => {
            log.warn("could not read positions beside the books; using the ones kept here:", describe(e));
            return null;
          }),
          lib.readProblems().catch(() => []),
          lib.readSeries().catch(() => new Map<string, SeriesRecord>()),
          lib.readAbout().catch(() => new Map<string, BookAbout>()),
        ]);
        if (!alive()) return;
        if (positions) {
          this.takeSharePositions(o, positions.places);
          this.takeLog(o, positions.records);
        }
        await this.takeEdits(o);
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

  /**
   * Positions read beside the books: newest wins against what is kept
   * here, and anything newer here goes back to the share. A read that
   * started before a write landed can never move a book backwards.
   */
  private takeSharePositions(o: Opened, share: Map<string, Position>): void {
    if (this.opened.get(o.source.id) !== o) return;
    const changed = o.keeper.absorb(share.values());
    o.keeper.reconcile(share);
    // The open book, paused here, was listened to somewhere else since:
    // move to where that left off, so pressing play here continues it
    // instead of overwriting it with the older place.
    const cur = this.state.current;
    const engine = this.engine;
    if (cur && engine && changed.includes(cur.book.book.id) && !this.state.player.playing && engine.current.bookId === cur.book.book.id) {
      const p = o.keeper.get(cur.book.book.id)!;
      log.info(`a newer position for the open book came from ${p.device || "another device"}: ${p.offsetMs} ms`);
      engine.seek(Math.min(p.offsetMs, cur.book.book.durationMs));
      this.pausedAt = Date.parse(p.updatedAt);
    }
    if (changed.length > 0) this.publishBooks();
  }

  /** Read a source's hand edits and lay them over its books. */
  private async takeEdits(o: Opened): Promise<void> {
    const edits = await o.lib.readAllEdits().catch((e: unknown) => {
      log.warn("could not read the edits beside the books:", describe(e));
      return null;
    });
    if (!edits || this.opened.get(o.source.id) !== o) return;
    o.edits = edits;
    o.books = this.stamp(o, o.books);
    this.publishBooks();
  }

  /**
   * Save what the edit form says about a book. Only fields that differ
   * from the files are kept; a field set back to the files' value stops
   * being an edit. Nothing in the audio files changes.
   */
  async saveEdits(bookId: string, form: Partial<Record<EditField, string>>): Promise<void> {
    const b = this.state.books.find((x) => x.book.id === bookId);
    const o = b && this.openedOf(b);
    if (!b || !o) return;
    const previous = o.edits.get(bookId)?.values ?? {};
    const values = diffEdits(b.original ?? b.book, form, previous);
    const edits: BookEdits = { bookId, values, updatedAt: new Date().toISOString() };
    await o.lib.writeEdits(edits);
    if (Object.keys(values).length === 0) o.edits.delete(bookId);
    else o.edits.set(bookId, edits);
    o.books = this.stamp(o, o.books);
    this.publishBooks();
    if (values.cover !== previous.cover) void this.mirrorCoversFor(o);
    log.info("edited", b.book.title, Object.keys(values).join(", ") || "(back to the files)");
  }

  /** Filter and sort the shelf, and remember it for next time. */
  setView(view: LibraryView): void {
    this.set({ view });
    this.appSettings = { ...this.appSettings, libraryView: view };
    void this.platform.appSettings?.write(this.appSettings).catch((e: unknown) => log.warn("could not save settings:", describe(e)));
  }

  openEditBook(bookId: string): void {
    this.set({ editBook: bookId });
  }

  closeEditBook(): void {
    this.set({ editBook: null });
  }

  /** Use an image the listener chose as the book's cover; it is copied beside the books. */
  async setCover(bookId: string, bytes: Uint8Array, ext: string): Promise<void> {
    const b = this.state.books.find((x) => x.book.id === bookId);
    const o = b && this.openedOf(b);
    if (!b || !o) return;
    const path = await o.lib.writeEditedCover(bookId, bytes, ext);
    await this.saveEdits(bookId, { cover: path });
  }

  /** Take back hand edits: one field, or all of them. */
  async resetEdits(bookId: string, field?: EditField): Promise<void> {
    const b = this.state.books.find((x) => x.book.id === bookId);
    const o = b && this.openedOf(b);
    if (!b || !o) return;
    const values = { ...(o.edits.get(bookId)?.values ?? {}) };
    if (field) delete values[field];
    const edits: BookEdits = { bookId, values: field ? values : {}, updatedAt: new Date().toISOString() };
    await o.lib.writeEdits(edits);
    if (Object.keys(edits.values).length === 0) o.edits.delete(bookId);
    else o.edits.set(bookId, edits);
    o.books = this.stamp(o, o.books);
    this.publishBooks();
    if (!field || field === "cover") void this.mirrorCoversFor(o);
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
      .readPositionLog()
      .then((l) => {
        this.takeSharePositions(o, l.places);
        this.takeLog(o, l.records);
      })
      .catch((e: unknown) => log.warn("could not read positions beside the books:", describe(e)));
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
      const edits = await lib.readAllEdits().catch(() => null);
      if (!alive()) return;
      if (edits) o.edits = edits;
      o.books = this.stamp(o, books);
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
        await this.persistPosition("pause");
      }
      this.chapterProbe?.abort();
      this.engine?.pause();
      this.set({ current: null, playerExpanded: false, playerDrawer: null, resumeOffer: null, previewing: null });
    }
    this.jobs.cancelWhere((b) => b.source === id);
    if (o) {
      await o.keeper.close().catch(() => undefined);
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
    if (player.playing && !prev.playing && player.bookId) this.beginListening(player.bookId, player.positionMs, player.speed);
    if (this.listening && (!player.playing || player.bookId !== this.listening.bookId)) this.endListening(prev.positionMs);
    // Stopped for any reason (the listener, the system, the end of a
    // preview, a file that failed): keep the place now.
    if (prev.playing && !player.playing && player.bookId === prev.bookId) {
      if (this.state.previewing !== null) this.set({ previewing: null });
      if (!player.reconnecting) this.pausedAt = Date.now();
      void this.persistPosition("pause");
    }
    if (player.playing && Date.now() - this.lastWrite > POSITION_WRITE_INTERVAL_MS) void this.persistPosition("periodic");
    if (player.chapterIndex !== prev.chapterIndex || player.bookId !== prev.bookId) this.refreshMediaMetadata();
    if (player.playing !== prev.playing || player.reconnecting !== prev.reconnecting || Math.abs(player.positionMs - prev.positionMs) > 900) {
      updateMediaPlayback(player.playing || player.reconnecting, player.positionMs, player.durationMs, player.speed);
    }
  }

  /**
   * Open a book. Playback is ready as soon as the cached records are
   * read; embedded chapter markers are probed behind it the first time
   * and swapped in when they arrive.
   */
  async openBook(book: ScannedBook, opts: { expand?: boolean; autoplay?: boolean } = {}): Promise<void> {
    const lib = this.libOf(book);
    // A book that is only its EPUB has nothing to play.
    if (!lib || readerOnly(book.book)) return;
    const engine = this.ensureEngine();
    if (!engine) return;
    const expand = opts.expand ?? true;
    const seq = ++this.openSeq;
    if (this.state.current?.book.book.id === book.book.id && this.engine?.current.bookId === book.book.id) {
      if (expand) this.expandPlayer();
      if (opts.autoplay && !this.state.player.playing) await this.play();
      return;
    }
    // Keep the place in the book being left before anything else happens.
    if (this.state.player.playing) engine.pause();
    await this.persistPosition("pause");
    if (seq !== this.openSeq) return;
    this.chapterProbe?.abort();
    const id = book.book.id;
    const quiet = <T>(what: string, p: Promise<T>, fallback: T): Promise<T> =>
      p.catch((e: unknown) => {
        log.warn(`could not read ${what} for`, book.book.title, describe(e));
        return fallback;
      });
    const [settings, bookmarks, loudness, silence, corrections] = await Promise.all([
      quiet("settings", lib.readSettings(id), defaultSettings(id)),
      quiet("bookmarks", this.loadBookmarks(id), [] as Bookmark[]),
      quiet("loudness", lib.readLoudness(id), null),
      quiet("silence", lib.readSilence(id), null),
      quiet("corrections", lib.readCorrections(id), [] as Correction[]),
    ]);
    if (seq !== this.openSeq) return;
    const position = this.openedOf(book)?.keeper.get(id) ?? this.state.positions[id] ?? (await quiet("the position", lib.readPosition(id), null));
    if (seq !== this.openSeq) return;
    const current: CurrentBook = { book, settings, bookmarks, loudnessGainDb: loudness?.gainDb ?? null, silence, corrections };
    this.set({ current, playerExpanded: expand, playerDrawer: null, resumeOffer: null, placeKept: this.openedOf(book)?.keeper.status() ?? null });
    // Read further than listened: start where the reading stopped.
    const ahead = this.readAhead(id, position ? Date.parse(position.updatedAt) : null);
    if (ahead !== null) log.info(`starting ${book.book.title} where it was read, at ${Math.round(ahead / 1000)} s`);
    const startMs = Math.min(ahead ?? position?.offsetMs ?? 0, book.book.durationMs);
    await engine.load({ id: book.book.id, files: book.files, chapters: book.chapters, silence: settings.trimSilence ? (silence ?? undefined) : undefined }, startMs);
    if (seq !== this.openSeq) return;
    engine.setSpeed(settings.speed);
    engine.setLoudnessGainDb(loudness?.gainDb ?? 0);
    this.pausedAt = ahead !== null ? null : position ? Date.parse(position.updatedAt) : null;
    if (ahead !== null) void this.persistPosition("seek");
    this.refreshMediaMetadata();
    if (!loudness || !silence) this.jobs.enqueue(book, true);
    void this.probeChapters(book).then(() => this.maybeNameChapters(book.book.id));
    if (opts.autoplay) await this.play();
  }

  /** Start or continue a book from its page: the bar appears, the page stays. A book that is only its EPUB opens to read. */
  playBook(book: ScannedBook): Promise<void> {
    if (readerOnly(book.book)) return this.openReading(book.book.id);
    return this.openBook(book, { expand: false, autoplay: true });
  }

  // Reading ------------------------------------------------------------

  private readingKeeper: ReadingKeeper | null = null;
  private settingsTimer: ReturnType<typeof setTimeout> | null = null;
  private settingsWrite: Promise<void> = Promise.resolve();

  /** Write the app's settings soon: a run of changes, like turning pages, makes one write. */
  private saveAppSettingsSoon(delayMs = 500): void {
    if (this.settingsTimer) clearTimeout(this.settingsTimer);
    this.settingsTimer = setTimeout(() => void this.saveAppSettingsNow(), delayMs);
  }

  private saveAppSettingsNow(): Promise<void> {
    if (this.settingsTimer) clearTimeout(this.settingsTimer);
    this.settingsTimer = null;
    const write = this.platform.appSettings?.write;
    if (!write) return Promise.resolve();
    const snapshot = this.appSettings;
    this.settingsWrite = this.settingsWrite.then(() => write(snapshot)).catch((e: unknown) => log.warn("could not save settings:", describe(e)));
    return this.settingsWrite;
  }

  private keptPlaces(): Record<string, KeptPlace> {
    return parseKeptPlaces(this.appSettings.readingPlaces);
  }

  /** How far through a book's text this machine last read, or null when it has not. */
  readingProgress(bookId: string): number | null {
    const kept = this.keptPlaces()[bookId];
    return kept ? (kept.loc.locations?.totalProgression ?? 0) : null;
  }

  /**
   * Open a book's EPUB in the reader, at the newer of this machine's
   * reading place and the log's, or at its start.
   */
  async openReading(bookId: string): Promise<void> {
    const book = this.state.books.find((b) => b.book.id === bookId);
    const o = book && this.openedOf(book);
    if (!book || !o) return;
    if (this.state.reading) await this.closeReading();
    this.set({ reading: { bookId, status: "opening" }, playerExpanded: false });
    const started = performance.now();
    const result = await openEbook(o.lib.host, o.lib.root, book.book);
    if (this.state.reading?.bookId !== bookId) return;
    if (!result.ok) {
      log.warn(`could not open the text of ${book.book.title}: ${result.message}`);
      this.set({ reading: { bookId, status: "failed", message: result.message } });
      return;
    }
    const ebook = result.ebook;
    // The audio's chapters, read from the file if they never were, to pair with the text's.
    const withChapters = await this.chaptersOf(o, book);
    this.readingFixes = await o.lib.readPairing(bookId);
    const heard = await o.lib.readHeard(bookId);
    this.readingHeard = heard.heard;
    this.readingAnchors = heard.anchors;
    // A book that is only its EPUB has no audio to pair the text with.
    const alignment = readerOnly(book.book) ? undefined : alignBook(ebook, withChapters.chapters, withChapters.book.durationMs, { generated: generatedTitles(withChapters.chapters), fixes: this.readingFixes, heard: this.readingHeard, anchors: this.anchorList() });
    if (alignment) log.info(`paired the text of ${book.book.title} with its audio by ${alignment.how}: ${alignment.pairs.length} chapters`);
    const shared = await o.lib
      .readTextPlaces()
      .then((m) => {
        const r = m.get(bookId);
        return r ? { loc: r.loc, t: r.t } : undefined;
      })
      .catch(() => undefined);
    if (this.state.reading?.bookId !== bookId) return;
    const place = openingPlace(ebook, this.keptPlaces()[bookId], shared, alignment && this.narratorPlace(bookId, ebook, alignment));
    this.readingKeeper = new ReadingKeeper(ebook, place, {
      keepLocal: (kept) => {
        this.appSettings = { ...this.appSettings, readingPlaces: { ...this.keptPlaces(), [bookId]: kept } };
        this.saveAppSettingsSoon();
      },
      share: (loc, why, at, ms) => o.lib.writeTextPlace(bookId, ebook.meta.identifiers, loc, why, at, ms),
      // The pairing can be fixed while the book is open: always the latest.
      toMs: (p) => {
        const a = this.state.reading?.alignment ?? alignment;
        return a ? textToMs(a, globalOffset(ebook, p)) : null;
      },
    });
    log.info(`opened the text of ${book.book.title} in ${Math.round(performance.now() - started)} ms: ${ebook.sections.length} sections`);
    this.set({ reading: { bookId, status: "ready", ebook, place, ...(alignment ? { alignment } : {}) } });
    this.readingCtx = { o, book: withChapters, ebook };
    void this.hearPlaces();
  }

  /** What the narrator was heard saying in the open book, by time, and where each was found in the text. */
  private readingHeard = new Map<number, string>();
  private readingAnchors = new Map<number, number>();
  private readingIndex: { ebook: Ebook; index: WordAt[] } | null = null;
  private readingCtx: { o: Opened; book: ScannedBook; ebook: Ebook } | null = null;
  private hearing = false;
  /** How long a clip took to hear, last measured: a fast machine hears the whole book, a slow one only around the reader. */
  private msPerClip: number | null = null;

  private anchorList(): Anchor[] {
    return [...this.readingAnchors].map(([ms, chars]) => ({ ms, chars }));
  }

  /** The open book paired again with everything heard and fixed so far. */
  private realign(ebook: Ebook, book: ScannedBook): Alignment {
    const latest = this.state.books.find((b) => b.book.id === book.book.id) ?? book;
    return alignBook(ebook, latest.chapters, latest.book.durationMs, { generated: generatedTitles(latest.chapters), fixes: this.readingFixes, heard: this.readingHeard, anchors: this.anchorList() });
  }

  /** Find heard words in the text near where the pairing puts them, and keep them as a checkpoint when found. */
  private anchorHeard(ebook: Ebook, alignment: Alignment, ms: number, words: string): boolean {
    const pair = alignment.pairs.find((p) => ms >= p.audio.startMs && ms < p.audio.endMs);
    if (!pair || alignment.how !== "chapter") return false;
    if (this.readingIndex?.ebook !== ebook) this.readingIndex = { ebook, index: wordIndex(ebook) };
    const pace = (pair.text.end - pair.text.start) / Math.max(1, pair.audio.endMs - pair.audio.startMs);
    const found = locate(this.readingIndex.index, words, msToText(alignment, ms), Math.max(1500, SEARCH_MS * pace));
    if (found) this.readingAnchors.set(ms, found.chars);
    return !!found;
  }

  /**
   * Hear the narrator where it helps, a few clips at a time in the
   * background, pairing again after each few (#65, #55):
   * - first where the pairing has doubts: the starts of the doubtful
   *   pairs' audio chapters, or every chapter when nothing pairs;
   * - then checkpoints inside chapters, every minute and a half, nearest
   *   the reader first: the whole book on a machine that hears a clip
   *   quickly (a GPU), the chapters around the reader on one that does not.
   * Kept beside the book after every few, so each place is heard once.
   */
  private async hearPlaces(): Promise<void> {
    const ctx = this.readingCtx;
    const model = this.state.speech.model;
    if (!ctx || !model || this.hearing) return;
    const hear = ctx.o.lib.host.speechOpenings;
    if (!hear) return;
    const { o, book, ebook } = ctx;
    const bookId = book.book.id;
    const durations = book.files.map((f) => f.durationMs);
    const language = (ebook.meta.language || book.book.language || "").slice(0, 2).toLowerCase() || null;
    const still = () => this.readingCtx === ctx && this.state.reading?.bookId === bookId && this.state.reading.status === "ready";
    const heardNear = (ms: number) => [...this.readingHeard.keys()].some((h) => Math.abs(h - ms) < HEARD_NEAR_MS);
    const doubts = (): number[] => {
      const a = this.state.reading?.alignment;
      const latest = this.state.books.find((b) => b.book.id === bookId) ?? book;
      // A machine that hears a clip quickly (a GPU) hears every chapter's opening: a few seconds for the surety.
      const fast = this.msPerClip !== null && this.msPerClip < FAST_CLIP_MS;
      const starts = !a || a.how === "proportion" || fast ? latest.chapters.map((c) => c.startMs) : a.pairs.filter((p) => p.confidence < DOUBT && !p.fixed).map((p) => p.audio.startMs);
      return [...new Set(starts)].filter((ms) => !this.readingHeard.has(ms)).sort((x, y) => x - y);
    };
    const checkpoints = (): number[] => {
      const a = this.state.reading?.alignment;
      const place = this.state.reading?.place;
      if (!a || a.how !== "chapter" || !place) return [];
      const here = globalOffset(ebook, place);
      const readerMs = textToMs(a, here);
      let at = a.pairs.findIndex((p) => here >= p.text.start && here < p.text.end);
      if (at < 0) at = Math.max(0, a.pairs.findIndex((p) => here < p.text.start));
      const fast = this.msPerClip !== null && this.msPerClip < FAST_CLIP_MS;
      const order = a.pairs.map((_, i) => i).filter((i) => fast || Math.abs(i - at) <= 1).sort((x, y) => Math.abs(x - at) - Math.abs(y - at) || x - y);
      const out: number[] = [];
      for (const i of order) {
        const p = a.pairs[i]!;
        const inPair: number[] = [];
        for (let ms = p.audio.startMs + CHECK_MS; ms < p.audio.endMs - CHECK_END_MS; ms += CHECK_MS) if (!heardNear(ms)) inPair.push(ms);
        // In the reader's own chapter, nearest the reader first.
        if (i === at) inPair.sort((x, y) => Math.abs(x - readerMs) - Math.abs(y - readerMs));
        out.push(...inPair);
      }
      return out;
    };
    if (doubts().length === 0 && checkpoints().length === 0) return;
    this.hearing = true;
    const started = performance.now();
    let done = 0;
    let found = 0;
    try {
      while (still() && done < MAX_HEARD) {
        let todo = doubts();
        const what: "openings" | "checkpoints" = todo.length > 0 ? "openings" : "checkpoints";
        if (what === "checkpoints") todo = checkpoints();
        if (todo.length === 0) break;
        const batch = todo.slice(0, what === "openings" ? 4 : 6);
        const clips = batch.map((ms) => {
          const at = locate_(durations, ms);
          return { path: o.lib.absPath(book.files[at.fileIndex]!.path), startMs: Math.round(at.fileOffsetMs) };
        });
        this.set({ reading: { ...this.state.reading!, listening: { done, total: done + todo.length, what } } });
        const t0 = performance.now();
        const words = await hear.call(o.lib.host, model, clips, HEAR_SECONDS, language);
        this.msPerClip = (performance.now() - t0) / batch.length;
        const before = this.state.reading?.alignment;
        batch.forEach((ms, i) => {
          const w = (words[i] ?? "").trim();
          this.readingHeard.set(ms, w);
          if (what === "checkpoints" && before && this.anchorHeard(ebook, before, ms, w)) found++;
        });
        done += batch.length;
        await o.lib.writeHeard(bookId, this.readingHeard, this.readingAnchors).catch((e: unknown) => log.warn("could not keep what was heard:", describe(e)));
        if (!still()) break;
        this.set({ reading: { ...this.state.reading!, alignment: this.realign(ebook, book) } });
      }
      log.info(`heard ${done} places in ${book.book.title} (${found} found in the text) in ${Math.round((performance.now() - started) / 1000)} s, ${Math.round(this.msPerClip ?? 0)} ms a clip`);
    } catch (e) {
      log.warn("could not hear the narrator:", describe(e));
    } finally {
      this.hearing = false;
      const r = this.state.reading;
      if (r?.bookId === bookId && r.listening) {
        const { listening: _, ...rest } = r;
        this.set({ reading: rest });
      }
    }
  }

  /**
   * Make sure the pairing is exact near a moment of the recording: when no
   * checkpoint is within PINPOINT_MS of it, hear it now and find it in the
   * text. True when the pairing changed.
   */
  private async pinpoint(ms: number): Promise<boolean> {
    const ctx = this.readingCtx;
    const model = this.state.speech.model;
    const hear = ctx?.o.lib.host.speechOpenings;
    const r = this.state.reading;
    if (!ctx || !model || !hear || !r?.alignment || r.alignment.how !== "chapter") return false;
    if ([...this.readingAnchors.keys()].some((a) => Math.abs(a - ms) < PINPOINT_MS)) return false;
    const { o, book, ebook } = ctx;
    const at = locate_(book.files.map((f) => f.durationMs), ms);
    this.set({ reading: { ...r, finding: true } });
    try {
      const language = (ebook.meta.language || book.book.language || "").slice(0, 2).toLowerCase() || null;
      const [w] = await hear.call(o.lib.host, model, [{ path: o.lib.absPath(book.files[at.fileIndex]!.path), startMs: Math.round(at.fileOffsetMs) }], HEAR_SECONDS, language);
      const words = (w ?? "").trim();
      this.readingHeard.set(ms, words);
      const found = this.anchorHeard(ebook, r.alignment, ms, words);
      void o.lib.writeHeard(book.book.id, this.readingHeard, this.readingAnchors).catch(() => undefined);
      if (found && this.state.reading?.bookId === book.book.id) this.set({ reading: { ...this.state.reading, alignment: this.realign(ebook, book) } });
      return found;
    } catch (e) {
      log.warn("could not pinpoint the place:", describe(e));
      return false;
    } finally {
      const now = this.state.reading;
      if (now?.finding) {
        const { finding: _, ...rest } = now;
        this.set({ reading: rest });
      }
    }
  }

  /** Choose a whisper.cpp model file already on this machine. */
  async chooseSpeechModel(): Promise<void> {
    const path = await this.platform.pickFile?.("Choose a whisper.cpp model", [{ name: "Whisper model", extensions: ["bin"] }]);
    if (!path) return;
    const ok = (await this.platform.host.speechModelOk?.(path).catch(() => false)) ?? true;
    if (!ok) {
      this.set({ error: "That file is not a whisper.cpp model. Models are named like ggml-base.bin." });
      return;
    }
    this.setSpeechModel(path);
  }

  /** Download Ribbon's speech model (whisper base, about 57 MB) into the Ribbon folder. */
  async downloadSpeechModel(): Promise<void> {
    const download = this.platform.host.downloadSpeechModel;
    if (!download || this.state.speech.downloading) return;
    this.set({ speech: { ...this.state.speech, downloading: { done: 0, total: 0 } } });
    try {
      const path = await download.call(this.platform.host, (done, total) => this.set({ speech: { ...this.state.speech, downloading: { done, total } } }));
      this.set({ speech: { ...this.state.speech, downloading: null } });
      this.setSpeechModel(path);
    } catch (e) {
      this.set({ speech: { ...this.state.speech, downloading: null }, error: `The speech model could not be downloaded: ${describe(e)}` });
    }
  }

  setSpeechModel(path: string | null): void {
    this.appSettings = { ...this.appSettings, speechModel: path ?? "" };
    this.set({ speech: { ...this.state.speech, model: path } });
    this.saveAppSettingsSoon(0);
  }

  private readingFixes: PairingFix[] = [];

  /** The open book's pairing, as fixed by hand. */
  pairingFixes(): readonly PairingFix[] {
    return this.readingFixes;
  }

  /**
   * In the reader: pair a contents entry with an audio chapter by hand
   * (its start), say it is not narrated (null), or give it back to the
   * automatic pairing ("auto"). Kept beside the book; the rest re-pairs
   * around it.
   */
  async fixPairing(textRef: string, choice: number | null | "auto"): Promise<void> {
    const r = this.state.reading;
    const book = r && this.state.books.find((b) => b.book.id === r.bookId);
    const o = book && this.openedOf(book);
    if (!r?.ebook || !book || !o) return;
    const fixes = this.readingFixes.filter((f) => f.text !== textRef);
    if (choice !== "auto") fixes.push({ text: textRef, audioMs: choice });
    this.readingFixes = fixes;
    const alignment = alignBook(r.ebook, book.chapters, book.book.durationMs, { generated: generatedTitles(book.chapters), fixes, heard: this.readingHeard, anchors: this.anchorList() });
    this.set({ reading: { ...r, alignment } });
    try {
      await o.lib.writePairing(r.bookId, fixes);
    } catch (e) {
      log.warn("could not keep the pairing beside the book:", describe(e));
      this.set({ error: "The pairing could not be saved beside the book. It holds until you close the book." });
    }
  }

  /** A book with its chapters read from its file, kept on the shelf when they were not before. */
  private async chaptersOf(o: Opened, book: ScannedBook): Promise<ScannedBook> {
    if (book.files.every((f) => f.chaptersProbed)) return book;
    try {
      const probed = await o.lib.ensureChapters(book);
      if (probed === book) return book;
      const updated = this.stamp(o, [probed])[0]!;
      this.replaceBook(o, updated);
      return updated;
    } catch (e) {
      log.warn("could not read the chapters of", book.book.title, describe(e));
      return book;
    }
  }

  /** Where the narrator is in a book, mapped into its text, and when that was so. */
  private narratorPlace(bookId: string, ebook: Ebook, alignment: Alignment): { place: TextPlace; t: string } | undefined {
    const live = this.state.current?.book.book.id === bookId && this.engine?.current.bookId === bookId;
    const ms = live ? this.engine!.positionMs() : this.state.positions[bookId]?.offsetMs;
    if (ms === undefined) return undefined;
    // Playing now is now; paused, it is when it paused.
    const t = live && this.state.player.playing ? new Date().toISOString() : live && this.pausedAt !== null ? new Date(this.pausedAt).toISOString() : (this.state.positions[bookId]?.updatedAt ?? new Date(0).toISOString());
    return { place: placeAtGlobal(ebook, msToText(alignment, ms)), t };
  }

  /** In the reader: the narrator's place in the text, or null when this book's audio is not loaded. */
  narratorInText(): TextPlace | null {
    const r = this.state.reading;
    if (!r?.ebook || !r.alignment || this.state.current?.book.book.id !== r.bookId) return null;
    return placeAtGlobal(r.ebook, msToText(r.alignment, this.state.player.positionMs));
  }

  /** In the reader: turn to where the narrator is, heard first when no checkpoint is near. */
  async goToNarrator(): Promise<void> {
    if (!this.narratorInText()) return;
    await this.pinpoint(this.state.player.positionMs);
    const p = this.narratorInText();
    if (p) this.moveReading(p, "seek");
  }

  /** In the reader: play this book's audio from the page being read. */
  async listenFromHere(): Promise<void> {
    const r = this.state.reading;
    if (!r?.ebook || !r.alignment || !r.place) return;
    const book = this.state.books.find((b) => b.book.id === r.bookId);
    if (!book) return;
    const chars = globalOffset(r.ebook, r.place);
    // Heard first when no checkpoint is near, so the narrator starts on the page's first words.
    await this.pinpoint(textToMs(r.alignment, chars));
    const alignment = this.state.reading?.alignment ?? r.alignment;
    const ms = textToMs(alignment, chars);
    if (this.state.current?.book.book.id !== r.bookId) await this.openBook(book, { expand: false });
    if (this.state.current?.book.book.id !== r.bookId) return;
    this.seek(ms);
    await this.play();
  }

  /**
   * Where to start a book's audio because it was read further than it was
   * listened to: the mapped time of this machine's reading place, when the
   * reader turned pages after the audio last stopped. Null otherwise.
   */
  private readAhead(bookId: string, audioAtMs: number | null): number | null {
    const kept = this.keptPlaces()[bookId];
    if (!kept || kept.ms === undefined) return null;
    const readAt = Date.parse(kept.t);
    if (Number.isNaN(readAt) || (audioAtMs !== null && readAt <= audioAtMs + 1000)) return null;
    return kept.ms;
  }

  /** The reader is on a new page, or scrolled to a new line. */
  moveReading(place: TextPlace, why: Why = "periodic"): void {
    const r = this.state.reading;
    if (!r || r.status !== "ready" || !this.readingKeeper) return;
    const p = r.place;
    if (p && p.section === place.section && p.block === place.block && p.offset === place.offset) return;
    this.readingKeeper.move(place, why);
    this.set({ reading: { ...r, place } });
    // Reading on into chapters not yet checked: hear them, when nothing else is being heard.
    if (!this.hearing && p && p.section !== place.section) void this.hearPlaces();
  }

  /** Close the reader, keeping its place everywhere first. */
  async closeReading(): Promise<void> {
    const keeper = this.readingKeeper;
    this.readingKeeper = null;
    this.readingCtx = null;
    if (this.state.reading) this.set({ reading: null });
    if (keeper) await Promise.all([keeper.finish(), this.saveAppSettingsNow()]);
  }

  /** A URL for an image in the open book's text, when it was kept on this machine. */
  readingImageUrl(src: string): string | undefined {
    const abs = this.state.reading?.ebook?.files?.[src];
    return abs ? this.platform.fileUrl(abs) : undefined;
  }

  setReadingSettings(patch: Partial<ReadingSettings>): void {
    const next = parseReading({ ...this.state.readingSettings, ...patch });
    this.appSettings = { ...this.appSettings, reading: next };
    this.set({ readingSettings: next });
    this.saveAppSettingsSoon();
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
    // Read on since this book last played, outside the reader: carry on from the page.
    if (!this.state.reading && this.pausedAt !== null) {
      const ahead = this.readAhead(cur.book.book.id, this.pausedAt);
      if (ahead !== null) {
        log.info(`continuing ${cur.book.book.title} where it was read, at ${Math.round(ahead / 1000)} s`);
        this.seek(ahead);
      }
    }
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
    void this.persistPosition("pause");
  }

  togglePlay(): void {
    // While a file is being reconnected the listener is still "playing": the button pauses.
    if (this.state.player.playing || this.state.player.reconnecting) this.pause();
    else void this.play();
  }

  seek(positionMs: number): void {
    if (!this.engine) return;
    this.engine.setStopAt(null);
    this.engine.seek(positionMs);
    // A place chosen by hand is exact: no resume rewind on the next play.
    this.pausedAt = null;
    this.set({ resumeOffer: null, previewing: null });
    void this.persistPosition("seek");
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

  /**
   * Keep the open book's place. The engine only reports positions it can
   * trust, and only for the book it has loaded; a book still loading has
   * nothing to say yet. Urgent ones (pause, seek, leaving) are written at
   * once; the steady ones while playing are throttled by the keeper.
   */
  private async persistPosition(why: NonNullable<Position["why"]>): Promise<void> {
    const urgent = why !== "periodic";
    const cur = this.state.current;
    const o = cur && this.openedOf(cur.book);
    const engine = this.engine;
    if (!cur || !o || !engine) return;
    const bookId = cur.book.book.id;
    if (engine.current.bookId !== bookId) return;
    const offsetMs = engine.positionMs();
    this.lastWrite = Date.now();
    try {
      const kept = o.keeper.record(await o.lib.positionAt(bookId, offsetMs, Date.now(), why), urgent);
      this.set({ positions: { ...this.state.positions, [bookId]: kept } });
    } catch (e) {
      log.error("could not keep the position:", describe(e));
    }
  }

  /**
   * Write every position everywhere and wait, for the window closing or
   * going away. Bounded, so a share that hangs cannot hold the app open:
   * whatever it does not take is already in the local copy.
   */
  async flushPositions(timeoutMs = 4_000): Promise<void> {
    if (this.state.player.playing) this.engine?.pause();
    await this.persistPosition("close");
    const reading = this.readingKeeper;
    const all = Promise.all([...this.openedInOrder().map((o) => o.keeper.flush()), reading?.finish(), this.saveAppSettingsNow()]);
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  /**
   * Keep the place through everything the window goes through: closing
   * (pause, write everywhere, then let it close), being hidden or
   * minimised (write, keep playing), and the page unloading in the
   * browser harness. Returns an uninstall.
   */
  installLifecycle(): () => void {
    const offs: (() => void)[] = [];
    if (this.platform.onWindowClose) offs.push(this.platform.onWindowClose(() => this.flushPositions()));
    if (typeof document !== "undefined") {
      const onVisibility = () => {
        if (document.visibilityState === "hidden") void this.checkpoint();
      };
      document.addEventListener("visibilitychange", onVisibility);
      offs.push(() => document.removeEventListener("visibilitychange", onVisibility));
    }
    if (typeof window !== "undefined") {
      const onUnload = () => void this.flushPositions();
      window.addEventListener("pagehide", onUnload);
      offs.push(() => window.removeEventListener("pagehide", onUnload));
    }
    return () => offs.forEach((f) => f());
  }

  /** The window is hidden or minimised: make sure the local copy is current, without pausing. */
  async checkpoint(): Promise<void> {
    if (this.state.current) await this.persistPosition("close");
  }

  private onBookEnded(): void {
    this.pausedAt = Date.now();
    const id = this.state.current?.book.book.id;
    if (id) void this.markFinished(id);
    void this.persistPosition("end");
  }

  private refreshMediaMetadata(): void {
    const cur = this.state.current;
    if (!cur) {
      updateMediaMetadata(null, "", null);
      return;
    }
    const ch = cur.book.chapters[this.state.player.chapterIndex];
    const story = cur.book.parts[partAt(cur.book.parts, this.state.player.positionMs)] ?? null;
    updateMediaMetadata(cur.book, ch?.title ?? "", this.coverUrl(cur.book), story);
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

  /** Bookmark the place in the open book. */
  async addBookmark(note: string): Promise<void> {
    const cur = this.state.current;
    if (!cur || !this.engine) return;
    await this.addBookmarkAt(cur.book.book.id, this.engine.positionMs(), note);
  }

  /**
   * Add a bookmark: cut its clip, write its `mark` to the log (shown at
   * once), and write the book's bookmarks CSV for earlier versions.
   */
  async addBookmarkAt(bookId: string, offsetMs: number, note: string): Promise<Bookmark | null> {
    const b = this.state.books.find((x) => x.book.id === bookId);
    const lib = b && this.libOf(b);
    if (!b || !lib) return null;
    if (!this.bookmarkRows.has(bookId)) await this.loadBookmarks(bookId).catch(() => undefined);
    const ms = Math.max(0, Math.round(offsetMs));
    const clip = await lib.cutClip(b, ms).catch((e: unknown) => {
      log.warn("could not cut a bookmark's clip:", describe(e));
      return "";
    });
    const bm: Bookmark = { id: markId(bookId, ms), bookId, offsetMs: ms, createdAt: new Date().toISOString(), note, clip };
    await this.writeHistory(bookId, markFields(bm), bm.createdAt);
    await this.writeBookmarkRows(bookId);
    return bm;
  }

  /** Change a bookmark's note. */
  async editBookmark(bookId: string, id: string, note: string): Promise<void> {
    if (!this.bookmarkRows.has(bookId)) await this.loadBookmarks(bookId).catch(() => undefined);
    const bm = this.bookmarksFor(bookId).find((x) => x.id === id);
    if (!bm || bm.note === note) return;
    const modifiedAt = new Date().toISOString();
    await this.writeHistory(bookId, markFields({ ...bm, note, modifiedAt }), modifiedAt);
    await this.writeBookmarkRows(bookId);
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

  /** Delete a bookmark: a `del` in the log, then its clip and its CSV row. */
  async removeBookmark(bookId: string, id: string): Promise<void> {
    const b = this.state.books.find((x) => x.book.id === bookId);
    const lib = b && this.libOf(b);
    if (!b || !lib) return;
    if (!this.bookmarkRows.has(bookId)) await this.loadBookmarks(bookId).catch(() => undefined);
    const bm = this.bookmarksFor(bookId).find((x) => x.id === id);
    if (!bm) return;
    if (this.state.current?.book.book.id === bookId && this.state.previewing === bm.offsetMs) this.pause();
    await this.writeHistory(bookId, { k: "del", of: id });
    await lib.removeClip(bm.clip);
    await this.writeBookmarkRows(bookId);
  }

  /** A book's bookmarks, read again from its CSV and merged with the log as read so far. */
  async loadBookmarks(bookId: string): Promise<Bookmark[]> {
    const b = this.state.books.find((x) => x.book.id === bookId);
    const lib = b && this.libOf(b);
    if (!lib) return [];
    this.bookmarkRows.set(bookId, await lib.readBookmarks(bookId));
    return this.bookmarksFor(bookId);
  }

  /** A book's bookmarks: the marks in its source's log merged with its CSV rows. */
  bookmarksFor(bookId: string): Bookmark[] {
    const b = this.state.books.find((x) => x.book.id === bookId);
    const o = b && this.openedOf(b);
    if (!b || !o) return [];
    return bookmarksOf(o.log, { id: bookId, claims: claimsFor(b.original ?? b.book) }, this.bookmarkRows.get(bookId) ?? []);
  }

  /**
   * The bookmarks CSV, rewritten as this device sees them, so Ribbon 0.4
   * on other machines keeps working. Only once its rows have been read,
   * so a CSV that could not be read is never written over.
   */
  private async writeBookmarkRows(bookId: string): Promise<void> {
    const b = this.state.books.find((x) => x.book.id === bookId);
    const lib = b && this.libOf(b);
    if (!lib || !this.bookmarkRows.has(bookId)) return;
    const list = this.bookmarksFor(bookId);
    try {
      await lib.writeBookmarks(bookId, list);
      this.bookmarkRows.set(bookId, list);
    } catch (e) {
      log.warn("could not write bookmarks beside the books:", describe(e));
    }
  }

  /** The open book's bookmarks, again from the log, when they changed. */
  private refreshBookmarks(): void {
    const cur = this.state.current;
    if (!cur) return;
    const bookmarks = this.bookmarksFor(cur.book.book.id);
    if (JSON.stringify(bookmarks) !== JSON.stringify(cur.bookmarks)) this.set({ current: { ...cur, bookmarks } });
  }

  bookmarkClipUrl(bm: Bookmark): string | null {
    const cur = this.state.current;
    const lib = cur && this.libOf(cur.book);
    if (!lib || !bm.clip) return null;
    return this.platform.fileUrl(lib.host.join(lib.root, ".ribbon", "bookmarks", ...bm.clip.split("/")));
  }

  // Chapter corrections -------------------------------------------------

  /**
   * Ask Audnexus for a book's chapters by its ASIN. Only when the
   * listener asks; the ASIN is all that is sent. Throws a sentence when
   * there is no answer worth using.
   */
  async lookupChapters(asin: string, region: Region): Promise<LookedUp> {
    let r: Response;
    try {
      r = await fetch(chaptersUrl(asin, region), { headers: { accept: "application/json" } });
    } catch (e) {
      log.warn("chapter lookup failed:", describe(e));
      throw new Error("Could not reach Audnexus. Check the connection and try again.");
    }
    if (r.status === 404) throw new Error("Audnexus has no chapters for that ASIN in this region.");
    if (!r.ok) throw new Error(`Audnexus answered ${r.status}. Try again later.`);
    const found = parseChapters(await r.json().catch(() => null));
    if (!found) throw new Error("Audnexus has no chapters for that ASIN in this region.");
    log.info("chapter lookup:", asin, region, found.chapters.length, "chapters");
    return found;
  }

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

  showStats(): void {
    this.set({ pane: "stats", playerExpanded: false });
  }

  // History -------------------------------------------------------------

  /** A source's log records, apart from places, into the shelf's history. */
  private takeLog(o: Opened, records: LogRecord[]): void {
    if (this.opened.get(o.source.id) !== o) return;
    const disk = records.filter((r) => r.k !== "pos");
    // A read that started before a write landed must not undo it: keep what it has not seen.
    o.pendingLog = o.pendingLog.filter((p) => !disk.some((d) => sameRecord(d, p)));
    o.log = [...disk, ...o.pendingLog];
    this.publishHistory();
  }

  private publishHistory(): void {
    const all = this.openedInOrder().flatMap((o) => o.log);
    const seen = new Set<string>();
    const sessions: SessionRecord[] = [];
    for (const r of all) {
      if (r.k !== "session") continue;
      const key = `${r.dev}:${r.seq}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sessions.push(r);
    }
    this.set({ history: { ...this.state.history, reads: mergeById<ReadRecord>(all, "read"), sessions } });
    this.refreshBookmarks();
  }

  /** Write a history record or a mark to the log of the book's source, and show it at once. */
  private async writeHistory(
    bookId: string,
    r: { k: "read"; id: string; started: string; finished?: string } | { k: "del"; of: string } | MarkFields | (Omit<SessionRecord, "v" | "dev" | "seq" | "t" | "book" | "k"> & { k: "session" }),
    t = new Date().toISOString(),
  ): Promise<void> {
    const b = this.state.books.find((x) => x.book.id === bookId);
    const o = b && this.openedOf(b);
    if (!b || !o) return;
    // A book with no audio has no length to give.
    const book = { ids: claimsFor(b.original ?? b.book), ...(b.book.durationMs > 0 ? { dur_ms: b.book.durationMs } : {}) };
    // Shown at once; the next read of the log replaces it with what was written.
    this.localSeq = Math.max(this.localSeq + 1, Date.now());
    const shown = { v: 1, dev: "local", seq: this.localSeq, t, book, ...r } as LogRecord;
    o.pendingLog = [...o.pendingLog, shown];
    o.log = [...o.log, shown];
    this.publishHistory();
    try {
      await o.lib.appendRecord({ ...r, t, book });
    } catch (e) {
      log.warn("could not write history beside the books:", describe(e));
    }
  }

  /** Mark a book finished: the listen-through in progress closes now, or one is recorded that does. */
  async markFinished(bookId: string): Promise<void> {
    const open = openRead(this.state.history.reads, bookId);
    const now = new Date().toISOString();
    await this.writeHistory(bookId, { k: "read", id: open?.id ?? `urn:uuid:${globalThis.crypto.randomUUID()}`, started: open?.started ?? now, finished: now });
  }

  /** Mark a book not finished: the last listen-through opens again. */
  async markUnfinished(bookId: string): Promise<void> {
    const reads = this.state.history.reads.filter((r) => r.book.ids.includes(`urn:ribbon:${bookId}`));
    const last = reads.sort((a, b) => Date.parse(a.started) - Date.parse(b.started)).pop();
    if (last) await this.writeHistory(bookId, { k: "read", id: last.id, started: last.started });
    else await this.writeHistory(bookId, { k: "read", id: `urn:uuid:${globalThis.crypto.randomUUID()}`, started: new Date().toISOString() });
  }

  /** Start a book again from the beginning, as a new listen-through; the old one stays in the history. */
  async listenAgain(bookId: string): Promise<void> {
    const b = this.state.books.find((x) => x.book.id === bookId);
    if (!b) return;
    await this.writeHistory(bookId, { k: "read", id: `urn:uuid:${globalThis.crypto.randomUUID()}`, started: new Date().toISOString() });
    if (readerOnly(b.book)) return;
    await this.openBook(b, { expand: false });
    this.seek(0);
    await this.play();
  }

  /** Correct the dates of a listen-through. A null finish means it is still going. */
  async editRead(bookId: string, readId: string, started: string, finished: string | null): Promise<void> {
    await this.writeHistory(bookId, { k: "read", id: readId, started, ...(finished ? { finished } : {}) });
  }

  async deleteRead(bookId: string, readId: string): Promise<void> {
    await this.writeHistory(bookId, { k: "del", of: readId });
  }

  /** Keep a record of listening sessions, or stop. Turning it off writes no more of them. */
  async setRecordSessions(on: boolean): Promise<void> {
    this.appSettings = { ...this.appSettings, recordSessions: on };
    this.set({ history: { ...this.state.history, recording: on } });
    await this.platform.appSettings?.write(this.appSettings).catch((e: unknown) => log.warn("could not save settings:", describe(e)));
  }

  /** Playing started: a listen-through opens if none is, and a session begins. */
  private beginListening(bookId: string, positionMs: number, speed: number): void {
    this.listening = { bookId, start: Date.now(), fromMs: positionMs, speed };
    const reads = this.state.history.reads;
    if (!openRead(reads, bookId) && !finishedByRead(reads, bookId)) {
      void this.writeHistory(bookId, { k: "read", id: `urn:uuid:${globalThis.crypto.randomUUID()}`, started: new Date().toISOString() });
    }
  }

  /** Playing stopped: a session of thirty seconds or more goes in the log, if sessions are kept. */
  private endListening(positionMs: number): void {
    const s = this.listening;
    this.listening = null;
    if (!s || !this.state.history.recording) return;
    const end = Date.now();
    if (end - s.start < 30_000) return;
    void this.writeHistory(s.bookId, {
      k: "session",
      start: new Date(s.start).toISOString(),
      end: new Date(end).toISOString(),
      from_ms: Math.round(s.fromMs),
      to_ms: Math.round(positionMs),
      listened_ms: end - s.start,
      speed: s.speed,
    });
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
    // The mirror holds positions the share may not have yet: give them a last chance to land.
    await this.flushPositions();
    if (!(await this.platform.home.reset())) return;
    this.engine?.pause();
    for (const o of this.opened.values()) {
      void o.keeper.close();
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
    // A record whose members were all taken out still has to reach where it lived.
    for (const o of this.openedInOrder()) if (o.seriesKeys.has(record.key)) for (const b of o.books.slice(0, 1)) members.add(b.book.id);
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
      await this.nameAllChapters();
    })().finally(() => {
      this.lookupRun = null;
    });
  }

  // Chapter names --------------------------------------------------------

  /** One ask at a time, whoever asks: the background pass or a book being opened. */
  private naming: Promise<unknown> = Promise.resolve();

  /**
   * Give a book its real chapter names when its chapters are only
   * numbered: find its ASIN, ask Audnexus, and if the names fit the
   * markers there are (same count, same length, starts in line), put them
   * on as corrections beside the book. Once per book; only with the
   * online lookups on; undone like any chapter correction.
   */
  maybeNameChapters(bookId: string): Promise<void> {
    const run = this.naming.then(() => this.nameChapters(bookId)).catch((e: unknown) => log.warn("chapter names:", describe(e)));
    this.naming = run;
    return run;
  }

  private async nameChapters(bookId: string): Promise<void> {
    const book = this.state.books.find((b) => b.book.id === bookId);
    const o = book && this.openedOf(book);
    if (!book || !o) return;
    o.names ??= await o.lib.readNameRecords();
    const asked = o.names.get(bookId);
    // Named in an earlier session: say so in the chapter list.
    if (asked?.outcome === "applied" && this.state.namedChapters[bookId] === undefined) this.set({ namedChapters: { ...this.state.namedChapters, [bookId]: asked.asin } });
    if (!this.state.lookup.enabled || asked || !wantsNames(book)) return;
    const { asin, plan } = await new ChapterNamer(o.lib.host).plan(book);
    const record: NameRecord = { bookId, asin, outcome: plan.apply ? "applied" : asin ? "kept" : "not-found", reason: plan.apply ? "" : plan.reason, at: new Date().toISOString() };
    if (plan.apply) {
      const cur = this.state.current;
      if (cur && cur.book.book.id === bookId) {
        await this.correctChapters([...cur.corrections, ...plan.corrections]);
      } else {
        const latest = this.state.books.find((b) => b.book.id === bookId) ?? book;
        const corrections = [...(await o.lib.readCorrections(bookId)), ...plan.corrections];
        this.replaceBook(o, this.stamp(o, [await o.lib.writeCorrections(latest, corrections)])[0]!);
      }
      this.set({ namedChapters: { ...this.state.namedChapters, [bookId]: asin } });
    }
    log.info(`chapter names for ${book.book.title}: ${record.outcome}${asin ? ` (${asin})` : ""}${record.reason ? `, ${record.reason}` : ""}`);
    o.names.set(bookId, record);
    await o.lib.writeNameRecords([...o.names.values()]).catch((e: unknown) => log.warn("could not keep chapter-name records:", describe(e)));
  }

  /** Every book with numbered chapters already read gets a turn, one at a time, after the descriptions. */
  private async nameAllChapters(): Promise<void> {
    for (const o of this.openedInOrder()) {
      for (const b of o.books) {
        if (!this.state.lookup.enabled || this.opened.get(o.source.id) !== o) return;
        if (!wantsNames(b)) continue;
        await this.maybeNameChapters(b.book.id);
        // Gentle with services that are free to use.
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
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

  /**
   * Save the decisions beside the books, in every source that holds one,
   * and apply them to the shelf: the order, the numbers, what is on the
   * shelf, a new name, and books moved into other series.
   */
  async saveSeries(choices: SeriesChoice[], opts: { name?: string; moves?: { bookId: string; toKey: string }[] } = {}): Promise<void> {
    const g = this.state.seriesSetup;
    if (!g) return;
    const now = new Date().toISOString();
    const moved = new Set((opts.moves ?? []).map((m) => m.bookId));
    const name = opts.name?.trim() || this.state.series[g.key]?.name || g.name;
    const record: SeriesRecord = { key: g.key, name, choices: normalizeChoices(choices.map((c) => (moved.has(c.bookId) ? { ...c, removed: true } : c))), decidedAt: now };
    const series = { ...this.state.series, [g.key]: record };
    const others: SeriesRecord[] = [];
    const groups = this.detectedSeries();
    for (const m of opts.moves ?? []) {
      if (m.toKey === g.key) continue;
      const target = groups.find((x) => x.key === m.toKey);
      const base = series[m.toKey] ?? (target ? { key: target.key, name: target.name, choices: defaultChoices(target), decidedAt: now } : null);
      if (!base) continue;
      const have = base.choices.find((c) => c.bookId === m.bookId);
      const choices2 = have
        ? base.choices.map((c) => (c.bookId === m.bookId ? { bookId: c.bookId, included: true, order: c.order, ...(c.number !== undefined ? { number: c.number } : {}) } : c))
        : [...base.choices, { bookId: m.bookId, included: true, order: base.choices.length + 1 }];
      const next: SeriesRecord = { ...base, choices: normalizeChoices(choices2), decidedAt: now };
      series[m.toKey] = next;
      others.push(next);
    }
    if (name !== g.name) log.info("rename series:", g.name, "→", name);
    if (moved.size > 0) log.info("moved", moved.size, "book(s) out of", name);
    this.set({ series, seriesSetup: null });
    await this.writeSeriesRecord(record);
    for (const r of others) await this.writeSeriesRecord(r);
  }

  /** Forget the listener's decisions about a series: detection, or nothing, takes over again. */
  async forgetSeries(key: string): Promise<void> {
    return this.deleteSeries(key);
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
      void o.keeper.flush();
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
