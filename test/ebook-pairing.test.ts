import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { groupBooks } from "../src/core/scan/group";
import type { FileEntry } from "../src/core/scan/walk";
import { nodeHost } from "../src/host/node";
import { loadLibrary, scanLibrary } from "../src/core/scan/scan";
import { booksToBytes, bytesToBooks } from "../src/core/scan/records";
import { openEbook, EBOOK_FORMAT } from "../src/core/ebook";
import type { Host } from "../src/host/host";
import type { Book } from "../src/core/types";

const f = (relPath: string): FileEntry => ({ relPath, absPath: `/lib/${relPath}`, name: relPath.slice(relPath.lastIndexOf("/") + 1), sizeBytes: 1, mtimeMs: 0 });

describe("pairing an EPUB with a book (docs/READING.md, section 2)", () => {
  it("takes the EPUB in the book's folder, the first by name when there are several", () => {
    const g = groupBooks([f("Voidscarred/01.mp3"), f("Voidscarred/Voidscarred.epub"), f("Voidscarred/Another.epub"), f("Other/01.mp3")]);
    expect(g.map((x) => [x.path, x.ebook])).toEqual([
      ["Voidscarred", "Voidscarred/Another.epub"],
      ["Other", undefined],
    ]);
  });

  it("pairs a loose file only with the EPUB of the same name", () => {
    const g = groupBooks([f("Voidscarred.m4b"), f("voidscarred.epub"), f("Horus Rising.m4b"), f("Something else.epub")]);
    expect(g.map((x) => [x.path, x.ebook])).toEqual([
      ["Voidscarred.m4b", "voidscarred.epub"],
      ["Horus Rising.m4b", undefined],
    ]);
  });

  it("gives an anthology the EPUB in its own folder, and an EPUB alone is not a book", () => {
    const g = groupBooks([f("03. Tales/01. First/a.mp3"), f("03. Tales/02. Second/b.mp3"), f("03. Tales/Tales.epub"), f("Reading/Only.epub")]);
    expect(g.map((x) => [x.path, x.ebook])).toEqual([["03. Tales", "03. Tales/Tales.epub"]]);
  });

  it("is kept in library.csv, and an older record has none", async () => {
    const book: Book = { id: "abc", path: "Voidscarred", title: "Voidscarred", rawTitle: "Voidscarred", author: "Mike Brooks", narrator: "", series: "", seriesIndex: null, year: null, cover: "", ebook: "Voidscarred/Voidscarred.epub", durationMs: 1, sizeBytes: 2, fileCount: 1 };
    const [back] = await bytesToBooks(await booksToBytes([book]));
    expect(back).toEqual(book);
    const [old] = await bytesToBooks(new TextEncoder().encode("id,path,title,raw_title,author,narrator,series,series_index,year,cover,duration_ms,size_bytes,file_count\nx,p,T,T,A,N,,,,,1,2,1\n"));
    expect(old!.ebook).toBeUndefined();
  });
});

function ff(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], (e) => (e ? reject(e) : resolve())));
}

describe("a scan with an EPUB beside the audio", () => {
  let root = "";
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-ebook-"));
    const dir = path.join(root, "Voidscarred");
    await fs.mkdir(dir);
    await ff(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=22050:duration=2", "-metadata", "album=Voidscarred", "-c:a", "libmp3lame", "-b:a", "32k", path.join(dir, "01.mp3")]);
    // The scan never opens it, so any bytes will do.
    await fs.writeFile(path.join(dir, "Voidscarred.epub"), "PK");
  }, 60_000);
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("pairs it, keeps it in the records, and does not count it as a file of the book", async () => {
    const { books, errors } = await scanLibrary(nodeHost(), root);
    expect(errors).toEqual([]);
    expect(books[0]!.book.ebook).toBe("Voidscarred/Voidscarred.epub");
    expect(books[0]!.files.map((x) => x.path)).toEqual(["Voidscarred/01.mp3"]);
    expect(books[0]!.book.fileCount).toBe(1);
    const loaded = await loadLibrary(nodeHost(), root);
    expect(loaded![0]!.book.ebook).toBe("Voidscarred/Voidscarred.epub");
  });

  it("forgets it when it is gone", async () => {
    await fs.rm(path.join(root, "Voidscarred", "Voidscarred.epub"));
    const { books } = await scanLibrary(nodeHost(), root);
    expect(books[0]!.book.ebook).toBeUndefined();
  });
});

describe("opening a book's EPUB", () => {
  const model = { format: EBOOK_FORMAT, meta: { title: "T", authors: [], identifiers: [] }, layout: "reflowable", sections: [{ href: "a.xhtml", linear: true, overlay: null, chars: 1, blocks: [{ k: "p", runs: [{ t: "A" }] }] }], toc: [] };
  const host = (answer: () => Promise<string>, seen: string[] = []): Host => ({ ...nodeHost(), openEbook: (p: string) => (seen.push(p), answer()) });

  it("opens it where it sits", async () => {
    const seen: string[] = [];
    const r = await openEbook(host(async () => JSON.stringify(model), seen), path.join("lib"), { ebook: "Voidscarred/Voidscarred.epub" });
    expect(r.ok).toBe(true);
    expect(seen).toEqual([path.join("lib", "Voidscarred", "Voidscarred.epub")]);
  });

  it("says plainly why it cannot", async () => {
    const reason = async (h: Host, book: { ebook?: string } = { ebook: "a.epub" }) => {
      const r = await openEbook(h, "lib", book);
      return r.ok ? "ok" : r.reason;
    };
    expect(await reason(host(() => Promise.reject(new Error("drm: this EPUB is locked with DRM"))))).toBe("drm");
    expect(await reason(host(() => Promise.reject("unreadable: not a zip file")))).toBe("unreadable");
    expect(await reason(host(async () => JSON.stringify({ ...model, layout: "pre-paginated" })))).toBe("fixed-layout");
    expect(await reason(host(async () => JSON.stringify({ ...model, format: "ribbon-ebook/9" })))).toBe("unreadable");
    expect(await reason(host(async () => "{"))).toBe("unreadable");
    expect(await reason(nodeHost())).toBe("unsupported");
    expect(await reason(host(async () => "{}"), {})).toBe("unreadable");
  });
});
