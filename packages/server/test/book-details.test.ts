import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EditValues, SharedEdits } from "@ribbon/core/edits";
import { comicInfoXml, makeComic } from "@ribbon/host-node/make-comic";
import { buildServer, type RibbonServer } from "../src/app.ts";
import type { ServerConfig } from "../src/config.ts";
import type { ListedBook, StoredBook } from "../src/library/books.ts";
import { tryComicMove } from "../src/library/comic-move-trial.ts";
import type { ServerSeries } from "../src/library/series.ts";
import { bookAsBefore } from "./before/comics.ts";
import { importAs, mp3, serverWithAdmin } from "./fixture.ts";

/**
 * A comic's own details on a server (docs/BOOK-DETAILS.md, section 4), over
 * comics made for the test: listed by the name and byline made from them,
 * labelled in its series, served and edited with them; and a server's data
 * from Ribbon 0.50.0, before comics had them, moved into them once, at
 * start, with its edits (section 6), and tried on a copy first.
 */

/** The made library: each comic's file, its pages (each a different count, so no two are the same file) and its ComicInfo.xml. */
const COMICS: { file: string; pages: number; info?: Record<string, string | number> }[] = [
  { file: "Made Up Saga/Made Up Saga 001 (2018).cbz", pages: 3 },
  {
    file: "Made Up Saga/anything.cbz",
    pages: 4,
    info: { Title: "The Long Way", Series: "Made Up Saga", Number: 2, Writer: "Ada Quill", Penciller: "Ben Nib", Colorist: "Cy Hue", Year: 2018, Month: 7, Web: "https://comicvine.gamespot.com/made-up-saga-2/4000-123456/" },
  },
  { file: "Made Up Saga/Made Up Saga Compendium.cbz", pages: 5, info: { Title: "Compendium One", Series: "Made Up Saga", Number: 1, Format: "TPB", Writer: "Ada Quill" } },
  { file: "Steel Giants/Steel Giants 007 (2024).cbz", pages: 7 },
  { file: "Steel Giants/Steel Giants 010 (2024).cbz", pages: 8 },
  { file: "Steel Giants/Steel Giants Vol. 1 (2024).cbz", pages: 6 },
  { file: "Paper Lanterns.cbz", pages: 2, info: { Writer: "Mo Brush", Manga: "YesAndRightToLeft" } },
  { file: "Ocean Pieces v03.cbz", pages: 9 },
];

const CONFIG = { host: "127.0.0.1", port: 0, url: "https://ribbon.example", secret: "a test secret of thirty-two chars!!" } satisfies Omit<ServerConfig, "dataDir">;

let dir: string;
let library: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "ribbon-book-details-"));
  library = path.join(dir, "library");
  mp3(path.join(library, "Ada Quill", "Red Book", "01.mp3"), { title: "Red Book", album: "Red Book", artist: "Ada Quill" });
  for (const c of COMICS) await makeComic(path.join(library, c.file), { pages: c.pages, ...(c.info ? { comicInfo: comicInfoXml(c.info) } : {}) });
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

/** Requests as the admin. */
function asAdmin(server: RibbonServer, token: string) {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return {
    get: (url: string) => server.app.inject({ method: "GET", url, headers }),
    put: (url: string, body: unknown) => server.app.inject({ method: "PUT", url, headers, payload: JSON.stringify(body) }),
    books: async () => ((await server.app.inject({ method: "GET", url: "/api/books", headers })).json() as { books: ListedBook[]; editFields?: string[] }),
    series: async () => ((await server.app.inject({ method: "GET", url: "/api/series", headers })).json() as { series: ServerSeries[] }).series,
    book: async (id: string) => (await server.app.inject({ method: "GET", url: `/api/books/${id}`, headers })).json() as StoredBook & { edited?: SharedEdits },
  };
}

