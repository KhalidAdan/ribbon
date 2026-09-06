import { describe, expect, it } from "vitest";
import { resumePosition, rewindFor } from "../src/core/resume";

describe("rewindFor", () => {
  it.each([
    [0, 0, false],
    [9_999, 0, false],
    [10_000, 2_000, false],
    [119_999, 2_000, false],
    [120_000, 10_000, false],
    [3_599_999, 10_000, false],
    [3_600_000, 30_000, false],
    [86_399_999, 30_000, false],
    [86_400_000, 30_000, true],
    [604_799_999, 30_000, true],
    [604_800_000, 60_000, true],
    [-1, 0, false],
    [Number.NaN, 0, false],
  ])("gap %i → rewind %i, offer=%s", (gap, rewind, offer) => {
    expect(rewindFor(gap)).toEqual({ rewindMs: rewind, offerChapterRestart: offer });
  });
});

describe("resumePosition", () => {
  it("rewinds by the policy amount", () => {
    expect(resumePosition(100_000, 60_000, 0)).toBe(98_000);
  });

  it("never lands before the chapter start", () => {
    expect(resumePosition(100_500, 3_600_000, 100_000)).toBe(100_000);
  });

  it("never lands before zero", () => {
    expect(resumePosition(500, 3_600_000)).toBe(0);
  });

  it("at exactly the chapter start yields the chapter start", () => {
    expect(resumePosition(100_000, 3_600_000, 100_000)).toBe(100_000);
  });

  it("ignores a chapter start that is after the position", () => {
    expect(resumePosition(50_000, 60_000, 90_000)).toBe(48_000);
  });
});
