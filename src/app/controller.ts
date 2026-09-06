import type { Host } from "../host/host";
import type { ScannedBook } from "../core/scan/scan";
import type { Bookmark, BookSettings, Position, SilenceRange } from "../core/types";
import { PlayerEngine, type EngineState } from "../player/engine";
import { LibraryService } from "./library";
import { JobQueue, type JobStatus } from "./jobs";
import { installMediaSession, updateMediaMetadata, updateMediaPlayback } from "./media-session";
import { resumePosition, rewindFor } from "../core/resume";
import { snapSpeed } from "../core/speed";
import { chapterAt } from "../core/scan/chapters";
import * as sleep from "../core/sleep";
import type { Correction } from "../core/scan/chapters";

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

export interface AppState {
  phase: "boot" | "pick" | "loading" | "ready";
  root: string | null;
  books: ScannedBook[];
  positions: Record<string, Position | null>;
  current: CurrentBook | null;
  player: EngineState;
  sleep: { state: sleep.SleepState; gain: number; remainingMs: number | null };
  resumeOffer: { chapterStartMs: number; awayMs: number } | null;
  jobs: Record<string, JobStatus>;
  scanning: { done: number; total: number } | null;
  error: string | null;
  /** Narrow layouts show one pane at a time. */
  pane: "library" | "player";
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
      jobs: {},
      scanning: null,
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
        this.set({ error: `Could not open ${remembered}: ${(e as Error).message}` });
      }
    }
    this.set({ phase: "pick" });
  }

  async pickLibrary(): Promise<void> {
    const root = await this.platform.pickFolder();
    if (!root) return;
    await this.openLibrary(root);
  }

  async openLibrary(root: string): Promise<void> {
    this.set({ phase: "loading", root, error: null, scanning: null });
    await this.platform.allowFolder(root);
    this.lib = new LibraryService(this.platform.host, root);
    this.jobs = new JobQueue(this.lib);
    this.jobs.onStatus((s) => this.set({ jobs: { ...this.state.jobs, [`${s.bookId}:${s.kind}`]: s } }));
    this.ensureEngine();
    const books = await this.lib.open({
      concurrency: 4,
      onBook: (_b, i, total) => this.set({ scanning: { done: i + 1, total } }),
    });
    this.platform.saveRoot(root);
    const positions = await this.loadPositions(books);
    this.set({ phase: "ready", books, positions, scanning: null });
    this.queueBackgroundJobs(books);
  }

  async rescan(): Promise<void> {
    if (!this.lib) return;
    this.set({ scanning: { done: 0, total: 0 } });
    try {
      const books = await this.lib.rescan({ concurrency: 4, onBook: (_b, i, total) => this.set({ scanning: { done: i + 1, total } }) });
      const positions = await this.loadPositions(books);
      this.set({ books, positions, scanning: null });
      this.queueBackgroundJobs(books);
    } catch (e) {
      this.set({ scanning: null, error: (e as Error).message });
    }
  }

  forgetLibrary(): void {
    this.engine?.pause();
    this.platform.saveRoot(null);
    this.set({ phase: "pick", root: null, books: [], positions: {}, current: null, pane: "library" });
  }

  private async loadPositions(books: ScannedBook[]): Promise<Record<string, Position | null>> {
    const out: Record<string, Position | null> = {};
    for (const b of books) out[b.book.id] = this.lib ? await this.lib.readPosition(b.book.id) : null;
    return out;
  }

  private queueBackgroundJobs(books: ScannedBook[]): void {
    if (!this.lib || !this.jobs) return;
    const lib = this.lib;
    const jobs = this.jobs;
    void (async () => {
      for (const b of books) {
        if (!(await lib.readLoudness(b.book.id))) jobs.enqueue(b, "loudness");
        if (!(await lib.readSilence(b.book.id))) jobs.enqueue(b, "silence");
      }
    })();
  }

  coverUrl(book: ScannedBook): string | null {
    if (!this.lib || !book.book.cover) return null;
    return this.platform.fileUrl(this.lib.absPath(book.book.cover));
  }

  // Playback ------------------------------------------------------------

  private ensureEngine(): PlayerEngine {
    if (this.engine) return this.engine;
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
    if (player.playing && Date.now() - this.lastWrite > POSITION_WRITE_INTERVAL_MS) void this.persistPosition();
    if (player.chapterIndex !== prev.chapterIndex || player.bookId !== prev.bookId) this.refreshMediaMetadata();
    if (player.playing !== prev.playing || Math.abs(player.positionMs - prev.positionMs) > 900) {
      updateMediaPlayback(player.playing, player.positionMs, player.durationMs, player.speed);
    }
  }

  async openBook(book: ScannedBook): Promise<void> {
    if (!this.lib) return;
    const engine = this.ensureEngine();
    if (this.state.current?.book.book.id === book.book.id) {
      this.set({ pane: "player" });
      return;
    }
    if (this.state.player.playing) {
      engine.pause();
      await this.persistPosition();
    }
    const [settings, bookmarks, loudness, silence, corrections, position] = await Promise.all([
      this.lib.readSettings(book.book.id),
      this.lib.readBookmarks(book.book.id),
      this.lib.readLoudness(book.book.id),
      this.lib.readSilence(book.book.id),
      this.lib.readCorrections(book.book.id),
      this.lib.readPosition(book.book.id),
    ]);
    const current: CurrentBook = { book, settings, bookmarks, loudnessGainDb: loudness?.gainDb ?? null, silence, corrections };
    this.set({ current, pane: "player", resumeOffer: null });
    const startMs = position ? Math.min(position.offsetMs, book.book.durationMs) : 0;
    await engine.load({ id: book.book.id, files: book.files, chapters: book.chapters, silence: silence ?? undefined }, startMs);
    engine.setSpeed(settings.speed);
    engine.setLoudnessGainDb(loudness?.gainDb ?? 0);
    this.pausedAt = position ? Date.parse(position.updatedAt) : null;
    this.refreshMediaMetadata();
    if (this.jobs) {
      if (!loudness) this.jobs.enqueue(book, "loudness", true);
      if (!silence) this.jobs.enqueue(book, "silence", true);
    }
  }

  /** Play, applying the scaled resume rewind for the time we were away. */
  async play(): Promise<void> {
    const engine = this.engine;
    const cur = this.state.current;
    if (!engine || !cur) return;
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
    void this.persistPosition();
  }

  togglePlay(): void {
    if (this.state.player.playing) this.pause();
    else void this.play();
  }

  seek(positionMs: number): void {
    if (!this.engine) return;
    this.engine.seek(positionMs);
    this.set({ resumeOffer: null });
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

  async removeBookmark(offsetMs: number): Promise<void> {
    const cur = this.state.current;
    if (!cur || !this.lib) return;
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
    if (this.engine) {
      await this.engine.load({ id: updated.book.id, files: updated.files, chapters: updated.chapters, silence: cur.silence ?? undefined }, this.state.player.positionMs);
      if (this.state.player.playing) await this.engine.play();
    }
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
  }
}
