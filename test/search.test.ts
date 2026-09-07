import { describe, expect, it } from "vitest";
import { fold, indexBooks, searchBooks } from "../src/core/search";
import type { Book } from "../src/core/types";

const book = (id: string, title: string, author: string, series = "", narrator = ""): Book => ({
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
});

const shelf = [
  book("horus", "01. Horus Rising", "Dan Abnett", "The Horus Heresy", "Toby Longworth"),
  book("false", "02. False Gods", "Graham McNeill", "The Horus Heresy"),
  book("legion", "07. Legion", "Dan Abnett", "The Horus Heresy"),
  book("drizzt", "Homeland", "R. A. Salvatore", "The Legend of Drizzt", "Victor Bevine"),
  book("bela", "Béla's Journey", "Zoë Quinn"),
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
    expect(ids).toHaveLength(3);
  });

  it("returns nothing for a blank query", async () => {
    const index = await indexBooks(shelf);
    expect(await searchBooks(index, "   ")).toEqual([]);
  });
});
