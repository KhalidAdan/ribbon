import { describe, expect, it } from "vitest";
import { columnNarrower, columnWider, COLUMNS, keptReading, pageAtY, pageReading, pagesShowing, scrollLayout } from "@ribbon/core/comic/scroll";
import { comicKey, keyList } from "@ribbon/core/comic/keys";
import { parseComicSettings } from "@ribbon/core/comic/settings";
import type { PixelSize } from "@ribbon/core/comic/size";

const page = (width: number, height: number): PixelSize => ({ width, height });

describe("one long scroll", () => {
  it("lays the pages one under another, as wide as the window and never wider than drawn", () => {
    const sizes = new Map([
      [0, page(2000, 3000)],
      [1, page(500, 750)],
      [2, page(4000, 3000)],
    ]);
    const layout = scrollLayout(sizes, 3, 1000, 1)!;
    expect(layout.widths).toEqual([1000, 500, 1000]);
    expect(layout.heights).toEqual([1500, 750, 750]);
    expect(layout.tops).toEqual([0, 1500, 2250]);
    expect(layout.total).toBe(3000);
    // A narrower column: 0.55 of the window.
    expect(scrollLayout(sizes, 3, 1000, 0.55)!.widths).toEqual([550, 500, 550]);
    // Pages narrower than the window: the column is a part of the page's own width, so a narrower one shows.
    const small = new Map([[0, page(800, 1200)]]);
    expect(scrollLayout(small, 2, 1400, 1)!.widths).toEqual([800, 800]);
    expect(scrollLayout(small, 2, 1400, 0.85)!.widths).toEqual([680, 680]);
  });

  it("takes a page not yet fetched to be the comic's usual page, so the scroll is the right length from the start", () => {
    // 600 pages, only the 300th known: all of them that size.
    const layout = scrollLayout(new Map([[299, page(1000, 1500)]]), 600, 1000, 1)!;
    expect(layout.total).toBe(600 * 1500);
    expect(layout.tops[299]).toBe(299 * 1500);
    // A spread among them is itself, and the pages not yet known are the usual page, not the spread.
    const mixed = scrollLayout(new Map([[0, page(1000, 1000)], [3, page(2000, 1000)], [4, page(1000, 1000)]]), 6, 1000, 1)!;
    expect(mixed.heights).toEqual([1000, 1000, 1000, 500, 1000, 1000]);
    // Nothing known, nothing laid out.
    expect(scrollLayout(new Map(), 6, 1000, 1)).toBeNull();
    expect(scrollLayout(new Map([[0, page(1000, 1000)]]), 6, 0, 1)).toBeNull();
  });

  it("knows the page at a point, the page being read (the one filling the top third), and the pages showing", () => {
    const layout = scrollLayout(new Map([[0, page(1000, 1000)]]), 10, 1000, 1)!;
    expect(pageAtY(layout, 0)).toBe(0);
    expect(pageAtY(layout, 999)).toBe(0);
    expect(pageAtY(layout, 1000)).toBe(1);
    expect(pageAtY(layout, 99_999)).toBe(9);
    // 800 tall, scrolled to 2600: the top third reaches 2866, on page 3, though page 2's foot still shows.
    expect(pageReading(layout, 2600, 800)).toBe(2);
    expect(pageReading(layout, 2800, 800)).toBe(3);
    expect(pagesShowing(layout, 2600, 800)).toEqual({ first: 2, last: 3 });
    // Scrolled to the very end, the last page is being read, though it can't reach the top third.
    const short = scrollLayout(new Map([[0, page(1000, 1000)], [9, page(2000, 1000)]]), 10, 1000, 1)!;
    expect(pageReading(short, short.total - 800, 800)).toBe(9);
    expect(pagesShowing(layout, 2000, 800)).toEqual({ first: 2, last: 2 });
  });

  it("keeps the page being read where it is when a page above it turns out another size, or the column changes", () => {
    const guessed = scrollLayout(new Map([[0, page(1000, 1000)]]), 10, 1000, 1)!;
    // Reading 200 into page 5.
    const scrolled = guessed.tops[5]! + 200;
    // Page 2 is drawn across two: half as tall at this width.
    const learned = scrollLayout(new Map([[0, page(1000, 1000)], [1, page(1000, 1000)], [2, page(2000, 1000)]]), 10, 1000, 1)!;
    expect(learned.tops[5]).toBe(guessed.tops[5]! - 500);
    expect(keptReading(guessed, learned, scrolled)).toBe(learned.tops[5]! + 200);
    // A column half as wide: the same part of the same page.
    const narrow = scrollLayout(new Map([[0, page(1000, 1000)]]), 10, 1000, 0.55)!;
    expect(keptReading(guessed, narrow, scrolled)).toBe(Math.round(narrow.tops[5]! + 0.2 * narrow.heights[5]!));
  });

  it("makes the column wider and narrower in steps, from as wide as the window", () => {
    expect(COLUMNS[COLUMNS.length - 1]).toBe(1);
    expect(columnNarrower(1)).toBe(0.85);
    expect(columnNarrower(0.4)).toBe(0.4);
    expect(columnWider(0.4)).toBe(0.55);
    expect(columnWider(1)).toBe(1);
  });

  it("is S, kept on this machine, off until chosen, with the column as wide as the window", () => {
    expect(comicKey("s")).toBe("scroll");
    expect(keyList(false).flatMap((l) => l.keys)).toContain("S");
    expect(parseComicSettings(undefined)).toMatchObject({ scroll: false, column: 1 });
    expect(parseComicSettings({ scroll: true, column: 0.55 })).toMatchObject({ scroll: true, column: 0.55 });
    expect(parseComicSettings({ scroll: "yes", column: 0.5 })).toMatchObject({ scroll: false, column: 1 });
  });
});
