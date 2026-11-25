import { describe, expect, it } from "vitest";
import { pagesInView, scrollToCentre, slotLeft, slotsDrawn, stripWidth, stripWindow } from "@ribbon/core/comic/strip";
import { parseComicSettings } from "@ribbon/core/comic/settings";
import { windowAround } from "@ribbon/core/comic/window";

// Slots 70 wide with a gap of 10: a page every 80 pixels.
const slots = { width: 70, gap: 10, inset: 0 };

describe("the strip of small pages", () => {
  it("lays every page in a row, first on the left, or on the right for a comic read right to left", () => {
    expect(stripWidth(24, slots)).toBe(1910);
    expect(slotLeft(0, 24, false, slots)).toBe(0);
    expect(slotLeft(3, 24, false, slots)).toBe(240);
    expect(slotLeft(0, 24, true, slots)).toBe(1840);
    expect(slotLeft(23, 24, true, slots)).toBe(0);
  });

  it("knows which pages are in view, even half in view, at either end and in a row that runs right to left", () => {
    // 400 wide at the start: the first five slots, the fifth to its edge.
    expect(pagesInView(0, 400, 24, false, slots)).toEqual({ first: 0, last: 4 });
    // Scrolled 100 along: the second slot is cut, the sixth begins at 400 and shows its first 100.
    expect(pagesInView(100, 400, 24, false, slots)).toEqual({ first: 1, last: 6 });
    // Past the end, it is still the last pages.
    expect(pagesInView(5000, 400, 24, false, slots)).toEqual({ first: 23, last: 23 });
    // Right to left, the left of the row is the last pages.
    expect(pagesInView(0, 400, 24, true, slots)).toEqual({ first: 19, last: 23 });
    expect(pagesInView(1520, 400, 24, true, slots)).toEqual({ first: 0, last: 4 });
    // A strip wider than the row shows all of it.
    expect(pagesInView(0, 4000, 3, false, slots)).toEqual({ first: 0, last: 2 });
    expect(pagesInView(0, 400, 0, false, slots)).toEqual({ first: 0, last: -1 });
  });

  it("leaves room before the first slot and after the last", () => {
    const inset = { ...slots, inset: 16 };
    expect(stripWidth(24, inset)).toBe(1942);
    expect(slotLeft(0, 24, false, inset)).toBe(16);
    expect(slotLeft(0, 24, true, inset)).toBe(1856);
    // 400 wide at the start: the room, then five slots, the fifth (336 to 406) cut at its edge.
    expect(pagesInView(0, 400, 24, false, inset)).toEqual({ first: 0, last: 4 });
    // 50 along: the first slot (16 to 86) still shows; the sixth begins at 416, 366 along the view, and shows.
    expect(pagesInView(50, 400, 24, false, inset)).toEqual({ first: 0, last: 5 });
    // The first page isn't against the strip's edge, and the last goes all the way to the end of the row.
    expect(scrollToCentre([0], 24, 400, false, inset)).toBe(0);
    expect(scrollToCentre([23], 24, 400, false, inset)).toBe(1542);
  });

  it("puts the page being read in the middle, and goes no further than the row at either end", () => {
    // Page 10's slot is 800 to 870: its middle, 835, in the middle of 400 is 635 along.
    expect(scrollToCentre([10], 24, 400, false, slots)).toBe(635);
    // Two that face each other: the middle of the pair.
    expect(scrollToCentre([10, 11], 24, 400, false, slots)).toBe(675);
    expect(scrollToCentre([0], 24, 400, false, slots)).toBe(0);
    // The last page: the row ends 1910 along (no gap after the last slot), so 1510 is as far as it goes.
    expect(scrollToCentre([23], 24, 400, false, slots)).toBe(1510);
    // Right to left, the first page is at the far end.
    expect(scrollToCentre([0], 24, 400, true, slots)).toBe(1510);
    // And the page in the middle is in view.
    const left = scrollToCentre([10], 24, 400, true, slots);
    const seen = pagesInView(left, 400, 24, true, slots);
    expect(seen.first <= 10 && 10 <= seen.last).toBe(true);
    // A row shorter than the strip isn't scrolled.
    expect(scrollToCentre([2], 3, 400, false, slots)).toBe(0);
  });

  it("draws the slots in view and a few either side, and holds their pictures nearest the middle first", () => {
    expect(slotsDrawn({ first: 10, last: 14 }, 600, 4)).toEqual({ first: 6, last: 18 });
    expect(slotsDrawn({ first: 0, last: 4 }, 600, 4)).toEqual({ first: 0, last: 8 });
    expect(slotsDrawn({ first: 596, last: 599 }, 600, 4)).toEqual({ first: 592, last: 599 });

    const { centre, size } = stripWindow({ first: 10, last: 14 }, 4);
    expect(centre).toBe(12);
    const held = windowAround(centre, 600, size);
    // Everything drawn is held, and nothing more; the middle first.
    expect([...held].sort((a, b) => a - b)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect(held[0]).toBe(12);
    // An even number in view: all of them, and the window being even either side, one more behind.
    const even = stripWindow({ first: 10, last: 13 }, 0);
    expect([...windowAround(even.centre, 600, even.size)].sort((a, b) => a - b)).toEqual([9, 10, 11, 12, 13]);
  });

  it("a 600-page book holds what an issue does", () => {
    const issue = stripWindow(pagesInView(0, 1400, 24, false, slots), 6);
    const book = stripWindow(pagesInView(24_000, 1400, 600, false, slots), 6);
    expect(windowAround(book.centre, 600, book.size).length).toBeLessThanOrEqual(windowAround(issue.centre, 24, issue.size).length + 13);
    expect(windowAround(book.centre, 600, book.size).length).toBeLessThan(40);
  });
});

describe("how comics are shown, as kept", () => {
  it("has the strip hidden until asked for, and keeps it shown once it is", () => {
    expect(parseComicSettings(undefined).strip).toBe(false);
    expect(parseComicSettings({ up: "two" })).toEqual({ up: "two", fit: "page", strip: false });
    expect(parseComicSettings({ strip: true }).strip).toBe(true);
    expect(parseComicSettings({ strip: "yes" }).strip).toBe(false);
  });
});
