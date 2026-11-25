import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { makeComic, makePdf, pagePng } from "@ribbon/host-node/make-comic";
import { makeComicRar } from "@ribbon/host-node/make-cbr";
import { cbrTool } from "@ribbon/host-node/cbr";
import { imageSize } from "@ribbon/core/comic/size";
import type { RibbonServer } from "../src/app.ts";
import type { ListedBook } from "../src/library/books.ts";
import { importAs, serverWithAdmin } from "./fixture.ts";

/**
 * Small pictures of every page on the server (docs/COMICS.md, section 15),
 * over comics made for the test: `?small` on a page sends it 300 pixels
 * tall, made the first time it is asked for and kept beside the book, for
 * the strip of pages a reader shows. A comic's is shrunk from its page, a
 * PDF's is drawn small, and a CBR is a comic like any other by then.
 */
describe("small pictures of a comic's pages", () => {
  let dir: string;
  let shelf: string;
  let server: RibbonServer;
  let token: string;
  let books: ListedBook[];
  const get = (url: string) => server.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  const titled = (title: string) => books.find((b) => b.title === title)!;
  const kept = (book: ListedBook, name: string) => path.join(dir, "data", "books", book.id, "pages", name);
  const sizeOf = (payload: Buffer) => imageSize(new Uint8Array(payload));

  beforeAll(async () => {
    expect(cbrTool(), "build the CBR reader first: cargo build --manifest-path packages/desktop/src-tauri/Cargo.toml -p ribbon-cbr").not.toBeNull();
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-small-pages-"));
    shelf = path.join(dir, "shelf");
    // Pages three times the size of a small one, the third drawn across two; and a last page that isn't a picture at all.
    await makeComic(path.join(shelf, "Big Pages", "Big Pages 001 (2020).cbz"), { pages: 4, width: 600, height: 900, wide: [2], extra: { "page-999.jpg": "not a picture" } });
    // Pages already smaller than a small picture.
    await makeComic(path.join(shelf, "Big Pages", "Big Pages 002 (2020).cbz"), { pages: 2, width: 100, height: 150 });
    await makePdf(path.join(shelf, "Old Tales", "Old Tales 014 (1954).pdf"), { pages: 3, width: 400, height: 600, wide: [1] });
    await makeComicRar(path.join(shelf, "Rar Saga", "Rar Saga 003.cbr"), { pages: 3, width: 600, height: 900 });
    const made = await serverWithAdmin(dir);
    server = made.server;
    token = made.admin;
    expect((await importAs(server, token, shelf)).status).toBe(202);
    books = ((await get("/api/books")).json() as { books: ListedBook[] }).books;
    expect(books.map((b) => b.title).sort()).toEqual(["Big Pages #1", "Big Pages #2", "Old Tales #14", "Rar Saga #3"]);
  }, 60_000);

  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("makes a page's small picture the first time it is asked for, 300 pixels tall, keeps it, and sends the kept one after", async () => {
    const comic = titled("Big Pages #1");
    expect(existsSync(kept(comic, "1-small.jpg"))).toBe(false);
    const small = await get(`/api/books/${comic.id}/pages/1?small`);
    expect(small.statusCode, small.body.slice(0, 200)).toBe(200);
    expect(small.headers["content-type"]).toBe("image/jpeg");
    expect(small.headers["cache-control"]).toMatch(/immutable/);
    expect(sizeOf(small.rawPayload)).toEqual({ width: 200, height: 300 });
    expect(existsSync(kept(comic, "1-small.jpg"))).toBe(true);
    expect((await get(`/api/books/${comic.id}/pages/1?small`)).rawPayload.equals(small.rawPayload)).toBe(true);
    // A page drawn across two is as tall as the others, and twice as wide.
    expect(sizeOf((await get(`/api/books/${comic.id}/pages/3?small`)).rawPayload)).toEqual({ width: 400, height: 300 });
    // The page itself is sent as it always was.
    expect(sizeOf((await get(`/api/books/${comic.id}/pages/1`)).rawPayload)).toEqual({ width: 600, height: 900 });
  });

  it("is that page, shrunk: its colour where the page has its colour", async () => {
    const comic = titled("Big Pages #1");
    for (const n of [2, 4]) {
      const small = await get(`/api/books/${comic.id}/pages/${n}?small`);
      const corner = await pixel(small.rawPayload, 4, 4);
      const page = await pixel(Buffer.from(pagePng(n, 600, 900)), 12, 12);
      // A JPEG's colours are near, not exact.
      for (const [i, c] of corner.entries()) expect(Math.abs(c - page[i]!), `page ${n}`).toBeLessThan(10);
    }
  });

  it("never makes a small picture larger than its page", async () => {
    const comic = titled("Big Pages #2");
    expect(sizeOf((await get(`/api/books/${comic.id}/pages/2?small`)).rawPayload)).toEqual({ width: 100, height: 150 });
  });

  it("draws a PDF's page small, rather than shrinking a large drawing of it", async () => {
    const pdf = titled("Old Tales #14");
    const small = await get(`/api/books/${pdf.id}/pages/2?small`);
    expect(small.statusCode, small.body.slice(0, 200)).toBe(200);
    expect(sizeOf(small.rawPayload)).toEqual({ width: 400, height: 300 });
    expect(sizeOf((await get(`/api/books/${pdf.id}/pages/1?small`)).rawPayload)).toEqual({ width: 200, height: 300 });
    expect(existsSync(kept(pdf, "2-small.jpg"))).toBe(true);
    // Nothing large was drawn to make it.
    for (const width of [1200, 2400]) expect(existsSync(kept(pdf, `2-${width}.jpg`))).toBe(false);
  });

  it("makes a CBR's, which the server keeps as a CBZ, as any comic's", async () => {
    const cbr = titled("Rar Saga #3");
    expect(sizeOf((await get(`/api/books/${cbr.id}/pages/3?small`)).rawPayload)).toEqual({ width: 200, height: 300 });
  });

  it("makes one once when two devices ask for it at the same moment", async () => {
    const comic = titled("Rar Saga #3");
    const [a, b] = await Promise.all([get(`/api/books/${comic.id}/pages/2?small`), get(`/api/books/${comic.id}/pages/2?small`)]);
    expect(a.statusCode).toBe(200);
    expect(b.rawPayload.equals(a.rawPayload)).toBe(true);
  });

  it("says when a page isn't a picture, and keeps nothing of it", async () => {
    const comic = titled("Big Pages #1");
    const bad = await get(`/api/books/${comic.id}/pages/5?small`);
    expect(bad.statusCode).toBe(500);
    expect(bad.json()).toEqual({ error: "Page 5 isn't a picture this server can read." });
    expect(existsSync(kept(comic, "5-small.jpg"))).toBe(false);
    expect(existsSync(kept(comic, `5-small.jpg.${process.pid}.tmp`))).toBe(false);
  });

  it("is asked for as a page is: counted from 1, of a comic, by someone signed in", async () => {
    const comic = titled("Big Pages #1");
    for (const bad of ["0", "6", "x", "1.5"]) expect((await get(`/api/books/${comic.id}/pages/${bad}?small`)).statusCode, bad).toBe(404);
    expect((await get(`/api/books/no-such-book/pages/1?small`)).statusCode).toBe(404);
    expect((await server.app.inject({ method: "GET", url: `/api/books/${comic.id}/pages/1?small` })).statusCode).toBe(401);
  });
});

/** The colour of one pixel of a picture, as red, green and blue. */
async function pixel(bytes: Buffer, x: number, y: number): Promise<number[]> {
  const picture = await loadImage(bytes);
  const canvas = createCanvas(picture.width, picture.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(picture, 0, 0);
  return [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)];
}
