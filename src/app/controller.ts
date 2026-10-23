import type { Host, ScanProgress } from "../host/host";
import { extractMissingCovers, type ScannedBook } from "../core/scan/scan";
import type { Bookmark, BookSettings, Highlight, Position, SilenceRange } from "../core/types";
import type { Problem } from "../core/problems";
import { defaultChoices, detectSeries, mergeSeries, newSeriesRecord, normalizeChoices, uniqueKey, type SeriesChoice, type SeriesGroup, type SeriesRecord } from "../core/series";
import type { BookAbout } from "../core/about";
import { sameRoot, serverKey, sourceFrom, sourceId, sourceName, type ServerRef, type Source, type SourceEntry } from "../core/sources";
import { ServerClient, ServerError, type ServerJob } from "./server/client";
import { NotEnoughSpace, ServerShelf } from "./server/shelf";
import { ServerLog } from "./server/server-log";
import { AboutLookup, type LookupStatus } from "./about";
import { ChapterNamer, wantsNames, type NameRecord } from "./chapternames";
import { PlayerEngine, type EngineState } from "../player/engine";
import { LibraryService } from "./library";
import { PositionKeeper } from "./positions";
import { isReadOnly } from "./read-only";
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
import { bookmarksOf, clipRange, highlightId, highlightsOf, markFields, markId, type MarkFields } from "../core/bookmarks";
import { highlightOf, trimRange } from "../core/reading/highlights";
import { chapterAt } from "../core/scan/chapters";
import { partAt } from "../core/scan/parts";
import * as sleep from "../core/sleep";
import type { Correction } from "../core/scan/chapters";
import { log } from "./log";
import { openEbook, readerOnly, type Ebook } from "../core/ebook";
import type { Why } from "../core/poslog";
import { BookText, type TextPlace } from "../core/reading/booktext";
import { parseReading, type ReadingSettings } from "../core/reading/typography";
import { openingPlace, parseKeptPlaces, ReadingKeeper, type KeptPlace, type ReadingState } from "./reading";
import { alignBook, byOverlay, followedMs, LEAD_IN_MS, msToText, textToMs, type Alignment, type PairingFix } from "../core/reading/align";
import { overlayAnchors } from "../core/reading/overlay";
import { exportPlan } from "../core/reading/export";
import * as perf from "./perf";
import { matchTranscript, type Said } from "../core/reading/transcript";
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
/** Read-along by transcription (#57): the narration is heard in stretches this long, several to a call. */
const SPAN_MS = 60_000;
const SPANS_PER_CALL = 8;
/** Transcribed before the reader shows the text: a minute behind the reader to this far ahead. */
const READY_MS = 4 * 60_000;
/** What is heard, transcribed and fixed for one book's text: see AppController.rd. */
interface ReadingData {
  fixes: PairingFix[];
  /** What the narrator was heard saying, by time, and where each was found in the text. */
  heard: Map<number, string>;
  anchors: Map<number, number>;
  /** The stretches transcribed (start to end, ms), every phrase heard in them, and where each was found. */
  spans: Map<number, number>;
  said: (Said & { chars: number | null })[];
  aligned: Map<number, number>;
  overlay: Anchor[] | null;
  /** The transcript changed since it was last kept beside the book, and when that was. */
  dirty: boolean;
  written: number;
}

function emptyReading(): ReadingData {
  return { fixes: [], heard: new Map(), anchors: new Map(), spans: new Map(), said: [], aligned: new Map(), overlay: null, dirty: false, written: 0 };
}

/** How far either side of where the pairing puts a stretch its words are looked for, in characters: about a minute and a half of reading. */
const SPAN_SLACK = 2_500;
/** The transcript is kept beside the book at most this often while it grows, and when it is done. */
const ALIGNED_WRITE_MS = 30_000;

export interface Platform {
  host: Host;
  /** Ask the user for a folder of books, opening near `near`. Null when cancelled. */
  pickFolder(near?: string | null): Promise<string | null>;
  /** Grant access to a folder before any read. */
  allowFolder(path: string): Promise<void>;
  /** Streamable URL for an absolute path. */
  fileUrl(absPath: string): string;
  /** A URL for an MP3 beginning exactly at a moment of it, where the platform can serve one. */
  exactAudioUrl?(absPath: string, ms: number): string;
  /** The folders the library is populated from, wherever the platform keeps them. */
  sources: {
    load(): Promise<SourceEntry[]>;
    save(list: SourceEntry[]): Promise<void>;
  };
  /** A folder to add automatically without picking (dev harness, command line). */
  defaultRoot?: () => Promise<string | null>;
  /** Milliseconds since the host process started, when the host knows. */
  uptimeMs?: () => Promise<number>;
  /** A phone, which the app's sentences call "this phone"; any other device is "this machine". */
  phone?: boolean;
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
  /** A folder being added to a server, which copies its books in, rather than read where it is. */
  copying?: boolean;
}

/** What the shelf knows about one source beyond its books. */
export interface SourceStatus {
  scanning: ScanStatus | null;
  /** How long the last scan took, or null before the first finishes. */
  lastScanMs: number | null;
  /** Why the source could not be opened, or null. */
  error: string | null;
  /** The folder is read-only from this device: places in its books are kept on this device alone (read-only.ts). */
  readOnly: boolean;
}

export interface AppState {
  phase: "boot" | "pick" | "loading" | "ready";
  /** The folders the library is populated from, in the order they were added. */
  sources: Source[];
  sourceStatus: Record<string, SourceStatus>;
  /** Folders found read-only from this device that the library has not said so about yet: it says so once per folder. */
  readOnlyNotice: string[];
  /** Whether this person adds folders: anyone without a server; with one, only its admin, and into it. */
  canAddFolders: boolean;
  /** Books downloading from a server now, by id: bytes done of the total (docs/SERVER.md, section 8). */
  downloads: Record<string, { done: number; total: number }>;
  /** A book that won't fit on this device, waiting for the person to choose what to remove, or not to download it. */
  spaceShort: { bookId: string; title: string; neededBytes: number; freeBytes: number } | null;
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
  /** Say, once, that a speech model makes read-along follow the sentence: shown the first time a book with both editions opens on a computer without one. */
  speechNudge: boolean;
  /** Speed measurements are summarised in the log (app/perf.ts). */
  perfLog: boolean;
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
  /** For a Ribbon server's source: what the server lists, and its downloads (server/shelf.ts). */
  server: ServerShelf | null;
  /** For a Ribbon server's source: the position log carried to and from the server, and the event stream that says when. */
  serverPlaces: { log: ServerLog; soon: ReturnType<typeof setTimeout> | null; events: AbortController } | null;
  /** The person signed in to this server is its admin, who adds its folders. */
  serverAdmin: boolean;
  /** A refresh of the server's list waiting to run: books arriving one at a time are fetched a few at once. */
  serverRefreshSoon: ReturnType<typeof setTimeout> | null;
  /**
   * Folders being added to this server, each with its job as last seen. Kept
   * apart from `scanning`: a scan of the downloads underneath never takes
   * over the import's progress, and covers don't hide while it runs.
   */
  serverImports: Map<number, { name: string; job: ServerJob | null }>;
}

/**
 * The app. One instance, made in `ui/App.tsx`, holds every piece of state
 * the screens show and every action they can take. React only draws it:
 * components read the state with `useAppState()` and call methods on
 * `useController()` (`ui/store.ts`), and nothing else changes anything.
 * The tests make one with a test platform and drive it the same way.
 *
 * ## How state moves
 *
 * `state` is one immutable `AppState`. Every change goes through
 * `set(patch)`, which makes a new object and calls the listeners
 * `subscribe` collected; React's `useSyncExternalStore` redraws whoever
 * reads it. The player sets `player` five times a second, so a component
 * selects what it draws, `useAppState((s) => …)`, and redraws only when
 * that changes; `useAppState()` with no selector redraws on every tick.
 * Nothing else holds state the screens see: the private fields below are
 * working parts (the audio engine, open libraries, timers, caches), never
 * what is shown.
 *
 * ## What it talks to
 *
 * ```
 *  Platform ── what the host gives: files and processes (Host), the folder
 *  │           picker, app settings, file URLs, window events (platform.ts)
 *  ├─ LibraryService ── one per library folder: reads and writes the
 *  │                    records in its .ribbon/ (library.ts)
 *  ├─ PositionKeeper ── one per library folder: where each book is
 *  │                    (positions.ts)
 *  ├─ PlayerEngine ──── the audio (player/engine.ts), made on the first play
 *  ├─ JobQueue ──────── loudness and silence, one ffmpeg at a time (jobs.ts)
 *  └─ core/ ─────────── every decision that needs no file: grouping books,
 *                       pairing text with audio, merging logs, search…
 * ```
 *
 * ## The sections, in file order
 *
 * - **Sources.** The library is any number of folders (`Source`). Each one
 *   opened becomes an `Opened`: its `LibraryService`, its books, its
 *   position keeper, its log. `libOf(book)` finds a book's.
 * - **Lifecycle.** `boot()` reads the app settings, opens every source
 *   (painting the shelf from cached records first, then scanning), and
 *   lands in `phase: "ready"`, or `"pick"` when there is no library yet.
 *   Adding, rescanning and removing folders live here too, and editing a
 *   book's details.
 * - **Playback.** `openBook` loads a book into the engine at its place
 *   (or where it was read to, if reading got further: `readAhead`).
 *   `play`, `pause`, `seek`, `skip`, chapters, speed. `onPlayerState`
 *   hears the engine five times a second, keeps the place and the
 *   listening session, and updates the system's media controls.
 * - **Reading.** The EPUB reader and read-along (docs/READING.md).
 *   `openReading` makes the book's `BookText`, pairs its chapters with the
 *   audio, and starts `hearPlaces`, the background work that makes the
 *   pairing precise: chapter openings heard, the narration transcribed,
 *   all kept beside the book. `ReadingData` is one book's share of that,
 *   kept per book so a closed book's work never lands on another.
 *   Following the narrator, listening from a place, highlights, the
 *   read-along export.
 * - **Sleep timer, Bookmarks, Chapter corrections, Navigation** (which
 *   pane is showing), **History** (listen-throughs and sessions from the
 *   position log), **Series**, **Descriptions** (book details from online
 *   catalogs, only when turned on), **Chapter names** (Audible's names
 *   for a book's numbered chapters).
 *
 * ## Habits worth knowing
 *
 * - **Records first, scan after.** Anything shown at start comes from the
 *   records beside the books (or this machine's mirror of them); work
 *   on files happens behind it.
 * - **Places are never lost.** The keeper writes a place to memory at
 *   once, to this machine within 2 s and beside the books within 15 s (at
 *   once for a pause or a seek); `flushPositions` runs when the window closes.
 * - **Slow work checks it is still wanted.** An open book that lost the
 *   race stops (`openSeq`); background reading work checks `still()`
 *   after every await; the engine carries an intent number for the same
 *   reason.
 * - **Failures become a sentence.** A record that cannot be read or
 *   written is logged and, when it matters to the listener, put in
 *   `state.error` in plain words; the rest of the app carries on.
 *
 * To add a feature: put the decision in `core/` (tested on its own), the
 * file it keeps in `LibraryService`, the state in `AppState`, and the
 * action here, in its section.
 */
