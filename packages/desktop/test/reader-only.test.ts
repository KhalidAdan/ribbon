import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { nodeHost } from "@ribbon/host-node/node";
import type { Host } from "@ribbon/core/host";
import { loadLibrary, scanLibrary, type ScannedBook } from "@ribbon/core/scan/scan";
import { authorKeys, bytesToEbooks, ebooksCsvIsCurrent, ebooksToBytes, isbn13, pairByMetadata, titleKeys, type EbookPackage } from "@ribbon/core/scan/ebooks";
import { EBOOK_FORMAT, readerOnly } from "@ribbon/core/ebook";
import { detectSeries } from "@ribbon/core/series";
import { EDIT_FIELDS, fieldText } from "@ribbon/core/edits";
import { formFields } from "@ribbon/core/edit-form";
import { bookKind } from "@ribbon/core/kind";
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
    const e: EbookPackage = { path: "Ebooks/A.epub", sizeBytes: 10, mtimeMs: 20, title: "A, the book", authors: ["Mike Brooks", "Dan Abnett"], isbns: ["9781836093152"], language: "en", publisher: "Black Library", date: "2025-08-05", description: "Line one.\nLine two.", hasCover: true, series: "Made Up Saga", seriesIndex: 2.5, subjects: ["Fantasy", "Science Fiction"], translators: ["Tom Turner", "Lee, Ann"] };
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

/** A package's metadata as the Rust scanner hands it over (`opf`): Calibre's EPUB 2, with made-up names. */
const calibre = (title: string, n: number) =>
  `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"><dc:title>${title}</dc:title><dc:creator opf:role="aut">Ann Writer</dc:creator><dc:creator opf:role="trl">Tom Turner</dc:creator><dc:subject>Fantasy</dc:subject><meta name="calibre:series" content="Made Up Saga"/><meta name="calibre:series_index" content="${n}"/></metadata>`;

/** The same, as an EPUB 3 publisher writes it. */
const epub3 = (title: string, n: number) =>
  `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator id="a">Ann Writer</dc:creator><meta refines="#a" property="role" scheme="marc:relators">aut</meta><dc:creator id="t">Lee, Ann</dc:creator><meta refines="#t" property="role" scheme="marc:relators">trl</meta><dc:subject>Science Fiction</dc:subject><meta property="belongs-to-collection" id="s">Made Up Saga</meta><meta refines="#s" property="collection-type">series</meta><meta refines="#s" property="group-position">${n}</meta></metadata>`;

/** What the Rust scanner would read of each EPUB with details of its own, by file name. */
const OWN: Record<string, { tags: Record<string, string>; hasCover: boolean }> = {
  "Lantern 1.epub": { tags: { title: "The Lantern Road", author: "Ann Writer", opf: calibre("The Lantern Road", 1) }, hasCover: false },
  "Lantern 2.epub": { tags: { title: "The Harbour Signal", author: "Ann Writer", opf: epub3("The Harbour Signal", 2) }, hasCover: false },
  "Lantern 3.epub": { tags: { title: "The Winter Tide", author: "Ann Writer", opf: calibre("The Winter Tide", 3) }, hasCover: false },
  "Plain.epub": { tags: { title: "A Plain Book", author: "Ann Writer", opf: "<metadata><dc:title>A Plain Book</dc:title></metadata>" }, hasCover: false },
  // Beside an audiobook, which its tags name.
  "Heard.epub": { tags: { title: "Heard Aloud", author: "Ann Writer", opf: calibre("Heard Aloud", 4) }, hasCover: false },
};

function ownHost(seen: string[] = [], before: () => Promise<void> = async () => undefined): Host {
  return nodeHost({
    async readEbookPackage(p) {
      await before();
      seen.push(path.basename(p));
      return OWN[path.basename(p)] ?? null;
    },
  });
}