describe("a comic added now", () => {
  let server: RibbonServer;
  let ask: ReturnType<typeof asAdmin>;
  let books: ListedBook[];
  const named = (title: string) => books.find((b) => b.title === title)!;

  beforeAll(async () => {
    const made = await serverWithAdmin(path.join(dir, "now"));
    server = made.server;
    ask = asAdmin(server, made.admin);
    await importAs(server, made.admin, library);
    books = (await ask.books()).books;
  }, 60_000);

  afterAll(async () => {
    await server.app.close();
    server.db.close();
  });

  it("is listed by the name and byline its details make, and nothing more", async () => {
    expect(books.map((b) => b.title).sort()).toEqual([
      "Made Up Saga #1",
      "Made Up Saga #2: The Long Way",
      "Made Up Saga Vol. 1: Compendium One",
      "Ocean Pieces Vol. 3",
      "Paper Lanterns",
      "Red Book",
      "Steel Giants #10",
      "Steel Giants #7",
      "Steel Giants Vol. 1",
    ]);
    expect(named("Made Up Saga #2: The Long Way")).toMatchObject({ author: "Ada Quill; Ben Nib", series: "Made Up Saga", seriesIndex: 2 });
    expect(named("Made Up Saga Vol. 1: Compendium One")).toMatchObject({ author: "Ada Quill", seriesIndex: 1 });
    expect(named("Paper Lanterns")).toMatchObject({ author: "Mo Brush", series: "", seriesIndex: null, rightToLeft: true });
    // The listing stays its size: a comic is listed with the fields any book is, its details kept for its own page.
    expect(Object.keys(named("Made Up Saga #2: The Long Way")).sort()).toEqual(Object.keys(named("Made Up Saga #1")).sort());
    expect(Object.keys(named("Made Up Saga #1"))).not.toContain("issue");
  });

  it("says which fields a book's edits may have here, so a desktop asks a comic for its own only where they're kept", async () => {
    const { editFields } = await ask.books();
    expect(editFields).toEqual(expect.arrayContaining(["title", "issue", "volume", "collects", "writers", "pencils", "coverArtists", "coverDate", "onSale", "storyArcs", "rightToLeft", "readAlong"]));
    expect(editFields).not.toContain("cover");
  });

  it("is labelled in its series as #2 or Vol. 1, and any other book isn't", async () => {
    const saga = (await ask.series()).find((s) => s.name === "Made Up Saga")!;
    // A collection is placed at its volume when it doesn't say which issues it holds: here beside #1.
    expect(saga.books.map((b) => [books.find((x) => x.id === b.id)!.title, b.number, b.label])).toEqual([
      ["Made Up Saga #1", 1, "#1"],
      ["Made Up Saga Vol. 1: Compendium One", 1, "Vol. 1"],
      ["Made Up Saga #2: The Long Way", 2, "#2"],
    ]);
  });

  it("is served with its own details: its people, its issue, its cover date, its ComicVine address and its story's name", async () => {
    const served = await ask.book(named("Made Up Saga #2: The Long Way").id);
    expect(served.book).toMatchObject({
      title: "Made Up Saga #2: The Long Way",
      rawTitle: "The Long Way",
      author: "Ada Quill; Ben Nib",
      issue: "2",
      coverDate: "2018-07",
      year: 2018,
      credits: { writers: ["Ada Quill"], pencils: ["Ben Nib"], colours: ["Cy Hue"] },
      comicvine: "4000-123456",
    });
    expect((await ask.book(named("Made Up Saga Vol. 1: Compendium One").id)).book).toMatchObject({ volume: "1", rawTitle: "Compendium One" });
    expect((await ask.book(named("Made Up Saga Vol. 1: Compendium One").id)).book.issue).toBeUndefined();
  });

  it("takes a comic's own details as edits, and every device names and labels it by them", async () => {
    const id = named("Steel Giants #7").id;
    const edits: EditValues = { issue: "", volume: "2", collects: "7–12", title: "Iron Dusk", writers: "Dana Pen", pencils: "Eli Ink; Fay Tint", colours: "Gil Line", coverDate: "July 2024", onSale: "2024-07-10", storyArcs: "Iron Dusk; The Long Fall" };
    expect((await ask.put(`/api/books/${id}/edits`, { values: edits })).statusCode).toBe(200);

    const listed = (await ask.books()).books.find((b) => b.id === id)!;
    expect(listed).toMatchObject({ title: "Steel Giants Vol. 2: Iron Dusk", author: "Dana Pen; Eli Ink; Fay Tint", seriesIndex: 7 });
    // What its files say for each field the listing shows: a comic's title is the story's name, and its file gives none.
    expect(listed.edited).toMatchObject({ values: edits, original: { title: "" } });

    const served = await ask.book(id);
    expect(served.book).toMatchObject({ title: "Steel Giants Vol. 2: Iron Dusk", rawTitle: "Iron Dusk", volume: "2", collects: "7–12", coverDate: "2024-07", year: 2024, onSale: "2024-07-10", storyArcs: ["Iron Dusk", "The Long Fall"] });
    expect(served.book.credits).toEqual({ writers: ["Dana Pen"], pencils: ["Eli Ink", "Fay Tint"], colours: ["Gil Line"] });
    expect(served.book.issue).toBeUndefined();
    expect(served.edited?.original).toMatchObject({ issue: "7", volume: "", title: "", coverDate: "2024", writers: "" });

    const giants = (await ask.series()).find((s) => s.name === "Steel Giants")!;
    expect(giants.books.find((b) => b.id === id)!.label).toBe("Vol. 2");
    // Taken back, it is what its file says again.
    await ask.put(`/api/books/${id}/edits`, { values: {} });
    expect((await ask.books()).books.find((b) => b.id === id)).toMatchObject({ title: "Steel Giants #7", author: "", seriesIndex: 7 });
  });
});

