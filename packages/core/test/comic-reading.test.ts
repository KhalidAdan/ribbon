import { describe, expect, it } from "vitest";
import { comicAfter, onScreen, pageAt, pageLocator, pageProgress, type ComicSession, type ReadyComic } from "@ribbon/core/comic/session";
import { DECODED, PageWindow, windowAround, WINDOW } from "@ribbon/core/comic/window";

const names = (n: number) => Array.from({ length: n }, (_, i) => `p${String(i + 1).padStart(3, "0")}.jpg`);
const ready = (pages: number, page = 0, wide: number[] = []): ReadyComic => ({ status: "ready", bookId: "c", pages: names(pages), wide: names(pages).map((_, i) => wide.includes(i)), page });

describe("the comic open in the reader", () => {
  it("opens, shows its pages at a place, and closes", () => {
    let s: ComicSession | null = comicAfter(null, { type: "open", bookId: "c" });
    expect(s).toEqual({ status: "opening", bookId: "c" });
    s = comicAfter(s, { type: "shown", bookId: "c", pages: names(5), page: 3 });
    expect(s).toMatchObject({ status: "ready", page: 3, wide: [false, false, false, false, false] });
    expect(comicAfter(s, { type: "closed" })).toBeNull();
  });

  it("fails in words when it can't be opened, or has no pages", () => {
    const opening = comicAfter(null, { type: "open", bookId: "c" });
    expect(comicAfter(opening, { type: "failed", bookId: "c", message: "It isn't a comic." })).toEqual({ status: "failed", bookId: "c", message: "It isn't a comic." });
    expect(comicAfter(opening, { type: "shown", bookId: "c", pages: [], page: 0 })).toMatchObject({ status: "failed", message: "This comic has no pages in it." });
  });

  it("drops what arrives for a comic that isn't the one open", () => {
    const other = comicAfter(null, { type: "open", bookId: "other" });
    expect(comicAfter(other, { type: "shown", bookId: "c", pages: names(5), page: 0 })).toBe(other);
    const s = ready(5, 2);
    expect(comicAfter(s, { type: "turned", bookId: "other", page: 4 })).toBe(s);
    expect(comicAfter(s, { type: "measured", bookId: "other", page: 1, wide: true })).toBe(s);
  });

  it("keeps a turn inside the comic", () => {
    expect(comicAfter(ready(5, 2), { type: "turned", bookId: "c", page: 99 })).toMatchObject({ page: 4 });
    expect(comicAfter(ready(5, 2), { type: "turned", bookId: "c", page: -3 })).toMatchObject({ page: 0 });
  });

  it("learns that a page is drawn across two, once", () => {
    const s = ready(5);
    const learned = comicAfter(s, { type: "measured", bookId: "c", page: 2, wide: true }) as ReadyComic;
    expect(learned.wide).toEqual([false, false, true, false, false]);
    // Told the same again, nothing changes: not even the object, so nothing redraws.
    expect(comicAfter(learned, { type: "measured", bookId: "c", page: 2, wide: true })).toBe(learned);
  });
});

describe("what is on screen", () => {
  it("is one page, with a turn either way", () => {
    expect(onScreen(ready(5, 2), "one")).toEqual({ pages: [2], next: 3, previous: 1 });
    expect(onScreen(ready(5, 0), "one")).toEqual({ pages: [0], next: 1, previous: null });
    expect(onScreen(ready(5, 4), "one")).toEqual({ pages: [4], next: null, previous: 3 });
  });

  it("is two facing pages, the cover alone, and a turn goes a spread at a time", () => {
    expect(onScreen(ready(5, 0), "two")).toEqual({ pages: [0], next: 1, previous: null });
    expect(onScreen(ready(5, 1), "two")).toEqual({ pages: [1, 2], next: 3, previous: 0 });
    // Opened at the second page of a pair, the pair shows.
    expect(onScreen(ready(5, 2), "two")).toEqual({ pages: [1, 2], next: 3, previous: 0 });
    expect(onScreen(ready(5, 3), "two")).toEqual({ pages: [3, 4], next: null, previous: 1 });
  });

  it("gives a wide page the screen to itself", () => {
    expect(onScreen(ready(6, 3, [3]), "two")).toEqual({ pages: [3], next: 4, previous: 1 });
  });
});

describe("a page as a place", () => {
  it("is 0 on the first page and 1 on the last, so the last page is the end", () => {
    expect(pageProgress(0, 24)).toBe(0);
    expect(pageProgress(23, 24)).toBe(1);
    expect(pageProgress(0, 1)).toBe(1);
  });

  it("names the page's entry and its number from 1", () => {
    expect(pageLocator(names(5), 2)).toEqual({ href: "p003.jpg", type: "image/jpeg", locations: { position: 3, totalProgression: 0.5 } });
  });

  it("is found again by its entry's name, then by its number, else the first page", () => {
    const pages = names(5);
    expect(pageAt(pages, pageLocator(pages, 3))).toBe(3);
    // Another reader's order: the name still finds it.
    expect(pageAt([...pages].reverse(), pageLocator(pages, 3))).toBe(1);
    expect(pageAt(pages, { href: "renamed.jpg", locations: { position: 2 } })).toBe(1);
    expect(pageAt(pages, { href: "renamed.jpg", locations: { position: 99 } })).toBe(0);
    expect(pageAt(pages, undefined)).toBe(0);
  });
});

