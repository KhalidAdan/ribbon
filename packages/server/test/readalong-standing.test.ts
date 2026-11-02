import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RibbonServer } from "../src/app.ts";
import { builtTool } from "../src/config.ts";
import { stateOf } from "../src/library/readalong.ts";
import { epub, importAs, mp3, serverWithAdmin } from "./fixture.ts";

const SENTENCES = ["The waygate hung in the void before them.", "It was a giant circle of wraithbone and old light.", "Eluadhri watched the runes along its rim kindle.", "Jurilan did not answer her at once.", "Then the gate opened, and they stepped through."];
/** Where each sentence starts in the text, after the heading's 11 characters, and when the narrator says it. */
const AT = SENTENCES.map((_, i) => 11 + SENTENCES.slice(0, i).reduce((n, s) => n + s.length + 1, 0));
const SAID_MS = [1000, 10_000, 19_000, 28_000, 37_000];

interface Listed {
  books: { title: string; state: string; placed?: number; transcribed?: { done: number; total: number }; error?: string }[];
}

/** A book of one chapter and a minute's narration or less, in a library folder of its own. */
function aBook(library: string, title: string, seconds: number): void {
  const folder = path.join(library, "An Author", title);
  mp3(path.join(folder, "01.mp3"), { title, album: title, artist: "An Author" }, undefined, seconds);
  epub(path.join(folder, `${title}.epub`), "Chapter One", SENTENCES);
}

/**
 * A book that doesn't read along is never found only on the TV
 * (docs/SERVER.md, section 9): the admin sees where every book stands, and
 * one whose narration is transcribed whole and still doesn't read along to
 * the sentence is flagged.
 */
describe("how the library reads along", () => {
  let dir: string;
  const servers: RibbonServer[] = [];
  const listed = async (server: RibbonServer, token: string) => (await server.app.inject({ method: "GET", url: "/api/library/readalong", headers: { authorization: `Bearer ${token}` } })).json() as Listed;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-standing-"));
    expect(builtTool("ribbon-ebook"), "build the EPUB tool first: cargo build --manifest-path src-tauri/Cargo.toml -p ribbon-ebook").not.toBeNull();
  });
  afterAll(async () => {
    for (const server of servers) {
      await server.app.close();
      server.db.close();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("flags a book whose narration is transcribed whole and still doesn't read along to the sentence, until it does", async () => {
    const here = path.join(dir, "transcribed");
    const library = path.join(here, "library");
    aBook(library, "The Waygate", 50);
    const { server, admin } = await serverWithAdmin(here, { ebookTool: builtTool("ribbon-ebook"), framesTool: builtTool("ribbon-frames") });
    servers.push(server);
    await importAs(server, admin, library);
    const id = server.books.list()[0]!.id;
    const send = (said: string) =>
      server.app.inject({ method: "PUT", url: `/api/books/${id}/transcript`, payload: `start_ms,end_ms,words,chars,heard_by,word_ms\n0,50000,,,ggml-small-q5_1,\n${said}`, headers: { authorization: `Bearer ${admin}`, "content-type": "text/csv" } });

    // The narration heard is another book's, a phrase every five seconds: nothing in it is found in this one's text.
    await send(Array.from({ length: 9 }, (_, i) => `${1000 + i * 5000},${5500 + i * 5000},"Another book entirely, its part number ${i + 1} read by somebody else",,,`).join("\n") + "\n");
    expect(await listed(server, admin)).toEqual({ books: [expect.objectContaining({ title: "The Waygate", state: "flagged", placed: 0, transcribed: { done: 1, total: 1 } })] });

    // A transcript that heard it right, in its place: the book reads along by sentence, without anyone opening it.
    await send(SENTENCES.map((s, i) => `${SAID_MS[i]},${SAID_MS[i]! + 8000},"${s}",${AT[i]},,`).join("\n") + "\n");
    expect((await listed(server, admin)).books).toEqual([expect.objectContaining({ title: "The Waygate", state: "sentence", placed: 1 })]);
  }, 60_000);

  it("says which books wait for a device to transcribe them, and which can't be read, those first", async () => {
    const here = path.join(dir, "devices");
    const library = path.join(here, "library");
    aBook(library, "The Waygate", 50);
    const broken = path.join(library, "An Author", "Broken");
    mp3(path.join(broken, "01.mp3"), { title: "Broken", album: "Broken", artist: "An Author" });
    mkdirSync(broken, { recursive: true });
    writeFileSync(path.join(broken, "Broken.epub"), "not an EPUB at all");
    const { server, admin } = await serverWithAdmin(here, { ebookTool: builtTool("ribbon-ebook"), framesTool: builtTool("ribbon-frames") });
    servers.push(server);
    await importAs(server, admin, library);

    const { books } = await listed(server, admin);
    expect(books.map((b) => [b.title, b.state])).toEqual([
      ["Broken", "unreadable"],
      ["The Waygate", "waiting"],
    ]);
    expect(books[0]!.error).toContain("can't be read");
    expect((await server.app.inject({ method: "GET", url: "/api/library/readalong" })).statusCode).toBe(401);
  }, 60_000);
});

/** Where a book stands by what's felt while listening (#163): the longest stretch of narration with nothing marked. */
describe("a book's standing, by narration unmarked", () => {
  const standing = (placed: number, unmarked: { totalMs: number; longestMs: number } | null) => ({ check: { placed, heldOut: null, unmarked: unmarked && { ...unmarked, narrationMs: 731 * 60_000 } }, pairedBy: "chapter" as const, transcribed: { done: 731, total: 731 } });

  it("flags a book with narration unmarked for more than a minute, though most of its sentences are placed", () => {
    // Plague War before #163: 95.6% of its sentences placed, and its last chapter, 31 minutes, unmarked.
    expect(stateOf(standing(0.9555, { totalMs: 1_926_000, longestMs: 1_848_000 }))).toBe("flagged");
    // The share alone called it read along by sentence.
    expect(stateOf(standing(0.9555, null))).toBe("sentence");
  });

  it("reads along by sentence with no narration unmarked, however many pages nobody reads pull its share down", () => {
    expect(stateOf(standing(0.85, { totalMs: 0, longestMs: 0 }))).toBe("sentence");
    expect(stateOf(standing(0.85, { totalMs: 41_000, longestMs: 41_000 }))).toBe("sentence");
  });
});
