import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rowsToBytes } from "../../src/core/csv.ts";
import { TRANSCRIPT_FIELDS, transcriptRows } from "../../src/core/reading/narration.ts";
import type { ReadAlong } from "../../src/core/reading/readalong.ts";
import { ServerClient } from "../../src/app/server/client.ts";
import type { RibbonServer } from "../src/app.ts";
import { builtTool } from "../src/config.ts";
import type { ListedBook } from "../src/library/books.ts";
import { epub, importAs, mp3, serverWithAdmin } from "./fixture.ts";

const SENTENCES = ["The waygate hung in the void before them.", "It was a giant circle of wraithbone and old light.", "Eluadhri watched the runes along its rim kindle.", "Then the gate opened, and they stepped through."];
/** Where each sentence starts in the text: after the heading's 11 characters, each sentence and a space. */
const AT = SENTENCES.map((_, i) => 11 + SENTENCES.slice(0, i).reduce((n, s) => n + s.length + 1, 0));
/** When the narrator says each one: eighteen seconds apart, near enough each other to mark each one (align.ts, `PRECISE_MS`). */
const SAID_MS = [1000, 19_000, 37_000, 55_000];

/**
 * A book's transcript on the server (docs/SERVER.md, section 9; #152): one
 * a computer with a graphics card made whole, start to end, and sent, kept
 * in place of what the book had. The server transcribes nothing itself,
 * and takes no piece of a transcript: only what was heard at moments of
 * the narration is merged, as before.
 */
