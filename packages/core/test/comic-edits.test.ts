import { describe, expect, it } from "vitest";
import { movedComicEdits } from "@ribbon/core/comic-edits";
import { namedComic } from "@ribbon/core/comic-name";
import { applyEdits, type EditValues } from "@ribbon/core/edits";
import type { Book } from "@ribbon/core/types";

/** A comic as its files have it. */
const files = (details: Partial<Book> = {}): Book => ({
  id: "c1",
  path: "Transformers 10 - Someone.cbz",
  title: "Transformers 10 - Someone",
  rawTitle: "Transformers 10 - Someone",
  author: "",
  narrator: "",
  series: "",
  seriesIndex: null,
  year: null,
  cover: "",
  comic: "Transformers 10 - Someone.cbz",
  durationMs: 0,
  sizeBytes: 1,
  fileCount: 0,
  ...details,
});

/** The comic as every device shows it, once its edits are moved: what a host does (comic-name.ts). */
const shown = (book: Book, values: EditValues) => {
  const moved = movedComicEdits(values, book);
  return namedComic(applyEdits(book, moved), moved);
};

/** Today's comic edits read as the new fields: one test for each row of docs/BOOK-DETAILS.md, section 6. */
describe("a comic's edits from before, moved", () => {
  it("drops a title that is the name the shelf now makes", () => {
    const saga = files({ series: "Saga", issue: "14", rawTitle: "" });
    expect(movedComicEdits({ title: "Saga #14" }, saga)).toEqual({});
    // However its case, its dashes and its spaces were written, and with the run's year said or not.
    const edits = { title: "transformers (2023)  #10", series: "Transformers (2023)", seriesIndex: "10" };
    expect(movedComicEdits(edits, files({ rawTitle: "" }))).toEqual({ series: "Transformers (2023)", issue: "10" });
    // A file that gives a title, kept off the shelf by the edit, is kept off it still: the shelf shows the same.
    expect(movedComicEdits(edits, files())).toEqual({ series: "Transformers (2023)", issue: "10", title: "" });
    expect(shown(files(), edits)).toMatchObject({ title: "Transformers #10", seriesIndex: 10 });
    // A title that was the whole name, the file's title and all, is dropped whole.
    expect(movedComicEdits({ title: "Saga #14: Chapter Fourteen" }, { ...saga, rawTitle: "Chapter Fourteen" })).toEqual({});
  });

  it("reads a title in the hint's shape as a volume and the issues it collects, its subtitle its title", () => {
    const edits = { title: "Transformers Vol. 1 (#1–#6)", subtitle: "Robots in Disguise", series: "Transformers (2023)", seriesIndex: "1" };
    expect(movedComicEdits(edits, files())).toEqual({ series: "Transformers (2023)", volume: "1", collects: "1–6", title: "Robots in Disguise" });
    expect(shown(files(), edits)).toMatchObject({ title: "Transformers Vol. 1: Robots in Disguise", seriesIndex: 1 });
    const saga = files({ series: "Saga", rawTitle: "" });
    // With no subtitle, it has no title of its own.
    expect(movedComicEdits({ title: "Saga Vol. 2 (#7-#12)" }, saga)).toEqual({ volume: "2", collects: "7–12" });
    expect(movedComicEdits({ title: "Saga Vol. 2 (#7-#12)" }, { ...saga, rawTitle: "Saga Two" })).toEqual({ volume: "2", collects: "7–12", title: "" });
    // A file that said it was an issue has its number emptied, so it doesn't come back as one.
    expect(movedComicEdits({ title: "Saga Vol. 2 (#7–#12)" }, { ...saga, issue: "7" })).toEqual({ volume: "2", collects: "7–12", issue: "" });
    // Without the issues, the shape is only the comic's own series and a volume.
    expect(movedComicEdits({ title: "Saga Vol. 2" }, saga)).toEqual({ volume: "2" });
    expect(movedComicEdits({ title: "Love Vol. 2" }, saga)).toEqual({ title: "Love Vol. 2" });
  });

  it("keeps any other title as the story's own name", () => {
    const made = files({ series: "Made Up Saga", issue: "2", rawTitle: "" });
    expect(movedComicEdits({ title: "The Long Way" }, made)).toEqual({ title: "The Long Way" });
    expect(shown(made, { title: "The Long Way" }).title).toBe("Made Up Saga #2: The Long Way");
  });

  it("joins a subtitle to the title kept, or makes it the title", () => {
    const made = files({ series: "Made Up Saga", issue: "2", rawTitle: "" });
    expect(movedComicEdits({ title: "The Long Way", subtitle: "Part One" }, made)).toEqual({ title: "The Long Way: Part One" });
    // Beside a title that was the name, or alone, it is the story's name; joined to the one its file gives, if it gives one.
    expect(movedComicEdits({ title: "Made Up Saga #2", subtitle: "Part One" }, made)).toEqual({ title: "Part One" });
    expect(movedComicEdits({ subtitle: "Part One" }, made)).toEqual({ title: "Part One" });
    expect(movedComicEdits({ subtitle: "Part One" }, { ...made, rawTitle: "The Long Way" })).toEqual({ title: "The Long Way: Part One" });
    expect(movedComicEdits({ subtitle: " " }, made)).toEqual({});
  });

  it("makes the number in the series a collection's volume, by its title or its file's name, and else an issue", () => {
    expect(movedComicEdits({ seriesIndex: "15" }, files({ series: "Saga", issue: "14" }))).toEqual({ issue: "15" });
    // "Saga Vol. 2.cbz": a collection by its file's name.
    expect(movedComicEdits({ seriesIndex: "3" }, files({ series: "Saga", volume: "2" }))).toEqual({ volume: "3" });
    // The number a title in the hint's shape gives stands: the number in the series was its place.
    expect(movedComicEdits({ title: "Saga Vol. 1 (#1–#6)", seriesIndex: "0.5" }, files({ series: "Saga", rawTitle: "" }))).toEqual({ volume: "1", collects: "1–6" });
    // An emptied number is no number.
    expect(movedComicEdits({ seriesIndex: "" }, files({ series: "Saga", issue: "14" }))).toEqual({ issue: "" });
  });

  it("keeps the author as a byline from before, shown until it is taken back", () => {
    const edits = { author: "Daniel Warren Johnson; Jorge Corona" };
    expect(movedComicEdits(edits, files())).toEqual(edits);
    const credited = files({ series: "Transformers (2023)", issue: "10", credits: { writers: ["Daniel Warren Johnson"] } });
    expect(shown(credited, edits).author).toBe("Daniel Warren Johnson; Jorge Corona");
    expect(shown(credited, {}).author).toBe("Daniel Warren Johnson");
  });

  it("leaves everything else as it was", () => {
    const edits = { description: "Writer: Daniel Warren Johnson. In stores July 10, 2024.", year: "2024", publisher: "Image", genres: "Science Fiction", language: "en", isbn: "9781534399990", rightToLeft: "no", cover: ".ribbon/covers/edited-c1-x.png" };
    expect(movedComicEdits({ ...edits, seriesIndex: "10" }, files({ series: "Transformers" }))).toEqual({ ...edits, issue: "10" });
  });
});

