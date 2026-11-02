import type { ProfilerOnRenderCallback } from "react";
import { log } from "./log";

/**
 * How fast Ribbon feels, measured where it runs. Nothing here changes
 * what the app does: it times what you would feel, keeps the samples in
 * memory, and, when the setting is on (`setLogging`), writes a summary to
 * the log every minute (median, 95th percentile, worst). Scripts read it
 * whenever they like through `window.__ribbonPerf`.
 *
 * What is measured:
 * - **Interactions:** from the input's own timestamp (the press, the key)
 *   to the first frame that shows the result: `page turn`, `page turn
 *   into a chapter`, `open the reader`. Started with `begin`, finished by
 *   the code that shows the result with `end`, which waits for the frame.
 * - **Input, as the browser reports it** (Event Timing): for any press or
 *   key slower than 16 ms, how long it waited before running, ran, and
 *   then waited for the frame. The browser rounds these to 8 ms and
 *   leaves faster ones out, so the interactions above are timed directly.
 * - **React's work:** each commit of the parts profiled (`<Profiler>`),
 *   by name and whether it mounted or updated.
 * - **Layout:** each chapter set in lines and pages.
 * - **Long tasks:** anything that held the main thread 50 ms or more.
 * - **Frames while scrolling:** the time between frames.
 * - **Presses:** how long a press on a labelled control is held before
 *   its click fires, which acting on the press instead would save.
 */

const KEEP = 5_000;
const samples = new Map<string, number[]>();
const pending = new Map<string, number>();

/** One measurement, in ms. */
export function record(name: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  let list = samples.get(name);
  if (!list) samples.set(name, (list = []));
  list.push(ms);
  if (list.length > KEEP) list.splice(0, list.length - KEEP);
}

/** Time a piece of synchronous work. */
export function time<T>(name: string, fn: () => T): T {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    record(name, performance.now() - t0);
  }
}

/** An interaction starts: at an input's own timestamp (`event.timeStamp`), or now. */
export function begin(name: string, at: number = performance.now()): void {
  pending.set(name, at);
}

/**
 * An interaction's result is on screen: called once React has committed
 * it, this waits for the frame that shows it and records the whole time
 * from `begin`. `as` files it under another name (a turn that crossed into
 * a new chapter). Nothing when nothing began.
 */
export function end(name: string, as: string = name): void {
  const at = pending.get(name);
  if (at === undefined) return;
  pending.delete(name);
  afterPaint(() => record(as, performance.now() - at));
}

/** Part of the way: the time from `begin` to the next frame, recorded as `as`, with `name` still running. */
export function reached(name: string, as: string): void {
  const at = pending.get(name);
  if (at !== undefined) afterPaint(() => record(as, performance.now() - at));
}

/** After the next frame is painted: a frame, then a task after it. */
function afterPaint(fn: () => void): void {
  requestAnimationFrame(() => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => fn();
    ch.port2.postMessage(null);
  });
}

/** For `<Profiler onRender>`: each commit of a profiled part, by id and phase. */
export const onRender: ProfilerOnRenderCallback = (id, phase, actualDuration) => {
  record(`render ${id} (${phase === "mount" ? "mount" : "update"})`, actualDuration);
};

/** Time between frames, for half a second from now: called as scrolling goes on, so it covers it. */
let framesUntil = 0;
export function sampleFrames(name: string): void {
  const now = performance.now();
  const running = framesUntil > now;
  framesUntil = now + 500;
  if (running) return;
  let last = now;
  const step = (t: number) => {
    record(name, t - last);
    last = t;
    if (t < framesUntil) requestAnimationFrame(step);
  };
  requestAnimationFrame((t) => {
    last = t;
    requestAnimationFrame(step);
  });
}

export interface Stat {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

function stat(list: number[]): Stat {
  const s = [...list].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  const r = (x: number) => Math.round(x * 10) / 10;
  return { n: s.length, p50: r(at(0.5)), p95: r(at(0.95)), max: r(s[s.length - 1]!) };
}

/** Every measurement so far, summarised. */
export function summary(): Record<string, Stat> {
  return Object.fromEntries([...samples].filter(([, l]) => l.length > 0).map(([k, l]) => [k, stat(l)]));
}

export function reset(): void {
  samples.clear();
  pending.clear();
}

/** What an input landed on, for the record: the nearest `data-perf` label, else the element's name. */
function labelOf(target: Node | null | undefined): string {
  const el = target instanceof Element ? target : null;
  const named = el?.closest<HTMLElement>("[data-perf]")?.dataset.perf;
  return named ?? (el ? el.tagName.toLowerCase() : "page");
}

let logged = 0;
let logging = false;

/** Write the summary to the log each minute, and long tasks as they happen (Settings → Ribbon folder). */
export function setLogging(on: boolean): void {
  logging = on;
}

/** Watch inputs, long tasks and the time; summarise to the log each minute. Returns a stop. */
export function startPerf(): () => void {
  const stops: (() => void)[] = [];
  const observe = (opts: PerformanceObserverInit & { durationThreshold?: number }, each: (e: PerformanceEntry) => void) => {
    try {
      const o = new PerformanceObserver((list) => list.getEntries().forEach(each));
      o.observe(opts);
      stops.push(() => o.disconnect());
    } catch {
      /* not in this browser */
    }
  };
  observe({ type: "event", buffered: true, durationThreshold: 16 }, (e) => {
    const t = e as PerformanceEventTiming;
    if (!["pointerdown", "pointerup", "click", "keydown", "keyup"].includes(t.name)) return;
    const what = `input ${t.name} on ${labelOf(t.target)}`;
    record(`${what}: total`, t.duration);
    record(`${what}: waited`, t.processingStart - t.startTime);
    record(`${what}: ran`, t.processingEnd - t.processingStart);
    record(`${what}: to frame`, t.startTime + t.duration - t.processingEnd);
  });
  observe({ type: "longtask", buffered: true }, (e) => {
    record("long task", e.duration);
    if (logging && e.duration >= 100) log.info(`perf: the main thread was busy for ${Math.round(e.duration)} ms`);
  });
  // How long a press is held before its click fires, on anything labelled: what acting on the press would save.
  let pressed = 0;
  const onDown = (e: PointerEvent) => (pressed = e.timeStamp);
  const onClick = (e: MouseEvent) => {
    const label = (e.target as Element | null)?.closest?.<HTMLElement>("[data-perf]")?.dataset.perf;
    if (label && pressed > 0) record(`press to click on ${label}`, e.timeStamp - pressed);
  };
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("click", onClick, true);
  stops.push(() => {
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("click", onClick, true);
  });
  const id = setInterval(() => {
    const total = [...samples.values()].reduce((n, l) => n + l.length, 0);
    if (!logging || total === logged) return;
    logged = total;
    log.info(`perf: ${format(summary())}`);
  }, 60_000);
  stops.push(() => clearInterval(id));
  (globalThis as unknown as { __ribbonPerf: unknown }).__ribbonPerf = { summary, reset, record };
  return () => stops.forEach((s) => s());
}

/** A summary on one line: name n=, median, 95th percentile and worst, in ms. */
export function format(s: Record<string, Stat>): string {
  return Object.entries(s)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k} n=${v.n} p50=${v.p50} p95=${v.p95} max=${v.max}`)
    .join("; ");
}
