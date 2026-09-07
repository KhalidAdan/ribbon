import { describe, expect, it } from "vitest";
import { of, pipe, collect } from "@culvert/stream";
import { findRange, gapRate, parseSilenceDetect, silenceRanges } from "../src/core/silence";

const OUT = `
[silencedetect @ 0x1] silence_start: 2
[silencedetect @ 0x1] silence_end: 4.5 | silence_duration: 2.5
[silencedetect @ 0x1] silence_start: 10.25
[silencedetect @ 0x1] silence_end: 10.75 | silence_duration: 0.5
[silencedetect @ 0x1] silence_start: 20
`;

describe("silenceRanges as a live transform", () => {
  it("closes each range as its end line arrives and the last at end of file", async () => {
    const out = await pipe(of("[silencedetect @ 0] silence_start: 1", "noise", "[silencedetect @ 0] silence_end: 3.5 | silence_duration: 2.5", "[silencedetect @ 0] silence_start: 8"), silenceRanges(10_000), collect());
    expect(out).toEqual([
      { startMs: 1000, endMs: 3500 },
      { startMs: 8000, endMs: 10_000 },
    ]);
  });
});

describe("parseSilenceDetect", () => {
  it("parses pairs into ranges and closes an open range at file end", async () => {
    expect(await parseSilenceDetect(OUT, 25_000)).toEqual([
      { startMs: 2000, endMs: 4500 },
      { startMs: 20_000, endMs: 25_000 },
    ]);
  });

  it("drops ranges under the threshold", async () => {
    expect(await parseSilenceDetect(OUT, 25_000, 100)).toHaveLength(3);
  });

  it("returns nothing for empty output", async () => {
    expect(await parseSilenceDetect("", 1000)).toEqual([]);
  });

  it("ignores an end with no start", async () => {
    expect(await parseSilenceDetect("silence_end: 5", 1000)).toEqual([]);
  });
});

describe("findRange", () => {
  const ranges = [
    { startMs: 1000, endMs: 2000 },
    { startMs: 5000, endMs: 9000 },
  ];
  it("is inclusive-start, exclusive-end", async () => {
    expect(findRange(ranges, 999)).toBeNull();
    expect(findRange(ranges, 1000)).toEqual(ranges[0]);
    expect(findRange(ranges, 1999)).toEqual(ranges[0]);
    expect(findRange(ranges, 2000)).toBeNull();
    expect(findRange(ranges, 7000)).toEqual(ranges[1]);
    expect(findRange(ranges, 9000)).toBeNull();
  });
  it("handles empty", async () => {
    expect(findRange([], 5)).toBeNull();
  });
});

describe("gapRate", () => {
  it("shortens a gap to the target length", async () => {
    expect(gapRate({ startMs: 0, endMs: 3000 })).toBe(3);
    expect(gapRate({ startMs: 0, endMs: 1500 })).toBe(2.5);
    expect(gapRate({ startMs: 0, endMs: 600 })).toBe(1);
    expect(gapRate({ startMs: 0, endMs: 100 })).toBe(1);
  });
  it("caps at 8", async () => {
    expect(gapRate({ startMs: 0, endMs: 60_000 })).toBe(3);
  });
});
