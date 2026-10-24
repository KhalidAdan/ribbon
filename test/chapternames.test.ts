import { describe, expect, it } from "vitest";
import { catalogUrl, generatedTitles, numbersChapter, parseCatalog, pickProduct, planNames, searchTitle } from "../src/core/chapternames";
import { parseChapters } from "../src/core/audnexus";
import { EBOOK_FORMAT, type Ebook, type EbookSection } from "../src/core/ebook";
import { BookText } from "../src/core/reading/booktext";
import { chapterNamesFromText, type Narration } from "../src/core/reading/narration";
import { applyCorrections } from "../src/core/scan/chapters";
import type { Chapter } from "../src/core/types";

const t = (titles: string[]) => titles.map((title) => ({ title }));

describe("generated chapter titles", () => {
  it("are numbers in order, however they are spelled", () => {
    expect(generatedTitles(t(["Chapter 1", "Chapter 2", "Chapter 3"]))).toBe(true);
    expect(generatedTitles(t(["Track 01", "Track 02"]))).toBe(true);
    expect(generatedTitles(t(["01", "02", "03"]))).toBe(true);
    expect(generatedTitles(t(["Chapter 0", "Chapter 1"]))).toBe(true);
    expect(generatedTitles(t(["Kapitel 1", "Kapitel 2"]))).toBe(true);
  });

  it("are not real names, a list out of order, or a single chapter", () => {
    expect(generatedTitles(t(["Opening Credits", "Epigraph", "Chapter 1"]))).toBe(false);
    expect(generatedTitles(t(["Chapter 1", "Chapter 3"]))).toBe(false);
    expect(generatedTitles(t(["Chapter 2", "Chapter 3"]))).toBe(false);
    expect(generatedTitles(t(["Chapter 1"]))).toBe(false);
    expect(generatedTitles(t(["Chapter 1: The Wolf", "Chapter 2: The Sea"]))).toBe(false);
  });
});

const VOIDSCARRED_MS = 36_688_117;
const CATALOG = {
  products: [
    { asin: "B0FPQWRGDP", title: "Voidscarred", authors: [{ name: "Mike Brooks" }], narrators: [{ name: "Nathaniel Priestley" }], runtime_length_min: 611 },
    { asin: "B0DIFFEREN", title: "Voidscarred (Abridged)", authors: [{ name: "Mike Brooks" }], narrators: [{ name: "Someone" }], runtime_length_min: 300 },
    { asin: "bad", title: "x", runtime_length_min: 1 },
  ],
};

