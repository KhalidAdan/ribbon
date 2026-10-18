import { describe, expect, it } from "vitest";
import { applyCorrections, correctionsToRows, fileChapters, patternTitle, rowsToCorrections, type Correction } from "../src/core/scan/chapters";
import { chaptersUrl, fit, parseChapters, titlesAndTimes, titlesOnly } from "../src/core/audnexus";
import type { AudioFile, Chapter } from "../src/core/types";

const MIN = 60_000;
const chapters: Chapter[] = [0, 10, 20, 30].map((m, i) => ({ startMs: m * MIN, endMs: (m + 10) * MIN, title: `Track ${i + 1}` }));
const total = 40 * MIN;

describe("chapter tools", () => {
  it("shift a chapter and everything after it", () => {
    const out = applyCorrections(chapters, [{ op: "shift", index: 2, deltaMs: 30_000 }], total).chapters;
    expect(out.map((c) => c.startMs)).toEqual([0, 10 * MIN, 20.5 * MIN, 30.5 * MIN]);
    expect(out[1]!.endMs).toBe(20.5 * MIN);
  });

  it("a shift never starts the book late, and drops what goes past the end", () => {
    const out = applyCorrections(chapters, [{ op: "shift", index: 0, deltaMs: -MIN }], total).chapters;
    expect(out[0]!.startMs).toBe(0);
    const pushed = applyCorrections(chapters, [{ op: "shift", index: 3, deltaMs: 11 * MIN }], total).chapters;
    expect(pushed).toHaveLength(3);
  });

  it("name every chapter from a pattern", () => {
    expect(patternTitle("Chapter {n}", 3)).toBe("Chapter 3");
    expect(patternTitle("Part {nn}", 3)).toBe("Part 03");
    const out = applyCorrections(chapters, [{ op: "titles", pattern: "Chapter {n}", from: 0 }], total).chapters;
    expect(out.map((c) => c.title)).toEqual(["Chapter 0", "Chapter 1", "Chapter 2", "Chapter 3"]);
  });

  it("one chapter per file, whatever the markers say", () => {
    const files = [
      { path: "a.mp3", durationMs: 15 * MIN, title: "Side A", chapters: [{ startMs: 0, endMs: 5 * MIN, title: "x" }] },
      { path: "b.mp3", durationMs: 25 * MIN, title: "", chapters: [] },
    ] as unknown as AudioFile[];
    expect(fileChapters(files).map((c) => [c.title, c.startMs])).toEqual([
      ["Side A", 0],
      ["b", 15 * MIN],
    ]);
    expect(applyCorrections(chapters, [{ op: "files" }], total, files).chapters).toHaveLength(2);
  });

  it("every new op survives the record", () => {
    const list: Correction[] = [{ op: "shift", index: 2, deltaMs: -1500 }, { op: "titles", pattern: "Part {nn}", from: 1 }, { op: "clear" }, { op: "insert", startMs: 0, title: "One" }, { op: "files" }];
    expect(rowsToCorrections(correctionsToRows(list))).toEqual(list);
  });
});

const ANSWER = {
  asin: "B002V1OF70",
  brandIntroDurationMs: 3970,
  brandOutroDurationMs: 4945,
  runtimeLengthMs: 40 * MIN,
  chapters: [
    { lengthMs: 5 * MIN, startOffsetMs: 0, title: "Opening Credits" },
    { lengthMs: 15 * MIN, startOffsetMs: 5 * MIN, title: "Chapter 1" },
    { lengthMs: 20 * MIN, startOffsetMs: 20 * MIN, title: "Chapter 2" },
  ],
};

describe("lookup by ASIN", () => {
  it("asks the right address", () => {
    expect(chaptersUrl(" b002v1of70 ", "uk")).toBe("https://api.audnex.us/books/B002V1OF70/chapters?region=uk");
  });

  it("reads the answer, and refuses one that is not a chapter list", () => {
    const l = parseChapters(ANSWER)!;
    expect(l.chapters.map((c) => [c.title, c.startMs, c.endMs])).toEqual([
      ["Opening Credits", 0, 5 * MIN],
      ["Chapter 1", 5 * MIN, 20 * MIN],
      ["Chapter 2", 20 * MIN, 40 * MIN],
    ]);
    expect(l.introMs).toBe(3970);
    expect(parseChapters({ message: "not found" })).toBeNull();
    expect(parseChapters(null)).toBeNull();
  });

  it("says whether the times fit and the counts match", () => {
    const l = parseChapters(ANSWER)!;
    expect(fit(l, 40 * MIN + 30_000, 3)).toEqual({ diffMs: -30_000, timesFit: true, countsMatch: true });
    expect(fit(l, 50 * MIN, 4).timesFit).toBe(false);
  });

  it("titles only rename one for one; titles and times replace, scaled to the book", () => {
    const l = parseChapters(ANSWER)!;
    expect(applyCorrections(chapters, titlesOnly(l, 4), total).chapters.map((c) => c.title)).toEqual(["Opening Credits", "Chapter 1", "Chapter 2", "Track 4"]);
    const out = applyCorrections(chapters, titlesAndTimes(l, 44 * MIN), 44 * MIN).chapters;
    expect(out.map((c) => [c.title, c.startMs])).toEqual([
      ["Opening Credits", 0],
      ["Chapter 1", 5.5 * MIN],
      ["Chapter 2", 22 * MIN],
    ]);
    expect(out[2]!.endMs).toBe(44 * MIN);
  });
});
