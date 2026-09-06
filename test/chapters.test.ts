import { describe, expect, it } from "vitest";
import { applyCorrections, buildChapters, chapterAt, correctionsToRows, normalize, rowsToCorrections, type Correction } from "../src/core/scan/chapters";
import type { AudioFile } from "../src/core/types";

const file = (path: string, durationMs: number, over: Partial<AudioFile> = {}): AudioFile => ({
  path,
  order: 0,
  durationMs,
  sizeBytes: 1,
  mtimeMs: 0,
  title: "",
  disc: 1,
  track: 0,
  hasCover: false,
  chapters: [],
  ...over,
});

describe("buildChapters", () => {
  it("uses embedded chapters from a single file", () => {
    const f = file("b.m4b", 6000, { chapters: [{ startMs: 0, endMs: 2000, title: "A" }, { startMs: 2000, endMs: 6000, title: "B" }] });
    expect(buildChapters([f])).toEqual([
      { startMs: 0, endMs: 2000, title: "A" },
      { startMs: 2000, endMs: 6000, title: "B" },
    ]);
  });

  it("infers one chapter per file with exact accumulated starts", () => {
    const ch = buildChapters([file("B/Chapter 1.m4a", 1000, { title: "Chapter 1" }), file("B/Chapter 2.m4a", 2000, { title: "Chapter 2" }), file("B/x.m4a", 3000)]);
    expect(ch).toEqual([
      { startMs: 0, endMs: 1000, title: "Chapter 1" },
      { startMs: 1000, endMs: 3000, title: "Chapter 2" },
      { startMs: 3000, endMs: 6000, title: "x" },
    ]);
  });

  it("offsets embedded chapters in later files", () => {
    const ch = buildChapters([file("a", 1000), file("b", 2000, { chapters: [{ startMs: 0, endMs: 500, title: "b1" }, { startMs: 500, endMs: 2000, title: "b2" }] })]);
    expect(ch.map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 1000],
      [1000, 1500],
      [1500, 3000],
    ]);
  });

  it("clamps embedded chapters that overrun the file", () => {
    const ch = buildChapters([file("a", 1000, { chapters: [{ startMs: 0, endMs: 5000, title: "x" }] })]);
    expect(ch).toEqual([{ startMs: 0, endMs: 1000, title: "x" }]);
  });

  it("names untitled chapters by index", () => {
    const ch = buildChapters([file("a", 1000, { chapters: [{ startMs: 0, endMs: 1000, title: "" }] })]);
    expect(ch[0]!.title).toBe("Chapter 1");
  });

  it("skips zero-duration files", () => {
    expect(buildChapters([file("a", 0), file("b", 100)])).toHaveLength(1);
  });
});

describe("normalize", () => {
  it("sorts, dedupes equal starts, trims overlaps", () => {
    const out = normalize([
      { startMs: 500, endMs: 900, title: "b" },
      { startMs: 0, endMs: 700, title: "a" },
      { startMs: 500, endMs: 600, title: "dup" },
    ]);
    expect(out).toEqual([
      { startMs: 0, endMs: 500, title: "a" },
      { startMs: 500, endMs: 900, title: "b" },
    ]);
  });
});

describe("chapterAt", () => {
  const ch = [
    { startMs: 0, endMs: 1000, title: "a" },
    { startMs: 1000, endMs: 3000, title: "b" },
  ];
  it("finds the containing chapter, last owns its end", () => {
    expect(chapterAt(ch, 0)).toBe(0);
    expect(chapterAt(ch, 999)).toBe(0);
    expect(chapterAt(ch, 1000)).toBe(1);
    expect(chapterAt(ch, 3000)).toBe(1);
    expect(chapterAt(ch, 99_999)).toBe(1);
    expect(chapterAt([], 5)).toBe(-1);
  });
});

describe("applyCorrections", () => {
  const base = [
    { startMs: 0, endMs: 1000, title: "a" },
    { startMs: 1000, endMs: 2000, title: "b" },
    { startMs: 2000, endMs: 3000, title: "c" },
  ];

  it("renames", () => {
    const r = applyCorrections(base, [{ op: "rename", index: 1, title: "B!" }], 3000);
    expect(r.chapters[1]!.title).toBe("B!");
    expect(r.ignored).toEqual([]);
  });

  it("moves a start and reflows neighbours", () => {
    const r = applyCorrections(base, [{ op: "move", index: 1, startMs: 1500 }], 3000);
    expect(r.chapters.map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 1500],
      [1500, 2000],
      [2000, 3000],
    ]);
  });

  it("deletes and the previous chapter absorbs the range", () => {
    const r = applyCorrections(base, [{ op: "delete", index: 1 }], 3000);
    expect(r.chapters.map((c) => [c.startMs, c.endMs, c.title])).toEqual([
      [0, 2000, "a"],
      [2000, 3000, "c"],
    ]);
  });

  it("inserts", () => {
    const r = applyCorrections(base, [{ op: "insert", startMs: 500, title: "new" }], 3000);
    expect(r.chapters.map((c) => c.title)).toEqual(["a", "new", "b", "c"]);
    expect(r.chapters[0]!.endMs).toBe(500);
  });

  it("applies in order with shifting indexes", () => {
    const list: Correction[] = [
      { op: "delete", index: 0 },
      { op: "rename", index: 0, title: "was b" },
    ];
    const r = applyCorrections(base, list, 3000);
    expect(r.chapters[0]).toEqual({ startMs: 1000, endMs: 2000, title: "was b" });
  });

  it("ignores and reports bad indexes and out-of-range starts", () => {
    const r = applyCorrections(base, [{ op: "rename", index: 9, title: "x" }, { op: "insert", startMs: 99_999, title: "y" }], 3000);
    expect(r.chapters).toEqual(base);
    expect(r.ignored).toHaveLength(2);
  });

  it("never yields two equal starts", () => {
    const r = applyCorrections(base, [{ op: "move", index: 2, startMs: 1000 }], 3000);
    const starts = r.chapters.map((c) => c.startMs);
    expect(new Set(starts).size).toBe(starts.length);
  });
});

describe("corrections CSV", () => {
  it("round-trips", () => {
    const list: Correction[] = [
      { op: "rename", index: 1, title: "x" },
      { op: "move", index: 2, startMs: 500 },
      { op: "delete", index: 0 },
      { op: "insert", startMs: 10, title: "y" },
    ];
    expect(rowsToCorrections(correctionsToRows(list))).toEqual(list);
  });

  it("drops unknown ops and bad numbers", () => {
    expect(rowsToCorrections([{ op: "explode", index: "1" }, { op: "move", index: "x", start_ms: "5" }])).toEqual([]);
  });
});