describe("finding the book in the catalog", () => {
  it("asks the right place, and searches by the title without its series noise", () => {
    expect(catalogUrl("Voidscarred", "Mike Brooks")).toBe("https://api.audible.com/1.0/catalog/products?title=Voidscarred&author=Mike+Brooks&num_results=10&products_sort_by=Relevance&response_groups=product_attrs%2Ccontributors");
    expect(catalogUrl("x", "y", "uk")).toMatch(/^https:\/\/api\.audible\.co\.uk\//);
    expect(searchTitle("Voidscarred: Warhammer 40,000")).toBe("Voidscarred");
    expect(searchTitle("01. Horus Rising")).toBe("Horus Rising");
    expect(searchTitle("The Martian")).toBe("The Martian");
  });

  it("takes only the product with this book's length and title", () => {
    const products = parseCatalog(CATALOG);
    expect(products.map((p) => p.asin)).toEqual(["B0FPQWRGDP", "B0DIFFEREN"]);
    expect(pickProduct(products, { title: "Voidscarred: Warhammer 40,000", narrator: "", durationMs: VOIDSCARRED_MS })?.asin).toBe("B0FPQWRGDP");
    // Two hours off is another recording.
    expect(pickProduct(products, { title: "Voidscarred", narrator: "", durationMs: VOIDSCARRED_MS + 7_200_000 })).toBeNull();
    // The right length but another title is another book.
    expect(pickProduct(products, { title: "Ghazghkull Thraka", narrator: "", durationMs: VOIDSCARRED_MS })).toBeNull();
  });
});

describe("planning the names", () => {
  // Voidscarred as Audnexus has it, in shape: 37 chapters over 611 minutes.
  const names = ["Opening Credits", "Epigraph", ...Array.from({ length: 33 }, (_, i) => `Chapter ${i + 1}`), "Epilogue", "End Credits"];
  const step = Math.floor(VOIDSCARRED_MS / names.length);
  const lookup = parseChapters({ asin: "B0FPQWRGDP", runtimeLengthMs: 611 * 60_000, chapters: names.map((title, i) => ({ title, startOffsetMs: i * step, lengthMs: i === names.length - 1 ? VOIDSCARRED_MS - i * step : step })) })!;
  const file: Chapter[] = names.map((_, i) => ({ title: `Chapter ${i + 1}`, startMs: i * step + 400, endMs: i === names.length - 1 ? VOIDSCARRED_MS : (i + 1) * step + 400 }));

  it("puts the real names on the same markers, times untouched", () => {
    const plan = planNames(lookup, file, VOIDSCARRED_MS);
    expect(plan.apply).toBe(true);
    if (!plan.apply) return;
    const out = applyCorrections(file, plan.corrections, VOIDSCARRED_MS).chapters;
    expect(out.map((c) => c.title).slice(0, 4)).toEqual(["Opening Credits", "Epigraph", "Chapter 1", "Chapter 2"]);
    expect(out.map((c) => c.startMs)).toEqual(file.map((c) => c.startMs));
    // Chapter 3 to Chapter 1 is a rename; markers already named right are left alone.
    expect(plan.corrections.every((c) => c.op === "rename")).toBe(true);
  });

  it("does nothing when the counts differ, the length differs, or a start is elsewhere", () => {
    expect(planNames(lookup, file.slice(0, 36), VOIDSCARRED_MS)).toMatchObject({ apply: false });
    expect(planNames(lookup, file, VOIDSCARRED_MS + 3_600_000)).toMatchObject({ apply: false, reason: "the lengths differ" });
    const moved = file.map((c, i) => (i === 10 ? { ...c, startMs: c.startMs + 5 * 60_000 } : c));
    expect(planNames(lookup, moved, VOIDSCARRED_MS)).toMatchObject({ apply: false, reason: "chapter 11 starts at a different time" });
  });
});

const MIN = 60_000;
/** Characters per millisecond: about 160 words a minute. */
const PACE = 0.016;
const NOTHING_HEARD: Narration = { fixes: [], heard: new Map(), anchors: [], overlay: null };

/**
 * A book's text and its recording, the way rippers number its chapters.
 * Each contents entry is read in so many minutes and may open with words of
 * its own; an entry of no length shares its place with the next, as a
 * part's heading does with its first chapter. The audio chapters are
 * "Chapter 1" on, with these lengths in minutes.
 */
function book(entries: { label: string; minutes: number; opening?: string }[], audio: number[]): { text: BookText; chapters: Chapter[]; durationMs: number } {
  const sections: EbookSection[] = [];
  const toc: Ebook["toc"] = [];
  for (const e of entries) {
    // An entry of no length points where the next one's section will be.
    toc.push({ label: e.label, section: sections.length, block: 0, depth: 1 });
    if (e.minutes === 0) continue;
    const chars = Math.max(1, Math.round(e.minutes * MIN * PACE));
    const t = `${e.opening ? `${e.opening} ` : ""}${"aaaa ".repeat(Math.ceil(chars / 5))}`.slice(0, Math.max(chars, e.opening?.length ?? 0));
    sections.push({ href: `s${sections.length}.xhtml`, linear: true, overlay: null, chars: t.length, blocks: [{ k: "p", runs: [{ t }] }] });
  }
  const ebook: Ebook = { format: EBOOK_FORMAT, meta: { title: "A Book", authors: [], identifiers: [] }, layout: "reflowable", sections, toc };
  const chapters: Chapter[] = [];
  let at = 0;
  audio.forEach((minutes, i) => {
    chapters.push({ title: `Chapter ${i + 1}`, startMs: at, endMs: at + Math.round(minutes * MIN) });
    at += Math.round(minutes * MIN);
  });
  return { text: new BookText(ebook), chapters, durationMs: at };
}

const TEN = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const LENGTHS = [22, 48, 45, 33, 30, 39, 49, 26, 40, 45];
const THE_WARP = "The warp howled around the Warmaster's fleet as its ships fell towards Terra";

/** The Solar War's shape: front matter, a prologue, ten numbered chapters, back matter; the recording opens and closes with credits. */
function solarWar() {
  return book(
    [
      { label: "Backlist", minutes: 3.6 },
      { label: "The Horus Heresy: Siege of Terra", minutes: 2 },
      { label: "Dramatis Personae", minutes: 3.2 },
      { label: "The Warp", minutes: 6.3, opening: THE_WARP },
      ...TEN.map((label, i) => ({ label, minutes: LENGTHS[i]! })),
      { label: "Afterword", minutes: 19 },
      { label: "About the Author", minutes: 0.6 },
      { label: "A Black Library Publication", minutes: 1.6 },
      { label: "eBook license", minutes: 4.6 },
    ],
    [3.5, 7.5, ...LENGTHS, 5.6],
  );
}

describe("whether a contents entry numbers a chapter", () => {
  it("does in words, digits and Roman numerals, alone or before a title", () => {
    for (const label of ["Three", "Chapter 3", "XII", "Twenty-one", "Twenty-one: The Long Walk", "1. Arrival", "Chapter 4 - The Fall", "9:ii", "iii"]) expect(numbersChapter(label), label).toBe(true);
  });

  it("doesn't when it's a part, or a title that starts like a number", () => {
    for (const label of ["Part Two", "PART NINE", "Book III", "Epilogue", "The Warp", "I Am the Storm", "One Last Job", "Dramatis Personae"]) expect(numbersChapter(label), label).toBe(false);
  });
});

describe("chapter names from the book's own text", () => {
  it("names the run of numbered chapters, and leaves the credits and the front and back matter alone", () => {
    const b = solarWar();
    const names = chapterNamesFromText(b.text, b.chapters, b.durationMs, NOTHING_HEARD);
    expect(names).toEqual(TEN.map((title, i) => ({ index: i + 2, title })));
  });

  it("names a chapter outside that run when the narrator was heard reading it", () => {
    const b = solarWar();
    const heard = new Map([[b.chapters[1]!.startMs, THE_WARP]]);
    const names = chapterNamesFromText(b.text, b.chapters, b.durationMs, { ...NOTHING_HEARD, heard });
    expect(names[0]).toEqual({ index: 1, title: "The Warp" });
    expect(names.map((n) => n.index)).not.toContain(0);
    expect(names.map((n) => n.index)).not.toContain(12);
  });

  it("gives a name a book numbers again in each part the part it's in", () => {
    const b = book(
      [
        { label: "Part One", minutes: 0 },
        { label: "One", minutes: 30 },
        { label: "Two", minutes: 40 },
        { label: "Three", minutes: 35 },
        { label: "Part Two", minutes: 0 },
        { label: "One", minutes: 45 },
        { label: "Two", minutes: 30 },
        { label: "Three", minutes: 50 },
      ],
      [30, 40, 35, 45, 30, 50],
    );
    expect(chapterNamesFromText(b.text, b.chapters, b.durationMs, NOTHING_HEARD).map((n) => n.title)).toEqual(["One (Part One)", "Two (Part One)", "Three (Part One)", "One (Part Two)", "Two (Part Two)", "Three (Part Two)"]);
  });

  it("names a moment the recording gives a part's heading, between two named chapters", () => {
    const b = book(
      [
        { label: "i", minutes: 20 },
        { label: "ii", minutes: 14 },
        { label: "iii", minutes: 19 },
        { label: "PART FIVE", minutes: 0.03 },
        { label: "5:i", minutes: 10 },
        { label: "5:ii", minutes: 10 },
        { label: "5:iii", minutes: 4 },
      ],
      [20, 14, 19, 0.1, 10, 10, 4],
    );
    expect(chapterNamesFromText(b.text, b.chapters, b.durationMs, NOTHING_HEARD).map((n) => n.title)).toEqual(["i", "ii", "iii", "PART FIVE", "5:i", "5:ii", "5:iii"]);
  });

  it("leaves chapters that have names, and a book with no numbered chapters, as they are", () => {
    const b = solarWar();
    const named = b.chapters.map((c, i) => ({ ...c, title: i === 0 ? "Opening Credits" : c.title }));
    expect(chapterNamesFromText(b.text, named, b.durationMs, NOTHING_HEARD)).toEqual([]);
    const titled = book(
      [
        { label: "The Boy Who Lived", minutes: 30 },
        { label: "The Vanishing Glass", minutes: 25 },
      ],
      [30, 25],
    );
    expect(chapterNamesFromText(titled.text, titled.chapters, titled.durationMs, NOTHING_HEARD)).toEqual([]);
  });
});
