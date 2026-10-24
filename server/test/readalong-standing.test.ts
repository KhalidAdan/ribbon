import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RibbonServer } from "../src/app.ts";
import { builtTool } from "../src/config.ts";
import { epub, importAs, mp3, serverWithAdmin, speechStandIn } from "./fixture.ts";

const SENTENCES = ["The waygate hung in the void before them.", "It was a giant circle of wraithbone and old light.", "Eluadhri watched the runes along its rim kindle.", "Jurilan did not answer her at once.", "Then the gate opened, and they stepped through."];
/** Where each sentence starts in the text, after the heading's 11 characters, and when the narrator says it. */
const AT = SENTENCES.map((_, i) => 11 + SENTENCES.slice(0, i).reduce((n, s) => n + s.length + 1, 0));
const SAID_MS = [1000, 10_000, 19_000, 28_000, 37_000];

interface Listed {
  transcribes: boolean;
  books: { title: string; state: string; placed?: number; transcribed?: { done: number; total: number }; error?: string }[];
}

/** A book of one chapter and a minute's narration or less, in a library folder of its own. */
function aBook(library: string, title: string, seconds: number): void {
  const folder = path.join(library, "An Author", title);
  mp3(path.join(folder, "01.mp3"), { title, album: title, artist: "An Author" }, undefined, seconds);
  epub(path.join(folder, `${title}.epub`), "Chapter One", SENTENCES);
}

/**
 * A book left reading along by chapter is never found only on the TV
 * (docs/SERVER.md, section 9): the admin sees where every book stands, and
 * one whose narration is transcribed and still goes by chapter is flagged.
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

  it("flags a book whose narration is transcribed and still reads along by chapter, until it reads along by sentence", async () => {
    const here = path.join(dir, "transcribes");
    const library = path.join(here, "library");
    aBook(library, "The Waygate", 50);
    // The narration heard is another book's: nothing in it is found in this one's text.
    const speech = speechStandIn(here, { 0: [{ startMs: 1000, endMs: 9000, words: " This is Audible. Narrated by somebody else entirely, copyright twenty twenty five." }] });
    writeFileSync(path.join(here, "model.bin"), "a model");
    const { server, admin } = await serverWithAdmin(here, { ebookTool: builtTool("ribbon-ebook"), framesTool: builtTool("ribbon-frames"), speech: { tool: speech.tool, model: path.join(here, "model.bin"), threads: 1 } });
    servers.push(server);
    const warned = vi.spyOn(server.app.log, "warn");
    await importAs(server, admin, library);
    await server.jobs.idle("speech");

    expect(await listed(server, admin)).toEqual({ transcribes: true, books: [expect.objectContaining({ title: "The Waygate", state: "flagged", placed: 0, transcribed: { done: 1, total: 1 } })] });
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('"The Waygate" is transcribed and still reads along by chapter (0% to the sentence)'));

    // A device that heard it right sends what it heard: the book reads along by sentence, without anyone opening it.
    const id = server.books.list()[0]!.id;
    const rows = SENTENCES.map((s, i) => `${SAID_MS[i]},${SAID_MS[i]! + 8000},"${s}",${AT[i]}`).join("\n");
    await server.app.inject({ method: "POST", url: `/api/books/${id}/records/aligned`, payload: `start_ms,end_ms,words,chars\n${rows}\n`, headers: { authorization: `Bearer ${admin}`, "content-type": "text/csv" } });
    expect((await listed(server, admin)).books).toEqual([expect.objectContaining({ title: "The Waygate", state: "sentence", placed: 1 })]);
  }, 60_000);

  it("says which books wait for a device on a server that doesn't transcribe, and which can't be read, those first", async () => {
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

    const { transcribes, books } = await listed(server, admin);
    expect(transcribes).toBe(false);
    expect(books.map((b) => [b.title, b.state])).toEqual([
      ["Broken", "unreadable"],
      ["The Waygate", "waiting"],
    ]);
    expect(books[0]!.error).toContain("can't be read");
    expect((await server.app.inject({ method: "GET", url: "/api/library/readalong" })).statusCode).toBe(401);
  }, 60_000);
});
