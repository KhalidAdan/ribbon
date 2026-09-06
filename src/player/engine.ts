import type { AudioFile, Chapter, SilenceRange } from "../core/types";
import { fileStarts, locate, totalDuration } from "../core/timeline";
import { chapterAt } from "../core/scan/chapters";
import { clampSpeed } from "../core/speed";
import { findRange, gapRate } from "../core/silence";
import { dbToLinear } from "../core/loudness";

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
  error: string | null;
}

export interface EngineOptions {
  /** Turn a library-relative file path into a streamable URL. */
  resolveUrl: (relPath: string) => string;
  onState: (state: EngineState) => void;
  /** Fired when the last file ends naturally. */
  onEnded?: () => void;
  /** Force the element-volume fallback instead of Web Audio. */
  noWebAudio?: boolean;
}

/**
 * Two audio elements, one active and one standby holding the next file,
 * swapped on `ended` so multi-file books play without a gap. Loudness
 * and sleep gain go through Web Audio when the asset origin allows it,
 * else through element volume.
 */
export class PlayerEngine {
  private readonly els: [HTMLAudioElement, HTMLAudioElement];
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
  private sources = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>();
  private webAudio: boolean | null = null;
  private raf = 0;
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
    error: null,
  };
  private wantPlaying = false;

  constructor(private readonly opts: EngineOptions) {
    this.els = [new Audio(), new Audio()];
    for (const el of this.els) {
      el.preload = "auto";
      el.crossOrigin = "anonymous";
      el.preservesPitch = true;
      el.addEventListener("ended", () => this.onEnded(el));
      el.addEventListener("waiting", () => this.emit({ buffering: true }));
      el.addEventListener("playing", () => this.emit({ buffering: false, playing: true, error: null }));
      el.addEventListener("pause", () => {
        if (el === this.activeEl) this.emit({ playing: false });
      });
      el.addEventListener("error", () => {
        if (el === this.activeEl) this.emit({ error: describeMediaError(el.error), playing: false, buffering: false });
      });
    }
  }

  get current(): EngineState {
    return this.state;
  }

  private get activeEl(): HTMLAudioElement {
    return this.els[this.active]!;
  }

  private get standbyEl(): HTMLAudioElement {
    return this.els[1 - this.active]!;
  }

  /** Load a book at a position. Does not start playback. */
  async load(book: EngineBook, positionMs: number): Promise<void> {
    this.stopLoop();
    this.wantPlaying = false;
    for (const el of this.els) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    this.book = book;
    this.durations = book.files.map((f) => f.durationMs);
    this.starts = fileStarts(this.durations);
    const loc = locate(this.durations, positionMs);
    this.fileIndex = loc.fileIndex;
    this.active = 0;
    await this.ensureGraph(book.files[0]?.path ?? "");
    this.setSource(this.activeEl, this.fileIndex, loc.fileOffsetMs);
    this.preloadNext();
    this.applyRate();
    this.applyGain();
    this.emit({
      bookId: book.id,
      durationMs: totalDuration(this.durations),
      positionMs: Math.min(positionMs, totalDuration(this.durations)),
      playing: false,
      buffering: false,
      chapterIndex: chapterAt(book.chapters, positionMs),
      error: null,
    });
  }

  async play(): Promise<void> {
    if (!this.book) return;
    this.wantPlaying = true;
    if (this.ctx && this.ctx.state === "suspended") await this.ctx.resume().catch(() => undefined);
    try {
      await this.activeEl.play();
      this.startLoop();
    } catch (e) {
      this.emit({ error: (e as Error).message, playing: false });
    }
  }

  pause(): void {
    this.wantPlaying = false;
    this.activeEl.pause();
    this.stopLoop();
    this.emit({ playing: false, positionMs: this.positionMs() });
  }

  /** Seek anywhere in the book. Crosses files when needed. */
  seek(positionMs: number): void {
    if (!this.book) return;
    const total = totalDuration(this.durations);
    const target = Math.max(0, Math.min(total, positionMs));
    const loc = locate(this.durations, target);
    if (loc.fileIndex !== this.fileIndex) {
      this.fileIndex = loc.fileIndex;
      this.setSource(this.activeEl, this.fileIndex, loc.fileOffsetMs);
      this.preloadNext();
      if (this.wantPlaying) void this.activeEl.play().catch(() => undefined);
    } else {
      this.activeEl.currentTime = loc.fileOffsetMs / 1000;
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

  /** Book position right now, from the active element's clock. */
  positionMs(): number {
    if (!this.book) return 0;
    const start = this.starts[this.fileIndex] ?? 0;
    return start + Math.round(this.activeEl.currentTime * 1000);
  }

  destroy(): void {
    this.stopLoop();
    for (const el of this.els) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }

  private setSource(el: HTMLAudioElement, index: number, offsetMs: number): void {
    const file = this.book?.files[index];
    if (!file) return;
    el.src = this.opts.resolveUrl(file.path);
    el.playbackRate = this.speed;
    // Setting src starts the load; a seek before metadata is queued by
    // Chromium, but re-apply on loadedmetadata in case it was dropped.
    el.currentTime = offsetMs / 1000;
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
      this.standbyEl.removeAttribute("src");
      return;
    }
    this.setSource(this.standbyEl, next, 0);
  }

  private onEnded(el: HTMLAudioElement): void {
    if (el !== this.activeEl || !this.book) return;
    const next = this.fileIndex + 1;
    if (next >= this.book.files.length) {
      this.wantPlaying = false;
      this.stopLoop();
      this.emit({ playing: false, positionMs: totalDuration(this.durations) });
      this.opts.onEnded?.();
      return;
    }
    this.fileIndex = next;
    this.active = 1 - this.active;
    this.activeEl.playbackRate = this.speed;
    if (this.wantPlaying) void this.activeEl.play().catch((e: Error) => this.emit({ error: e.message }));
    this.preloadNext();
    this.emit({ positionMs: this.positionMs(), chapterIndex: chapterAt(this.book.chapters, this.positionMs()) });
  }

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
    if (this.opts.noWebAudio || typeof AudioContext === "undefined") {
      this.webAudio = false;
      return;
    }
    try {
      const r = await fetch(this.opts.resolveUrl(firstPath), { method: "HEAD", mode: "cors" });
      if (!r.ok) throw new Error(String(r.status));
      this.ctx = new AudioContext({ latencyHint: "playback" });
      this.gainNode = this.ctx.createGain();
      this.gainNode.connect(this.ctx.destination);
      for (const el of this.els) {
        const src = this.ctx.createMediaElementSource(el);
        src.connect(this.gainNode);
        this.sources.set(el, src);
      }
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
    if (this.raf) return;
    const step = () => {
      this.raf = requestAnimationFrame(step);
      if (!this.book) return;
      this.applyRate();
      const pos = this.positionMs();
      const ch = chapterAt(this.book.chapters, pos);
      if (pos !== this.state.positionMs || ch !== this.state.chapterIndex) this.emit({ positionMs: pos, chapterIndex: ch });
    };
    this.raf = requestAnimationFrame(step);
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private emit(patch: Partial<EngineState>): void {
    this.state = { ...this.state, ...patch };
    this.opts.onState(this.state);
  }
}

function describeMediaError(e: MediaError | null): string {
  if (!e) return "playback failed";
  switch (e.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "playback aborted";
    case MediaError.MEDIA_ERR_NETWORK:
      return "could not read the file";
    case MediaError.MEDIA_ERR_DECODE:
      return "could not decode this file";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "this format is not supported";
    default:
      return e.message || "playback failed";
  }
}
