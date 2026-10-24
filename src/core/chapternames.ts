import type { Chapter } from "./types";
import type { Correction } from "./scan/chapters";
import { fit, titlesOnly, type LookedUp, type Region } from "./audnexus";
import { chapterKey, type Alignment, type Pair } from "./reading/align";
import type { BookText } from "./reading/booktext";
import { fold } from "./search";

/**
 * Real chapter names for books whose files only number their chapters.
 * Many files carry generated markers ("Chapter 1" to "Chapter 37") while
 * the book opens with credits and an epigraph, so the narrator's Chapter
 * 2 is the file's fourth marker. The names come from the book's own text,
 * when it has an EPUB (`namesFromContents`), or from Audible's chapter
 * data (through Audnexus), which has the names the publisher gave them.
 * Pure: the app and the server do the asking.
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

// Names from the book's own text ------------------------------------------

/** A chapter given a name: its place in the list of chapters, and the name. */
export interface ChapterName {
  index: number;
  title: string;
}

/** A contents entry that sets off a part of the book rather than a chapter: "Part Two", "BOOK III". */
const PART = /^\s*(part|book)\b/i;

/** A contents entry as a name shows it: on one line. */
const tidy = (label: string) => label.replace(/\s+/g, " ").trim();

/**
 * Whether a contents entry numbers a chapter, alone or before its title:
 * "Three", "Chapter 3", "XII", "Twenty-one: The Long Walk", "1. Arrival",
 * "9:ii" (a part's ninth, its second chapter). A part is not a chapter.
 */
export function numbersChapter(label: string): boolean {
  if (PART.test(label)) return false;
  const lead = label.split(/[:.]|\s[–—-]\s/)[0]!.trim();
  return lead !== "" && /^\d+$/.test(chapterKey(lead));
}

/** A name that is a number and nothing else: "One", "ii", "Chapter 3". */
const onlyNumber = (title: string) => numbersChapter(title) && /^\d+$/.test(chapterKey(title));

/**
 * The heading each numbered chapter of a book's contents comes under: the
 * nearest entry before it that isn't a numbered chapter ("Part Two",
 * "INTERLUDE"), by where the chapter is (`href#block`, as the pairing names
 * it). A part's heading often shares its place with the part's first
 * chapter, and the pairing keeps only the chapter there, so the headings
 * are read from the contents themselves.
 */
export function headingsOf(text: BookText): Map<string, string> {
  const ebook = text.ebook;
  const out = new Map<string, string>();
  let heading = "";
  for (const t of ebook.toc) {
    const section = ebook.sections[t.section];
    if (!section?.linear) continue;
    if (!numbersChapter(t.label)) heading = tidy(t.label);
    else if (heading) out.set(`${section.href}#${t.block}`, heading);
  }
  return out;
}

/**
 * Names for an audiobook's chapters from its text's contents, by the
 * pairing of the two (reading/align.ts): each audio chapter is named after
 * the contents entries it reads, "Three", or "Part Two, One" when a part
 * opens with its first chapter.
 *
 * A name is given only where the pairing is sure of it:
 * - across the run of the book's numbered chapters, from the first to the
 *   last, where the chapters' lengths pair them: the pairing read-along
 *   already moves between the text and the audio by;
 * - before and after that run, where the credits meet the front and back
 *   matter and lengths can't tell an epigraph from a first chapter, only
 *   where the narration says so: a pair set by hand, an opening heard as
 *   its text's, or the transcript found in its text.
 *
 * An audio chapter the pairing passed over, alone between two named ones,
 * takes the entries it passed over between them (a part's heading, read on
 * its own). In a book that numbers its chapters again under each heading,
 * a name that is only a number gets its heading (`headingsOf`): "One (Part
 * Two)". Written "Part Two: One", it would read to the pairing as chapter
 * three.
 */
export function namesFromContents(a: Alignment, headings: ReadonlyMap<string, string> = new Map()): ChapterName[] {
  if (a.how !== "chapter") return [];
  const narrated = (p: Pair) => p.fixed || !!p.heard || p.points.length > 2;
  const numbered = a.pairs.map((_, k) => a.text.some((t) => t.pair === k && numbersChapter(t.label)));
  const first = numbered.indexOf(true);
  const last = numbered.lastIndexOf(true);
  const sure = (k: number) => k >= 0 && ((first >= 0 && k >= first && k <= last) || narrated(a.pairs[k]!));
  const textOf = (k: number) => a.text.flatMap((t, i) => (t.pair === k ? [i] : []));
  const label = (from: number, to: number) =>
    a.text
      .slice(from, to)
      .map((t) => tidy(t.label))
      .join(", ");

  // Each with the first contents entry it reads, for the heading it's under.
  const names: (ChapterName & { entry: number; continued: boolean })[] = [];
  a.audio.forEach((u, j) => {
    if (u.pair >= 0) {
      if (!sure(u.pair)) return;
      const entries = textOf(u.pair);
      names.push({ index: j, title: label(entries[0]!, entries.at(-1)! + 1), entry: entries[0]!, continued: a.audio[j - 1]?.pair === u.pair });
      return;
    }
    const before = a.audio[j - 1]?.pair ?? -1;
    const after = a.audio[j + 1]?.pair ?? -1;
    if (!sure(before) || !sure(after)) return;
    // Pairs run in order, so the entries between two are the ones passed over.
    const from = textOf(before).at(-1)! + 1;
    const to = textOf(after)[0]!;
    if (to > from) names.push({ index: j, title: label(from, to), entry: from, continued: false });
  });

  const numbers = names.filter((n) => !n.continued && onlyNumber(n.title)).map((n) => n.title);
  const again = new Set(numbers).size < numbers.length;
  return names.map(({ index, title, entry, continued }) => {
    const under = again && onlyNumber(title) ? headings.get(a.text[entry]!.ref) : undefined;
    const named = under ? `${title} (${under})` : title;
    return { index, title: continued ? `${named} (continued)` : named };
  });
}
