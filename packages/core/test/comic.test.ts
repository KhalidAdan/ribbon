import { describe, expect, it } from "vitest";
import { ARCHIVE_LIMITS, archiveProblem, comicInfoEntry, isPage, pageOrder, pageType } from "@ribbon/core/comic/pages";
import { firstPage, isWide, pagesOf, spreadOf, spreads } from "@ribbon/core/comic/spreads";
import { comicVineIssue, parseComicInfo } from "@ribbon/core/comic/comicinfo";
import { parseComicName } from "@ribbon/core/comic/filename";

/** A ComicInfo.xml from a few fields, as host-node's make-comic.ts writes one. */
function comicInfoXml(fields: Record<string, string | number>): string {
  const lines = Object.entries(fields).map(([k, v]) => `  <${k}>${String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</${k}>`);
  return `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo>\n${lines.join("\n")}\n</ComicInfo>\n`;
}

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

  it("gives what the file says, the number as printed", () => {
    expect(parseComicInfo(xml)).toEqual({
      title: "Chapter Fourteen",
      series: "The Made-Up Saga",
      number: "14",
      volume: "2",
      year: 2013,
      summary: "They ran & ran.\nThen stopped.",
      credits: { writers: ["Ada Quill", "Ben Nib"] },
      publisher: "Paper Moon",
      genres: ["Science Fiction", "Fantasy"],
      language: "en",
    });
  });

  it("reads it in full: every role, the format, the imprint, the cover date, the story arcs and the address", () => {
    const full = comicInfoXml({
      Series: "Transformers",
      Number: "7",
      Volume: "2023",
      Format: "Series",
      Writer: "Daniel Warren Johnson",
      Penciller: "Jorge Corona",
      Inker: "Jorge Corona",
      Colorist: "Mike Spicer",
      Letterer: "Rus Wooton",
      CoverArtist: "Daniel Warren Johnson, Mike Spicer",
      Editor: "Sean Mackiewicz",
      Translator: "Nobody Here",
      Publisher: "Image",
      Imprint: "Skybound",
      Year: 2024,
      Month: 7,
      Day: 10,
      StoryArc: "Robots in Disguise, Batman/Superman",
      Web: "https://comicvine.gamespot.com/transformers-7/4000-1234567/ https://example.com/other",
    });
    expect(parseComicInfo(full)).toEqual({
      series: "Transformers",
      number: "7",
      volume: "2023",
      format: "Series",
      credits: {
        writers: ["Daniel Warren Johnson"],
        pencils: ["Jorge Corona"],
        inks: ["Jorge Corona"],
        colours: ["Mike Spicer"],
        letters: ["Rus Wooton"],
        coverArtists: ["Daniel Warren Johnson", "Mike Spicer"],
        editors: ["Sean Mackiewicz"],
        translators: ["Nobody Here"],
      },
      publisher: "Image",
      imprint: "Skybound",
      year: 2024,
      month: 7,
      day: 10,
      storyArcs: ["Robots in Disguise", "Batman/Superman"],
      web: "https://comicvine.gamespot.com/transformers-7/4000-1234567/ https://example.com/other",
    });
  });

  it("finds a ComicVine issue's address in Web, and only an issue's", () => {
    expect(comicVineIssue("https://comicvine.gamespot.com/transformers-7/4000-1234567/")).toBe("4000-1234567");
    expect(comicVineIssue("http://www.comicvine.gamespot.com/4000-99/")).toBe("4000-99");
    expect(comicVineIssue("https://comicvine.gamespot.com/transformers/4050-123456/")).toBeUndefined();
    expect(comicVineIssue("https://example.com/4000-1234567/")).toBeUndefined();
    expect(comicVineIssue(undefined)).toBeUndefined();
  });

  it("reads right to left from Manga", () => {
    expect(parseComicInfo("<ComicInfo><Manga>YesAndRightToLeft</Manga></ComicInfo>").rightToLeft).toBe(true);
    expect(parseComicInfo("<ComicInfo><Manga>Yes</Manga></ComicInfo>").rightToLeft).toBeUndefined();
  });

  it("keeps a number as printed, whatever it is, without the zeros that pad it", () => {
    expect(parseComicInfo("<ComicInfo><Number>0.5</Number></ComicInfo>").number).toBe("0.5");
    expect(parseComicInfo("<ComicInfo><Number>1.MU</Number></ComicInfo>").number).toBe("1.MU");
    expect(parseComicInfo("<ComicInfo><Number>½</Number></ComicInfo>").number).toBe("½");
    expect(parseComicInfo("<ComicInfo><Number>014</Number></ComicInfo>").number).toBe("14");
    expect(parseComicInfo("<ComicInfo><Number>0</Number></ComicInfo>").number).toBe("0");
  });

  it("leaves out a month or a day that can't be one", () => {
    expect(parseComicInfo("<ComicInfo><Year>2024</Year><Month>13</Month><Day>0</Day></ComicInfo>")).toEqual({ year: 2024 });
    expect(parseComicInfo("<ComicInfo><Year>-1</Year><Month>July</Month></ComicInfo>")).toEqual({});
  });

  it("is empty for a file that says nothing or is not XML", () => {
    expect(parseComicInfo("<ComicInfo></ComicInfo>")).toEqual({});
    expect(parseComicInfo("not xml at all")).toEqual({});
  });
});

