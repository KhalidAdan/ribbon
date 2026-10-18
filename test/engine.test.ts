import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlayerEngine, type EngineState } from "../src/player/engine";
import { FakeMedia } from "./support/fake-media";
import { STALL_MS, recoveryDelayMs } from "../src/core/recovery";
import type { AudioFile } from "../src/core/types";

const MIN = 60_000;

function file(path: string, durationMs: number): AudioFile {
  FakeMedia.durations.set(`url:${path}`, durationMs / 1000);
  return { path, durationMs } as AudioFile;
}

function setup(files: AudioFile[], startMs = 0) {
  const states: EngineState[] = [];
  const logs: string[] = [];
  let ended = 0;
  const engine = new PlayerEngine({
    resolveUrl: (p) => `url:${p}`,
    onState: (s) => states.push(s),
    onEnded: () => ended++,
    onLog: (m) => logs.push(m),
    createElement: () => new FakeMedia(),
  });
  const book = { id: "b1", files, chapters: [] };
  return {
    engine,
    states,
    logs,
    ended: () => ended,
    last: () => states[states.length - 1]!,
    load: async () => {
      await engine.load(book, startMs);
      await flush();
    },
  };
}

/** Let promises and microtasks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Wall time passes: playing elements move, timers fire. */
async function run(ms: number, step = 100): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    for (const m of FakeMedia.all) m.advance(step);
    await vi.advanceTimersByTimeAsync(step);
    await flush();
  }
}

function active(): FakeMedia {
  // The engine's active element is the one with a source that is not paused, else the first with a source.
  return FakeMedia.all.find((m) => m.src && !m.paused) ?? FakeMedia.all.find((m) => m.src)!;
}

beforeEach(() => {
  FakeMedia.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PlayerEngine: the basics", () => {
  it("plays, moves the clock, pauses and keeps the place", async () => {
    const t = setup([file("a.mp3", 10 * MIN)], 30_000);
    await t.load();
    await t.engine.play();
    await run(5_000);
    expect(t.last().playing).toBe(true);
    expect(t.engine.positionMs()).toBeGreaterThanOrEqual(34_500);
    t.engine.pause();
    const at = t.engine.positionMs();
    await run(5_000);
    expect(t.last().playing).toBe(false);
    expect(t.engine.positionMs()).toBe(at);
  });

  it("crosses files without a gap and reports the book position", async () => {
    const t = setup([file("a.mp3", 3_000), file("b.mp3", 60_000)]);
    await t.load();
    await t.engine.play();
    await run(5_000);
    expect(t.last().playing).toBe(true);
    expect(t.engine.positionMs()).toBeGreaterThanOrEqual(4_500);
    expect(t.engine.positionMs()).toBeLessThan(6_000);
  });

  it("ends at the end of the last file", async () => {
    const t = setup([file("a.mp3", 2_000)]);
    await t.load();
    await t.engine.play();
    await run(3_000);
    expect(t.ended()).toBe(1);
    expect(t.last().playing).toBe(false);
    expect(t.engine.positionMs()).toBe(2_000);
  });
});

describe("PlayerEngine: never loses the place", () => {
  it("reports where it was told to start while the file is still loading", async () => {
    FakeMedia.manualLoad = true;
    const t = setup([file("a.mp3", 10 * MIN)], 4 * MIN);
    await t.load();
    expect(t.engine.positionMs()).toBe(4 * MIN);
  });

  it("does not report 0 after the file fails", async () => {
    const t = setup([file("a.mp3", 10 * MIN)], 2 * MIN);
    await t.load();
    await t.engine.play();
    await run(3_000);
    const before = t.engine.positionMs();
    active().fail(2);
    expect(t.engine.positionMs()).toBe(before);
    t.engine.pause();
    expect(t.engine.positionMs()).toBe(before);
  });

  it("a seek is the place at once, even before the element catches up", async () => {
    FakeMedia.manualLoad = true;
    const t = setup([file("a.mp3", 5_000), file("b.mp3", 10 * MIN)]);
    await t.load();
    t.engine.seek(7 * MIN);
    expect(t.engine.positionMs()).toBe(7 * MIN);
  });
});

