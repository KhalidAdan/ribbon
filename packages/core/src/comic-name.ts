import type { EditValues } from "./edits";
import type { Book, Credits } from "./types";

/**
 * How a comic is named on the shelf (docs/BOOK-DETAILS.md, section 3):
 * from its details, here and only here, so every device names a comic
 * the same way. Its title is the story's own name, "Chapter Fourteen";
 * the name is made from that, its series and its number, "Saga #14:
 * Chapter Fourteen". Its byline, its place in the series and its label
 * there ("#14", "Vol. 1") are made here too.
 *
 * A host names a comic after laying a person's edits over what its
 * files say, with today's edits moved first (comic-edits.ts):
 *
 *     const values = movedComicEdits(edits, files);
 *     const shown = namedComic(applyEdits(files, values), values);
 *
 * The scan names a comic from its files the same way, with no edits.
 */

/**
 * What a comic is (section 2): an issue, with an issue number; a
 * collection, with a volume number or the issues it collects; or a comic
 * on its own, a graphic novel or a one-shot, with neither. It is never
 * kept: its details say it.
 */
export type ComicShape = "issue" | "collection" | "alone";

/** What a comic's name, place and label are made from. */
export interface ComicNaming {
  /** The series, a run's first year and all: "Transformers (2023)". */
  series: string;
  issue?: string | undefined;
  volume?: string | undefined;
  collects?: string | undefined;
  /** The story's own name, or empty (a comic's `rawTitle`). */
  title: string;
}

/** What a comic is, from its numbers. An issue number wins: a form that makes an issue a collection empties it (edit-form.ts, `shapeEmpties`). */
export function comicShape(c: Pick<ComicNaming, "issue" | "volume" | "collects">): ComicShape {
  if (c.issue?.trim()) return "issue";
  if (c.volume?.trim() || c.collects?.trim()) return "collection";
  return "alone";
}

/** A run's first year, in brackets at the end of a series' name, is left out of a comic's name: the series says it ("Transformers (2023)" is "Transformers"). */
export function seriesWithoutRunYear(series: string): string {
  const s = series.trim();
  return s.replace(/\s*\(\d{4}\)$/, "") || s;
}

/** A number as a place can be had from it: "14", "0.5", "½", "-1". "1.MU" and "14A" aren't numbers. */
export function issueNumber(issue: string): number | null {
  const t = issue.trim().replace(/^#/, "");
  if (t === "½" || t === "1/2") return 0.5;
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

/** A piece of a list of issues that is an issue's number: "7", "#7", "½", "1.MU". */
const ISSUE = /#?\s*([\d½][\w.½]*)/;
const ONE_ISSUE = new RegExp(`^${ISSUE.source}$`);
const LEADING_ISSUE = new RegExp(`^${ISSUE.source}`);
const RANGE = new RegExp(`^${ISSUE.source}\\s*[-–—]\\s*${ISSUE.source}$`);

/** The issues a collection holds, as the shelf says them: "1–6, Annual 1" is "#1–#6, Annual 1". */
export function issuesText(collects: string): string {
  return collects
    .split(/\s*,\s*/)
    .filter(Boolean)
    .map((part) => {
      const range = part.match(RANGE);
      if (range) return `#${range[1]}–#${range[2]}`;
      const one = part.match(ONE_ISSUE);
      return one ? `#${one[1]}` : part;
    })
    .join(", ");
}

/** The first issue a collection holds that is a number: 1, for "1–6, Annual 1". */
export function firstIssue(collects: string): number | null {
  for (const part of collects.split(/\s*,\s*/)) {
    const first = part.match(LEADING_ISSUE);
    const n = first ? issueNumber(first[1]!) : null;
    if (n !== null) return n;
  }
  return null;
}

/**
 * A comic's name on the shelf (section 3):
 *
 * - an issue: its series, its number, then its title, "Saga #14: Chapter Fourteen";
 * - a collection: its series, its volume, then its title, "Transformers Vol. 1: Robots in Disguise";
 * - a collection with no volume number: its series, then its title or else the issues, "Saga: Compendium One", "Saga (#1–#54)";
 * - on its own: its title, "The Sculptor".
 *
 * A number means nothing without a series to be a number in: with none,
 * the name is the title, else the number alone. Empty when the comic has
 * nothing to be named by.
 */
export function comicName(c: ComicNaming): string {
  const series = seriesWithoutRunYear(c.series);
  const title = c.title.trim();
  const issue = c.issue?.trim() ?? "";
  const volume = c.volume?.trim() ?? "";
  const collects = c.collects?.trim() ?? "";
  const withTitle = (head: string) => (title ? `${head}: ${title}` : head);
  switch (comicShape(c)) {
    case "issue":
      return series ? withTitle(`${series} #${issue}`) : title || `#${issue}`;
    case "collection":
      if (!series) return title || (volume ? `Vol. ${volume}` : issuesText(collects));
      if (volume) return withTitle(`${series} Vol. ${volume}`);
      return title ? withTitle(series) : `${series} (${issuesText(collects)})`;
    case "alone":
      return title || series;
  }
}

/** A comic's byline, where an audiobook says its author: its writers and then its art, each name once, "Daniel Warren Johnson; Jorge Corona". */
export function comicByline(credits: Credits | undefined): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const name of [...(credits?.writers ?? []), ...(credits?.pencils ?? [])]) {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(name.trim());
  }
  return names.join("; ");
}

