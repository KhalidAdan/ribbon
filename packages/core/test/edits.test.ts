import { describe, expect, it } from "vitest";
import { applyEdits, bytesToEdits, changedFields, coverDateFrom, diffEdits, editColumn, editsToBytes, fieldText, hasEdits, originalOf, sharedEdits, withUnknownRows, type BookEdits } from "@ribbon/core/edits";
import { namedComic } from "@ribbon/core/comic-name";
import type { Book } from "@ribbon/core/types";

const comic: Book = {
  id: "c1",
  path: "Transformers 007.cbz",
  title: "Transformers #7",
  rawTitle: "",
  author: "Daniel Warren Johnson",
  narrator: "",
  series: "Transformers (2023)",
  seriesIndex: 7,
  year: 2024,
  cover: "",
  comic: "Transformers 007.cbz",
  issue: "7",
  coverDate: "2024-03",
  credits: { writers: ["Daniel Warren Johnson"] },
  durationMs: 0,
  sizeBytes: 1,
  fileCount: 0,
};

/** A comic's own details as edits (docs/BOOK-DETAILS.md, section 4). */
describe("a comic's own details, edited", () => {
  it("lay over its files, each in its own field", () => {
    const b = applyEdits(comic, {
      pencils: "Jorge Corona; Jorge Corona",
      colours: "Mike Spicer",
      letters: "Rus Wooton",
      coverArtists: "Daniel Warren Johnson; Mike Spicer",
      imprint: "Skybound",
      coverDate: "July 2024",
      onSale: "2024-07-10",
      storyArcs: "Robots in Disguise; Batman/Superman, Part 2",
    });
    expect(b.credits).toEqual({ writers: ["Daniel Warren Johnson"], pencils: ["Jorge Corona"], colours: ["Mike Spicer"], letters: ["Rus Wooton"], coverArtists: ["Daniel Warren Johnson", "Mike Spicer"] });
    expect(b).toMatchObject({ imprint: "Skybound", coverDate: "2024-07", onSale: "2024-07-10", storyArcs: ["Robots in Disguise", "Batman/Superman, Part 2"] });
  });

  it("empty a field, so what the file says doesn't come back: an issue made a collection", () => {
    const b = applyEdits(comic, { issue: "", volume: "1", collects: "1–6", writers: "" });
    expect(b.issue).toBeUndefined();
    expect(b.credits).toBeUndefined();
    expect(b).toMatchObject({ volume: "1", collects: "1–6" });
    expect(namedComic(b).title).toBe("Transformers Vol. 1");
  });

  it("set a comic's title as the story's own name, which may be none", () => {
    const titled = applyEdits({ ...comic, rawTitle: "Chapter Seven" }, { title: "Robots" });
    expect(titled.rawTitle).toBe("Robots");
    expect(namedComic(titled).title).toBe("Transformers #7: Robots");
    const none = applyEdits({ ...comic, rawTitle: "Chapter Seven" }, { title: "" });
    expect(none.rawTitle).toBe("");
    expect(namedComic(none).title).toBe("Transformers #7");
    expect(fieldText({ ...comic, rawTitle: "Chapter Seven" }, "title")).toBe("Chapter Seven");
  });

  it("show as form text, names apart by semicolons", () => {
    const b = { ...comic, credits: { writers: ["Ada Quill", "Ben Nib"] }, storyArcs: ["One", "Two"] };
    expect(fieldText(b, "writers")).toBe("Ada Quill; Ben Nib");
    expect(fieldText(b, "pencils")).toBe("");
    expect(fieldText(b, "storyArcs")).toBe("One; Two");
    expect(fieldText(b, "issue")).toBe("7");
    expect(fieldText(b, "coverDate")).toBe("2024-03");
    expect(originalOf(b, { writers: "Someone", issue: "8" })).toEqual({ writers: "Ada Quill; Ben Nib", issue: "7" });
  });

  it("are a change only where they say something else", () => {
    // The same names spaced differently, and the same month written another way, are no change.
    expect(diffEdits(comic, { writers: " Daniel Warren Johnson ", coverDate: "2024-3", issue: "7" })).toEqual({});
    expect(diffEdits(comic, { writers: "Daniel Warren Johnson; Jorge Corona", coverDate: "March 2024" })).toEqual({ writers: "Daniel Warren Johnson; Jorge Corona" });
    expect(changedFields(comic, { inks: "Jorge Corona", issue: "7" })).toEqual({ inks: "Jorge Corona" });
  });

  it("go to a server as any edit does", () => {
    expect(sharedEdits({ issue: "7", coverArtists: "Someone", cover: "x.jpg" })).toEqual({ issue: "7", coverArtists: "Someone" });
  });

  it("round-trip through their CSV, each in a column named as the design names it", async () => {
    const e: BookEdits = { bookId: "c1", values: { issue: "1.MU", coverArtists: "A; B", coverDate: "2024-07", onSale: "2024-07-10", storyArcs: "One; Two", translators: "C" }, updatedAt: "2026-11-25T12:00:00.000Z" };
    const text = new TextDecoder().decode(await editsToBytes(e));
    for (const column of ["issue,1.MU", "cover_artists,A; B", "cover_date,2024-07", "on_sale,2024-07-10", "story_arcs,One; Two", "translators,C"]) expect(text).toContain(column);
    expect(await bytesToEdits("c1", await editsToBytes(e))).toEqual(e);
    expect(editColumn("coverArtists")).toBe("cover_artists");
  });
});

