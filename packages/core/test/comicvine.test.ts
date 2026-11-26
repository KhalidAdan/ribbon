import { describe, expect, it } from "vitest";
import { namedComic } from "@ribbon/core/comic-name";
import {
  comicVineAddress,
  creditsFrom,
  issueByNumber,
  issuePage,
  issueRequest,
  issuesRequest,
  lookUpComic,
  matchedValues,
  numberToLookUp,
  outcomeOf,
  rolesOf,
  runOf,
  runPicture,
  runRequest,
  runSearchOf,
  runSeries,
  runsInOrder,
  runsRequest,
  sameIssueNumber,
  withMatch,
  type CvIssue,
  type CvRequest,
  type CvVolume,
} from "@ribbon/core/comicvine";
import { applyEdits, type EditValues } from "@ribbon/core/edits";
import { summaryText } from "@ribbon/core/summary-text";
import type { Book } from "@ribbon/core/types";

/**
 * Looking a comic up on ComicVine (docs/BOOK-DETAILS.md, section 7): the
 * rules a server and the desktop share. The answers are made up, written
 * by hand in the shape ComicVine's API documentation gives; its words for
 * what a person did are a reading, not checked against real answers yet.
 */

/** A made-up run: Made Up Saga, from 2018. */
const RUN: CvVolume = {
  id: 9001,
  name: "Made Up Saga",
  start_year: "2018",
  count_of_issues: 12,
  publisher: { id: 31, name: "Made Up Press" },
  image: { thumb_url: "https://comicvine.gamespot.com/a/uploads/scale_avatar/1/1/9001-made-up-saga.jpg", small_url: "https://comicvine.gamespot.com/a/uploads/scale_small/1/1/9001-made-up-saga.jpg" },
  site_detail_url: "https://comicvine.gamespot.com/made-up-saga/4050-9001/",
};

/** A made-up issue of it, #2, with people, an arc and a description in HTML. */
const ISSUE: CvIssue = {
  id: 123456,
  name: "The Long Way",
  issue_number: "2",
  cover_date: "2018-07-01",
  store_date: "2018-07-04",
  volume: { id: 9001, name: "Made Up Saga" },
  person_credits: [
    { id: 1, name: "Ada Quill", role: "writer" },
    { id: 2, name: "Ben Nib", role: "penciler, inker, cover" },
    { id: 3, name: "Cy Hue", role: "colorist" },
    { id: 4, name: "Di Pen", role: "letterer" },
    { id: 5, name: "Ed Itor", role: "editor" },
    { id: 6, name: "Odd Job", role: "other" },
  ],
  story_arc_credits: [{ id: 70, name: "The Long Way Round" }],
  site_detail_url: "https://comicvine.gamespot.com/made-up-saga-2-the-long-way/4000-123456/",
  deck: "Ada and Ben's second.",
  description: "<p>The road goes <em>on</em> &amp; on.</p><h4>Notes</h4><p>Printed twice.</p>",
};

/** A comic as its files have it, before anything is laid over it. */
const comic = (details: Partial<Book>): Book => ({
  id: "c1",
  path: "Made Up Saga/anything.cbz",
  title: "anything",
  rawTitle: "",
  author: "",
  narrator: "",
  series: "",
  seriesIndex: null,
  year: null,
  cover: "",
  comic: "Made Up Saga/anything.cbz",
  durationMs: 0,
  sizeBytes: 1,
  fileCount: 0,
  ...details,
});

