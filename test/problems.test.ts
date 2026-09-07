import { describe, expect, it } from "vitest";
import { bytesToProblems, groupProblems, problemsToBytes } from "../src/core/problems";

describe("problems record", () => {
  it("round-trips through CSV", async () => {
    const list = [
      { path: "Book A/01.mp3", message: "could not read this file", at: "2026-09-07T01:00:00.000Z" },
      { path: "Book A/02.mp3", message: "could not read this file", at: "2026-09-07T01:00:00.000Z" },
      { path: "loose, with comma.mp3", message: 'quote "inside"', at: "2026-09-07T01:00:00.000Z" },
    ];
    expect(await bytesToProblems(await problemsToBytes(list))).toEqual(list);
  });

  it("groups by folder in first-seen order, loose files under the root", async () => {
    const groups = groupProblems([
      { path: "Book B/03.mp3", message: "x", at: "" },
      { path: "loose.mp3", message: "x", at: "" },
      { path: "Book B/01.mp3", message: "x", at: "" },
    ]);
    expect(groups.map((g) => g.folder)).toEqual(["Book B", ""]);
    expect(groups[0]!.problems).toHaveLength(2);
  });

  it("keeps the same folder name in two sources apart", () => {
    const groups = groupProblems([
      { path: "Book B/03.mp3", message: "x", at: "", source: "a" },
      { path: "Book B/01.mp3", message: "x", at: "", source: "b" },
      { path: "Book B/02.mp3", message: "x", at: "", source: "a" },
    ]);
    expect(groups.map((g) => [g.source, g.folder, g.problems.length])).toEqual([
      ["a", "Book B", 2],
      ["b", "Book B", 1],
    ]);
  });
});
