import type { ScannedBook } from "./scan/scan";
import { compareBooks } from "./order";
import { splitPeople } from "./scan/sidefiles";

/**
 * How the shelf is filtered and sorted. Every filter narrows; within one
 * kind (two authors, say) any match will do. Pure: the app hands in how
 * far along each book is and when it was last listened to.
 */

export type Standing = "new" | "started" | "finished";
export type Missing = "cover" | "chapters" | "description";
export type FacetKind = "author" | "narrator" | "genre" | "series";

export interface LibraryFilter {
  standing?: Standing[];
  author?: string[];
  narrator?: string[];
  genre?: string[];
  series?: string[];
  missing?: Missing[];
}

export const SORTS = ["shelf", "title", "author", "listened", "added", "length", "year", "progress"] as const;
export type SortKey = (typeof SORTS)[number];

export interface LibraryView {
  filter: LibraryFilter;
  sort: SortKey;
  /** Reverse the sort's natural direction. */
  reverse: boolean;
}

export const DEFAULT_VIEW: LibraryView = { filter: {}, sort: "shelf", reverse: false };

export interface BookFacts {
  standing(b: ScannedBook): Standing;
  /** 0 to 1. */
  fraction(b: ScannedBook): number;
  /** Milliseconds since the epoch, 0 when never. */
  listenedAt(b: ScannedBook): number;
  /** The series the book is in, if any. */
  seriesOf(b: ScannedBook): string | null;
}

/** The values a facet can take on a book: several authors, several genres. */
export function facetValues(b: ScannedBook, kind: FacetKind, facts: Pick<BookFacts, "seriesOf">): string[] {
  switch (kind) {
    case "author":
      return splitPeople(b.book.author);
    case "narrator":
      return splitPeople(b.book.narrator);
    case "genre":
      return b.book.genres ?? [];
    case "series": {
      const s = facts.seriesOf(b);
      return s ? [s] : [];
    }
  }
}

/** Every value of a facet with how many books carry it, most common first. */
export function facetCounts(books: readonly ScannedBook[], kind: FacetKind, facts: Pick<BookFacts, "seriesOf">): { value: string; count: number }[] {
  const counts = new Map<string, { value: string; count: number }>();
  for (const b of books) {
    for (const v of facetValues(b, kind, facts)) {
      const k = v.toLowerCase();
      const have = counts.get(k);
      if (have) have.count++;
      else counts.set(k, { value: v, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export function missing(b: ScannedBook, what: Missing): boolean {
  switch (what) {
    case "cover":
      return !b.book.cover;
    case "chapters":
      // One chapter for the whole of a long book is no chapters at all.
      return b.chapters.length <= 1 && b.book.durationMs > 3_600_000;
    case "description":
      return !b.book.description;
  }
}

/** How many filters are on, counting each chosen value. */
export function filterCount(f: LibraryFilter): number {
  return (f.standing?.length ?? 0) + (f.author?.length ?? 0) + (f.narrator?.length ?? 0) + (f.genre?.length ?? 0) + (f.series?.length ?? 0) + (f.missing?.length ?? 0);
}

export function matches(b: ScannedBook, f: LibraryFilter, facts: BookFacts): boolean {
  if (f.standing?.length && !f.standing.includes(facts.standing(b))) return false;
  for (const kind of ["author", "narrator", "genre", "series"] as const) {
    const want = f[kind];
    if (!want?.length) continue;
    const have = new Set(facetValues(b, kind, facts).map((v) => v.toLowerCase()));
    if (!want.some((w) => have.has(w.toLowerCase()))) return false;
  }
  if (f.missing?.length && !f.missing.some((m) => missing(b, m))) return false;
  return true;
}

/** When a book arrived: its newest file's modified time. */
export function addedAt(b: ScannedBook): number {
  let t = 0;
  for (const f of b.files) if (f.mtimeMs > t) t = f.mtimeMs;
  return t;
}

/**
 * Filter and sort. "shelf" keeps the order given (the app's own shelf
 * order); every other sort has a natural direction, newest or most first
 * for times and amounts, A to Z for names, which `reverse` flips.
 */
export function applyView(books: readonly ScannedBook[], view: LibraryView, facts: BookFacts): ScannedBook[] {
  const kept = books.filter((b) => matches(b, view.filter, facts));
  if (view.sort === "shelf") return view.reverse ? kept.reverse() : kept;
  const byTitle = (a: ScannedBook, b: ScannedBook) => compareBooks(a.book, b.book);
  const cmp: Record<Exclude<SortKey, "shelf">, (a: ScannedBook, b: ScannedBook) => number> = {
    title: (a, b) => a.book.title.localeCompare(b.book.title, undefined, { numeric: true, sensitivity: "base" }),
    author: (a, b) => sortName(a.book.author).localeCompare(sortName(b.book.author), undefined, { sensitivity: "base" }) || byTitle(a, b),
    listened: (a, b) => facts.listenedAt(b) - facts.listenedAt(a) || byTitle(a, b),
    added: (a, b) => addedAt(b) - addedAt(a) || byTitle(a, b),
    length: (a, b) => b.book.durationMs - a.book.durationMs,
    year: (a, b) => (b.book.year ?? -Infinity) - (a.book.year ?? -Infinity) || byTitle(a, b),
    progress: (a, b) => facts.fraction(b) - facts.fraction(a) || byTitle(a, b),
  };
  const sorted = [...kept].sort(cmp[view.sort]);
  return view.reverse ? sorted.reverse() : sorted;
}

/** "Frank Herbert" sorts as "Herbert Frank"; "Herbert, Frank" already does. No author sorts last. */
function sortName(author: string): string {
  const first = splitPeople(author)[0] ?? "";
  if (!first) return "￿";
  if (first.includes(",")) return first;
  const parts = first.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[parts.length - 1]} ${parts.slice(0, -1).join(" ")}` : first;
}

export const SORT_LABELS: Record<SortKey, string> = {
  shelf: "Shelf order",
  title: "Title",
  author: "Author",
  listened: "Recently listened",
  added: "Recently added",
  length: "Length",
  year: "Year",
  progress: "Progress",
};

/** Read a saved view, dropping anything that no longer makes sense. */
export function parseView(raw: unknown): LibraryView {
  if (!raw || typeof raw !== "object") return DEFAULT_VIEW;
  const r = raw as Partial<LibraryView>;
  const sort = (SORTS as readonly string[]).includes(r.sort as string) ? (r.sort as SortKey) : "shelf";
  const f = (r.filter ?? {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
  const filter: LibraryFilter = {};
  for (const k of ["standing", "author", "narrator", "genre", "series", "missing"] as const) {
    const v = list(f[k]);
    if (v?.length) (filter as Record<string, string[]>)[k] = v;
  }
  return { filter, sort, reverse: r.reverse === true };
}
