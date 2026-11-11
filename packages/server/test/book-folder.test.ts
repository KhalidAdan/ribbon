import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rowsToBytes } from "@ribbon/core/csv";
import type { Host } from "@ribbon/core/host";
import { TRANSCRIPT_FIELDS, transcriptRows } from "@ribbon/core/reading/narration";
import { nodeHost } from "@ribbon/host-node/node";
import { buildServer, type RibbonServer } from "../src/app.ts";
import { builtTool } from "../src/config.ts";
import type { StoredBook } from "../src/library/books.ts";
import { hydrateBooks } from "../src/library/hydrate.ts";
import { PLACING } from "../src/library/place.ts";
import { prepareBooks } from "../src/library/prepare.ts";
import { ReadAlongs } from "../src/library/readalong.ts";
import { epub, importAs, mp3, serverWithAdmin } from "./fixture.ts";

const SENTENCES = ["The waygate hung in the void before them.", "It was a giant circle of wraithbone and old light.", "Eluadhri watched the runes along its rim kindle.", "Then the gate opened, and they stepped through."];
/** Where each sentence starts in the text: after the heading's 11 characters, each sentence and a space. */
const AT = SENTENCES.map((_, i) => 11 + SENTENCES.slice(0, i).reduce((n, s) => n + s.length + 1, 0));
/** When the narrator says each one. */
const SAID_MS = [1000, 19_000, 37_000, 55_000];

/** The book's narration transcribed whole, each sentence found where it starts: what a device with a graphics card sends. */
const WHOLE = rowsToBytes(
  transcriptRows({
    spans: new Map([
      [0, 60_000],
      [60_000, 70_000],
    ]),
    heardBy: new Map([
      [0, "ggml-small-q5_1"],
      [60_000, "ggml-small-q5_1"],
    ]),
    said: SENTENCES.map((words, i) => ({ startMs: SAID_MS[i]!, endMs: SAID_MS[i]! + 8000, words, chars: AT[i]! })),
  }),
  TRANSCRIPT_FIELDS,
);

/**
 * A gate that holds work at one point until the test lets it go, so two
 * things that happen at once on a server happen in a known order here.
 */
function gate() {
  let reach!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  const opened = new Promise<void>((r) => (open = r));
  return { reached, open, pass: async () => (reach(), await opened) };
}

/**
 * The EPUB tool behind a gate made of files: while `closed` is there, each
 * run reads the book's text, touches `reached`, and waits before it answers.
 * So a request to the real server can be held exactly where it has just
 * read a book's text, and the tool can be made new (`touch`), as a server
 * updated to a new one, so each book's read-along is made again.
 */
function gatedTool(dir: string): { tool: string; close(): void; open(): void; reached(): Promise<void>; touch(): void } {
  const tool = path.join(dir, "gated-ribbon-ebook");
  const closed = path.join(dir, "closed");
  const reached = path.join(dir, "reached");
  const answer = path.join(dir, "answer");
  writeFileSync(tool, `#!/bin/sh\n'${builtTool("ribbon-ebook")}' "$@" > '${answer}'\ncode=$?\ntouch '${reached}'\nwhile [ -e '${closed}' ]; do sleep 0.02; done\ncat '${answer}'\nexit $code\n`);
  chmodSync(tool, 0o755);
  return {
    tool,
    touch: () => utimesSync(tool, new Date(), new Date(Date.now() + 60_000)),
    close: () => (rmSync(reached, { force: true }), writeFileSync(closed, "")),
    open: () => rmSync(closed, { force: true }),
    reached: async () => {
      for (let i = 0; i < 500 && !existsSync(reached); i++) await new Promise((r) => setTimeout(r, 10));
      expect(existsSync(reached), "the EPUB tool was never run").toBe(true);
    },
  };
}

/**
 * A book's folder on the server is written by many things: jobs that work
 * out more about it, devices sending what they heard or a whole transcript,
 * and the admin deleting it. Each happens while the others may be under
 * way, so each must keep what the others kept, and nothing may write into
 * a book's folder once it's deleted.
 */
