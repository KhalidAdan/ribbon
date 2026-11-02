import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerBook } from "@ribbon/core/server-books";
import type { RibbonServer } from "../src/app.ts";
import { builtTool } from "../src/config.ts";
import type { ListedBook } from "../src/library/books.ts";
import { epub, importAs, mp3, serverWithAdmin } from "./fixture.ts";

/** What the server lists is what the apps read: this stops compiling if the two part. */
export type ListedIsWhatTheAppsRead = ListedBook extends ServerBook ? true : never;

const CONTRACT = path.resolve(import.meta.dirname, "..", "..", "apple", "RibbonTests", "Contract");
const DEVICE = { id: "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Ribbon on the Apple TV" };
const SENTENCES = ["The waygate hung in the void before them.", "It was a giant circle of wraithbone and old light.", "Nobody on the ship would look at it for long."];
/** Where each sentence starts in the text, after the heading's 11 characters. */
const AT = SENTENCES.map((_, i) => 11 + SENTENCES.slice(0, i).reduce((n, s) => n + s.length + 1, 0));

/**
 * An answer as a stable file: every array cut to its first two, and what
 * differs from one run to the next made the same (ids, moments, sizes). What's
 * left is the answer's shape, which is what an app depends on.
 */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 2).map(shapeOf);
  if (typeof value === "number") return Number.isInteger(value) ? 1000 : 0.5;
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return "2026-01-01T00:00:00.000Z";
    if (/^[0-9a-f]{16}$/.test(value)) return "0123456789abcdef";
    if (/^urn:uuid:/.test(value)) return "urn:uuid:00000000-0000-4000-8000-000000000000";
    if (/^\d+\|\d+:/.test(value)) return "1|1:1";
    return value;
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [/^[0-9a-f]{8}([0-9a-f]{8})?$/.test(k) ? "0123456789abcdef" : k, shapeOf(v)]));
  }
  return value;
}

/**
 * The contract between the server and the Apple app: the server's real
 * answer to everything the app asks, kept as a file, which the app's own types
 * decode in packages/apple/RibbonTests. Change an answer and this fails until the file
 * is written again (`npx vitest run test/api-contract -u`), and then the
 * app's test says whether it can still read it.
 */
describe("what the server answers the Apple app", () => {
  let dir: string;
  let server: RibbonServer;
  let admin = "";
  let id = "";

  const ask = async (method: "GET" | "POST" | "DELETE", url: string, payload?: Record<string, unknown>) => {
    const r = await server.app.inject({ method, url, headers: { authorization: `Bearer ${admin}` }, ...(payload ? { payload } : {}) });
    expect(r.statusCode, `${method} ${url}: ${r.body}`).toBeLessThan(300);
    return r.json() as Record<string, unknown>;
  };
  const kept = (name: string, answer: unknown) => expect(`${JSON.stringify(shapeOf(answer), null, 2)}\n`).toMatchFileSnapshot(path.join(CONTRACT, `${name}.json`));

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-contract-"));
    const folder = path.join(dir, "library", "An Author", "The Waygate");
    mp3(path.join(folder, "01.mp3"), { title: "The Waygate", album: "The Waygate", artist: "An Author" }, "red", 50);
    epub(path.join(folder, "The Waygate.epub"), "Chapter One", SENTENCES);
    ({ server, admin } = await serverWithAdmin(dir, { ebookTool: builtTool("ribbon-ebook"), framesTool: builtTool("ribbon-frames") }));
    await importAs(server, admin, path.join(dir, "library"));
    id = server.books.list()[0]!.id;
    const said = SENTENCES.map((s, i) => `${1000 + i * 15000},${9000 + i * 15000},"${s}",${AT[i]},,`).join("\n");
    await server.app.inject({ method: "PUT", url: `/api/books/${id}/transcript`, payload: `start_ms,end_ms,words,chars,heard_by,word_ms\n0,50000,,,ggml-small-q5_1,\n${said}\n`, headers: { authorization: `Bearer ${admin}`, "content-type": "text/csv" } });
    await ask("POST", "/api/series", { name: "The Waygates", books: [{ id, number: 1, shelved: true }] });
    await server.jobs.idle("work");
  }, 60_000);
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("the library", async () => {
    await kept("books", await ask("GET", "/api/books"));
    await kept("series", await ask("GET", "/api/series"));
  });

  it("a book", async () => {
    await kept("book", await ask("GET", `/api/books/${id}`));
    await kept("readalong", await ask("GET", `/api/books/${id}/readalong`));
  });

  it("a place, and how far through", async () => {
    await kept("place-told", await ask("POST", `/api/books/${id}/place`, { ms: 20000, why: "pause", device: DEVICE }));
    await kept("place", await ask("GET", `/api/books/${id}/place`));
    await kept("progress", await ask("GET", "/api/progress"));
  });

  it("bookmarks, in a book and in every book", async () => {
    const made = await ask("POST", `/api/books/${id}/bookmarks`, { first: 0, last: 1, device: DEVICE });
    await kept("bookmark-made", made);
    await kept("bookmarks", await ask("GET", `/api/books/${id}/bookmarks`));
    await kept("passages", await ask("GET", "/api/bookmarks"));
    await kept("bookmark-deleted", await ask("DELETE", `/api/books/${id}/bookmarks/${encodeURIComponent((made.bookmark as { id: string }).id)}`, { device: DEVICE }));
  });

  it("listening, and the end of a book", async () => {
    const start = new Date(1_790_000_000_000).toISOString();
    const end = new Date(1_790_000_020_000).toISOString();
    await kept("listened", await ask("POST", `/api/books/${id}/listened`, { start, end, fromMs: 0, toMs: 20000, speed: 1, again: false, keep: true, device: DEVICE }));
    await kept("finished", await ask("POST", `/api/books/${id}/finished`, { device: DEVICE }));
  });

  it("a line found", async () => {
    await kept("search", await ask("GET", `/api/search?q=${encodeURIComponent("giant circle of wraithbone")}`));
  });
});
