import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nodeHost } from "@ribbon/host-node/node";
import { openPdf } from "@ribbon/host-node/pdf";
import { makePdf } from "@ribbon/host-node/make-comic";
import { extractMissingCovers, scanLibrary, type ScannedBook } from "@ribbon/core/scan/scan";
import { groupBooks } from "@ribbon/core/scan/group";
import { pageAt, pageLocator, pdfPageNames } from "@ribbon/core/comic/session";
import { parseLog } from "@ribbon/core/poslog";
import { AppController, type Platform } from "../src/app/controller";
import { memorySettings, memorySources } from "../src/app/platform";
import { lengthOf, progressOf } from "../src/ui/progress";

/**
 * PDFs, read as comics are (docs/COMICS.md, section 12), over PDFs made
 * for the test: a PDF is a book of pages, named by its file, its pages
 * counted and its cover its first page drawn; its place is a page.
 */
describe("PDFs in a library", () => {
  let root: string;
  let books: ScannedBook[];
  const byTitle = (title: string) => books.find((b) => b.book.title === title)!;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-pdfs-"));
    await makePdf(path.join(root, "Old Tales", "Old Tales 014 (1954).pdf"), { pages: 7, wide: [3] });
    await makePdf(path.join(root, "A Book Alone.pdf"), { pages: 2 });
    await fs.writeFile(path.join(root, "Not A PDF.pdf"), "this is not a PDF");
    books = (await scanLibrary(nodeHost(), root)).books;
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("is a book of pages, named by its file, with its pages counted", () => {
    expect(books.map((b) => b.book.title).sort()).toEqual(["A Book Alone", "Not A PDF", "Old Tales #14"]);
    expect(byTitle("Old Tales #14").book).toMatchObject({ comic: "Old Tales/Old Tales 014 (1954).pdf", series: "Old Tales", seriesIndex: 14, year: 1954, pages: 7, durationMs: 0, fileCount: 0 });
    expect(lengthOf(byTitle("Old Tales #14"))).toBe("7 pages");
  });

  it("shelves a file that isn't a PDF after all, with no pages and no cover", () => {
    expect(byTitle("Not A PDF").book).toMatchObject({ pages: 0, cover: "" });
  });

  it("is counted once, and not again while it is unchanged", async () => {
    const again = await scanLibrary(nodeHost(), root);
    expect(again.probed).toBe(0);
    expect(again.books.find((b) => b.book.title === "Old Tales #14")!.book.pages).toBe(7);
  });

  it("has its first page, drawn small, for a cover", async () => {
    const changed = await extractMissingCovers(nodeHost(), root, books);
    expect(changed.map((b) => b.book.title).sort()).toEqual(["A Book Alone", "Old Tales #14"]);
    const cover = await fs.readFile(path.join(root, ...byTitle("Old Tales #14").book.cover.split("/")));
    expect([...cover.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });

  it("says each page's size, so a page drawn across two is known before it is drawn", async () => {
    const pdf = await openPdf(path.join(root, "Old Tales", "Old Tales 014 (1954).pdf"));
    expect(pdf.pages).toBe(7);
    expect(await pdf.size(0)).toEqual({ width: 200, height: 300 });
    expect(await pdf.size(3)).toEqual({ width: 400, height: 300 });
    await pdf.close();
  });

  it("opens in the comic reader, keeps its page in the log as PDFs name one, and opens there again", async () => {
    const platform = (settings = memorySettings()): Platform => ({ host: nodeHost(), pickFolder: async () => root, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: settings });
    const c = new AppController(platform());
    await c.boot();
    await c.pickLibrary();
    const book = c.getState().books.find((b) => b.book.title === "Old Tales #14")!;
    await c.playBook(book);
    expect(c.getState().comic).toMatchObject({ status: "ready", page: 0, document: "Old Tales 014 (1954).pdf" });
    expect((c.getState().comic as { pages: string[] }).pages.slice(0, 2)).toEqual(["page=1", "page=2"]);
    expect(c.comicDocument()).toEqual({ url: `file:///${path.join(root, "Old Tales", "Old Tales 014 (1954).pdf")}`, bytes: book.book.sizeBytes });
    c.turnComic(4, "seek");
    await c.closeComic();
    expect(progressOf(book, c.getState(), (id) => c.readingProgress(id)).fraction).toBeCloseTo(4 / 6, 3);

    const dir = path.join(root, ".ribbon", "positions");
    const log = (await Promise.all((await fs.readdir(dir)).filter((f) => f.endsWith(".ndjson")).map(async (f) => parseLog(await fs.readFile(path.join(dir, f), "utf8")).records))).flat();
    expect(log.filter((r) => r.k === "pos").at(-1)).toMatchObject({ book: { ids: [`urn:ribbon:${book.book.id}-text`] }, loc: { href: "Old Tales 014 (1954).pdf", type: "application/pdf", locations: { position: 5, fragments: ["page=5"] } } });
    c.destroy();

    const other = new AppController(platform());
    await other.boot();
    await other.pickLibrary();
    await other.openComic(book.book.id);
    expect(other.getState().comic).toMatchObject({ status: "ready", page: 4 });
    await other.closeComic();
    other.destroy();
  });
});

describe("a PDF's place", () => {
  it("is found again by the page its fragment names, then by its number", () => {
    const pages = pdfPageNames(10);
    expect(pageAt(pages, pageLocator(pages, 6, "a.pdf"))).toBe(6);
    expect(pageAt(pages, { href: "renamed.pdf", locations: { fragments: ["page=3"] } })).toBe(2);
    expect(pageAt(pages, { href: "renamed.pdf", locations: { position: 9 } })).toBe(8);
  });
});

describe("which PDFs are books", () => {
  const file = (relPath: string) => ({ relPath, absPath: `/lib/${relPath}`, name: relPath.split("/").pop()!, sizeBytes: 10, mtimeMs: 1 });

  it("is one in a folder with no audio and no EPUB; beside those it is the book's booklet", () => {
    const groups = groupBooks([file("Dune/01.mp3"), file("Dune/Booklet.pdf"), file("Novel/Novel.epub"), file("Novel/Map.pdf"), file("Old Tales/Old Tales 001.pdf"), file("Old Tales/Old Tales 002.cbz"), file("Loose.pdf")]);
    expect(groups.map((g) => g.path)).toEqual(["Dune", "Novel/Novel.epub", "Old Tales/Old Tales 002.cbz", "Old Tales/Old Tales 001.pdf", "Loose.pdf"]);
  });

  it("is not one at the root beside loose audiobooks", () => {
    expect(groupBooks([file("Book.m4b"), file("Booklet.pdf")]).map((g) => g.path)).toEqual(["Book.m4b"]);
  });
});