describe("an address on ComicVine", () => {
  it("is an issue's or a run's page, or its id alone", () => {
    expect(comicVineAddress("https://comicvine.gamespot.com/made-up-saga-2-the-long-way/4000-123456/")).toEqual({ kind: "issue", id: 123456 });
    expect(comicVineAddress("comicvine.gamespot.com/made-up-saga/4050-9001/")).toEqual({ kind: "run", id: 9001 });
    expect(comicVineAddress("http://comicvine.gamespot.com/made-up-saga/4050-9001")).toEqual({ kind: "run", id: 9001 });
    expect(comicVineAddress("https://www.comicvine.com/made-up-saga/4050-9001/issues/")).toEqual({ kind: "run", id: 9001 });
    expect(comicVineAddress(" 4000-123456 ")).toEqual({ kind: "issue", id: 123456 });
    expect(comicVineAddress("4050-9001")).toEqual({ kind: "run", id: 9001 });
  });

  it("is never a page somewhere else, or another kind of thing on ComicVine", () => {
    expect(comicVineAddress("https://example.com/made-up-saga/4000-123456/")).toBeNull();
    expect(comicVineAddress("https://comicvine.gamespot.com/ada-quill/4040-1/")).toBeNull();
    expect(comicVineAddress("123456")).toBeNull();
    expect(comicVineAddress("")).toBeNull();
  });

  it("links back to an issue's page as its answer gives it, else to one made from its id", () => {
    expect(issuePage(ISSUE)).toBe("https://comicvine.gamespot.com/made-up-saga-2-the-long-way/4000-123456/");
    expect(issuePage({ id: 7, site_detail_url: "https://example.com/elsewhere/" })).toBe("https://comicvine.gamespot.com/issue/4000-7/");
    expect(issuePage({ id: 7 })).toBe("https://comicvine.gamespot.com/issue/4000-7/");
  });
});

describe("what an answer means", () => {
  it("reads ComicVine's status codes: 1 answered, 100 the key refused, 101 not found, 107 too many", () => {
    expect(outcomeOf(200, { status_code: 1, error: "OK", results: {} })).toBe("answered");
    expect(outcomeOf(401, { status_code: 100, error: "Invalid API Key", results: [] })).toBe("refused");
    expect(outcomeOf(200, { status_code: 100, error: "Invalid API Key", results: [] })).toBe("refused");
    expect(outcomeOf(404, { status_code: 101, error: "Object Not Found", results: [] })).toBe("not found");
    expect(outcomeOf(200, { status_code: 101, error: "Object Not Found", results: [] })).toBe("not found");
    expect(outcomeOf(200, { status_code: 107, error: "Rate limit exceeded.  Slow down cowboy.", results: [] })).toBe("too many");
  });

  it("reads too many from the HTTP status too, and anything else as ComicVine out of reach", () => {
    expect(outcomeOf(420, null)).toBe("too many");
    expect(outcomeOf(429, "Too Many Requests")).toBe("too many");
    expect(outcomeOf(404, null)).toBe("not found");
    expect(outcomeOf(502, null)).toBe("failed");
    expect(outcomeOf(0, null)).toBe("failed");
    expect(outcomeOf(200, { status_code: 104, error: "Filter Error", results: [] })).toBe("failed");
    expect(outcomeOf(200, "<html>a page, not an answer</html>")).toBe("failed");
  });
});

describe("what is asked", () => {
  it("asks for an issue whole, with its people and its arcs, and a run for its name, year and publisher", () => {
    expect(issueRequest(123456)).toMatchObject({ resource: "issue", path: "issue/4000-123456/" });
    expect(issueRequest(123456).params.field_list!.split(",")).toEqual(expect.arrayContaining(["person_credits", "story_arc_credits", "cover_date", "store_date", "volume", "description", "deck"]));
    expect(runRequest(9001)).toMatchObject({ resource: "volume", path: "volume/4050-9001/" });
    expect(runRequest(9001).params.field_list!.split(",")).toEqual(expect.arrayContaining(["start_year", "publisher", "count_of_issues", "image"]));
  });

  it("searches runs by a series' name, its run's year taken out and given as the year", () => {
    expect(runSearchOf("Steel Giants (2023)")).toEqual({ name: "Steel Giants", year: 2023 });
    expect(runSearchOf("Made Up Saga")).toEqual({ name: "Made Up Saga", year: null });
    expect(runsRequest(runSearchOf("Steel Giants (2023)"))).toMatchObject({ resource: "volumes", path: "volumes/", params: { filter: "name:Steel Giants,start_year:2023" } });
    // A filter's parts are apart by commas, and its name from its value by a colon: neither can be in the name.
    expect(runsRequest({ name: "Giants: Steel, Rust", year: null }).params.filter).toBe("name:Giants Steel Rust");
    // A search asks the same fields as a run alone, so its answer answers for each run.
    expect(runsRequest({ name: "x", year: null }).params.field_list).toBe(runRequest(1).params.field_list);
  });

  it("asks for a run's issue by the number as ComicVine prints it", () => {
    expect(issuesRequest(9001, "002").params.filter).toBe("volume:9001,issue_number:2");
    expect(issuesRequest(9001, "#7").params.filter).toBe("volume:9001,issue_number:7");
    expect(issuesRequest(9001, "1.MU").params.filter).toBe("volume:9001,issue_number:1.MU");
  });
});

