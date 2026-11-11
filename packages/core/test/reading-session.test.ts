import { describe, expect, it } from "vitest";
import { EBOOK_FORMAT, type Ebook } from "@ribbon/core/ebook";
import { BookText } from "@ribbon/core/reading/booktext";
import type { Alignment } from "@ribbon/core/reading/align";
import { readingAfter, readyReading, type ReadingEvent, type ReadingSession, type ReadySession } from "@ribbon/core/reading/session";

const model: Ebook = {
  format: EBOOK_FORMAT,
  meta: { title: "T", authors: [], identifiers: [] },
  layout: "reflowable",
  sections: [{ href: "one.xhtml", linear: true, overlay: null, chars: 30, blocks: [{ k: "p", runs: [{ t: "It was a giant circle of stone." }] }] }],
  toc: [],
};
const text = new BookText(model);
const start = { section: 0, block: 0, offset: 0 };
const later = { section: 0, block: 0, offset: 9 };
const alignment = { how: "chapter", pairs: [] } as unknown as Alignment;

const shown = (bookId = "a", following = false): ReadingEvent => ({ type: "shown", bookId, text, place: start, alignment: null, following, highlights: [] });
const ready = (following = false): ReadySession => readingAfter(readingAfter(null, { type: "open", bookId: "a" }), shown("a", following)) as ReadySession;

/** Every event a ready book can be told, about the book open and about another. */
const aboutABook = (bookId: string): ReadingEvent[] => [
  { type: "paired", bookId, alignment },
  { type: "reads along", bookId },
  { type: "listening", bookId, listening: { done: 1, total: 9, what: "aligning" } },
  { type: "moved", bookId, place: later, by: "hand" },
  { type: "following", bookId, on: true },
  { type: "finding", bookId, on: true },
  { type: "highlights", bookId, highlights: [] },
  { type: "found", bookId, range: { from: start, to: later } },
  { type: "export", bookId, export: { status: "exporting", done: 0, total: 3 } },
];

describe("the reader's session", () => {
  it("opens, then shows the text at a place, or says why it couldn't", () => {
    const opening = readingAfter(null, { type: "open", bookId: "a" });
    expect(opening).toEqual({ status: "opening", bookId: "a" });
    expect(readingAfter(opening, { type: "failed", bookId: "a", message: "This EPUB could not be read." })).toEqual({ status: "failed", bookId: "a", message: "This EPUB could not be read." });
    expect(readingAfter(opening, shown())).toMatchObject({ status: "ready", bookId: "a", text, place: start, alignment: null, readsAlong: false, listening: null, following: false, finding: false, highlights: [], found: null, export: { status: "none" } });
  });

  it("takes a text or a failure only for the book opening, and only while it opens", () => {
    const opening = readingAfter(null, { type: "open", bookId: "a" });
    expect(readingAfter(opening, shown("b"))).toBe(opening);
    expect(readingAfter(opening, { type: "failed", bookId: "b", message: "no" })).toBe(opening);
    const r = ready();
    expect(readingAfter(r, shown())).toBe(r);
    expect(readingAfter(r, { type: "failed", bookId: "a", message: "no" })).toBe(r);
    expect(readingAfter(null, shown())).toBeNull();
  });

  it("opens another book, or the same again, from anywhere, and closes from anywhere", () => {
    const states: (ReadingSession | null)[] = [null, readingAfter(null, { type: "open", bookId: "a" }), readingAfter(readingAfter(null, { type: "open", bookId: "a" }), { type: "failed", bookId: "a", message: "no" }), ready()];
    for (const s of states) {
      expect(readingAfter(s, { type: "open", bookId: "b" })).toEqual({ status: "opening", bookId: "b" });
      expect(readingAfter(s, { type: "open", bookId: "a" })).toEqual({ status: "opening", bookId: "a" });
      expect(readingAfter(s, { type: "closed" })).toBeNull();
    }
  });

  it("drops what comes for a book that isn't open, or isn't ready: work goes on after a book is closed", () => {
    const opening = readingAfter(null, { type: "open", bookId: "a" });
    const failed = readingAfter(opening, { type: "failed", bookId: "a", message: "no" });
    const r = ready();
    for (const e of aboutABook("a")) {
      expect(readingAfter(null, e)).toBeNull();
      expect(readingAfter(opening, e)).toBe(opening);
      expect(readingAfter(failed, e)).toBe(failed);
    }
    for (const e of aboutABook("b")) expect(readingAfter(r, e)).toBe(r);
  });

  it("keeps a ready book's place, pairing, transcription, highlights and export", () => {
    let r: ReadingSession | null = ready();
    r = readingAfter(r, { type: "paired", bookId: "a", alignment });
    r = readingAfter(r, { type: "listening", bookId: "a", listening: { done: 3, total: 9, what: "aligning" } });
    r = readingAfter(r, { type: "reads along", bookId: "a" });
    r = readingAfter(r, { type: "export", bookId: "a", export: { status: "made", path: "/b/T (read-along).epub" } });
    expect(r).toMatchObject({ alignment, listening: { done: 3, total: 9 }, readsAlong: true, export: { status: "made", path: "/b/T (read-along).epub" } });
    r = readingAfter(r, { type: "listening", bookId: "a", listening: null });
    expect(readyReading(r)!.listening).toBeNull();
  });

  it("stops following the narrator on a turn by hand, but not on one the narrator made, or a scroll", () => {
    expect(readingAfter(ready(true), { type: "moved", bookId: "a", place: later, by: "hand" })).toMatchObject({ place: later, following: false });
    expect(readingAfter(ready(true), { type: "moved", bookId: "a", place: later, by: "follow" })).toMatchObject({ place: later, following: true });
    expect(readingAfter(ready(true), { type: "moved", bookId: "a", place: later, by: "scroll" })).toMatchObject({ place: later, following: true });
    expect(readingAfter(ready(false), { type: "moved", bookId: "a", place: later, by: "follow" })).toMatchObject({ following: false });
  });

  it("marks a found line until the reader moves on, whichever way", () => {
    const found = readingAfter(ready(), { type: "found", bookId: "a", range: { from: later, to: later } });
    expect(readyReading(found)!.found).toEqual({ from: later, to: later });
    for (const by of ["hand", "follow", "scroll"] as const) expect(readyReading(readingAfter(found, { type: "moved", bookId: "a", place: start, by }))!.found).toBeNull();
  });

  it("has one export status at a time: running, then made or failed, and running again replaces either", () => {
    let r: ReadingSession | null = ready();
    r = readingAfter(r, { type: "export", bookId: "a", export: { status: "exporting", done: 1, total: 3 } });
    expect(readyReading(r)!.export).toEqual({ status: "exporting", done: 1, total: 3 });
    r = readingAfter(r, { type: "export", bookId: "a", export: { status: "failed", error: "the disk is full" } });
    expect(readyReading(r)!.export).toEqual({ status: "failed", error: "the disk is full" });
    r = readingAfter(r, { type: "export", bookId: "a", export: { status: "exporting", done: 0, total: 3 } });
    expect(readyReading(r)!.export).toEqual({ status: "exporting", done: 0, total: 3 });
  });

  it("answers with the same object when nothing changes, so nothing redraws", () => {
    const r = ready();
    expect(readingAfter(r, { type: "following", bookId: "a", on: false })).toBe(r);
    expect(readingAfter(r, { type: "finding", bookId: "a", on: false })).toBe(r);
    const along = readingAfter(r, { type: "reads along", bookId: "a" });
    expect(readingAfter(along, { type: "reads along", bookId: "a" })).toBe(along);
  });
});
