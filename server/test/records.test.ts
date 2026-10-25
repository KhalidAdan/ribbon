import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RibbonServer } from "../src/app.ts";
import type { StoredBook } from "../src/library/books.ts";
import { bookId } from "../../src/core/bookid.ts";
import { importAs, mp3, serverWithAdmin } from "./fixture.ts";

/**
 * A book's records, made by Ribbon beside it in its folder's `.ribbon/`
 * (what people set about it, its loudness and silences), come into the
 * server with it, so nobody sets or measures them again. What was heard of
 * its narration doesn't (#152): a transcript is only ever one a device sent
 * whole.
 */
describe("a book's records, carried in", () => {
  let dir: string;
  let server: RibbonServer;
  let admin = "";
  let library = "";
  let id = "";

  /** Records as Ribbon writes them beside a book, under the id it has in `root`. */
  const record = (root: string, kind: string, bookPath: string, csv: string) => {
    const bytes = statSync(path.join(root, ...bookPath.split("/"), "01.mp3")).size;
    mkdirSync(path.join(root, ".ribbon", kind), { recursive: true });
    writeFileSync(path.join(root, ".ribbon", kind, `${bookId(bookPath, bytes)}.csv`), csv);
  };
  const stored = () => JSON.parse(readFileSync(path.join(dir, "data", "books", id, "book.json"), "utf8")) as StoredBook;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ribbon-records-"));
    library = path.join(dir, "library");
    mp3(path.join(library, "Series", "Heard Book", "01.mp3"), { title: "Heard Book", album: "Heard Book", artist: "An Author" });
    mp3(path.join(library, "Series", "Later Book", "01.mp3"), { title: "Later Book", album: "Later Book", artist: "An Author" });
    // The library Ribbon made them in was the series folder, not the one the admin adds.
    const series = path.join(library, "Series");
    record(series, "heard", "Heard Book", "audio_ms,words,chars\n0,In the beginning,\n");
    record(series, "aligned", "Heard Book", "start_ms,end_ms,words,chars\n0,3000,,\n");
    record(series, "pairing", "Heard Book", "text,audio_ms\none.xhtml#0,0\n");
    record(series, "loudness", "Heard Book", "book_id,integrated_lufs,true_peak_dbtp,gain_db\nx,-21.5,-4,3.5\n");
    record(series, "silence", "Heard Book", "file_index,start_ms,end_ms\n0,1000,2000\n");
    ({ server, admin } = await serverWithAdmin(dir));
    const { job } = await importAs(server, admin, library);
    expect(job.progress).toMatchObject({ added: 2, failed: 0 });
    id = server.books.list().find((b) => b.title === "Heard Book")!.id;
  }, 60_000);
  afterAll(async () => {
    await server.app.close();
    server.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("come in with the book, found in the library they were made in, but for what was heard of it", () => {
    expect(stored().records).toEqual(["pairing"]);
    expect(readFileSync(path.join(dir, "data", "books", id, "records", "pairing.csv"), "utf8")).toContain("one.xhtml#0");
    expect(existsSync(path.join(dir, "data", "books", id, "records", "aligned.csv"))).toBe(false);
  });

  it("bring the loudness and silences measured before, rather than measuring again", () => {
    expect(stored().analysis).toEqual({ loudness: { integratedLufs: -21.5, truePeakDbtp: -4 }, silence: [{ file: 0, ranges: [{ startMs: 1000, endMs: 2000 }] }] });
  });

  it("are served with the book, and only the ones it has", async () => {
    const get = (file: string) => server.app.inject({ method: "GET", url: `/api/books/${id}/files/${file}`, headers: { authorization: `Bearer ${admin}` } });
    expect((await get("records/pairing.csv")).body).toContain("one.xhtml#0");
    expect((await get("records/heard.csv")).statusCode).toBe(404);
    expect((await get("../../ribbon.db")).statusCode).toBe(404);
  });

  it("fill in, when the folder is added again, what a book already here was missing", async () => {
    const later = server.books.list().find((b) => b.title === "Later Book")!.id;
    expect(JSON.parse(readFileSync(path.join(dir, "data", "books", later, "book.json"), "utf8")).records).toBeUndefined();
    record(path.join(library, "Series"), "pairing", "Later Book", "text,audio_ms\none.xhtml#0,0\n");
    const { job } = await importAs(server, admin, library);
    expect(job.progress).toMatchObject({ added: 0, skipped: 2 });
    expect((JSON.parse(readFileSync(path.join(dir, "data", "books", later, "book.json"), "utf8")) as StoredBook).records).toEqual(["pairing"]);
  });

  it("leave the book's transcript alone when the folder is added again: never merged with what the folder heard", async () => {
    const aligned = path.join(dir, "data", "books", id, "records", "aligned.csv");
    writeFileSync(aligned, "start_ms,end_ms,words,chars,heard_by,word_ms\n0,3000,,,ggml-small-q5_1,\n");
    record(path.join(library, "Series"), "aligned", "Heard Book", "start_ms,end_ms,words,chars\n0,3000,,\n3100,5800,In the beginning,0\n");
    await importAs(server, admin, library);
    expect(readFileSync(aligned, "utf8")).toBe("start_ms,end_ms,words,chars,heard_by,word_ms\n0,3000,,,ggml-small-q5_1,\n");
  });
});
