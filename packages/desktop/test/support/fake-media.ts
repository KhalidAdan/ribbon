import type { MediaElement } from "../../src/player/engine";

type Listener = (ev: Event) => void;

/**
 * A media element that behaves like Chromium's where the engine cares,
 * and can be made to misbehave: load slowly, stall, fail, end early.
 * Time only moves when the test calls `advance`.
 */
export class FakeMedia implements MediaElement {
  static all: FakeMedia[] = [];
  /** Per-URL duration in seconds; unknown URLs last an hour. */
  static durations = new Map<string, number>();
  /** URLs that fail to load with this MediaError code until removed. */
  static broken = new Map<string, number>();
  /** When true, sources load only when the test calls `loadAll()`. */
  static manualLoad = false;

  preload: "" | "auto" | "metadata" | "none" = "";
  crossOrigin: string | null = null;
  preservesPitch = true;
  playbackRate = 1;
  volume = 1;
  paused = true;
  ended = false;
  readyState = 0;
  error: MediaError | null = null;
  /** True while the network has stopped delivering: time does not move. */
  stalled = false;
  /** Every play() call, for assertions. */
  plays = 0;

  private _src = "";
  private _time = 0;
  private startAt = 0;
  private listeners = new Map<string, Set<{ fn: Listener; once: boolean }>>();
  private pendingPlay: { resolve: () => void; reject: (e: Error) => void }[] = [];

  constructor() {
    FakeMedia.all.push(this);
  }

  static reset(): void {
    FakeMedia.all = [];
    FakeMedia.durations.clear();
    FakeMedia.broken.clear();
    FakeMedia.manualLoad = false;
  }

  static loadAll(): void {
    for (const m of FakeMedia.all) m.finishLoad();
  }

  get src(): string {
    return this._src;
  }

  set src(url: string) {
    this.rejectPending("AbortError");
    this._src = url;
    // A new request is a new connection: whatever stalled the last one is gone.
    this.stalled = false;
    this.paused = true;
    this.ended = false;
    this.readyState = 0;
    this.error = null;
    this.startAt = 0;
    this._time = 0;
    if (!FakeMedia.manualLoad) queueMicrotask(() => this.finishLoad());
  }

  get duration(): number {
    return FakeMedia.durations.get(this._src) ?? 3600;
  }

  get currentTime(): number {
    return this.readyState === 0 ? this.startAt : this._time;
  }

  set currentTime(t: number) {
    if (this.readyState === 0) this.startAt = t;
    else {
      this._time = Math.max(0, Math.min(this.duration, t));
      this.ended = false;
    }
  }

  finishLoad(): void {
    if (!this._src || this.readyState > 0 || this.error) return;
    const code = FakeMedia.broken.get(this._src);
    if (code) {
      this.fail(code);
      return;
    }
    this.readyState = 4;
    this._time = Math.min(this.duration, this.startAt);
    this.fire("loadedmetadata");
    for (const p of this.pendingPlay.splice(0)) {
      this.startPlaying();
      p.resolve();
    }
  }

  play(): Promise<void> {
    this.plays++;
    if (this.error) return Promise.reject(named("NotSupportedError", "The element has no supported sources."));
    if (!this._src) return Promise.reject(named("NotSupportedError", "no src"));
    if (this.readyState >= 2) {
      this.startPlaying();
      return Promise.resolve();
    }
    this.paused = false;
    return new Promise((resolve, reject) => this.pendingPlay.push({ resolve, reject }));
  }

  pause(): void {
    this.rejectPending("AbortError");
    if (this.paused) return;
    this.paused = true;
    this.fire("pause");
  }

  load(): void {
    this.rejectPending("AbortError");
  }

  removeAttribute(name: string): void {
    if (name === "src") {
      this.rejectPending("AbortError");
      this._src = "";
      this.readyState = 0;
      this.paused = true;
    }
    if (name === "crossorigin") this.crossOrigin = null;
  }

  addEventListener(type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add({ fn: fn as Listener, once: typeof opts === "object" && !!opts.once });
    this.listeners.set(type, set);
  }

  /** Move the clock by `ms` of wall time, if playing and not stalled. */
  advance(ms: number): void {
    if (this.paused || this.readyState < 2 || this.stalled || this.error) return;
    this._time += (ms / 1000) * this.playbackRate;
    if (this._time >= this.duration) {
      this._time = this.duration;
      this.ended = true;
      this.paused = true;
      this.fire("pause");
      this.fire("ended");
    }
  }

  /** The file stops being readable: an error event, as Chromium sends it. */
  fail(code: number): void {
    this.error = { code, message: "", MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 } as MediaError;
    this.paused = true;
    this.readyState = 0;
    this.rejectPending("NotSupportedError");
    this.fire("error");
  }

  /** Something outside the app paused it (the system, another app). */
  externalPause(): void {
    this.pause();
  }

  private startPlaying(): void {
    this.paused = false;
    this.fire("play");
    this.fire("playing");
  }

  private rejectPending(name: string): void {
    for (const p of this.pendingPlay.splice(0)) p.reject(named(name, name));
  }

  private fire(type: string): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const l of [...set]) {
      if (l.once) set.delete(l);
      l.fn(new Event(type));
    }
  }
}

function named(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}