describe("the runs offered", () => {
  it("are each its id, name, first year, publisher, how many issues, its page and a small picture", () => {
    expect(runOf(RUN)).toEqual({ id: "4050-9001", name: "Made Up Saga", startYear: 2018, publisher: "Made Up Press", issues: 12, address: "https://comicvine.gamespot.com/made-up-saga/4050-9001/" });
    expect(runPicture(RUN)).toBe(RUN.image!.thumb_url);
    expect(runOf({ id: 5, name: " Nameless " })).toEqual({ id: "4050-5", name: "Nameless", startYear: null, publisher: "", issues: null, address: "https://comicvine.gamespot.com/volume/4050-5/" });
    expect(runPicture({ id: 5, name: "Nameless", image: null })).toBeNull();
  });

  it("come the ones named just as asked first, then the year asked, then the longest, and nothing is chosen", () => {
    const runs: CvVolume[] = [
      { id: 1, name: "Made Up Saga Tales", start_year: "2018", count_of_issues: 40 },
      { id: 2, name: "Made Up Saga", start_year: "2021", count_of_issues: 3 },
      { id: 3, name: "made up saga", start_year: "2018", count_of_issues: 12 },
      { id: 4, name: "Made Up Saga", start_year: "2021", count_of_issues: 30 },
    ];
    expect(runsInOrder(runs, { name: "Made Up Saga", year: 2018 }).map((r) => r.id)).toEqual([3, 4, 2, 1]);
    expect(runsInOrder(runs, { name: "Made Up Saga", year: null }).map((r) => r.id)).toEqual([4, 3, 2, 1]);
  });

  it("names a comic's series as the run with its first year in brackets", () => {
    expect(runSeries(RUN)).toBe("Made Up Saga (2018)");
    expect(runSeries({ name: "Steel Giants (2023)", start_year: "2023" })).toBe("Steel Giants (2023)");
    expect(runSeries({ name: "Old Tales", start_year: null })).toBe("Old Tales");
  });
});

