import { describe, expect, it } from "vitest";
import { fold, indexBooks, searchBooks } from "@ribbon/core/search";
import type { Book, Part } from "@ribbon/core/types";

const book = (id: string, title: string, author: string, series = "", narrator = "", parts: Part[] = []): { book: Book; parts: Part[] } => ({
  book: {
    id,
    path: id,
    title,
    rawTitle: title,
    author,
    narrator,
    series,
    seriesIndex: null,
    year: null,
    cover: "",
    durationMs: 0,
    sizeBytes: 0,
    fileCount: 1,
  },
  parts,
});

const shelf = [
  book("horus", "01. Horus Rising", "Dan Abnett", "The Horus Heresy", "Toby Longworth"),
  book("false", "02. False Gods", "Graham McNeill", "The Horus Heresy"),
  book("legion", "07. Legion", "Dan Abnett", "The Horus Heresy"),
  book("drizzt", "Homeland", "R. A. Salvatore", "The Legend of Drizzt", "Victor Bevine"),
  book("bela", "Béla's Journey", "Zoë Quinn"),
  book("primarchs", "20. The Primarchs", "Various", "The Horus Heresy", "", [
    { title: "The Reflection Crack'd", author: "Gav Thorpe", startMs: 0, endMs: 10 },
    { title: "Feat of Iron", author: "Nick Kyme", startMs: 10, endMs: 20 },
  ]),
];

describe("book search", () => {
  it("folds case, accents and whitespace", () => {
    expect(fold("  Béla's   JOURNEY ")).toBe("bela's journey");
  });

  it("finds by title, author, narrator and series", async () => {
    const index = await indexBooks(shelf);
    expect(await searchBooks(index, "horus rising")).toContain("horus");
    expect(await searchBooks(index, "abnett")).toEqual(expect.arrayContaining(["horus", "legion"]));
    expect(await searchBooks(index, "longworth")).toEqual(["horus"]);
    expect(await searchBooks(index, "drizzt")).toEqual(["drizzt"]);
  });

  it("matches prefixes and forgives a typo", async () => {
    const index = await indexBooks(shelf);
    expect(await searchBooks(index, "sal")).toEqual(["drizzt"]);
    expect(await searchBooks(index, "abnet")).toEqual(expect.arrayContaining(["horus", "legion"]));
  });

  it("ignores accents in either direction", async () => {
    const index = await indexBooks(shelf);
    expect(await searchBooks(index, "bela")).toEqual(["bela"]);
    expect(await searchBooks(index, "zoë")).toEqual(["bela"]);
  });

  it("ranks a title hit above a series hit", async () => {
    const index = await indexBooks(shelf);
    const ids = await searchBooks(index, "horus");
    expect(ids[0]).toBe("horus");
    expect(ids).toHaveLength(4);
  });

  it("finds an anthology by one of its stories or their authors", async () => {
    const index = await indexBooks(shelf);
    expect(await searchBooks(index, "reflection")).toEqual(["primarchs"]);
    expect(await searchBooks(index, "kyme")).toEqual(["primarchs"]);
  });

  it("finds a book only when every word is in it, in any of its fields", async () => {
    const index = await indexBooks(shelf);
    expect(await searchBooks(index, "abnett rising")).toEqual(["horus"]);
    expect((await searchBooks(index, "abnett heresy")).sort()).toEqual(["horus", "legion"]);
    expect(await searchBooks(index, "salvatore homeland")).toEqual(["drizzt"]);
    expect(await searchBooks(index, "abnett drizzt")).toEqual([]);
  });

  it("brings back no books for a line from inside one", async () => {
    // A line from The Lion searched on the owner's shelf brought back thirty books, "Know No Fear" and "Old Earth"
    // first: Orama found any book with any of its words. Lines are found in the books' text (the server's search).
    const heresy = [
      book("lion", "The Lion: Son of the Forest: Warhammer 40,000", "Mike Brooks", "", "Jonathan Keeble"),
      book("fear", "19. Know No Fear", "Dan Abnett", "The Horus Heresy"),
      book("tread", "21. Fear to Tread", "James Swallow", "The Horus Heresy"),
      book("old", "47. Old Earth", "Nick Kyme", "The Horus Heresy"),
      book("galaxy", "03. Galaxy in Flames", "Ben Counter", "The Horus Heresy"),
      book("sons", "12. A Thousand Sons", "Graham McNeill", "The Horus Heresy"),
    ];
    const index = await indexBooks(heresy);
    expect(await searchBooks(index, "There is no malady at work here, my lord. You simply got old.")).toEqual([]);
    expect(await searchBooks(index, "his mind is like a blade")).toEqual([]);
    // Its title and its author still find it, together or apart.
    expect(await searchBooks(index, "son of the forest")).toEqual(["lion"]);
    expect(await searchBooks(index, "brooks lion")).toEqual(["lion"]);
  });

  it("returns nothing for a blank query", async () => {
    const index = await indexBooks(shelf);
    expect(await searchBooks(index, "   ")).toEqual([]);
  });
});
