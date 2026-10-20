import type { Ebook } from "../core/ebook";
import * as perf from "../app/perf";
import { log } from "../app/log";
import { addFaces } from "./faces";
import { layOutSection, specKey, type FromWorker, type LayoutSpec, type SectionLayout, type ToWorker } from "./layout";
import { Typesetter } from "./typeset";

/**
 * Where the reader's chapters get laid out: in a worker (layout.worker.ts)
 * wherever one can run (Chromium, so Windows and Android, and WebKit from
 * iOS 16.4), else on the page, one chapter per task. Either way the page
 * asks for what it needs now and gets it first, then the chapters around
 * it, then the rest of the book outward, and never waits on a long chapter
 * while you read.
 *
 * Laid-out chapters are kept for the current layout spec (text size, column,
 * page height, justification); a new spec starts again.
 */
export class LayoutEngine {
  private readonly cache = new Map<number, SectionLayout>();
  private readonly waiters = new Map<number, ((l: SectionLayout) => void)[]>();
  /** Sections the page is showing or about to: their arrival redraws it. */
  private readonly watched = new Set<number>();
  /** How many views watch every chapter (the scroll, which places the whole book). */
  private watchingAll = 0;
  private readonly listeners = new Set<(section: number) => void>();
  private queue: number[] = [];
  private spec: LayoutSpec | null = null;
  private key = "";
  private generation = 0;
  /** The generation the request in the worker was made for: an answer for an older spec is dropped. */
  private pendingGeneration = 0;
  private busy = false;
  private nextId = 1;
  private worker: Worker | null = null;
  private local: { typesetter: Typesetter; ready: Promise<void> } | null = null;
  /** Bumped when a section the page watches arrives, or the spec changes: what React reads to redraw. */
  version = 0;
  hyphenates = false;
  private readonly images: string[];

  constructor(private readonly ebook: Ebook) {
    this.images = Object.keys(ebook.files ?? {});
    try {
      if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") throw new Error("no worker here");
      const w = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<FromWorker>) => this.fromWorker(e.data);
      w.onerror = (e) => {
        log.warn(`the layout worker failed (${e.message}); laying out on the page`);
        this.goLocal();
      };
      const open: ToWorker = { kind: "open", ebook, images: this.images };
      w.postMessage(open);
      this.worker = w;
    } catch {
      this.goLocal();
    }
  }

  /** Lay out on the page instead: where no worker runs, or one failed. What was asked of the worker is asked again. */
  private goLocal(): void {
    this.worker?.terminate();
    this.worker = null;
    if (this.local) return;
    const images = new Set(this.images);
    const typesetter = new Typesetter(this.ebook, (src) => images.has(src));
    const faces = typeof document !== "undefined" && document.fonts ? addFaces(document.fonts) : Promise.resolve();
    this.local = { typesetter, ready: Promise.all([typesetter.ready, faces]).then(() => {
      this.hyphenates = typesetter.hyphenates;
      this.bump();
    }) };
    this.busy = false;
    this.pump();
  }

  subscribe = (fn: (section: number) => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  private bump(section = -1): void {
    this.version++;
    for (const l of this.listeners) l(section);
  }

  /** Set the layout spec. Idempotent: the same spec changes nothing. */
  setSpec(spec: LayoutSpec): void {
    const key = specKey(spec);
    if (key === this.key) return;
    this.key = key;
    this.spec = spec;
    this.generation++;
    this.cache.clear();
    this.queue = [];
    this.bump();
    this.pump();
  }

  /** The current layout spec, as a key (layout.ts, specKey). */
  get specKey(): string {
    return this.key;
  }

  /**
   * A chapter laid out earlier for this same spec (a snapshot, snapshot.ts),
   * taken as if just laid out: nothing to wait for. Ignored for another spec.
   */
  seed(section: number, layout: SectionLayout, key: string): void {
    if (key !== this.key || this.cache.has(section)) return;
    this.cache.set(section, layout);
  }

  /** A chapter, if it is laid out for the current spec. */
  get(section: number): SectionLayout | undefined {
    return this.cache.get(section);
  }

  /** The page needs these now, most needed first: they go to the front, and their arrival redraws it. */
  want(sections: readonly number[]): void {
    for (const s of sections) this.watched.add(s);
    const missing = sections.filter((s) => !this.cache.has(s));
    this.queue = [...missing, ...this.queue.filter((s) => !missing.includes(s))];
    this.pump();
  }

  /** Redraw on every chapter that arrives, until the returned function is called: for a view of the whole book. */
  watchAll(): () => void {
    this.watchingAll++;
    return () => void this.watchingAll--;
  }

  /** Lay these out when nothing more pressing is asked, in this order. */
  later(sections: readonly number[]): void {
    const add = sections.filter((s) => !this.cache.has(s) && !this.queue.includes(s));
    this.queue.push(...add);
    this.pump();
  }

  /** A chapter, laid out first if it is not yet. */
  request(section: number): Promise<SectionLayout> {
    const have = this.cache.get(section);
    if (have) return Promise.resolve(have);
    return new Promise((resolve) => {
      const list = this.waiters.get(section) ?? [];
      list.push(resolve);
      this.waiters.set(section, list);
      this.want([section]);
    });
  }

  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
    this.listeners.clear();
  }

  private pump(): void {
    if (this.busy || !this.spec) return;
    let section: number | undefined;
    while ((section = this.queue.shift()) !== undefined && this.cache.has(section));
    if (section === undefined) return;
    this.busy = true;
    const spec = this.spec;
    const generation = this.generation;
    if (this.worker) {
      const message: ToWorker = { kind: "lay out", id: this.nextId++, section, spec };
      this.pendingGeneration = generation;
      this.worker.postMessage(message);
      return;
    }
    const local = this.local!;
    const s = section;
    // One chapter per task, so the page stays responsive between them.
    void local.ready.then(
      () =>
        new Promise<void>((done) =>
          setTimeout(() => {
            if (generation === this.generation) {
              const t0 = performance.now();
              const layout = layOutSection(local.typesetter, s, spec);
              this.arrived(s, layout, performance.now() - t0, "on the page");
            }
            this.busy = false;
            this.pump();
            done();
          }, 0),
        ),
    );
  }

  private fromWorker(m: FromWorker): void {
    if (m.kind === "ready") {
      this.hyphenates = m.hyphenates;
      this.bump();
      return;
    }
    const current = this.pendingGeneration === this.generation;
    if (m.kind === "laid out" && current) this.arrived(m.section, m.layout, m.ms, "in the worker");
    if (m.kind === "failed") log.warn(`could not lay out section ${m.section}: ${m.message}`);
    this.busy = false;
    this.pump();
  }

  private arrived(section: number, layout: SectionLayout, ms: number, where: string): void {
    perf.record(`lay out a chapter (${where})`, ms);
    this.cache.set(section, layout);
    for (const resolve of this.waiters.get(section) ?? []) resolve(layout);
    this.waiters.delete(section);
    if (this.watchingAll > 0 || this.watched.has(section)) this.bump(section);
  }
}
