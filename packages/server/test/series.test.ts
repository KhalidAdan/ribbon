import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RibbonServer } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { BookIndex } from "../src/library/books.ts";
import { LibrarySeries, type ServerSeries } from "../src/library/series.ts";
import { serverWithAdmin } from "./fixture.ts";

/** The owner's shelf as their server lists it: Siege of Terra, its titles as a store writes them, and two books of no series. */
const SHELF = [
  "Echoes of Eternity: The Horus Heresy: Siege of Terra, Book 7",
  "Master of Rites: Warhammer 40,000",
  "Mortis: The Horus Heresy: Siege of Terra, Book 5",
  "Saturnine: Siege of Terra: The Horus Heresy, Book 4",
  "The End and the Death: Volume I: The Horus Heresy: Siege of Terra, Book 8",
  "The End and the Death: Volume II: The Horus Heresy: Siege of Terra, Book 8, Part 2",
  "The End and the Death: Volume III: The Horus Heresy: Siege of Terra, Book 8, Part 3",
  "The First Wall: Siege of Terra: The Horus Heresy, Book 3",
  "The Lost and the Damned: Siege of Terra: The Horus Heresy, Book 2",
  "The Solar War: Siege of Terra: The Horus Heresy, Book 1",
  "Voidscarred: Warhammer 40,000",
  "Warhawk: The Horus Heresy: Siege of Terra, Book 6",
];

/** A book on the server's list, as an import leaves it, with its title as its id. */
function addBook(db: DatabaseSync, title: string, tags: { series?: string; index?: number } = {}): void {
  db.prepare(
    `INSERT INTO book (id, fingerprint, title, author, narrator, series, series_index, duration_ms, size_bytes, has_audio, has_ebook, added_at)
     VALUES (?, ?, ?, 'Aaron Dembski-Bowden', '', ?, ?, 3600000, 1000, 1, 0, 0)`,
  ).run(title, title, title, tags.series ?? "", tags.index ?? null);
}

/** The shelf with Siege of Terra's books tagged as the series they are, each with its number; the other two with no tag. */
function addShelf(db: DatabaseSync, titles: readonly string[] = SHELF): void {
  for (const title of titles) {
    const number = /, Book (\d+)/.exec(title);
    addBook(db, title, number ? { series: "Siege of Terra", index: Number(number[1]) } : {});
  }
}

const SIEGE = "siege-of-terra";

const titlesOf = (s: ServerSeries | null | undefined) => s?.books.map((b) => b.title ?? b.id) ?? [];

