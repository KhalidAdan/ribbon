import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeComic, makePdf } from "@ribbon/host-node/make-comic";
import { localIdOf, remoteBook } from "@ribbon/core/server-books";
import { imageSize } from "@ribbon/core/comic/size";
import { parseLog } from "@ribbon/core/poslog";
import type { RibbonServer } from "../src/app.ts";
import type { ListedBook, StoredBook } from "../src/library/books.ts";
import { importAs, mp3, serverWithAdmin } from "./fixture.ts";

/**
 * PDFs on the server (docs/COMICS.md, section 12), over PDFs made for the
 * test: a PDF is kept whole, its pages counted and measured, and each
 * page is drawn the first time a device asks for it, so a device with
 * nothing that reads a PDF reads one as it reads a comic.
 */
describe("PDFs on the server", () => {
  let dir: string;
  let shelf: string;
  let server: RibbonServer;
  let token: string;
  let books: ListedBook[];
  const DEVICE = { id: "urn:uuid:0b1f5c1e-3a52-4c11-9d36-6a1c0e7f5a10", name: "An iPad" };
  const get = (url: string) => server.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  const post = (url: string, body: unknown) => server.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: JSON.stringify(body) });
  const titled = (title: string) => books.find((b) => b.title === title)!;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-pdfs-server-"));
    shelf = path.join(dir, "shelf");
    mkdirSync(path.join(shelf, "Red Book"), { recursive: true });
    mp3(path.join(shelf, "Red Book", "01.mp3"), { title: "One", album: "Red Book", artist: "Ada Quill" });
    // Beside an audiobook's files, a PDF is its booklet, and not a book.
    await makePdf(path.join(shelf, "Red Book", "Booklet.pdf"), { pages: 2 });
    await makePdf(path.join(shelf, "Old Tales", "Old Tales 014 (1954).pdf"), { pages: 7, wide: [3] });
    await makeComic(path.join(shelf, "Old Tales", "Old Tales 015 (1954).cbz"), { pages: 3 });
    const made = await serverWithAdmin(dir);
    server = made.server;
    token = made.admin;
    expect((await importAs(server, token, shelf)).status).toBe(202);
    books = ((await get("/api/books")).json() as { books: ListedBook[] }).books;
  }, 60_000);

  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("lists a PDF as a book of pages, and says its pages are a PDF's", () => {
    expect(books.map((b) => b.title).sort()).toEqual(["Old Tales #14", "Old Tales #15", "Red Book"]);
    expect(titled("Old Tales #14")).toMatchObject({ comic: true, pdf: true, pages: 7, audio: false, ebook: false, series: "Old Tales", seriesIndex: 14 });
    expect(titled("Old Tales #15")).toMatchObject({ comic: true, pdf: false, pages: 3 });
    expect(titled("Red Book")).toMatchObject({ comic: false, pdf: false });
    // Its cover is its first page, drawn.
    expect(titled("Old Tales #14").cover).not.toBeNull();
  });

  it("keeps the PDF whole, with each page's size", async () => {
    const pdf = titled("Old Tales #14");
    const stored = (await get(`/api/books/${pdf.id}`)).json() as StoredBook;
    expect(stored.book).toMatchObject({ comic: "book.pdf", pages: 7 });
    expect(stored.pages!.slice(0, 2)).toEqual([
      { name: "page=1", width: 200, height: 300 },
      { name: "page=2", width: 200, height: 300 },
    ]);
    expect(stored.pages![3]).toMatchObject({ width: 400, height: 300 });
    expect(readFileSync(path.join(dir, "data", "books", pdf.id, "book.pdf")).equals(readFileSync(path.join(shelf, "Old Tales", "Old Tales 014 (1954).pdf")))).toBe(true);
    const file = await get(`/api/books/${pdf.id}/files/book.pdf`);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.length).toBe(pdf.sizeBytes);
  });

  it("draws a page the first time it is asked for, keeps it, and sends the kept one after", async () => {
    const pdf = titled("Old Tales #14");
    const kept = path.join(dir, "data", "books", pdf.id, "pages", "4-1200.jpg");
    expect(existsSync(kept)).toBe(false);
    const page = await get(`/api/books/${pdf.id}/pages/4?width=1200`);
    expect(page.statusCode, page.body.slice(0, 200)).toBe(200);
    expect(page.headers["content-type"]).toBe("image/jpeg");
    expect(page.headers["cache-control"]).toMatch(/immutable/);
    // The fourth page is drawn across two: twice as wide as it is asked to be tall for.
    expect(imageSize(new Uint8Array(page.rawPayload))).toEqual({ width: 1200, height: 900 });
    expect(existsSync(kept)).toBe(true);
    const again = await get(`/api/books/${pdf.id}/pages/4?width=1200`);
    expect(again.rawPayload.equals(page.rawPayload)).toBe(true);
    // A width it isn't drawn at gets the larger of the two.
    expect(imageSize(new Uint8Array((await get(`/api/books/${pdf.id}/pages/1?width=77`)).rawPayload))).toEqual({ width: 2400, height: 3600 });
    for (const bad of ["0", "8", "x"]) expect((await get(`/api/books/${pdf.id}/pages/${bad}`)).statusCode, bad).toBe(404);
  });

  it("draws one page once when two devices ask at the same moment", async () => {
    const pdf = titled("Old Tales #14");
    const [a, b] = await Promise.all([get(`/api/books/${pdf.id}/pages/6?width=1200`), get(`/api/books/${pdf.id}/pages/6?width=1200`)]);
    expect(a.statusCode).toBe(200);
    expect(b.rawPayload.equals(a.rawPayload)).toBe(true);
  });

  it("takes a page as a place, written as PDFs name one, and gives it back", async () => {
    const pdf = titled("Old Tales #14");
    const told = await post(`/api/books/${pdf.id}/place`, { device: DEVICE, page: 5, why: "periodic" });
    expect(told.statusCode, told.body).toBe(200);
    expect(((await get(`/api/books/${pdf.id}/place`)).json() as { place: { page: number; pages: number } }).place).toMatchObject({ page: 5, pages: 7 });
    const log = parseLog((await get("/api/places/export")).body).records;
    expect(log.at(-1)).toMatchObject({ k: "pos", book: { ids: [`urn:ribbon:${localIdOf(pdf)}-text`] }, loc: { href: "book.pdf", type: "application/pdf", locations: { position: 5, fragments: ["page=5"] } } });
  });

  it("is, to a desktop, a PDF to download: one file in its folder, with the id it will have there", () => {
    const pdf = titled("Old Tales #14");
    expect(remoteBook(pdf).book).toMatchObject({ comic: `${pdf.id}/book.pdf`, pages: 7, fileCount: 0 });
    expect(remoteBook(pdf).book.id).toBe(localIdOf(pdf));
    // A comic's id is what it was before PDFs.
    expect(remoteBook(titled("Old Tales #15")).book.comic).toBe(`${titled("Old Tales #15").id}/book.cbz`);
  });
});
