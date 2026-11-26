import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeComic } from "@ribbon/host-node/make-comic";
import type { SharedEdits } from "@ribbon/core/edits";
import type { RibbonServer } from "../src/app.ts";
import type { ListedBook, StoredBook } from "../src/library/books.ts";
import type { ServerSeries } from "../src/library/series.ts";
import { importAs, serverWithAdmin } from "./fixture.ts";

/**
 * A comic's details and its cover set by an assistant through the MCP
 * (docs/COMICS.md, section 4), by the names of a comic's own details
 * (docs/BOOK-DETAILS.md, section 5), over comics made for the test: kept
 * as the desktop's edit form keeps them, so every device lists the comic
 * as corrected, and a person can take any of it back.
 */
describe("a comic's details, set through the MCP", () => {
  let dir: string;
  let server: RibbonServer;
  let admin: string;
  let comics: ListedBook[];
  const heard: { type: string }[] = [];

  const as = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
  const get = (url: string) => server.app.inject({ method: "GET", url, headers: as(admin) });
  const mcp = async (method: string, params: unknown) => (await server.app.inject({ method: "POST", url: "/mcp", headers: as(admin), payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json().result;
  const call = async (name: string, args: unknown) => (await mcp("tools/call", { name, arguments: args })) as { content: { type: string; text?: string; data?: string }[]; isError?: boolean };
  const words = (answer: { content: { type: string; text?: string }[] }) => answer.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const details = async (book: string, given?: Record<string, unknown>) => JSON.parse(words(await call(given ? "set_details" : "comic_details", { book, ...(given ? { details: given } : {}) }))) as Record<string, unknown>;
  const listed = async () => ((await get("/api/books")).json() as { books: ListedBook[] }).books;
  const served = async (id: string) => (await get(`/api/books/${id}`)).json() as StoredBook & { edited?: SharedEdits };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-comic-details-"));
    const shelf = path.join(dir, "shelf");
    // Named as files often are: nothing in them says what series they are, or who made them.
    for (const n of [7, 8, 9]) await makeComic(path.join(shelf, `Robots #${n} - Someone.cbz`), { pages: n - 3, width: 200, height: 300 });
    const made = await serverWithAdmin(dir);
    server = made.server;
    admin = made.admin;
    await importAs(server, admin, shelf);
    comics = (await listed()).sort((a, b) => a.title.localeCompare(b.title));
    server.events.listen("anyone", (e) => heard.push(e as { type: string }));
  }, 60_000);

  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("says what a comic's details are, by the names of a comic's own", async () => {
    const said = await details(comics[0]!.id);
    expect(said).toMatchObject({ id: comics[0]!.id, name: "Robots #7 - Someone", is: "a comic on its own", title: "Robots #7 - Someone", series: "", issue: "", volume: "", collects: "", writers: "", pencils: "", cover_artists: "", cover_date: "", on_sale: "", story_arcs: "", reads: "left to right", pages: 4, corrected: [], cover: "its first page" });
    // An audiobook's details aren't a comic's, and a byline is there only while one kept from before is.
    for (const gone of ["narrator", "subtitle", "number", "author", "by"]) expect(Object.keys(said)).not.toContain(gone);
    expect((await call("comic_details", { book: "0123456789abcdef" })).isError).toBe(true);
  });

  it("tells an assistant the names, what the title is now, how a collection's issues are written, and how a date is", async () => {
    const tools = (await mcp("tools/list", {})).tools as { name: string; description: string; inputSchema: { properties: { details?: { properties: Record<string, unknown> } } } }[];
    const set = tools.find((t) => t.name === "set_details")!;
    expect(Object.keys(set.inputSchema.properties.details!.properties)).toEqual([
      "series",
      "issue",
      "volume",
      "collects",
      "title",
      "writers",
      "pencils",
      "inks",
      "colours",
      "letters",
      "cover_artists",
      "by",
      "cover_date",
      "year",
      "publisher",
      "imprint",
      "story_arcs",
      "language",
      "genres",
      "isbn",
      "editors",
      "translators",
      "on_sale",
      "description",
      "reads",
    ]);
    expect(set.description).toMatch(/story's own name/);
    expect(set.description).toContain("1–6, Annual 1");
    expect(set.description).toContain("2024-07");
  });

  it("changes only the details given, and every device lists the comic named by them", async () => {
    const id = comics[0]!.id;
    const set = await details(id, { series: "Robots", issue: 7, title: "First Light", writers: "A Writer", pencils: ["An Artist", "Another Artist"], cover_date: "July 2024", on_sale: "2024-07-10", description: "A new arc." });
    expect(set).toMatchObject({ name: "Robots #7: First Light", is: "an issue", issue: "7", title: "First Light", writers: "A Writer", pencils: "An Artist; Another Artist", cover_date: "2024-07", year: "2024", on_sale: "2024-07-10" });
    expect(set.corrected).toEqual(["series", "issue", "title", "writers", "pencils", "cover_date", "on_sale", "description"]);
    // One more detail: the others stand.
    await details(id, { publisher: "Made Up Press" });
    expect((await listed()).find((b) => b.id === id)).toMatchObject({ title: "Robots #7: First Light", author: "A Writer; An Artist; Another Artist", series: "Robots", seriesIndex: 7 });
    const book = await served(id);
    expect(book.book).toMatchObject({ issue: "7", rawTitle: "First Light", coverDate: "2024-07", year: 2024, onSale: "2024-07-10", publisher: "Made Up Press", description: "A new arc.", credits: { writers: ["A Writer"], pencils: ["An Artist", "Another Artist"] } });
    // What its file says, to take each back to: the story's name is its file's.
    expect(book.edited?.original).toMatchObject({ title: "Robots #7 - Someone", issue: "", coverDate: "" });
    expect(heard.some((e) => e.type === "books")).toBe(true);
  });

  it("takes a correction back with null, and refuses what isn't a comic's detail", async () => {
    const id = comics[0]!.id;
    const back = await details(id, { description: null });
    expect(back.description).toBe("");
    expect(back.corrected).not.toContain("description");
    for (const given of [{ narrator: "Nobody" }, { number: 7 }, { author: "A Writer" }, { by: "A Writer" }, { title: 7 }, { cover_date: "someday" }, { on_sale: "July" }, { year: "24" }, { issue: "8", volume: "1" }, {}, "Robots"]) {
      expect((await call("set_details", { book: id, details: given })).isError, JSON.stringify(given)).toBe(true);
    }
    expect((await listed()).find((b) => b.id === id)!.title).toBe("Robots #7: First Light");
  });

  it("makes an issue a collection and back, emptying what the other has, as the form's It is does", async () => {
    const id = comics[0]!.id;
    const collected = await details(id, { volume: 1, collects: "1–6", title: "Robots in Disguise" });
    expect(collected).toMatchObject({ name: "Robots Vol. 1: Robots in Disguise", is: "a collection", issue: "", volume: "1", collects: "1–6" });
    expect(server.books.edits(id)?.values).toMatchObject({ issue: "", volume: "1", collects: "1–6" });
    const series = (await listed()).find((b) => b.id === id)!;
    expect(series.seriesIndex).toBe(1);
    // An issue again: its volume and the issues it collected are emptied.
    expect(await details(id, { issue: "7", title: "First Light" })).toMatchObject({ name: "Robots #7: First Light", is: "an issue", volume: "", collects: "" });
  });

  it("shows a byline kept from before while it's there, and takes it back", async () => {
    const id = comics[2]!.id;
    // As the one-time move leaves an assistant's byline from before (comic-edits.ts): kept as the comic's author.
    server.books.saveEdits(id, { values: { author: "A Writer; An Artist" }, updatedAt: new Date().toISOString() }, null);
    expect(await details(id)).toMatchObject({ by: "A Writer; An Artist", corrected: ["by"] });
    expect((await listed()).find((b) => b.id === id)!.author).toBe("A Writer; An Artist");
    await details(id, { writers: "A Writer", pencils: "An Artist" });
    const taken = await details(id, { by: null });
    expect(Object.keys(taken)).not.toContain("by");
    expect(taken.corrected).toEqual(["writers", "pencils"]);
    expect((await listed()).find((b) => b.id === id)!.author).toBe("A Writer; An Artist");
  });

  it("says which way a comic reads, and sets it as the edit form's switch does, for every device", async () => {
    const comic = comics[1]!;
    expect(await details(comic.id)).toMatchObject({ reads: "left to right", corrected: [] });
    expect(await details(comic.id, { reads: "Right to left" })).toMatchObject({ reads: "right to left", corrected: ["reads"] });
    // Kept as the form keeps its switch, and listed, served and looked at so.
    expect(server.books.edits(comic.id)?.values).toEqual({ rightToLeft: "yes" });
    expect((await listed()).find((b) => b.id === comic.id)!.rightToLeft).toBe(true);
    expect((await served(comic.id)).book.rightToLeft).toBe(true);
    expect(JSON.parse(words(await call("comic_pages", { book: comic.id }))).reads).toBe("right to left");
    expect((await call("set_details", { book: comic.id, details: { reads: "upwards" } })).isError).toBe(true);
    // Taken back, it reads as its file says.
    expect(await details(comic.id, { reads: null })).toMatchObject({ reads: "left to right", corrected: [] });
    expect((await listed()).find((b) => b.id === comic.id)!.rightToLeft).toBeUndefined();
    expect((await served(comic.id)).book.rightToLeft).toBeUndefined();
  });

  it("puts comics that name the same series in it together, in the order of their issues, each labelled", async () => {
    // Set out of order: the series is in the order of the issues.
    await details(comics[2]!.id, { series: "Robots (2023)", issue: 9 });
    await details(comics[0]!.id, { series: "Robots (2023)" });
    expect(((await get("/api/series")).json() as { series: ServerSeries[] }).series).toEqual([]);
    await details(comics[1]!.id, { series: "Robots (2023)", issue: "8" });
    const series = ((await get("/api/series")).json() as { series: ServerSeries[] }).series;
    expect(series.map((s) => s.name)).toEqual(["Robots (2023)"]);
    expect(series[0]!.books.map((b) => [b.id, b.number, b.label])).toEqual([
      [comics[0]!.id, 7, "#7"],
      [comics[1]!.id, 8, "#8"],
      [comics[2]!.id, 9, "#9"],
    ]);
    // The run's year is the series', and left out of each comic's name.
    expect((await listed()).find((b) => b.id === comics[1]!.id)!.title).toMatch(/^Robots #8\b/);
    expect(heard.some((e) => e.type === "series")).toBe(true);
  });

  it("makes a page of a comic its cover, and gives its own back", async () => {
    const own = (await listed()).find((b) => b.id === comics[1]!.id)!.cover!;
    const set = await call("set_cover", { book: comics[1]!.id, page: 3 });
    expect(set.isError).toBeUndefined();
    expect(words(set)).toBe("Page 3 is its cover now.");
    expect(set.content.some((c) => c.type === "image")).toBe(true);
    const chosen = (await listed()).find((b) => b.id === comics[1]!.id)!;
    expect(chosen.cover!.hash).not.toBe(own.hash);
    expect(chosen.edited?.chosenCover).toBe(true);
    expect((await get(`/covers/${chosen.cover!.hash}-400.jpg`)).statusCode).toBe(200);
    expect((await details(comics[1]!.id)).cover).toBe("chosen by hand");
    expect((await call("set_cover", { book: comics[1]!.id, page: 9 })).isError).toBe(true);
    expect(words(await call("set_cover", { book: comics[1]!.id, page: 0 }))).toBe("Its cover is the one its file gives it again.");
    expect((await listed()).find((b) => b.id === comics[1]!.id)!.cover!.hash).toBe(own.hash);
  });
});