describe("the library's series", () => {
  let dir: string;
  let db: DatabaseSync;
  let books: BookIndex;
  let series: LibrarySeries;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-series-"));
    db = openDatabase(dir);
    books = new BookIndex(db);
    series = new LibrarySeries(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds Siege of Terra by its series tag, in the order of its numbers, and nothing in the books of no series", () => {
    addShelf(db);
    expect(series.find(books.list(), 1)).toBe(10);
    const [siege, ...others] = series.list();
    expect(others).toEqual([]);
    expect(siege).toMatchObject({ id: SIEGE, name: "Siege of Terra" });
    expect(siege!.books.map((b) => b.id)).toEqual([SHELF[9], SHELF[8], SHELF[7], SHELF[3], SHELF[2], SHELF[11], SHELF[0], SHELF[4], SHELF[5], SHELF[6]]);
    expect(siege!.books.map((b) => b.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 8, 8]);
    expect(siege!.books.every((b) => b.shelved)).toBe(true);
    // Found once: looking again changes nothing.
    expect(series.find(books.list(), 2)).toBe(0);
  });

  it("never guesses a series from titles: books with no series tag are in none", () => {
    for (const title of SHELF) addBook(db, title);
    expect(series.find(books.list(), 1)).toBe(0);
    expect(series.list()).toEqual([]);
  });

  it("puts a book that arrives later among the others by its number", () => {
    addShelf(
      db,
      SHELF.filter((t) => !t.startsWith("Saturnine")),
    );
    series.find(books.list(), 1);
    addShelf(db, [SHELF[3]!]);
    expect(series.find(books.list(), 2)).toBe(1);
    expect(titlesOf(series.get(SIEGE)).slice(2, 5)).toEqual([SHELF[7], SHELF[3], SHELF[2]]);
  });

  it("keeps a person's changes when series are found again", () => {
    addShelf(db);
    series.find(books.list(), 1);
    const siege = series.get(SIEGE)!;
    // Renamed, Echoes of Eternity taken out, and the last volume left off the shelf.
    // Saved without numbers, as a device that didn't change them saves: each keeps its own.
    const kept = siege.books.filter((b) => !b.id.startsWith("Echoes")).map((b) => ({ id: b.id, ...(b.id === SHELF[6] ? { shelved: false } : {}) }));
    series.save(siege.id, "The Siege", kept, "admin", 2);
    expect(series.find(books.list(), 3)).toBe(0);
    const after = series.get(siege.id)!;
    expect(after.name).toBe("The Siege");
    expect(after.books.map((b) => b.id)).not.toContain(SHELF[0]);
    expect(after.books.find((b) => b.id === SHELF[6])!.shelved).toBe(false);
    expect(after.books.map((b) => b.number)).toEqual([1, 2, 3, 4, 5, 6, 8, 8, 8]);
  });

  it("brings a book into a series without the number and title it has in another, and leaves it in that one as it was", () => {
    addShelf(db);
    series.find(books.list(), 1);
    // Warhawk, given the title the series' list shows it by.
    const found = series.get(SIEGE)!;
    const siege = series.save(found.id, found.name, found.books.map((b) => (b.number === 6 ? { id: b.id, title: "Warhawk" } : { id: b.id })), "admin", 1)!;
    const sixth = siege.books.find((b) => b.number === 6)!;
    expect(sixth.title).toBe("Warhawk");
    // Put in a series a person made, saved with no number for it, as White Scars was.
    const made = series.create("White Scars", [{ id: "Voidscarred: Warhammer 40,000" }], "admin", 2)!;
    const brought = series.save(made.id, made.name, [{ id: "Voidscarred: Warhammer 40,000" }, { id: sixth.id }], "admin", 3)!;
    expect(brought.books.map((b) => [b.id, b.number, b.title])).toEqual([
      ["Voidscarred: Warhammer 40,000", null, null],
      [sixth.id, null, null],
    ]);
    expect(series.get(siege.id)!.books.find((b) => b.id === sixth.id)).toEqual(sixth);
    // Within its own series, a number left out is still kept, and a null clears it.
    series.save(made.id, made.name, [{ id: sixth.id, number: 2 }, { id: "Voidscarred: Warhammer 40,000" }], "admin", 4);
    expect(series.save(made.id, made.name, [{ id: sixth.id }, { id: "Voidscarred: Warhammer 40,000" }], "admin", 5)!.books[0]!.number).toBe(2);
    expect(series.save(made.id, made.name, [{ id: sixth.id, number: null }, { id: "Voidscarred: Warhammer 40,000" }], "admin", 6)!.books[0]!.number).toBeNull();
  });

  it("doesn't find a series again once a person deleted it, and keeps a book in its series when a person puts it in one they make", () => {
    addShelf(db);
    series.find(books.list(), 1);
    const made = series.create("Warhammer 40,000", [{ id: "Voidscarred: Warhammer 40,000" }, { id: "Master of Rites: Warhammer 40,000" }, { id: SHELF[0]! }], "admin", 2)!;
    expect(made.books.map((b) => b.id)).toEqual(["Voidscarred: Warhammer 40,000", "Master of Rites: Warhammer 40,000", SHELF[0]]);
    // Echoes of Eternity is in both.
    expect(series.get(SIEGE)!.books).toHaveLength(10);
    expect(series.find(books.list(), 3)).toBe(0);
    expect(series.drop(SIEGE, "admin", 4)).toBe(true);
    expect(series.find(books.list(), 5)).toBe(0);
    expect(series.list().map((s) => s.id)).toEqual(["warhammer-40-000"]);
    expect(series.create("Nothing here", [{ id: "no such book" }], "admin", 6)).toBeNull();
    expect(series.list().map((s) => s.id)).toEqual(["warhammer-40-000"]);
  });

  it("goes with its books when they're all deleted", () => {
    addShelf(db);
    series.find(books.list(), 1);
    for (const title of SHELF) books.remove(title, "admin", 2);
    expect(series.list()).toEqual([]);
    series.find(books.list(), 3);
    expect(db.prepare("SELECT count(*) AS n FROM series").get()!.n).toBe(0);
  });

  it("finds a series among books already in a reading list a person made, and keeps both", () => {
    addShelf(db);
    // The list is made before the server ever looked for series, as on a server where books arrive after it.
    const list = series.create("White Scars", [{ id: SHELF[11]! }, { id: SHELF[0]! }, { id: "Voidscarred: Warhammer 40,000" }], "admin", 1)!;
    expect(series.find(books.list(), 2)).toBe(10);
    expect(titlesOf(series.get(SIEGE))).toContain(SHELF[11]);
    expect(series.get(list.id)!.books.map((b) => b.id)).toEqual([SHELF[11], SHELF[0], "Voidscarred: Warhammer 40,000"]);
  });

  it("keeps a book named twice in a series once, where it's named first", () => {
    for (const title of SHELF) addBook(db, title);
    const made = series.create("White Scars", [{ id: SHELF[11]! }, { id: SHELF[0]! }, { id: SHELF[11]! }], "admin", 1)!;
    expect(made.books.map((b) => b.id)).toEqual([SHELF[11], SHELF[0]]);
  });
});