describe("a cover date as a person types it", () => {
  it("is kept as a month and a year, or a year", () => {
    expect(coverDateFrom("2024-07")).toBe("2024-07");
    expect(coverDateFrom("2024-7")).toBe("2024-07");
    expect(coverDateFrom("2024/07")).toBe("2024-07");
    expect(coverDateFrom("2024-07-10")).toBe("2024-07");
    expect(coverDateFrom("7/2024")).toBe("2024-07");
    expect(coverDateFrom("July 2024")).toBe("2024-07");
    expect(coverDateFrom("Sept. 2024")).toBe("2024-09");
    expect(coverDateFrom("2024")).toBe("2024");
  });

  it("is nothing when it can't be read as one", () => {
    expect(coverDateFrom("2024-13")).toBeNull();
    expect(coverDateFrom("Summer 2024")).toBeNull();
    expect(coverDateFrom("")).toBeNull();
    expect(applyEdits(comic, { coverDate: "someday" }).coverDate).toBeUndefined();
  });
});

/** Fields a version doesn't know (docs/BOOK-DETAILS.md, section 4): a newer Ribbon's rows outlive a save here. */
describe("edits a newer version wrote", () => {
  const newer = "field,value,updated_at\ntitle,Robots,2026-12-01T00:00:00.000Z\nlooked_up,4000-1,2026-12-02T00:00:00.000Z\nsomething_else,\"a, b\",2026-12-03T00:00:00.000Z\n";

  it("are read with the rows this version doesn't know kept as they were", async () => {
    const e = await bytesToEdits("c1", new TextEncoder().encode(newer));
    expect(e.values).toEqual({ title: "Robots" });
    expect(e.unknownRows).toEqual([
      { field: "looked_up", value: "4000-1", updated_at: "2026-12-02T00:00:00.000Z" },
      { field: "something_else", value: "a, b", updated_at: "2026-12-03T00:00:00.000Z" },
    ]);
  });

  it("keep those rows through a save, whatever the save changes, and through taking every edit back", async () => {
    const before = await bytesToEdits("c1", new TextEncoder().encode(newer));
    const saved = withUnknownRows({ bookId: "c1", values: { title: "Robots in Disguise", issue: "1" }, updatedAt: "2026-12-04T00:00:00.000Z" }, before);
    const text = new TextDecoder().decode(await editsToBytes(saved));
    expect(text).toContain("looked_up,4000-1,2026-12-02T00:00:00.000Z");
    expect(text).toContain('something_else,"a, b",2026-12-03T00:00:00.000Z');
    expect((await bytesToEdits("c1", await editsToBytes(saved))).unknownRows).toEqual(before.unknownRows);
    const none = withUnknownRows({ bookId: "c1", values: {}, updatedAt: "2026-12-04T00:00:00.000Z" }, before);
    expect(hasEdits(none)).toBe(true);
    expect(hasEdits(withUnknownRows({ bookId: "c1", values: {}, updatedAt: "" }, null))).toBe(false);
  });
});
