import type { AudioFile, Chapter, SilenceRange } from "../core/types";
import { fileStarts, locate, totalDuration } from "../core/timeline";
import { chapterAt } from "../core/scan/chapters";
import { clampSpeed } from "../core/speed";
import { findRange, gapRate } from "../core/silence";
import { dbToLinear } from "../core/loudness";
import { recoveryDelayMs, STALL_MS } from "../core/recovery";

/** How often the position clock, the gap check and the watchdog run. */
const TICK_MS = 200;

/** MediaError codes, spelled out so the engine runs where `MediaError` is not a global. */
const MEDIA_ERR_ABORTED = 1;
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

/** HTMLMediaElement.readyState at which `currentTime` means what it says. */
const HAVE_METADATA = 1;

/** Failed recoveries before the bar says what is wrong rather than only "Reconnecting". */
const QUIET_ATTEMPTS = 3;

export interface EngineBook {
  id: string;
  files: AudioFile[];
  chapters: Chapter[];
  /** Silence ranges per file index, file-relative. Optional. */
  silence?: Map<number, SilenceRange[]> | undefined;
}

export interface EngineState {
  bookId: string | null;
  positionMs: number;
  durationMs: number;
  playing: boolean;
  buffering: boolean;
  speed: number;
  chapterIndex: number;
  /** True while the rate is raised to cross a recorded gap. */
  skippingGap: boolean;
  /** Linear loudness gain in effect. */
  gain: number;
  /** True while a stalled or failed file is being reloaded at the last good position. */
  reconnecting: boolean;
  error: string | null;
}

/** The slice of HTMLAudioElement the engine uses, so tests can drive a fake one. */
export type MediaElement = Pick<
  HTMLAudioElement,
  "src" | "currentTime" | "paused" | "ended" | "playbackRate" | "volume" | "preload" | "crossOrigin" | "preservesPitch" | "readyState" | "error" | "play" | "pause" | "load" | "removeAttribute" | "addEventListener"
>;

export interface EngineOptions {
  /** Turn a library-relative file path into a streamable URL. */
  resolveUrl: (relPath: string) => string;
  onState: (state: EngineState) => void;
  /** Fired when the last file ends naturally. */
  onEnded?: () => void;
  /** Something worth a line in the log: a stall, a failed file, a recovery. */
  onLog?: (message: string) => void;
  /** Force the element-volume fallback instead of Web Audio. */
  noWebAudio?: boolean;
  /** Make a media element. Tests pass a fake; the app gets `new Audio()`. */
  createElement?: () => MediaElement;
}

/**
 * Two audio elements, one active and one standby holding the next file,
 * swapped on `ended` so multi-file books play without a gap. Loudness
 * and sleep gain go through Web Audio when the asset origin allows it,
 * else through element volume.
 *
 * The engine is built to keep going. It remembers the last position it
 * could trust and never reports anything else: an element that is
 * loading, reloading or broken does not get to say the book is at 0.
 * A file that fails or stalls is reloaded at that position, again and
 * again with backoff, for as long as the listener wants to be playing.
 * Every play and pause carries an intent number, so a slow `play()`
 * that resolves after a pause does not start the audio again.
 */
export class PlayerEngine {
  private readonly els: [MediaElement, MediaElement];
  private active = 0;
  private book: EngineBook | null = null;
  private starts: number[] = [];
  private durations: number[] = [];
  private fileIndex = 0;
  private speed = 1;
  private loudnessGain = 1;
  private sleepGain = 1;
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private webAudio: boolean | null = null;
  /** Position clock. A timer, not requestAnimationFrame, so it keeps
   *  running while the window is hidden or minimized. */
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** Book offset at which playback pauses itself, for previews. */
  private stopAtMs: number | null = null;
  private state: EngineState = {
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
  };
  /** What the listener asked for most recently. */
  private wantPlaying = false;
  /** Bumped by every load, play and pause; async work checks it is still current. */
  private intent = 0;
  /** The last book offset read from a healthy element, or set by a seek. */
  private trusted = 0;
  /** When the trusted position last moved forward while playing, for the stall watchdog. */
  private lastProgressAt = 0;
  private lastProgressPos = -1;
  /** Elements whose next `pause` event is our own doing (a source change), not the system's. */
  private quietPause = new WeakSet<MediaElement>();
  private recovery: { attempts: number; timer: ReturnType<typeof setTimeout> | null; lastFailAt: number; lastFailPos: number } = { attempts: 0, timer: null, lastFailAt: 0, lastFailPos: -1 };