describe("a database from when a book could be in one series at most", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-series-upgrade-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Today's database with its series' books as they were kept then: each book's id UNIQUE. */
  function databaseAsItWas(): DatabaseSync {
    const db = openDatabase(dir);
    db.exec(`
      DROP TABLE series_book;
      CREATE TABLE series_book (
        series_id TEXT NOT NULL REFERENCES series (id) ON DELETE CASCADE,
        book_id TEXT NOT NULL UNIQUE REFERENCES book (id) ON DELETE CASCADE,
        position REAL NOT NULL,
        number REAL,
        title TEXT,
        shelved INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (series_id, book_id)
      );`);
    return db;
  }

  const WARHAWK = SHELF[11]!;
  const MORTIS = SHELF[2]!;

  it("lets a book into many series, and puts back the books a reading list took, but not those taken out by hand", () => {
    const old = databaseAsItWas();
    addShelf(old);
    new LibrarySeries(old).find(new BookIndex(old).list(), 1);
    // What the server did then: Warhawk put in White Scars left Siege of Terra for it, and Mortis was taken out by hand.
    old.exec(`
      INSERT INTO series (id, name, created_at, changed_at, changed_by) VALUES ('white-scars', 'White Scars', 2, 2, 'admin');
      DELETE FROM series_book WHERE book_id IN ('${WARHAWK}', '${MORTIS}');
      INSERT INTO series_book (series_id, book_id, position, number, title, shelved) VALUES ('white-scars', '${WARHAWK}', 1, NULL, NULL, 1);
      INSERT INTO series_left (series_id, book_id) VALUES ('siege-of-terra', '${WARHAWK}'), ('siege-of-terra', '${MORTIS}');`);
    old.close();

    const db = openDatabase(dir);
    const series = new LibrarySeries(db);
    // Found again, as the server does when it starts: Warhawk goes back by its number, and Mortis stays out.
    expect(series.find(new BookIndex(db).list(), 3)).toBe(1);
    const siege = series.get(SIEGE)!;
    expect(siege.books.map((b) => b.number)).toEqual([1, 2, 3, 4, 6, 7, 8, 8, 8]);
    expect(siege.books.find((b) => b.number === 6)).toMatchObject({ id: WARHAWK });
    expect(series.get("white-scars")!.books.map((b) => b.id)).toEqual([WARHAWK]);
    // And from now on a book can be in both.
    series.save("white-scars", "White Scars", [{ id: WARHAWK }, { id: SHELF[0]! }], "admin", 4);
    expect(series.get(SIEGE)!.books).toHaveLength(9);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'series_book_by_book'").get()).toBeDefined();
    const rows = db.prepare("SELECT count(*) AS n FROM series_book").get()!.n;
    db.close();

    // Once: opened again, nothing changes.
    const again = openDatabase(dir);
    expect(new LibrarySeries(again).find(new BookIndex(again).list(), 5)).toBe(0);
    expect(again.prepare("SELECT count(*) AS n FROM series_book").get()!.n).toBe(rows);
    expect(again.prepare("SELECT book_id FROM series_left").all().map((r) => r.book_id)).toEqual([MORTIS]);
    again.close();
  });
});

