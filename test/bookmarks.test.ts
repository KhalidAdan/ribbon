import { describe, expect, it } from "vitest";
import { clipArgs, clipName, clipRange, parseBookmarks, serializeBookmarks } from "../src/core/bookmarks";
import type { Bookmark } from "../src/core/types";

describe("bookmarks", () => {
  it("round-trips hostile notes and sorts by offset", async () => {
    const list: Bookmark[] = [
      { bookId: "b", offsetMs: 90_000, createdAt: "2026-01-01T00:00:00.000Z", note: 'has "quotes", commas,\nand a newline', clip: "b-90000.opus" },
      { bookId: "b", offsetMs: 10_000, createdAt: "2026-01-01T00:00:00.000Z", note: "", clip: "" },
    ];
    const bytes = await serializeBookmarks(list);
    const { bookmarks, problems } = await parseBookmarks(bytes);
    expect(problems).toEqual([]);
    expect(bookmarks.map((b) => b.offsetMs)).toEqual([10_000, 90_000]);
    expect(bookmarks[1]?.note).toBe(list[0]!.note);
  });

  it("computes clip ranges that never go negative", () => {
    expect(clipRange(10_000)).toEqual({ startMs: 0, endMs: 10_000 });
    expect(clipRange(100_000)).toEqual({ startMs: 70_000, endMs: 100_000 });
    expect(clipRange(0)).toEqual({ startMs: 0, endMs: 0 });
  });

  it("names clips uniquely per offset", () => {
    expect(clipName("abcd", 100_000)).toBe("abcd-100000.opus");
    expect(clipName("abcd", 100_001)).not.toBe(clipName("abcd", 100_000));
  });

  it("builds an ffmpeg command with seconds", () => {
    const args = clipArgs("in.mp3", 70_000, 100_000, "out.opus");
    expect(args).toContain("70.000");
    expect(args).toContain("100.000");
    expect(args[args.length - 1]).toBe("out.opus");
  });
});