  constructor(private readonly opts: EngineOptions) {
    const make = opts.createElement ?? (() => new Audio());
    this.els = [make(), make()];
    for (const el of this.els) {
      el.preload = "auto";
      el.crossOrigin = "anonymous";
      el.preservesPitch = true;
      el.addEventListener("ended", () => this.onEnded(el));
      el.addEventListener("waiting", () => {
        if (el === this.activeEl) this.emit({ buffering: true });
      });
      el.addEventListener("playing", () => {
        if (el !== this.activeEl) return;
        this.markProgress();
        this.emit({ buffering: false, playing: true, error: null, reconnecting: false });
      });
      el.addEventListener("timeupdate", () => {
        if (el === this.activeEl) this.readTrusted();
      });
      el.addEventListener("pause", () => this.onPauseEvent(el));
      el.addEventListener("error", () => {
        if (el === this.activeEl) this.onFailure(describeMediaError(el.error), el.error?.code ?? 0);
      });
    }
  }

  get current(): EngineState {
    return this.state;
  }

  private get activeEl(): MediaElement {
    return this.els[this.active]!;
  }

  private get standbyEl(): MediaElement {
    return this.els[1 - this.active]!;
  }

  /** Load a book at a position. Does not start playback. */
  async load(book: EngineBook, positionMs: number): Promise<void> {
    const intent = ++this.intent;
    this.stopLoop();
    this.cancelRecovery();
    this.wantPlaying = false;
    for (const el of this.els) this.unload(el);
    this.book = book;
    this.durations = book.files.map((f) => f.durationMs);
    this.starts = fileStarts(this.durations);
    const total = totalDuration(this.durations);
    const start = Math.max(0, Math.min(positionMs, total));
    const loc = locate(this.durations, start);
    this.fileIndex = loc.fileIndex;
    this.active = 0;
    this.trusted = start;
    await this.ensureGraph(book.files[0]?.path ?? "");
    if (intent !== this.intent) return;
    this.setSource(this.activeEl, this.fileIndex, loc.fileOffsetMs);
    this.preloadNext();
    this.applyRate();
    this.applyGain();
    this.emit({
      bookId: book.id,
      durationMs: total,
      positionMs: start,
      playing: false,
      buffering: false,
      reconnecting: false,
      chapterIndex: chapterAt(book.chapters, start),
      error: null,
    });
  }

  async play(): Promise<void> {
    if (!this.book) return;
    const intent = ++this.intent;
    this.wantPlaying = true;
    this.markProgress();
    this.startLoop();
    if (this.ctx && this.ctx.state !== "running") await this.ctx.resume().catch(() => undefined);
    if (intent !== this.intent) return;
    // A failed element cannot play; reload it where we were first.
    if (this.activeEl.error) {
      this.reloadAtTrusted();
      if (intent !== this.intent) return;
    }
    await this.playActive(intent);
  }

  /** Pause automatically once the position reaches `ms`. Null clears it. */
  setStopAt(ms: number | null): void {
    this.stopAtMs = ms;
  }

  pause(): void {
    ++this.intent;
    this.wantPlaying = false;
    this.stopAtMs = null;
    this.cancelRecovery();
    this.readTrusted();
    this.activeEl.pause();
    this.stopLoop();
    this.emit({ playing: false, buffering: false, reconnecting: false, positionMs: this.trusted });
  }

  /** Seek anywhere in the book. Crosses files when needed. */
  seek(positionMs: number): void {
    if (!this.book) return;
    const total = totalDuration(this.durations);
    const target = Math.max(0, Math.min(total, Number.isFinite(positionMs) ? positionMs : this.trusted));
    const loc = locate(this.durations, target);
    this.trusted = target;
    this.markProgress();
    const el = this.activeEl;
    if (loc.fileIndex !== this.fileIndex || el.error || el.readyState < HAVE_METADATA) {
      this.fileIndex = loc.fileIndex;
      this.setSource(el, this.fileIndex, loc.fileOffsetMs);
      this.preloadNext();
      if (this.wantPlaying) void this.playActive(this.intent);
    } else {
      try {
        el.currentTime = loc.fileOffsetMs / 1000;
      } catch {
        this.setSource(el, this.fileIndex, loc.fileOffsetMs);
        if (this.wantPlaying) void this.playActive(this.intent);
      }
    }
    this.emit({ positionMs: target, chapterIndex: chapterAt(this.book.chapters, target) });
  }

