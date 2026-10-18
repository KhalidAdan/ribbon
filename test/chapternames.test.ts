import { describe, expect, it } from "vitest";
import { catalogUrl, generatedTitles, parseCatalog, pickProduct, planNames, searchTitle } from "../src/core/chapternames";
import { parseChapters } from "../src/core/audnexus";
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
