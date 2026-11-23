import { pipe, type Sink, type Source } from "@culvert/stream";

/**
 * The window of pages kept ready around the one being read (docs/COMICS.md,
 * section 5), so a turn never waits for a picture to arrive and decode.
 * It is a few pages wide whatever the comic's length: a 600-page book
 * costs what a 24-page issue does.
 *
 * Two parts. `windowAround` decides, purely, which pages to hold. The
 * `PageWindow` carries it out as a Culvert pipe: a Source of the pages
 * wanted, nearest first, which a transform fetches and decodes and a sink
 * keeps; turning the page moves the window, and a page no longer wanted
 * is let go, or abandoned if it was still on its way.
 */
export interface WindowSize {
  /** Pages kept behind the one being read, for a turn back. */
  behind: number;
  /** Pages kept ahead of it. */
  ahead: number;
}

/** Panels' window: a reader mostly goes forward, and sometimes back a page or two. */
export const WINDOW: WindowSize = { behind: 2, ahead: 8 };

/**
 * The pages to hold around `page`, nearest first: the page itself, then
 * outward, each step ahead before the one behind, since ahead is where
 * the reader is going. `forward` false (reading back through the comic)
 * mirrors it.
 */
export function windowAround(page: number, pages: number, size: WindowSize = WINDOW, forward = true): number[] {
  if (pages <= 0) return [];
  const at = Math.max(0, Math.min(pages - 1, page));
  // "Ahead" is the way the reader is going, whichever way that is.
  const [lead, trail] = [size.ahead, size.behind];
  const step = forward ? 1 : -1;
  const out = [at];
  for (let d = 1; d <= Math.max(lead, trail); d++) {
    for (const p of [d <= lead ? at + d * step : -1, d <= trail ? at - d * step : -1]) if (p >= 0 && p < pages && !out.includes(p)) out.push(p);
  }
  return out;
}

/** How a window fetches a page and lets one go. */
export interface PageLoader<T> {
  /** Bring a page in, ready to draw. Rejects when it can't be; an abort is not a failure. */
  load(page: number, signal: AbortSignal): Promise<T>;
  /** A page the window no longer holds: free what it took. */
  release?(page: number, loaded: T): void;
}

/**
 * The pages held ready. Ask for a page with `get`; move the window with
 * `moveTo` as the reader turns.
 */
export class PageWindow<T> {
  private readonly held = new Map<number, T>();
  private readonly loading = new Map<number, { abort: AbortController; done: Promise<T | undefined> }>();
  private readonly waiting = new Map<number, ((loaded: T | undefined) => void)[]>();
  private wanted: number[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private readonly running: Promise<void>;

  constructor(
    private readonly pages: number,
    private readonly loader: PageLoader<T>,
    private readonly size: WindowSize = WINDOW,
    /** How many pages are fetched at once. */
    private readonly atOnce = 3,
  ) {
    this.running = pipe(this.toLoad(), this.fetchAndKeep());
  }

  /** The pages wanted and not yet held or on their way, nearest first, for as long as the window is open. */
  private toLoad(): Source<number> {
    const self = this;
    return (async function* () {
      while (!self.closed) {
        const next = self.wanted.find((p) => !self.held.has(p) && !self.loading.has(p));
        if (next !== undefined && self.loading.size < self.atOnce) {
          yield next;
          continue;
        }
        // Nothing to start: wait for a turn of the page or a load to finish.
        await new Promise<void>((resolve) => (self.wake = resolve));
        self.wake = null;
      }
    })();
  }

  /** The sink: each page the source names is fetched, and kept if it is still wanted when it arrives. */
  private fetchAndKeep(): Sink<number> {
    return async (source) => {
      for await (const page of source) {
        // The window may have moved, or closed, between the source naming a page and it arriving here.
        if (this.closed || !this.wanted.includes(page)) continue;
        const abort = new AbortController();
        const done = this.loader.load(page, abort.signal).then(
          (loaded) => {
            this.loading.delete(page);
            if (this.closed || abort.signal.aborted || !this.wanted.includes(page)) {
              this.loader.release?.(page, loaded);
              return undefined;
            }
            this.held.set(page, loaded);
            return loaded;
          },
          () => {
            this.loading.delete(page);
            return undefined;
          },
        );
        this.loading.set(page, { abort, done });
        void done.then((loaded) => {
          this.answer(page, loaded);
          this.wake?.();
        });
      }
    };
  }

  /** Tell whoever asked for a page that it is here, or that it won't be. */
  private answer(page: number, loaded: T | undefined): void {
    for (const tell of this.waiting.get(page) ?? []) tell(loaded);
    this.waiting.delete(page);
  }

  /** The reader is at `page`, going `forward` or back: hold the pages around it, and let the rest go. */
  moveTo(page: number, forward = true): void {
    if (this.closed) return;
    this.wanted = windowAround(page, this.pages, this.size, forward);
    for (const [p, loaded] of this.held) {
      if (this.wanted.includes(p)) continue;
      this.held.delete(p);
      this.loader.release?.(p, loaded);
    }
    for (const [p, l] of this.loading) if (!this.wanted.includes(p)) l.abort.abort();
    for (const p of [...this.waiting.keys()]) if (!this.wanted.includes(p)) this.answer(p, undefined);
    this.wake?.();
  }

  /** A page if it is held now, without waiting. */
  peek(page: number): T | undefined {
    return this.held.get(page);
  }

  /** A page, as soon as it is ready: at once when held. Undefined when it couldn't be brought in, or the window moved off it first. */
  get(page: number): Promise<T | undefined> {
    const have = this.held.get(page);
    if (have !== undefined || this.closed || page < 0 || page >= this.pages) return Promise.resolve(have);
    if (!this.wanted.includes(page)) this.moveTo(page);
    return new Promise((resolve) => {
      const asked = this.waiting.get(page) ?? [];
      asked.push(resolve);
      this.waiting.set(page, asked);
    });
  }

  /** The pages held now, in page order: for tests and the measuring build. */
  holding(): number[] {
    return [...this.held.keys()].sort((a, b) => a - b);
  }

  /** Let everything go. */
  async close(): Promise<void> {
    this.closed = true;
    this.wanted = [];
    for (const l of this.loading.values()) l.abort.abort();
    for (const p of [...this.waiting.keys()]) this.answer(p, undefined);
    this.wake?.();
    await this.running;
    await Promise.all([...this.loading.values()].map((l) => l.done));
    for (const [p, loaded] of this.held) this.loader.release?.(p, loaded);
    this.held.clear();
  }
}
