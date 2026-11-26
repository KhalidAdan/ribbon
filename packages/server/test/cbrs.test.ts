import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cbrTool, isRar, openCbr } from "@ribbon/host-node/cbr";
import { comicEntries, comicEntry, openComic } from "@ribbon/host-node/comic";
import { comicInfoXml, madePageName, makeComic, pagePng, type MadeComic } from "@ribbon/host-node/make-comic";
import { makeComicRar } from "@ribbon/host-node/make-cbr";
import { CBR_REFUSALS } from "@ribbon/core/comic/cbr";
import { localIdOf } from "@ribbon/core/server-books";
import type { RibbonServer } from "../src/app.ts";
import type { ListedBook, StoredBook } from "../src/library/books.ts";
import { importAs, serverWithAdmin } from "./fixture.ts";

/**
 * CBRs on the server (docs/COMICS.md, section 13), over CBRs made for the
 * test (make-cbr.ts): one is written out as a CBZ when its folder is
 * added, and from there on it is a comic like any other. A locked one and
 * one part of a split one are left out, each with its sentence.
 *
 * The made CBRs' files are stored, not squeezed; the squeezed kind is the
 * Rust reader's own tests' (packages/desktop/src-tauri/cbr).
 */
describe("CBRs on the server", () => {
  let dir: string;
  let shelf: string;
  let server: RibbonServer;
  let token: string;
  let books: ListedBook[];
  let notes: string;
  const saga: MadeComic = { pages: 12, wide: [4], unpadded: true, folder: "scans", comicInfo: comicInfoXml({ Title: "The Long Way", Series: "Made Up Saga", Number: 2, Writer: "Ada Quill" }), extra: { "__MACOSX/._page-1.png": "x", "notes.txt": "hello" } };
  const get = (url: string) => server.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  const titled = (title: string) => books.find((b) => b.title === title)!;
  const inShelf = (name: string) => path.join(shelf, name);

  beforeAll(async () => {
    expect(cbrTool(), "build the CBR reader first: cargo build --manifest-path packages/desktop/src-tauri/Cargo.toml -p ribbon-cbr").not.toBeNull();
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-cbrs-server-"));
    shelf = path.join(dir, "shelf");
    await makeComicRar(inShelf("The Long Way.cbr"), saga);
    await makeComicRar(inShelf("Old Format 003.cbr"), { pages: 5, folder: "Épisode un" }, { format: "rar4" });
    await makeComicRar(inShelf("Locked New.cbr"), { pages: 3 }, { locked: true });
    await makeComicRar(inShelf("Locked Old.cbr"), { pages: 3 }, { format: "rar4", locked: true });
    await makeComicRar(inShelf("Split New.cbr"), { pages: 3 }, { split: true });
    await makeComicRar(inShelf("Split Old.cbr"), { pages: 3 }, { format: "rar4", split: true });
    await makeComicRar(inShelf("No Pictures.cbr"), { pages: 0, extra: { "notes.txt": "nothing to read" } });
    // A zip under a CBR's name, as many are, and a RAR under a CBZ's.
    await makeComic(inShelf("Really A Zip 007.cbr"), { pages: 4 });
    await makeComicRar(inShelf("made.tmp"), { pages: 2 });
    copyFileSync(inShelf("made.tmp"), inShelf("Really A Rar 008.cbz"));
    await rm(inShelf("made.tmp"));
    const made = await serverWithAdmin(dir);
    server = made.server;
    token = made.admin;
    const added = await importAs(server, token, shelf);
    expect(added.status).toBe(202);
    notes = JSON.stringify(added.job.progress);
    books = ((await get("/api/books")).json() as { books: ListedBook[] }).books;
  }, 60_000);

  afterAll(async () => {
    await server.app.close();
    server.db.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("reads a made CBR as the comic it was made from, in the new format and the old", async () => {
    for (const how of [{ file: "The Long Way.cbr", comic: saga }, { file: "Old Format 003.cbr", comic: { pages: 5, folder: "Épisode un" } }]) {
      expect(await isRar(inShelf(how.file))).toBe(true);
      const entries = await comicEntries(inShelf(how.file));
      const pages = Array.from({ length: how.comic.pages }, (_, i) => madePageName(how.comic, i));
      // Folders parted by a slash, whichever way the archive wrote them, and every size said.
      expect(entries.map((e) => e.name).filter((n) => n.endsWith(".png") && !n.startsWith("__"))).toEqual(pages);
      expect(entries.every((e) => typeof e.size === "number" && e.size === e.packed)).toBe(true);
      const second = await comicEntry(inShelf(how.file), pages[1]!);
      expect(Buffer.from(second).equals(Buffer.from(pagePng(2, 200, 300)))).toBe(true);
    }
    const cbr = await openCbr(inShelf("The Long Way.cbr"));
    expect(() => cbr.source("scans/page-99.png")).toThrow(/no such page/);
  });

  it("lists a CBR as a comic like any other, with its details and its cover", () => {
    expect(books.map((b) => b.title).sort()).toEqual(["Made Up Saga #2: The Long Way", "Old Format #3", "Really A Rar #8", "Really A Zip #7"]);
    expect(titled("Made Up Saga #2: The Long Way")).toMatchObject({ comic: true, pages: 12, author: "Ada Quill", series: "Made Up Saga", seriesIndex: 2, audio: false, ebook: false });
    expect(titled("Old Format #3")).toMatchObject({ comic: true, pages: 5 });
    expect(titled("Really A Zip #7")).toMatchObject({ comic: true, pages: 4 });
    expect(titled("Really A Rar #8")).toMatchObject({ comic: true, pages: 2 });
    expect(titled("Made Up Saga #2: The Long Way").cover).not.toBeNull();
  });

  it("keeps it as a CBZ of the same files, none squeezed, and nothing else", async () => {
    const comic = titled("Made Up Saga #2: The Long Way");
    const folder = path.join(dir, "data", "books", comic.id);
    expect(readdirSync(folder).sort()).toEqual(["book.cbz", "book.json", "covers"]);
    const kept = await openComic(path.join(folder, "book.cbz"));
    try {
      const made = await comicEntries(inShelf("The Long Way.cbr"));
      expect(kept.entries.map((e) => [e.name, e.size, e.packed])).toEqual(made.map((e) => [e.name, e.size, e.size]));
    } finally {
      await kept.close();
    }
    const stored = (await get(`/api/books/${comic.id}`)).json() as StoredBook;
    expect(stored.book).toMatchObject({ comic: "book.cbz", pages: 12 });
    expect(stored.pages!.slice(0, 2)).toEqual([
      { name: "scans/page-1.png", width: 200, height: 300 },
      { name: "scans/page-2.png", width: 200, height: 300 },
    ]);
    expect(stored.pages![9]!.name).toBe("scans/page-10.png");
    expect(stored.pages![4]).toMatchObject({ width: 400, height: 300 });
  });

  it("sends its pages and its file as a CBZ's are sent, so no device needs to read a RAR", async () => {
    const comic = titled("Made Up Saga #2: The Long Way");
    const page = await get(`/api/books/${comic.id}/pages/10`);
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toBe("image/png");
    expect(page.rawPayload.equals(Buffer.from(pagePng(10, 200, 300)))).toBe(true);
    // The fifth was drawn across two.
    expect((await get(`/api/books/${comic.id}/pages/5`)).rawPayload.equals(Buffer.from(pagePng(5, 400, 300)))).toBe(true);

    // A device that keeps books is sent the CBZ, and knows the comic by that file's size.
    const file = await get(`/api/books/${comic.id}/files/book.cbz`);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.subarray(0, 2).toString("latin1")).toBe("PK");
    const keptBytes = statSync(path.join(dir, "data", "books", comic.id, "book.cbz")).size;
    expect(comic.sizeBytes).toBe(keptBytes);
    expect(file.rawPayload.length).toBe(keptBytes);
    expect(localIdOf(comic)).toMatch(/^[0-9a-f-]+$/i);
  });

  it("leaves out a locked CBR, one part of a split one and one with no pages, each with its sentence", () => {
    for (const left of ["Locked New", "Locked Old", "Split New", "Split Old", "No Pictures"]) expect(books.some((b) => b.title === left), left).toBe(false);
    const said = (title: string) => (JSON.parse(notes) as { notes: string[] }).notes.find((n) => n.startsWith(`${title}:`));
    expect(said("Locked New")).toContain(CBR_REFUSALS.locked);
    expect(said("Locked Old")).toContain(CBR_REFUSALS.locked);
    expect(said("Split New")).toContain(CBR_REFUSALS.split);
    expect(said("Split Old")).toContain(CBR_REFUSALS.split);
    expect(said("No Pictures")).toMatch(/no pages/);
    // Nothing of them is left on the server.
    expect(readdirSync(path.join(dir, "data", "books")).length).toBe(books.length);
  });

  it("never adds a CBR twice", async () => {
    await importAs(server, token, shelf);
    const again = ((await get("/api/books")).json() as { books: ListedBook[] }).books;
    expect(again.map((b) => b.id).sort()).toEqual(books.map((b) => b.id).sort());
  });
});
