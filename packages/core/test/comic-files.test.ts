import { describe, expect, it } from "vitest";
import { namedComic } from "@ribbon/core/comic-name";
import { bytesToRows } from "@ribbon/core/csv";
import { bytesToComics, comicFromFiles, comicFromTags, comicsToBytes, keepsComicDetails, type ComicRecord } from "@ribbon/core/scan/comics";
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

/** A whole ComicInfo.xml, every element Ribbon reads. */
const EVERYTHING = {
  Title: "Chapter Seven",
  Series: "Spider-Man",
  Number: "1.MU",
  Volume: "2023",
  Format: "Annual",
  Writer: "Ada Quill, Ben Nib",
  Penciller: "Cy Ink",
  Inker: "Di Pen",
  Colorist: "Ed Hue",
  Letterer: "Flo Script",
  CoverArtist: "Gus Wash",
  Editor: "Hal Red",
  Translator: "Ida Word",
  Publisher: "Paper Moon",
  Imprint: "Lantern",
  Year: "2024",
  Month: "7",
  Day: "10",
  Summary: "They swing.",
  LanguageISO: "en",
  Genre: "Action",
  StoryArc: "The Long Way, Home Again",
  Web: "https://comicvine.gamespot.com/x/4000-1234567/",
  Manga: "YesAndRightToLeft",
};

/** comics.csv as Ribbon wrote it before comics kept their details (0.51.0 and before), from records in its columns. */
const OLD_COLUMNS = ["path", "size_bytes", "mtime_ms", "pages", "title", "series", "number", "year", "writers", "publisher", "summary", "language", "genres", "right_to_left"];
const oldComicsCsv = (...rows: string[][]) => new TextEncoder().encode([OLD_COLUMNS.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n");

describe("comics.csv", () => {
  it("keeps everything a comic's ComicInfo.xml says, and reads it back as it was", async () => {
    const record = recordOf(EVERYTHING);
    const back = (await bytesToComics(await comicsToBytes([record]))).get(file.path)!;
    expect(back).toEqual(record);
    // So a comic named from its record is the comic named from its file: the scan's name, byline, place and all.
    expect(shelved(back, "anything")).toEqual(shelved(record, "anything"));
    expect(shelved(back, "anything")).toMatchObject({ title: "Spider-Man #1.MU: Chapter Seven", author: "Ada Quill; Ben Nib; Cy Ink", coverDate: "2024-07", storyArcs: ["The Long Way", "Home Again"], comicvine: "4000-1234567" });
  });

  it("keeps an issue as printed, and a number beside it only where it is one, for a Ribbon from before that reads only that", async () => {
    const rows = async (record: ComicRecord) => (await bytesToRows(await comicsToBytes([record]))).rows[0]!;
    expect(await rows(recordOf({ Series: "Spider-Man", Number: "1.MU" }))).toMatchObject({ issue: "1.MU", number: "" });
    expect(await rows(recordOf({ Series: "Saga", Number: "½" }))).toMatchObject({ issue: "½", number: "0.5" });
    expect(await rows(recordOf({ Series: "Saga", Number: "014" }))).toMatchObject({ issue: "14", number: "14" });
    // Its writers stay in the column a Ribbon from before reads them from.
    expect(await rows(recordOf({ Writer: "Ada Quill, Ben Nib" }))).toMatchObject({ writers: "Ada Quill; Ben Nib" });
  });

  it("says whether it keeps a comic's details, from its columns alone", async () => {
    expect(keepsComicDetails(await comicsToBytes([recordOf(EVERYTHING)]))).toBe(true);
    // Written once the last comic went: nothing in it to read again.
    expect(keepsComicDetails(await comicsToBytes([]))).toBe(true);
    expect(keepsComicDetails(oldComicsCsv())).toBe(false);
    expect(keepsComicDetails(new TextEncoder().encode(`${OLD_COLUMNS.join(",")}\r\n`))).toBe(false);
  });

  it("reads one from before as far as its columns go, its number as the issue", async () => {
    const old = await bytesToComics(oldComicsCsv([file.path, "100", "1", "24", "Chapter Seven", "Saga", "14", "2019", "Ada Quill; Ben Nib", "Paper Moon", "", "en", "Fantasy", "1"], ["Loose.cbz", "5", "1", "3", "", "", "", "", "", "", "", "", "", "0"]));
    expect(old.get(file.path)).toEqual({ ...file, pages: 24, title: "Chapter Seven", series: "Saga", number: "14", year: 2019, credits: { writers: ["Ada Quill", "Ben Nib"] }, publisher: "Paper Moon", language: "en", genres: ["Fantasy"], rightToLeft: true });
    expect(old.get("Loose.cbz")).toEqual({ path: "Loose.cbz", sizeBytes: 5, mtimeMs: 1, pages: 3 });
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
