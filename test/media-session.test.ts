import { describe, expect, it } from "vitest";
import { mediaMetadataFor } from "../src/app/media-session";
import type { ScannedBook } from "../src/core/scan/scan";

const book: ScannedBook = {
  book: { id: "a", path: "20. The Primarchs", title: "20. The Primarchs", rawTitle: "20. The Primarchs", author: "Various", narrator: "", series: "The Horus Heresy", seriesIndex: 20, year: null, cover: "", durationMs: 20, sizeBytes: 1, fileCount: 2 },
  files: [],
  chapters: [],
  parts: [
    { title: "The Reflection Crack'd", author: "Gav Thorpe", startMs: 0, endMs: 10 },
    { title: "Feat of Iron", author: "", startMs: 10, endMs: 20 },
  ],
};

describe("mediaMetadataFor", () => {
  it("names the book and chapter, under the series, for a plain book", () => {
    expect(mediaMetadataFor({ ...book, parts: [] }, "Chapter 3", null)).toEqual({ title: "20. The Primarchs: Chapter 3", artist: "Various", album: "The Horus Heresy" });
  });

  it("puts the story where the book was, by its own author, with the book as the album", () => {
    expect(mediaMetadataFor(book, "Chapter 1", book.parts[0]!)).toEqual({ title: "The Reflection Crack'd: Chapter 1", artist: "Gav Thorpe", album: "20. The Primarchs" });
  });

  it("falls back to the book's author when the story has none", () => {
    expect(mediaMetadataFor(book, "", book.parts[1]!)).toEqual({ title: "Feat of Iron", artist: "Various", album: "20. The Primarchs" });
  });
});
