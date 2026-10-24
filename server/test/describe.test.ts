import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.ts";
import { BookIndex, bookDir, type StoredBook } from "../src/library/books.ts";
import { booksToDescribe, catalogTitles, describeBooks, matchProduct, summaryText, type Catalog, type CatalogProduct } from "../src/library/describe.ts";
import { readStored, writeStored } from "../src/library/prepare.ts";

/** Audible's summary of Mortis as its catalog sends it, cut short: HTML, with entities. */
const MORTIS_HTML = "<p>The Siege of Terra rages on.</p><p><b>The Emperor&#39;s Palace</b> burns &amp; the Lion&rsquo;s sons are far away.</p><p>Read by Jonathan Keeble.</p>";

const product = (asin: string, title: string, author: string, minutes: number | null): CatalogProduct => ({ asin, title, authors: [author], minutes });

describe("the catalog's summaries and titles", () => {
  it("turns a summary's HTML into paragraphs", () => {
    expect(summaryText(MORTIS_HTML)).toBe("The Siege of Terra rages on.\n\nThe Emperor's Palace burns & the Lion’s sons are far away.\n\nRead by Jonathan Keeble.");
    expect(summaryText("One<br>two<br/>three")).toBe("One\ntwo\nthree");
    expect(summaryText("")).toBe("");
  });

  it("asks by the book's own title, without a folder's number, then by what comes before its first colon", () => {
    expect(catalogTitles("01. Horus Rising")).toEqual(["Horus Rising"]);
    expect(catalogTitles("Raven's Flight: The Horus Heresy Series")).toEqual(["Raven's Flight: The Horus Heresy Series", "Raven's Flight"]);
    expect(catalogTitles("Mortis: The Horus Heresy: Siege of Terra, Book 5")).toEqual(["Mortis: The Horus Heresy: Siege of Terra, Book 5", "Mortis"]);
  });

  it("takes a recording by one of the book's authors, as long as it, the closest when several are", () => {
    const book = { author: "Dan Abnett", durationMs: 735 * 60_000 };
    // Another edition (an older reading, 9 hours) and a namesake by someone else are passed over.
    expect(matchProduct(book, [product("old", "Horus Rising", "Dan Abnett", 540), product("other", "Horus Rising", "Someone Else", 735), product("new", "Horus Rising", "Dan Abnett", 731)])?.asin).toBe("new");
    expect(matchProduct(book, [product("a", "Horus Rising", "Dan Abnett", 760), product("b", "Horus Rising", "Dan Abnett", 736)])?.asin).toBe("b");
    expect(matchProduct(book, [product("long", "Horus Rising", "Dan Abnett", 800), product("none", "Horus Rising", "Dan Abnett", null)])).toBeNull();
    // Any of several authors will do.
    expect(matchProduct({ author: "Graham McNeill & Dan Abnett", durationMs: 600 * 60_000 }, [product("x", "Book", "Dan Abnett", 601)])?.asin).toBe("x");
  });
});

/** A catalog that has only Mortis and Horus Rising, and notes what it's asked. */
function fakeCatalog(): Catalog & { asked: string[] } {
  const asked: string[] = [];
  const shelf = [product("1800266340", "Mortis", "John French", 986), product("hr", "Horus Rising", "Dan Abnett", 731)];
  return {
    asked,
    async search(title, author) {
      asked.push(`${title} / ${author}`);
      return shelf.filter((p) => p.title === title);
    },
    async summary(asin) {
      return asin === "1800266340" ? summaryText(MORTIS_HTML) : "Horus Rising, the first book of the Heresy.";
    },
  };
}

