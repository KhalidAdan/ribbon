import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { nodeHost } from "../src/host/node";
import type { Host } from "../src/host/host";
import { loadLibrary, scanLibrary, type ScannedBook } from "../src/core/scan/scan";
import { authorKeys, bytesToEbooks, ebooksToBytes, isbn13, pairByMetadata, titleKeys, type EbookPackage } from "../src/core/scan/ebooks";
import { EBOOK_FORMAT, readerOnly } from "../src/core/ebook";
import { AppController, type Platform } from "../src/app/controller";
import { memorySettings, memorySources } from "../src/app/platform";
import { progressOf } from "../src/ui/progress";

const pkg = (title: string, authors: string[], isbns: string[] = []) => ({ title, authors, isbns });

describe("pairing an EPUB with an audiobook by its metadata (docs/READING.md, section 2)", () => {
  it("knows an ISBN in either form, and nothing that is not one", () => {
    expect(isbn13("978-1-83609-315-2")).toBe("9781836093152");
    expect(isbn13("urn:isbn:0-306-40615-2")).toBe("9780306406157");
    expect(isbn13("9781836093153")).toBeNull();
    expect(isbn13("B0CXYZ1234")).toBeNull();
  });

  it("compares titles and authors loosely", () => {
    expect(titleKeys("Horus Rising (Unabridged)")).toEqual(["horusrising"]);
    expect(titleKeys("The Horus Heresy: Horus Rising")).toContain("horusrising");
    expect(authorKeys("Abnett, Dan")).toContain("danabnett");
    expect(authorKeys(["Dan Abnett", "Graham McNeill"])).toEqual(["danabnett", "grahammcneill"]);
  });

  it("pairs by an ISBN in the audiobook's tags, either form of it, before title and author", () => {
    const audio = [
      { title: "Something Else", author: "Nobody", isbn: "0-306-40615-2" },
      { title: "Voidscarred", author: "Mike Brooks" },
    ];
    // The ISBN wins though the title says otherwise.
    expect([...pairByMetadata(audio, [pkg("Voidscarred", ["Mike Brooks"], ["9780306406157"])])]).toEqual([[0, 0]]);
  });

  it("pairs by title and author when no identifier agrees", () => {
    const audio = [
      { title: "Horus Rising", rawTitle: "Horus Rising (Unabridged)", author: "Dan Abnett" },
      { title: "False Gods", author: "Graham McNeill" },
    ];
    expect([...pairByMetadata(audio, [pkg("False Gods", ["McNeill, Graham"]), pkg("The Horus Heresy: Horus Rising", ["Dan Abnett"])])]).toEqual([
      [0, 1],
      [1, 0],
    ]);
    // The title alone is not enough.
    expect(pairByMetadata(audio, [pkg("Horus Rising", ["Someone Else"])]).size).toBe(0);
  });

  it("pairs nothing when the match is not unique both ways", () => {
    const twice = [
      { title: "Horus Rising", author: "Dan Abnett" },
      { title: "Horus Rising", author: "Dan Abnett" },
    ];
    expect(pairByMetadata(twice, [pkg("Horus Rising", ["Dan Abnett"])]).size).toBe(0);
    expect(pairByMetadata([twice[0]!], [pkg("Horus Rising", ["Dan Abnett"]), pkg("Horus Rising", ["Dan Abnett"])]).size).toBe(0);
    // Two EPUBs with one ISBN: neither.
    expect(pairByMetadata([{ title: "A", author: "B", isbn: "9781836093152" }], [pkg("X", [], ["9781836093152"]), pkg("Y", [], ["9781836093152"])]).size).toBe(0);
  });

  it("keeps what was read of each EPUB in ebooks.csv", async () => {
    const e: EbookPackage = { path: "Ebooks/A.epub", sizeBytes: 10, mtimeMs: 20, title: "A, the book", authors: ["Mike Brooks", "Dan Abnett"], isbns: ["9781836093152"], language: "en", publisher: "Black Library", date: "2025-08-05", description: "Line one.\nLine two.", hasCover: true };
    expect((await bytesToEbooks(await ebooksToBytes([e]))).get("Ebooks/A.epub")).toEqual(e);
  });
});

function ff(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], (e) => (e ? reject(e) : resolve())));
}