export class AppController {
  private state: AppState;
  private listeners = new Set<() => void>();
  private opened = new Map<string, Opened>();
  private jobs: JobQueue;
  private engine: PlayerEngine | null = null;
  private pausedAt: number | null = null;
  /** The moment a Listen from here began from, before its lead-in: the text holds there until the narrator reaches it (followedMs). */
  private listenedFrom: number | null = null;
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

  /** This device, as the app's sentences name it. */
  get here(): string {
    return this.platform.phone ? "this phone" : "this machine";
  }

  constructor(private readonly platform: Platform) {
    this.state = {
      phase: "boot",
      sources: [],
      sourceStatus: {},
      readOnlyNotice: [],
      canAddFolders: true,
      downloads: {},
      spaceShort: null,
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
      editBook: null,
      view: DEFAULT_VIEW,
      history: { reads: [], sessions: [], recording: true },
      namedChapters: {},
      reading: null,
      readingSettings: parseReading(undefined),
      speech: { model: null, downloading: null },
      speechNudge: false,
      perfLog: false,
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
      // A server's books not on this device yet come after the ones that are.
      const remote = (o.server?.remote(o.books) ?? []).map((b) => ({ ...b, source: o.source.id }));
      for (const b of [...o.books, ...remote]) {
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
    // A server's imports, while there are any, are what its status says.
    const statusOf = (o: Opened) => this.importStatus(o) ?? o.scanning;
    const live = this.openedInOrder().filter((o) => statusOf(o));
    let scanning: ScanStatus | null = null;
    if (live.length > 0) {
      scanning = { walked: 0, done: 0, background: true };
      for (const o of live) {
        const s = statusOf(o)!;
        scanning.walked += s.walked;
        scanning.done += s.done;
        if (s.found !== undefined) scanning.found = (scanning.found ?? 0) + s.found;
        if (s.stage && !scanning.stage) scanning.stage = s.stage;
        if (!s.background) scanning.background = false;
        if (s.copying) scanning.copying = true;
      }
    }
    const sourceStatus: Record<string, SourceStatus> = {};
    for (const s of this.state.sources) {
      const o = this.opened.get(s.id);
      sourceStatus[s.id] = { ...(this.state.sourceStatus[s.id] ?? { lastScanMs: null, error: null, readOnly: false }), scanning: o ? statusOf(o) : null };
    }
    this.set({ scanning, sourceStatus, assetsReady: this.openedInOrder().every((o) => o.assetsReady), ...extra });
  }

  private setSourceStatus(id: string, patch: Partial<SourceStatus>): void {
    const prev = this.state.sourceStatus[id] ?? { scanning: null, lastScanMs: null, error: null, readOnly: false };
    this.set({ sourceStatus: { ...this.state.sourceStatus, [id]: { ...prev, ...patch } } });
  }

  /** A folder turned out to be read-only from this device: say so beside it in Settings, and once at the top of the library. */
  private folderReadOnly(source: Source): void {
    if (!this.opened.has(source.id)) return;
    log.warn(`${source.name}: read-only from this device; places in its books are kept on this machine`);
    this.setSourceStatus(source.id, { readOnly: true });
    if (!this.readOnlyTold().includes(source.root) && !this.state.readOnlyNotice.includes(source.id)) this.set({ readOnlyNotice: [...this.state.readOnlyNotice, source.id] });
  }

  /** The folders the library has already said are read-only from this device. */
  private readOnlyTold(): string[] {
    const told = this.appSettings.readOnlyTold;
    return Array.isArray(told) ? told.filter((root): root is string => typeof root === "string") : [];
  }

  /** The notice about read-only folders was read: it is not shown for them again. */
  dismissReadOnly(): void {
    const roots = this.state.readOnlyNotice.flatMap((id) => this.state.sources.find((s) => s.id === id)?.root ?? []);
    this.appSettings = { ...this.appSettings, readOnlyTold: [...new Set([...this.readOnlyTold(), ...roots])] };
    void this.platform.appSettings?.write(this.appSettings).catch((e: unknown) => log.warn("could not save settings:", describe(e)));
    this.set({ readOnlyNotice: [] });
  }

  private saveSources(): Promise<void> {
    return this.platform.sources.save(this.state.sources.map((s) => ({ root: s.root, addedAt: s.addedAt, ...(s.server ? { server: s.server } : {}) }))).catch((e: unknown) => log.warn("could not save the sources:", describe(e)));
  }

  // Lifecycle -----------------------------------------------------------

  async boot(): Promise<void> {
    if (this.platform.appSettings) {
      this.appSettings = await this.platform.appSettings.read().catch(() => ({}));
      this.set({ lookup: { ...this.state.lookup, enabled: this.appSettings.lookupDescriptions === true }, view: parseView(this.appSettings.libraryView), history: { ...this.state.history, recording: this.appSettings.recordSessions !== false }, readingSettings: parseReading(this.appSettings.reading), speech: { model: typeof this.appSettings.speechModel === "string" && this.appSettings.speechModel ? this.appSettings.speechModel : null, downloading: null }, perfLog: this.appSettings.perfLog === true });
      perf.setLogging(this.appSettings.perfLog === true);
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
    const entries = await this.platform.sources
      .load()
      .then((list) => this.placeServers(list))
      .catch((e: unknown) => {
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
    this.set({ phase: "loading", sources, sourceStatus: Object.fromEntries(sources.map((s) => [s.id, { scanning: null, lastScanMs: null, error: null, readOnly: false }])) });
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
    // With a server, a folder goes into it, and only its admin adds one (docs/SERVER.md, section 6).
    const servers = this.openedInOrder().filter((o) => o.source.server);
    const server = servers.find((o) => o.serverAdmin && o.server);
    if (servers.length > 0 && !server) return;
    const lastAdded = typeof this.appSettings.lastServerFolder === "string" ? this.appSettings.lastServerFolder : null;
    const near = server ? lastAdded : (this.state.sources[this.state.sources.length - 1]?.root ?? null);
    const root = await this.platform.pickFolder(near);
    if (!root) return;
    if (server) return this.addFolderToServer(server, root);
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
  async addSource(pickedRoot: string, server?: ServerRef): Promise<void> {
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
    const source = sourceFrom({ root, addedAt: new Date().toISOString(), ...(server ? { server } : {}) });
    log.info("add source", server ? server.url : root);
    this.set({
      phase: this.opened.size === 0 ? "loading" : this.state.phase,
      sources: [...this.state.sources, source],
      sourceStatus: { ...this.state.sourceStatus, [source.id]: { scanning: null, lastScanMs: null, error: null, readOnly: false } },
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
    const lib = new LibraryService(this.platform.host, root, () => this.folderReadOnly(source));
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
      server: null,
      serverPlaces: null,
      serverAdmin: false,
      serverRefreshSoon: null,
      serverImports: new Map(),
    };
    this.opened.set(source.id, o);
    if (source.server) await this.linkServer(o, this.serverTokens()[serverKey(source.server)] ?? null);
    this.updateCanAddFolders();
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
    await Promise.all(this.openedInOrder().map((o) => this.checkSource(o, background)));
  }

  /** Check one source for changes. */
  async rescanSourceById(id: string): Promise<void> {
    const o = this.opened.get(id);
    if (o) await this.checkSource(o, true);
  }

  /** Check a source for changes, asked for: a server's is asked for its books and places too. */
  private async checkSource(o: Opened, background: boolean): Promise<void> {
    if (o.server) {
      void this.refreshServer(o);
      void this.syncPlaces(o);
    }
    await this.rescanSource(o, background);
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
      void this.fetchCovers(o)
        .then(() => this.mirrorCoversFor(o))
        .catch((e: unknown) => isReadOnly(e) || log.warn("could not keep covers beside the books:", describe(e)));
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
  // Servers -------------------------------------------------------------

  /**
   * Connect to a Ribbon server (docs/SERVER.md, section 11): sign in, and
   * add it as a source whose folder is one of Ribbon's own, where its books
   * are downloaded before they play. The sign-in token is kept in the app's
   * settings, never in the sources file. Connecting again to a server
   * already here signs it in again.
   */
  async connectServer(address: string, name: string, password: string): Promise<void> {
    const server: ServerRef = { url: serverUrl(address), person: name.trim() };
    const home = await this.platform.home?.path();
    if (!home) throw new Error("This version of Ribbon can't keep a server's books.");
    const client = await ServerClient.signIn(server.url, server.person, password);
    const root = this.serverRoot(home, server);
    // The app's files reach only the folders it has been allowed (allow_library): this one is Ribbon's own, made here.
    await this.platform.allowFolder(root);
    await this.platform.host.mkdir(root);
    await this.keepServerToken(server, client.token);
    const open = this.opened.get(sourceId(root));
    if (open) {
      this.setSourceStatus(open.source.id, { error: null });
      await this.linkServer(open, client.token);
      return;
    }
    await this.addSource(root, server);
  }

  /** A server's folder: one of Ribbon's own, named by the server and who's signed in. */
  private serverRoot(home: string, server: ServerRef): string {
    return this.platform.host.join(home, "servers", sourceId(serverKey(server)));
  }

  /** Each server source's folder, worked out again from Ribbon's own: a phone's app folder moves when the app is updated. */
  private async placeServers(entries: SourceEntry[]): Promise<SourceEntry[]> {
    if (!entries.some((e) => e.server)) return entries;
    const home = await this.platform.home?.path().catch(() => null);
    if (!home) return entries;
    const placed = entries.map((e) => (e.server ? { ...e, root: this.serverRoot(home, e.server) } : e));
    // Made again if it's gone: the server still has the books, and the place in each.
    for (const e of placed) {
      if (!e.server) continue;
      await this.platform
        .allowFolder(e.root)
        .then(() => this.platform.host.mkdir(e.root))
        .catch((err: unknown) => log.warn("could not make a server's folder:", describe(err)));
    }
    return placed;
  }

  /** The sign-in tokens of the servers this device is connected to, by `serverKey`. */
  private serverTokens(): Record<string, string> {
    const kept = this.appSettings.serverTokens;
    return kept && typeof kept === "object" ? (kept as Record<string, string>) : {};
  }

  /** Keep a server's sign-in in the app's settings, or forget it (null). */
  private async keepServerToken(server: ServerRef, token: string | null): Promise<void> {
    const { [serverKey(server)]: _was, ...others } = this.serverTokens();
    this.appSettings = { ...this.appSettings, serverTokens: token ? { ...others, [serverKey(server)]: token } : others };
    await this.platform.appSettings?.write(this.appSettings).catch((e: unknown) => log.warn("could not save settings:", describe(e)));
  }

  /** Give an opened server source its shelf: the list as last seen at once, then the server's own. */
  private async linkServer(o: Opened, token: string | null): Promise<void> {
    if (!o.source.server) return;
    if (!token) {
      this.setSourceStatus(o.source.id, { error: "Sign in to the server again." });
      return;
    }
    // Its list and covers are read and written here before the shelf's own access to the folder lands.
    await this.platform.allowFolder(o.source.root).catch((e: unknown) => log.warn("could not open a server's folder:", describe(e)));
    const client = new ServerClient(o.source.server.url, token);
    this.letGoOfServerPlaces(o);
    // The position log is the server's, kept here only as last read and what's still to send (server-log.ts).
    const placesLog = new ServerLog(client, this.platform.host, o.source.root, () => o.lib.logDevice());
    o.lib.useRemoteLog(placesLog);
    o.serverPlaces = { log: placesLog, soon: null, events: new AbortController() };
    o.server = new ServerShelf(client, this.platform.host, o.source.root);
    await o.server.loadCached();
    void this.refreshServer(o);
    void client
      .me()
      .then((me) => {
        if (this.opened.get(o.source.id) !== o) return;
        o.serverAdmin = me.role === "admin";
        this.updateCanAddFolders();
      })
      .catch((e: unknown) => log.warn("could not ask the server who's signed in:", describe(e)));
    // What this device adds to its log goes on to the server, a moment later so a run of records goes as one.
    o.lib.onAppend = () => this.syncPlacesSoon(o);
    void this.syncPlaces(o);
    void this.listenToServer(o, client, o.serverPlaces.events.signal);
  }

  /** Carry the position log to and from a server, and take in whatever came down. */
  private async syncPlaces(o: Opened): Promise<void> {
    const sp = o.serverPlaces;
    if (!sp) return;
    const alive = () => this.opened.get(o.source.id) === o && o.serverPlaces === sp;
    try {
      if (!(await sp.log.sync()) || !alive()) return;
      const l = await o.lib.readPositionLog();
      if (!alive()) return;
      this.takeSharePositions(o, l.places);
      this.takeLog(o, l.records);
    } catch (e) {
      log.warn("could not share places with the server:", o.source.name, describe(e));
      if (alive() && e instanceof ServerError && e.status === 401) this.setSourceStatus(o.source.id, { error: "Sign in to the server again." });
    }
  }

  private syncPlacesSoon(o: Opened): void {
    const sp = o.serverPlaces;
    if (!sp || sp.soon) return;
    sp.soon = setTimeout(() => {
      sp.soon = null;
      void this.syncPlaces(o);
    }, 1000);
  }

  /**
   * The server's events, for as long as the source is open: another of
   * this person's devices moved a place, or the library changed. A stream
   * that drops is opened again, sooner at first, and what was missed
   * meanwhile is caught up with a sync.
   */
  private async listenToServer(o: Opened, client: ServerClient, signal: AbortSignal): Promise<void> {
    const me = (await o.lib.logDevice()).id;
    for (let attempt = 0; !signal.aborted; attempt++) {
      const opened = Date.now();
      await client
        .events((type, data) => {
          if (type === "places" && (data as { device?: string } | null)?.device !== me) void this.syncPlaces(o);
          if (type === "books") this.refreshServerSoon(o);
        }, signal)
        .catch((e: unknown) => {
          if (!signal.aborted && attempt === 0) log.info("the server's events stopped:", describe(e));
        });
      if (signal.aborted) return;
      // A stream that stayed up a while starts the waits over.
      if (Date.now() - opened > 60_000) attempt = 0;
      await new Promise((r) => setTimeout(r, Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5))));
      if (!signal.aborted) void this.syncPlaces(o);
    }
  }

  /** Refresh a server's list shortly: books added one after another are fetched a few at once. */
  private refreshServerSoon(o: Opened): void {
    if (o.serverRefreshSoon) return;
    o.serverRefreshSoon = setTimeout(() => {
      o.serverRefreshSoon = null;
      void this.refreshServer(o);
    }, 1500);
  }

  /** Who adds folders: anyone, until a server is connected; then only its admin. */
  private updateCanAddFolders(): void {
    const servers = this.openedInOrder().filter((o) => o.source.server);
    const can = servers.length === 0 || servers.some((o) => o.serverAdmin);
    if (can !== this.state.canAddFolders) this.set({ canAddFolders: can });
  }

  /**
   * Add a folder as a server's admin: the server copies its books in, and
   * they join the shelf as they arrive, with the same progress a folder's
   * scan shows. The folder is a path on the server's own machine, and the
   * server only ever reads it.
   */
  private async addFolderToServer(o: Opened, folder: string): Promise<void> {
    const shelf = o.server;
    if (!shelf) return;
    const name = sourceName(folder);
    this.appSettings = { ...this.appSettings, lastServerFolder: folder };
    void this.platform.appSettings?.write(this.appSettings).catch((e: unknown) => log.warn("could not save settings:", describe(e)));
    const alive = () => this.opened.get(o.source.id) === o && o.server === shelf;
    const entry: { name: string; job: ServerJob | null } = { name, job: null };
    const key = this.nextImport++;
    o.serverImports.set(key, entry);
    const show = (job: ServerJob | null) => {
      entry.job = job;
      this.publishScanning();
    };
    show(null);
    let job: ServerJob;
    try {
      job = await shelf.client.importFolder(folder);
      log.info("adding a folder to the server:", folder, job.id);
      let added = 0;
      while (job.state === "waiting" || job.state === "running") {
        await new Promise((r) => setTimeout(r, 1000));
        if (!alive()) return;
        job = await shelf.client.job(job.id);
        show(job);
        if (job.progress.added > added) {
          added = job.progress.added;
          this.refreshServerSoon(o);
        }
      }
    } catch (e) {
      if (alive()) this.set({ error: `Couldn't add ${name} to the server: ${describe(e)}` });
      return;
    } finally {
      o.serverImports.delete(key);
      if (alive()) this.publishScanning();
    }
    await this.refreshServer(o);
    const p = job.progress;
    log.info(`added ${name} to the server: ${p.added} added, ${p.skipped} already there, ${p.failed} not added`);
    if (job.state === "failed") {
      const there = /There's no folder at/.test(job.error ?? "");
      this.set({ error: there ? `The server can't see ${name}: it adds folders from its own computer. Pick one there.` : `Couldn't add ${name} to the server: ${job.error ?? "it stopped"}` });
    } else if (p.failed > 0) {
      const why = p.notes.filter((n) => !n.endsWith("already on the server."));
      this.set({ error: `${p.added} ${p.added === 1 ? "book" : "books"} from ${name} added. ${p.failed} couldn't be: ${why.slice(0, 3).join(" ")}${why.length > 3 ? ` And ${why.length - 3} more.` : ""}` });
    }
  }

  /** Each import's own number, to keep it by. */
  private nextImport = 0;

  /**
   * One status for all of a server's imports, which its server runs one at a
   * time: the folder being added, and how many wait behind it. Null when
   * nothing is being added.
   */
  private importStatus(o: Opened): ScanStatus | null {
    const all = [...o.serverImports.values()];
    if (all.length === 0) return null;
    const now = all.find((i) => i.job?.state === "running") ?? all[0]!;
    const p = now.job?.progress;
    const done = p ? p.added + p.skipped + p.failed : 0;
    const waiting = all.length - 1;
    const doing =
      now.job?.state === "waiting" ? `Waiting to add ${now.name}…` : !p || p.found === 0 ? `Looking through ${now.name}…` : p.current ? `Adding ${p.current}, ${Math.min(done + 1, p.found)} of ${p.found}…` : `Adding ${done} of ${p.found}…`;
    return {
      walked: p?.found ?? 0,
      done,
      background: this.state.books.length > 0,
      stage: waiting > 0 ? `${doing} Then ${waiting} more ${waiting === 1 ? "folder" : "folders"}.` : doing,
      copying: true,
    };
  }

  /** Stop carrying a server source's places: before it's linked again, or goes. */
  private letGoOfServerPlaces(o: Opened): void {
    if (!o.serverPlaces) return;
    o.serverPlaces.events.abort();
    if (o.serverPlaces.soon) clearTimeout(o.serverPlaces.soon);
    if (o.serverRefreshSoon) clearTimeout(o.serverRefreshSoon);
    o.serverRefreshSoon = null;
    o.serverPlaces = null;
    o.lib.onAppend = null;
  }

  /** Catch up with every server: when the window comes back, say. */
  private syncAllServers(): void {
    for (const o of this.openedInOrder()) if (o.serverPlaces) void this.syncPlaces(o);
  }

  /** Ask a server what it has now, and fetch the covers the shelf will draw. */
  private async refreshServer(o: Opened): Promise<void> {
    const shelf = o.server;
    if (!shelf) return;
    const alive = () => this.opened.get(o.source.id) === o && o.server === shelf;
    try {
      if ((await shelf.refresh()) && alive()) this.publishBooks();
    } catch (e) {
      log.warn("could not ask the server for its books:", o.source.name, describe(e));
      if (alive() && e instanceof ServerError && e.status === 401) this.setSourceStatus(o.source.id, { error: "Sign in to the server again." });
    }
    // The covers kept here show even when the server is out of reach.
    const found = await shelf.fetchCovers().catch(() => 0);
    if (found > 0 && alive()) this.publishBooks({ coverVersion: this.state.coverVersion + 1 });
  }

  /**
   * Download a server's book before it plays or opens, the space checked
   * first. The book as it is on this device afterwards, or null when it
   * isn't (not enough space, the server out of reach).
   */
  private async downloadRemote(book: ScannedBook): Promise<ScannedBook | null> {
    const o = this.openedOf(book);
    const serverId = book.remote?.serverId;
    if (!o?.server || !serverId || this.state.downloads[book.book.id]) return null;
    const id = book.book.id;
    this.set({ downloads: { ...this.state.downloads, [id]: { done: 0, total: book.book.sizeBytes } }, spaceShort: null });
    try {
      await o.server.download(book, (done, total) => this.set({ downloads: { ...this.state.downloads, [id]: { done, total } } }));
      await this.rescanSource(o, true);
      return o.books.find((b) => b.book.path === serverId || b.book.path.startsWith(`${serverId}/`)) ?? null;
    } catch (e) {
      if (e instanceof NotEnoughSpace) this.set({ spaceShort: { bookId: id, title: book.book.title, neededBytes: e.neededBytes, freeBytes: e.freeBytes } });
      else this.set({ error: `Couldn't download ${book.book.title}: ${describe(e)}` });
      return null;
    } finally {
      const { [id]: _done, ...rest } = this.state.downloads;
      this.set({ downloads: rest });
    }
  }

  /** Download a server's book without opening it: after making room, say. */
  async downloadBook(bookId: string): Promise<void> {
    const book = this.state.books.find((b) => b.book.id === bookId);
    if (book?.remote) await this.downloadRemote(book);
  }

  /** The books downloaded from servers, biggest first: what the person can remove to make room. */
  downloadedBooks(): ScannedBook[] {
    return this.state.books.filter((b) => !b.remote && this.openedOf(b)?.server).sort((a, b) => b.book.sizeBytes - a.book.sizeBytes);
  }

  /** Take a server's book off this device. The server keeps it, and the person's place in it. */
  async removeDownload(bookId: string): Promise<void> {
    const book = this.state.books.find((b) => b.book.id === bookId);
    const o = book && this.openedOf(book);
    if (!book || !o?.server || book.remote) return;
    if (this.state.current?.book.book.id === bookId) await this.letGoOfCurrent();
    await o.server.remove(book.book.path.split("/")[0]!);
    await this.rescanSource(o, true);
  }

  /** The person chose not to make room: the book stays on the server. */
  dismissSpaceShort(): void {
    this.set({ spaceShort: null });
  }

  /** Stop the open book, its place kept, before its files go. */
  private async letGoOfCurrent(): Promise<void> {
    if (this.state.player.playing) {
      this.engine?.pause();
      await this.persistPosition("pause");
    }
    this.chapterProbe?.abort();
    this.engine?.pause();
    this.set({ current: null, playerExpanded: false, playerDrawer: null, resumeOffer: null, previewing: null });
  }

  async removeSource(id: string): Promise<void> {
    const o = this.opened.get(id);
    const source = this.state.sources.find((s) => s.id === id);
    if (!source) return;
    log.info("remove source", source.root);
    if (this.state.current?.book.source === id) await this.letGoOfCurrent();
    this.jobs.cancelWhere((b) => b.source === id);
    const gone = new Set(this.state.books.filter((b) => b.source === id).map((b) => b.book.id));
    if (o) {
      await o.keeper.close().catch(() => undefined);
      // The places still to send go before the downloads do.
      await o.serverPlaces?.log.sync().catch((e: unknown) => log.warn("could not send the last places to the server:", describe(e)));
      this.letGoOfServerPlaces(o);
      o.coverJob?.abort();
      o.lookup?.stop();
      this.opened.delete(id);
    }
    this.updateCanAddFolders();
    // A server's downloads are Ribbon's own files: they go, and the sign-in with them.
    if (source.server) {
      await o?.server?.removeAll().catch((e: unknown) => log.warn("could not remove a server's downloads:", describe(e)));
      await this.keepServerToken(source.server, null);
    }
    const { [id]: _dropped, ...sourceStatus } = this.state.sourceStatus;
    const series = Object.fromEntries(Object.entries(this.state.series).filter(([k]) => !o?.seriesKeys.has(k)));
    const about = Object.fromEntries(Object.entries(this.state.about).filter(([k]) => !gone.has(k)));
    const jobs = Object.fromEntries(Object.entries(this.state.jobs).filter(([k]) => !gone.has(k)));
    this.set({
      sources: this.state.sources.filter((s) => s.id !== id),
      sourceStatus,
      readOnlyNotice: this.state.readOnlyNotice.filter((s) => s !== id),
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
    // A server's book not downloaded yet: its cover once it's fetched.
    if (book.remote) return book.remote.cover && o.server?.hasCover(book.remote.cover.hash) ? this.platform.fileUrl(o.lib.absPath(book.book.cover)) : null;
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
      onLog: (m) => log.info(m),
      exactUrl: this.platform.exactAudioUrl
        ? (rel, ms) => {
            const cur = this.state.current;
            const lib = (cur && this.libOf(cur.book)) ?? this.openedInOrder()[0]?.lib;
            return lib ? this.platform.exactAudioUrl!(lib.absPath(rel), ms) : null;
          }
        : undefined,
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
    // A server's book is downloaded before it plays (docs/SERVER.md, section 8).
    if (book.remote) {
      const here = await this.downloadRemote(book);
      if (!here) return;
      book = here;
    }
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
    this.set({ current, playerExpanded: expand, playerDrawer: null, resumeOffer: null });
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
    this.prepareAudio(lib, book);
    if (opts.autoplay) await this.play();
  }

  /** Index a book's MP3s in the background, so the first seek in one does not wait for it (frames.rs). */
  private prepareAudio(lib: Opened["lib"], book: ScannedBook): void {
    const mp3s = book.files.filter((f) => /\.mp3$/i.test(f.path)).map((f) => lib.absPath(f.path));
    if (mp3s.length > 0) void lib.host.audioPrepare?.(mp3s).catch(() => undefined);
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
    this.maybeNudgeSpeech(bookId);
    // A server's book is downloaded before it opens, as before it plays.
    if (book.remote) {
      const here = await this.downloadRemote(book);
      if (here) await this.openReading(here.book.id);
      return;
    }
    if (this.state.reading) await this.closeReading();
    perf.begin("open the reader");
    this.set({ reading: { bookId, status: "opening" }, playerExpanded: false });
    const started = performance.now();
    // Everything the reader needs, read at once: over a share each is a round trip of its own.
    const steps: string[] = [];
    const timed = <T>(name: string, p: Promise<T>): Promise<T> =>
      p.finally(() => {
        steps.push(`${name} ${Math.round(performance.now() - started)}`);
      });
    // Read-along's records (pairing fixes, what was heard, the transcript), read alongside the text. Kept from an
    // earlier opening in this session, they are not read again.
    const known = this.readingData.get(bookId);
    const records: Promise<ReadingData> = known
      ? Promise.resolve(known)
      : Promise.all([timed("pairing", o.lib.readPairing(bookId)), timed("heard", o.lib.readHeard(bookId)), timed("aligned", o.lib.readAligned(bookId))]).then(([fixes, heard, aligned]) => ({
          ...emptyReading(),
          fixes,
          heard: heard.heard,
          anchors: heard.anchors,
          spans: aligned.spans,
          said: aligned.said,
          aligned: new Map(aligned.said.filter((s) => s.chars !== null).map((s) => [s.startMs, s.chars!])),
        }));
    // A failure is reported where the records are awaited, not as unhandled meanwhile.
    records.catch(() => undefined);
    const [result, withChapters, shared] = await Promise.all([
      timed("text", openEbook(o.lib.host, o.lib.root, book.book)),
      // The audio's chapters, read from the file if they never were, to pair with the text's.
      timed("chapters", this.chaptersOf(o, book)),
      timed(
        "places",
        o.lib
          .readTextPlaces()
          .then((m) => {
            const r = m.get(bookId);
            return r ? { loc: r.loc, t: r.t } : undefined;
          })
          .catch(() => undefined),
      ),
    ]);
    if (this.state.reading?.bookId !== bookId) return;
    if (!result.ok) {
      log.warn(`could not open the text of ${book.book.title}: ${result.message}`);
      this.set({ reading: { bookId, status: "failed", message: result.message } });
      return;
    }
    const ebook = result.ebook;
    const text = new BookText(ebook);
    const audio = !readerOnly(book.book);
    const kept = this.keptPlaces()[bookId];
    // Opened while its audio plays: the pages follow the narrator.
    const following = this.state.current?.book.book.id === bookId && this.state.player.playing;
    // The book opens at the newest of this machine's reading place, the log's, and the narrator's. Only the
    // narrator's needs the text paired with the audio first; when it is not the newest, the book opens at
    // once and is paired just after, so the page can be read and turned while read-along gets ready.
    const narrator = audio ? this.narratorWhen(bookId) : undefined;
    const readAt = Math.max(-Infinity, ...[kept, shared].map((k) => (k ? Date.parse(k.t) : NaN)).filter((t) => !Number.isNaN(t)));
    const early = audio && !following && (!narrator || readAt >= Date.parse(narrator.t));

    /** The records read, kept for this session, and the text paired with the audio; null if the reader moved on meanwhile. */
    const pair = async (): Promise<{ rd: ReadingData; alignment: Alignment | undefined } | null> => {
      const rd = await records;
      if (this.state.reading?.bookId !== bookId) return null;
      this.readingData.set(bookId, rd);
      this.rd = rd;
      rd.overlay = overlayAnchors(text, { files: withChapters.files.map((f) => ({ path: f.path, durationMs: f.durationMs })), durationMs: withChapters.book.durationMs });
      if (rd.overlay) log.info(`${book.book.title} has a Media Overlay for this recording: ${rd.overlay.length} passages`);
      // A book that is only its EPUB has no audio to pair the text with.
      const paired = performance.now();
      const alignment = audio ? this.pairUp(text, withChapters, rd) : undefined;
      steps.push(`pair ${Math.round(performance.now() - paired)}`);
      if (alignment) log.info(`paired the text of ${book.book.title} with its audio by ${alignment.how}: ${alignment.pairs.length} chapters`);
      return { rd, alignment };
    };
    /** Show the text at this place: the reader is ready to read. */
    const show = (place: TextPlace, alignment: Alignment | undefined) => {
      this.readingKeeper = new ReadingKeeper(text, place, {
        keepLocal: (k) => {
          this.appSettings = { ...this.appSettings, readingPlaces: { ...this.keptPlaces(), [bookId]: k } };
          this.saveAppSettingsSoon();
        },
        share: (loc, why, at, ms) => o.lib.writeTextPlace(bookId, ebook.meta.identifiers, loc, why, at, ms),
        // The pairing arrives after the text, and can be fixed while the book is open: always the latest.
        toMs: (p) => {
          const a = this.state.reading?.alignment ?? alignment;
          return a ? textToMs(a, text.chars(p)) : null;
        },
      });
      const highlights = this.highlightsFor(bookId);
      this.set({ reading: { bookId, status: "ready", text, place, ...(alignment ? { alignment } : {}), ...(following ? { following } : {}), ...(highlights.length > 0 ? { highlights } : {}) } });
    };
    /** With the text paired: listening from the page, hearing the narration, read-along. */
    const listen = (rd: ReadingData) => {
      this.readingCtx = { o, book: withChapters, text, rd, early };
      this.prepareAudio(o.lib, withChapters);
      void this.hearPlaces();
    };

    if (early) {
      show(openingPlace(text, kept, shared), undefined);
      log.info(`opened the text of ${book.book.title} in ${Math.round(performance.now() - started)} ms, pairing it next: ${ebook.sections.length} sections; done at (ms) ${steps.join(", ")}`);
      let done: Awaited<ReturnType<typeof pair>>;
      try {
        // The page is drawn first: pairing holds the main thread a while.
        await afterNextPaint();
        done = await pair();
      } catch (e) {
        log.warn(`could not read the read-along records of ${book.book.title}: ${String(e)}`);
        return;
      }
      // Still this opening of the book: not closed, nor opened again meanwhile.
      const r = this.state.reading;
      if (!done || r?.status !== "ready" || r.text !== text) return;
      if (done.alignment) this.set({ reading: { ...r, alignment: done.alignment } });
      log.info(`paired ${book.book.title} ${Math.round(performance.now() - started)} ms after opening began: ${steps.join(", ")}`);
      listen(done.rd);
      return;
    }
    const done = await pair();
    if (!done || this.state.reading?.status !== "opening") return;
    const { rd, alignment } = done;
    show(openingPlace(text, kept, shared, alignment && narrator && { place: text.place(msToText(alignment, narrator.ms)), t: narrator.t }), alignment);
    log.info(`opened the text of ${book.book.title} in ${Math.round(performance.now() - started)} ms: ${ebook.sections.length} sections; done at (ms) ${steps.join(", ")}`);
    listen(rd);
  }

  /** How much of the open book's narration is transcribed: minutes done, of all. The export waits for all of it. */
  narrationTranscribed(): { done: number; total: number } | null {
    const ctx = this.readingCtx;
    if (!ctx || ctx.book.files.length === 0) return null;
    let done = 0;
    let total = 0;
    let t = 0;
    for (const f of ctx.book.files) {
      for (let offset = 0; offset < f.durationMs - 1000; offset += SPAN_MS) {
        total++;
        if (ctx.rd.spans.has(t + offset)) done++;
      }
      t += f.durationMs;
    }
    return { done, total };
  }

  /**
   * Make the open book's read-along EPUB beside its own (docs/READING.md,
   * section 6): its text with every sentence timed to its narration, and
   * the narration inside, as Media Overlays any reader can play. The
   * original is never touched.
   */
  async exportReadAlong(): Promise<void> {
    const ctx = this.readingCtx;
    const r = this.state.reading;
    const host = ctx?.o.lib.host;
    if (!ctx || !r?.text || !r.alignment || r.exporting || !host?.exportEbook || !ctx.book.book.ebook) return;
    const { o, book } = ctx;
    const plan = exportPlan(r.text, r.alignment, book.files.map((f) => ({ path: o.lib.absPath(f.path), durationMs: f.durationMs })), o.lib.absPath(book.book.ebook!));
    const started = performance.now();
    const { exported: _, ...rest } = r;
    this.set({ reading: { ...rest, exporting: { done: 0, total: plan.sections.length } } });
    const update = (patch: Partial<ReadingState>) => {
      const now = this.state.reading;
      if (now?.bookId === r.bookId) this.set({ reading: { ...now, ...patch } });
    };
    try {
      const path = await host.exportEbook.call(host, plan, (done, total) => update({ exporting: { done, total } }));
      log.info(`exported the read-along EPUB of ${book.book.title} in ${Math.round((performance.now() - started) / 1000)} s: ${plan.sections.length} chapters, ${plan.sections.reduce((n, s) => n + s.sentences.length, 0)} sentences`);
      update({ exported: { path } });
    } catch (e) {
      log.warn("could not export the read-along EPUB:", describe(e));
      update({ exported: { error: describe(e) } });
    } finally {
      const now = this.state.reading;
      if (now?.bookId === r.bookId && now.exporting) {
        const { exporting: _x, ...left } = now;
        this.set({ reading: left });
      }
    }
  }

  /** In the reader: show the text now, while read-along gets ready behind it. */
  readNow(): void {
    const r = this.state.reading;
    if (!r?.preparing) return;
    const { preparing: _, ...rest } = r;
    this.set({ reading: rest });
  }

  /**
   * Everything heard, transcribed and fixed for the book open to read, as
   * that book's own object: work still running for a book that was closed
   * keeps and saves that book's, never the next one's. (Until 0.10.1 they
   * were the controller's own fields, emptied on close; a transcription
   * still finishing then saved the emptied transcript over the book's.)
   * Kept for the session, so a book opened again reads none of it again.
   */
  private rd: ReadingData = emptyReading();
  private readingData = new Map<string, ReadingData>();
  private readingIndex: { text: BookText; index: WordAt[] } | null = null;
  /** The open book with its text paired; `early` when the reader opened before the pairing (openReading). */
  private readingCtx: { o: Opened; book: ScannedBook; text: BookText; rd: ReadingData; early?: boolean } | null = null;
  private hearing = false;
  /** How long a clip took to hear, last measured: a fast machine hears the whole book, a slow one only around the reader. */
  private msPerClip: number | null = null;

  private anchorList(rd = this.rd): Anchor[] {
    return [...rd.anchors, ...rd.aligned].map(([ms, chars]) => ({ ms, chars }));
  }

  /** The open book's text paired with its audio: by its Media Overlay when it has one for this recording, else by chapters, with every checkpoint heard. */
  private pairUp(text: BookText, book: ScannedBook, rd = this.rd): Alignment {
    const a = alignBook(text, book.chapters, book.book.durationMs, { generated: generatedTitles(book.chapters), fixes: rd.fixes, heard: rd.heard, anchors: this.anchorList(rd) });
    return rd.overlay ? byOverlay(text, a, rd.overlay, book.book.durationMs) : a;
  }

  /** The open book paired again with everything heard and fixed so far. */
  private realign(text: BookText, book: ScannedBook, rd = this.rd): Alignment {
    return this.pairUp(text, this.state.books.find((b) => b.book.id === book.book.id) ?? book, rd);
  }

  /**
   * Time how long this machine takes to hear a clip, the way it hears
   * them: one clip first to load the model and wake the GPU (seconds, once
   * a session), then six at once, as fetching them over a share is what
   * one at a time would measure.
   */
  private async timeClips(ctx: { o: Opened; book: ScannedBook }, model: string, language: string | null): Promise<void> {
    const { o, book } = ctx;
    const hear = o.lib.host.speechOpenings;
    const total = book.book.durationMs;
    if (!hear || total <= 0) return;
    const durations = book.files.map((f) => f.durationMs);
    const clip = (ms: number) => {
      const at = locate_(durations, ms);
      return { path: o.lib.absPath(book.files[at.fileIndex]!.path), startMs: Math.round(at.fileOffsetMs) };
    };
    try {
      await hear.call(o.lib.host, model, [clip(total / 2)], HEAR_SECONDS, language);
      const six = [1, 2, 3, 4, 5, 6].map((k) => clip((total * k) / 7));
      const t0 = performance.now();
      await hear.call(o.lib.host, model, six, HEAR_SECONDS, language);
      this.msPerClip = (performance.now() - t0) / six.length;
      this.appSettings = { ...this.appSettings, speechClipMs: Math.round(this.msPerClip) };
      this.saveAppSettingsSoon();
      log.info(`hearing takes ${Math.round(this.msPerClip)} ms a clip on this machine`);
    } catch (e) {
      log.warn("could not time hearing on this machine:", describe(e));
    }
  }

  /** How long a clip took to hear on this machine, as last measured in any book. */
  private clipMs(): number | null {
    if (this.msPerClip !== null) return this.msPerClip;
    const kept = Number(this.appSettings.speechClipMs);
    return Number.isFinite(kept) && kept > 0 ? kept : null;
  }

  private keepAligned(rd: ReadingData, bookId: string, lib: Opened["lib"], now = false): Promise<void> {
    if (!rd.dirty || (!now && Date.now() - rd.written < ALIGNED_WRITE_MS)) return Promise.resolve();
    rd.dirty = false;
    rd.written = Date.now();
    return lib.writeAligned(bookId, rd.spans, rd.said).catch((e: unknown) => log.warn("could not keep the transcript:", describe(e)));
  }

  /**
   * Transcribe stretches of the open book's narration and match each to the
   * text (#57): every phrase found becomes a checkpoint, a few seconds
   * apart, so read-along can mark the sentence being read.
   */
  private async alignStretches(ctx: { o: Opened; book: ScannedBook; text: BookText; rd: ReadingData }, model: string, language: string | null, stretches: { startMs: number; endMs: number; file: number; offset: number }[]): Promise<void> {
    const { o, book, text, rd } = ctx;
    const host = o.lib.host;
    const batch = stretches.slice(0, SPANS_PER_CALL);
    const clips = batch.map((x) => ({ path: o.lib.absPath(book.files[x.file]!.path), startMs: x.offset }));
    const said = await host.speechTranscribe!.call(host, model, clips, SPAN_MS / 1000, language);
    const a = this.state.reading?.alignment;
    if (this.readingIndex?.text !== text) this.readingIndex = { text, index: wordIndex(text) };
    const index = this.readingIndex.index;
    batch.forEach((x, i) => {
      rd.spans.set(x.startMs, x.endMs);
      rd.dirty = true;
      // The file's times, as the book's.
      const shift = x.startMs - x.offset;
      const phrases = (said[i] ?? []).map((s) => ({ startMs: s.startMs + shift, endMs: s.endMs + shift, words: s.words.trim() })).filter((s) => s.words);
      if (!a || phrases.length === 0) return;
      const m = matchTranscript(index, phrases, msToText(a, x.startMs) - SPAN_SLACK, msToText(a, x.endMs) + SPAN_SLACK);
      for (const an of m.anchors) rd.aligned.set(an.ms, an.chars);
      for (const p of phrases) {
        const an = m.anchors.find((z) => z.ms >= p.startMs && z.ms < p.endMs);
        rd.said.push(an ? { ...p, startMs: an.ms, chars: an.chars } : { ...p, chars: null });
      }
    });
  }

  /** Find heard words in the text near where the pairing puts them, and keep them as a checkpoint when found. */
  private anchorHeard(rd: ReadingData, text: BookText, alignment: Alignment, ms: number, words: string): boolean {
    const pair = alignment.pairs.find((p) => ms >= p.audio.startMs && ms < p.audio.endMs);
    if (!pair || alignment.how !== "chapter") return false;
    if (this.readingIndex?.text !== text) this.readingIndex = { text, index: wordIndex(text) };
    const pace = (pair.text.end - pair.text.start) / Math.max(1, pair.audio.endMs - pair.audio.startMs);
    const found = locate(this.readingIndex.index, words, msToText(alignment, ms), Math.max(1500, SEARCH_MS * pace));
    if (found) rd.anchors.set(ms, found.chars);
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
  private hearAgain = false;

  private async hearPlaces(): Promise<void> {
    const ctx = this.readingCtx;
    const model = this.state.speech.model;
    if (!ctx || !model) return;
    // Already hearing (another book, or this one before it was reopened): once that stops, start again.
    if (this.hearing) {
      this.hearAgain = true;
      return;
    }
    const hear = ctx.o.lib.host.speechOpenings;
    if (!hear) return;
    // A Media Overlay is exact: nothing to hear.
    if (this.state.reading?.alignment?.how === "overlay") return;
    const { o, book, text, rd } = ctx;
    const bookId = book.book.id;
    const durations = book.files.map((f) => f.durationMs);
    const language = (text.ebook.meta.language || book.book.language || "").slice(0, 2).toLowerCase() || null;
    const still = () => this.readingCtx === ctx && this.state.reading?.bookId === bookId && this.state.reading.status === "ready";
    const heardNear = (ms: number) => [...rd.heard.keys()].some((h) => Math.abs(h - ms) < HEARD_NEAR_MS);
    // A machine that hears a clip quickly (a GPU) hears every chapter's opening, and transcribes the whole narration.
    const fast = () => {
      const ms = this.clipMs();
      return ms !== null && ms < FAST_CLIP_MS;
    };
    const transcribes = () => fast() && !!ctx.o.lib.host.speechTranscribe;
    const doubts = (): number[] => {
      const a = this.state.reading?.alignment;
      const latest = this.state.books.find((b) => b.book.id === bookId) ?? book;
      const starts = !a || a.how === "proportion" || fast() ? latest.chapters.map((c) => c.startMs) : a.pairs.filter((p) => p.confidence < DOUBT && !p.fixed).map((p) => p.audio.startMs);
      return [...new Set(starts)].filter((ms) => !rd.heard.has(ms)).sort((x, y) => x - y);
    };
    const checkpoints = (): number[] => {
      const a = this.state.reading?.alignment;
      const place = this.state.reading?.place;
      if (!a || a.how !== "chapter" || !place || transcribes()) return [];
      const here = text.chars(place);
      const readerMs = textToMs(a, here);
      let at = a.pairs.findIndex((p) => here >= p.text.start && here < p.text.end);
      if (at < 0) at = Math.max(0, a.pairs.findIndex((p) => here < p.text.start));
      const order = a.pairs.map((_, i) => i).filter((i) => Math.abs(i - at) <= 1).sort((x, y) => Math.abs(x - at) - Math.abs(y - at) || x - y);
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
    /** Stretches of the narration not yet transcribed, from just before where the narrator or the reader is, onward first. */
    /** Where the listener is: the narrator, when this book plays, else the reader's place in the audio. */
    const focusMs = (): number => {
      const a = this.state.reading?.alignment;
      const place = this.state.reading?.place;
      if (this.state.current?.book.book.id === bookId) return this.state.player.positionMs;
      return a && place ? textToMs(a, text.chars(place)) : 0;
    };
    const stretches = (): { startMs: number; endMs: number; file: number; offset: number }[] => {
      const a = this.state.reading?.alignment;
      if (!transcribes() || !a || a.how !== "chapter") return [];
      const focus = focusMs();
      const out: { startMs: number; endMs: number; file: number; offset: number }[] = [];
      let t = 0;
      book.files.forEach((f, file) => {
        for (let offset = 0; offset < f.durationMs - 1000; offset += SPAN_MS) if (!rd.spans.has(t + offset)) out.push({ startMs: t + offset, endMs: t + Math.min(f.durationMs, offset + SPAN_MS), file, offset });
        t += f.durationMs;
      });
      const key = (x: { startMs: number }) => (x.startMs >= focus - SPAN_MS ? x.startMs - focus : 2 * (focus - x.startMs));
      return out.sort((x, y) => key(x) - key(y));
    };
    /** Untranscribed minutes around the listener: what the reader waits for, and what is always transcribed first. */
    const near = () => {
      const focus = focusMs();
      return stretches().filter((x) => x.endMs > focus - SPAN_MS && x.startMs < focus + READY_MS);
    };
    const ready = () => {
      const r = this.state.reading;
      if (r?.bookId === bookId && r.preparing) {
        const { preparing: _, ...rest } = r;
        this.set({ reading: rest });
      }
    };
    // The reader waits for read-along when this machine may transcribe and the minutes around it are not done.
    const a0 = this.state.reading?.alignment;
    const mayTranscribe = !!ctx.o.lib.host.speechTranscribe && a0?.how === "chapter" && (this.clipMs() === null || fast());
    // Not for a book opened before its pairing: its page is already being read, and read-along catches up beside it.
    if (mayTranscribe && !ctx.early && (this.clipMs() === null || near().length > 0)) this.set({ reading: { ...this.state.reading!, preparing: true } });
    // Never timed on this machine (an older Ribbon heard everything near already): time it now, so a
    // machine that can transcribes the whole narration rather than waiting for something to hear.
    if (this.clipMs() === null) {
      this.hearing = true;
      try {
        await this.timeClips(ctx, model, language);
      } finally {
        this.hearing = false;
      }
      if (!still()) return ready();
    }
    if (near().length === 0) ready();
    if (doubts().length === 0 && checkpoints().length === 0 && stretches().length === 0) return;
    this.hearing = true;
    const started = performance.now();
    let done = 0;
    let found = 0;
    let spans = 0;
    try {
      while (still()) {
        // The minutes around the listener come first, always: then the reader can show the text.
        const close = near();
        if (close.length > 0) {
          this.set({ reading: { ...this.state.reading!, listening: { done: rd.spans.size, total: rd.spans.size + stretches().length, what: "aligning" } } });
          await this.alignStretches(ctx, model, language, close);
          spans += Math.min(SPANS_PER_CALL, close.length);
          await this.keepAligned(rd, bookId, o.lib);
          if (!still()) break;
          this.set({ reading: { ...this.state.reading!, alignment: this.realign(text, book, rd) } });
          if (near().length === 0) ready();
          continue;
        }
        ready();
        let todo = doubts();
        if (todo.length === 0) {
          const left = stretches();
          if (left.length > 0) {
            this.set({ reading: { ...this.state.reading!, listening: { done: rd.spans.size, total: rd.spans.size + left.length, what: "aligning" } } });
            await this.alignStretches(ctx, model, language, left);
            spans += Math.min(SPANS_PER_CALL, left.length);
            await this.keepAligned(rd, bookId, o.lib);
            if (!still()) break;
            this.set({ reading: { ...this.state.reading!, alignment: this.realign(text, book, rd) } });
            continue;
          }
        }
        if (done >= MAX_HEARD) break;
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
        this.appSettings = { ...this.appSettings, speechClipMs: Math.round(this.msPerClip) };
        this.saveAppSettingsSoon();
        const before = this.state.reading?.alignment;
        batch.forEach((ms, i) => {
          const w = (words[i] ?? "").trim();
          rd.heard.set(ms, w);
          if (what === "checkpoints" && before && this.anchorHeard(rd, text, before, ms, w)) found++;
        });
        done += batch.length;
        await o.lib.writeHeard(bookId, rd.heard, rd.anchors).catch((e: unknown) => log.warn("could not keep what was heard:", describe(e)));
        if (!still()) break;
        this.set({ reading: { ...this.state.reading!, alignment: this.realign(text, book, rd) } });
      }
      log.info(`heard ${done} places in ${book.book.title} (${found} found in the text) and transcribed ${spans} minutes in ${Math.round((performance.now() - started) / 1000)} s, ${Math.round(this.msPerClip ?? 0)} ms a clip`);
    } catch (e) {
      log.warn("could not hear the narrator:", describe(e));
    } finally {
      this.hearing = false;
      ready();
      if (this.hearAgain) {
        this.hearAgain = false;
        if (this.readingCtx && this.readingCtx !== ctx) void this.hearPlaces();
      }
      await this.keepAligned(rd, bookId, o.lib, true);
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
    const rd = ctx?.rd ?? this.rd;
    if (this.anchorList(rd).some((a) => Math.abs(a.ms - ms) < PINPOINT_MS)) return false;
    const { o, book, text } = ctx;
    const at = locate_(book.files.map((f) => f.durationMs), ms);
    this.set({ reading: { ...r, finding: true } });
    try {
      const language = (text.ebook.meta.language || book.book.language || "").slice(0, 2).toLowerCase() || null;
      const [w] = await hear.call(o.lib.host, model, [{ path: o.lib.absPath(book.files[at.fileIndex]!.path), startMs: Math.round(at.fileOffsetMs) }], HEAR_SECONDS, language);
      const words = (w ?? "").trim();
      rd.heard.set(ms, words);
      const found = this.anchorHeard(rd, text, r.alignment, ms, words);
      void o.lib.writeHeard(book.book.id, rd.heard, rd.anchors).catch(() => undefined);
      if (found && this.state.reading?.bookId === book.book.id) this.set({ reading: { ...this.state.reading, alignment: this.realign(text, book, rd) } });
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


  /** The open book's pairing, as fixed by hand. */
  pairingFixes(): readonly PairingFix[] {
    return this.rd.fixes;
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
    if (!r?.text || !book || !o) return;
    const fixes = this.rd.fixes.filter((f) => f.text !== textRef);
    if (choice !== "auto") fixes.push({ text: textRef, audioMs: choice });
    this.rd.fixes = fixes;
    const alignment = this.pairUp(r.text, book);
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
      const probed = await o.lib.ensureChapters(book, undefined, (e) => log.warn("could not keep the chapters of", book.book.title, "beside the book; using them for now:", describe(e)));
      if (probed === book) return book;
      const updated = this.stamp(o, [probed])[0]!;
      this.replaceBook(o, updated);
      return updated;
    } catch (e) {
      log.warn("could not read the chapters of", book.book.title, describe(e));
      return book;
    }
  }

  /** Where the narrator is in a book's audio, and when that was so. */
  private narratorWhen(bookId: string): { ms: number; t: string } | undefined {
    const live = this.state.current?.book.book.id === bookId && this.engine?.current.bookId === bookId;
    const ms = live ? this.engine!.positionMs() : this.state.positions[bookId]?.offsetMs;
    if (ms === undefined) return undefined;
    // Playing now is now; paused, it is when it paused.
    const t = live && this.state.player.playing ? new Date().toISOString() : live && this.pausedAt !== null ? new Date(this.pausedAt).toISOString() : (this.state.positions[bookId]?.updatedAt ?? new Date(0).toISOString());
    return { ms, t };
  }

  /** In the reader: the narrator's place in the text, or null when this book's audio is not loaded. */
  narratorInText(): TextPlace | null {
    const r = this.state.reading;
    if (!r?.text || !r.alignment || this.state.current?.book.book.id !== r.bookId) return null;
    return r.text.place(msToText(r.alignment, this.narratorMs()));
  }

  /** The moment of the recording the text follows: the player's, held at the sentence during a Listen from here's lead-in. */
  narratorMs(positionMs = this.state.player.positionMs): number {
    return followedMs(positionMs, this.listenedFrom);
  }

  /** In the reader: turn to where the narrator is, heard first when no checkpoint is near, and follow it from there. */
  async goToNarrator(): Promise<void> {
    if (!this.narratorInText()) return;
    await this.pinpoint(this.state.player.positionMs);
    const p = this.narratorInText();
    if (p) this.moveReading(p, "seek", "follow");
    this.setFollowing(true);
  }

  /** In the reader: follow the narrator, or stop. */
  setFollowing(on: boolean): void {
    const r = this.state.reading;
    if (!r || !!r.following === on) return;
    if (on) this.set({ reading: { ...r, following: true } });
    else {
      const { following: _, ...rest } = r;
      this.set({ reading: rest });
    }
  }

  /** In the reader: play this book's audio from a place in the text, the top of the page unless one is given (a tapped sentence). */
  async listenFromHere(at?: TextPlace): Promise<void> {
    const r = this.state.reading;
    if (!r?.text || !r.alignment || !r.place) return;
    const book = this.state.books.find((b) => b.book.id === r.bookId);
    if (!book) return;
    const chars = r.text.chars(at ?? r.place);
    // Heard first when no checkpoint is near, so the narrator starts on the page's first words.
    await this.pinpoint(textToMs(r.alignment, chars));
    const alignment = this.state.reading?.alignment ?? r.alignment;
    const ms = textToMs(alignment, chars);
    if (this.state.current?.book.book.id !== r.bookId) await this.openBook(book, { expand: false });
    if (this.state.current?.book.book.id !== r.bookId) return;
    // A moment early, so a sentence placed a little late still starts on its first word (LEAD_IN_MS).
    this.seek(Math.max(0, ms - LEAD_IN_MS));
    this.listenedFrom = ms;
    await this.play();
    this.setFollowing(true);
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

  /**
   * The reader is on a new page, or scrolled to a new line. By hand, it
   * stops following the narrator; turned by following, or a scroll that
   * may be either (the scroll's own input says which), it does not.
   */
  moveReading(place: TextPlace, why: Why = "periodic", by: "hand" | "follow" | "scroll" = "hand"): void {
    const r = this.state.reading;
    if (!r || r.status !== "ready" || !this.readingKeeper) return;
    const p = r.place;
    if (p && p.section === place.section && p.block === place.block && p.offset === place.offset) return;
    this.readingKeeper.move(place, why);
    const { following, ...rest } = r;
    this.set({ reading: { ...rest, place, ...(following && by !== "hand" ? { following } : {}) } });
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
    this.rd = emptyReading();
  }

  /** A URL for an image in the open book's text, when it was kept on this machine. */
  readingImageUrl(src: string): string | undefined {
    const abs = this.state.reading?.text?.ebook.files?.[src];
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
    this.maybeNudgeSpeech(bookId);
  }

  /**
   * The first time a book with both its text and its audio opens on a
   * computer with no speech model, say once what one does. Phones don't
   * transcribe, and a device that has a model, or was told, isn't told again.
   */
  private maybeNudgeSpeech(bookId: string): void {
    const book = this.state.books.find((b) => b.book.id === bookId);
    if (!book?.book.ebook || readerOnly(book.book)) return;
    if (this.platform.phone || !this.platform.host.downloadSpeechModel || this.state.speech.model || this.state.speech.downloading) return;
    if (this.appSettings.speechNudged === true) return;
    this.appSettings = { ...this.appSettings, speechNudged: true };
    void this.platform.appSettings?.write(this.appSettings).catch((e: unknown) => log.warn("could not save settings:", describe(e)));
    this.set({ speechNudge: true });
  }

  /** The nudge's Download: the same download Settings starts. */
  downloadSpeechModelFromNudge(): Promise<void> {
    this.set({ speechNudge: false });
    return this.downloadSpeechModel();
  }

  dismissSpeechNudge(): void {
    this.set({ speechNudge: false });
  }

  private async probeChapters(book: ScannedBook): Promise<void> {
    const o = this.openedOf(book);
    if (!o || book.files.every((f) => f.chaptersProbed)) return;
    const abort = new AbortController();
    this.chapterProbe = abort;
    // The chapter probe rewrites files.csv; let the scan's own write land first.
    await o.saving;
    if (abort.signal.aborted) return;
    const probed = await o.lib.ensureChapters(book, abort.signal, (e) => log.warn("could not keep the chapters of", book.book.title, "beside the book; using them for now:", describe(e)));
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
    this.listenedFrom = null;
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
        // Back in front: another device may have moved on meanwhile, and a phone's event stream doesn't last in the background.
        else this.syncAllServers();
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

  /** Bookmark the open book: where it is playing, or the moment given (the bookmark sheet's, nudged a few seconds). */
  async addBookmark(note: string, offsetMs?: number): Promise<void> {
    const cur = this.state.current;
    if (!cur || !this.engine) return;
    await this.addBookmarkAt(cur.book.book.id, offsetMs ?? this.engine.positionMs(), note);
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

  /**
   * Bookmark the words selected in the reader: where they start and end
   * and the words, and, when the book has audio, the time they map to,
   * so the bookmark is in the player's list too, with its clip.
   */
  async addHighlight(a: TextPlace, b: TextPlace): Promise<Highlight | null> {
    const r = this.state.reading;
    const book = r && this.state.books.find((x) => x.book.id === r.bookId);
    const lib = book && this.libOf(book);
    if (!r?.text || !book || !lib) return null;
    const range = trimRange(r.text, a, b);
    if (!range) return null;
    const text = highlightOf(r.text, book.book.id, range);
    const ms = r.alignment && book.book.durationMs > 0 ? Math.max(0, Math.round(textToMs(r.alignment, r.text.chars(range.from)))) : null;
    const clip =
      ms === null
        ? ""
        : await lib.cutClip(book, ms).catch((e: unknown) => {
            log.warn("could not cut a bookmark's clip:", describe(e));
            return "";
          });
    const h: Highlight = { id: highlightId(book.book.id, text.start, text.quote), bookId: book.book.id, offsetMs: ms, createdAt: new Date().toISOString(), note: "", clip, text };
    await this.writeHistory(book.book.id, markFields(h), h.createdAt);
    return h;
  }

  /** A book's bookmarks made from highlights, from the log as read so far. */
  highlightsFor(bookId: string): Highlight[] {
    const b = this.state.books.find((x) => x.book.id === bookId);
    const o = b && this.openedOf(b);
    if (!b || !o) return [];
    return highlightsOf(o.log, { id: bookId, claims: claimsFor(b.original ?? b.book) });
  }

  /** The reader's highlights, again from the log, when they changed. */
  private refreshHighlights(): void {
    const r = this.state.reading;
    if (!r || r.status !== "ready") return;
    const highlights = this.highlightsFor(r.bookId);
    if (JSON.stringify(highlights) === JSON.stringify(r.highlights ?? [])) return;
    const { highlights: _, ...rest } = r;
    this.set({ reading: { ...rest, ...(highlights.length > 0 ? { highlights } : {}) } });
  }

  /** Open a highlight's words in the reader. */
  async readHighlight(bookId: string, id: string): Promise<void> {
    const h = this.highlightsFor(bookId).find((x) => x.id === id);
    if (!h) return;
    if (this.state.reading?.bookId !== bookId || this.state.reading.status !== "ready") await this.openReading(bookId);
    const r = this.state.reading;
    if (r?.bookId !== bookId || !r.text) return;
    this.moveReading(r.text.fromLocator(h.text.start), "seek");
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
    const bm = this.bookmarksFor(bookId).find((x) => x.id === id) ?? this.highlightsFor(bookId).find((x) => x.id === id);
    if (!bm) return;
    if (this.state.current?.book.book.id === bookId && bm.offsetMs !== null && this.state.previewing === bm.offsetMs) this.pause();
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
    const list = this.bookmarksFor(bookId).filter((x) => !x.text);
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
    this.refreshHighlights();
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

  /** Summarise speed measurements in the log each minute, or stop (app/perf.ts). */
  async setPerfLog(on: boolean): Promise<void> {
    this.appSettings = { ...this.appSettings, perfLog: on };
    perf.setLogging(on);
    this.set({ perfLog: on });
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
      this.letGoOfServerPlaces(o);
      o.coverJob?.abort();
      o.lookup?.stop();
    }
    this.opened.clear();
    this.jobs.cancelAll();
    this.set({ phase: "pick", sources: [], sourceStatus: {}, books: [], positions: {}, current: null, pane: "library", playerExpanded: false, assetsReady: false, series: {}, problems: [], about: {}, scanning: null, canAddFolders: true });
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

/**
 * Once the page has drawn what is set now. A window that is hidden draws
 * nothing and may not run frames at all, so never later than 100 ms; and at
 * once where nothing draws (the tests).
 */
function afterNextPaint(): Promise<void> {
  return new Promise((done) => {
    if (typeof requestAnimationFrame !== "function") return void setTimeout(done, 0);
    const late = setTimeout(done, 100);
    requestAnimationFrame(() =>
      setTimeout(() => {
        clearTimeout(late);
        done();
      }, 0),
    );
  });
}

/**
 * A server's address as someone types it, made a URL: a scheme when it has
 * none (plain HTTP only on this machine), and no trailing slash.
 */
export function serverUrl(address: string): string {
  let a = address.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(a)) a = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(a) ? `http://${a}` : `https://${a}`;
  const url = new URL(a);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}
