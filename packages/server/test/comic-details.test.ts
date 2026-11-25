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
 * (docs/COMICS.md, section 4), over comics made for the test: kept as the
 * desktop's edit form keeps them, so every device lists the comic as
 * corrected, and a person can take any of it back.
 */
describe("a comic's details, set through the MCP", () => {
  let dir: string;
  let server: RibbonServer;
  let admin: string;
  let comics: ListedBook[];
  const heard: { type: string }[] = [];

  const as = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
  const get = (url: string) => server.app.inject({ method: "GET", url, headers: as(admin) });
  const call = async (name: string, args: unknown) =>
    (await server.app.inject({ method: "POST", url: "/mcp", headers: as(admin), payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json().result as { content: { type: string; text?: string; data?: string }[]; isError?: boolean };
  const words = (answer: { content: { type: string; text?: string }[] }) => answer.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const listed = async () => ((await get("/api/books")).json() as { books: ListedBook[] }).books;

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

  it("says what a comic's details are", async () => {
    const details = JSON.parse(words(await call("comic_details", { book: comics[0]!.id }))) as Record<string, unknown>;
    expect(details).toMatchObject({ id: comics[0]!.id, title: comics[0]!.title, pages: 4, corrected: [], cover: "its first page" });
    expect(Object.keys(details)).not.toContain("narrator");
    expect((await call("comic_details", { book: "0123456789abcdef" })).isError).toBe(true);
  });

  it("changes only the details given, and every device lists the comic so", async () => {
    const set = await call("set_details", { book: comics[0]!.id, details: { title: "Robots #7", author: "A Writer; An Artist", number: 7, year: "2024", description: "A new arc." } });
    expect(set.isError).toBeUndefined();
    expect(JSON.parse(words(set))).toMatchObject({ title: "Robots #7", author: "A Writer; An Artist", number: "7", year: "2024", corrected: ["title", "author", "number", "year", "description"] });
    // One more detail: the others stand.
    await call("set_details", { book: comics[0]!.id, details: { publisher: "Made Up Press" } });
    const book = (await listed()).find((b) => b.id === comics[0]!.id)!;
    expect(book).toMatchObject({ title: "Robots #7", author: "A Writer; An Artist", seriesIndex: 7 });
    const served = (await get(`/api/books/${book.id}`)).json() as StoredBook & { edited?: SharedEdits };
    expect(served.book).toMatchObject({ year: 2024, publisher: "Made Up Press", description: "A new arc." });
    expect(served.edited?.original.title).toBe(comics[0]!.title);
    expect(heard.some((e) => e.type === "books")).toBe(true);
  });

  it("takes a correction back with null, and refuses what isn't a comic's detail", async () => {
    const back = JSON.parse(words(await call("set_details", { book: comics[0]!.id, details: { description: null } }))) as { description: string; corrected: string[] };
    expect(back.description).toBe("");
    expect(back.corrected).not.toContain("description");
    for (const details of [{ narrator: "Nobody" }, { title: 7 }, {}, "Robots"]) expect((await call("set_details", { book: comics[0]!.id, details })).isError).toBe(true);
    expect((await listed()).find((b) => b.id === comics[0]!.id)!.title).toBe("Robots #7");
  });

  it("says which way a comic reads, and sets it as the edit form's switch does, for every device", async () => {
    const comic = comics[1]!;
    expect(JSON.parse(words(await call("comic_details", { book: comic.id })))).toMatchObject({ reads: "left to right", corrected: [] });
    const set = JSON.parse(words(await call("set_details", { book: comic.id, details: { reads: "Right to left" } })));
    expect(set).toMatchObject({ reads: "right to left", corrected: ["reads"] });
    // Kept as the form keeps its switch, and listed, served and looked at so.
    expect(server.books.edits(comic.id)?.values).toEqual({ rightToLeft: "yes" });
    expect((await listed()).find((b) => b.id === comic.id)!.rightToLeft).toBe(true);
    expect(((await get(`/api/books/${comic.id}`)).json() as StoredBook).book.rightToLeft).toBe(true);
    expect(JSON.parse(words(await call("comic_pages", { book: comic.id }))).reads).toBe("right to left");
    expect((await call("set_details", { book: comic.id, details: { reads: "upwards" } })).isError).toBe(true);
    // Taken back, it reads as its file says.
    expect(JSON.parse(words(await call("set_details", { book: comic.id, details: { reads: null } })))).toMatchObject({ reads: "left to right", corrected: [] });
    expect((await listed()).find((b) => b.id === comic.id)!.rightToLeft).toBeUndefined();
    expect(((await get(`/api/books/${comic.id}`)).json() as StoredBook).book.rightToLeft).toBeUndefined();
  });

  it("puts comics that name the same series in it together, in the order of their numbers", async () => {
    // Set out of order: the series is in the order of the numbers.
    await call("set_details", { book: comics[2]!.id, details: { series: "Robots (2023)", number: 9 } });
    await call("set_details", { book: comics[0]!.id, details: { series: "Robots (2023)" } });
    expect(((await get("/api/series")).json() as { series: ServerSeries[] }).series).toEqual([]);
    await call("set_details", { book: comics[1]!.id, details: { series: "Robots (2023)", number: 8 } });
    const series = ((await get("/api/series")).json() as { series: ServerSeries[] }).series;
    expect(series.map((s) => s.name)).toEqual(["Robots (2023)"]);
    expect(series[0]!.books.map((b) => [b.id, b.number])).toEqual([[comics[0]!.id, 7], [comics[1]!.id, 8], [comics[2]!.id, 9]]);
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
    expect(JSON.parse(words(await call("comic_details", { book: comics[1]!.id }))).cover).toBe("chosen by hand");
    expect((await call("set_cover", { book: comics[1]!.id, page: 9 })).isError).toBe(true);
    expect(words(await call("set_cover", { book: comics[1]!.id, page: 0 }))).toBe("Its cover is the one its file gives it again.");
    expect((await listed()).find((b) => b.id === comics[1]!.id)!.cover!.hash).toBe(own.hash);
  });
});