describe("an EPUB's own series, genres and translators (docs/BOOK-DETAILS.md, section 2, \"A text\")", () => {
  let root = "";
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-epub-own-"));
    await fs.mkdir(path.join(root, "Texts"));
    for (const name of Object.keys(OWN).filter((n) => n !== "Heard.epub")) await fs.writeFile(path.join(root, "Texts", name), `PK ${name}`);
    await mp3(path.join(root, "Audio", "Heard Aloud", "01.mp3"), { album: "Heard Aloud", artist: "Ann Writer" });
    await fs.writeFile(path.join(root, "Audio", "Heard Aloud", "Heard.epub"), "PK Heard.epub");
  }, 60_000);
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const byPath = (books: ScannedBook[], p: string) => books.find((b) => b.book.path === p)!.book;

  it("gives an EPUB alone its package's series and place, genres and translators", async () => {
    const { books } = await scanLibrary(ownHost(), root);
    expect(byPath(books, "Texts/Lantern 1.epub")).toMatchObject({ title: "The Lantern Road", series: "Made Up Saga", seriesIndex: 1, genres: ["Fantasy"], credits: { translators: ["Tom Turner"] } });
    expect(byPath(books, "Texts/Lantern 2.epub")).toMatchObject({ series: "Made Up Saga", seriesIndex: 2, genres: ["Science Fiction"], credits: { translators: ["Lee, Ann"] } });
    const plain = byPath(books, "Texts/Plain.epub");
    expect(plain).toMatchObject({ series: "", seriesIndex: null });
    expect(plain.genres).toBeUndefined();
    expect(plain.credits).toBeUndefined();
    // So the three make a series on the shelf, as tagged audiobooks do.
    expect(detectSeries(books.map((b) => b.book), "Library").map((g) => [g.name, g.bookIds.length])).toEqual([["Made Up Saga", 3]]);
    // And the series is in library.csv, so the first paint shows it before a file is looked at.
    const loaded = await loadLibrary(nodeHost(), root);
    expect(byPath(loaded!, "Texts/Lantern 1.epub")).toMatchObject({ series: "Made Up Saga", seriesIndex: 1 });
  });

  it("leaves an audiobook named by its tags, though its EPUB names a series", async () => {
    const { books } = await scanLibrary(ownHost(), root);
    const heard = byPath(books, "Audio/Heard Aloud");
    expect(heard.ebook).toBe("Audio/Heard Aloud/Heard.epub");
    expect(heard).toMatchObject({ series: "", seriesIndex: null });
    expect(heard.credits).toBeUndefined();
  });

  it("reads every package once more when ebooks.csv is from before, showing each as it was until it is read, and then not again", async () => {
    await scanLibrary(ownHost(), root);
    // ebooks.csv as Ribbon 0.50.0 wrote it: no series, subjects or translators.
    const csv = path.join(root, ".ribbon", "ebooks.csv");
    const kept = await bytesToEbooks(await fs.readFile(csv));
    const header = "path,size_bytes,mtime_ms,title,authors,isbn,language,publisher,date,description,has_cover";
    await fs.writeFile(csv, [header, ...[...kept.values()].map((e) => `"${e.path}",${e.sizeBytes},${e.mtimeMs},"${e.title}","${e.authors.join("; ")}",,,,,,0`)].join("\n") + "\n");

    // No package is read until the shelf is out.
    const seen: string[] = [];
    let painted!: () => void;
    const shelfOut = new Promise<void>((resolve) => (painted = resolve));
    const shelves: ScannedBook[][] = [];
    const { books } = await scanLibrary(
      ownHost(seen, () => shelfOut),
      root,
      {
        onBooks: (b) => {
          shelves.push(b);
          painted();
        },
      },
    );
    // The first shelf has every text alone, as ebooks.csv kept it; none goes missing while its package is read.
    const first = shelves[0]!;
    expect(byPath(first, "Texts/Lantern 1.epub")).toMatchObject({ title: "The Lantern Road", series: "" });
    expect(byPath(first, "Audio/Heard Aloud").ebook).toBe("Audio/Heard Aloud/Heard.epub");
    expect([...seen].sort()).toEqual(Object.keys(OWN).sort());
    expect(byPath(books, "Texts/Lantern 1.epub")).toMatchObject({ series: "Made Up Saga", seriesIndex: 1, credits: { translators: ["Tom Turner"] } });

    // Kept in the new columns: the next scan opens nothing.
    expect(ebooksCsvIsCurrent(await fs.readFile(csv))).toBe(true);
    const again: string[] = [];
    await scanLibrary(ownHost(again), root);
    expect(again).toEqual([]);
  });

  it("keeps what was read of an unchanged EPUB when reading it again brings nothing back", async () => {
    await scanLibrary(ownHost(), root);
    const csv = path.join(root, ".ribbon", "ebooks.csv");
    const kept = await bytesToEbooks(await fs.readFile(csv));
    const header = "path,size_bytes,mtime_ms,title,authors,isbn,language,publisher,date,description,has_cover";
    await fs.writeFile(csv, [header, ...[...kept.values()].map((e) => `"${e.path}",${e.sizeBytes},${e.mtimeMs},"${e.title}","${e.authors.join("; ")}",,,,,,0`)].join("\n") + "\n");
    // A share that drops while the packages are read: the scanner sends the file back read, with nothing in it.
    const dropped: Host = { ...nodeHost(), scan: (r, known, onProgress, onFiles) => nodeHost({ readEbookPackage: async () => ({ tags: {}, hasCover: false }) }).scan(r, known, onProgress, onFiles) };
    const { books } = await scanLibrary(dropped, root);
    expect(byPath(books, "Texts/Lantern 1.epub")).toMatchObject({ title: "The Lantern Road", author: "Ann Writer" });
  });
});

