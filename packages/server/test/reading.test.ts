import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReadAlong } from "@ribbon/core/reading/readalong";
import { localIdOf } from "@ribbon/core/server-books";
import type { RibbonServer } from "../src/app.ts";
import { builtTool } from "../src/config.ts";
import type { ListedBook } from "../src/library/books.ts";
import { epub, importAs, mp3, serverWithAdmin } from "./fixture.ts";

const SENTENCES = ["The first sentence is here.", "A second one follows it.", "The third ends the chapter."];
const ONLY_TEXT = ["The lamp was lit at dusk.", "Nobody came to the door.", "By morning the sea was calm."];

/**
 * Reading on a device that only draws and plays (the iPhone, the iPad, the
 * TV): a book that is only its text, read there, and a reading place kept
 * from there, as the desktop's reader keeps one, so every device opens at
 * it and listening carries on from it.
 */
describe("reading on a device that keeps no log", () => {
  let dir: string;
  let server: RibbonServer;
  let token = "";
  let narrated: ListedBook;
  let text: ListedBook;
  const phone = { id: "urn:uuid:0c3d2e1f-9a8b-4c7d-8e6f-5a4b3c2d1e0f", name: "Ribbon on an iPhone" };

  beforeAll(async () => {
    const tool = builtTool("ribbon-ebook");
    expect(tool, "build the EPUB tool first: cargo build --manifest-path packages/desktop/src-tauri/Cargo.toml -p ribbon-ebook").not.toBeNull();
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-reading-"));
    const library = path.join(dir, "library");
    const folder = path.join(library, "An Author", "Read Along");
    mp3(path.join(folder, "01.mp3"), { title: "Read Along", album: "Read Along", artist: "An Author" }, undefined, 12);
    epub(path.join(folder, "Read Along.epub"), "Chapter One", SENTENCES);
    epub(path.join(library, "The Lamp.epub"), "The Lamp", ONLY_TEXT);
    const made = await serverWithAdmin(dir, { ebookTool: tool, framesTool: builtTool("ribbon-frames") });
    server = made.server;
    token = made.admin;
    await importAs(server, token, library);
    const books = ((await get("/api/books")).json() as { books: ListedBook[] }).books;
    narrated = books.find((b) => b.audio)!;
    text = books.find((b) => !b.audio)!;
  }, 60_000);
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (url: string) => server.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  const post = (url: string, payload: object) => server.app.inject({ method: "POST", url, payload, headers: { authorization: `Bearer ${token}` } });

  it("gives a book that is only its text, to read, with nothing read aloud", async () => {
    expect(text).toMatchObject({ audio: false, ebook: true });
    const r = await get(`/api/books/${text.id}/readalong`);
    expect(r.statusCode).toBe(200);
    const readAlong = r.json() as ReadAlong;
    expect(readAlong).toMatchObject({ ready: false, transcribed: { done: 0, total: 0 } });
    const sentences = readAlong.blocks.flatMap((b) => b.sentences ?? []);
    expect(sentences.length).toBeGreaterThanOrEqual(ONLY_TEXT.length);
    expect(sentences.every((s) => s.ms === 0 && s.endMs === 0 && !s.exact)).toBe(true);
  });

  it("keeps a reading place in a book that is only its text, and says how far through it is", async () => {
    expect((await get("/api/progress")).json()).toEqual({ books: {} });
    expect((await post(`/api/books/${text.id}/place`, { device: phone, sentence: 3, why: "periodic" })).json()).toEqual({ added: 1 });
    expect((await get(`/api/books/${text.id}/place`)).json()).toMatchObject({ place: { sentence: 3, ms: 0, from: "reading" } });
    const progress = ((await get("/api/progress")).json() as { books: Record<string, { started: boolean; finished: boolean; fraction: number }> }).books[text.id]!;
    expect(progress).toMatchObject({ started: true, finished: false });
    expect(progress.fraction).toBeGreaterThan(0);
    // In the phone's log as the desktop's reader writes one: a place in the text, under the text's own claim.
    type Pos = { k: string; dev: string; loc?: { href: string }; book: { ids: string[] } };
    const kept = ((await get("/api/places")).json() as { records: Pos[] }).records.filter((r) => r.k === "pos" && r.loc);
    expect(kept.at(-1)).toMatchObject({ dev: phone.id, book: { ids: expect.arrayContaining([`urn:ribbon:${localIdOf(text)}-text`]) } });
  });

  it("keeps a reading place in a narrated book, newer than where it was listened to, with where it's read as a hint", async () => {
    expect((await post(`/api/books/${narrated.id}/place`, { device: phone, ms: 1000, why: "pause" })).json()).toEqual({ added: 1 });
    expect((await post(`/api/books/${narrated.id}/place`, { device: phone, sentence: 3, why: "periodic" })).json()).toEqual({ added: 1 });
    const { place } = (await get(`/api/books/${narrated.id}/place`)).json() as { place: { sentence: number; ms: number; from: string } };
    expect(place).toMatchObject({ sentence: 3, from: "reading" });
    expect(place.ms).toBeGreaterThan(1000);
    type Pos = { k: string; loc?: object; x?: Record<string, { ms: number; how: string }> };
    const kept = ((await get("/api/places")).json() as { records: Pos[] }).records.filter((r) => r.k === "pos" && r.loc);
    expect(kept.at(-1)!.x!["urn:ribbon:audio"]).toMatchObject({ ms: place.ms });
  });

  it("refuses a sentence it doesn't have, and bookmarks words in a book with nothing read aloud without a moment", async () => {
    expect((await post(`/api/books/${text.id}/place`, { device: phone, sentence: 999, why: "periodic" })).statusCode).toBe(400);
    expect((await post(`/api/books/${text.id}/place`, { device: phone, sentence: -1, why: "periodic" })).statusCode).toBe(400);
    const made = (await post(`/api/books/${text.id}/bookmarks`, { device: phone, first: 2, last: 2 })).json() as { bookmark: { ms: number | null; quote: string } };
    expect(made.bookmark).toMatchObject({ ms: null, quote: "Nobody came to the door." });
    expect((await post(`/api/books/${text.id}/bookmarks`, { device: phone, ms: 1000 })).statusCode).toBe(400);
  });

  it("finds a line in a book that is only its text", async () => {
    const { results } = (await get(`/api/search?q=${encodeURIComponent("nobody came to the door")}`)).json() as { results: { book: string; ms: number }[] };
    expect(results[0]).toMatchObject({ book: text.id, ms: 0 });
  });


  it("says the speed a book was last heard at, on any device, for a device to open it at", async () => {
    const stretch = { device: phone, start: "2026-11-02T20:00:00.000Z", end: "2026-11-02T20:05:00.000Z", fromMs: 0, toMs: 9000, speed: 1.5 };
    expect((await post(`/api/books/${narrated.id}/listened`, stretch)).statusCode).toBe(200);
    const progress = ((await get("/api/progress")).json() as { books: Record<string, { speed?: number; speedAt?: string }> }).books[narrated.id];
    expect(progress).toMatchObject({ speed: 1.5, speedAt: "2026-11-02T20:05:00.000Z" });
  });


  it("counts the listening as the desktop's Stats counts it, on the device's own days", async () => {
    const r = await get("/api/stats?tz=300");
    expect(r.statusCode).toBe(200);
    const stats = r.json() as { totals: { totalMs: number; sessions: number }; days: number[][]; books: { book: string; ms: number }[]; authors: { name: string; ms: number }[]; finished: unknown[] };
    // The five minutes at 1.5x kept a moment ago.
    expect(stats.totals).toMatchObject({ totalMs: 300_000, sessions: 1 });
    expect(stats.days.length).toBe(53);
    expect(stats.books).toEqual([{ book: narrated.id, ms: 300_000 }]);
    expect(stats.authors).toEqual([{ name: "An Author", ms: 300_000 }]);
    expect((await server.app.inject({ method: "GET", url: "/api/stats" })).statusCode).toBe(401);
  });
});
