import { bytesToRows, int, bool, rowsToBytes } from "../csv";
import { comicVineIssue, parseComicInfo, type ComicInfo } from "../comic/comicinfo";
import { parseComicName } from "../comic/filename";
import { issueNumber } from "../comic-name";
import type { Book } from "../types";

/**
 * What a scan reads of a comic (docs/COMICS.md, section 4): how many
 * pages its archive lists and what its ComicInfo.xml says, no page
 * opened. The host reads it, once per file; it is kept in
 * `.ribbon/comics.csv` so an unchanged comic is not opened again.
 *
 * It is ComicInfo.xml as the file says it, read in full; what it means for
 * the comic's details is worked out by `comicFromFiles`.
 */
export interface ComicRecord extends ComicInfo {
  /** Library-relative, forward slashes. */
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  pages: number;
}

/**
 * The columns `comics.csv` has had since comics came, which keep less
 * than a ComicRecord holds: of the people, only the writers; a number
 * only when it is one; no volume, format, month, day, imprint, story arc
 * or address. A comic read again from this record is named from what it
 * keeps (docs/BOOK-DETAILS.md, section 4, has the columns that keep the
 * rest, and the one reading again that fills them).
 */
export const COMIC_RECORD_HEADERS = ["path", "size_bytes", "mtime_ms", "pages", "title", "series", "number", "year", "writers", "publisher", "summary", "language", "genres", "right_to_left"];

/** A record from the tags the scanner sent: `pages`, and `comicinfo`, the archive's ComicInfo.xml as text. */
export function comicFromTags(file: { path: string; sizeBytes: number; mtimeMs: number }, tags: Record<string, string>): ComicRecord {
  return { path: file.path, sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs, pages: int(tags.pages), ...(tags.comicinfo ? parseComicInfo(tags.comicinfo) : {}) };
}

export function comicsToBytes(list: readonly ComicRecord[]): Promise<Uint8Array> {
  return rowsToBytes(
    list.map((c) => ({
      path: c.path,
      size_bytes: String(c.sizeBytes),
      mtime_ms: String(c.mtimeMs),
      pages: String(c.pages),
      title: c.title ?? "",
      series: c.series ?? "",
      // A number only, as a Ribbon from before reads this column: "1.MU" would be no number to it.
      number: numberColumn(c.number),
      year: c.year === undefined ? "" : String(c.year),
      writers: (c.credits?.writers ?? []).join("; "),
      publisher: c.publisher ?? "",
      summary: c.summary ?? "",
      language: c.language ?? "",
      genres: (c.genres ?? []).join("; "),
      right_to_left: c.rightToLeft ? "1" : "0",
    })),
    COMIC_RECORD_HEADERS,
  );
}

function numberColumn(number: string | undefined): string {
  const n = number === undefined ? null : issueNumber(number);
  return n === null ? "" : String(n);
}

export async function bytesToComics(bytes: Uint8Array): Promise<Map<string, ComicRecord>> {
  const { rows } = await bytesToRows(bytes);
  const list = (cell: string | undefined) => (cell ?? "").split(/\s*;\s*/).filter(Boolean);
  const out = new Map<string, ComicRecord>();
  for (const r of rows) {
    if (!r.path) continue;
    const writers = list(r.writers);
    const genres = list(r.genres);
    const year = r.year ? int(r.year) : 0;
    out.set(r.path, {
      path: r.path,
      sizeBytes: int(r.size_bytes),
      mtimeMs: int(r.mtime_ms),
      pages: int(r.pages),
      ...(r.title ? { title: r.title } : {}),
      ...(r.series ? { series: r.series } : {}),
      ...(r.number ? { number: r.number } : {}),
      ...(year > 0 ? { year } : {}),
      ...(writers.length > 0 ? { credits: { writers } } : {}),
      ...(r.publisher ? { publisher: r.publisher } : {}),
      ...(r.summary ? { summary: r.summary } : {}),
      ...(r.language ? { language: r.language } : {}),
      ...(genres.length > 0 ? { genres } : {}),
      ...(bool(r.right_to_left) ? { rightToLeft: true } : {}),
    });
  }
  return out;
}

/** The formats ComicInfo.xml gives a collection, whose `Number` is its volume: a trade paperback, a hardcover, an omnibus. */
const COLLECTION_FORMATS = /^(tpb|trade\s*paper\s*back|hc|hard\s*cover|omnibus|compendium|deluxe(\s+edition)?|absolute(\s+edition)?)$/i;

