import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeComic, makePdf } from "@ribbon/host-node/make-comic";
import { imageSize } from "@ribbon/core/comic/size";
import type { RibbonServer } from "../src/app.ts";
import type { ListedBook } from "../src/library/books.ts";
import { importAs, serverWithAdmin } from "./fixture.ts";

/**
 * A comic's panels on the server (docs/COMICS.md, section 14), over comics
 * made for the test: an assistant sets them through the MCP, a device
 * reads them through the API, and both go through the same store and the
 * same rules.
 */
describe("a comic's panels on the server", () => {
  let dir: string;
  let server: RibbonServer;
  let admin: string;
  let reader: string;
  let comic: ListedBook;
  let pdf: ListedBook;

  const as = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
  const get = (url: string, token = admin) => server.app.inject({ method: "GET", url, headers: as(token) });
  const put = (url: string, body: unknown, token = admin) => server.app.inject({ method: "PUT", url, headers: as(token), payload: JSON.stringify(body) });
  /** One message to the MCP, as an assistant sends it. */
  const mcp = (method: string, params: unknown = {}, token = admin, note = false) => server.app.inject({ method: "POST", url: "/mcp", headers: as(token), payload: JSON.stringify({ jsonrpc: "2.0", ...(note ? {} : { id: 1 }), method, params }) });
  /** A tool called, and what it sent back. */
  const call = async (name: string, args: unknown) => (await mcp("tools/call", { name, arguments: args })).json().result as { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };
  const words = (answer: { content: { type: string; text?: string }[] }) => answer.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

  const three = [
    { x: 0.05, y: 0.05, w: 0.9, h: 0.25 },
    { x: 0.05, y: 0.35, w: 0.42, h: 0.6 },
    { x: 0.53, y: 0.35, w: 0.42, h: 0.6 },
  ];

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-panels-"));
    const shelf = path.join(dir, "shelf");
    await makeComic(path.join(shelf, "Made Up Saga 001 (2018).cbz"), { pages: 6, width: 400, height: 600 });
    await makePdf(path.join(shelf, "Old Tales", "Old Tales 001.pdf"), { pages: 3 });
    const made = await serverWithAdmin(dir);
    server = made.server;
    admin = made.admin;
    await importAs(server, admin, shelf);
    const books = ((await get("/api/books")).json() as { books: ListedBook[] }).books;
    comic = books.find((b) => b.title === "Made Up Saga #1")!;
    pdf = books.find((b) => b.title === "Old Tales #1")!;
    // Someone who is signed in and isn't the admin.
    const invite = (await server.app.inject({ method: "POST", url: "/api/invites", headers: { authorization: `Bearer ${admin}` } })).json() as { code: string };
    reader = ((await server.app.inject({ method: "POST", url: `/api/invites/${invite.code}/accept`, payload: { name: "reader", password: "another long password" } })).json() as { token: string }).token;
    expect(reader).toBeTruthy();
  }, 60_000);

  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("speaks the protocol plainly: who it is, its tools, and nothing back for a note", async () => {
    const hello = (await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })).json();
    expect(hello).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ribbon" } } });
    // Asked for a version it doesn't know, it says the newest it does.
    expect((await mcp("initialize", { protocolVersion: "1999-01-01" })).json().result.protocolVersion).toBe("2025-06-18");
    expect((await mcp("notifications/initialized", {}, admin, true)).statusCode).toBe(202);
    const tools = (await mcp("tools/list")).json().result.tools as { name: string; inputSchema: { type: string } }[];
    expect(tools.map((t) => t.name)).toEqual(["list_comics", "comic_pages", "look_at_page", "set_panels", "comic_details", "set_details", "set_cover"]);
    expect(tools.every((t) => t.inputSchema.type === "object")).toBe(true);
    expect((await mcp("resources/list")).json().error.code).toBe(-32601);
    expect((await server.app.inject({ method: "GET", url: "/mcp", headers: as(admin) })).statusCode).toBe(405);
  });

  it("takes only the admin's key", async () => {
    expect((await server.app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).statusCode).toBe(401);
    expect((await mcp("tools/list", {}, reader)).statusCode).toBe(403);
  });

  it("lists the comics, and one comic's pages with what is left to do", async () => {
    const listed = JSON.parse(words(await call("list_comics", {}))) as { comics: { id: string; title: string; pages: number; pagesWithPanels: number }[] };
    expect(listed.comics.map((c) => c.title).sort()).toEqual(["Made Up Saga #1", "Old Tales #1"]);
    expect(listed.comics.find((c) => c.id === comic.id)).toMatchObject({ pages: 6, pagesWithPanels: 0 });
    expect((JSON.parse(words(await call("list_comics", { query: "old tales" }))) as { comics: unknown[] }).comics).toHaveLength(1);
    const pages = JSON.parse(words(await call("comic_pages", { book: comic.id }))) as { reads: string; pages: { page: number; width: number; height: number; panels: number }[] };
    expect(pages.reads).toBe("left to right");
    expect(pages.pages).toHaveLength(6);
    expect(pages.pages[0]).toEqual({ page: 1, width: 400, height: 600, panels: 0 });
  });

  it("shows a page as a picture to look at", async () => {
    const seen = await call("look_at_page", { book: comic.id, page: 2 });
    const picture = seen.content.find((c) => c.type === "image")!;
    expect(picture.mimeType).toBe("image/jpeg");
    expect(imageSize(Buffer.from(picture.data!, "base64"))).toEqual({ width: 400, height: 600 });
    expect(JSON.parse(words(seen))).toMatchObject({ page: 2, of: 6, panels: [] });
  });

  it("sets a page's panels, in order, and sends the page back with them drawn", async () => {
    const set = await call("set_panels", { book: comic.id, page: 2, panels: three });
    expect(set.isError).toBeUndefined();
    expect(words(set)).toBe("Page 2 has 3 panels now.");
    const drawn = Buffer.from(set.content.find((c) => c.type === "image")!.data!, "base64");
    // The same page, and not the same picture: the panels are drawn over it.
    const plain = Buffer.from((await call("set_panels", { book: comic.id, page: 3, panels: [] })).content.find((c) => c.type === "image")!.data!, "base64");
    expect(imageSize(drawn)).toEqual({ width: 400, height: 600 });
    expect(drawn.equals(plain)).toBe(false);
    expect(JSON.parse(words(await call("look_at_page", { book: comic.id, page: 2 }))).panels).toEqual(three);
    // Without the picture, when the assistant says so.
    expect((await call("set_panels", { book: comic.id, page: 2, panels: three, show: false })).content).toHaveLength(1);
  });

  it("refuses panels that can't be, in a sentence the assistant can act on", async () => {
    const small = await call("set_panels", { book: comic.id, page: 4, panels: [{ x: 0.5, y: 0.5, w: 0.001, h: 0.2 }] });
    expect(small.isError).toBe(true);
    expect(words(small)).toMatch(/Panel 1 is too small/);
    expect(words(await call("set_panels", { book: comic.id, page: 4, panels: "all of them" }))).toMatch(/fraction of the page/);
    expect(words(await call("set_panels", { book: comic.id, page: 40, panels: three }))).toMatch(/has 6 pages, counted from 1/);
    expect(words(await call("look_at_page", { book: "no-such-comic", page: 1 }))).toMatch(/no comic with the id/);
    expect((await mcp("tools/call", { name: "paint_page", arguments: {} })).json().error.message).toMatch(/no tool called paint_page/);
  });

  it("gives a device the same panels, by page, and asks nothing new of one that has them", async () => {
    const first = await get(`/api/books/${comic.id}/panels`, reader);
    expect(first.json()).toEqual({ pages: [{ page: 2, panels: three }] });
    const again = await server.app.inject({ method: "GET", url: `/api/books/${comic.id}/panels`, headers: { ...as(reader), "if-none-match": String(first.headers.etag) } });
    expect(again.statusCode).toBe(304);
    expect((await get("/api/books/no-such-book/panels")).statusCode).toBe(404);
  });

  it("lets the admin set a page's panels from an app, by the same rules, and nobody else", async () => {
    const whole = [{ x: 0, y: 0, w: 1, h: 1 }];
    expect((await put(`/api/books/${comic.id}/pages/5/panels`, { panels: whole })).json()).toEqual({ page: 5, panels: whole });
    expect((await put(`/api/books/${comic.id}/pages/5/panels`, { panels: whole }, reader)).statusCode).toBe(403);
    expect((await put(`/api/books/${comic.id}/pages/5/panels`, { panels: [{ x: 2, y: 2, w: 1, h: 1 }] })).json().error).toMatch(/outside the page/);
    expect((await put(`/api/books/${comic.id}/pages/9/panels`, { panels: whole })).statusCode).toBe(404);
    // What an app set, the assistant sees, and counts.
    expect(JSON.parse(words(await call("look_at_page", { book: comic.id, page: 5 }))).panels).toEqual(whole);
    const listed = JSON.parse(words(await call("list_comics", { query: "saga" }))) as { comics: { pagesWithPanels: number }[] };
    expect(listed.comics[0]!.pagesWithPanels).toBe(2);
    // An empty list takes a page's panels away.
    await put(`/api/books/${comic.id}/pages/5/panels`, { panels: [] });
    expect(((await get(`/api/books/${comic.id}/panels`)).json() as { pages: { page: number }[] }).pages.map((p) => p.page)).toEqual([2]);
  });

  it("does the same for a PDF, whose pages the server draws", async () => {
    const seen = await call("look_at_page", { book: pdf.id, page: 1 });
    expect(seen.content.find((c) => c.type === "image")?.mimeType).toBe("image/jpeg");
    expect(words(await call("set_panels", { book: pdf.id, page: 1, panels: three, show: false }))).toBe("Page 1 has 3 panels now.");
    expect((await get(`/api/books/${pdf.id}/panels`)).json()).toEqual({ pages: [{ page: 1, panels: three }] });
  });

  it("forgets a comic's panels when the comic is taken off the server", async () => {
    expect((await server.app.inject({ method: "DELETE", url: `/api/books/${pdf.id}`, headers: { authorization: `Bearer ${admin}` } })).statusCode).toBe(204);
    expect(Number(server.db.prepare("SELECT count(*) AS n FROM comic_panels WHERE book_id = ?").get(pdf.id)?.n)).toBe(0);
    expect(Number(server.db.prepare("SELECT count(*) AS n FROM comic_panels WHERE book_id = ?").get(comic.id)?.n)).toBe(1);
  });
});
