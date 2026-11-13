import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rowsToBytes } from "@ribbon/core/csv";
import { TRANSCRIPT_FIELDS, transcriptRows } from "@ribbon/core/reading/narration";
import type { ReadAlong } from "@ribbon/core/reading/readalong";
import type { RibbonServer } from "../src/app.ts";
import { builtTool } from "../src/config.ts";
import type { ListedBook } from "../src/library/books.ts";
import { epub, importAs, mp3, serverWithAdmin } from "./fixture.ts";

const SENTENCES = ["The waygate hung in the void before them.", "It was a giant circle of wraithbone and old light.", "Eluadhri watched the runes along its rim kindle.", "Then the gate opened, and they stepped through."];
/** Where each sentence starts in the text: after the heading's 11 characters, each sentence and a space. */
const AT = SENTENCES.map((_, i) => 11 + SENTENCES.slice(0, i).reduce((n, s) => n + s.length + 1, 0));
/** When the narrator says each one: near enough each other to mark each one (align.ts, `PRECISE_MS`). */
const SAID_MS = [1000, 19_000, 37_000, 55_000];

/**
 * Read-along turned off for one book by the admin (packages/core/src/edits.ts,
 * `readAlong`), for a book where it will never work. It's one of the
 * book's edits, so it's saved and listed as they are. While it's off, the
 * read-along every device is given says so and marks no sentence, and the
 * book is left out of the list a computer with a graphics card transcribes
 * from. Nothing is deleted: its transcript stays, and turned back on, the
 * book reads along as before.
 */
describe("read-along turned off for a book, on the server", () => {
  let dir: string;
  let server: RibbonServer;
  let admin = "";
  let book: ListedBook;

  beforeAll(async () => {
    const ebookTool = builtTool("ribbon-ebook");
    expect(ebookTool, "build the EPUB tool first: cargo build --manifest-path packages/desktop/src-tauri/Cargo.toml -p ribbon-ebook").not.toBeNull();
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-readalong-off-"));
    const library = path.join(dir, "library");
    const folder = path.join(library, "An Author", "The Waygate");
    mp3(path.join(folder, "01.mp3"), { title: "The Waygate", album: "The Waygate", artist: "An Author" }, undefined, 70);
    epub(path.join(folder, "The Waygate.epub"), "Chapter One", SENTENCES);
    ({ server, admin } = await serverWithAdmin(dir, { ebookTool, framesTool: builtTool("ribbon-frames") }));
    await importAs(server, admin, library);
    book = ((await get("/api/books")).json() as { books: ListedBook[] }).books[0]!;
  }, 60_000);
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (url: string) => server.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${admin}` } });
  const edit = (values: Record<string, string>) => server.app.inject({ method: "PUT", url: `/api/books/${book.id}/edits`, payload: { values }, headers: { authorization: `Bearer ${admin}` } });
  const listed = async () => ((await get("/api/books")).json() as { books: ListedBook[] }).books[0]!;
  const readAlong = async () => (await get(`/api/books/${book.id}/readalong`)).json() as ReadAlong;
  const toTranscribe = async () => ((await get("/api/library/transcripts")).json() as { books: { id: string; done: number; total: number }[] }).books;
  const standing = async () => ((await get("/api/library/readalong")).json() as { books: { id: string; state: string }[] }).books[0]!.state;
  const transcript = () => readFileSync(path.join(dir, "data", "books", book.id, "records", "aligned.csv"), "utf8");
  /** The book's two minutes heard whole, each sentence found where it starts: what a computer with a graphics card sends. */
  const sendTranscript = async () => {
    const whole = {
      spans: new Map([
        [0, 60_000],
        [60_000, 70_000],
      ]),
      heardBy: new Map([
        [0, "ggml-small-q5_1"],
        [60_000, "ggml-small-q5_1"],
      ]),
      said: SENTENCES.map((words, i) => ({ startMs: SAID_MS[i]!, endMs: SAID_MS[i]! + 8000, words, chars: AT[i]! })),
    };
    const csv = await rowsToBytes(transcriptRows(whole), TRANSCRIPT_FIELDS);
    return server.app.inject({ method: "PUT", url: `/api/books/${book.id}/transcript`, payload: Buffer.from(csv), headers: { authorization: `Bearer ${admin}`, "content-type": "text/csv" } });
  };

  it("is on for every book to begin with: a book not yet transcribed waits to be", async () => {
    expect(await toTranscribe()).toEqual([expect.objectContaining({ id: book.id, done: 0, total: 2 })]);
    expect(await readAlong()).toMatchObject({ ready: false });
    expect("off" in (await readAlong())).toBe(false);
    expect(await standing()).toBe("waiting");
  });

  it("turned off, the book isn't picked to be transcribed, and every device is told it's off", async () => {
    const before = await get(`/api/books/${book.id}/readalong`);
    expect((await edit({ readAlong: "off" })).statusCode).toBe(200);
    expect((await listed()).edited).toMatchObject({ values: { readAlong: "off" } });
    expect(await toTranscribe()).toEqual([]);
    expect(await readAlong()).toMatchObject({ ready: false, off: true });
    expect(await standing()).toBe("off");
    // A device that kept the read-along from before asks again and gets the new one, not "nothing changed".
    const after = await server.app.inject({ method: "GET", url: `/api/books/${book.id}/readalong`, headers: { authorization: `Bearer ${admin}`, "if-none-match": String(before.headers.etag) } });
    expect(after.statusCode).toBe(200);
  });

  it("keeps a transcript it's sent, and one it had, while it's off, and marks no sentence with it", async () => {
    // Sent by a computer that was part way through the book when the switch was turned.
    expect((await sendTranscript()).statusCode).toBe(204);
    expect(transcript()).toContain("ggml-small-q5_1");
    const off = await readAlong();
    expect(off).toMatchObject({ ready: false, off: true, transcribed: { done: 2, total: 2 } });
    expect(off.blocks.flatMap((b) => b.sentences ?? []).some((s) => s.exact)).toBe(false);
    expect(await toTranscribe()).toEqual([]);
    // An edit to something else leaves the switch where it is, sent with it as the desktop sends a book's edits.
    expect((await edit({ title: "The Waygate, Again", readAlong: "off" })).statusCode).toBe(200);
    expect(await readAlong()).toMatchObject({ off: true });
  });

  it("turned back on, it reads along at once from the transcript it kept, and isn't an edit any more", async () => {
    const kept = transcript();
    // As the desktop's form sends it: the switch back on is an empty value.
    expect((await edit({ readAlong: "" })).statusCode).toBe(200);
    expect((await listed()).edited).toBeUndefined();
    expect(transcript()).toBe(kept);
    const on = await readAlong();
    expect(on.ready).toBe(true);
    expect("off" in on).toBe(false);
    const sentences = on.blocks.filter((b) => b.k === "p").flatMap((b) => b.sentences ?? []);
    expect(sentences.map((s) => s.ms)).toEqual(SAID_MS);
    expect(sentences.every((s) => s.exact)).toBe(true);
    expect(await toTranscribe()).toEqual([expect.objectContaining({ id: book.id, done: 2, total: 2 })]);
    expect(await standing()).toBe("sentence");
  });
});
