import { describe, expect, it } from "vitest";
import { namedComic } from "@ribbon/core/comic-name";
import { bytesToComics, comicFromFiles, comicFromTags, comicsToBytes, type ComicRecord } from "@ribbon/core/scan/comics";
import { bytesToBooks, booksToBytes } from "@ribbon/core/scan/records";
import type { Book } from "@ribbon/core/types";

const file = { path: "Transformers/Transformers 007.cbz", sizeBytes: 100, mtimeMs: 1 };

/** A record from a ComicInfo.xml of these fields. */
const recordOf = (fields: Record<string, string | number>): ComicRecord =>
  comicFromTags(file, { pages: "24", comicinfo: `<ComicInfo>${Object.entries(fields).map(([k, v]) => `<${k}>${v}</${k}>`).join("")}</ComicInfo>` });

/** A comic's book as the scan makes it: its files' details, named (scan.ts, `buildComic`). */
const shelved = (record: ComicRecord | undefined, stem: string, folder = ""): Book =>
  namedComic({ id: "c1", path: "c.cbz", ...comicFromFiles(record, stem, folder), author: "", narrator: "", seriesIndex: null, cover: "", comic: "c.cbz", durationMs: 0, sizeBytes: 1, fileCount: 0 });

/** What a comic's files say of it, as its book's details (docs/BOOK-DETAILS.md, section 2). */
describe("a comic's details from its files", () => {
  it("takes every detail ComicInfo.xml gives, and names the comic from them", () => {
    const record = recordOf({
      Title: "Chapter Seven",
      Series: "Transformers",
      Number: "7",
      Volume: "2023",
      Writer: "Daniel Warren Johnson",
      Penciller: "Jorge Corona",
      Colorist: "Mike Spicer",
      Letterer: "Rus Wooton",
      Publisher: "Image",
      Imprint: "Skybound",
      Year: "2024",
      Month: "7",
      Day: "10",
      StoryArc: "Robots in Disguise",
      Web: "https://comicvine.gamespot.com/transformers-7/4000-1234567/",
      Summary: "They fight.",
    });
    expect(shelved(record, "anything")).toMatchObject({
      title: "Transformers #7: Chapter Seven",
      rawTitle: "Chapter Seven",
      author: "Daniel Warren Johnson; Jorge Corona",
      series: "Transformers (2023)",
      seriesIndex: 7,
      issue: "7",
      year: 2024,
      coverDate: "2024-07",
      credits: { writers: ["Daniel Warren Johnson"], pencils: ["Jorge Corona"], colours: ["Mike Spicer"], letters: ["Rus Wooton"] },
      publisher: "Image",
      imprint: "Skybound",
      storyArcs: ["Robots in Disguise"],
      comicvine: "4000-1234567",
      description: "They fight.",
    });
  });

  it("keeps a run's first year in the series' name once, and a run's number out of it", () => {
    expect(shelved(recordOf({ Series: "Transformers (2023)", Number: "7", Volume: "2023" }), "x").series).toBe("Transformers (2023)");
    expect(shelved(recordOf({ Series: "Batman", Number: "7", Volume: "2" }), "x").series).toBe("Batman");
  });

  it("reads Number as a collection's volume when Format says it is one", () => {
    const book = shelved(recordOf({ Series: "Saga", Number: "1", Format: "TPB", Title: "Book One" }), "x");
    expect(book).toMatchObject({ title: "Saga Vol. 1: Book One", volume: "1", seriesIndex: 1 });
    expect(book.issue).toBeUndefined();
    expect(shelved(recordOf({ Series: "Saga", Number: "1", Format: "Annual" }), "x")).toMatchObject({ title: "Saga #1", issue: "1" });
  });

  it("keeps an issue number that isn't a number, with no place", () => {
    expect(shelved(recordOf({ Series: "Spider-Man", Number: "1.MU" }), "x")).toMatchObject({ title: "Spider-Man #1.MU", issue: "1.MU", seriesIndex: null });
  });

  it("names a comic by its file where nothing in it says", () => {
    expect(shelved(undefined, "Saga 014 (2013) (Digital)")).toMatchObject({ title: "Saga #14", rawTitle: "", series: "Saga", issue: "14", seriesIndex: 14, year: 2013, coverDate: "2013" });
    // The second run is a series of its own.
    expect(shelved(undefined, "Batman v2 014")).toMatchObject({ title: "Batman v2 #14", series: "Batman v2", issue: "14" });
    // A collection by its name.
    expect(shelved(undefined, "Saga Vol. 2")).toMatchObject({ title: "Saga Vol. 2", series: "Saga", volume: "2", seriesIndex: 2 });
    // Only a number: its folder is its series.
    expect(shelved(undefined, "003", "Second Series (2020)")).toMatchObject({ title: "Second Series #3", series: "Second Series", issue: "3" });
    // Only a title: a comic on its own, its title the file's.
    expect(shelved(undefined, "Batman - Year One (2007)")).toMatchObject({ title: "Batman - Year One", rawTitle: "Batman - Year One", series: "", seriesIndex: null, year: 2007 });
  });

  it("counts only ComicInfo's own number where it names the series", () => {
    expect(shelved(recordOf({ Series: "Saga" }), "Saga 014")).toMatchObject({ title: "Saga 014", series: "Saga", seriesIndex: null });
    expect(shelved(recordOf({ Number: "15" }), "Saga 014")).toMatchObject({ title: "Saga #15", series: "Saga", issue: "15" });
  });
});

describe("comics.csv, as it has been", () => {
  it("keeps what its columns hold and reads it back, a number only where it is one", async () => {
    const record = recordOf({ Title: "Chapter Seven", Series: "Spider-Man", Number: "1.MU", Year: "2024", Writer: "Ada Quill, Ben Nib", Penciller: "Cy Ink", Genre: "Action", LanguageISO: "en", Manga: "YesAndRightToLeft" });
    const back = (await bytesToComics(await comicsToBytes([record]))).get(file.path)!;
    expect(back).toEqual({ ...file, pages: 24, title: "Chapter Seven", series: "Spider-Man", year: 2024, credits: { writers: ["Ada Quill", "Ben Nib"] }, genres: ["Action"], language: "en", rightToLeft: true });
    expect((await bytesToComics(await comicsToBytes([recordOf({ Number: "014" })]))).get(file.path)!.number).toBe("14");
  });
});

describe("library.csv, with a comic's details", () => {
  it("brings a comic back as it was shelved, so its name can be made again from them", async () => {
    const book = shelved(recordOf({ Title: "Robots in Disguise", Series: "Transformers", Number: "1", Format: "TPB", Volume: "2023", Writer: "Daniel Warren Johnson", Penciller: "Jorge Corona", CoverArtist: "Jason Howard", Imprint: "Skybound", Year: "2024", Month: "3", StoryArc: "Origins", Web: "comicvine.gamespot.com/x/4000-1/" }), "x");
    const withCollects: Book = { ...book, collects: "1–6", onSale: "2024-03-13" };
    const [back] = await bytesToBooks(await booksToBytes([withCollects]));
    expect(back).toEqual(withCollects);
  });
});