describe("the window of pages", () => {
  it("is the page, then outward, ahead before behind", () => {
    expect(windowAround(10, 100)).toEqual([10, 11, 9, 12, 8, 13, 14, 15, 16, 17, 18]);
    expect(WINDOW).toEqual({ behind: 2, ahead: 8 });
    // Decoded pages are dear in memory: only the nearest few.
    expect(windowAround(10, 100, DECODED)).toEqual([10, 11, 9, 12]);
  });

  it("stops at the comic's ends", () => {
    expect(windowAround(0, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(windowAround(4, 5)).toEqual([4, 3, 2]);
    expect(windowAround(0, 0)).toEqual([]);
  });

  it("mirrors when the reader is going back", () => {
    expect(windowAround(10, 100, WINDOW, false)).toEqual([10, 9, 11, 8, 12, 7, 6, 5, 4, 3, 2]);
  });

  /** A loader that says what it was asked for, and can be held up. */
  function loader(holdUp = false) {
    const asked: number[] = [];
    const released: number[] = [];
    const aborted: number[] = [];
    const gates = new Map<number, () => void>();
    return {
      asked,
      released,
      aborted,
      letThrough: (page: number) => gates.get(page)?.(),
      load: (page: number, signal: AbortSignal) => {
        asked.push(page);
        if (!holdUp) return Promise.resolve(`page ${page}`);
        return new Promise<string>((resolve, reject) => {
          gates.set(page, () => resolve(`page ${page}`));
          signal.addEventListener("abort", () => {
            aborted.push(page);
            reject(new Error("aborted"));
          });
        });
      },
      release: (page: number) => void released.push(page),
    };
  }
  const settle = () => new Promise((r) => setTimeout(r, 5));

  it("holds the pages around the reader, however long the comic", async () => {
    const l = loader();
    const w = new PageWindow<string>(600, l);
    w.moveTo(300);
    await settle();
    expect(w.holding()).toEqual([298, 299, 300, 301, 302, 303, 304, 305, 306, 307, 308]);
    // The page being read was fetched first.
    expect(l.asked[0]).toBe(300);
    await w.close();
  });

  it("lets go of what falls outside when the page turns, and fetches only what is new", async () => {
    const l = loader();
    const w = new PageWindow<string>(600, l);
    w.moveTo(300);
    await settle();
    l.asked.length = 0;
    w.moveTo(301);
    await settle();
    expect(l.asked).toEqual([309]);
    expect(l.released).toEqual([298]);
    expect(w.holding()).toEqual([299, 300, 301, 302, 303, 304, 305, 306, 307, 308, 309]);
    await w.close();
    // Closing lets all of it go.
    expect(l.released.sort((a, b) => a - b)).toEqual([298, 299, 300, 301, 302, 303, 304, 305, 306, 307, 308, 309]);
  });

  it("gives a held page at once and a coming page when it lands", async () => {
    const l = loader(true);
    const w = new PageWindow<string>(50, l, WINDOW, 2);
    w.moveTo(10);
    await settle();
    // Two at once, nearest first.
    expect(l.asked).toEqual([10, 11]);
    const coming = w.get(10);
    l.letThrough(10);
    expect(await coming).toBe("page 10");
    expect(w.peek(10)).toBe("page 10");
    expect(await w.get(10)).toBe("page 10");
    await w.close();
  });

  it("abandons a page still on its way when the reader jumps elsewhere", async () => {
    const l = loader(true);
    const w = new PageWindow<string>(600, l, WINDOW, 2);
    w.moveTo(10);
    await settle();
    const coming = w.get(10);
    w.moveTo(400);
    expect(await coming).toBeUndefined();
    await settle();
    expect(l.aborted.sort((a, b) => a - b)).toEqual([10, 11]);
    expect(l.asked.slice(2)).toEqual([400, 401]);
    await w.close();
  });

  it("says when a page lands, for whoever draws from it", async () => {
    const landed: number[] = [];
    const w = new PageWindow<string>(5, { load: (page) => Promise.resolve(`page ${page}`), landed: (page) => void landed.push(page) }, { behind: 1, ahead: 1 });
    w.moveTo(2);
    await settle();
    expect(landed).toEqual([2, 3, 1]);
    expect(landed.every((p) => w.peek(p) !== undefined)).toBe(true);
    await w.close();
  });

  it("answers undefined for a page that couldn't be brought in, and for a page outside the comic", async () => {
    const w = new PageWindow<string>(5, { load: (page) => (page === 2 ? Promise.reject(new Error("unreadable")) : Promise.resolve("ok")) });
    expect(await w.get(2)).toBeUndefined();
    expect(await w.get(9)).toBeUndefined();
    expect(await w.get(1)).toBe("ok");
    await w.close();
  });
});

describe("the window, resized", () => {
  it("holds more around the reader from the next move on", async () => {
    const released: number[] = [];
    const w = new PageWindow<string>(100, { load: (page) => Promise.resolve(`page ${page}`), release: (page) => void released.push(page) }, DECODED);
    w.moveTo(10);
    await new Promise((r) => setTimeout(r, 5));
    expect(w.holding()).toEqual([9, 10, 11, 12]);
    w.resize({ behind: 2, ahead: 3 });
    w.moveTo(10);
    await new Promise((r) => setTimeout(r, 5));
    expect(w.holding()).toEqual([8, 9, 10, 11, 12, 13]);
    w.resize(DECODED);
    w.moveTo(10);
    expect(released.sort((a, b) => a - b)).toEqual([8, 13]);
    await w.close();
  });
});
