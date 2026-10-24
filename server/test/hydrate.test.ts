import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookId } from "../../src/core/bookid.ts";
import { buildServer, type RibbonServer } from "../src/app.ts";
import { builtTool } from "../src/config.ts";
import type { StoredBook } from "../src/library/books.ts";
import { booksToHydrate } from "../src/library/hydrate.ts";
import { epubOf, importAs, mp3, serverWithAdmin } from "./fixture.ts";

const CHAPTERS = ["One", "Two", "Three", "Four"];

/**
 * Books that came without a description or real chapter names, though
 * their EPUBs have both, are filled in after they're added: the
 * description from the EPUB's package, the names from its contents, by
 * pairing its text with the audio. Nothing given by hand is replaced.
 */
describe("filling in what a book came without", () => {
  let dir: string;
  let server: RibbonServer;
  let token = "";
  const config = { ebookTool: builtTool("ribbon-ebook"), framesTool: builtTool("ribbon-frames") };
  const ids: Record<string, string> = {};

  /**
   * A book of four files the ripper titled "Chapter 1" to "Chapter 4", with
   * its EPUB. Over a minute each: a first or last chapter shorter than that
   * would be taken for the credits.
   */
  const numbered = (folder: string, description?: string) => {
    CHAPTERS.forEach((_, i) => mp3(path.join(folder, `0${i + 1}.mp3`), { title: `Chapter ${i + 1}`, album: path.basename(folder), artist: "An Author" }, undefined, 80));
    epubOf(path.join(folder, `${path.basename(folder)}.epub`), {
      title: path.basename(folder),
      ...(description ? { description } : {}),
      chapters: CHAPTERS.map((heading) => ({ heading, sentences: [`Chapter ${heading.toLowerCase()} begins here and ends soon after.`] })),
    });
  };
  const stored = (title: string) => JSON.parse(readFileSync(path.join(dir, "data", "books", ids[title]!, "book.json"), "utf8")) as StoredBook;
  const get = (url: string, headers: Record<string, string> = {}) => server.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}`, ...headers } });
  const details = async (title: string) => (await get(`/api/books/${ids[title]}`)).json() as StoredBook;

  beforeAll(async () => {
    expect(config.ebookTool, "build the EPUB tool first: cargo build --manifest-path src-tauri/Cargo.toml -p ribbon-ebook").not.toBeNull();
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-hydrate-"));
    const library = path.join(dir, "library");
    // The publisher's description, HTML escaped inside the XML, as Black Library's EPUBs have it.
    numbered(path.join(library, "Numbered Book"), "&lt;p&gt;A book about &lt;b&gt;four&lt;/b&gt; things &amp;#8211; nothing more.&lt;/p&gt;");
    numbered(path.join(library, "Named By Hand"), "Its own description.");
    numbered(path.join(library, "Described Book"), "What the EPUB says.");
    // Its first chapter named on a computer before it came to the server.
    const bytes = ["01", "02", "03", "04"].reduce((s, n) => s + statSync(path.join(library, "Named By Hand", `${n}.mp3`)).size, 0);
    mkdirSync(path.join(library, ".ribbon", "corrections"), { recursive: true });
    writeFileSync(path.join(library, ".ribbon", "corrections", `${bookId("Named By Hand", bytes)}.csv`), "op,index,start_ms,title\nrename,0,,The Start\n");
    // Described by whoever made the folder.
    writeFileSync(path.join(library, "Described Book", "desc.txt"), "What the folder says.");
    const made = await serverWithAdmin(dir, config);
    server = made.server;
    token = made.admin;
    const { job } = await importAs(server, token, library);
    expect(job.progress).toMatchObject({ added: 3, failed: 0 });
    for (const b of server.books.list()) ids[b.title] = b.id;
  }, 60_000);
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("describes a book with its EPUB's description, as plain text", async () => {
    expect((await details("Numbered Book")).book.description).toBe("A book about four things – nothing more.");
    expect(stored("Numbered Book").filled?.description).toBe("epub");
  });

  it("names the chapters its files only number from its contents, for every device", async () => {
    // The TV keeps nothing: it's given the chapters named.
    const book = await details("Numbered Book");
    expect(book.chapters.map((c) => c.title)).toEqual(CHAPTERS);
    // A device that downloads it keeps the names as the corrections beside the book.
    expect(book.records).toContain("corrections");
    const r = await get(`/api/books/${ids["Numbered Book"]}/files/records/corrections.csv`);
    expect(r.statusCode).toBe(200);
    expect(r.body.trim().split("\n")).toEqual(["op,index,start_ms,title", "rename,0,,One", "rename,1,,Two", "rename,2,,Three", "rename,3,,Four"]);
    expect((await get(`/api/books/${ids["Numbered Book"]}/files/records/corrections.csv`, { "if-none-match": r.headers.etag as string })).statusCode).toBe(304);
    // The book's own record keeps what came with it, and says what was filled in.
    expect(stored("Numbered Book").chapters.map((c) => c.title)).toEqual(["Chapter 1", "Chapter 2", "Chapter 3", "Chapter 4"]);
    expect(stored("Numbered Book").filled?.chapters).toHaveLength(4);
  });

  it("never replaces a chapter name or a description given by hand", async () => {
    const hand = await details("Named By Hand");
    expect(hand.chapters.map((c) => c.title)).toEqual(["The Start", "Chapter 2", "Chapter 3", "Chapter 4"]);
    expect(stored("Named By Hand").filled?.chapters).toBeUndefined();
    expect((await get(`/api/books/${ids["Named By Hand"]}/files/records/corrections.csv`)).body).toBe("op,index,start_ms,title\nrename,0,,The Start\n");
    // Its description was missing, so that's filled in all the same.
    expect(hand.book.description).toBe("Its own description.");

    const described = await details("Described Book");
    expect(described.book.description).toBe("What the folder says.");
    expect(stored("Described Book").filled?.description).toBeUndefined();
    expect(described.chapters.map((c) => c.title)).toEqual(CHAPTERS);
  });

  it("looks at a book once, until what it's filled in from changes", async () => {
    expect(await booksToHydrate(path.join(dir, "data"), server.books)).toEqual([]);
  });

  it("fills in the books added before it did, when the server starts", async () => {
    const id = ids["Numbered Book"]!;
    const file = path.join(dir, "data", "books", id, "book.json");
    const before = stored("Numbered Book");
    delete before.filled;
    delete before.book.description;
    writeFileSync(file, JSON.stringify(before));
    await server.app.close();
    server.db.close();
    server = await buildServer({ dataDir: path.join(dir, "data"), host: "127.0.0.1", port: 0, url: "https://ribbon.example", secret: "a test secret of thirty-two chars!!", ...config });
    await server.jobs.idle();
    const book = await details("Numbered Book");
    expect(book.book.description).toBe("A book about four things – nothing more.");
    expect(book.chapters.map((c) => c.title)).toEqual(CHAPTERS);
  });
});
