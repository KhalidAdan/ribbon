import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RibbonServer } from "../src/app.ts";
import { bookDir, type ListedBook } from "../src/library/books.ts";
import { importAs, makeLibraries, serverWithAdmin } from "./fixture.ts";

const PHONE = "urn:uuid:0d1e2f30-4152-4637-8899-aabbccddeeff";

/** A place in a book, as a device appends it to its log (docs/POSITION-FORMAT.md, section 3.1). */
const pos = (seq: number, ms: number) => ({ v: 1, dev: PHONE, seq, t: new Date(1_790_000_000_000 + seq).toISOString(), k: "pos", book: { ids: ["urn:ribbon:book:red"] }, why: "pause", ms });

// Deleting a book as the admin: off the list and off the disk, listed as
// deleted so devices take their copies off, nobody's places touched, and
// back again when its folder is added again.
describe("deleting a book from the server", () => {
  let dir: string;
  let server: RibbonServer;
  let shelf = "";
  let admin = "";
  let member = "";
  let red: ListedBook;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-delete-"));
    shelf = makeLibraries(dir).shelf;
    const made = await serverWithAdmin(dir);
    server = made.server;
    admin = made.admin;
    const { code } = (await server.app.inject({ method: "POST", url: "/api/invites", headers: { authorization: `Bearer ${admin}` } })).json() as { code: string };
    member = ((await server.app.inject({ method: "POST", url: `/api/invites/${code}/accept`, payload: { name: "brother", password: "a long password" } })).json() as { token: string }).token;
    await importAs(server, admin, shelf);
  }, 60_000);
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const as = (token: string, method: "GET" | "DELETE", url: string) => server.app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });
  const library = async () => (await as(admin, "GET", "/api/books")).json() as { books: ListedBook[]; deleted: string[] };

  it("can be asked for from the apps' own origin", async () => {
    const asked = await server.app.inject({ method: "OPTIONS", url: "/api/books/0123456789abcdef", headers: { origin: "tauri://localhost", "access-control-request-method": "DELETE", "access-control-request-headers": "authorization" } });
    expect(asked.statusCode).toBe(204);
    expect(asked.headers["access-control-allow-methods"]).toContain("DELETE");
  });

  it("is the admin's to do", async () => {
    red = (await library()).books.find((b) => b.title === "Red Book")!;
    expect((await server.app.inject({ method: "DELETE", url: `/api/books/${red.id}` })).statusCode).toBe(401);
    expect((await as(member, "DELETE", `/api/books/${red.id}`)).statusCode).toBe(403);
    expect((await as(admin, "DELETE", "/api/books/0123456789abcdef")).statusCode).toBe(404);
    expect((await library()).books.map((b) => b.title).sort()).toEqual(["Long Book", "Red Book"]);
  });

  it("takes the book and its files away, lists it as deleted, and keeps everyone's places", async () => {
    await server.app.inject({ method: "POST", url: "/api/places", payload: { device: { id: PHONE, name: "the phone" }, records: [pos(1, 60_000)] }, headers: { authorization: `Bearer ${admin}` } });
    const before = await as(admin, "GET", "/api/books");

    expect((await as(admin, "DELETE", `/api/books/${red.id}`)).statusCode).toBe(204);

    const after = await as(admin, "GET", "/api/books");
    expect(after.headers.etag).not.toBe(before.headers.etag);
    const { books, deleted } = after.json() as { books: ListedBook[]; deleted: string[] };
    expect(books.map((b) => b.title)).toEqual(["Long Book"]);
    expect(deleted).toEqual([red.id]);
    expect((await as(admin, "GET", `/api/books/${red.id}`)).statusCode).toBe(404);
    expect((await as(admin, "GET", `/api/books/${red.id}/files/audio/01.mp3`)).statusCode).toBe(404);
    expect((await as(admin, "GET", `/covers/${red.cover!.hash}-200.jpg`)).statusCode).toBe(404);
    // Gone from the disk, with nothing left over beside it.
    expect(existsSync(bookDir(path.join(dir, "data"), red.id))).toBe(false);
    expect(readdirSync(path.join(dir, "data", "books")).filter((n) => n.startsWith(red.id))).toEqual([]);
    // The place in it is still the person's.
    expect((await as(admin, "GET", "/api/places/export")).body).toContain('"ms":60000');
    // Deleting it again finds nothing.
    expect((await as(admin, "DELETE", `/api/books/${red.id}`)).statusCode).toBe(404);
  });

  it("brings the book back, with the same id, when its folder is added again", async () => {
    const { job } = await importAs(server, admin, shelf);
    expect(job.progress).toMatchObject({ added: 1, skipped: 1 });
    const { books, deleted } = await library();
    expect(books.find((b) => b.title === "Red Book")?.id).toBe(red.id);
    expect(deleted).toEqual([]);
  });
});
