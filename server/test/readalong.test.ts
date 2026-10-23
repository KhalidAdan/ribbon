import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookId } from "../../src/core/bookid.ts";
import type { ReadAlong } from "../../src/core/reading/readalong.ts";
import { localIdOf } from "../../src/core/server-books.ts";
import type { RibbonServer } from "../src/app.ts";
import { builtEbookTool } from "../src/config.ts";
import type { ListedBook } from "../src/library/books.ts";
import { epub, importAs, mp3, serverWithAdmin } from "./fixture.ts";

const SENTENCES = ["The first sentence is here.", "A second one follows it.", "The third ends the chapter."];

/**
 * Read-along for a device that only draws and plays (the Apple TV): a
 * book's text with when each sentence is read, from the EPUB and the
 * transcript that came in with it, and the person's place in it as a
 * sentence.
 */
describe("read-along from the server", () => {
  let dir: string;
  let server: RibbonServer;
  let token = "";
  let book: ListedBook;
  const tv = { id: "urn:uuid:7b1e4c1a-3f0d-4d55-9a8e-2c4f6b0d9e11", name: "Ribbon on the living room TV" };
  const phone = { id: "urn:uuid:0c3d2e1f-9a8b-4c7d-8e6f-5a4b3c2d1e0f", name: "Ribbon on an iPhone" };

  beforeAll(async () => {
    const tool = builtEbookTool();
    expect(tool, "build the EPUB tool first: cargo build --manifest-path src-tauri/Cargo.toml -p ribbon-ebook").not.toBeNull();
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-readalong-"));
    const library = path.join(dir, "library");
    const folder = path.join(library, "An Author", "Read Along");
    mp3(path.join(folder, "01.mp3"), { title: "Read Along", album: "Read Along", artist: "An Author" }, undefined, 12);
    epub(path.join(folder, "Read Along.epub"), "Chapter One", SENTENCES);
    // The narration transcribed on a desktop, each phrase found in the text: the heading is 11 characters, then the sentences.
    const id = bookId("An Author/Read Along", statSync(path.join(folder, "01.mp3")).size);
    mkdirSync(path.join(library, ".ribbon", "aligned"), { recursive: true });
    writeFileSync(path.join(library, ".ribbon", "aligned", `${id}.csv`), "start_ms,end_ms,words,chars\n0,12000,,\n1000,3900,The first sentence is here,11\n4000,7900,A second one follows it,39\n8000,11500,The third ends the chapter,64\n");
    const made = await serverWithAdmin(dir, { ebookTool: tool });
    server = made.server;
    token = made.admin;
    await importAs(server, token, library);
    book = ((await get("/api/books")).json() as { books: ListedBook[] }).books[0]!;
  }, 60_000);
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (url: string, headers: Record<string, string> = {}) => server.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}`, ...headers } });
  const post = (url: string, payload: object) => server.app.inject({ method: "POST", url, payload, headers: { authorization: `Bearer ${token}` } });

  it("asks for a sign-in", async () => {
    for (const url of [`/api/books/${book.id}/readalong`, `/api/books/${book.id}/place`]) expect((await server.app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect((await server.app.inject({ method: "POST", url: `/api/books/${book.id}/place`, payload: {} })).statusCode).toBe(401);
  });

  it("gives the book's text with when each sentence is read, exact where the narration was transcribed", async () => {
    const r = await get(`/api/books/${book.id}/readalong`);
    expect(r.statusCode).toBe(200);
    const readAlong = r.json() as ReadAlong;
    expect(readAlong.blocks.map((b) => b.k)).toEqual(["h", "p"]);
    expect(readAlong.contents).toEqual([{ title: "Chapter One", block: 0 }]);
    const sentences = readAlong.blocks[1]!.sentences!;
    expect(sentences.map((s) => s.ms)).toEqual([1000, 4000, 8000]);
    expect(sentences.every((s) => s.exact)).toBe(true);

    // Asked again, nothing has changed: a bare 304.
    const again = await get(`/api/books/${book.id}/readalong`, { "if-none-match": r.headers.etag as string });
    expect(again.statusCode).toBe(304);
  });

  it("keeps a device's place in the book in its position log, under the book's id on every device", async () => {
    expect((await get(`/api/books/${book.id}/place`)).json()).toEqual({ place: null });
    const written = await post(`/api/books/${book.id}/place`, { device: tv, ms: 4500, why: "pause" });
    expect(written.json()).toEqual({ added: 1 });
    expect((await get(`/api/books/${book.id}/place`)).json()).toMatchObject({ place: { sentence: 2, ms: 4500, from: "listening" } });

    const { records } = (await get("/api/places")).json() as { records: { dev: string; book: { ids: string[] }; ms: number; seq: number }[] };
    const mine = records.filter((r) => r.dev === tv.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.book.ids).toContain(`urn:ribbon:${localIdOf(book)}`);
    // The next record from the same device goes past the last.
    await post(`/api/books/${book.id}/place`, { device: tv, ms: 5000, why: "periodic" });
    const next = ((await get("/api/places")).json() as { records: { dev: string; seq: number }[] }).records.filter((r) => r.dev === tv.id);
    expect(next[1]!.seq).toBeGreaterThan(next[0]!.seq);
  });

  it("opens where a phone was last reading, at the sentence it was on", async () => {
    const reading = {
      v: 1,
      k: "pos",
      dev: phone.id,
      seq: Date.now() + 1000,
      t: new Date(Date.now() + 1000).toISOString(),
      book: { ids: [`urn:ribbon:${localIdOf(book)}-text`] },
      why: "close",
      loc: { href: "OEBPS/one.xhtml", type: "application/xhtml+xml", locations: { progression: 0.7, totalProgression: 0.7 }, text: { highlight: "The third ends the chapter." } },
    };
    expect((await post("/api/places", { device: phone, records: [reading] })).json()).toMatchObject({ added: 1 });
    expect((await get(`/api/books/${book.id}/place`)).json()).toMatchObject({ place: { sentence: 3, ms: 8000, from: "reading" } });
  });

  it("refuses a place it can't keep", async () => {
    expect((await post(`/api/books/${book.id}/place`, { device: tv, ms: -1, why: "pause" })).statusCode).toBe(400);
    expect((await post(`/api/books/${book.id}/place`, { device: tv, ms: 1000, why: "remote" })).statusCode).toBe(400);
    expect((await post(`/api/books/${book.id}/place`, { device: { id: "my-tv" }, ms: 1000, why: "pause" })).statusCode).toBe(400);
    expect((await post(`/api/books/0123456789abcdef/place`, { device: tv, ms: 1000, why: "pause" })).statusCode).toBe(404);
  });
});

describe("read-along on a server without the EPUB tool", () => {
  it("says the server can't, rather than failing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ribbon-readalong-none-"));
    const folder = path.join(dir, "library", "Read Along");
    mp3(path.join(folder, "01.mp3"), { title: "Read Along", album: "Read Along", artist: "An Author" });
    epub(path.join(folder, "Read Along.epub"), "Chapter One", SENTENCES);
    const { server, admin } = await serverWithAdmin(dir, { ebookTool: null });
    await importAs(server, admin, path.join(dir, "library"));
    const id = server.books.list()[0]!.id;
    const r = await server.app.inject({ method: "GET", url: `/api/books/${id}/readalong`, headers: { authorization: `Bearer ${admin}` } });
    expect(r.statusCode).toBe(503);
    expect((r.json() as { error: string }).error).toMatch(/ribbon-ebook/);
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