describe("which issue it is", () => {
  it("is the run's issue with the comic's number, however the number is written", () => {
    expect(sameIssueNumber("002", "2")).toBe(true);
    expect(sameIssueNumber("#7", "7")).toBe(true);
    expect(sameIssueNumber("½", "0.5")).toBe(true);
    expect(sameIssueNumber("1.MU", "1.mu")).toBe(true);
    expect(sameIssueNumber("1.MU", "1")).toBe(false);
    expect(sameIssueNumber("", "")).toBe(false);
    const issues: CvIssue[] = [
      { id: 1, issue_number: "1" },
      { id: 2, issue_number: "2" },
      { id: 22, issue_number: "2.1" },
    ];
    expect(issueByNumber(issues, "02")?.id).toBe(2);
    expect(issueByNumber(issues, "3")).toBeNull();
  });

  it("is looked for by an issue's issue number, or a collection's volume", () => {
    expect(numberToLookUp({ issue: "7" }, "issue")).toBe("7");
    expect(numberToLookUp({ issue: "7", volume: "1" }, "collection")).toBe("1");
    expect(numberToLookUp({}, "issue")).toBe("");
  });

  /** ComicVine as a table of made-up answers, noting each request. */
  const stand = (answers: Record<string, unknown>) => {
    const asked: string[] = [];
    const ask = async <T>(request: CvRequest): Promise<T | null> => {
      const key = request.params.filter ? `${request.path}?${request.params.filter}` : request.path;
      asked.push(key);
      return (answers[key] as T | undefined) ?? null;
    };
    return { ask, asked };
  };

  it("by an issue's address: the issue, then its run", async () => {
    const cv = stand({ "issue/4000-123456/": ISSUE, "volume/4050-9001/": RUN });
    const found = await lookUpComic(cv.ask, { address: { kind: "issue", id: 123456 }, as: "issue" });
    expect(cv.asked).toEqual(["issue/4000-123456/", "volume/4050-9001/"]);
    expect(found).toMatchObject({ address: ISSUE.site_detail_url, as: "issue", issue: ISSUE, run: RUN });
    expect(found?.values).toMatchObject({ series: "Made Up Saga (2018)", issue: "2", publisher: "Made Up Press" });
  });

  it("by a run's address: the run, its issue with that number, then the issue whole", async () => {
    const cv = stand({ "volume/4050-9001/": RUN, "issues/?volume:9001,issue_number:2": [{ id: 123456, issue_number: "2" }], "issue/4000-123456/": ISSUE });
    const found = await lookUpComic(cv.ask, { address: { kind: "run", id: 9001 }, number: "002", as: "issue" });
    expect(cv.asked).toEqual(["volume/4050-9001/", "issues/?volume:9001,issue_number:2", "issue/4000-123456/"]);
    expect(found?.values.title).toBe("The Long Way");
  });

  it("finds nothing for an issue or a run ComicVine hasn't, an issue the run hasn't, or a run's address without a number", async () => {
    const cv = stand({ "volume/4050-9001/": RUN, "issues/?volume:9001,issue_number:99": [] });
    expect(await lookUpComic(cv.ask, { address: { kind: "issue", id: 404 }, as: "issue" })).toBeNull();
    expect(await lookUpComic(cv.ask, { address: { kind: "run", id: 404 }, number: "1", as: "issue" })).toBeNull();
    expect(await lookUpComic(cv.ask, { address: { kind: "run", id: 9001 }, number: "99", as: "issue" })).toBeNull();
    expect(await lookUpComic(cv.ask, { address: { kind: "run", id: 9001 }, as: "issue" })).toBeNull();
    expect(cv.asked).toEqual(["issue/4000-404/", "volume/4050-404/", "volume/4050-9001/", "issues/?volume:9001,issue_number:99"]);
  });
});

describe("what is filled", () => {
  it("reads ComicVine's words for what people did as Ribbon's roles: an artist alone drew and inked, and words it doesn't know are left out", () => {
    expect(rolesOf("writer")).toEqual(["writers"]);
    expect(rolesOf("penciler, inker, cover")).toEqual(["pencils", "inks", "coverArtists"]);
    expect(rolesOf("Artist")).toEqual(["pencils", "inks"]);
    expect(rolesOf("artist, penciler")).toEqual(["pencils", "inks"]);
    expect(rolesOf("colorist, letterer, editor")).toEqual(["colours", "letters", "editors"]);
    expect(rolesOf("other")).toEqual([]);
    expect(rolesOf("")).toEqual([]);
  });

  it("puts each person in each role they had, once, in ComicVine's order", () => {
    expect(
      creditsFrom([
        { id: 1, name: "Ada Quill", role: "writer, cover" },
        { id: 2, name: "Ben Nib", role: "artist" },
        { id: 3, name: "ben nib", role: "penciler" },
        { id: 4, name: "Cy Hue", role: "inker" },
        { id: 5, name: " ", role: "writer" },
      ]),
    ).toEqual({ writers: ["Ada Quill"], coverArtists: ["Ada Quill"], pencils: ["Ben Nib"], inks: ["Ben Nib", "Cy Hue"] });
  });

  it("fills an issue's series, number, title, people, dates, arcs, publisher and description, from the issue and its run", () => {
    expect(matchedValues(ISSUE, RUN, "issue")).toEqual({
      series: "Made Up Saga (2018)",
      issue: "2",
      volume: "",
      collects: "",
      title: "The Long Way",
      writers: "Ada Quill",
      pencils: "Ben Nib",
      inks: "Ben Nib",
      coverArtists: "Ben Nib",
      colours: "Cy Hue",
      letters: "Di Pen",
      editors: "Ed Itor",
      coverDate: "2018-07",
      onSale: "2018-07-04",
      storyArcs: "The Long Way Round",
      publisher: "Made Up Press",
      description: "The road goes on & on.\n\nNotes\n\nPrinted twice.",
    });
  });

  it("reads a collection's number on ComicVine as its volume, and a comic on its own's as neither", () => {
    const tpb: CvIssue = { id: 8, issue_number: "1", name: "Robots in Disguise", volume: { id: 7002, name: "Steel Giants" } };
    expect(matchedValues(tpb, null, "collection")).toEqual({ series: "Steel Giants", issue: "", volume: "1", title: "Robots in Disguise" });
    expect(matchedValues(tpb, null, "alone")).toEqual({ series: "Steel Giants", title: "Robots in Disguise" });
  });

  it("never fills imprint, language, genres, reading direction, what a collection collects or the cover, nor the run's own description", () => {
    const run = { ...RUN, description: "<p>About the whole run.</p>" } as CvVolume;
    const said = matchedValues({ id: 1, issue_number: "1" }, run, "issue");
    for (const never of ["imprint", "language", "genres", "rightToLeft", "cover", "description", "title"]) expect(said).not.toHaveProperty(never);
    expect(said.collects).toBe("");
  });

  it("takes the deck when the issue has no description, and says nothing of what ComicVine is silent on", () => {
    expect(matchedValues({ id: 1, deck: " A line about it. ", description: "" }, null, "issue")).toEqual({ description: "A line about it." });
    expect(matchedValues({ id: 1, name: "", cover_date: "0000-00-00", store_date: "soon", story_arc_credits: [], person_credits: [] }, null, "issue")).toEqual({});
  });

  it("makes ComicVine's HTML plain paragraphs, as Audible's summaries are: headings and items on lines of their own", () => {
    expect(summaryText("<h2>Plot</h2><p>One.</p><ul><li>Two</li><li>Three</li></ul>")).toBe("Plot\n\nOne.\n\nTwo\nThree");
    expect(summaryText("<p>The Emperor&#39;s &amp; the Lion&rsquo;s</p>")).toBe("The Emperor's & the Lion’s");
  });
});

