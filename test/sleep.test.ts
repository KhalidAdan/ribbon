import { describe, expect, it } from "vitest";
import { FADE_MS, IDLE, cancel, extend, pause, resume, start, tick, type SleepTick } from "../src/core/sleep";

const base: SleepTick = { nowMs: 0, positionMs: 0, chapterEndMs: null, speed: 1, playing: true };

describe("duration mode", () => {
  it("fires at start plus duration", () => {
    let s = start({ kind: "duration", ms: 60_000 }, 1000);
    let out;
    [s, out] = tick(s, { ...base, nowMs: 30_000 });
    expect(out).toEqual({ gain: 1, fire: false, remainingMs: 31_000 });
    [s, out] = tick(s, { ...base, nowMs: 61_000 });
    expect(out.fire).toBe(true);
    expect(out.gain).toBe(0);
    [s, out] = tick(s, { ...base, nowMs: 70_000 });
    expect(out.fire).toBe(false);
  });

  it("fades linearly over the last 15 seconds", () => {
    const s = start({ kind: "duration", ms: 60_000 }, 0);
    expect(tick(s, { ...base, nowMs: 60_000 - FADE_MS })[1].gain).toBe(1);
    expect(tick(s, { ...base, nowMs: 60_000 - FADE_MS / 2 })[1].gain).toBeCloseTo(0.5);
    expect(tick(s, { ...base, nowMs: 60_000 - 1 })[1].gain).toBeCloseTo(1 / FADE_MS);
    expect(tick(s, { ...base, nowMs: 60_000 })[1].gain).toBe(0);
  });

  it("extend adds time and cancels the fade", () => {
    let s = start({ kind: "duration", ms: 20_000 }, 0);
    expect(tick(s, { ...base, nowMs: 15_000 })[1].gain).toBeCloseTo(5_000 / FADE_MS);
    s = extend(s, 60_000, 15_000);
    expect(tick(s, { ...base, nowMs: 15_000 })[1]).toEqual({ gain: 1, fire: false, remainingMs: 65_000 });
  });

  it("extend after firing restarts the timer", () => {
    let s = start({ kind: "duration", ms: 1000 }, 0);
    [s] = tick(s, { ...base, nowMs: 2000 });
    s = extend(s, 5000, 2000);
    expect(tick(s, { ...base, nowMs: 2000 })[1].remainingMs).toBe(5000);
  });

  it("pause stops the clock, resume shifts the deadline", () => {
    let s = start({ kind: "duration", ms: 60_000 }, 0);
    s = pause(s, 10_000);
    expect(tick(s, { ...base, nowMs: 50_000 })[1].remainingMs).toBe(50_000);
    s = resume(s, 30_000);
    expect(tick(s, { ...base, nowMs: 30_000 })[1].remainingMs).toBe(50_000);
    expect(tick(s, { ...base, nowMs: 80_000 })[1].fire).toBe(true);
  });

  it("cancel returns to idle with gain 1", () => {
    const s = cancel();
    expect(s).toEqual(IDLE);
    expect(tick(s, base)[1]).toEqual({ gain: 1, fire: false, remainingMs: null });
  });

  it("speed does not affect wall-clock duration", () => {
    const s = start({ kind: "duration", ms: 60_000 }, 0);
    expect(tick(s, { ...base, nowMs: 30_000, speed: 2 })[1].remainingMs).toBe(30_000);
  });
});

describe("chapter mode", () => {
  it("fires at the chapter end and respects speed", () => {
    const s = start({ kind: "chapter" }, 0);
    expect(tick(s, { ...base, positionMs: 0, chapterEndMs: 100_000, speed: 2 })[1].remainingMs).toBe(50_000);
    expect(tick(s, { ...base, positionMs: 99_000, chapterEndMs: 100_000 })[1].gain).toBeCloseTo(1000 / FADE_MS);
    expect(tick(s, { ...base, positionMs: 100_000, chapterEndMs: 100_000 })[1].fire).toBe(true);
  });

  it("follows a seek into a different chapter", () => {
    const s = start({ kind: "chapter" }, 0);
    expect(tick(s, { ...base, positionMs: 10_000, chapterEndMs: 20_000 })[1].remainingMs).toBe(10_000);
    expect(tick(s, { ...base, positionMs: 500_000, chapterEndMs: 900_000 })[1].remainingMs).toBe(400_000);
  });

  it("is inert without a chapter end", () => {
    const s = start({ kind: "chapter" }, 0);
    expect(tick(s, base)[1]).toEqual({ gain: 1, fire: false, remainingMs: null });
  });

  it("extend converts to a duration timer", () => {
    let s = start({ kind: "chapter" }, 0);
    s = extend(s, 300_000, 1000);
    expect(s.mode).toEqual({ kind: "duration", ms: 300_000 });
    expect(tick(s, { ...base, nowMs: 1000 })[1].remainingMs).toBe(300_000);
  });
});
