import { beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { nodeHost } from "../src/host/node";
import { scanLibrary, loadLibrary, ensureChapters, type ScanResult } from "../src/core/scan/scan";
import { FIXTURE_ROOT } from "../tools/make-fixtures";
import { locate } from "../src/core/timeline";

const host = nodeHost();

describe("scanLibrary over generated fixtures", () => {
  let result: ScanResult;

  beforeAll(async () => {
    await fs.rm(path.join(FIXTURE_ROOT, ".odio"), { recursive: true, force: true });
    result = await scanLibrary(host, FIXTURE_ROOT);
  });

  const byPath = (p: string) => {
    const b = result.books.find((x) => x.book.path === p);
    if (!b) throw new Error(`no book at ${p}: ${result.books.map((x) => x.book.path).join(", ")}`);
    return b;
  };

  it("finds every fixture book exactly once with no errors", () => {
    expect(result.errors).toEqual([]);
    expect(result.books.map((b) => b.book.path).sort()).toEqual(
      ["flac", "gaps", "loose.mp3", "loud", "multi-m4a-natural", "multi-mp3", "nested/Series/Book One", "nested/Series/Book Two", "opus", "quiet", "single-m4b"].sort(),
    );
    expect(result.reused).toBe(0);
    expect(result.probed).toBe(1 + 5 + 12 + 1 + 2 + 1 + 2 + 3);
  });

  it("reads the single M4B: chapters, tags, series, cover", () => {
    const b = byPath("single-m4b");
    expect(b.book.title).toBe("The Single Book");
    expect(b.book.author).toBe("Ada Author");
    expect(b.book.narrator).toBe("Nora Narrator");
    expect(b.book.series).toBe("Fixture Series");
    expect(b.book.seriesIndex).toBeNull();
    expect(b.book.year).toBe(2021);
    expect(b.book.fileCount).toBe(1);
    expect(b.book.durationMs).toBeGreaterThan(5900);
    expect(b.book.durationMs).toBeLessThan(6200);
    expect(b.chapters.map((c) => c.title)).toEqual(["Opening", "Middle", "Closing"]);
    expect(b.chapters.map((c) => c.startMs)).toEqual([0, 2000, 4000]);
    expect(b.files[0]!.hasCover).toBe(true);
    expect(b.book.cover).toBe(`.odio/covers/${b.book.id}.jpg`);
  });

  it("extracts the embedded cover to .odio/covers as a JPEG", async () => {
    const b = byPath("single-m4b");
    const bytes = await fs.readFile(path.join(FIXTURE_ROOT, ".odio", "covers", `${b.book.id}.jpg`));
    expect(bytes.length).toBeGreaterThan(500);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  });

  it("orders multi-mp3 by track tag, not filename, and strips Unabridged", () => {
    const b = byPath("multi-mp3");
    expect(b.book.title).toBe("The Multi Book");
    expect(b.book.rawTitle).toBe("The Multi Book (Unabridged)");
    expect(b.book.year).toBe(1999);
    expect(b.book.series).toBe("Multi Series");
    expect(b.book.seriesIndex).toBe(2.5);
    expect(b.files.map((f) => f.path.slice(-6))).toEqual(["05.mp3", "04.mp3", "03.mp3", "02.mp3", "01.mp3"]);
    expect(b.files.map((f) => f.order)).toEqual([0, 1, 2, 3, 4]);
    expect(b.chapters.map((c) => c.title)).toEqual(["Part 1", "Part 2", "Part 3", "Part 4", "Part 5"]);
    expect(b.book.cover).toBe("multi-mp3/cover.jpg");
  });

  it("orders multi-m4a by natural filename when no track tags", () => {
    const b = byPath("multi-m4a-natural");
    const names = b.files.map((f) => f.path.slice(f.path.lastIndexOf("/") + 1));
    expect(names).toEqual(Array.from({ length: 12 }, (_, i) => `Chapter ${i + 1}.m4a`));
    expect(b.chapters).toHaveLength(12);
    expect(b.chapters[11]!.startMs).toBe(b.files.slice(0, 11).reduce((s, f) => s + f.durationMs, 0));
    expect(b.book.durationMs).toBe(b.files.reduce((s, f) => s + f.durationMs, 0));
  });

  it("makes the loose root file a one-file book titled from its tag", () => {
    const b = byPath("loose.mp3");
    expect(b.book.title).toBe("Loose Episode");
    expect(b.book.author).toBe("Dee Author");
    expect(b.book.fileCount).toBe(1);
    expect(b.chapters).toHaveLength(1);
  });

  it("handles opus and flac", () => {
    expect(byPath("opus").book.title).toBe("Opus Book");
    expect(byPath("flac").book.title).toBe("Flac Book");
    expect(byPath("opus").files[0]!.durationMs).toBeGreaterThan(1500);
  });

  it("groups nested series at the book folder and ignores notes.txt", () => {
    expect(byPath("nested/Series/Book One").files).toHaveLength(2);
    expect(byPath("nested/Series/Book Two").files).toHaveLength(1);
  });

  it("gives every book a stable eight-hex id", () => {
    for (const b of result.books) expect(b.book.id).toMatch(/^[0-9a-f]{8}$/);
    expect(new Set(result.books.map((b) => b.book.id)).size).toBe(result.books.length);
  });

  it("writes records that load back identically", async () => {
    const loaded = await loadLibrary(host, FIXTURE_ROOT);
    expect(loaded).not.toBeNull();
    expect(loaded!.map((b) => b.book)).toEqual(result.books.map((b) => b.book));
    expect(loaded!.map((b) => b.files)).toEqual(result.books.map((b) => b.files));
    expect(loaded!.map((b) => b.chapters)).toEqual(result.books.map((b) => b.chapters));
  });

  it("marks every file as chapter-probed on the ffprobe path", () => {
    for (const b of result.books) for (const f of b.files) expect(f.chaptersProbed).toBe(true);
  });

  it("ensureChapters is a no-op when everything is probed, and probes when not", async () => {
    const b = byPath("single-m4b");
    expect(await ensureChapters(host, FIXTURE_ROOT, b)).toBe(b);
    const stripped = { ...b, files: b.files.map((f) => ({ ...f, chapters: [], chaptersProbed: false })), chapters: [] };
    const probed = await ensureChapters(host, FIXTURE_ROOT, stripped);
    expect(probed).not.toBe(stripped);
    expect(probed.chapters.map((c) => c.title)).toEqual(["Opening", "Middle", "Closing"]);
    expect(probed.files[0]!.chaptersProbed).toBe(true);
    const reloaded = (await loadLibrary(host, FIXTURE_ROOT))!.find((x) => x.book.id === b.book.id)!;
    expect(reloaded.files[0]!.chaptersProbed).toBe(true);
    expect(reloaded.chapters.map((c) => c.title)).toEqual(["Opening", "Middle", "Closing"]);
  });

  it("ensureChapters recovers a cover the fast scanner missed", async () => {
    const b = byPath("single-m4b");
    await fs.rm(path.join(FIXTURE_ROOT, ".odio", "covers", `${b.book.id}.jpg`), { force: true });
    const blind = { ...b, book: { ...b.book, cover: "" }, files: b.files.map((f) => ({ ...f, hasCover: false, chaptersProbed: false })) };
    const fixed = await ensureChapters(host, FIXTURE_ROOT, blind);
    expect(fixed.files[0]!.hasCover).toBe(true);
    expect(fixed.book.cover).toBe(`.odio/covers/${b.book.id}.jpg`);
    const st = await fs.stat(path.join(FIXTURE_ROOT, ".odio", "covers", `${b.book.id}.jpg`));
    expect(st.size).toBeGreaterThan(500);
  });

  it("rescans incrementally without probing unchanged files", async () => {
    const again = await scanLibrary(host, FIXTURE_ROOT);
    expect(again.probed).toBe(0);
    expect(again.reused).toBe(result.probed);
    expect(again.books.map((b) => b.book)).toEqual(result.books.map((b) => b.book));
  });

  it("maps a book offset into the right file across boundaries", () => {
    const b = byPath("multi-mp3");
    const d = b.files.map((f) => f.durationMs);
    expect(locate(d, d[0]!).fileIndex).toBe(1);
    expect(locate(d, d[0]! - 1).fileIndex).toBe(0);
  });
});
