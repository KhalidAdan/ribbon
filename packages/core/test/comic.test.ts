import { describe, expect, it } from "vitest";
import { ARCHIVE_LIMITS, archiveProblem, comicInfoEntry, isPage, pageOrder, pageType } from "@ribbon/core/comic/pages";
import { firstPage, isWide, pagesOf, spreadOf, spreads } from "@ribbon/core/comic/spreads";
import { parseComicInfo } from "@ribbon/core/comic/comicinfo";
import { parseComicName } from "@ribbon/core/comic/filename";

describe("a comic's pages", () => {
  it("are the pictures, in the natural order of their names", () => {
    const entries = ["page-10.jpg", "page-2.jpg", "ComicInfo.xml", "page-1.png", "notes.txt", "art/"];
    expect(pageOrder(entries)).toEqual(["page-1.png", "page-2.jpg", "page-10.jpg"]);
  });

  it("order folders before the pages inside the next one", () => {
    expect(pageOrder(["ch2/001.jpg", "ch1/002.jpg", "ch1/001.jpg", "ch10/001.jpg"])).toEqual(["ch1/001.jpg", "ch1/002.jpg", "ch2/001.jpg", "ch10/001.jpg"]);
  });

  it("leave out what macOS and other tools add to an archive", () => {
    expect(isPage("__MACOSX/._page-1.jpg")).toBe(false);
    expect(isPage(".hidden/page.jpg")).toBe(false);
    expect(isPage("pages/._page-1.jpg")).toBe(false);
    expect(isPage("Pages/Page 1.JPG")).toBe(true);
  });

  it("know a page's media type from its name", () => {
    expect(pageType("a/b.JPEG")).toBe("image/jpeg");
    expect(pageType("b.webp")).toBe("image/webp");
  });

  it("find ComicInfo.xml nearest the top, whatever its case", () => {
    expect(comicInfoEntry(["Saga/comicinfo.xml", "ComicInfo.xml", "1.jpg"])).toBe("ComicInfo.xml");
    expect(comicInfoEntry(["Saga/ComicInfo.xml", "1.jpg"])).toBe("Saga/ComicInfo.xml");
    expect(comicInfoEntry(["__MACOSX/ComicInfo.xml", "1.jpg"])).toBeUndefined();
  });
});

describe("an archive that is not a comic", () => {
  const page = (name: string, size: number, packed?: number) => ({ name, size, ...(packed === undefined ? {} : { packed }) });

  it("is opened when it is a few hundred ordinary pages", () => {
    expect(archiveProblem(Array.from({ length: 300 }, (_, i) => page(`${i}.jpg`, 2_000_000, 1_950_000)))).toBeNull();
  });

  it("is refused with too many files", () => {
    expect(archiveProblem(Array.from({ length: ARCHIVE_LIMITS.entries + 1 }, (_, i) => page(`${i}.jpg`, 10)))).toMatch(/more than a comic has/);
  });

  it("is refused when a page unpacks to far more than a picture would", () => {
    expect(archiveProblem([page("bomb.png", 100 * 1024 * 1024, 100 * 1024)])).toMatch(/far more than a picture/);
  });

  it("is refused when one page is enormous", () => {
    expect(archiveProblem([page("huge.png", ARCHIVE_LIMITS.pageBytes + 1)])).toMatch(/more than a page could be/);
  });

  it("is not judged by files that are not pages", () => {
    expect(archiveProblem([page("readme.txt", 5_000_000, 1_000), page("1.jpg", 1_000)])).toBeNull();
  });
});

describe("spreads", () => {
  it("put the cover alone and pair the pages that face each other", () => {
    expect(spreads([false, false, false, false, false])).toEqual([
      { kind: "solo", page: 0 },
      { kind: "pair", first: 1, second: 2 },
      { kind: "pair", first: 3, second: 4 },
    ]);
  });

  it("leave a wide page alone, and the page stranded before it", () => {
    expect(spreads([false, false, true, false, false])).toEqual([
      { kind: "solo", page: 0 },
      { kind: "solo", page: 1 },
      { kind: "solo", page: 2 },
      { kind: "pair", first: 3, second: 4 },
    ]);
  });

  it("leave the last page alone when no page faces it", () => {
    expect(spreads([false, false, false, false])).toEqual([
      { kind: "solo", page: 0 },
      { kind: "pair", first: 1, second: 2 },
      { kind: "solo", page: 3 },
    ]);
  });

  it("are none for no pages", () => {
    expect(spreads([])).toEqual([]);
  });

  it("find the spread a page is on, and the page a spread is kept as", () => {
    const all = spreads([false, false, false, true]);
    expect(spreadOf(all, 2)).toBe(1);
    expect(spreadOf(all, 3)).toBe(2);
    expect(spreadOf(all, 99)).toBe(0);
    expect(firstPage(all[1]!)).toBe(1);
    expect(pagesOf(all[1]!)).toEqual([1, 2]);
    expect(pagesOf(all[2]!)).toEqual([3]);
  });

  it("call a page wide when it is wider than it is tall", () => {
    expect(isWide(3000, 2000)).toBe(true);
    expect(isWide(2000, 3000)).toBe(false);
    expect(isWide(0, 0)).toBe(false);
  });
});

