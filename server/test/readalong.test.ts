import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookId } from "../../src/core/bookid.ts";
import type { ReadAlong } from "../../src/core/reading/readalong.ts";
import { localIdOf } from "../../src/core/server-books.ts";
import type { RibbonServer } from "../src/app.ts";
import { builtTool } from "../src/config.ts";
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
    const tool = builtTool("ribbon-ebook");
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
    const made = await serverWithAdmin(dir, { ebookTool: tool, framesTool: builtTool("ribbon-frames") });
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

  it("says how far the person is through each book, for a library that keeps no log", async () => {
    const { books } = (await get("/api/progress")).json() as { books: Record<string, { ms: number; started: boolean; finished: boolean }> };
    expect(books[book.id]).toMatchObject({ ms: 5000, started: true, finished: false });
    // Within the last stretch of a book, it's finished.
    await post(`/api/books/${book.id}/place`, { device: tv, ms: 11_500, why: "end" });
    expect(((await get("/api/progress")).json() as { books: Record<string, { finished: boolean }> }).books[book.id]!.finished).toBe(true);
    await post(`/api/books/${book.id}/place`, { device: tv, ms: 5000, why: "seek" });
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

  it("bookmarks whole sentences as the desktop bookmarks words selected in its reader, and takes them back", async () => {
    const del = (url: string, payload: object) => server.app.inject({ method: "DELETE", url, payload, headers: { authorization: `Bearer ${token}` } });
    expect((await get(`/api/books/${book.id}/bookmarks`)).json()).toEqual({ bookmarks: [] });
    const made = await post(`/api/books/${book.id}/bookmarks`, { device: tv, first: 2, last: 3 });
    expect(made.statusCode).toBe(200);
    const { bookmark } = made.json() as { bookmark: { id: string } };
    const quote = "A second one follows it. The third ends the chapter.";
    expect(bookmark).toMatchObject({ ms: 4000, note: "", quote, first: 2, last: 3 });

    // In the TV's log as the desktop's reader writes one (docs/POSITION-FORMAT.md, section 3.4), so every app shows it.
    type Mark = { k: string; dev: string; id: string; motivation: string; target: { ms: number; text: { quote: string } }; book: { ids: string[] } };
    const mark = ((await get("/api/places")).json() as { records: Mark[] }).records.find((r) => r.k === "mark");
    expect(mark).toMatchObject({ dev: tv.id, id: bookmark.id, motivation: "bookmarking", target: { ms: 4000, text: { quote } } });
    expect(mark!.book.ids).toContain(`urn:ribbon:${localIdOf(book)}`);

    // The same sentences bookmarked on another device are the same bookmark.
    const again = (await post(`/api/books/${book.id}/bookmarks`, { device: phone, first: 2, last: 3 })).json() as { bookmark: { id: string } };
    expect(again.bookmark.id).toBe(bookmark.id);
    expect((await get(`/api/books/${book.id}/bookmarks`)).json()).toMatchObject({ bookmarks: [{ id: bookmark.id, first: 2, last: 3, quote }] });

    const url = `/api/books/${book.id}/bookmarks/${encodeURIComponent(bookmark.id)}`;
    expect((await del(url, { device: tv })).json()).toEqual({ deleted: bookmark.id });
    expect((await get(`/api/books/${book.id}/bookmarks`)).json()).toEqual({ bookmarks: [] });
    expect((await del(url, { device: tv })).statusCode).toBe(404);
  });

  it("refuses a bookmark it can't make", async () => {
    expect((await post(`/api/books/${book.id}/bookmarks`, { device: tv, first: 3, last: 2 })).statusCode).toBe(400);
    expect((await post(`/api/books/${book.id}/bookmarks`, { device: tv, first: 3, last: 9 })).statusCode).toBe(400);
    expect((await post(`/api/books/${book.id}/bookmarks`, { device: { id: "my-tv" }, first: 1, last: 1 })).statusCode).toBe(400);
    expect((await post(`/api/books/0123456789abcdef/bookmarks`, { device: tv, first: 1, last: 1 })).statusCode).toBe(404);
    expect((await server.app.inject({ method: "GET", url: `/api/books/${book.id}/bookmarks` })).statusCode).toBe(401);
  });
});

describe("read-along on a server without its commands", () => {
  /** A server with one book of an MP3 and an EPUB, and these commands. */
  const answer = async (tools: { ebookTool: string | null; framesTool: string | null }) => {
    const dir = mkdtempSync(path.join(tmpdir(), "ribbon-readalong-none-"));
    const folder = path.join(dir, "library", "Read Along");
    mp3(path.join(folder, "01.mp3"), { title: "Read Along", album: "Read Along", artist: "An Author" });
    epub(path.join(folder, "Read Along.epub"), "Chapter One", SENTENCES);
    const { server, admin } = await serverWithAdmin(dir, tools);
    await importAs(server, admin, path.join(dir, "library"));
    const id = server.books.list()[0]!.id;
    const r = await server.app.inject({ method: "GET", url: `/api/books/${id}/readalong`, headers: { authorization: `Bearer ${admin}` } });
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
    return { status: r.statusCode, error: (r.json() as { error: string }).error };
  };

  it("says it can't read EPUBs, rather than failing", async () => {
    const r = await answer({ ebookTool: null, framesTool: builtTool("ribbon-frames") });
    expect(r.status).toBe(503);
    expect(r.error).toMatch(/ribbon-ebook/);
  }, 60_000);

  it("says it can't send an MP3 from a moment, rather than letting the narration run out of step", async () => {
    const r = await answer({ ebookTool: builtTool("ribbon-ebook"), framesTool: null });
    expect(r.status).toBe(503);
    expect(r.error).toMatch(/ribbon-frames/);
  }, 60_000);
});