// The routes: anyone signed in reads the series; only the admin changes them, and every device hears of it.
describe("the series routes", () => {
  let dir: string;
  let server: RibbonServer;
  let admin = "";
  let member = "";

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-series-routes-"));
    const made = await serverWithAdmin(dir);
    server = made.server;
    admin = made.admin;
    const { code } = (await server.app.inject({ method: "POST", url: "/api/invites", headers: { authorization: `Bearer ${admin}` } })).json() as { code: string };
    member = ((await server.app.inject({ method: "POST", url: `/api/invites/${code}/accept`, payload: { name: "brother", password: "a long password" } })).json() as { token: string }).token;
    for (const title of SHELF.slice(0, 3)) addBook(server.db, title);
  }, 60_000);
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const as = (token: string | null, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
    server.app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}), headers: token ? { authorization: `Bearer ${token}` } : {} });
  const listed = async () => ((await as(member, "GET", "/api/series")).json() as { series: ServerSeries[] }).series;

  it("are the admin's to change and everyone's to read", async () => {
    expect((await as(null, "GET", "/api/series")).statusCode).toBe(401);
    expect(await listed()).toEqual([]);
    const books = [{ id: SHELF[2]! }, { id: SHELF[0]!, number: 7 }];
    expect((await as(member, "POST", "/api/series", { name: "Siege", books })).statusCode).toBe(403);
    expect((await as(admin, "POST", "/api/series", { name: "", books })).statusCode).toBe(400);
    expect((await as(admin, "POST", "/api/series", { name: "Siege", books: [{ id: 5 }] })).statusCode).toBe(400);
    const made = await as(admin, "POST", "/api/series", { name: "Siege", books });
    expect(made.statusCode).toBe(201);
    expect(await listed()).toEqual([{ id: "siege", name: "Siege", books: [{ id: SHELF[2], number: null, title: null, shelved: true }, { id: SHELF[0], number: 7, title: null, shelved: true }] }]);
  });

  it("is answered again only when it changed", async () => {
    const first = await as(member, "GET", "/api/series");
    const again = await server.app.inject({ method: "GET", url: "/api/series", headers: { authorization: `Bearer ${member}`, "if-none-match": String(first.headers.etag) } });
    expect(again.statusCode).toBe(304);
  });

  it("are changed and deleted by the admin", async () => {
    expect((await as(member, "PUT", "/api/series/siege", { name: "Siege of Terra", books: [] })).statusCode).toBe(403);
    expect((await as(admin, "PUT", "/api/series/nothing", { name: "Siege of Terra", books: [] })).statusCode).toBe(404);
    const saved = await as(admin, "PUT", "/api/series/siege", { name: "Siege of Terra", books: [{ id: SHELF[0]!, number: 7 }, { id: SHELF[1]!, shelved: false }] });
    expect(saved.statusCode).toBe(200);
    expect((await listed()).map((s) => [s.name, s.books.map((b) => [b.id, b.shelved])])).toEqual([
      [
        "Siege of Terra",
        [
          [SHELF[0], true],
          [SHELF[1], false],
        ],
      ],
    ]);
    expect((await as(member, "DELETE", "/api/series/siege")).statusCode).toBe(403);
    expect((await as(admin, "DELETE", "/api/series/siege")).statusCode).toBe(204);
    expect((await as(admin, "DELETE", "/api/series/siege")).statusCode).toBe(404);
    expect(await listed()).toEqual([]);
  });
});
