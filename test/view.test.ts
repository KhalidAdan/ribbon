import { describe, expect, it } from "vitest";
import { applyView, DEFAULT_VIEW, facetCounts, filterCount, matches, parseView, type BookFacts, type Standing } from "../src/core/view";
import type { ScannedBook } from "../src/core/scan/scan";
import type { Book } from "../src/core/types";

function sb(id: string, extra: Partial<Book> = {}, opts: { chapters?: number; mtime?: number } = {}): ScannedBook {
  const book: Book = { id, path: id, title: id, rawTitle: id, author: "", narrator: "", series: "", seriesIndex: null, year: null, cover: "c.jpg", durationMs: 10 * 3_600_000, sizeBytes: 1, fileCount: 1, ...extra };
  return {
    book,
    files: [{ path: `${id}.mp3`, order: 0, durationMs: book.durationMs, sizeBytes: 1, mtimeMs: opts.mtime ?? 0, title: "", part: "", partAuthor: "", disc: 1, track: 0, hasCover: false, coverFile: "", chapters: [], chaptersProbed: true }],
    chapters: Array.from({ length: opts.chapters ?? 10 }, (_, i) => ({ title: `${i}`, startMs: i, endMs: i + 1 })),
    parts: [],
  };
}

const books = [
  sb("dune", { title: "Dune", author: "Frank Herbert", narrator: "Scott Brick; Simon Vance", genres: ["Science Fiction"], year: 1965, durationMs: 21 * 3_600_000 }, { mtime: 300 }),
  sb("legion", { title: "Legion", author: "Dan Abnett", narrator: "Martyn Ellis", genres: ["Science Fiction", "Military"], year: 2008 }, { mtime: 100 }),
  sb("horus", { title: "Horus Rising", author: "Dan Abnett", narrator: "Toby Longworth", genres: ["Military"], year: 2006, cover: "" }, { mtime: 200, chapters: 1 }),
  sb("ego", { title: "Ego Is the Enemy", author: "Ryan Holiday", narrator: "Ryan Holiday", year: 2016, durationMs: 7 * 3_600_000 }, { mtime: 50 }),
];

const standing: Record<string, Standing> = { dune: "finished", legion: "started", horus: "started", ego: "new" };
const facts: BookFacts = {
  standing: (b) => standing[b.book.id]!,
  fraction: (b) => ({ dune: 1, legion: 0.5, horus: 0.1, ego: 0 })[b.book.id]!,
  listenedAt: (b) => ({ dune: 10, legion: 30, horus: 20, ego: 0 })[b.book.id]!,
  seriesOf: (b) => (b.book.author === "Dan Abnett" ? "The Horus Heresy" : null),
};
const ids = (list: ScannedBook[]) => list.map((b) => b.book.id);

describe("filters", () => {
  it("combine across kinds; any value within one kind", () => {
    expect(ids(applyView(books, { ...DEFAULT_VIEW, filter: { standing: ["started"], genre: ["military"] } }, facts))).toEqual(["legion", "horus"]);
    expect(ids(applyView(books, { ...DEFAULT_VIEW, filter: { author: ["Frank Herbert", "Ryan Holiday"] } }, facts))).toEqual(["dune", "ego"]);
    expect(ids(applyView(books, { ...DEFAULT_VIEW, filter: { narrator: ["Simon Vance"] } }, facts))).toEqual(["dune"]);
    expect(ids(applyView(books, { ...DEFAULT_VIEW, filter: { series: ["The Horus Heresy"], standing: ["started"] } }, facts))).toEqual(["legion", "horus"]);
  });

  it("find books that need attention", () => {
    expect(ids(applyView(books, { ...DEFAULT_VIEW, filter: { missing: ["cover"] } }, facts))).toEqual(["horus"]);
    expect(ids(applyView(books, { ...DEFAULT_VIEW, filter: { missing: ["chapters"] } }, facts))).toEqual(["horus"]);
    expect(applyView(books, { ...DEFAULT_VIEW, filter: { missing: ["description"] } }, facts)).toHaveLength(4);
  });

  it("count values and facets", () => {
    expect(filterCount({ standing: ["new", "started"], author: ["x"] })).toBe(3);
    expect(facetCounts(books, "author", facts)[0]).toEqual({ value: "Dan Abnett", count: 2 });
    expect(facetCounts(books, "narrator", facts).map((f) => f.value)).toContain("Simon Vance");
    expect(matches(books[0]!, {}, facts)).toBe(true);
  });
});

describe("sorts", () => {
  const sorted = (sort: (typeof DEFAULT_VIEW)["sort"], reverse = false) => ids(applyView(books, { filter: {}, sort, reverse }, facts));
  it("each has a natural direction", () => {
    expect(sorted("shelf")).toEqual(["dune", "legion", "horus", "ego"]);
    expect(sorted("title")).toEqual(["dune", "ego", "horus", "legion"]);
    expect(sorted("author")).toEqual(["horus", "legion", "dune", "ego"]);
    expect(sorted("listened")).toEqual(["legion", "horus", "dune", "ego"]);
    expect(sorted("added")).toEqual(["dune", "horus", "legion", "ego"]);
    expect(sorted("length")[0]).toBe("dune");
    expect(sorted("year")).toEqual(["ego", "legion", "horus", "dune"]);
    expect(sorted("progress")).toEqual(["dune", "legion", "horus", "ego"]);
  });

  it("reverse flips them", () => {
    expect(sorted("title", true)).toEqual(["legion", "horus", "ego", "dune"]);
  });
});

describe("saved views", () => {
  it("read back what makes sense and drop the rest", () => {
    expect(parseView(null)).toEqual(DEFAULT_VIEW);
    expect(parseView({ sort: "nonsense", filter: { author: ["A", 3], missing: "cover" }, reverse: true })).toEqual({ sort: "shelf", filter: { author: ["A"] }, reverse: true });
  });
});
