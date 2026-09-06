import { describe, expect, it } from "vitest";
import { natcompare, natsort } from "../src/core/natsort";

describe("natcompare", () => {
  it("orders digit runs numerically", () => {
    const sorted = natsort(["Chapter 100", "Chapter 2", "Chapter 10"], (s) => s);
    expect(sorted).toEqual(["Chapter 2", "Chapter 10", "Chapter 100"]);
  });

  it("handles mixed padding and separators", () => {
    const sorted = natsort(["10 - End", "2 - Body", "01 - Intro"], (s) => s);
    expect(sorted).toEqual(["01 - Intro", "2 - Body", "10 - End"]);
  });

  it("treats leading zeros as equal value, shorter first", () => {
    expect(natcompare("007", "7")).toBeGreaterThan(0);
    expect(natcompare("7", "007")).toBeLessThan(0);
    expect(natcompare("007", "8")).toBeLessThan(0);
  });

  it("is case-insensitive for text, falling back to raw for ties", () => {
    expect(natcompare("chapter 1", "Chapter 1")).not.toBe(0);
    expect(natsort(["b", "A", "a", "B"], (s) => s)).toEqual(["A", "a", "B", "b"]);
  });

  it("is stable for identical keys", () => {
    const items = [
      { k: "x", v: 1 },
      { k: "x", v: 2 },
      { k: "x", v: 3 },
    ];
    expect(natsort(items, (i) => i.k).map((i) => i.v)).toEqual([1, 2, 3]);
  });

  it("does not treat non-ASCII digits as numbers", () => {
    // Arabic-Indic digits: compared as text, not by value.
    expect(natcompare("١٠", "٢")).toBeLessThan(0);
  });

  it("returns 0 only for identical strings", () => {
    expect(natcompare("Chapter 1", "Chapter 1")).toBe(0);
    expect(natcompare("", "")).toBe(0);
    expect(natcompare("", "a")).toBeLessThan(0);
  });

  it("orders a real multi-file book", () => {
    const names = Array.from({ length: 22 }, (_, i) => `Chapter ${i + 1}.m4a`);
    const shuffled = [...names].sort();
    expect(shuffled[1]).toBe("Chapter 10.m4a");
    expect(natsort(shuffled, (s) => s)).toEqual(names);
  });
});