describe("a book's folder, written by many things at once", () => {
  let dir: string;
  let data: string;
  let library: string;
  let server: RibbonServer;
  let token = "";
  /** The book written to while jobs run on it, and the one deleted while its read-along is made: each test leaves the next its own. */
  let id = "";
  let other = "";
  let gated: ReturnType<typeof gatedTool>;

  beforeAll(async () => {
    expect(builtTool("ribbon-ebook"), "build the EPUB tool first: cargo build --release --manifest-path packages/desktop/src-tauri/Cargo.toml -p ribbon-ebook -p ribbon-frames").not.toBeNull();
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-book-folder-"));
    data = path.join(dir, "data");
    library = path.join(dir, "library");
    for (const [title, seconds] of [["The Waygate", 70], ["The Second Gate", 65]] as const) {
      const folder = path.join(library, "An Author", title);
      mp3(path.join(folder, "01.mp3"), { title, album: title, artist: "An Author" }, undefined, seconds);
      epub(path.join(folder, `${title}.epub`), "Chapter One", SENTENCES);
    }
    gated = gatedTool(dir);
    ({ server, admin: token } = await serverWithAdmin(dir, { ebookTool: gated.tool, framesTool: builtTool("ribbon-frames") }));
    await importAs(server, token, library);
    id = server.books.list().find((b) => b.title === "The Waygate")!.id;
    other = server.books.list().find((b) => b.title === "The Second Gate")!.id;
  }, 60_000);
  afterAll(async () => {
    gated.open();
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const as = (method: "GET" | "PUT" | "DELETE", url: string, payload?: Buffer) => server.app.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...(payload ? { "content-type": "text/csv" } : {}) }, ...(payload ? { payload } : {}) });
  const putTranscript = async () => as("PUT", `/api/books/${id}/transcript`, Buffer.from(await WHOLE));
  const record = () => JSON.parse(readFileSync(path.join(data, "books", id, "book.json"), "utf8")) as StoredBook;
  const forget = (...fields: (keyof StoredBook)[]) => {
    const stored = record() as unknown as Record<string, unknown>;
    for (const f of fields) delete stored[f];
    writeFileSync(path.join(data, "books", id, "book.json"), JSON.stringify(stored));
  };
  /** Where the book's read-along stands for the admin, and how much of it the admin's devices are told is transcribed. */
  const standing = async () => ({
    readAlong: ((await as("GET", "/api/library/readalong")).json() as { books: { id: string; state: string }[] }).books.find((b) => b.id === id)?.state,
    transcribed: ((await as("GET", "/api/library/transcripts")).json() as { books: { id: string; done: number; total: number }[] }).books.find((b) => b.id === id),
  });

  it("keeps a transcript sent while the book is measured, and it reads along", async () => {
    // As a book added before the server measured books, measured at start-up: ffmpeg held at its first run.
    forget("analysis", "records", "placed");
    const held = gate();
    const base = nodeHost();
    const { stream: _, ...rest } = base;
    const host: Host = { ...rest, run: async (tool, args, signal) => (await held.pass(), base.run(tool, args, signal)) };
    const measuring = prepareBooks(host, data, [id], () => undefined);
    await held.reached;

    expect((await putTranscript()).statusCode).toBe(204);
    held.open();
    await measuring;

    expect(record().analysis?.loudness).toBeTruthy();
    expect(record().records).toContain("aligned");
    expect(record().placed).toBe(PLACING);
    expect(await standing()).toEqual({ readAlong: "sentence", transcribed: { id, title: "The Waygate", done: 2, total: 2 } });
  });

  it("keeps a transcript sent while the book is filled in from its EPUB, and it reads along", async () => {
    forget("records", "placed", "filled");
    const held = gate();
    const readAlongs = new ReadAlongs(data, builtTool("ribbon-ebook"));
    const filling = hydrateBooks({ ebook: async (...a: Parameters<ReadAlongs["ebook"]>) => (await held.pass(), readAlongs.ebook(...a)) } as ReadAlongs, data, [id], () => undefined);
    await held.reached;

    expect((await putTranscript()).statusCode).toBe(204);
    held.open();
    await filling;

    expect(record().filled).toBeTruthy();
    expect(record().records).toContain("aligned");
    expect(record().placed).toBe(PLACING);
    expect((await standing()).readAlong).toBe("sentence");
  });

  it("writes nothing into a book deleted while its transcript was placed, so it comes back when its folder is added again", async () => {
    // The transcript's phrases are placed in the book's text as it comes in: held just after the EPUB tool has read it.
    gated.close();
    const sending = putTranscript();
    await gated.reached();
    const deleting = as("DELETE", `/api/books/${id}`);
    // The delete is answered whenever it can be; the transcript, after.
    await new Promise((r) => setTimeout(r, 100));
    gated.open();
    expect((await deleting).statusCode).toBe(204);
    expect.soft((await sending).statusCode, "the transcript of a book deleted meanwhile").toBe(404);

    expect.soft(existsSync(path.join(data, "books", id)), "a folder left behind").toBe(false);
    const { job } = await importAs(server, token, library);
    expect(job.progress).toMatchObject({ added: 1, failed: 0, notes: ["The Second Gate: already on the server."] });
    expect(server.books.has(id)).toBe(true);
  });

  it("doesn't index a book deleted while its read-along was made, so it isn't found by its words", async () => {
    // A new EPUB tool, so the next ask makes it again: held just after it has read the text.
    gated.touch();
    const found = async () => ((await as("GET", "/api/search?q=wraithbone")).json() as { results: { book: string }[] }).results.filter((r) => r.book === other);
    expect(await found()).toHaveLength(1);
    gated.close();
    const asking = as("GET", `/api/books/${other}/readalong`);
    await gated.reached();
    const deleting = as("DELETE", `/api/books/${other}`);
    await new Promise((r) => setTimeout(r, 100));
    gated.open();
    expect((await deleting).statusCode).toBe(204);
    await asking;

    expect(await found()).toEqual([]);
  });
});