describe("PlayerEngine: recovers by itself", () => {
  it("reloads a failed file at the last good position and carries on", async () => {
    const t = setup([file("a.mp3", 10 * MIN)], MIN);
    await t.load();
    await t.engine.play();
    await run(2_000);
    const before = t.engine.positionMs();
    active().fail(2);
    await flush();
    expect(t.last().reconnecting).toBe(true);
    expect(t.last().error).toBeNull();
    await run(recoveryDelayMs(0) + 500);
    expect(t.last().playing).toBe(true);
    expect(t.last().reconnecting).toBe(false);
    expect(t.engine.positionMs()).toBeGreaterThanOrEqual(before);
    expect(t.engine.positionMs()).toBeLessThan(before + 2_000);
  });

  it("keeps trying while the share is away, says so after a few tries, and resumes when it is back", async () => {
    const t = setup([file("a.mp3", 10 * MIN)], MIN);
    await t.load();
    await t.engine.play();
    await run(1_000);
    FakeMedia.broken.set("url:a.mp3", 2);
    active().fail(2);
    await run(40_000);
    expect(t.last().playing).toBe(false);
    expect(t.last().reconnecting).toBe(true);
    expect(t.last().error).toMatch(/Still trying/);
    FakeMedia.broken.delete("url:a.mp3");
    await run(35_000);
    expect(t.last().playing).toBe(true);
    expect(t.last().error).toBeNull();
    expect(t.engine.positionMs()).toBeGreaterThanOrEqual(MIN + 1_000);
  });

  it("treats a stall as a failure and reloads", async () => {
    const t = setup([file("a.mp3", 10 * MIN)]);
    await t.load();
    await t.engine.play();
    await run(1_000);
    const el = active();
    el.stalled = true;
    await run(STALL_MS + recoveryDelayMs(0) + 1_000);
    expect(t.logs.some((l) => l.includes("no progress"))).toBe(true);
    expect(t.last().playing).toBe(true);
    await run(2_000);
    expect(t.engine.positionMs()).toBeGreaterThan(1_500);
  });

  it("steps over damaged audio that fails to decode twice in the same place", async () => {
    const t = setup([file("a.mp3", 10 * MIN)], MIN);
    await t.load();
    await t.engine.play();
    await run(500);
    active().fail(3);
    await run(recoveryDelayMs(0) + 100);
    const second = t.engine.positionMs();
    active().fail(3);
    await run(recoveryDelayMs(1) + 300);
    expect(t.engine.positionMs()).toBeGreaterThanOrEqual(second + 2_000);
    expect(t.last().playing).toBe(true);
  });

  it("does not retry once the listener has paused", async () => {
    const t = setup([file("a.mp3", 10 * MIN)]);
    await t.load();
    await t.engine.play();
    await run(500);
    FakeMedia.broken.set("url:a.mp3", 2);
    active().fail(2);
    t.engine.pause();
    const plays = FakeMedia.all.reduce((n, m) => n + m.plays, 0);
    await run(60_000);
    expect(FakeMedia.all.reduce((n, m) => n + m.plays, 0)).toBe(plays);
    expect(t.last().reconnecting).toBe(false);
  });

  it("reloads a failed file when play is pressed again", async () => {
    const t = setup([file("a.mp3", 10 * MIN)], 3 * MIN);
    await t.load();
    active().fail(2);
    await flush();
    await t.engine.play();
    await run(1_000);
    expect(t.last().playing).toBe(true);
    expect(t.engine.positionMs()).toBeGreaterThanOrEqual(3 * MIN);
  });

  it("loads the next file itself when the standby never loaded", async () => {
    const t = setup([file("a.mp3", 2_000), file("b.mp3", 10 * MIN)]);
    await t.load();
    await t.engine.play();
    const standby = FakeMedia.all.find((m) => m.src === "url:b.mp3")!;
    standby.fail(2);
    await run(3_000);
    expect(t.last().playing).toBe(true);
    expect(t.engine.positionMs()).toBeGreaterThanOrEqual(2_000);
  });
});

describe("PlayerEngine: fast hands", () => {
  it("a pause during a slow play() wins: no audio after the pause", async () => {
    FakeMedia.manualLoad = true;
    const t = setup([file("a.mp3", 10 * MIN)]);
    await t.load();
    const playing = t.engine.play();
    t.engine.pause();
    FakeMedia.loadAll();
    await playing;
    await run(1_000);
    expect(t.last().playing).toBe(false);
  });

  it("a seek across files while playing is not an error", async () => {
    const t = setup([file("a.mp3", 5 * MIN), file("b.mp3", 5 * MIN)]);
    await t.load();
    await t.engine.play();
    await run(500);
    t.engine.seek(7 * MIN);
    await run(1_000);
    expect(t.states.some((s) => s.error)).toBe(false);
    expect(t.last().playing).toBe(true);
    expect(t.engine.positionMs()).toBeGreaterThanOrEqual(7 * MIN);
  });

  it("twenty skips in a row land where they add up to", async () => {
    const t = setup([file("a.mp3", 3 * MIN), file("b.mp3", 3 * MIN), file("c.mp3", 3 * MIN)]);
    await t.load();
    await t.engine.play();
    for (let i = 0; i < 20; i++) t.engine.seek(t.engine.positionMs() + 15_000);
    await run(500);
    expect(t.engine.positionMs()).toBeGreaterThanOrEqual(5 * MIN);
    expect(t.engine.positionMs()).toBeLessThan(5 * MIN + 2_000);
    expect(t.last().playing).toBe(true);
  });

  it("a pause from outside the app is respected, not undone by the watchdog", async () => {
    const t = setup([file("a.mp3", 10 * MIN)]);
    await t.load();
    await t.engine.play();
    await run(1_000);
    active().externalPause();
    await run(STALL_MS * 3);
    expect(t.last().playing).toBe(false);
    expect(t.last().reconnecting).toBe(false);
  });

  it("loading a second book while the first is still loading leaves only the second", async () => {
    const t = setup([file("a.mp3", 10 * MIN)]);
    const first = t.engine.load({ id: "one", files: [file("a.mp3", 10 * MIN)], chapters: [] }, 0);
    const second = t.engine.load({ id: "two", files: [file("z.mp3", 10 * MIN)], chapters: [] }, 5_000);
    await Promise.all([first, second]);
    await flush();
    expect(t.last().bookId).toBe("two");
    expect(t.engine.positionMs()).toBe(5_000);
  });
});