  setSpeed(speed: number): void {
    this.speed = clampSpeed(speed);
    this.applyRate();
    this.emit({ speed: this.speed });
  }

  /** Loudness normalisation gain in dB. Applied to the whole book. */
  setLoudnessGainDb(db: number): void {
    this.loudnessGain = dbToLinear(db);
    this.applyGain();
  }

  /** Swap the chapter list without touching playback. */
  setChapters(chapters: Chapter[]): void {
    if (!this.book) return;
    this.book = { ...this.book, chapters };
    this.emit({ chapterIndex: chapterAt(chapters, this.positionMs()) });
  }

  /** Attach silence ranges once the analysis job finishes. */
  setSilence(silence: Map<number, SilenceRange[]> | null): void {
    if (!this.book) return;
    this.book = { ...this.book, silence: silence ?? undefined };
  }

  /** 0..1 multiplier from the sleep timer fade. */
  setSleepGain(gain: number): void {
    this.sleepGain = Math.max(0, Math.min(1, gain));
    this.applyGain();
  }

  /**
   * Book position right now. Read live from the active element when it
   * is healthy; otherwise the last position that was.
   */
  positionMs(): number {
    if (!this.book) return 0;
    this.readTrusted();
    return this.trusted;
  }

  destroy(): void {
    ++this.intent;
    this.stopLoop();
    this.cancelRecovery();
    for (const el of this.els) this.unload(el);
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }

  // Positions --------------------------------------------------------------

  /** Take the element's clock as the truth, if the element has earned it. */
  private readTrusted(): void {
    const el = this.activeEl;
    if (!this.book || el.error || el.readyState < HAVE_METADATA) return;
    const t = el.currentTime;
    if (!Number.isFinite(t)) return;
    const start = this.starts[this.fileIndex] ?? 0;
    this.trusted = Math.min(totalDuration(this.durations), start + Math.max(0, Math.round(t * 1000)));
  }

  private markProgress(): void {
    this.lastProgressAt = Date.now();
    this.lastProgressPos = this.trusted;
  }

  // Sources ----------------------------------------------------------------

  private unload(el: MediaElement): void {
    if (!el.paused) this.quietPause.add(el);
    try {
      el.pause();
      el.removeAttribute("src");
      el.load();
    } catch {
      /* an element with nothing loaded */
    }
  }

  private setSource(el: MediaElement, index: number, offsetMs: number): void {
    const file = this.book?.files[index];
    if (!file) return;
    // Replacing the source pauses the element without a `pause` event,
    // and rejects its pending play() with AbortError, which playActive ignores.
    el.src =this.opts.resolveUrl(file.path);
    el.playbackRate = this.speed;
    // Setting src starts the load; a seek before metadata is queued by
    // Chromium, but re-apply on loadedmetadata in case it was dropped.
    try {
      el.currentTime = offsetMs / 1000;
    } catch {
      /* applied on loadedmetadata below */
    }
    if (offsetMs > 0) {
      const fix = () => {
        if (Math.abs(el.currentTime * 1000 - offsetMs) > 500) el.currentTime = offsetMs / 1000;
      };
      el.addEventListener("loadedmetadata", fix, { once: true });
    }
  }

  private preloadNext(): void {
    const next = this.fileIndex + 1;
    if (!this.book || next >= this.book.files.length) {
      this.unload(this.standbyEl);
      return;
    }
    this.setSource(this.standbyEl, next, 0);
  }

  private async playActive(intent: number): Promise<void> {
    const el = this.activeEl;
    try {
      await el.play();
    } catch (e) {
      if (intent !== this.intent || !this.wantPlaying) return;
      const name = (e as { name?: string }).name ?? "";
      // A new source interrupted this play: the next playActive owns it.
      if (name === "AbortError") return;
      if (name === "NotAllowedError") {
        this.wantPlaying = false;
        this.stopLoop();
        this.emit({ playing: false, error: "Press play to continue" });
        return;
      }
      this.onFailure((e as Error).message || "playback failed", 0);
    }
  }

