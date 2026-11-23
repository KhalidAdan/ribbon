import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { comicEntry } from "@ribbon/host-node/comic";
import { comicInfoXml, makeComic } from "@ribbon/host-node/make-comic";
import { localIdOf, remoteBook } from "@ribbon/core/server-books";
import { parseLog } from "@ribbon/core/poslog";
import type { RibbonServer } from "../src/app.ts";
import type { ListedBook, StoredBook } from "../src/library/books.ts";
import { importAs, mp3, serverWithAdmin } from "./fixture.ts";

/**
 * Comics on the server (docs/COMICS.md, section 7), over comics made for
 * the test: a CBZ is copied in once, listed as a comic with its pages,
 * its pages are sent one at a time out of the archive, and a device that
 * keeps no log tells the server its page and asks for it back.
 */
describe("comics on the server", () => {
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
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-comics-server-"));
    shelf = path.join(dir, "shelf");
    mkdirSync(path.join(shelf, "Red Book"), { recursive: true });
    mp3(path.join(shelf, "Red Book", "01.mp3"), { title: "One", album: "Red Book", artist: "Ada Quill" });
    await makeComic(path.join(shelf, "Made Up Saga", "Made Up Saga 001 (2018).cbz"), { pages: 12, wide: [4], unpadded: true, folder: "scans", extra: { "__MACOSX/._page-1.png": "x" } });
    await makeComic(path.join(shelf, "Made Up Saga", "anything.cbz"), { pages: 3, comicInfo: comicInfoXml({ Title: "The Long Way", Series: "Made Up Saga", Number: 2, Writer: "Ada Quill", Summary: "They walk.", Manga: "YesAndRightToLeft" }) });
    writeFileSync(path.join(shelf, "Broken.cbz"), "not an archive");
    const made = await serverWithAdmin(dir);
    server = made.server;
    token = made.admin;
    const added = await importAs(server, token, shelf);
    expect(added.status).toBe(202);
    books = ((await get("/api/books")).json() as { books: ListedBook[] }).books;
  }, 60_000);

  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists a comic as one, with its pages, beside the other books", () => {
    expect(books.map((b) => b.title).sort()).toEqual(["Made Up Saga #1", "Red Book", "The Long Way"]);
    expect(titled("Made Up Saga #1")).toMatchObject({ comic: true, pages: 12, audio: false, ebook: false, series: "Made Up Saga", seriesIndex: 1, durationMs: 0 });
    expect(titled("The Long Way")).toMatchObject({ comic: true, pages: 3, author: "Ada Quill", seriesIndex: 2 });
    expect(titled("Red Book")).toMatchObject({ comic: false, pages: null, audio: true });
    // Its cover is its first page, made at the sizes the apps draw.
    expect(titled("Made Up Saga #1").cover).not.toBeNull();
  });

  it("leaves out a file that isn't a comic, and says why", async () => {
    const job = (await importAs(server, token, shelf)).job;
    expect(JSON.stringify(job.progress)).toMatch(/Broken/);
    expect(JSON.stringify(job.progress)).toMatch(/isn't a comic Ribbon can open|no pages/);
  });

  it("never adds a comic twice", async () => {
    await importAs(server, token, shelf);
    const again = ((await get("/api/books")).json() as { books: ListedBook[] }).books;
    expect(again.map((b) => b.id).sort()).toEqual(books.map((b) => b.id).sort());
  });

  it("keeps the CBZ whole and lists its pages in reading order, each with its size", async () => {
    const comic = titled("Made Up Saga #1");
    const stored = (await get(`/api/books/${comic.id}`)).json() as StoredBook;
    expect(stored.book).toMatchObject({ comic: "book.cbz", pages: 12 });
    expect(stored.pages).toHaveLength(12);
    expect(stored.pages!.slice(0, 2)).toEqual([
      { name: "scans/page-1.png", width: 200, height: 300 },
      { name: "scans/page-2.png", width: 200, height: 300 },
    ]);
    expect(stored.pages![9]!.name).toBe("scans/page-10.png");
    // The fifth is drawn across two.
    expect(stored.pages![4]).toMatchObject({ width: 400, height: 300 });
    const copy = path.join(dir, "data", "books", comic.id, "book.cbz");
    expect(readFileSync(copy).equals(readFileSync(path.join(shelf, "Made Up Saga", "Made Up Saga 001 (2018).cbz")))).toBe(true);
    // Nothing is left of making the cover.
    expect(existsSync(path.join(dir, "data", "books", comic.id, "first-page.png"))).toBe(false);
  });

  it("sends a page out of the archive as it is in it, counted from 1, to keep for good", async () => {
    const comic = titled("Made Up Saga #1");
    const page = await get(`/api/books/${comic.id}/pages/10`);
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toBe("image/png");
    expect(page.headers["cache-control"]).toMatch(/immutable/);
    const inArchive = await comicEntry(path.join(shelf, "Made Up Saga", "Made Up Saga 001 (2018).cbz"), "scans/page-10.png");
    expect(page.rawPayload.equals(Buffer.from(inArchive))).toBe(true);
    expect(Number(page.headers["content-length"])).toBe(inArchive.length);
    for (const bad of ["0", "13", "x", "1.5", "-1"]) expect((await get(`/api/books/${comic.id}/pages/${bad}`)).statusCode, bad).toBe(404);
    expect((await get(`/api/books/${titled("Red Book").id}/pages/1`)).statusCode).toBe(404);
    expect((await server.app.inject({ method: "GET", url: `/api/books/${comic.id}/pages/1` })).statusCode).toBe(401);
  });

  it("sends the CBZ itself, for a device that keeps books", async () => {
    const comic = titled("Made Up Saga #1");
    const file = await get(`/api/books/${comic.id}/files/book.cbz`);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.length).toBe(comic.sizeBytes);
  });

  it("takes a page as a place, and gives it back, for a device that keeps no log", async () => {
    const comic = titled("Made Up Saga #1");
    expect(((await get(`/api/books/${comic.id}/place`)).json() as { place: unknown }).place).toBeNull();
    const told = await post(`/api/books/${comic.id}/place`, { device: DEVICE, page: 7, why: "periodic" });
    expect(told.statusCode, told.body).toBe(200);
    expect(((await get(`/api/books/${comic.id}/place`)).json() as { place: { page: number; pages: number; from: string } }).place).toMatchObject({ page: 7, pages: 12, from: "reading" });

    // In the log as the desktop's comic reader writes one: the page's entry, its number, under the read edition's claim.
    const log = parseLog((await get("/api/places/export")).body).records;
    expect(log.at(-1)).toMatchObject({ k: "pos", why: "periodic", book: { ids: [`urn:ribbon:${localIdOf(comic)}-text`] }, loc: { href: "scans/page-7.png", type: "image/png", locations: { position: 7 } } });

    for (const bad of [0, 13, 1.5, "7"]) expect((await post(`/api/books/${comic.id}/place`, { device: DEVICE, page: bad, why: "periodic" })).statusCode, String(bad)).toBe(400);
    expect((await post(`/api/books/${titled("Red Book").id}/place`, { device: DEVICE, page: 1, why: "periodic" })).statusCode).toBe(400);
  });

  it("says how far through a comic is, and that it is finished on its last page", async () => {
    const comic = titled("Made Up Saga #1");
    const progress = () => get("/api/progress").then((r) => (r.json() as { books: Record<string, { started: boolean; finished: boolean; fraction: number }> }).books[comic.id]);
    expect(await progress()).toMatchObject({ started: true, finished: false });
    expect((await progress())!.fraction).toBeCloseTo(6 / 11, 3);
    await post(`/api/books/${comic.id}/place`, { device: DEVICE, page: 12, why: "close" });
    expect(await progress()).toMatchObject({ finished: true, fraction: 1 });
  });

  it("counts time with a comic as reading, between two of its pages", async () => {
    const comic = titled("Made Up Saga #1");
    const stretch = { device: DEVICE, start: "2026-11-23T20:00:00.000Z", end: "2026-11-23T20:10:00.000Z", from: 1, to: 12 };
    const kept = await post(`/api/books/${comic.id}/reading`, stretch);
    expect(kept.statusCode, kept.body).toBe(200);
    const log = parseLog((await get("/api/places/export")).body).records;
    expect(log.at(-1)).toMatchObject({ k: "reading", read_ms: 600_000, from: 0, to: 1, book: { ids: [`urn:ribbon:${localIdOf(comic)}-text`] } });
    expect((await post(`/api/books/${comic.id}/reading`, { ...stretch, to: 13 })).statusCode).toBe(400);
  });

  it("is, to a desktop, a comic to download: one file in its folder, with the id it will have there", () => {
    const comic = titled("Made Up Saga #1");
    const remote = remoteBook(comic);
    expect(remote.book).toMatchObject({ comic: `${comic.id}/book.cbz`, pages: 12, fileCount: 0, durationMs: 0 });
    expect(remote.book.ebook).toBeUndefined();
    expect(remote.book.id).toBe(localIdOf(comic));
    // An audiobook's id is unchanged by any of this.
    expect(remoteBook(titled("Red Book")).book.comic).toBeUndefined();
  });
});