describe("moving a comic's edits", () => {
  it("names the owner's Transformers as the design says", () => {
    // #7 to #24: the title edit goes, the number is the issue, the byline stays until the credits are filled.
    const issue = { title: "Transformers #10", series: "Transformers (2023)", seriesIndex: "10", author: "Daniel Warren Johnson; Jorge Corona", description: "Writer: Daniel Warren Johnson." };
    expect(shown(files(), issue)).toMatchObject({ title: "Transformers #10", author: "Daniel Warren Johnson; Jorge Corona", series: "Transformers (2023)", seriesIndex: 10, issue: "10", description: "Writer: Daniel Warren Johnson." });
    // Vol. 1: volume 1, collecting 1 to 6, first in the series.
    const collection = { title: "Transformers Vol. 1 (#1–#6)", subtitle: "Robots in Disguise", series: "Transformers (2023)", seriesIndex: "1" };
    expect(shown(files(), collection)).toMatchObject({ title: "Transformers Vol. 1: Robots in Disguise", rawTitle: "Robots in Disguise", volume: "1", collects: "1–6", seriesIndex: 1 });
  });

  it("gives edits already moved back as they are, so they can be moved every time they are read", () => {
    const cases: [EditValues, Book][] = [
      [{ title: "Transformers #10", series: "Transformers (2023)", seriesIndex: "10" }, files()],
      [{ title: "Transformers Vol. 1 (#1–#6)", subtitle: "Robots in Disguise", series: "Transformers (2023)", seriesIndex: "1" }, files()],
      [{ title: "The Long Way", subtitle: "Part One", seriesIndex: "2" }, files({ series: "Made Up Saga" })],
    ];
    for (const [edits, book] of cases) {
      const once = movedComicEdits(edits, book);
      expect(movedComicEdits(once, book)).toEqual(once);
    }
    const already = { issue: "7", writers: "Ada Quill" };
    expect(movedComicEdits(already, files())).toBe(already);
  });

  it("moves nothing for a book that isn't a comic", () => {
    const { comic: _comic, ...audiobook } = files({ fileCount: 3 });
    const edits = { title: "Dune", subtitle: "Book One", seriesIndex: "1" };
    expect(movedComicEdits(edits, audiobook)).toBe(edits);
  });

  it("keeps an emptied title empty: no title of its own", () => {
    expect(movedComicEdits({ title: "", seriesIndex: "3" }, files({ series: "Saga" }))).toEqual({ title: "", issue: "3" });
  });
});
