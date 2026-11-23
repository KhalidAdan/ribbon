import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nodeHost } from "@ribbon/host-node/node";
import { comicEntries, comicEntry, openComic } from "@ribbon/host-node/comic";
import { comicInfoXml, makeComic, madePageName } from "@ribbon/host-node/make-comic";
import { extractMissingCovers, loadLibrary, scanLibrary, type ScannedBook } from "@ribbon/core/scan/scan";
import { bytesToComics } from "@ribbon/core/scan/comics";
import { groupBooks } from "@ribbon/core/scan/group";
import { pageOrder } from "@ribbon/core/comic/pages";
import { bytesToBooks, booksToBytes, LIBRARY_HEADERS } from "@ribbon/core/scan/records";

/**
 * Comics in the library (docs/COMICS.md, section 4), over comics made for
 * the test: one CBZ is one book, named by its ComicInfo.xml or else its
 * file, with its pages counted and its cover its first page.
 */
describe("comics in a scan", () => {
  let root: string;
  let books: ScannedBook[];
  const byTitle = (title: string) => books.find((b) => b.book.title === title)!;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-comics-"));
    // Says everything about itself.
    await makeComic(path.join(root, "Made Up Saga", "anything at all.cbz"), {
      pages: 5,
      wide: [3],
      comicInfo: comicInfoXml({ Title: "The Long Way", Series: "Made Up Saga", Number: 2, Year: 2019, Writer: "Ada Quill, Ben Nib", Publisher: "Paper Moon", Summary: "They walk.", Genre: "Fantasy", LanguageISO: "en" }),
    });
    // Says nothing: its file name counts.
    await makeComic(path.join(root, "Made Up Saga", "Made Up Saga 001 (2018) (Digital).cbz"), { pages: 3, unpadded: true });
    // Only a number: its folder is its series.
    await makeComic(path.join(root, "Second Series (2020)", "003.cbz"), { pages: 2 });
    // Right to left, pages in a folder inside the archive, with litter.
    await makeComic(path.join(root, "Right To Left.cbz"), { pages: 12, unpadded: true, folder: "scans", comicInfo: comicInfoXml({ Manga: "YesAndRightToLeft" }), extra: { "__MACOSX/._page-1.png": "x", "notes.txt": "hello" } });
    // Not a zip at all.
    await fs.writeFile(path.join(root, "Broken.cbz"), "this is not an archive");
    const result = await scanLibrary(nodeHost(), root);
    books = result.books;
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("makes each CBZ one book, with no audio and no EPUB", () => {
    expect(books).toHaveLength(5);
    for (const b of books) {
      expect(b.book.comic).toBe(b.book.path);
      expect(b.files).toEqual([]);
      expect(b.book.ebook).toBeUndefined();
      expect(b.book.durationMs).toBe(0);
      expect(b.pending).toBeUndefined();
    }
  });

  it("believes ComicInfo.xml first, in the fields every book has", () => {
    const b = byTitle("The Long Way").book;
    expect(b).toMatchObject({ series: "Made Up Saga", seriesIndex: 2, year: 2019, author: "Ada Quill, Ben Nib", narrator: "", publisher: "Paper Moon", description: "They walk.", genres: ["Fantasy"], language: "en", pages: 5 });
    expect(b.rightToLeft).toBeUndefined();
  });

  it("takes the series, number and year from a file name that has them", () => {
    expect(byTitle("Made Up Saga #1").book).toMatchObject({ series: "Made Up Saga", seriesIndex: 1, year: 2018, pages: 3, author: "" });
  });

  it("takes the series from the folder when the name is only a number", () => {
    expect(byTitle("Second Series #3").book).toMatchObject({ series: "Second Series", seriesIndex: 3, pages: 2 });
  });

  it("knows a comic read right to left, and counts only its pages", () => {
    expect(byTitle("Right To Left").book).toMatchObject({ rightToLeft: true, pages: 12, series: "", seriesIndex: null });
  });

  it("shelves a file that is not an archive, with no pages and no cover", () => {
    expect(byTitle("Broken").book).toMatchObject({ pages: 0, cover: "" });
  });

  it("keeps what it read in comics.csv and reads no comic twice", async () => {
    const kept = await bytesToComics(await fs.readFile(path.join(root, ".ribbon", "comics.csv")));
    expect(kept.size).toBe(5);
    expect(kept.get("Made Up Saga/anything at all.cbz")).toMatchObject({ pages: 5, title: "The Long Way", number: 2, writers: ["Ada Quill", "Ben Nib"] });
    const again = await scanLibrary(nodeHost(), root);
    expect(again.probed).toBe(0);
    expect(again.books.map((b) => b.book).sort((a, b) => a.id.localeCompare(b.id))).toEqual(books.map((b) => b.book).sort((a, b) => a.id.localeCompare(b.id)));
  });

  it("comes back from the records as it was scanned", async () => {
    const loaded = await loadLibrary(nodeHost(), root);
    expect(loaded!.find((b) => b.book.title === "Right To Left")!.book).toEqual(byTitle("Right To Left").book);
  });

  it("makes a comic's cover from its first page, small", async () => {
    const changed = await extractMissingCovers(nodeHost(), root, books);
    // Every comic with a page, and not the broken one.
    expect(changed.map((b) => b.book.title).sort()).toEqual(["Made Up Saga #1", "Right To Left", "Second Series #3", "The Long Way"]);
    const cover = await fs.readFile(path.join(root, ...byTitle("Right To Left").book.cover.split("/")));
    // A JPEG.
    expect([...cover.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    // Asked again, nothing is made again.
    expect(await extractMissingCovers(nodeHost(), root, books)).toEqual([]);
  });

  it("reads any page straight out of the archive, in the natural order of their names", async () => {
    const file = path.join(root, "Right To Left.cbz");
    const order = pageOrder((await comicEntries(file)).map((e) => e.name));
    expect(order).toHaveLength(12);
    expect(order[1]).toBe("scans/page-2.png");
    expect(order[9]).toBe("scans/page-10.png");
    const page = await comicEntry(file, order[9]!);
    // A PNG, the tenth page's own bytes.
    expect([...page.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    expect(order[9]).toBe(madePageName({ pages: 12, unpadded: true, folder: "scans" }, 9));
  });

  it("says so when asked for a page the archive doesn't have, and when the file is no archive", async () => {
    const comic = await openComic(path.join(root, "Right To Left.cbz"));
    expect(() => comic.source("scans/page-99.png")).toThrow(/no such page/);
    await comic.close();
    await expect(openComic(path.join(root, "Broken.cbz"))).rejects.toThrow();
  });
});

describe("a comic among other books", () => {
  const file = (relPath: string) => ({ relPath, absPath: `/lib/${relPath}`, name: relPath.split("/").pop()!, sizeBytes: 10, mtimeMs: 1 });

  it("is a book of its own, even in an audiobook's folder, and never pairs", () => {
    const groups = groupBooks([file("Dune/01.mp3"), file("Dune/02.mp3"), file("Dune/Dune.epub"), file("Dune/Dune 001.cbz"), file("Loose 002.cbz")]);
    expect(groups.map((g) => g.path)).toEqual(["Dune", "Dune/Dune 001.cbz", "Loose 002.cbz"]);
    expect(groups[0]).toMatchObject({ ebook: "Dune/Dune.epub" });
    expect(groups[0]!.comic).toBeUndefined();
    expect(groups[1]).toMatchObject({ comic: "Dune/Dune 001.cbz", audio: [] });
  });
});

describe("library.csv with comics", () => {
  const book = { id: "a", path: "a", title: "A", rawTitle: "A", author: "", narrator: "", series: "", seriesIndex: null, year: null, cover: "", durationMs: 1, sizeBytes: 1, fileCount: 1 };

  it("is byte for byte what it was for a library with no comic", async () => {
    const text = new TextDecoder().decode(await booksToBytes([book]));
    expect(text.split("\n")[0]!.trim()).toBe(LIBRARY_HEADERS.join(","));
  });

  it("carries a comic's own facts once there is one, and reads them back", async () => {
    const comic = { ...book, id: "c", path: "c.cbz", durationMs: 0, fileCount: 0, comic: "c.cbz", pages: 24, rightToLeft: true };
    const back = await bytesToBooks(await booksToBytes([book, comic]));
    expect(back[1]).toEqual(comic);
    expect(back[0]).toEqual(book);
  });
});
