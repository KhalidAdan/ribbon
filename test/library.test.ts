import { beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { nodeHost } from "../src/host/node";
import { LibraryService } from "../src/app/library";
import { measureLoudness, detectSilence } from "../src/app/jobs";
import { FIXTURE_ROOT } from "../tools/make-fixtures";
import type { ScannedBook } from "../src/core/scan/scan";
import { TARGET_LUFS } from "../src/core/loudness";

const lib = new LibraryService(nodeHost(), FIXTURE_ROOT);
let books: ScannedBook[];
const find = (p: string) => books.find((b) => b.book.path === p)!;

beforeAll(async () => {
  books = await lib.open();
  for (const d of ["positions", "settings", "bookmarks", "corrections", "loudness", "silence"]) {
    await fs.rm(path.join(FIXTURE_ROOT, ".odio", d), { recursive: true, force: true });
  }
});

describe("positions", () => {
  it("reads null before any write, then round-trips", async () => {
    const b = find("multi-mp3");
    expect(await lib.readPosition(b.book.id)).toBeNull();
    const written = await lib.writePosition(b.book.id, 1234.6, 1_757_000_000_000);
    expect(written.offsetMs).toBe(1235);
    expect(written.updatedAt).toBe("2025-09-04T15:33:20.000Z");
    const read = await lib.readPosition(b.book.id);
    expect(read).toEqual(written);
  });

  it("merges a sync-conflict copy and keeps the latest", async () => {
    const b = find("multi-mp3");
    await lib.writePosition(b.book.id, 100, 1_757_000_000_000);
    const conflict = `book_id,offset_ms,updated_at,device\n${b.book.id},999,2026-01-01T00:00:00.000Z,other-laptop\n`;
    await fs.writeFile(path.join(FIXTURE_ROOT, ".odio", "positions", `${b.book.id} (conflicted copy).csv`), conflict);
    const read = await lib.readPosition(b.book.id);
    expect(read?.offsetMs).toBe(999);
    expect(read?.device).toBe("other-laptop");
  });

  it("ignores other books' files", async () => {
    const a = find("multi-mp3");
    const b = find("single-m4b");
    await lib.writePosition(a.book.id, 5);
    expect(await lib.readPosition(b.book.id)).toBeNull();
  });
});

describe("settings", () => {
  it("defaults to 1x and round-trips a snapped speed", async () => {
    const b = find("single-m4b");
    expect(await lib.readSettings(b.book.id)).toEqual({ bookId: b.book.id, speed: 1 });
    await lib.writeSettings({ bookId: b.book.id, speed: 1.2600001 });
    expect(await lib.readSettings(b.book.id)).toEqual({ bookId: b.book.id, speed: 1.25 });
  });
});

describe("bookmarks", () => {
  it("adds a bookmark with a clip and removes it with the clip", async () => {
    const b = find("single-m4b");
    const bm = await lib.addBookmark(b, 4500, "a note, with comma");
    expect(bm.clip).toBe(`clips/${b.book.id}-4500.opus`);
    const clipPath = path.join(FIXTURE_ROOT, ".odio", "bookmarks", "clips", `${b.book.id}-4500.opus`);
    const st = await fs.stat(clipPath);
    expect(st.size).toBeGreaterThan(100);
    expect(await lib.readBookmarks(b.book.id)).toEqual([bm]);
    await lib.removeBookmark(b.book.id, 4500);
    expect(await lib.readBookmarks(b.book.id)).toEqual([]);
    await expect(fs.stat(clipPath)).rejects.toThrow();
  });

  it("clips inside the right file of a multi-file book", async () => {
    const b = find("multi-mp3");
    const secondFileStart = b.files[0]!.durationMs;
    const bm = await lib.addBookmark(b, secondFileStart + 500, "");
    expect(bm.clip).not.toBe("");
  });
});

describe("corrections", () => {
  it("persists and re-derives chapters", async () => {
    const b = find("multi-mp3");
    const updated = await lib.writeCorrections(b, [{ op: "rename", index: 0, title: "Prologue" }, { op: "delete", index: 1 }]);
    expect(updated.chapters.map((c) => c.title)).toEqual(["Prologue", "Part 3", "Part 4", "Part 5"]);
    expect(await lib.readCorrections(b.book.id)).toHaveLength(2);
    const reopened = await lib.open();
    expect(reopened.find((x) => x.book.id === b.book.id)!.chapters.map((c) => c.title)).toEqual(["Prologue", "Part 3", "Part 4", "Part 5"]);
    const rescanned = await lib.rescan();
    expect(rescanned.find((x) => x.book.id === b.book.id)!.chapters.map((c) => c.title)).toEqual(["Prologue", "Part 3", "Part 4", "Part 5"]);
  });
});

describe("loudness job", () => {
  it("brings quiet and loud books within 1 LU of each other", async () => {
    const quiet = find("quiet");
    const loud = find("loud");
    const gq = await measureLoudness(lib, quiet);
    const gl = await measureLoudness(lib, loud);
    expect(gq).not.toBeNull();
    expect(gl).not.toBeNull();
    const rq = (await lib.readLoudness(quiet.book.id))!;
    const rl = (await lib.readLoudness(loud.book.id))!;
    expect(rq.measurement.integratedLufs).toBeLessThan(rl.measurement.integratedLufs - 10);
    const afterQ = rq.measurement.integratedLufs + rq.gainDb;
    const afterL = rl.measurement.integratedLufs + rl.gainDb;
    expect(Math.abs(afterQ - afterL)).toBeLessThan(1);
    expect(Math.abs(afterQ - TARGET_LUFS)).toBeLessThan(1);
  }, 60_000);

  it("returns null for a missing record", async () => {
    expect(await lib.readLoudness("nope")).toBeNull();
  });
});

describe("silence job", () => {
  it("finds the three gaps in the gaps fixture", async () => {
    const b = find("gaps");
    const out = await detectSilence(lib, b);
    const ranges = out!.get(0)!;
    expect(ranges).toHaveLength(3);
    const lengths = ranges.map((r) => Math.round((r.endMs - r.startMs) / 100) / 10);
    expect(lengths[0]).toBeCloseTo(2, 0);
    expect(lengths[1]).toBeCloseTo(3, 0);
    expect(lengths[2]).toBeCloseTo(5, 0);
    expect(ranges[0]!.startMs).toBeGreaterThan(1800);
    expect(ranges[0]!.startMs).toBeLessThan(2300);
    const back = await lib.readSilence(b.book.id);
    expect(back!.get(0)).toEqual(ranges);
  }, 60_000);
});
