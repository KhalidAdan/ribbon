import { describe, expect, it } from "vitest";
import { comicByline, comicLabel, comicName, comicPlace, comicShape, firstIssue, issueNumber, issuesText, namedComic, seriesWithoutRunYear } from "@ribbon/core/comic-name";
import type { Book } from "@ribbon/core/types";

/** A comic as its details have it, before it is named. */
const comic = (details: Partial<Book>): Book => ({
  id: "c1",
  path: "Transformers 007.cbz",
  title: "Transformers 007",
  rawTitle: "",
  author: "",
  narrator: "",
  series: "",
  seriesIndex: null,
  year: null,
  cover: "",
  comic: "Transformers 007.cbz",
  durationMs: 0,
  sizeBytes: 1,
  fileCount: 0,
  ...details,
});

/** How a comic is named on the shelf, from its details (docs/BOOK-DETAILS.md, section 3). */
describe("a comic's name on the shelf", () => {
  it("is an issue's series and number, then its title after a colon", () => {
    expect(comicName({ series: "Transformers", issue: "7", title: "" })).toBe("Transformers #7");
    expect(comicName({ series: "Saga", issue: "14", title: "Chapter Fourteen" })).toBe("Saga #14: Chapter Fourteen");
    expect(comicName({ series: "Spider-Man", issue: "1.MU", title: "" })).toBe("Spider-Man #1.MU");
  });

  it("is a collection's series and volume, then its title", () => {
    expect(comicName({ series: "Transformers", volume: "1", collects: "1–6", title: "Robots in Disguise" })).toBe("Transformers Vol. 1: Robots in Disguise");
    expect(comicName({ series: "Transformers", volume: "1", title: "" })).toBe("Transformers Vol. 1");
  });

  it("is a collection's series, then its title or else the issues it holds, when it has no volume number", () => {
    expect(comicName({ series: "Saga", collects: "1–54", title: "Compendium One" })).toBe("Saga: Compendium One");
    expect(comicName({ series: "Saga", collects: "1–54", title: "" })).toBe("Saga (#1–#54)");
  });

  it("is a comic on its own's title", () => {
    expect(comicName({ series: "", title: "The Sculptor" })).toBe("The Sculptor");
  });

  it("leaves a run's first year out: the series says it", () => {
    expect(comicName({ series: "Transformers (2023)", issue: "7", title: "" })).toBe("Transformers #7");
    expect(comicName({ series: "Transformers (2023)", volume: "1", title: "Robots in Disguise" })).toBe("Transformers Vol. 1: Robots in Disguise");
    expect(seriesWithoutRunYear("Transformers (2023)")).toBe("Transformers");
    expect(seriesWithoutRunYear("Marvel 1602")).toBe("Marvel 1602");
    expect(seriesWithoutRunYear("(2023)")).toBe("(2023)");
  });

  it("gives a number no series to be in only when there is no title", () => {
    expect(comicName({ series: "", issue: "14", title: "Chapter Fourteen" })).toBe("Chapter Fourteen");
    expect(comicName({ series: "", issue: "14", title: "" })).toBe("#14");
    expect(comicName({ series: "", title: "" })).toBe("");
  });

  it("names a comic with a series and nothing else by its series", () => {
    expect(comicName({ series: "Saga", title: "" })).toBe("Saga");
  });
});

describe("what a comic is", () => {
  it("is an issue by its issue number, a collection by its volume or what it collects, and else on its own", () => {
    expect(comicShape({ issue: "7" })).toBe("issue");
    expect(comicShape({ volume: "1" })).toBe("collection");
    expect(comicShape({ collects: "1–6" })).toBe("collection");
    expect(comicShape({})).toBe("alone");
    expect(comicShape({ issue: " ", volume: "" })).toBe("alone");
    // An issue number wins: making it a collection empties it (edit-form.ts).
    expect(comicShape({ issue: "7", volume: "1" })).toBe("issue");
  });
});

describe("a comic's byline", () => {
  it("is its writers and then its art, each name once", () => {
    expect(comicByline({ writers: ["Daniel Warren Johnson"], pencils: ["Jorge Corona"], inks: ["Jorge Corona"], colours: ["Mike Spicer"] })).toBe("Daniel Warren Johnson; Jorge Corona");
    expect(comicByline({ writers: ["Ada Quill"], pencils: ["ada quill", "Ben Nib"] })).toBe("Ada Quill; Ben Nib");
    expect(comicByline({ colours: ["Mike Spicer"] })).toBe("");
    expect(comicByline(undefined)).toBe("");
  });
});

