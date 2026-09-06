import type { Host, ScanProgress } from "../host/host";
import type { ScannedBook } from "../core/scan/scan";
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
  /** Ask the user for a library folder. Null when cancelled. */
  pickFolder(): Promise<string | null>;
  /** Grant access to a folder before any read. */
  allowFolder(path: string): Promise<void>;
  /** Streamable URL for an absolute path. */
  fileUrl(absPath: string): string;
  /** Persisted last library root. */
  loadRoot(): string | null;
  saveRoot(root: string | null): void;
  /** A root to open automatically without picking (dev harness). */
  defaultRoot?: () => Promise<string | null>;
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
  error: string | null;
  /** Narrow layouts show one pane at a time. */
  pane: "library" | "player";
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
    const root = await this.platform.pickFolder();
    if (!root) return;
    try {
      await this.openLibrary(root);
    } catch (e) {
      this.set({ phase: "pick", scanning: null, error: `Could not open ${root}: ${describe(e)}` });
    }
  }

  /**
   * Open a library. If it has been scanned before, its records paint
   * immediately and a rescan runs behind them. If not, the scan runs in
   * the foreground with live counts.
   */
  async openLibrary(root: string): Promise<void> {
    log.info("open library", root);
    this.set({ phase: "loading", root, error: null, scanning: null });
    await this.platform.allowFolder(root);
    this.lib = new LibraryService(this.platform.host, root);
    this.jobs = new JobQueue(this.lib);
    this.jobs.onStatus((s, result) => this.onJob(s, result));
    this.ensureEngine();

    const cached = await this.lib.loadCached();
    log.info("cached records:", cached ? `${cached.length} books` : "none");
    if (cached && cached.length > 0) {
      const positions = await this.positionsFor(cached);
      this.platform.saveRoot(root);
      this.set({ phase: "ready", books: cached, positions, scanning: null });
      void this.rescan(true);
      return;
    }
    this.set({ scanning: { walked: 0, done: 0, background: false } });
    await this.rescan(false);
    this.platform.saveRoot(root);
    this.set({ phase: "ready" });
  }

  async rescan(background = this.state.phase === "ready"): Promise<void> {
    if (!this.lib || this.scanInFlight) return;
    this.scanInFlight = true;
    this.set({ scanning: { walked: 0, done: 0, background }, scanErrors: [] });
    const started = Date.now();
    log.info("scan start", this.state.root, background ? "(background)" : "(foreground)");
    try {
      const result = await this.lib.rescanDetailed({ onProgress: (p: ScanProgress) => this.set({ scanning: { ...p, background } }) });
      const books = result.books;
      log.info("scan done:", books.length, "books,", result.probed, "probed,", result.reused, "reused,", result.rescued, "rescued by ffprobe,", result.errors.length, "errors,", result.elapsedMs, "ms");
      for (const e of result.errors) log.warn("scan:", e.path, e.message);
      const positions = await this.positionsFor(books);
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
    } catch (e) {
      log.error("scan failed:", describe(e));
      this.set({ scanning: null, error: describe(e) });
      if (!background) throw e;
    } finally {
      this.scanInFlight = false;
    }
  }

  forgetLibrary(): void {
    this.engine?.pause();
    this.platform.saveRoot(null);
    this.set({ phase: "pick", root: null, books: [], positions: {}, current: null, pane: "library" });
  }

  private async positionsFor(books: ScannedBook[]): Promise<Record<string, Position | null>> {
    const out: Record<string, Position | null> = {};
    const all = this.lib ? await this.lib.readAllPositions() : new Map<string, Position>();
    for (const b of books) out[b.book.id] = all.get(b.book.id) ?? null;
    return out;
  }

  coverUrl(book: ScannedBook): string | null {
    if (!this.lib || !book.book.cover) return null;
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
    return this.platform.fileUrl(this.lib.host.join(this.lib.root, ".odio", "bookmarks", ...bm.clip.split("/")));
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
  }
}