  private onPauseEvent(el: MediaElement): void {
    if (this.quietPause.has(el)) {
      this.quietPause.delete(el);
      return;
    }
    if (el !== this.activeEl || el.ended || el.error) return;
    if (this.wantPlaying) {
      // Paused by something other than us: the system, a device change,
      // another app taking the audio. Respect it, and keep the place.
      this.opts.onLog?.("playback paused from outside the app");
      ++this.intent;
      this.wantPlaying = false;
      this.cancelRecovery();
      this.stopLoop();
      this.readTrusted();
    }
    this.emit({ playing: false, buffering: false, positionMs: this.trusted });
  }

  private onEnded(el: MediaElement): void {
    if (el !== this.activeEl || !this.book) return;
    this.recovery.attempts = 0;
    const next = this.fileIndex + 1;
    if (next >= this.book.files.length) {
      this.wantPlaying = false;
      this.stopLoop();
      this.trusted = totalDuration(this.durations);
      this.emit({ playing: false, buffering: false, positionMs: this.trusted });
      this.opts.onEnded?.();
      return;
    }
    this.fileIndex = next;
    this.active = 1 - this.active;
    this.trusted = this.starts[next] ?? this.trusted;
    this.markProgress();
    const incoming = this.activeEl;
    incoming.playbackRate = this.speed;
    // The standby never loaded (a share hiccup): load it now, from its start.
    if (incoming.error || !incoming.src) this.setSource(incoming, next, 0);
    if (this.wantPlaying) void this.playActive(this.intent);
    this.preloadNext();
    this.emit({ positionMs: this.trusted, chapterIndex: chapterAt(this.book.chapters, this.trusted) });
  }

  // Recovery ---------------------------------------------------------------

  /**
   * A file failed or stalled. While the listener wants to play, reload
   * it at the last good position after a growing pause, forever. A decode
   * error at the same spot twice steps over the damage.
   */
  private onFailure(message: string, code: number): void {
    if (!this.book) return;
    this.opts.onLog?.(`playback trouble at ${this.trusted} ms in file ${this.fileIndex + 1}: ${message}`);
    if (!this.wantPlaying) {
      // Nothing is waiting on it. Remember the trouble; the next play reloads.
      this.emit({ playing: false, buffering: false, reconnecting: false, error: null });
      return;
    }
    if (code === MEDIA_ERR_DECODE) {
      const now = Date.now();
      if (Math.abs(this.trusted - this.recovery.lastFailPos) < 1500 && now - this.recovery.lastFailAt < 60_000) {
        const total = totalDuration(this.durations);
        this.trusted = Math.min(total, this.trusted + 2000);
        this.opts.onLog?.(`stepping over damaged audio to ${this.trusted} ms`);
      }
      this.recovery.lastFailAt = now;
      this.recovery.lastFailPos = this.trusted;
    }
    this.scheduleRecovery(message);
  }

  private scheduleRecovery(message: string): void {
    if (this.recovery.timer !== null) return;
    const attempt = this.recovery.attempts++;
    const delay = recoveryDelayMs(attempt);
    this.emit({
      playing: false,
      buffering: false,
      reconnecting: true,
      error: attempt >= QUIET_ATTEMPTS ? `${capitalise(message)}. Still trying…` : null,
    });
    const intent = this.intent;
    this.recovery.timer = setTimeout(() => {
      this.recovery.timer = null;
      if (intent !== this.intent || !this.wantPlaying) return;
      this.opts.onLog?.(`reloading file ${this.fileIndex + 1} at ${this.trusted} ms (attempt ${attempt + 1})`);
      this.reloadAtTrusted();
      this.markProgress();
      void this.playActive(this.intent);
    }, delay);
  }

  private reloadAtTrusted(): void {
    if (!this.book) return;
    const loc = locate(this.durations, this.trusted);
    this.fileIndex = loc.fileIndex;
    this.setSource(this.activeEl, this.fileIndex, loc.fileOffsetMs);
    this.preloadNext();
  }

  private cancelRecovery(): void {
    if (this.recovery.timer !== null) clearTimeout(this.recovery.timer);
    this.recovery.timer = null;
    this.recovery.attempts = 0;
  }

  /** Called every tick while the listener wants to play. */
  private watchdog(): void {
    const el = this.activeEl;
    if (!this.wantPlaying || this.recovery.timer !== null) return;
    if (el.error) {
      this.onFailure(describeMediaError(el.error), el.error.code);
      return;
    }
    if (this.trusted !== this.lastProgressPos) {
      this.markProgress();
      if (this.recovery.attempts > 0 && this.state.playing) this.recovery.attempts = 0;
      return;
    }
    if (Date.now() - this.lastProgressAt > STALL_MS) {
      this.opts.onLog?.(`no progress for ${STALL_MS} ms (readyState ${el.readyState}, paused ${el.paused})`);
      this.markProgress();
      this.scheduleRecovery("The audio stalled");
    }
  }

