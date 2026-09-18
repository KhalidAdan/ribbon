import { describe, expect, it } from "vitest";
import { buildParts, groupByPart, partAt } from "../src/core/scan/parts";
import type { AudioFile, Chapter } from "../src/core/types";

const file = (path: string, durationMs: number, part = "", partAuthor = ""): AudioFile => ({
  path,
  order: 0,
  durationMs,
  sizeBytes: 1,
  mtimeMs: 0,
  title: "",
  part,
  partAuthor,
  disc: 1,
  track: 0,
  hasCover: false,
  coverFile: "",
  chapters: [],
  chaptersProbed: true,
});

const anthology = [file("a/1.mp3", 1000, "Alpha", "Ann"), file("a/2.mp3", 2000, "Alpha", "Ann"), file("b/1.mp3", 500, "Beta", "Ben"), file("c/1.mp3", 1500, "Gamma", "")];

describe("buildParts", () => {
  it("runs consecutive files with one part name together on the book timeline", () => {
    expect(buildParts(anthology)).toEqual([
      { title: "Alpha", author: "Ann", startMs: 0, endMs: 3000 },
      { title: "Beta", author: "Ben", startMs: 3000, endMs: 3500 },
      { title: "Gamma", author: "", startMs: 3500, endMs: 5000 },
    ]);
  });

  it("gives a book whose files carry no part name no parts at all", () => {
    expect(buildParts([file("x/1.mp3", 1000), file("x/2.mp3", 1000)])).toEqual([]);
  });

  it("skips files that are not yet read", () => {
    expect(buildParts([file("a/1.mp3", 0, "Alpha"), file("b/1.mp3", 100, "Beta")])).toEqual([{ title: "Beta", author: "", startMs: 0, endMs: 100 }]);
  });
});

describe("partAt", () => {
  const parts = buildParts(anthology);
  it("finds the story around a position, and the last one owns the end", () => {
    expect(partAt(parts, 0)).toBe(0);
    expect(partAt(parts, 2999)).toBe(0);
    expect(partAt(parts, 3000)).toBe(1);
    expect(partAt(parts, 5000)).toBe(2);
    expect(partAt(parts, 99999)).toBe(2);
  });
  it("is -1 with no stories", () => {
    expect(partAt([], 10)).toBe(-1);
  });
});

describe("groupByPart", () => {
  const parts = buildParts(anthology);
  const chapters: Chapter[] = [
    { startMs: 0, endMs: 1000, title: "a1" },
    { startMs: 1000, endMs: 3000, title: "a2" },
    { startMs: 3000, endMs: 3500, title: "b1" },
    { startMs: 3500, endMs: 5000, title: "c1" },
  ];

  it("folds chapters under their stories, keeping each chapter's flat index", () => {
    const g = groupByPart(chapters, parts);
    expect(g.map((x) => x.part?.title)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(g.map((x) => x.chapters.map((c) => c.index))).toEqual([[0, 1], [2], [3]]);
  });

  it("keeps an empty story in the list so it can still be jumped to", () => {
    const g = groupByPart(chapters.filter((c) => c.title !== "b1"), parts);
    expect(g[1]!.chapters).toEqual([]);
  });

  it("is one unnamed group for a book without stories", () => {
    const g = groupByPart(chapters, []);
    expect(g).toHaveLength(1);
    expect(g[0]!.part).toBeNull();
    expect(g[0]!.chapters.map((c) => c.index)).toEqual([0, 1, 2, 3]);
  });
});