describe("ComicInfo.xml", () => {
  const xml = `<?xml version="1.0"?>
<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Title>Chapter Fourteen</Title>
  <Series>The Made-Up Saga</Series>
  <Number>14</Number>
  <Volume>2</Volume>
  <Year>2013</Year>
  <Summary>They ran &amp; ran.&lt;br&gt;Then stopped.</Summary>
  <Writer>Ada Quill, Ben Nib</Writer>
  <Publisher>Paper Moon</Publisher>
  <Genre>Science Fiction, Fantasy</Genre>
  <LanguageISO>en</LanguageISO>
  <Manga>No</Manga>
  <Pages><Page Image="0" Type="FrontCover" ImageWidth="1988" ImageHeight="3056" /></Pages>
</ComicInfo>`;

  it("gives the details Ribbon shows", () => {
    expect(parseComicInfo(xml)).toEqual({
      title: "Chapter Fourteen",
      series: "The Made-Up Saga",
      number: 14,
      volume: 2,
      year: 2013,
      summary: "They ran & ran.\nThen stopped.",
      writers: ["Ada Quill", "Ben Nib"],
      publisher: "Paper Moon",
      genres: ["Science Fiction", "Fantasy"],
      language: "en",
    });
  });

  it("reads right to left from Manga", () => {
    expect(parseComicInfo("<ComicInfo><Manga>YesAndRightToLeft</Manga></ComicInfo>").rightToLeft).toBe(true);
    expect(parseComicInfo("<ComicInfo><Manga>Yes</Manga></ComicInfo>").rightToLeft).toBeUndefined();
  });

  it("keeps a number that is a number and leaves out one that is not", () => {
    expect(parseComicInfo("<ComicInfo><Number>0.5</Number></ComicInfo>").number).toBe(0.5);
    expect(parseComicInfo("<ComicInfo><Number>14A</Number></ComicInfo>").number).toBeUndefined();
  });

  it("is empty for a file that says nothing or is not XML", () => {
    expect(parseComicInfo("<ComicInfo></ComicInfo>")).toEqual({});
    expect(parseComicInfo("not xml at all")).toEqual({});
  });
});

describe("a comic's file name", () => {
  it("gives the series, the number and the year", () => {
    expect(parseComicName("Saga 014 (2013) (Digital) (Group)")).toEqual({ series: "Saga", number: 14, year: 2013, title: "Saga 014" });
  });

  it("reads a number after a hash, and underscores as spaces", () => {
    expect(parseComicName("The_Made_Up_Saga_#7")).toEqual({ series: "The Made Up Saga", number: 7, year: null, title: "The Made Up Saga #7" });
  });

  it("reads the issue, not the volume, when a name has both", () => {
    expect(parseComicName("Saga v2 014 (2014)")).toEqual({ series: "Saga", number: 14, year: 2014, title: "Saga v2 014" });
  });

  it("reads a collected volume as its number in the series", () => {
    expect(parseComicName("Saga Vol. 3 (2014)")).toMatchObject({ series: "Saga", number: 3, year: 2014 });
    expect(parseComicName("Saga v2")).toMatchObject({ series: "Saga", number: 2 });
  });

  it("reads 'of' counts and half issues", () => {
    expect(parseComicName("Small Run 2 of 6")).toMatchObject({ series: "Small Run", number: 2 });
    expect(parseComicName("Saga 0.5")).toMatchObject({ series: "Saga", number: 0.5 });
  });

  it("takes a year in a title for part of the title", () => {
    expect(parseComicName("Spider-Man 2099")).toEqual({ series: "", number: null, year: null, title: "Spider-Man 2099" });
    expect(parseComicName("Spider-Man 2099 001")).toMatchObject({ series: "Spider-Man 2099", number: 1 });
    expect(parseComicName("Spider-Man #2099")).toMatchObject({ series: "Spider-Man", number: 2099 });
  });

  it("gives no series for a name that is only a title", () => {
    expect(parseComicName("Batman - Year One (2007)")).toEqual({ series: "", number: null, year: 2007, title: "Batman - Year One" });
  });

  it("gives only a number for a name that is only a number", () => {
    expect(parseComicName("014")).toEqual({ series: "", number: 14, year: null, title: "014" });
  });

  it("keeps a hyphenated series whole", () => {
    expect(parseComicName("Spider-Man - 003")).toMatchObject({ series: "Spider-Man", number: 3 });
  });
});
