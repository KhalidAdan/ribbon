import type { Host, ScanProgress } from "../host/host";
import { extractMissingCovers, type ScannedBook } from "../core/scan/scan";
import type { Bookmark, BookSettings, Position, SilenceRange } from "../core/types";
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
  /** Ask the user for a library folder, opening near `near`. Null when cancelled. */
  pickFolder(near?: string | null): Promise<string | null>;
  /** Grant access to a folder before any read. */
  allowFolder(path: string): Promise<void>;
  /** Streamable URL for an absolute path. */
  fileUrl(absPath: string): string;
  /** Persisted last library root. */
  loadRoot(): string | null;
  saveRoot(root: string | null): void;
  /** A root to open automatically without picking (dev harness). */
  defaultRoot?: () => Promise<string | null>;
  /** Milliseconds since the host process started, when the host knows. */
  uptimeMs?: () => Promise<number>;
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

export interface AppState {
  phase: "boot" | "pick" | "loading" | "ready";
  root: string | null;
  books: ScannedBook[];
  positions: Record<string, Position | null>;
  current: CurrentBook | null;
  player: EngineState;
  sleep: { state: sleep.SleepState; gain: number; remainingMs: number | null };
  resumeOffer: { chapterStartMs: number; awayMs: number } | null;
  /** The bookmark whose lead-in is playing through the main player. */
  previewing: number | null;
  jobs: Record<string, JobStatus>;
  scanning: ScanStatus | null;
  /** Files the last scan could not read. */
  scanErrors: { path: string; message: string }[];
  /** How long the last scan took, for the header. */
  lastScanMs: number | null;
  /**
   * True once the host will serve files from the library: covers and
   * audio. Granting that access canonicalises the folder, which on a
   * network volume is several round trips, so the shelf paints first.
   */
  assetsReady: boolean;
  /** Bumped when the set of locally mirrored covers changes. */
  coverVersion: number;
  error: string | null;
  /** Narrow layouts show one pane at a time. */
  pane: "library" | "player";
}

