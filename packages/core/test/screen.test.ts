import { describe, expect, it } from "vitest";
import { LIBRARY, pageBook, screenAfter, type OnScreen, type ScreenEvent } from "@ribbon/core/screen";

const open = (screen: OnScreen["screen"], drawer: "chapters" | "bookmarks" | "speed" | null = null): OnScreen => ({ screen, fullPlayer: { drawer } });
const after = (now: OnScreen, ...events: ScreenEvent[]) => events.reduce(screenAfter, now);

describe("what's on screen", () => {
  it("shows each page, closing the full player as it does, but Settings", () => {
    for (const pane of ["library", "stats", "bookcase"] as const) expect(after(open({ pane: "settings" }), { type: "show", pane })).toEqual({ screen: { pane }, fullPlayer: null });
    expect(after(open({ pane: "library" }, "speed"), { type: "show", pane: "settings" })).toEqual(open({ pane: "settings" }, "speed"));
    expect(after(open({ pane: "library" }), { type: "series", key: "saga" })).toEqual({ screen: { pane: "series", key: "saga" }, fullPlayer: null });
    expect(after(open({ pane: "library" }), { type: "book", bookId: "b" })).toEqual({ screen: { pane: "reader", bookId: "b", fromBookcase: false }, fullPlayer: null });
  });

  it("leads back to the bookcase from a book opened there, and from the books opened from that one's page", () => {
    const fromCase = after(LIBRARY, { type: "show", pane: "bookcase" }, { type: "book", bookId: "a" });
    expect(fromCase.screen).toEqual({ pane: "reader", bookId: "a", fromBookcase: true });
    expect(after(fromCase, { type: "book", bookId: "b" }).screen).toEqual({ pane: "reader", bookId: "b", fromBookcase: true });
    expect(after(fromCase, { type: "show", pane: "library" }, { type: "book", bookId: "b" }).screen).toEqual({ pane: "reader", bookId: "b", fromBookcase: false });
    expect(after(fromCase, { type: "series", key: "saga" }, { type: "book", bookId: "b" }).screen).toEqual({ pane: "reader", bookId: "b", fromBookcase: false });
  });

  it("opens the full player on a drawer or none, changes drawer only while it's open, and closes", () => {
    const s = after(LIBRARY, { type: "expand", drawer: "chapters" });
    expect(s.fullPlayer).toEqual({ drawer: "chapters" });
    expect(after(s, { type: "drawer", drawer: "bookmarks" }).fullPlayer).toEqual({ drawer: "bookmarks" });
    expect(after(s, { type: "collapse" }).fullPlayer).toBeNull();
    expect(after(LIBRARY, { type: "drawer", drawer: "bookmarks" })).toBe(LIBRARY);
    expect(after(LIBRARY, { type: "collapse" })).toBe(LIBRARY);
    // Opened again, it's on what it's asked to be on, not what it was left on.
    expect(after(s, { type: "collapse" }, { type: "expand", drawer: null }).fullPlayer).toEqual({ drawer: null });
  });

  it("goes back to the library when the book or series a page shows is gone, and stays otherwise", () => {
    const book = after(LIBRARY, { type: "expand", drawer: null }, { type: "book", bookId: "a" }, { type: "expand", drawer: "speed" });
    expect(after(book, { type: "gone", books: new Set(["a"]) })).toEqual({ screen: { pane: "library" }, fullPlayer: { drawer: "speed" } });
    expect(after(book, { type: "gone", books: new Set(["b"]) })).toBe(book);
    const series = after(LIBRARY, { type: "series", key: "saga" });
    expect(after(series, { type: "gone", series: "saga" }).screen).toEqual({ pane: "library" });
    expect(after(series, { type: "gone", series: "other" })).toBe(series);
    expect(after(series, { type: "gone", books: new Set(["a"]) })).toBe(series);
  });

  it("says which book's page shows", () => {
    expect(pageBook({ pane: "reader", bookId: "a", fromBookcase: false })).toBe("a");
    expect(pageBook({ pane: "series", key: "a" })).toBeNull();
  });
});