/**
 * A server's data as Ribbon 0.50.0 left it: the same comics, each named as
 * 0.50.0 named it (before/comics.ts), the book table without the columns
 * for a comic's own details, and the edits an assistant and a desktop made
 * then (the owner's Steel Giants, here made up: a title that is the name,
 * the number in the series, a byline, the credits in the description).
 */
describe("a server's comics from before they had details of their own", () => {
  let data: string;
  let ids: Record<string, string>;
  let token: string;
  /** The edits as 0.50.0 kept them, by the name each comic is listed by now. */
  const BEFORE: Record<string, EditValues> = {
    "Steel Giants #7": { title: "Steel Giants #7", series: "Steel Giants (2023)", seriesIndex: "7", author: "Dana Pen; Eli Ink", description: "Writer: Dana Pen. Artist: Eli Ink. In stores July 10, 2024." },
    "Steel Giants #10": { title: "Steel Giants #10", series: "Steel Giants (2023)", seriesIndex: "10", author: "Dana Pen; Eli Ink" },
    "Steel Giants Vol. 1": { title: "Steel Giants Vol. 1 (#1–#6)", subtitle: "Iron Dawn", series: "Steel Giants (2023)", seriesIndex: "1", author: "Dana Pen; Eli Ink" },
    "Made Up Saga #1": { author: "Ada Quill; Ben Nib", year: "2019" },
    "Made Up Saga #2: The Long Way": { title: "The Long Way Home" },
    "Ocean Pieces Vol. 3": { subtitle: "The Deep Current" },
    "Paper Lanterns": { rightToLeft: "no" },
  };

  const start = () => buildServer({ ...CONFIG, dataDir: data });
  const stop = async (server: RibbonServer) => {
    await server.app.close();
    server.db.close();
  };
  const raw = (sql: string, ...args: string[]) => {
    const db = new DatabaseSync(path.join(data, "ribbon.db"));
    try {
      return db.prepare(sql).all(...args);
    } finally {
      db.close();
    }
  };
  const editsOf = (name: string) => raw("SELECT edits, edits_before_move FROM book_edit WHERE book_id = ?", ids[name]!)[0] as { edits: string; edits_before_move: string | null } | undefined;
  const stored = (name: string) => JSON.parse(readFileSync(path.join(data, "books", ids[name]!, "book.json"), "utf8")) as StoredBook;
  const ocean = () => path.join(data, "books", ids["Ocean Pieces Vol. 3"]!, "book.cbz");

  beforeAll(async () => {
    const made = await serverWithAdmin(path.join(dir, "before"));
    data = path.join(dir, "before", "data");
    token = made.admin;
    await importAs(made.server, made.admin, library);
    ids = Object.fromEntries(made.server.books.list().map((b) => [b.title, b.id]));
    // Each comic's book.json and its row as 0.50.0 kept them, and the edits made then.
    for (const c of COMICS) {
      const name = Object.keys(ids).find((n) => made.server.books.get(ids[n]!)!.pages === c.pages && made.server.books.get(ids[n]!)!.comic)!;
      const file = path.join(data, "books", ids[name]!, "book.json");
      const now = JSON.parse(readFileSync(file, "utf8")) as StoredBook;
      const parts = c.file.split("/");
      const book = bookAsBefore(now.book, c.info, path.basename(c.file, ".cbz"), parts.length > 1 ? parts.at(-2)! : "");
      writeFileSync(file, JSON.stringify({ ...now, book }, null, 2));
      made.server.db.prepare("UPDATE book SET title = ?, author = ?, series = ?, series_index = ? WHERE id = ?").run(book.title, book.author, book.series, book.seriesIndex, ids[name]!);
      if (BEFORE[name]) made.server.books.saveEdits(ids[name]!, { values: BEFORE[name], updatedAt: "2026-11-20T10:00:00.000Z" }, null);
    }
    made.server.db.exec("ALTER TABLE book DROP COLUMN details; ALTER TABLE book_edit DROP COLUMN edits_before_move");
    await stop(made.server);
  }, 60_000);

  it("is named as 0.50.0 named it, before the move", () => {
    const rows = raw("SELECT id, title, author FROM book WHERE has_comic = 1 ORDER BY title") as { title: string; author: string }[];
    expect(rows.map((r) => r.title)).toEqual(["Compendium One", "Made Up Saga #1", "Ocean Pieces #3", "Paper Lanterns", "Steel Giants #1", "Steel Giants #10", "Steel Giants #7", "The Long Way"]);
    expect(stored("Steel Giants Vol. 1").book).toMatchObject({ title: "Steel Giants #1", rawTitle: "Steel Giants #1", seriesIndex: 1 });
    expect(stored("Steel Giants Vol. 1").book.volume).toBeUndefined();
  });

  it("is tried on a copy first: every comic before and after, and nothing written to the server's data", async () => {
    const files = (folder: string): string[] => readdirSync(folder, { recursive: true, withFileTypes: true }).flatMap((e) => (e.isFile() ? [path.join(e.parentPath, e.name)] : []));
    const sums = () => Object.fromEntries(files(data).map((f) => [f, `${statSync(f).mtimeMs}:${createHash("sha256").update(readFileSync(f)).digest("hex")}`]));
    const before = sums();
    const copy = path.join(dir, "trial");
    const trial = await tryComicMove(data, copy);
    expect(sums()).toEqual(before);

    expect(trial).toMatchObject({ read: 8, moved: 4 });
    const vol = trial.comics.find((c) => c.id === ids["Steel Giants Vol. 1"])!;
    expect(vol.before).toMatchObject({ name: "Steel Giants Vol. 1 (#1–#6)", series: "Steel Giants (2023)", number: 1 });
    expect(vol.after).toMatchObject({ name: "Steel Giants Vol. 1: Iron Dawn", by: "Dana Pen; Eli Ink", is: "a collection: volume 1, collects 1–6", title: "Iron Dawn", label: "Vol. 1", place: 1 });
    expect(trial.lines.join("\n")).toContain("  after   name    Steel Giants Vol. 1: Iron Dawn");
    expect(trial.lines.at(-1)).toBe("8 comics: 8 read again, and the edits of 4 moved; 0 couldn't be read.");
    // The copy is the data as the move leaves it: each comic's record copied and moved, its file read where it is.
    const copied = new DatabaseSync(path.join(copy, "ribbon.db"));
    expect(copied.prepare("SELECT count(*) AS n FROM book WHERE has_comic = 1 AND details IS NOT NULL").get()).toEqual({ n: 8 });
    copied.close();
    expect(readdirSync(path.join(copy, "books")).sort()).toEqual(trial.comics.map((c) => c.id).sort());
    expect(lstatSync(path.join(copy, "books", vol.id, "book.cbz")).isSymbolicLink()).toBe(true);
    await expect(tryComicMove(data, copy)).rejects.toThrow(/isn't empty/);
    await expect(tryComicMove(data, path.join(data, "inside"))).rejects.toThrow(/outside/);
  });

  it("moves every comic's details and edits in one transaction at start, or none of them", async () => {
    // One comic's file is missing from here on: it is left as it was, and read at a later start.
    renameSync(ocean(), `${ocean()}.away`);
    // A start that fails partway, at the last comic it moves: no comic is moved.
    const last = (raw("SELECT id FROM book WHERE has_comic = 1 AND id <> ?", ids["Ocean Pieces Vol. 3"]!).at(-1) as { id: string }).id;
    raw(`CREATE TRIGGER stop_the_move BEFORE UPDATE ON book WHEN NEW.id = '${last}' BEGIN SELECT RAISE(ABORT, 'stopped'); END`);
    await expect(start()).rejects.toThrow(/stopped/);
    raw("DROP TRIGGER stop_the_move");
    expect(raw("SELECT count(*) AS n FROM book WHERE details IS NOT NULL")[0]).toEqual({ n: 0 });
    for (const name of Object.keys(BEFORE)) expect(editsOf(name)).toEqual({ edits: JSON.stringify(BEFORE[name]), edits_before_move: null });
  });

  it("names each comic from its details at the next start, its edits moved and kept as they were beside them", async () => {
    const server = await start();
    const ask = asAdmin(server, token);
    try {
      const listed = Object.fromEntries((await ask.books()).books.filter((b) => b.comic).map((b) => [b.id, b]));
      const shown = (name: string) => listed[ids[name]!]!;
      expect(shown("Steel Giants #7")).toMatchObject({ title: "Steel Giants #7", author: "Dana Pen; Eli Ink", series: "Steel Giants (2023)", seriesIndex: 7 });
      expect(shown("Steel Giants #10")).toMatchObject({ title: "Steel Giants #10", seriesIndex: 10 });
      expect(shown("Steel Giants Vol. 1")).toMatchObject({ title: "Steel Giants Vol. 1: Iron Dawn", author: "Dana Pen; Eli Ink", seriesIndex: 1 });
      expect(shown("Made Up Saga #1")).toMatchObject({ title: "Made Up Saga #1", author: "Ada Quill; Ben Nib", seriesIndex: 1 });
      expect(shown("Made Up Saga #2: The Long Way")).toMatchObject({ title: "Made Up Saga #2: The Long Way Home", author: "Ada Quill; Ben Nib", seriesIndex: 2 });
      expect(shown("Made Up Saga Vol. 1: Compendium One")).toMatchObject({ title: "Made Up Saga Vol. 1: Compendium One", author: "Ada Quill", seriesIndex: 1 });
      expect(shown("Paper Lanterns")).toMatchObject({ title: "Paper Lanterns", author: "Mo Brush", seriesIndex: null });
      expect(shown("Paper Lanterns").rightToLeft).toBeUndefined();
      expect(shown("Ocean Pieces Vol. 3")).toMatchObject({ title: "Ocean Pieces #3", seriesIndex: 3 });

      // The edits moved: the name the shelf makes dropped, the number an issue or a volume, a byline kept.
      expect(JSON.parse(editsOf("Steel Giants #7")!.edits)).toEqual({ series: "Steel Giants (2023)", author: "Dana Pen; Eli Ink", description: BEFORE["Steel Giants #7"]!.description, issue: "7" });
      expect(JSON.parse(editsOf("Steel Giants Vol. 1")!.edits)).toEqual({ series: "Steel Giants (2023)", author: "Dana Pen; Eli Ink", volume: "1", collects: "1–6", issue: "", title: "Iron Dawn" });
      expect(JSON.parse(editsOf("Made Up Saga #1")!.edits)).toEqual(BEFORE["Made Up Saga #1"]);
      // Kept as they were beside them, for a release: a comic whose edits are already in the new shape too.
      for (const name of ["Steel Giants #7", "Steel Giants #10", "Steel Giants Vol. 1", "Made Up Saga #1", "Made Up Saga #2: The Long Way", "Paper Lanterns"]) expect(JSON.parse(editsOf(name)!.edits_before_move!)).toEqual(BEFORE[name]);
      // Its edits made when they were, not when they were moved.
      expect(listed[ids["Steel Giants #7"]!]!.edited!.updatedAt).toBe("2026-11-20T10:00:00.000Z");

      // Its record is in the new shape: its issue or volume read back from its number, its story's name apart.
      expect(stored("Steel Giants Vol. 1").book).toMatchObject({ title: "Steel Giants #1", rawTitle: "", issue: "1", seriesIndex: 1, coverDate: "2024" });
      expect(stored("Made Up Saga #2: The Long Way").book).toMatchObject({ title: "Made Up Saga #2: The Long Way", rawTitle: "The Long Way", issue: "2", coverDate: "2018-07", credits: { writers: ["Ada Quill"], pencils: ["Ben Nib"], colours: ["Cy Hue"] }, comicvine: "4000-123456" });
      expect(stored("Made Up Saga Vol. 1: Compendium One").book).toMatchObject({ volume: "1", rawTitle: "Compendium One" });
      expect(stored("Paper Lanterns").book).toMatchObject({ rawTitle: "Paper Lanterns", credits: { writers: ["Mo Brush"] } });

      // Served with its own details as edited, and labelled in its series.
      expect((await ask.book(ids["Steel Giants Vol. 1"]!)).book).toMatchObject({ title: "Steel Giants Vol. 1: Iron Dawn", volume: "1", collects: "1–6", rawTitle: "Iron Dawn" });
      expect((await ask.book(ids["Steel Giants Vol. 1"]!)).book.issue).toBeUndefined();
      const giants = (await ask.series()).find((s) => s.name === "Steel Giants (2023)")!;
      expect(giants.books.map((b) => [b.id, b.label])).toEqual([
        [ids["Steel Giants Vol. 1"], "Vol. 1"],
        [ids["Steel Giants #7"], "#7"],
        [ids["Steel Giants #10"], "#10"],
      ]);

      // The one not read: as it was, its record, its name and its edits.
      expect(editsOf("Ocean Pieces Vol. 3")).toEqual({ edits: JSON.stringify(BEFORE["Ocean Pieces Vol. 3"]), edits_before_move: null });
      expect(stored("Ocean Pieces Vol. 3").book).toMatchObject({ title: "Ocean Pieces #3", rawTitle: "Ocean Pieces #3", seriesIndex: 3 });
      expect(stored("Ocean Pieces Vol. 3").book.issue).toBeUndefined();
      expect((await ask.book(ids["Ocean Pieces Vol. 3"]!)).book).toMatchObject({ title: "Ocean Pieces #3", subtitle: "The Deep Current" });
    } finally {
      await stop(server);
    }
  });

  it("reads a comic missed before at a later start, and moves nothing twice", async () => {
    renameSync(`${ocean()}.away`, ocean());
    const before = raw("SELECT book_id, edits, edits_before_move, updated_at FROM book_edit ORDER BY book_id");
    const server = await start();
    try {
      expect(server.books.get(ids["Ocean Pieces Vol. 3"]!)).toMatchObject({ title: "Ocean Pieces #3: The Deep Current", seriesIndex: 3 });
      expect(JSON.parse(editsOf("Ocean Pieces Vol. 3")!.edits)).toEqual({ title: "The Deep Current" });
      expect(JSON.parse(editsOf("Ocean Pieces Vol. 3")!.edits_before_move!)).toEqual(BEFORE["Ocean Pieces Vol. 3"]);
      const after = raw("SELECT book_id, edits, edits_before_move, updated_at FROM book_edit ORDER BY book_id");
      expect(after.filter((row) => row.book_id !== ids["Ocean Pieces Vol. 3"])).toEqual(before.filter((row) => row.book_id !== ids["Ocean Pieces Vol. 3"]));
      expect(server.books.get(ids["Steel Giants Vol. 1"]!)!.title).toBe("Steel Giants Vol. 1: Iron Dawn");
    } finally {
      await stop(server);
    }
  });
});
