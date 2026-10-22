import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RibbonServer } from "../src/app.ts";
import type { ListedBook, StoredBook } from "../src/library/books.ts";
import { importAs, makeLibraries, serverWithAdmin } from "./fixture.ts";

// The library as the apps read it, and how it's cached: a bare 304 when
// nothing changed, covers that never change, files that resume.
describe("the library API", () => {
  let dir: string;
  let server: RibbonServer;
  let token = "";
  let red: ListedBook;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-library-"));
    const { shelf } = makeLibraries(dir);
    const made = await serverWithAdmin(dir);
    server = made.server;
    token = made.admin;
    await importAs(server, token, shelf);
  }, 60_000);
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (url: string, headers: Record<string, string> = {}) => server.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}`, ...headers } });

  it("asks for a sign-in", async () => {
    for (const url of ["/api/books", "/api/books/x", "/covers/0123456789abcdef-200.jpg", "/api/books/x/files/book.epub"]) {
      expect((await server.app.inject({ method: "GET", url })).statusCode).toBe(401);
    }
  });

  it("lists every book with what the shelf needs, and answers 304 when nothing changed", async () => {
    const first = await get("/api/books");
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("private, no-cache");
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^W\/"/);
    const { books } = first.json() as { books: ListedBook[] };
    expect(books.map((b) => b.title).sort()).toEqual(["Long Book", "Red Book"]);
    red = books.find((b) => b.title === "Red Book")!;
    expect(red).toMatchObject({ author: "Author One", audio: true, ebook: false, ebookBytes: null });
    expect(red.cover).toMatchObject({ aspect: 0.667 });
    expect(red.cover!.colour).toMatch(/^#[0-9a-f]{6}$/);
    // Nothing about anyone's place: those change while people listen and would spoil the 304s.
    expect(Object.keys(red)).not.toContain("position");

    const again = await get("/api/books", { "if-none-match": etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
  });

  it("gives one book in full, also revalidated", async () => {
    const r = await get(`/api/books/${red.id}`);
    expect(r.statusCode).toBe(200);
    const book = r.json() as StoredBook;
    expect(book.files.map((f) => f.path)).toEqual(["audio/01.mp3"]);
    expect(book.chapters).toHaveLength(1);
    expect((await get(`/api/books/${red.id}`, { "if-none-match": r.headers.etag as string })).statusCode).toBe(304);
    expect((await get("/api/books/not-a-book")).statusCode).toBe(404);
  });

  it("sends covers at addresses that never change", async () => {
    for (const width of [200, 400, 800]) {
      const r = await get(`/covers/${red.cover!.hash}-${width}.jpg`);
      expect(r.statusCode).toBe(200);
      expect(r.headers["content-type"]).toBe("image/jpeg");
      expect(r.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    }
    expect((await get(`/covers/${red.cover!.hash}-300.jpg`)).statusCode).toBe(404);
    expect((await get("/covers/0123456789abcdef-200.jpg")).statusCode).toBe(404);
  });

  it("sends a book's files whole, or from where a download stopped", async () => {
    const url = `/api/books/${red.id}/files/audio/01.mp3`;
    const size = statSync(path.join(dir, "data", "books", red.id, "audio", "01.mp3")).size;
    const whole = await get(url);
    expect(whole.statusCode).toBe(200);
    expect(Number(whole.headers["content-length"])).toBe(size);
    expect(whole.headers["accept-ranges"]).toBe("bytes");
    expect(whole.headers["last-modified"]).toBeTruthy();
    const etag = whole.headers.etag as string;
    expect(etag).toBeTruthy();

    const rest = await get(url, { range: "bytes=100-", "if-range": etag });
    expect(rest.statusCode).toBe(206);
    expect(rest.rawPayload.length).toBe(size - 100);
    expect(rest.headers["content-range"]).toBe(`bytes 100-${size - 1}/${size}`);

    // The file changed since (its ETag doesn't match): the whole file again, not a piece of the new one.
    const changed = await get(url, { range: "bytes=100-", "if-range": 'W/"something-else"' });
    expect(changed.statusCode).toBe(200);
    expect(changed.rawPayload.length).toBe(size);
  });

  it("sends only the book's own files", async () => {
    for (const file of ["book.json", "../../ribbon.db", "audio/../book.json", "covers/x.jpg", "audio/02.mp3"]) {
      expect((await get(`/api/books/${red.id}/files/${file}`)).statusCode).toBe(404);
    }
  });
});