/**
 * A book whose record lost its transcript from its list to a job that wrote
 * back an older copy, before each job changed only its own part: the admin's
 * devices are told it's transcribed, so none sends it again, and it waited
 * to read along for good. The server lists what the book's folder holds
 * when it starts.
 */
describe("a book whose record lost its transcript from its list", () => {
  let dir: string;
  const servers: RibbonServer[] = [];

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-relist-"));
  });
  afterAll(async () => {
    for (const server of servers) {
      await server.app.close();
      server.db.close();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads along again once the server starts", async () => {
    const library = path.join(dir, "library");
    const folder = path.join(library, "An Author", "The Waygate");
    mp3(path.join(folder, "01.mp3"), { title: "The Waygate", album: "The Waygate", artist: "An Author" }, undefined, 70);
    epub(path.join(folder, "The Waygate.epub"), "Chapter One", SENTENCES);
    const tools = { ebookTool: builtTool("ribbon-ebook"), framesTool: builtTool("ribbon-frames") };
    const first = await serverWithAdmin(dir, tools);
    servers.push(first.server);
    await importAs(first.server, first.admin, library);
    const id = first.server.books.list()[0]!.id;
    const put = await first.server.app.inject({ method: "PUT", url: `/api/books/${id}/transcript`, payload: Buffer.from(await WHOLE), headers: { authorization: `Bearer ${first.admin}`, "content-type": "text/csv" } });
    expect(put.statusCode).toBe(204);
    // As a job writing back what it read before the transcript came left it.
    const file = path.join(dir, "data", "books", id, "book.json");
    const { records: _, placed: __, ...lost } = JSON.parse(readFileSync(file, "utf8")) as StoredBook;
    writeFileSync(file, JSON.stringify(lost));

    const again = await buildServer({ dataDir: path.join(dir, "data"), host: "127.0.0.1", port: 0, url: "https://ribbon.example", secret: "a test secret of thirty-two chars!!", ...tools });
    servers.push(again);
    await again.jobs.idle();
    const listed = (await again.app.inject({ method: "GET", url: "/api/library/readalong", headers: { authorization: `Bearer ${first.admin}` } })).json() as { books: { state: string }[] };
    expect(listed.books.map((b) => b.state)).toEqual(["sentence"]);
    expect((JSON.parse(readFileSync(file, "utf8")) as StoredBook).records).toEqual(["aligned"]);
  });
});