describe("transcripts on the server", () => {
  let dir: string;
  let server: RibbonServer;
  let token = "";
  let book: ListedBook;

  beforeAll(async () => {
    const ebookTool = builtTool("ribbon-ebook");
    expect(ebookTool, "build the EPUB tool first: cargo build --manifest-path src-tauri/Cargo.toml -p ribbon-ebook").not.toBeNull();
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-transcripts-"));
    const library = path.join(dir, "library");
    const folder = path.join(library, "An Author", "The Waygate");
    mp3(path.join(folder, "01.mp3"), { title: "The Waygate", album: "The Waygate", artist: "An Author" }, undefined, 70);
    epub(path.join(folder, "The Waygate.epub"), "Chapter One", SENTENCES);
    ({ server, admin: token } = await serverWithAdmin(dir, { ebookTool, framesTool: builtTool("ribbon-frames") }));
    await importAs(server, token, library);
    book = ((await get("/api/books")).json() as { books: ListedBook[] }).books[0]!;
  }, 60_000);
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (url: string) => server.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  const send = (kind: string, csv: string, id = book.id, headers: Record<string, string> = { authorization: `Bearer ${token}` }) =>
    server.app.inject({ method: "POST", url: `/api/books/${id}/records/${kind}`, payload: csv, headers: { ...headers, "content-type": "text/csv" } });
  const record = (kind: string) => readFileSync(path.join(dir, "data", "books", book.id, "records", `${kind}.csv`), "utf8");
  const readAlong = async () => (await get(`/api/books/${book.id}/readalong`)).json() as ReadAlong;
  /** The book's two minutes heard, by `model`, each sentence found where it starts. */
  const whole = (model: string) => ({
    spans: new Map([
      [0, 60_000],
      [60_000, 70_000],
    ]),
    heardBy: new Map([
      [0, model],
      [60_000, model],
    ]),
    said: SENTENCES.map((words, i) => ({ startMs: SAID_MS[i]!, endMs: SAID_MS[i]! + 8000, words, chars: AT[i]! })),
  });

  it("lists every book with how much of its narration is transcribed: none, to begin with", async () => {
    expect((await get("/api/library/transcripts")).json()).toEqual({ books: [{ id: book.id, title: "The Waygate", done: 0, total: 2 }] });
    expect((await readAlong()).ready).toBe(false);
    expect((await server.app.inject({ method: "GET", url: "/api/library/transcripts" })).statusCode).toBe(401);
  });

  it("takes a transcript whole, as the app sends it, and reads along with it", async () => {
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const client = new ServerClient(`http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`, token);
    await client.putTranscript(book.id, await rowsToBytes(transcriptRows(whole("ggml-base-q5_1")), TRANSCRIPT_FIELDS));
    expect(await client.transcripts()).toEqual([{ id: book.id, title: "The Waygate", done: 2, total: 2 }]);
    const sentences = (await readAlong()).blocks.filter((b) => b.k === "p").flatMap((b) => b.sentences ?? []);
    expect(sentences.map((s) => s.ms)).toEqual(SAID_MS);
    expect(sentences.every((s) => s.exact)).toBe(true);
  });

  it("keeps one in place of the last, never merged with it", async () => {
    const csv = await rowsToBytes(transcriptRows(whole("ggml-small-q5_1")), TRANSCRIPT_FIELDS);
    const put = await server.app.inject({ method: "PUT", url: `/api/books/${book.id}/transcript`, payload: Buffer.from(csv), headers: { authorization: `Bearer ${token}`, "content-type": "text/csv" } });
    expect(put.statusCode).toBe(204);
    expect(record("aligned")).toContain("ggml-small-q5_1");
    expect(record("aligned")).not.toContain("ggml-base-q5_1");
  });

  it("refuses one that isn't whole, a piece of one, and one for a book it hasn't", async () => {
    const put = (csv: string, id = book.id) => server.app.inject({ method: "PUT", url: `/api/books/${id}/transcript`, payload: csv, headers: { authorization: `Bearer ${token}`, "content-type": "text/csv" } });
    const first = "start_ms,end_ms,words,chars,heard_by,word_ms\n0,60000,,,ggml-small-q5_1,\n";
    expect((await put(first)).json()).toMatchObject({ missing: 1 });
    expect((await put(first, "0000000000000000")).statusCode).toBe(404);
    expect((await send("aligned", first)).statusCode).toBe(404);
    expect((await server.app.inject({ method: "PUT", url: `/api/books/${book.id}/transcript`, payload: first, headers: { "content-type": "text/csv" } })).statusCode).toBe(401);
    // What it had stays.
    expect(record("aligned")).toContain("ggml-small-q5_1");
  });

  it("merges what a device heard at moments of the narration, leaving out rows that aren't times", async () => {
    expect((await send("heard", "audio_ms,words,chars\n1000,The waygate hung,11\nsoon,Not a time,\n")).json()).toEqual({ kept: 1, refused: 1 });
    expect((await send("heard", "audio_ms,words,chars\n62000,Then the gate opened,\n")).json()).toEqual({ kept: 1, refused: 0 });
    expect(record("heard")).toContain("The waygate hung");
    expect(record("heard")).toContain("Then the gate opened");
    expect(((await get(`/api/books/${book.id}`)).json() as { records: string[] }).records.sort()).toEqual(["aligned", "heard"]);
  });

  it("loses no record when another job writes the book's record without it listed", async () => {
    const file = path.join(dir, "data", "books", book.id, "book.json");
    const stored = JSON.parse(readFileSync(file, "utf8")) as { records: string[] };
    writeFileSync(file, JSON.stringify({ ...stored, records: stored.records.filter((k) => k !== "heard") }));
    await send("heard", "audio_ms,words,chars\n40000,Eluadhri watched,\n");
    expect(record("heard")).toContain("The waygate hung");
    expect((JSON.parse(readFileSync(file, "utf8")) as { records: string[] }).records).toContain("heard");
  });

  it("takes only what was heard, of a book it has, from someone signed in", async () => {
    expect((await send("pairing", "text,audio_ms\n")).statusCode).toBe(404);
    expect((await send("heard", "audio_ms,words,chars\n", "0000000000000000")).statusCode).toBe(404);
    expect((await send("heard", "audio_ms,words,chars\n", book.id, {})).statusCode).toBe(401);
  });
});
