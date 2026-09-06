import { describe, expect, it } from "vitest";
import { booksToBytes, bytesToBooks, bytesToChapters, bytesToFiles, chaptersToBytes, filesToBytes, filesToRows, isStale } from "../src/core/scan/records";
import type { AudioFile, Book } from "../src/core/types";

const book: Book = {
  id: "0badf00d",
  path: "Series/Book, One",
  title: "Book One",
  rawTitle: "Book One (Unabridged)",
  author: "A \"quoted\" Author",
  narrator: "",
  series: "Series",
  seriesIndex: 1.5,
  year: 2020,
  cover: "Series/Book, One/cover.jpg",
  durationMs: 123_456,
  sizeBytes: 999,
  fileCount: 2,
};

const files: AudioFile[] = [
  { path: "Series/Book, One/01.mp3", order: 0, durationMs: 100, sizeBytes: 10, mtimeMs: 1, title: "One", disc: 1, track: 1, hasCover: true, chapters: [], chaptersProbed: true },
  {
    path: "Series/Book, One/02.mp3",
    order: 1,
    durationMs: 200,
    sizeBytes: 20,
    mtimeMs: 2,
    title: "Two",
    disc: 1,
    track: 2,
    hasCover: false,
    chapters: [
      { startMs: 0, endMs: 100, title: "a|b:c\\d" },
      { startMs: 100, endMs: 200, title: "" },
    ],
    chaptersProbed: true,
  },
];

describe("records", () => {
  it("round-trips library.csv", async () => {
    const back = await bytesToBooks(await booksToBytes([book]));
    expect(back).toEqual([book]);
  });

  it("round-trips nulls", async () => {
    const b = { ...book, seriesIndex: null, year: null };
    expect((await bytesToBooks(await booksToBytes([b])))[0]).toEqual(b);
  });

  it("round-trips files.csv including packed chapters", async () => {
    const back = await bytesToFiles(await filesToBytes(filesToRows(book.id, files)));
    expect(back.get(book.id)).toEqual(files);
  });

  it("round-trips chapters.csv", async () => {
    const ch = [
      { startMs: 0, endMs: 5, title: "x" },
      { startMs: 5, endMs: 9, title: "y, z" },
    ];
    expect(await bytesToChapters(await chaptersToBytes(ch))).toEqual(ch);
  });

  it("detects staleness by size or mtime beyond a second", () => {
    expect(isStale({ sizeBytes: 1, mtimeMs: 1000 }, { sizeBytes: 1, mtimeMs: 1500 })).toBe(false);
    expect(isStale({ sizeBytes: 1, mtimeMs: 1000 }, { sizeBytes: 2, mtimeMs: 1000 })).toBe(true);
    expect(isStale({ sizeBytes: 1, mtimeMs: 1000 }, { sizeBytes: 1, mtimeMs: 5000 })).toBe(true);
  });
});
