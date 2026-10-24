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

/** The owner's shelf as their server lists it: Siege of Terra named only in its titles, in two orders, and two books of no series. */
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

  it("finds Siege of Terra in its titles, in order, as the list shows it, and nothing in the books of no series", () => {
    for (const title of SHELF) addBook(db, title);
    expect(series.find(books.list(), 1)).toBe(10);
    const [siege, ...others] = series.list();
    expect(others).toEqual([]);
    // Most of its titles put The Horus Heresy first.
    expect(siege).toMatchObject({ id: "siege-of-terra-the-horus-heresy", name: "The Horus Heresy: Siege of Terra" });
    expect(titlesOf(siege)).toEqual([
      "The Solar War",
      "The Lost and the Damned",
      "The First Wall",
      "Saturnine",
      "Mortis",
      "Warhawk",
      "Echoes of Eternity",
      "The End and the Death: Volume I",
      "The End and the Death: Volume II",
      "The End and the Death: Volume III",
    ]);
    expect(siege!.books.map((b) => b.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 8, 8]);
    expect(siege!.books.every((b) => b.shelved)).toBe(true);
    // Found once: looking again changes nothing.
    expect(series.find(books.list(), 2)).toBe(0);
  });

  it("puts a book that arrives later among the others by its number", () => {
    for (const title of SHELF.filter((t) => !t.startsWith("Saturnine"))) addBook(db, title);
    series.find(books.list(), 1);
    addBook(db, SHELF[3]!);
    expect(series.find(books.list(), 2)).toBe(1);
    expect(titlesOf(series.get("siege-of-terra-the-horus-heresy")).slice(2, 5)).toEqual(["The First Wall", "Saturnine", "Mortis"]);
  });

  it("keeps a person's changes when series are found again", () => {
    for (const title of SHELF) addBook(db, title);
    series.find(books.list(), 1);
    const siege = series.get("siege-of-terra-the-horus-heresy")!;
    // Renamed, Echoes of Eternity taken out, and the last volume left off the shelf.
    const kept = siege.books.filter((b) => !b.id.startsWith("Echoes")).map((b) => ({ id: b.id, number: b.number, ...(b.title?.endsWith("III") ? { shelved: false } : {}) }));
    series.save(siege.id, "Siege of Terra", kept, "admin", 2);
    expect(series.find(books.list(), 3)).toBe(0);
    const after = series.get(siege.id)!;
    expect(after.name).toBe("Siege of Terra");
    expect(after.books.map((b) => b.id)).not.toContain(SHELF[0]);
    expect(after.books.find((b) => b.title === "The End and the Death: Volume III")!.shelved).toBe(false);
  });

  it("doesn't find a series again once a person deleted it, and moves a book into a series a person makes", () => {
    for (const title of SHELF) addBook(db, title);
    series.find(books.list(), 1);
    const made = series.create("Warhammer 40,000", [{ id: "Voidscarred: Warhammer 40,000" }, { id: "Master of Rites: Warhammer 40,000" }, { id: SHELF[0]! }], "admin", 2)!;
    expect(made.books.map((b) => b.id)).toEqual(["Voidscarred: Warhammer 40,000", "Master of Rites: Warhammer 40,000", SHELF[0]]);
    // Echoes of Eternity left Siege of Terra for it, and isn't put back.
    expect(series.get("siege-of-terra-the-horus-heresy")!.books).toHaveLength(9);
    expect(series.find(books.list(), 3)).toBe(0);
    expect(series.drop("siege-of-terra-the-horus-heresy", "admin", 4)).toBe(true);
    expect(series.find(books.list(), 5)).toBe(0);
    expect(series.list().map((s) => s.id)).toEqual(["warhammer-40-000"]);
    expect(series.create("Nothing here", [{ id: "no such book" }], "admin", 6)).toBeNull();
    expect(series.list().map((s) => s.id)).toEqual(["warhammer-40-000"]);
  });

  it("goes with its books when they're all deleted", () => {
    for (const title of SHELF) addBook(db, title);
    series.find(books.list(), 1);
    for (const title of SHELF) books.remove(title, "admin", 2);
    expect(series.list()).toEqual([]);
    series.find(books.list(), 3);
    expect(db.prepare("SELECT count(*) AS n FROM series").get()!.n).toBe(0);
  });

  it("goes by a series tag over a title", () => {
    addBook(db, "Horus Rising", { series: "The Horus Heresy", index: 1 });
    addBook(db, "False Gods", { series: "The Horus Heresy", index: 2 });
    addBook(db, "Galaxy in Flames", { series: "The Horus Heresy", index: 3 });
    series.find(books.list(), 1);
    expect(series.list().map((s) => [s.name, titlesOf(s)])).toEqual([["The Horus Heresy", ["Horus Rising", "False Gods", "Galaxy in Flames"]]]);
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
