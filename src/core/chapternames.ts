import type { Chapter } from "./types";
import type { Correction } from "./scan/chapters";
import { fit, titlesOnly, type LookedUp, type Region } from "./audnexus";
import { fold } from "./search";

/**
 * Real chapter names for books whose files only number their chapters.
 * Many files carry generated markers ("Chapter 1" to "Chapter 37") while
 * the book opens with credits and an epigraph, so the narrator's Chapter
 * 2 is the file's fourth marker. Audible's chapter data (through
 * Audnexus) has the names the publisher gave them. Pure: the app does
 * the asking.
 */

/** "Chapter 3", "Track 03", "Part 3", "03", "3." and the like, with its number. */
const NUMBERED = /^\s*(?:chapter|chap\.?|track|part|kapitel|chapitre|cap[ií]tulo|capitolo|hoofdstuk|rozdzia[lł]|глава)?\s*[-_#.:]?\s*0*(\d{1,4})\s*\.?\s*$/i;

/**
 * True when every title is just a number in order (1, 2, 3, or 0, 1, 2):
 * names a tool made up, not the ones the book was given. One chapter is
 * not a list and says nothing.
 */
export function generatedTitles(chapters: readonly Pick<Chapter, "title">[]): boolean {
  if (chapters.length < 2) return false;
  const numbers = chapters.map((c) => c.title.match(NUMBERED)?.[1]);
  if (numbers.some((n) => n === undefined)) return false;
  const first = Number(numbers[0]);
  if (first !== 0 && first !== 1) return false;
  return numbers.every((n, i) => Number(n) === first + i);
}

export interface Product {
  asin: string;
  title: string;
  authors: string[];
  narrators: string[];
  runtimeMs: number;
}

/** Audible's catalog search, by title and author. */
export function catalogUrl(title: string, author: string, region: Region = "us"): string {
  const host: Record<Region, string> = {
    us: "api.audible.com",
    uk: "api.audible.co.uk",
    ca: "api.audible.ca",
    au: "api.audible.com.au",
    de: "api.audible.de",
    fr: "api.audible.fr",
    it: "api.audible.it",
    es: "api.audible.es",
    in: "api.audible.in",
    jp: "api.audible.co.jp",
  };
  const q = new URLSearchParams({ title, author, num_results: "10", products_sort_by: "Relevance", response_groups: "product_attrs,contributors" });
  return `https://${host[region]}/1.0/catalog/products?${q}`;
}

/** The products in a catalog answer. Anything malformed is left out. */
export function parseCatalog(json: unknown): Product[] {
  const list = (json as { products?: unknown })?.products;
  if (!Array.isArray(list)) return [];
  const names = (v: unknown) => (Array.isArray(v) ? v.map((x) => String((x as { name?: unknown })?.name ?? "")).filter(Boolean) : []);
  const out: Product[] = [];
  for (const p of list) {
    const r = p as Record<string, unknown>;
    const asin = String(r.asin ?? "");
    const minutes = Number(r.runtime_length_min);
    if (!/^[A-Z0-9]{10}$/.test(asin) || !Number.isFinite(minutes) || minutes <= 0) continue;
    out.push({ asin, title: String(r.title ?? ""), authors: names(r.authors), narrators: names(r.narrators), runtimeMs: minutes * 60_000 });
  }
  return out;
}

/** The title a search should use: a numbered folder's number and the series noise taken off. */
export function searchTitle(title: string): string {
  return title
    .replace(/^\s*\d+(?:\.\d+)?\s*[.\-_)]+\s*/, "")
    .replace(/\s*[:(\[].*(?:warhammer|series|book \d|unabridged|novel).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The product that is this book: as long as the book within a minute or
 * one percent (catalog runtimes are whole minutes), and with the same
 * title. A narrator that matches breaks a tie. Null when nothing is
 * close enough to trust.
 */
export function pickProduct(products: readonly Product[], book: { title: string; narrator: string; durationMs: number }): Product | null {
  const tolerance = Math.max(60_000, book.durationMs * 0.01);
  const want = fold(searchTitle(book.title));
  const narrators = new Set(book.narrator.split(/\s*[,;&]\s*|\s+and\s+/i).map(fold).filter(Boolean));
  const near = products.filter((p) => Math.abs(p.runtimeMs - book.durationMs) <= tolerance);
  const titled = near.filter((p) => {
    const t = fold(p.title);
    return want && (t === want || t.startsWith(want) || want.startsWith(t));
  });
  if (titled.length === 0) return null;
  const byNarrator = titled.find((p) => p.narrators.some((n) => narrators.has(fold(n))));
  return byNarrator ?? (titled.length === 1 ? titled[0]! : null);
}

export type Plan = { apply: true; corrections: Correction[] } | { apply: false; reason: string };

/**
 * Whether the looked-up names can go onto this book's chapters as they
 * are: the same count, the same length, and every start within twenty
 * seconds (or 0.2% of the book) of the looked-up one. Times are never moved;
 * when they disagree, the listener can still apply a lookup by hand.
 */
export function planNames(lookup: LookedUp, chapters: readonly Chapter[], bookMs: number): Plan {
  const f = fit(lookup, bookMs, chapters.length);
  if (!f.countsMatch) return { apply: false, reason: `Audible has ${lookup.chapters.length} chapters; the file has ${chapters.length}` };
  if (!f.timesFit) return { apply: false, reason: "the lengths differ" };
  const slack = Math.max(20_000, bookMs * 0.002);
  const scale = lookup.runtimeMs > 0 ? bookMs / lookup.runtimeMs : 1;
  const off = chapters.findIndex((c, i) => Math.abs(c.startMs - lookup.chapters[i]!.startMs * scale) > slack);
  if (off >= 0) return { apply: false, reason: `chapter ${off + 1} starts at a different time` };
  const corrections = titlesOnly(lookup, chapters.length).filter((c) => c.op === "rename" && c.title !== chapters[c.index]?.title);
  if (corrections.length === 0) return { apply: false, reason: "the names already match" };
  return { apply: true, corrections };
}