async function mp3(file: string, tags: Record<string, string>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const meta = Object.entries(tags).flatMap(([k, v]) => ["-metadata", `${k}=${v}`]);
  await ff(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=22050:duration=2", ...meta, "-c:a", "libmp3lame", "-b:a", "32k", file]);
}

/** What the Rust scanner would read of each EPUB, by file name. */
const PACKAGES: Record<string, { tags: Record<string, string>; hasCover: boolean }> = {
  "Only.epub": { tags: { title: "The Lost Book", author: "Ann Writer", date: "2019-03-01", description: "A book with no audio." }, hasCover: true },
  "void.epub": { tags: { title: "Not Its Usual Title", author: "Mike Brooks", isbn: "9781836093152" }, hasCover: false },
  "hr.epub": { tags: { title: "Horus Rising", author: "Dan Abnett" }, hasCover: false },
  "fg.epub": { tags: { title: "False Gods", author: "Graham McNeill" }, hasCover: false },
};

function readingHost(seen: string[] = []): Host {
  return nodeHost({
    async readEbookPackage(p) {
      seen.push(path.basename(p));
      return PACKAGES[path.basename(p)] ?? null;
    },
  });
}

describe("a scan of a library with EPUBs on their own", () => {
  let root = "";
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-reader-only-"));
    await mp3(path.join(root, "Audio", "Voidscarred", "01.mp3"), { album: "Voidscarred", artist: "Mike Brooks", isbn: "978-1-83609-315-2" });
    await mp3(path.join(root, "Audio", "Horus Rising", "01.mp3"), { album: "Horus Rising (Unabridged)", artist: "Dan Abnett" });
    // False Gods twice, as two folders: which one the EPUB goes with cannot be told.
    await mp3(path.join(root, "Audio", "False Gods", "01.mp3"), { album: "False Gods", artist: "Graham McNeill" });
    await mp3(path.join(root, "Audio", "False Gods (2006)", "01.mp3"), { album: "False Gods", artist: "Graham McNeill" });
    await fs.mkdir(path.join(root, "Ebooks"));
    for (const name of Object.keys(PACKAGES)) await fs.writeFile(path.join(root, "Ebooks", name), `PK ${name}`);
  }, 60_000);
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const byPath = (books: ScannedBook[], p: string) => books.find((b) => b.book.path === p);

  it("makes an EPUB alone a book to read, named by its package, with its cover", async () => {
    const { books } = await scanLibrary(readingHost(), root);
    const only = byPath(books, "Ebooks/Only.epub")!;
    expect(only).toBeDefined();
    expect(readerOnly(only.book)).toBe(true);
    expect(only.book).toMatchObject({ title: "The Lost Book", author: "Ann Writer", year: 2019, description: "A book with no audio.", ebook: "Ebooks/Only.epub", durationMs: 0, fileCount: 0, narrator: "" });
    expect(only.book.cover).toBe(`.ribbon/covers/${only.book.id}.jpg`);
    expect(only.files).toEqual([]);
    expect(only.chapters).toEqual([]);
    // Kept in the records like any book.
    const loaded = await loadLibrary(nodeHost(), root);
    expect(readerOnly(byPath(loaded!, "Ebooks/Only.epub")!.book)).toBe(true);
  });

  it("pairs an EPUB in another folder by ISBN, and by title and author, and leaves an ambiguous one alone", async () => {
    const { books } = await scanLibrary(readingHost(), root);
    expect(byPath(books, "Audio/Voidscarred")!.book.ebook).toBe("Ebooks/void.epub");
    expect(byPath(books, "Audio/Horus Rising")!.book.ebook).toBe("Ebooks/hr.epub");
    expect(byPath(books, "Ebooks/void.epub")).toBeUndefined();
    expect(byPath(books, "Ebooks/hr.epub")).toBeUndefined();
    expect(byPath(books, "Audio/False Gods")!.book.ebook).toBeUndefined();
    expect(byPath(books, "Audio/False Gods (2006)")!.book.ebook).toBeUndefined();
    expect(readerOnly(byPath(books, "Ebooks/fg.epub")!.book)).toBe(true);
  });

  it("reads each EPUB once, and again only when it changes", async () => {
    const seen: string[] = [];
    await scanLibrary(readingHost(seen), root);
    expect(seen).toEqual([]);
    await fs.writeFile(path.join(root, "Ebooks", "Only.epub"), "PK changed");
    await scanLibrary(readingHost(seen), root);
    expect(seen).toEqual(["Only.epub"]);
  });
});

describe("a book that is only its EPUB, in the app", () => {
  let root = "";
  const model = {
    format: EBOOK_FORMAT,
    meta: { title: "The Lost Book", authors: ["Ann Writer"], identifiers: [] },
    layout: "reflowable",
    sections: [0, 1].map((i) => ({ href: `s${i}.xhtml`, linear: true, overlay: null, chars: 40, blocks: [{ k: "p", runs: [{ t: `Section ${i} has exactly forty letters in.` }] }] })),
    toc: [],
  };
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-reader-only-app-"));
    await fs.mkdir(path.join(root, "Ebooks"));
    await fs.writeFile(path.join(root, "Ebooks", "Only.epub"), "PK");
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("offers reading for playing, and is as far along as its reading place", async () => {
    const host: Host = { ...readingHost(), openEbook: async () => JSON.stringify(model) };
    const platform: Platform = { host, pickFolder: async () => root, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: memorySettings() };
    const c = new AppController(platform);
    await c.boot();
    await c.pickLibrary();
    const book = c.getState().books.find((b) => b.book.path === "Ebooks/Only.epub")!;
    const reading = (id: string) => c.readingProgress(id);
    expect(progressOf(book, c.getState(), reading)).toMatchObject({ started: false, finished: false, fraction: 0 });

    // Play opens the text; nothing is loaded to play, and the text is paired with no audio.
    await c.playBook(book);
    expect(c.getState().current).toBeNull();
    expect(c.getState().reading).toMatchObject({ bookId: book.book.id, status: "ready" });
    expect(c.getState().reading!.alignment).toBeUndefined();

    c.moveReading({ section: 1, block: 0, offset: 0 }, "seek");
    await c.closeReading();
    const p = progressOf(book, c.getState(), reading);
    expect(p.started).toBe(true);
    expect(p.fraction).toBeCloseTo(0.5, 1);
    expect(p.finished).toBe(false);

    await c.markFinished(book.book.id);
    expect(progressOf(book, c.getState(), reading).finished).toBe(true);
    c.destroy();
  });
});