describe("a comic's place in its series", () => {
  it("is its issue number, when that is a number", () => {
    expect(comicPlace({ series: "Transformers", issue: "7", title: "" })).toBe(7);
    expect(comicPlace({ series: "Saga", issue: "½", title: "" })).toBe(0.5);
    expect(comicPlace({ series: "Spider-Man", issue: "1.MU", title: "" })).toBeNull();
  });

  it("is a collection's first issue, else its volume number, so Vol. 1 (#1–#6) comes before #7", () => {
    expect(comicPlace({ series: "Transformers", volume: "1", collects: "1–6", title: "" })).toBe(1);
    expect(comicPlace({ series: "Transformers", volume: "2", collects: "7–12", title: "" })).toBe(7);
    expect(comicPlace({ series: "Saga", volume: "3", title: "" })).toBe(3);
    expect(comicPlace({ series: "Saga", collects: "Annual 1, 13–18", title: "" })).toBe(13);
  });

  it("is none for a comic on its own, or with no series", () => {
    expect(comicPlace({ series: "Saga", title: "Special" })).toBeNull();
    expect(comicPlace({ series: "", issue: "7", title: "" })).toBeNull();
  });

  it("reads numbers as a cover prints them", () => {
    expect(issueNumber("14")).toBe(14);
    expect(issueNumber("#14")).toBe(14);
    expect(issueNumber("0")).toBe(0);
    expect(issueNumber("-1")).toBe(-1);
    expect(issueNumber("14A")).toBeNull();
    expect(firstIssue("#1-#6")).toBe(1);
    expect(firstIssue("Annual 1")).toBeNull();
  });
});

describe("a comic's label in its series", () => {
  it("is #7 for an issue and Vol. 1 for a collection, where an audiobook says Book 2", () => {
    expect(comicLabel({ series: "Transformers (2023)", issue: "7", title: "" })).toBe("#7");
    expect(comicLabel({ series: "Transformers (2023)", volume: "1", collects: "1–6", title: "" })).toBe("Vol. 1");
    expect(comicLabel({ series: "Saga", collects: "1–54", title: "" })).toBe("#1–#54");
    expect(comicLabel({ series: "Saga", title: "Special" })).toBeNull();
    expect(comicLabel({ series: "", issue: "7", title: "" })).toBeNull();
  });

  it("says the issues a collection holds as the shelf does", () => {
    expect(issuesText("1–6, Annual 1")).toBe("#1–#6, Annual 1");
    expect(issuesText("#1-#6")).toBe("#1–#6");
    expect(issuesText("7, 9, 1.MU")).toBe("#7, #9, #1.MU");
  });
});

describe("a comic named", () => {
  const transformers7 = comic({
    series: "Transformers (2023)",
    issue: "7",
    coverDate: "2024-03",
    year: 2023,
    credits: { writers: ["Daniel Warren Johnson"], pencils: ["Jorge Corona"], colours: ["Mike Spicer"] },
  });

  it("takes its name, byline, place and year from its details", () => {
    expect(namedComic(transformers7)).toMatchObject({ title: "Transformers #7", author: "Daniel Warren Johnson; Jorge Corona", seriesIndex: 7, year: 2024 });
  });

  it("keeps the name of its file when it has nothing to be named by", () => {
    expect(namedComic(comic({})).title).toBe("Transformers 007");
  });

  it("keeps a byline, a number or a year a person edited", () => {
    const edited = { ...transformers7, author: "Daniel Warren Johnson; Jorge Corona; Mike Spicer", seriesIndex: 6.5, year: 2023 };
    expect(namedComic(edited, { author: edited.author, seriesIndex: "6.5", year: "2023" })).toMatchObject({ author: edited.author, seriesIndex: 6.5, year: 2023 });
    // An emptied byline is no byline: the credits show.
    expect(namedComic({ ...transformers7, author: "" }, { author: "" }).author).toBe("Daniel Warren Johnson; Jorge Corona");
  });

  it("is the same named twice", () => {
    const once = namedComic(comic({ series: "Saga", issue: "14", rawTitle: "Chapter Fourteen" }));
    expect(once.title).toBe("Saga #14: Chapter Fourteen");
    expect(namedComic(once)).toEqual(once);
  });

  it("leaves a book that isn't a comic as it is", () => {
    const { comic: _comic, ...audiobook } = comic({ series: "Dune", issue: "7", fileCount: 3 });
    expect(namedComic(audiobook)).toBe(audiobook);
  });
});
