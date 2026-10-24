import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { epub, importAs, mp3, serverWithAdmin, speechStandIn } from "./fixture.ts";

const SENTENCES = [
  "The waygate hung in the void before them.",
  "It was a giant circle of wraithbone and old light.",
  "Eluadhri watched the runes along its rim kindle.",
  "Jurilan did not answer her at once.",
  "Somewhere beyond, the webway waited for them all.",
  "It was older than any of them, and patient.",
  "The first of the runes went dark again.",
  "Then the gate opened, and they stepped through.",
];
/** Where each sentence starts in the text: after the heading's 11 characters, each sentence and a space. */
const AT = SENTENCES.map((_, i) => 11 + SENTENCES.slice(0, i).reduce((n, s) => n + s.length + 1, 0));
/** When the narrator says each one: nine seconds apart, the last in the book's second minute. */
const SAID_MS = [1000, 10_000, 19_000, 28_000, 37_000, 46_000, 55_000, 62_000];

/**
 * Getting the narration's transcript onto the server (docs/SERVER.md,
 * section 9), so a device that only draws and plays reads along to the
 * sentence: the server hears what nobody has yet, and a device sends what
 * it heard. Either way it's merged into the book's own, and a stretch
 * transcribed once is never heard again.
 */
describe("transcripts on the server", () => {
  let dir: string;
  let server: RibbonServer;
  let token = "";
  let book: ListedBook;
  let asked = "";
  let library = "";

  beforeAll(async () => {
    const ebookTool = builtTool("ribbon-ebook");
    expect(ebookTool, "build the EPUB tool first: cargo build --manifest-path src-tauri/Cargo.toml -p ribbon-ebook").not.toBeNull();
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-transcripts-"));
    library = path.join(dir, "library");
    const folder = path.join(library, "An Author", "The Waygate");
    mp3(path.join(folder, "01.mp3"), { title: "The Waygate", album: "The Waygate", artist: "An Author" }, undefined, 70);
    epub(path.join(folder, "The Waygate.epub"), "Chapter One", SENTENCES);
    // The first minute heard as the narrator says it; the second unreadable, as a file ffmpeg can't read.
    const said = SENTENCES.slice(0, 7).map((words, i) => ({ startMs: SAID_MS[i]!, endMs: SAID_MS[i]! + 8000, words: ` ${words}` }));
    const speech = speechStandIn(dir, { 0: said });
    asked = speech.asked;
    const model = path.join(dir, "ggml-base-q5_1.bin");
    writeFileSync(model, "a model");
    const made = await serverWithAdmin(dir, { ebookTool, framesTool: builtTool("ribbon-frames"), speech: { tool: speech.tool, model, threads: 1 } });
    server = made.server;
    token = made.admin;
    await importAs(server, token, library);
    await server.jobs.idle("speech");
    book = ((await get("/api/books")).json() as { books: ListedBook[] }).books[0]!;
  }, 60_000);
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const auth = () => ({ authorization: `Bearer ${token}` });
  const get = (url: string) => server.app.inject({ method: "GET", url, headers: auth() });
  const send = (kind: string, csv: string, id = book.id, headers: Record<string, string> = auth()) => server.app.inject({ method: "POST", url: `/api/books/${id}/records/${kind}`, payload: csv, headers: { ...headers, "content-type": "text/csv" } });
  const record = (kind: string) => readFileSync(path.join(dir, "data", "books", book.id, "records", `${kind}.csv`), "utf8");
  const sentences = async () => ((await get(`/api/books/${book.id}/readalong`)).json() as ReadAlong).blocks[1]!.sentences!;
  const asks = () => readFileSync(asked, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args?: string[]; clips?: { path: string; startMs: number }[] });

  it("hears the narration a minute at a time, with the book's own model and language, behind everything else", () => {
    const [start, ...batches] = asks();
    expect(start!.args).toEqual([path.join(dir, "ggml-base-q5_1.bin"), "60", "en", "1", "1"]);
    expect(batches.map((b) => b.clips!.map((c) => c.startMs))).toEqual([[0, 60_000]]);
    expect(batches[0]!.clips![0]!.path).toBe(path.join(dir, "data", "books", book.id, "audio", "01.mp3"));
  });

  it("places each phrase heard in the text, and keeps it as the book's transcript", async () => {
    const rows = record("aligned").trim().split("\n");
    expect(rows[0]).toBe("start_ms,end_ms,words,chars");
    expect(rows[1]).toBe("0,60000,,");
    expect(rows.slice(2).map((r) => Number(r.split(",").at(-1)))).toEqual(AT.slice(0, 7));
    const read = await sentences();
    expect(read.slice(0, 7).map((s) => s.ms)).toEqual(SAID_MS.slice(0, 7));
    expect(read.slice(0, 7).every((s) => s.exact)).toBe(true);
  });

  it("leaves a stretch it couldn't hear for another time, rather than marking it done", () => {
    expect(record("aligned")).not.toContain("60000,70000");
  });

  it("takes what a device heard, merged with what it has, and leaves out rows that aren't times", async () => {
    const r = await send("aligned", `start_ms,end_ms,words,chars\n60000,70000,,\n${SAID_MS[7]},69000,"${SENTENCES[7]}",${AT[7]}\nsoon,later,Not a time,\n`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ kept: 2, refused: 1 });
    expect(record("aligned")).toContain("0,60000,,");
    expect(record("aligned")).toContain("60000,70000,,");
    expect((await sentences())[7]!.ms).toBe(SAID_MS[7]);
    // What was heard at a chapter's opening comes the same way, and joins the book's records.
    expect((await send("heard", "audio_ms,words,chars\n1000,The waygate hung,11\n")).json()).toEqual({ kept: 1, refused: 0 });
    expect(((await get(`/api/books/${book.id}`)).json() as { records: string[] }).records.sort()).toEqual(["aligned", "heard"]);
  });

  it("takes it as the app sends it, over HTTP", async () => {
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const client = new ServerClient(`http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`, token);
    const said = [{ startMs: 63_000, endMs: 64_000, words: "and they stepped through", chars: AT[7]! + 24 }];
    await client.sendRecord(book.id, "aligned", await rowsToBytes(transcriptRows({ spans: new Map(), said }), TRANSCRIPT_FIELDS));
    expect(record("aligned")).toContain("63000,64000,and they stepped through,");
  });

  it("loses nothing when another job writes the book's record without the transcript in it", async () => {
    const file = path.join(dir, "data", "books", book.id, "book.json");
    const stored = JSON.parse(readFileSync(file, "utf8")) as { records: string[] };
    writeFileSync(file, JSON.stringify({ ...stored, records: stored.records.filter((k) => k !== "aligned") }));
    await send("aligned", "start_ms,end_ms,words,chars\n64000,65000,stepped through,\n");
    expect(record("aligned")).toContain("0,60000,,");
    expect(record("aligned")).toContain("64000,65000,stepped through,");
    expect((JSON.parse(readFileSync(file, "utf8")) as { records: string[] }).records).toContain("aligned");
  });

  it("never hears a stretch again once it's transcribed, here or on a device", async () => {
    const before = asks().length;
    await importAs(server, token, library);
    await server.jobs.idle("speech");
    expect(asks().length).toBe(before);
  });

  it("takes only what was heard, of a book it has, from someone signed in", async () => {
    expect((await send("pairing", "text,audio_ms\n")).statusCode).toBe(404);
    expect((await send("aligned", "start_ms,end_ms,words,chars\n", "0000000000000000")).statusCode).toBe(404);
    expect((await send("aligned", "start_ms,end_ms,words,chars\n", book.id, {})).statusCode).toBe(401);
    expect(existsSync(path.join(dir, "data", "books", book.id, "records", "pairing.csv"))).toBe(false);
  });
});