/**
 * The folder picker opens inside the last library, where `.ribbon` is the
 * first thing to click. Choosing it means the library it belongs to.
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

function positionsRecord(books: readonly ScannedBook[], all: Map<string, Position>): Record<string, Position | null> {
  const out: Record<string, Position | null> = {};
  for (const b of books) out[b.book.id] = all.get(b.book.id) ?? null;
  return out;
}

const SKIP_BACK_MS = 30_000;
const SKIP_FORWARD_MS = 30_000;
const POSITION_WRITE_INTERVAL_MS = 5_000;

export class AppController {
  private state: AppState;
  private listeners = new Set<() => void>();
  private lib: LibraryService | null = null;
  private jobs: JobQueue | null = null;
  private engine: PlayerEngine | null = null;
  private pausedAt: number | null = null;
  private lastWrite = 0;
  private sleepTimer: number | null = null;
  private uninstallMedia: (() => void) | null = null;
  private chapterProbe: AbortController | null = null;
  private scanInFlight = false;
  /** The last scan's record write, which the shelf does not wait for. */
  private saving: Promise<void> = Promise.resolve();
  /** process uptime minus performance.now(), learned once at boot. */
  private clockOffset: number | null = null;
  /** Covers copied into the local mirror, and where they are. */
  private mirrorCovers = new Set<string>();
  private mirrorCoversDir: string | null = null;

  constructor(private readonly platform: Platform) {
    this.state = {
      phase: "boot",
      root: null,
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
      lastScanMs: null,
      assetsReady: false,
      coverVersion: 0,
      error: null,
      pane: "library",
    };
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

  // Lifecycle -----------------------------------------------------------

  async boot(): Promise<void> {
    const asked = performance.now();
    void this.platform.uptimeMs?.().then((ms) => {
      this.clockOffset = ms - asked;
      log.info(`web side booted ${Math.round(ms)} ms after process start`);
    });
    const remembered = this.platform.loadRoot() ?? (await this.platform.defaultRoot?.()) ?? null;
    if (remembered) {
      try {
        await this.openLibrary(remembered);
        return;
      } catch (e) {
        this.set({ scanning: null, error: `Could not open ${remembered}: ${describe(e)}` });
      }
    }
    this.set({ phase: "pick" });
  }

  async pickLibrary(): Promise<void> {
    const root = await this.platform.pickFolder(this.state.root ?? this.platform.loadRoot());
    if (!root) return;
    try {
      await this.openLibrary(root);
    } catch (e) {
      this.set({ phase: "pick", scanning: null, error: `Could not open ${root}: ${describe(e)}` });
    }
  }

  /**
   * Open a library. If it has been scanned before, its records paint
   * immediately and a rescan runs behind them; nothing before that paint
   * waits on the share when the local mirror has a copy. If not, the
   * scan runs in the foreground with live counts.
   */
  async openLibrary(pickedRoot: string): Promise<void> {
    const root = libraryRootOf(pickedRoot);
    if (root !== pickedRoot) log.info("picked the records folder; using its parent", root);
    log.info("open library", root);
    this.set({ phase: "loading", root, error: null, scanning: null, assetsReady: false });
    this.mirrorCovers = new Set();
    this.mirrorCoversDir = null;
    const marks: string[] = [];
    let last = performance.now();
    const mark = (what: string) => {
      const now = performance.now();
      marks.push(`${what} ${Math.round(now - last)}`);
      last = now;
    };
    // Access to the folder's files is granted while the shelf paints from
    // the local mirror; covers appear the moment it lands.
    const allowed = this.platform.allowFolder(root).then(() => {
      mark("allow");
      if (this.state.root === root) this.set({ assetsReady: true });
    });
    const lib = new LibraryService(this.platform.host, root);
    this.lib = lib;
    this.jobs = new JobQueue(lib);
    this.jobs.onStatus((s, result) => this.onJob(s, result));
    this.ensureEngine();

    let migrated = false;
    const migrate = async () => {
      if (migrated) return;
      migrated = true;
      if (await lib.migrateLegacyRecords()) log.info("moved records from .odio to .ribbon");
    };
    let cached = await lib.loadCached();
    mark("records");
    if (!cached || cached.length === 0) {
      await migrate();
      cached = await lib.loadCached();
      mark("migrate+records");
    }
    log.info("cached records:", cached ? `${cached.length} books` : "none");
    if (cached && cached.length > 0) {
      const extras = await lib.readMirrorExtras();
      this.mirrorCovers = extras.covers;
      this.mirrorCoversDir = extras.coversDir;
      mark("positions");
      this.platform.saveRoot(root);
      this.set({ phase: "ready", books: cached, positions: positionsRecord(cached, extras.positions), scanning: null, coverVersion: this.state.coverVersion + 1 });
      mark("render");
      this.logPainted("from records", `; steps: ${marks.join(", ")} ms`);
      // Only now the share: the legacy folder, the positions written elsewhere, the rescan.
      await allowed;
      await migrate();
      const positions = await this.positionsFor(cached);
      if (this.lib === lib) this.set({ positions });
      void this.rescan(true);
      return;
    }
    this.set({ scanning: { walked: 0, done: 0, background: false } });
    await allowed;
    await this.rescan(false);
    this.platform.saveRoot(root);
    this.set({ phase: "ready" });
    await this.saving;
  }

  /**
   * Scan the library. Books appear as the scan streams them: the shelf
   * paints from folder names as soon as the walk is done, then fills in
   * authors, then durations, and the complete list lands last.
   */
  async rescan(background = this.state.phase === "ready"): Promise<void> {
    if (!this.lib || this.scanInFlight) return;
    const lib = this.lib;
    this.scanInFlight = true;
    this.set({ scanning: { walked: 0, done: 0, background }, scanErrors: [] });
    const started = Date.now();
    log.info("scan start", this.state.root, background ? "(background)" : "(foreground)");
    // Positions are one directory read; start it now and apply it to
    // every set of books that comes through.
    let positions: Map<string, Position> | null = null;
    const positionsReady = lib
      .readAllPositions()
      .catch(() => new Map<string, Position>())
      .then((m) => (positions = m));
    const positionsOf = (books: ScannedBook[]): Record<string, Position | null> => {
      const out: Record<string, Position | null> = {};
      for (const b of books) out[b.book.id] = positions?.get(b.book.id) ?? this.state.positions[b.book.id] ?? null;
      return out;
    };
    let painted = false;
    let lastTick = 0;
    try {
      const result = await lib.rescanDetailed({
        write: false,
        onProgress: (p: ScanProgress) => {
          // Batches can land many times a second; the header need not.
          const now = Date.now();
          const final = p.stage !== undefined || (p.walked > 0 && p.done >= p.walked);
          if (!final && now - lastTick < 100) return;
          lastTick = now;
          this.set({ scanning: { ...p, background } });
        },
        onBooks: (books: ScannedBook[]) => {
          if (books.length === 0) return;
          if (!painted) {
            painted = true;
            log.info("first paint:", books.length, "books,", Date.now() - started, "ms after scan start");
            this.logPainted("from the walk");
          }
          this.set({ books, positions: positionsOf(books), ...(this.state.phase === "loading" ? { phase: "ready" as const } : {}) });
        },
      });
      const books = result.books;
      log.info("scan done:", books.length, "books,", result.probed, "probed,", result.reused, "reused,", result.rescued, "rescued by ffprobe,", result.errors.length, "errors,", result.elapsedMs, "ms");
      const t = result.timings;
      log.info(`scan timings: records ${t.recordsMs} ms, scan ${t.scanMs} ms, rescue ${t.rescueMs} ms, build ${t.buildMs} ms, write ${t.writeMs} ms; ${t.publishes} interim builds took ${t.publishMs} ms`);
      for (const e of result.errors) log.warn("scan:", e.path, e.message);
      await positionsReady;
      const positions = positionsOf(books);
      // Keep the open book's live object if it still exists.
      const cur = this.state.current;
      const refreshed = cur ? books.find((b) => b.book.id === cur.book.book.id) : undefined;
      this.set({
        books,
        positions,
        scanning: null,
        scanErrors: result.errors,
        lastScanMs: Date.now() - started,
        current: cur && refreshed ? { ...cur, book: { ...refreshed, chapters: cur.book.chapters } } : cur,
      });
      const saveStarted = Date.now();
      this.saving = result.save().then(
        () => log.info("records saved in", Date.now() - saveStarted, "ms"),
        (e: unknown) => log.warn("could not save records:", describe(e)),
      );
      void this.fetchCovers(books).then(() => this.mirrorCoversFor(books));
    } catch (e) {
      log.error("scan failed:", describe(e));
      this.set({ scanning: null, error: describe(e) });
      if (!background) throw e;
    } finally {
      this.scanInFlight = false;
    }
  }

  private coverJob: AbortController | null = null;

  /** Covers ffmpeg still has to cut, after the library is visible. */
  private async fetchCovers(books: ScannedBook[]): Promise<void> {
    if (!this.lib) return;
    this.coverJob?.abort();
    const abort = new AbortController();
    this.coverJob = abort;
    const done = await extractMissingCovers(this.lib.host, this.lib.root, books, () => this.set({ books: [...this.state.books] }), abort.signal);
    if (done.length > 0) log.info("covers extracted:", done.length);
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

  forgetLibrary(): void {
    this.engine?.pause();
    this.platform.saveRoot(null);
    this.set({ phase: "pick", root: null, books: [], positions: {}, current: null, pane: "library", assetsReady: false });
  }

  private async positionsFor(books: ScannedBook[]): Promise<Record<string, Position | null>> {
    const all = this.lib ? await this.lib.readAllPositions() : new Map<string, Position>();
    return positionsRecord(books, all);
  }

  /** Copy covers into the local mirror once the shelf is settled, then show them from there. */
  private async mirrorCoversFor(books: ScannedBook[]): Promise<void> {
    const lib = this.lib;
    if (!lib || !lib.host.recordsMirror) return;
    const present = await lib.mirrorCovers(books);
    if (this.lib !== lib) return;
    if (!this.mirrorCoversDir) this.mirrorCoversDir = (await lib.readMirrorExtras()).coversDir;
    this.mirrorCovers = present;
    this.set({ coverVersion: this.state.coverVersion + 1 });
  }

  /**
   * The cover's URL. From the local mirror when it has a copy; otherwise
   * from the library, but only once files may be served and no scan is
   * running, because a read across the network stalls the host's main
   * thread and a scan keeps the volume busy. Null means show initials.
   */
  coverUrl(book: ScannedBook): string | null {
    if (!this.lib || !book.book.cover) return null;
    const name = LibraryService.mirrorCoverName(book);
    if (name && this.mirrorCoversDir && this.mirrorCovers.has(name)) return this.platform.fileUrl(this.lib.host.join(this.mirrorCoversDir, name));
    if (!this.state.assetsReady || this.state.scanning) return null;
    return this.platform.fileUrl(this.lib.absPath(book.book.cover));
  }

  private onJob(s: JobStatus, result: { gainDb: number | null; silence: Map<number, SilenceRange[]> } | null): void {
    this.set({ jobs: { ...this.state.jobs, [s.bookId]: s } });
    const cur = this.state.current;
    if (result && cur && cur.book.book.id === s.bookId) {
      this.set({ current: { ...cur, loudnessGainDb: result.gainDb, silence: result.silence } });
      if (result.gainDb !== null) this.engine?.setLoudnessGainDb(result.gainDb);
      this.engine?.setSilence(result.silence);
    }
  }

  // Playback ------------------------------------------------------------

  private ensureEngine(): PlayerEngine | null {
    if (this.engine) return this.engine;
    if (typeof Audio === "undefined") return null;
    this.engine = new PlayerEngine({
      resolveUrl: (rel) => this.platform.fileUrl(this.lib!.absPath(rel)),
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
  async openBook(book: ScannedBook): Promise<void> {
    if (!this.lib) return;
    const engine = this.ensureEngine();
    if (!engine) return;
    if (this.state.current?.book.book.id === book.book.id) {
      this.set({ pane: "player" });
      return;
    }
    if (this.state.player.playing) {
      engine.pause();
      await this.persistPosition();
    }
    this.chapterProbe?.abort();
    const [settings, bookmarks, loudness, silence, corrections] = await Promise.all([
      this.lib.readSettings(book.book.id),
      this.lib.readBookmarks(book.book.id),
      this.lib.readLoudness(book.book.id),
      this.lib.readSilence(book.book.id),
      this.lib.readCorrections(book.book.id),
    ]);
    const position = this.state.positions[book.book.id] ?? (await this.lib.readPosition(book.book.id));
    const current: CurrentBook = { book, settings, bookmarks, loudnessGainDb: loudness?.gainDb ?? null, silence, corrections };
    this.set({ current, pane: "player", resumeOffer: null });
    const startMs = position ? Math.min(position.offsetMs, book.book.durationMs) : 0;
    await engine.load({ id: book.book.id, files: book.files, chapters: book.chapters, silence: silence ?? undefined }, startMs);
    engine.setSpeed(settings.speed);
    engine.setLoudnessGainDb(loudness?.gainDb ?? 0);
    this.pausedAt = position ? Date.parse(position.updatedAt) : null;
    this.refreshMediaMetadata();
    if (this.jobs && (!loudness || !silence)) this.jobs.enqueue(book, true);
    void this.probeChapters(book);
  }

  private async probeChapters(book: ScannedBook): Promise<void> {
    if (!this.lib || book.files.every((f) => f.chaptersProbed)) return;
    const abort = new AbortController();
    this.chapterProbe = abort;
    // The chapter probe rewrites files.csv; let the scan's own write land first.
    await this.saving;
    if (abort.signal.aborted) return;
    const updated = await this.lib.ensureChapters(book, abort.signal);
    if (abort.signal.aborted || updated === book) return;
    const cur = this.state.current;
    if (!cur || cur.book.book.id !== book.book.id) return;
    const books = this.state.books.map((b) => (b.book.id === updated.book.id ? updated : b));
    this.set({ books, current: { ...cur, book: updated } });
    this.engine?.setChapters(updated.chapters);
    this.refreshMediaMetadata();
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
    if (!cur || !this.engine || !this.lib) return;
    const s = snapSpeed(speed);
    this.engine.setSpeed(s);
    const settings = { ...cur.settings, speed: s };
    this.set({ current: { ...cur, settings } });
    await this.lib.writeSettings(settings);
  }

  private async persistPosition(): Promise<void> {
    const cur = this.state.current;
    if (!cur || !this.lib || !this.engine) return;
    this.lastWrite = Date.now();
    const pos = await this.lib.writePosition(cur.book.book.id, this.engine.positionMs());
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
    if (!cur || !this.lib || !this.engine) return;
    const bm = await this.lib.addBookmark(cur.book, this.engine.positionMs(), note);
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
    if (!cur || !this.lib) return;
    if (this.state.previewing === offsetMs) this.pause();
    await this.lib.removeBookmark(cur.book.book.id, offsetMs);
    this.set({ current: { ...this.state.current!, bookmarks: cur.bookmarks.filter((b) => b.offsetMs !== offsetMs) } });
  }

  bookmarkClipUrl(bm: Bookmark): string | null {
    if (!this.lib || !bm.clip) return null;
    return this.platform.fileUrl(this.lib.host.join(this.lib.root, ".ribbon", "bookmarks", ...bm.clip.split("/")));
  }

  // Chapter corrections -------------------------------------------------

  async correctChapters(corrections: Correction[]): Promise<void> {
    const cur = this.state.current;
    if (!cur || !this.lib) return;
    const updated = await this.lib.writeCorrections(cur.book, corrections);
    const books = this.state.books.map((b) => (b.book.id === updated.book.id ? updated : b));
    this.set({ books, current: { ...cur, book: updated, corrections } });
    this.engine?.setChapters(updated.chapters);
  }

  // Navigation ----------------------------------------------------------

  showLibrary(): void {
    this.set({ pane: "library" });
  }

  showPlayer(): void {
    if (this.state.current) this.set({ pane: "player" });
  }

  clearError(): void {
    this.set({ error: null });
  }

  destroy(): void {
    this.stopSleepLoop();
    this.uninstallMedia?.();
    this.engine?.destroy();
    this.jobs?.cancelAll();
    this.chapterProbe?.abort();
    this.coverJob?.abort();
  }
}
