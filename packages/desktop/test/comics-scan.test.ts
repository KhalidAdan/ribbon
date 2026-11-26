import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nodeHost } from "@ribbon/host-node/node";
import { comicEntries, comicEntry, openComic } from "@ribbon/host-node/comic";
import { comicInfoXml, makeComic, makePdf, madePageName } from "@ribbon/host-node/make-comic";
import type { Host, ScannedFile } from "@ribbon/core/host";
import { bytesToRows, rowsToBytes } from "@ribbon/core/csv";
import { extractMissingCovers, loadLibrary, scanLibrary, type ScannedBook } from "@ribbon/core/scan/scan";
import { bytesToComics, keepsComicDetails } from "@ribbon/core/scan/comics";
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

  it("believes ComicInfo.xml first, and names the comic from its details", () => {
    const b = byTitle("Made Up Saga #2: The Long Way").book;
    expect(b).toMatchObject({ rawTitle: "The Long Way", series: "Made Up Saga", issue: "2", seriesIndex: 2, year: 2019, coverDate: "2019", author: "Ada Quill; Ben Nib", credits: { writers: ["Ada Quill", "Ben Nib"] }, narrator: "", publisher: "Paper Moon", description: "They walk.", genres: ["Fantasy"], language: "en", pages: 5 });
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
    expect(kept.get("Made Up Saga/anything at all.cbz")).toMatchObject({ pages: 5, title: "The Long Way", number: "2", credits: { writers: ["Ada Quill", "Ben Nib"] } });
    const again = await scanLibrary(nodeHost(), root);
    expect(again.probed).toBe(0);
    expect(again.books.map((b) => b.book).sort((a, b) => a.id.localeCompare(b.id))).toEqual(books.map((b) => b.book).sort((a, b) => a.id.localeCompare(b.id)));
  });

  it("comes back from the records as it was scanned, its details and all", async () => {
    const loaded = await loadLibrary(nodeHost(), root);
    for (const title of ["Right To Left", "Made Up Saga #2: The Long Way"]) expect(loaded!.find((b) => b.book.title === title)!.book).toEqual(byTitle(title).book);
  });

  it("makes a comic's cover from its first page, small", async () => {
    const changed = await extractMissingCovers(nodeHost(), root, books);
    // Every comic with a page, and not the broken one.
    expect(changed.map((b) => b.book.title).sort()).toEqual(["Made Up Saga #1", "Made Up Saga #2: The Long Way", "Right To Left", "Second Series #3"]);
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

/**
 * A library scanned before comics kept their details (docs/BOOK-DETAILS.md,
 * section 4): its comics.csv keeps only some of what each comic's files
 * say, so every comic is read once more, after the shelf has painted from
 * the folder walk, and never again after that.
 */
describe("a comics.csv from before comics kept their details", () => {
  let root: string;
  const SAGA = "Made Up Saga/Made Up Saga 014.cbz";
  const PDF = "Old Tales 003.pdf";

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-comics-again-"));
    await makeComic(path.join(root, ...SAGA.split("/")), {
      pages: 3,
      comicInfo: comicInfoXml({ Title: "Chapter Fourteen", Series: "Made Up Saga", Number: "14", Writer: "Ada Quill", Penciller: "Ben Nib", Colorist: "Cy Ink", Year: 2019, Month: 7, StoryArc: "The Long Way" }),
    });
    await makeComic(path.join(root, "Made Up Saga", "Made Up Saga Vol. 1.cbz"), { pages: 2 });
    await makePdf(path.join(root, PDF), { pages: 2 });
    await scanLibrary(nodeHost(), root);
    // comics.csv as Ribbon 0.51.0 wrote it: these columns and no others.
    const file = path.join(root, ".ribbon", "comics.csv");
    const { rows } = await bytesToRows(await fs.readFile(file));
    await fs.writeFile(file, await rowsToBytes(rows, ["path", "size_bytes", "mtime_ms", "pages", "title", "series", "number", "year", "writers", "publisher", "summary", "language", "genres", "right_to_left"]));
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reads each comic again once the shelf has painted, showing it as the old records have it until then, and a PDF not at all", async () => {
    // The host as it is, but holding back what it reads until the walk's shelf is out, and saying what it was told it knows.
    const inner = nodeHost();
    let known: string[] = [];
    let painted!: () => void;
    const firstShelf = new Promise<void>((done) => (painted = done));
    const host: Host = {
      ...inner,
      async scan(at, knownFiles, onProgress, onFiles) {
        known = knownFiles.map((k) => k.path);
        const held: ScannedFile[][] = [];
        let walked = false;
        const out = await inner.scan(at, knownFiles, onProgress, (files) => {
          if (walked) held.push(files);
          else onFiles?.(files);
          walked = true;
        });
        await firstShelf;
        for (const files of held) onFiles?.(files);
        return out;
      },
    };
    const shelves: ScannedBook[][] = [];
    const result = await scanLibrary(host, root, {
      onBooks: (books) => {
        shelves.push(books);
        painted();
      },
    });

    // The comics weren't counted as known, so the host read them; the PDF, with no ComicInfo.xml to read again, was.
    expect(known).toEqual([PDF]);
    expect(result.probed).toBe(2);
    // The shelf from the walk: the issue as the old records keep it, its writers and its number but not its colourist.
    const before = shelves[0]!.find((b) => b.book.comic === SAGA)!.book;
    expect(before).toMatchObject({ title: "Made Up Saga #14: Chapter Fourteen", credits: { writers: ["Ada Quill"] } });
    expect(before.credits?.colours).toBeUndefined();
    // Read again: everything its ComicInfo.xml says.
    const after = result.books.find((b) => b.book.comic === SAGA)!.book;
    expect(after).toMatchObject({ title: "Made Up Saga #14: Chapter Fourteen", author: "Ada Quill; Ben Nib", coverDate: "2019-07", storyArcs: ["The Long Way"], credits: { writers: ["Ada Quill"], pencils: ["Ben Nib"], colours: ["Cy Ink"] } });
    expect(result.books.find((b) => b.book.comic === PDF)!.book.pages).toBe(2);
    // Kept in the new columns, so it is never read again.
    expect(keepsComicDetails(await fs.readFile(path.join(root, ".ribbon", "comics.csv")))).toBe(true);
    const again = await scanLibrary(nodeHost(), root);
    expect(again.probed).toBe(0);
    expect(again.books.find((b) => b.book.comic === SAGA)!.book).toEqual(after);
  });
});