describe("describing the server's books", () => {
  let dir: string;
  let db: DatabaseSync;
  let index: BookIndex;

  /** A book as an import leaves it: its row in the list, its record in its folder. */
  async function add(id: string, book: Partial<StoredBook["book"]> & { title: string; author: string; minutes: number }, more: Partial<StoredBook> = {}): Promise<void> {
    db.prepare(
      `INSERT INTO book (id, fingerprint, title, author, narrator, series, series_index, duration_ms, size_bytes, has_audio, has_ebook, added_at)
       VALUES (?, ?, ?, ?, '', '', NULL, ?, 1000, 1, ?, 0)`,
    ).run(id, id, book.title, book.author, book.minutes * 60_000, book.ebook ? 1 : 0);
    mkdirSync(bookDir(dir, id), { recursive: true });
    const { minutes, ...rest } = book;
    await writeStored(dir, id, { book: { id, path: "", rawTitle: book.title, narrator: "", series: "", seriesIndex: null, year: null, cover: "", sizeBytes: 1000, fileCount: 1, ...rest, durationMs: minutes * 60_000 }, files: [], chapters: [], parts: [], cover: null, ...more } as StoredBook);
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-describe-"));
    db = openDatabase(dir);
    index = new BookIndex(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives a book with none the catalog's description, and leaves one that has its own alone", async () => {
    await add("mortis", { title: "Mortis: The Horus Heresy: Siege of Terra, Book 5", author: "John French", minutes: 986 });
    await add("hr", { title: "01. Horus Rising", author: "Dan Abnett", minutes: 735 });
    await add("voidscarred", { title: "Voidscarred: Warhammer 40,000", author: "Mike Brooks", minutes: 611, description: "Its own words." });
    const catalog = fakeCatalog();
    const ids = await booksToDescribe(dir, index);
    expect(ids.sort()).toEqual(["hr", "mortis"]);
    const done = await describeBooks(catalog, dir, ids, () => undefined, async () => undefined);
    expect(done).toMatchObject({ books: 2, done: 2, described: 2 });
    expect((await readStored(dir, "mortis"))?.book.description).toBe(summaryText(MORTIS_HTML));
    expect((await readStored(dir, "mortis"))?.described).toEqual({ asked: "Mortis: The Horus Heresy: Siege of Terra, Book 5|John French|986", asin: "1800266340" });
    expect((await readStored(dir, "hr"))?.book.description).toBe("Horus Rising, the first book of the Heresy.");
    expect((await readStored(dir, "voidscarred"))?.book.description).toBe("Its own words.");
    // Mortis was asked about by its full title first, then the short one; Voidscarred never.
    expect(catalog.asked).toEqual(["Horus Rising / Dan Abnett", "Mortis: The Horus Heresy: Siege of Terra, Book 5 / John French", "Mortis / John French"]);
    expect(await booksToDescribe(dir, index)).toEqual([]);
  });

  it("asks about a book the catalog lacks once, and again only when the book changes", async () => {
    await add("raven", { title: "Raven's Flight: The Horus Heresy Series", author: "Gav Thorpe", minutes: 69 });
    const catalog = fakeCatalog();
    await describeBooks(catalog, dir, await booksToDescribe(dir, index), () => undefined, async () => undefined);
    expect((await readStored(dir, "raven"))?.described).toEqual({ asked: "Raven's Flight: The Horus Heresy Series|Gav Thorpe|69", asin: null });
    expect((await readStored(dir, "raven"))?.book.description).toBeUndefined();
    expect(await booksToDescribe(dir, index)).toEqual([]);
    const stored = (await readStored(dir, "raven"))!;
    await writeStored(dir, "raven", { ...stored, book: { ...stored.book, title: "Raven's Flight" } });
    expect(await booksToDescribe(dir, index)).toEqual(["raven"]);
  });

  it("waits on a book's EPUB to be looked in first, and asks again next time when the catalog is out of reach", async () => {
    await add("epub", { title: "Echoes of Eternity", author: "Aaron Dembski-Bowden", minutes: 950, ebook: "book.epub" });
    expect(await booksToDescribe(dir, index)).toEqual([]);

    await add("a", { title: "01. Horus Rising", author: "Dan Abnett", minutes: 735 });
    await add("b", { title: "Mortis", author: "John French", minutes: 986 });
    await add("c", { title: "Galaxy in Flames", author: "Ben Counter", minutes: 531 });
    await add("d", { title: "Fulgrim", author: "Graham McNeill", minutes: 900 });
    let calls = 0;
    const away: Catalog = {
      search: async () => {
        calls++;
        throw new Error("Audible's catalog answered 503");
      },
      summary: async () => null,
    };
    const ids = await booksToDescribe(dir, index);
    const done = await describeBooks(away, dir, ids, () => undefined, async () => undefined);
    // Three in a row out of reach, and it stops: nothing is noted as asked, so all are asked next time.
    expect(calls).toBe(3);
    expect(done.described).toBe(0);
    expect((await booksToDescribe(dir, index)).sort()).toEqual(["a", "b", "c", "d"]);
  });
});
