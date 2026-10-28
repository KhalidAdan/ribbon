import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RibbonServer } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { BookIndex, type StoredBook } from "../src/library/books.ts";
import { importFolder } from "../src/library/importer.ts";
import { booksToPrepare, prepareBooks } from "../src/library/prepare.ts";
import { nodeHost } from "../../src/host/node.ts";
import { importAs, makeLibraries, serverWithAdmin } from "./fixture.ts";

// Adding folders of books: a book with a cover, a book in two files, and
// the first book again in another folder, which is never added twice.
describe("adding a folder", () => {
  let dir: string;
  let shelf: string;
  let copies: string;
  let server: RibbonServer;
  let admin = "";

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-import-"));
    ({ shelf, copies } = makeLibraries(dir));
    ({ server, admin } = await serverWithAdmin(dir));
  }, 60_000);
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const importing = async (folder: string) => {
    const { status, job } = await importAs(server, admin, folder);
    expect(status).toBe(202);
    return job;
  };

  it("copies each new book in, with its chapters and covers", async () => {
    const job = await importing(shelf);
    expect(job.error).toBeNull();
    expect(job.state).toBe("done");
    expect(job.progress).toMatchObject({ found: 2, added: 2, skipped: 0, failed: 0, current: null });
    expect(server.books.count()).toBe(2);

    const ids = readdirSync(path.join(dir, "data", "books"));
    expect(ids).toHaveLength(2);
    const stored = ids.map((id) => JSON.parse(readFileSync(path.join(dir, "data", "books", id, "book.json"), "utf8")) as StoredBook);
    const red = stored.find((b) => b.book.title === "Red Book")!;
    const long = stored.find((b) => b.book.title === "Long Book")!;

    expect(red.files.map((f) => f.path)).toEqual(["audio/01.mp3"]);
    expect(long.files.map((f) => f.path)).toEqual(["audio/01.mp3", "audio/02.mp3"]);
    expect(long.chapters.map((c) => c.title)).toEqual(["Part one", "Part two"]);
    for (const b of stored) for (const f of b.files) expect(existsSync(path.join(dir, "data", "books", b.book.id, f.path))).toBe(true);

    // The red picture inside the first book: its shape, its colour, and a file at every width, none wider than the picture.
    expect(red.cover).not.toBeNull();
    expect(red.cover!.aspect).toBeCloseTo(300 / 450, 2);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(red.cover!.colour.slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(200);
    expect(g! + b!).toBeLessThan(80);
    expect(readdirSync(path.join(dir, "data", "books", red.book.id, "covers")).sort()).toEqual([`${red.cover!.hash}-200.jpg`, `${red.cover!.hash}-400.jpg`, `${red.cover!.hash}-800.jpg`]);
    expect(long.cover).toBeNull();

    // Measured once, here, from the copies: a tone has a loudness and no silences.
    for (const b of [red, long]) {
      expect(b.analysis?.loudness?.integratedLufs).toEqual(expect.any(Number));
      expect(b.analysis?.silence).toEqual([]);
    }
  });

  it("measures, once, a book added before the server measured books", async () => {
    const dataDir = path.join(dir, "data");
    const id = readdirSync(path.join(dataDir, "books"))[0]!;
    const file = path.join(dataDir, "books", id, "book.json");
    const { analysis: _was, ...older } = JSON.parse(readFileSync(file, "utf8")) as StoredBook;
    writeFileSync(file, JSON.stringify(older));
    expect(await booksToPrepare(dataDir, server.books)).toEqual([id]);
    const done = await prepareBooks(nodeHost(), dataDir, [id], () => undefined);
    expect(done).toMatchObject({ books: 1, done: 1, current: null });
    expect((JSON.parse(readFileSync(file, "utf8")) as StoredBook).analysis?.loudness).not.toBeNull();
    expect(await booksToPrepare(dataDir, server.books)).toEqual([]);
  });

  it("never adds the same book twice", async () => {
    const job = await importing(copies);
    expect(job.progress).toMatchObject({ found: 1, added: 0, skipped: 1, failed: 0 });
    expect(job.progress.notes).toEqual(["Red Book: already on the server."]);
    expect(server.books.count()).toBe(2);
    const again = await importing(shelf);
    expect(again.progress).toMatchObject({ found: 2, added: 0, skipped: 2 });
  });

  it("leaves the folders it reads exactly as they were", () => {
    for (const folder of [shelf, copies]) expect(existsSync(path.join(folder, ".ribbon"))).toBe(false);
  });

  it("refuses anyone but the admin, and a path that isn't a folder", async () => {
    const nobody = await server.app.inject({ method: "POST", url: "/api/library/import", payload: { folder: shelf } });
    expect(nobody.statusCode).toBe(401);
    const relative = await server.app.inject({ method: "POST", url: "/api/library/import", payload: { folder: "shelf" }, headers: { authorization: `Bearer ${admin}` } });
    expect(relative.statusCode).toBe(400);
    const missing = await importing(path.join(dir, "no such folder"));
    expect(missing.state).toBe("failed");
    expect(missing.error).toMatch(/There's no folder at/);
  });

  it("leaves out a book that won't fit on the server's disk, and says so", async () => {
    const dataDir = path.join(dir, "full");
    const db = openDatabase(dataDir);
    const asked: string[] = [];
    const freeBytes = async (folder: string) => (asked.push(folder), 10 * 1024 ** 2);
    const done = await importFolder({ host: nodeHost(), dataDir, index: new BookIndex(db), addedBy: null, freeBytes }, shelf, () => undefined);
    expect(done).toMatchObject({ found: 2, added: 0, failed: 2 });
    expect(done.notes.every((n) => /there isn't room for it on the server's disk/.test(n))).toBe(true);
    // The disk asked about is the books folder's, which can be a big drive of its own, never the data folder's above it.
    expect(new Set(asked)).toEqual(new Set([path.join(dataDir, "books")]));
    expect(existsSync(path.join(dataDir, "books")) ? readdirSync(path.join(dataDir, "books")) : []).toEqual([]);
    db.close();
  });

  it("tells every device as each book is added, so shelves fill as it goes", async () => {
    const { server: fresh, admin: freshAdmin } = await serverWithAdmin(path.join(dir, "events"));
    const heard: unknown[] = [];
    // Nobody in particular: everyone hears of new books.
    fresh.events.listen("anyone", (e) => heard.push(e));
    await importAs(fresh, freshAdmin, shelf);
    expect(heard).toEqual([
      { type: "books", data: { added: 1 } },
      { type: "books", data: { added: 2 } },
    ]);
    await fresh.app.close();
    fresh.db.close();
  });
});