/**
 * Where a comic comes in its series: its issue number, when that is a
 * number; a collection's is the first issue it collects, else its volume
 * number, so "Vol. 1 (#1–#6)" comes before #7. Null with no series, and
 * for a comic on its own. A series ordered by hand still has the last word
 * (series.ts).
 */
export function comicPlace(c: ComicNaming): number | null {
  if (!c.series.trim()) return null;
  switch (comicShape(c)) {
    case "issue":
      return issueNumber(c.issue ?? "");
    case "collection":
      return firstIssue(c.collects ?? "") ?? issueNumber(c.volume ?? "");
    case "alone":
      return null;
  }
}

/**
 * A comic's label in its series, where an audiobook's is "Book 2": "#7",
 * "Vol. 1", or the issues of a collection with no volume number, "#1–#54".
 * Null with no series, and for a comic on its own, which is labelled as
 * any book is.
 */
export function comicLabel(c: ComicNaming): string | null {
  if (!c.series.trim()) return null;
  switch (comicShape(c)) {
    case "issue":
      return `#${c.issue!.trim()}`;
    case "collection":
      return c.volume?.trim() ? `Vol. ${c.volume.trim()}` : issuesText(c.collects!.trim());
    case "alone":
      return null;
  }
}

/** What a comic's book is named from: the story's own name is its `rawTitle`. */
export function comicNamingOf(book: Partial<Pick<Book, "series" | "issue" | "volume" | "collects" | "rawTitle">>): ComicNaming {
  return { series: book.series ?? "", issue: book.issue, volume: book.volume, collects: book.collects, title: book.rawTitle ?? "" };
}

/** The year of a cover date, "2024-07" or "2024", or null. */
export function coverYear(coverDate: string | undefined): number | null {
  const y = coverDate?.match(/^(\d{4})/)?.[1];
  return y ? Number(y) : null;
}

/**
 * A comic as the shelf shows it, named from its details: its `title` the
 * name, its `author` the byline, its `seriesIndex` its place and its
 * `year` its cover date's. `edits` are the person's edits laid over it, if
 * any: where one of them is that very field, it stands. An `author` edit
 * is a byline kept from before credits had fields of their own (section
 * 6); `seriesIndex` and `year` edits are a person's word on them. Any
 * other book is given back as it is, so a host may name every book.
 */
export function namedComic<B extends Partial<Book>>(book: B, edits: EditValues = {}): B {
  if (!book.comic) return book;
  const naming = comicNamingOf(book);
  const out: Partial<Book> = { ...book };
  // With nothing to be named by (no title, series or number), it keeps the name it has: its file's.
  const name = comicName(naming);
  if (name) out.title = name;
  if (!edits.author?.trim()) out.author = comicByline(book.credits);
  if (edits.seriesIndex === undefined) out.seriesIndex = comicPlace(naming);
  const year = coverYear(book.coverDate);
  if (edits.year === undefined && year !== null) out.year = year;
  return out as B;
}
