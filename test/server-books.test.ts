import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanLibrary } from "../src/core/scan/scan";
import { parseOpf } from "../src/core/scan/sidefiles";
import { localIdOf, opfFor, remoteBook, serverCoverPath, type ServerBook } from "../src/core/server-books";
import { nodeHost } from "../src/host/node";

const SERVER_ID = "0f1e2d3c4b5a6978";

const listed = (sizeBytes: number): ServerBook => ({
  id: SERVER_ID,
  title: "The Red Book",
  author: "Ann Author & Bo Writer",
  narrator: "Nell Narrator",
  series: "Colours",
  seriesIndex: 2,
  durationMs: 6000,
  sizeBytes,
  audio: true,
  ebook: false,
  ebookBytes: null,
  cover: { hash: "abcdef0123456789", aspect: 0.667, colour: "#fe0000" },
  addedAt: "2026-10-22T00:00:00.000Z",
});

describe("a server's books on this device", () => {
  it("writes a metadata.opf the scanner reads back", () => {
    const meta = parseOpf(opfFor({ id: SERVER_ID, title: "The Red Book & Co.", author: "Ann Author & Bo Writer", narrator: "Nell Narrator", series: "Colours", seriesIndex: 2, isbn: "9780000000002", asin: "B000000001", description: "A red book, & more." }));
    expect(meta).toMatchObject({ title: "The Red Book & Co.", authors: ["Ann Author", "Bo Writer"], narrators: ["Nell Narrator"], series: "Colours", seriesIndex: 2, isbn: "9780000000002", asin: "B000000001", description: "A red book, & more." });
  });

  it("shows a book not downloaded yet with what the shelf needs", () => {
    const b = remoteBook(listed(1234));
    expect(b.book).toMatchObject({ id: localIdOf(listed(1234)), title: "The Red Book", cover: serverCoverPath("abcdef0123456789"), fileCount: 1 });
    expect(b.files).toEqual([]);
    expect(b.remote).toEqual({ serverId: SERVER_ID, audio: true, ebook: false, cover: listed(1234).cover });
  });

  describe("once downloaded", () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(path.join(tmpdir(), "ribbon-server-books-"));
      const book = path.join(dir, SERVER_ID);
      mkdirSync(book, { recursive: true });
      for (const n of ["01", "02"]) execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "libmp3lame", "-b:a", "64k", "-metadata", `title=Part ${n}`, path.join(book, `${n}.mp3`)]);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=200x300:d=1", "-frames:v", "1", path.join(book, "cover.jpg")]);
      writeFileSync(path.join(book, "metadata.opf"), opfFor({ id: SERVER_ID, title: "The Red Book", author: "Ann Author & Bo Writer", narrator: "Nell Narrator", series: "Colours", seriesIndex: 2 }));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("gets the id it had before, its name from the server, and its cover", async () => {
      const audioBytes = ["01", "02"].reduce((s, n) => s + statSync(path.join(dir, SERVER_ID, `${n}.mp3`)).size, 0);
      const { books } = await scanLibrary(nodeHost(), dir, { write: false });
      expect(books).toHaveLength(1);
      expect(books[0]!.book).toMatchObject({ id: localIdOf(listed(audioBytes)), title: "The Red Book", narrator: "Nell Narrator", series: "Colours", seriesIndex: 2, cover: `${SERVER_ID}/cover.jpg` });
      expect(books[0]!.book.author).toMatch(/Ann Author/);
      expect(books[0]!.files.map((f) => f.path)).toEqual([`${SERVER_ID}/01.mp3`, `${SERVER_ID}/02.mp3`]);
    });

    it("an EPUB alone gets the id its listing predicted", async () => {
      const only = mkdtempSync(path.join(tmpdir(), "ribbon-server-epub-"));
      mkdirSync(path.join(only, SERVER_ID));
      writeFileSync(path.join(only, SERVER_ID, "book.epub"), "PK an EPUB's bytes");
      const ebookBytes = statSync(path.join(only, SERVER_ID, "book.epub")).size;
      const { books } = await scanLibrary(nodeHost(), only, { write: false });
      expect(books.map((b) => b.book.id)).toEqual([localIdOf({ id: SERVER_ID, audio: false, sizeBytes: 0, ebookBytes })]);
      rmSync(only, { recursive: true, force: true });
    });
  });
});