describe("a text's translators in the app (docs/BOOK-DETAILS.md, section 5)", () => {
  let root = "";
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-epub-translators-"));
    await fs.mkdir(path.join(root, "Texts"));
    await fs.writeFile(path.join(root, "Texts", "Lantern 1.epub"), "PK Lantern 1.epub");
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("shows the package's translators in the text's form, keeps an edit to them, and takes it back", async () => {
    const platform: Platform = { host: ownHost(), pickFolder: async () => root, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: memorySettings() };
    const c = new AppController(platform);
    await c.boot();
    await c.pickLibrary();
    const text = () => c.getState().books.find((b) => b.book.path === "Texts/Lantern 1.epub")!;
    const id = text().book.id;
    expect(bookKind(text().book)).toBe("text");
    expect(formFields("text")).toContain("translators");

    // The form as EditBook fills it: every field as the book shows it.
    const form = Object.fromEntries(EDIT_FIELDS.filter((f) => f !== "cover").map((f) => [f, fieldText(text().book, f)]));
    expect(form.translators).toBe("Tom Turner");
    expect(form.series).toBe("Made Up Saga");

    // A person adds a translator and puts the book in a series of their own: their word stands over the package's.
    await c.saveEdits(id, { ...form, translators: "Tom Turner; Ann Lee", series: "My Own Shelf" });
    expect(text().book.credits).toEqual({ translators: ["Tom Turner", "Ann Lee"] });
    expect(text().book.series).toBe("My Own Shelf");
    expect(text().original?.credits).toEqual({ translators: ["Tom Turner"] });
    const saved = await fs.readFile(path.join(root, ".ribbon", "edits", `${id}.csv`), "utf8");
    expect(saved).toContain("translators,Tom Turner; Ann Lee,");
    expect(saved).not.toContain("genres");

    // And it survives a rescan, which reads the package's again beneath it.
    await c.rescan(true);
    expect(text().book.credits).toEqual({ translators: ["Tom Turner", "Ann Lee"] });

    await c.resetEdits(id, "translators");
    expect(text().book.credits).toEqual({ translators: ["Tom Turner"] });
    expect(text().book.series).toBe("My Own Shelf");
    await c.resetEdits(id);
    expect(text().book.series).toBe("Made Up Saga");
    c.destroy();
  });
});

describe("an EPUB's own series in the app, beside the ones a person makes", () => {
  let root = "";
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-epub-series-"));
    await fs.mkdir(path.join(root, "Texts"));
    for (const name of ["Lantern 1.epub", "Lantern 2.epub", "Lantern 3.epub", "Plain.epub"]) await fs.writeFile(path.join(root, "Texts", name), `PK ${name}`);
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const platform = (): Platform => ({ host: ownHost(), pickFolder: async () => root, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources(), appSettings: memorySettings() });

  it("is a series on the shelf, a text may be in one made by hand as well, and one deleted stays deleted though the packages name it", async () => {
    const c = new AppController(platform());
    await c.boot();
    await c.pickLibrary();
    const idOf = (file: string) => c.getState().books.find((b) => b.book.path === `Texts/${file}`)!.book.id;
    const saga = c.detectedSeries().find((g) => g.name === "Made Up Saga")!;
    expect(saga.bookIds).toEqual(["Lantern 1.epub", "Lantern 2.epub", "Lantern 3.epub"].map(idOf));
    expect(saga.numbers).toEqual({ [idOf("Lantern 1.epub")]: 1, [idOf("Lantern 2.epub")]: 2, [idOf("Lantern 3.epub")]: 3 });

    // A reading list made by hand, with a text from the saga in it: the book is in both.
    await c.createSeries("Read This Winter", [idOf("Plain.epub"), idOf("Lantern 1.epub")]);
    expect(c.detectedSeries().map((g) => g.name).sort()).toEqual(["Made Up Saga", "Read This Winter"]);

    // Deleted, the saga doesn't come back from the packages, on a rescan or the next start.
    await c.deleteSeries(saga.key);
    await c.rescan(true);
    expect(c.detectedSeries().map((g) => g.name)).toEqual(["Read This Winter"]);
    c.destroy();
    const again = new AppController(platform());
    await again.pickLibrary();
    // A cached library is scanned again behind the shelf: wait for it, so the packages have had their say.
    const started = Date.now();
    while (again.getState().scanning !== null || again.getState().lastScanMs === null) {
      if (Date.now() - started > 60_000) throw new Error("timed out waiting for the rescan");
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(again.detectedSeries().map((g) => g.name)).toEqual(["Read This Winter"]);
    again.destroy();
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
    expect(c.getState().reading).toMatchObject({ alignment: null });

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
