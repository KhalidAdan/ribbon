import { describe, expect, it } from "vitest";
import { orderKeys, parseTrack, resolveMetadata } from "../src/core/scan/metadata";
import type { ProbeResult } from "../src/core/scan/probe";

const pr = (tags: Record<string, string>): ProbeResult => ({ durationMs: 0, tags, hasCover: false, chapters: [], codec: "", sampleRate: 0, channels: 0 });

describe("parseTrack and orderKeys", () => {
  it("parses n/m and junk", () => {
    expect(parseTrack("3/22")).toBe(3);
    expect(parseTrack("07")).toBe(7);
    expect(parseTrack("")).toBe(0);
    expect(parseTrack(undefined)).toBe(0);
    expect(parseTrack("abc")).toBe(0);
  });

  it("defaults disc 0 or missing to 1", () => {
    expect(orderKeys({ disc: "0", track: "4" })).toEqual({ disc: 1, track: 4 });
    expect(orderKeys({ tracknumber: "4" })).toEqual({ disc: 1, track: 4 });
    expect(orderKeys({ disc: "2/3", track: "1" })).toEqual({ disc: 2, track: 1 });
  });
});

describe("resolveMetadata", () => {
  it("reads title, author, narrator, series, year", () => {
    const m = resolveMetadata([pr({ album: "The Book (Unabridged)", artist: "Ada", composer: "Nora", series: "S", "series-part": "2.5", date: "2021-03-04" })], "Folder", "file");
    expect(m).toEqual({ title: "The Book", rawTitle: "The Book (Unabridged)", author: "Ada", narrator: "Nora", series: "S", seriesIndex: 2.5, year: 2021 });
  });

  it("falls back to folder name then file name", () => {
    expect(resolveMetadata([pr({})], "Folder", "file").title).toBe("Folder");
    expect(resolveMetadata([pr({})], "", "file").title).toBe("file");
  });

  it("uses the title tag for a single file with no album", () => {
    expect(resolveMetadata([pr({ title: "Loose Episode" })], "", "loose").title).toBe("Loose Episode");
  });

  it("prefers artist over album_artist and composer over narrator", () => {
    expect(resolveMetadata([pr({ album_artist: "AA", artist: "A" })], "", "").author).toBe("A");
    expect(resolveMetadata([pr({ album_artist: "AA" })], "", "").author).toBe("AA");
    expect(resolveMetadata([pr({ narrator: "N" })], "", "").narrator).toBe("N");
  });

  it("uses the most common album across files", () => {
    const m = resolveMetadata([pr({ album: "X" }), pr({ album: "Y" }), pr({ album: "Y" })], "F", "");
    expect(m.title).toBe("Y");
  });

  it("reads iTunes movement atoms for series", () => {
    const m = resolveMetadata([pr({ mvnm: "Horus Heresy", mvin: "1" })], "", "");
    expect(m.series).toBe("Horus Heresy");
    expect(m.seriesIndex).toBe(1);
  });

  it("leaves year null without a date", () => {
    expect(resolveMetadata([pr({ date: "unknown" })], "", "").year).toBeNull();
  });
});