/** A `Volume` that is a run's first year, which the series' name carries (docs/BOOK-DETAILS.md, section 3), rather than a run's number or a manga's book. */
function runYear(volume: string | undefined): string | null {
  return volume && /^(19|20)\d{2}$/.test(volume.trim()) ? volume.trim() : null;
}

/** A cover date from ComicInfo's year and month: "2024-07", or "2024" with no month. */
function coverDateOf(year: number, month: number | undefined): string {
  return month === undefined ? String(year).padStart(4, "0") : `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/**
 * What a comic's files say of it, before a person's edits: the details a
 * comic's book carries (docs/BOOK-DETAILS.md, section 2), and the name of
 * its file as a title, which is what it is called until its details make
 * it a name (comic-name.ts, `namedComic`).
 */
export type ComicFromFiles = Pick<Book, "title" | "rawTitle" | "series" | "year"> &
  Partial<Pick<Book, "issue" | "volume" | "credits" | "imprint" | "coverDate" | "storyArcs" | "comicvine" | "publisher" | "description" | "language" | "genres" | "rightToLeft">>;

/**
 * A comic's details (docs/COMICS.md, section 4; docs/BOOK-DETAILS.md,
 * section 2). ComicInfo.xml is believed first. Where it says nothing, the
 * file's name counts: "Saga 014 (2013)" is Saga, issue 14. A name that is
 * only a number ("014.cbz") takes its series from the folder it is in. A
 * comic nobody has read yet (`record` absent) is known by its file alone,
 * so the shelf shows it at once and its details arrive after.
 *
 * - **Its series** is the run. A `Volume` that is a year is the run's
 *   first year, and goes in brackets after the series' name, "Transformers
 *   (2023)", unless the name has a year there already. A file name's "v2"
 *   before an issue is the run too: "Batman v2".
 * - **Its number** is an issue's, or a collection's volume when `Format`
 *   says it is one (a TPB, a hardcover, an omnibus), or when its file's
 *   name ends in one ("Saga Vol. 2"). Where ComicInfo.xml names a series,
 *   only its own number counts. A number means nothing without a series to
 *   be a number in, so a comic with no series has none.
 * - **Its title** is the story's own name, from ComicInfo.xml; else, for a
 *   comic with no number, what its file is called.
 * - **Its cover date** is ComicInfo's year and month, else its file name's
 *   year; its year is the cover date's.
 */
export function comicFromFiles(record: ComicRecord | undefined, fileStem: string, folderName: string): ComicFromFiles {
  const name = parseComicName(fileStem);
  const fromFolder = name.series === "" && (name.issue !== null || name.volume !== null) ? parseComicName(folderName).title : "";
  const run = runYear(record?.volume);
  const series = record?.series ? (run && !/\(\d{4}\)$/.test(record.series.trim()) ? `${record.series.trim()} (${run})` : record.series) : name.series || fromFolder;

  let issue: string | null = null;
  let volume: string | null = null;
  if (series) {
    if (record?.series || record?.number) {
      const number = record.number ?? null;
      if (number && COLLECTION_FORMATS.test(record.format?.trim() ?? "")) volume = number;
      else issue = number;
    } else {
      issue = name.issue;
      volume = name.volume;
    }
  }

  const year = record?.year ?? name.year;
  const coverDate = record?.year !== undefined ? coverDateOf(record.year, record.month) : name.year !== null ? String(name.year) : null;
  const comicvine = comicVineIssue(record?.web);
  return {
    title: name.title,
    rawTitle: record?.title || (issue || volume ? "" : name.title),
    series,
    year,
    ...(issue ? { issue } : {}),
    ...(volume ? { volume } : {}),
    ...(record?.credits ? { credits: record.credits } : {}),
    ...(record?.imprint ? { imprint: record.imprint } : {}),
    ...(coverDate ? { coverDate } : {}),
    ...(record?.storyArcs ? { storyArcs: record.storyArcs } : {}),
    ...(comicvine ? { comicvine } : {}),
    ...(record?.publisher ? { publisher: record.publisher } : {}),
    ...(record?.summary ? { description: record.summary } : {}),
    ...(record?.language ? { language: record.language } : {}),
    ...(record?.genres && record.genres.length > 0 ? { genres: record.genres } : {}),
    ...(record?.rightToLeft ? { rightToLeft: true } : {}),
  };
}

/** True for a book that is a comic. */
export function isComicBook(book: Pick<Book, "comic">): boolean {
  return !!book.comic;
}