  // Output -----------------------------------------------------------------

  private applyRate(): void {
    let rate = this.speed;
    let skipping = false;
    if (this.book?.silence) {
      const ranges = this.book.silence.get(this.fileIndex);
      if (ranges) {
        const r = findRange(ranges, Math.round(this.activeEl.currentTime * 1000));
        if (r) {
          rate = Math.min(16, this.speed * gapRate(r));
          skipping = true;
        }
      }
    }
    if (this.activeEl.playbackRate !== rate) this.activeEl.playbackRate = rate;
    if (this.standbyEl.playbackRate !== this.speed) this.standbyEl.playbackRate = this.speed;
    if (skipping !== this.state.skippingGap) this.emit({ skippingGap: skipping });
  }

  private applyGain(): void {
    const g = this.loudnessGain * this.sleepGain;
    if (this.gainNode) {
      this.gainNode.gain.value = g;
    } else {
      // Element volume cannot exceed 1: positive loudness gain is lost here.
      for (const el of this.els) el.volume = Math.min(1, g);
    }
    if (g !== this.state.gain) this.emit({ gain: g });
  }

  /**
   * Decide once whether the media origin allows Web Audio. A CORS HEAD
   * request succeeds only when the asset server sends the header that
   * also keeps MediaElementSource from being silenced.
   */
  private async ensureGraph(firstPath: string): Promise<void> {
    if (this.webAudio !== null) return;
    if (this.opts.noWebAudio || typeof AudioContext === "undefined" || this.opts.createElement) {
      this.webAudio = false;
      return;
    }
    try {
      const r = await fetch(this.opts.resolveUrl(firstPath), { method: "HEAD", mode: "cors" });
      if (!r.ok) throw new Error(String(r.status));
      const ctx = new AudioContext({ latencyHint: "playback" });
      this.ctx = ctx;
      this.gainNode = ctx.createGain();
      this.gainNode.connect(ctx.destination);
      for (const el of this.els) ctx.createMediaElementSource(el as HTMLAudioElement).connect(this.gainNode);
      // A device change or the machine waking can suspend the graph under
      // a playing element: silence while the clock runs. Wake it back up.
      ctx.addEventListener("statechange", () => {
        if (this.wantPlaying && ctx.state !== "running" && ctx.state !== "closed") {
          this.opts.onLog?.(`audio output was ${ctx.state}; resuming`);
          void ctx.resume().catch(() => undefined);
        }
      });
      this.webAudio = true;
    } catch {
      this.webAudio = false;
      this.ctx = null;
      this.gainNode = null;
      // Without CORS headers a crossorigin media fetch fails outright,
      // so fall back to a plain (opaque) media load.
      for (const el of this.els) el.removeAttribute("crossorigin");
    }
  }

  private startLoop(): void {
    if (this.ticker !== null) return;
    const step = () => {
      if (!this.book) return;
      this.applyRate();
      this.readTrusted();
      const pos = this.trusted;
      if (this.stopAtMs !== null && pos >= this.stopAtMs) {
        this.pause();
        return;
      }
      this.watchdog();
      if (this.wantPlaying && this.ctx && this.ctx.state === "suspended") void this.ctx.resume().catch(() => undefined);
      const ch = chapterAt(this.book.chapters, pos);
      if (pos !== this.state.positionMs || ch !== this.state.chapterIndex) this.emit({ positionMs: pos, chapterIndex: ch });
    };
    this.ticker = setInterval(step, TICK_MS);
    step();
  }

  private stopLoop(): void {
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
  }

  private emit(patch: Partial<EngineState>): void {
    this.state = { ...this.state, ...patch };
    this.opts.onState(this.state);
  }
}

function capitalise(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function describeMediaError(e: MediaError | null): string {
  if (!e) return "playback failed";
  switch (e.code) {
    case MEDIA_ERR_ABORTED:
      return "playback aborted";
    case MEDIA_ERR_NETWORK:
      return "could not read the file";
    case MEDIA_ERR_DECODE:
      return "could not decode this file";
    case MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "could not open the file";
    default:
      return e.message || "playback failed";
  }
}
