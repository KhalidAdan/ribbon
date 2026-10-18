import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { nodeHost } from "../src/host/node";
import { scanLibrary } from "../src/core/scan/scan";
import { resolveMetadata, withSideFiles } from "../src/core/scan/metadata";
import { booksToBytes, bytesToBooks } from "../src/core/scan/records";
import type { ProbeResult } from "../src/core/scan/probe";
import type { Book } from "../src/core/types";

const pr = (tags: Record<string, string>): ProbeResult => ({ durationMs: 0, tags, hasCover: false, chapters: [], codec: "", sampleRate: 0, channels: 0 });

describe("details from tags", () => {
  it("reads subtitle, genres, publisher, language, identifiers and the longest description", () => {
    const m = resolveMetadata(
      [
        pr({ album: "Dune", artist: "Frank Herbert", subtitle: "Book One", genre: "Science Fiction; Classics", publisher: "Macmillan Audio", language: "eng", isbn: "978-1-4272-0614-9", asin: "B002V1OF70", desc: "Short." }),
        pr({ ldes: "Set on the desert planet Arrakis, Dune is the story of the boy Paul Atreides." }),
      ],
      "Dune",
      "",
    );
    expect(m.subtitle).toBe("Book One");
    expect(m.genres).toEqual(["Science Fiction", "Classics"]);
    expect(m.publisher).toBe("Macmillan Audio");
    expect(m.language).toBe("eng");
    expect(m.isbn).toBe("9781427206149");
    expect(m.asin).toBe("B002V1OF70");
    expect(m.description).toBe("Set on the desert planet Arrakis, Dune is the story of the boy Paul Atreides.");
  });

  it("takes a comment only when it reads like prose about the book", () => {
    expect(resolveMetadata([pr({ comment: "Encoded by LAME 3.100 at 64kbps for the audiobook release of this title" })], "X", "").description).toBeUndefined();
    expect(resolveMetadata([pr({ comment: "short" })], "X", "").description).toBeUndefined();
    const prose = "A young boy discovers he is a wizard and is invited to attend a school of witchcraft.";
    expect(resolveMetadata([pr({ comment: prose })], "X", "").description).toBe(prose);
  });

  it("reads folder marks and keeps them out of the title", () => {
    const m = resolveMetadata([pr({})], "1965 - Dune {Scott Brick} [B002V1OF70]", "file");
    expect(m.title).toBe("Dune");
    expect(m.narrator).toBe("Scott Brick");
    expect(m.asin).toBe("B002V1OF70");
    expect(m.year).toBe(1965);
  });

  it("a tag narrator beats a folder mark", () => {
    expect(resolveMetadata([pr({ composer: "Simon Vance" })], "Dune {Scott Brick}", "").narrator).toBe("Simon Vance");
  });

  it("side files go over tags, and a numbered folder keeps its name and number", () => {
    const base = resolveMetadata([pr({ album: "Tag Title", artist: "Tag Author" })], "07. Legion", "", "The Horus Heresy");
    const m = withSideFiles(base, { title: "Legion", authors: ["Dan Abnett"], narrators: ["Martyn Ellis"], seriesIndex: 99, description: "From the OPF." }, true);
    expect(m.title).toBe("07. Legion");
    expect(m.seriesIndex).toBe(7);
    expect(m.author).toBe("Dan Abnett");
    expect(m.narrator).toBe("Martyn Ellis");
    expect(m.description).toBe("From the OPF.");
  });
});

describe("details in the records", () => {
  it("round-trip through library.csv, and an old record reads as empty", async () => {
    const book: Book = {
      id: "abc",
      path: "Dune",
      title: "Dune",
      rawTitle: "Dune",
      author: "Frank Herbert",
      narrator: "Scott Brick",
      series: "",
      seriesIndex: null,
      year: 1965,
      subtitle: "Book One",
      genres: ["Science Fiction", "Classics"],
      publisher: "Macmillan",
      description: 'Line one, with "quotes".\nLine two.',
      language: "eng",
      isbn: "9781427206149",
      asin: "B002V1OF70",
      cover: "",
      durationMs: 1,
      sizeBytes: 2,
      fileCount: 1,
    };
    const [back] = await bytesToBooks(await booksToBytes([book]));
    expect(back).toEqual(book);
    const old = new TextEncoder().encode("id,path,title,raw_title,author,narrator,series,series_index,year,cover,duration_ms,size_bytes,file_count\nx,p,T,T,A,N,,,,,1,2,1\n");
    const [plain] = await bytesToBooks(old);
    expect(plain!.genres).toBeUndefined();
    expect(plain!.description).toBeUndefined();
  });
});

function ff(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], (e) => (e ? reject(e) : resolve())));
}

describe("a scan with side files", () => {
  let root = "";
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-details-"));
    const dir = path.join(root, "1965 - Dune {Scott Brick} [B002V1OF70]");
    await fs.mkdir(dir, { recursive: true });
    await ff(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=22050:duration=2", "-metadata", "album=Dune", "-metadata", "artist=Frank Herbert", "-metadata", "genre=Science Fiction", "-c:a", "libmp3lame", "-b:a", "32k", path.join(dir, "01.mp3")]);
    await fs.writeFile(
      path.join(dir, "metadata.opf"),
      `<package><metadata><dc:title>Dune</dc:title><dc:creator opf:role="aut">Frank Herbert</dc:creator><dc:publisher>Macmillan Audio</dc:publisher><dc:language>en</dc:language><dc:subject>Classics</dc:subject></metadata></package>`,
    );
    await fs.writeFile(path.join(dir, "desc.txt"), "Set on the desert planet Arrakis.\n");
    await fs.writeFile(path.join(dir, "reader.txt"), "Scott Brick, Simon Vance, Euan Morton\n");
  }, 60_000);
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reads the OPF, desc.txt, reader.txt and the folder marks into the book", async () => {
    const { books, errors } = await scanLibrary(nodeHost(), root);
    expect(errors).toEqual([]);
    expect(books).toHaveLength(1);
    const b = books[0]!.book;
    expect(b.title).toBe("Dune");
    expect(b.year).toBe(1965);
    expect(b.asin).toBe("B002V1OF70");
    expect(b.narrator).toBe("Scott Brick, Simon Vance, Euan Morton");
    expect(b.description).toBe("Set on the desert planet Arrakis.");
    expect(b.publisher).toBe("Macmillan Audio");
    expect(b.language).toBe("en");
    expect(b.genres).toEqual(["Classics"]);
  });

  it("an older library.csv without the detail columns makes the next scan read every file again", async () => {
    const recordsDir = path.join(root, ".ribbon");
    const library = await fs.readFile(path.join(recordsDir, "library.csv"), "utf8");
    const old = library
      .split("\n")
      .map((line) => line.split(",").slice(0, 13).join(","))
      .join("\n");
    await fs.writeFile(path.join(recordsDir, "library.csv"), old);
    const again = await scanLibrary(nodeHost(), root);
    expect(again.probed).toBe(1);
    expect(again.books[0]!.book.publisher).toBe("Macmillan Audio");
    const third = await scanLibrary(nodeHost(), root);
    expect(third.probed).toBe(0);
    expect(third.books[0]!.book.description).toBe("Set on the desert planet Arrakis.");
  });
});