describe("what ComicVine said, between the files and a person's edits", () => {
  const files = comic({ series: "Made Up Saga", issue: "2", rawTitle: "", credits: { writers: ["Ada Quill"] }, coverDate: "2018", comicvine: "4000-123456" });
  const match = { values: matchedValues(ISSUE, RUN, "issue"), address: issuePage(ISSUE) };
  const shown = (edits: EditValues, layer: typeof match | null = match) => namedComic(applyEdits(withMatch(files, layer), edits), edits);

  it("shows what ComicVine said where the files said less, and names the comic from it", () => {
    expect(shown({})).toMatchObject({ title: "Made Up Saga #2: The Long Way", author: "Ada Quill; Ben Nib", series: "Made Up Saga (2018)", seriesIndex: 2, year: 2018, coverDate: "2018-07", publisher: "Made Up Press", comicvine: "4000-123456" });
  });

  it("is beaten by a person's edit, and taking the edit back goes to ComicVine's, not the files'", () => {
    expect(shown({ title: "My Own Name", publisher: "" })).toMatchObject({ title: "Made Up Saga #2: My Own Name", publisher: "" });
    expect(shown({})).toMatchObject({ rawTitle: "The Long Way", publisher: "Made Up Press" });
  });

  it("forgotten, leaves the comic what its files and its edits say", () => {
    expect(shown({}, null)).toMatchObject({ title: "Made Up Saga #2", author: "Ada Quill", series: "Made Up Saga", coverDate: "2018" });
    expect(shown({}, null).publisher).toBeUndefined();
    expect(withMatch(files, null)).toBe(files);
  });

  it("makes a comic matched as a collection one, even where its file numbered it as an issue", () => {
    const tpb = { values: matchedValues({ id: 8, issue_number: "1", name: "Robots in Disguise", volume: { id: 7002, name: "Steel Giants" } }, null, "collection"), address: "https://comicvine.gamespot.com/x/4000-8/" };
    expect(shown({}, tpb)).toMatchObject({ title: "Steel Giants Vol. 1: Robots in Disguise", comicvine: "4000-8" });
    expect(shown({}, tpb).issue).toBeUndefined();
  });
});
