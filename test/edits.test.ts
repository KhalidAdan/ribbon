import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyEdits, bytesToEdits, diffEdits, editsToBytes, fieldText } from "../src/core/edits";
import { LibraryService } from "../src/app/library";
import { nodeHost } from "../src/host/node";
import type { Book } from "../src/core/types";
import type { ScannedBook } from "../src/core/scan/scan";

const files: Book = {
  id: "b1",
  path: "Dune",
  title: "Dune (Unabridged)",
  rawTitle: "Dune (Unabridged)",
  author: "Frank Herbert",
  narrator: "",
  series: "",
  seriesIndex: null,
  year: null,
  genres: ["Sci-Fi"],
  cover: "Dune/cover.jpg",
  durationMs: 1,
  sizeBytes: 1,
  fileCount: 1,
};

describe("edits", () => {
  it("lay over the files field by field, typed", () => {
    const b = applyEdits(files, { title: "Dune", narrator: "Scott Brick; Simon Vance", series: "Dune Chronicles", seriesIndex: "1", year: "1965", genres: "Science Fiction, Classics" });
    expect(b.title).toBe("Dune");
    expect(b.rawTitle).toBe("Dune");
    expect(b.narrator).toBe("Scott Brick; Simon Vance");
    expect(b.series).toBe("Dune Chronicles");
    expect(b.seriesIndex).toBe(1);
    expect(b.year).toBe(1965);
    expect(b.genres).toEqual(["Science Fiction", "Classics"]);
    expect(b.author).toBe("Frank Herbert");
  });

  it("an emptied title keeps the files' title; an emptied series index is none", () => {
    const b = applyEdits({ ...files, seriesIndex: 3 }, { title: "  ", seriesIndex: "" });
    expect(b.title).toBe("Dune (Unabridged)");
    expect(b.seriesIndex).toBeNull();
  });

  it("only what differs from the files is an edit", () => {
    const form = { title: "Dune", author: "Frank Herbert", genres: "sci-fi", year: "", narrator: "Scott Brick" };
    expect(diffEdits(files, form)).toEqual({ title: "Dune", narrator: "Scott Brick" });
  });

  it("a cover edit survives a form that does not mention it", () => {
    expect(diffEdits(files, { title: "Dune" }, { cover: ".ribbon/covers/edited-b1-x.png" })).toEqual({ title: "Dune", cover: ".ribbon/covers/edited-b1-x.png" });
  });

  it("round-trip through their CSV, multi-line description and all", async () => {
    const e = { bookId: "b1", values: { title: "Dune", description: 'A "desert" planet,\nand spice.' }, updatedAt: "2026-10-18T12:00:00.000Z" };
    expect(await bytesToEdits("b1", await editsToBytes(e))).toEqual(e);
  });

  it("show as form text", () => {
    expect(fieldText({ ...files, seriesIndex: 2.5, year: 1965 }, "seriesIndex")).toBe("2.5");
    expect(fieldText(files, "genres")).toBe("Sci-Fi");
    expect(fieldText(files, "subtitle")).toBe("");
  });
});

describe("edits beside the books", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-edits-"));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("are written, read back, and removed when empty", async () => {
    const lib = new LibraryService(nodeHost(), dir);
    await lib.writeEdits({ bookId: "b1", values: { title: "Dune" }, updatedAt: "2026-10-18T12:00:00.000Z" });
    await lib.writeEdits({ bookId: "b2", values: { narrator: "Someone" }, updatedAt: "2026-10-18T12:00:00.000Z" });
    const all = await lib.readAllEdits();
    expect([...all.keys()].sort()).toEqual(["b1", "b2"]);
    expect(all.get("b1")!.values.title).toBe("Dune");
    await lib.writeEdits({ bookId: "b1", values: {}, updatedAt: "2026-10-18T12:00:00.000Z" });
    expect([...(await lib.readAllEdits()).keys()]).toEqual(["b2"]);
  });

  it("a chosen cover gets a new name every time, and so does its copy in the mirror", async () => {
    const lib = new LibraryService(nodeHost(), dir);
    const a = await lib.writeEditedCover("b1", new Uint8Array([1, 2, 3]), "PNG", 1000);
    const b = await lib.writeEditedCover("b1", new Uint8Array([4]), "jpg", 2000);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^\.ribbon\/covers\/edited-b1-[0-9a-z]+\.png$/);
    expect(await fs.readFile(path.join(dir, ...a.split("/")))).toEqual(Buffer.from([1, 2, 3]));
    const book = (cover: string) => ({ book: { ...files, cover }, files: [], chapters: [], parts: [] }) as ScannedBook;
    expect(LibraryService.mirrorCoverName(book(a))).not.toBe(LibraryService.mirrorCoverName(book(b)));
    expect(LibraryService.mirrorCoverName(book("Dune/cover.jpg"))).toBe("b1.jpg");
  });
});
