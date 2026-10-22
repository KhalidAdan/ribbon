import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type RibbonServer } from "../src/app.ts";
import type { StoredBook } from "../src/library/books.ts";
import type { ImportProgress } from "../src/library/importer.ts";

// Adding folders of books: a book with a cover, a book in two files, and
// the first book again in another folder, which is never added twice.
describe("adding a folder", () => {
  let dir: string;
  let shelf: string;
  let copies: string;
  let server: RibbonServer;
  let admin = "";

  /** A few seconds of tone as an MP3, tagged, with a picture inside when asked. */
  const mp3 = (file: string, title: string, album: string, artist: string, picture?: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const args = ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3"];
    if (picture) args.push("-f", "lavfi", "-i", `color=c=${picture}:s=300x450:d=1`, "-map", "0:a", "-map", "1:v", "-c:v", "mjpeg", "-disposition:v", "attached_pic", "-frames:v", "1");
    args.push("-c:a", "libmp3lame", "-b:a", "64k", "-id3v2_version", "3", "-metadata", `title=${title}`, "-metadata", `album=${album}`, "-metadata", `artist=${artist}`, file);
    execFileSync("ffmpeg", args);
  };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-import-"));
    shelf = path.join(dir, "shelf");
    copies = path.join(dir, "copies");
    mp3(path.join(shelf, "Author One", "Red Book", "01.mp3"), "Red Book", "Red Book", "Author One", "red");
    mp3(path.join(shelf, "Author Two", "Long Book", "01.mp3"), "Part one", "Long Book", "Author Two");
    mp3(path.join(shelf, "Author Two", "Long Book", "02.mp3"), "Part two", "Long Book", "Author Two");
    mkdirSync(path.join(copies, "Red Book again"), { recursive: true });
    copyFileSync(path.join(shelf, "Author One", "Red Book", "01.mp3"), path.join(copies, "Red Book again", "01.mp3"));

    server = await buildServer({ dataDir: path.join(dir, "data"), host: "127.0.0.1", port: 0, url: "https://ribbon.example", secret: "a test secret of thirty-two chars!!" });
    const code = server.invites.firstAdmin().code;
    const joined = await server.app.inject({ method: "POST", url: `/api/invites/${code}/accept`, payload: { name: "admin", password: "a long password" } });
    admin = (joined.json() as { token: string }).token;
  }, 60_000);
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const importing = async (folder: string) => {
    const r = await server.app.inject({ method: "POST", url: "/api/library/import", payload: { folder }, headers: { authorization: `Bearer ${admin}` } });
    expect(r.statusCode).toBe(202);
    const { job } = r.json() as { job: { id: string } };
    await server.jobs.idle();
    const done = await server.app.inject({ method: "GET", url: `/api/jobs/${job.id}`, headers: { authorization: `Bearer ${admin}` } });
    return (done.json() as { job: { state: string; progress: ImportProgress; error: string | null } }).job;
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
});