describe("a comic's file name", () => {
  it("gives the series, the issue and the year", () => {
    expect(parseComicName("Saga 014 (2013) (Digital) (Group)")).toEqual({ series: "Saga", issue: "14", volume: null, year: 2013, title: "Saga 014" });
  });

  it("reads a number after a hash, and underscores as spaces", () => {
    expect(parseComicName("The_Made_Up_Saga_#7")).toEqual({ series: "The Made Up Saga", issue: "7", volume: null, year: null, title: "The Made Up Saga #7" });
  });

  it("keeps a run before an issue as part of the series: the second run is a series of its own", () => {
    expect(parseComicName("Saga v2 014 (2014)")).toEqual({ series: "Saga v2", issue: "14", volume: null, year: 2014, title: "Saga v2 014" });
    expect(parseComicName("Batman Vol. 02 #7")).toMatchObject({ series: "Batman v2", issue: "7", volume: null });
  });

  it("reads a volume at the end as a collection's, a manga's book among them", () => {
    expect(parseComicName("Saga Vol. 3 (2014)")).toEqual({ series: "Saga", issue: null, volume: "3", year: 2014, title: "Saga Vol. 3" });
    expect(parseComicName("Saga v2")).toMatchObject({ series: "Saga", issue: null, volume: "2" });
    expect(parseComicName("One Piece v03")).toMatchObject({ series: "One Piece", issue: null, volume: "3" });
  });

  it("reads 'of' counts and half issues", () => {
    expect(parseComicName("Small Run 2 of 6")).toMatchObject({ series: "Small Run", issue: "2" });
    expect(parseComicName("Saga 0.5")).toMatchObject({ series: "Saga", issue: "0.5" });
    expect(parseComicName("Saga 000")).toMatchObject({ series: "Saga", issue: "0" });
  });

  it("takes a year in a title for part of the title", () => {
    expect(parseComicName("Spider-Man 2099")).toEqual({ series: "", issue: null, volume: null, year: null, title: "Spider-Man 2099" });
    expect(parseComicName("Spider-Man 2099 001")).toMatchObject({ series: "Spider-Man 2099", issue: "1" });
    expect(parseComicName("Spider-Man #2099")).toMatchObject({ series: "Spider-Man", issue: "2099" });
  });

  it("gives no series for a name that is only a title", () => {
    expect(parseComicName("Batman - Year One (2007)")).toEqual({ series: "", issue: null, volume: null, year: 2007, title: "Batman - Year One" });
  });

  it("gives only a number for a name that is only a number", () => {
    expect(parseComicName("014")).toEqual({ series: "", issue: "14", volume: null, year: null, title: "014" });
  });

  it("keeps a hyphenated series whole", () => {
    expect(parseComicName("Spider-Man - 003")).toMatchObject({ series: "Spider-Man", issue: "3" });
  });
});
