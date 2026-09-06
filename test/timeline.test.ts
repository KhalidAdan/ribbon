import { describe, expect, it } from "vitest";
import { fileStarts, locate, toBookOffset, totalDuration } from "../src/core/timeline";

const D = [1000, 2000, 3000];

describe("locate", () => {
  it.each([
    [0, 0, 0, false],
    [999, 0, 999, false],
    [1000, 1, 0, false],
    [2999, 1, 1999, false],
    [3000, 2, 0, false],
    [5999, 2, 2999, false],
    [6000, 2, 3000, true],
    [7000, 2, 3000, true],
    [-5, 0, 0, false],
  ])("offset %i is file %i at %i (end=%s)", (offset, file, local, atEnd) => {
    expect(locate(D, offset)).toEqual({ fileIndex: file, fileOffsetMs: local, atEnd });
  });

  it("handles NaN as zero", () => {
    expect(locate(D, Number.NaN)).toEqual({ fileIndex: 0, fileOffsetMs: 0, atEnd: false });
  });

  it("skips zero-duration files", () => {
    expect(locate([0, 1000, 0, 500], 1000)).toEqual({ fileIndex: 3, fileOffsetMs: 0, atEnd: false });
    expect(locate([0, 1000, 0], 1000)).toEqual({ fileIndex: 1, fileOffsetMs: 1000, atEnd: true });
  });

  it("handles an empty book", () => {
    expect(locate([], 10)).toEqual({ fileIndex: 0, fileOffsetMs: 0, atEnd: true });
  });
});

describe("toBookOffset", () => {
  it("is exact at every boundary", () => {
    for (let off = 0; off <= 6000; off++) {
      const l = locate(D, off);
      expect(toBookOffset(D, l.fileIndex, l.fileOffsetMs)).toBe(off);
    }
  });

  it("clamps file index and offset", () => {
    expect(toBookOffset(D, 99, 0)).toBe(3000);
    expect(toBookOffset(D, -1, 50)).toBe(50);
    expect(toBookOffset(D, 0, 5000)).toBe(1000);
    expect(toBookOffset(D, 1, -5)).toBe(1000);
  });
});

describe("totals", () => {
  it("sums durations, ignoring negatives", () => {
    expect(totalDuration(D)).toBe(6000);
    expect(totalDuration([1, -5, 2])).toBe(3);
    expect(totalDuration([])).toBe(0);
  });

  it("computes file starts", () => {
    expect(fileStarts(D)).toEqual([0, 1000, 3000]);
  });
});
