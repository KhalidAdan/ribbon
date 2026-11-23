import { bytesToRows, int, bool, rowsToBytes } from "../csv";
import { parseComicInfo } from "../comic/comicinfo";
import { parseComicName } from "../comic/filename";
import type { Book } from "../types";

/**
 * What a scan reads of a comic (docs/COMICS.md, section 4): how many
 * pages its archive lists and what its ComicInfo.xml says, no page
 * opened. The host reads it, once per file; it is kept in
 * `.ribbon/comics.csv` so an unchanged comic is not opened again.
 */
export interface ComicRecord {
  /** Library-relative, forward slashes. */
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  pages: number;
  title: string;
  series: string;
  /** Its number in the series, or null. */
  number: number | null;
  year: number | null;
  writers: string[];
  publisher: string;
  summary: string;
  language: string;
  genres: string[];
  rightToLeft: boolean;
}

export const COMIC_RECORD_HEADERS = ["path", "size_bytes", "mtime_ms", "pages", "title", "series", "number", "year", "writers", "publisher", "summary", "language", "genres", "right_to_left"];

/** A record from the tags the scanner sent: `pages`, and `comicinfo`, the archive's ComicInfo.xml as text. */
export function comicFromTags(file: { path: string; sizeBytes: number; mtimeMs: number }, tags: Record<string, string>): ComicRecord {
  const info = tags.comicinfo ? parseComicInfo(tags.comicinfo) : {};
  return {
    path: file.path,
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    pages: int(tags.pages),
    title: info.title ?? "",
    series: info.series ?? "",
    number: info.number ?? null,
    year: info.year ?? null,
    writers: info.writers ?? [],
    publisher: info.publisher ?? "",
    summary: info.summary ?? "",
    language: info.language ?? "",
    genres: info.genres ?? [],
    rightToLeft: info.rightToLeft ?? false,
  };
}

export function comicsToBytes(list: readonly ComicRecord[]): Promise<Uint8Array> {
  return rowsToBytes(
    list.map((c) => ({
      path: c.path,
      size_bytes: String(c.sizeBytes),
      mtime_ms: String(c.mtimeMs),
      pages: String(c.pages),
      title: c.title,
      series: c.series,
      number: c.number === null ? "" : String(c.number),
      year: c.year === null ? "" : String(c.year),
      writers: c.writers.join("; "),
      publisher: c.publisher,
      summary: c.summary,
      language: c.language,
      genres: c.genres.join("; "),
      right_to_left: c.rightToLeft ? "1" : "0",
    })),
    COMIC_RECORD_HEADERS,
  );
}

export async function bytesToComics(bytes: Uint8Array): Promise<Map<string, ComicRecord>> {
  const { rows } = await bytesToRows(bytes);
  const list = (cell: string | undefined) => (cell ?? "").split(/\s*;\s*/).filter(Boolean);
  const out = new Map<string, ComicRecord>();
  for (const r of rows) {
    if (!r.path) continue;
    out.set(r.path, {
      path: r.path,
      sizeBytes: int(r.size_bytes),
      mtimeMs: int(r.mtime_ms),
      pages: int(r.pages),
      title: r.title ?? "",
      series: r.series ?? "",
      number: r.number ? Number(r.number) : null,
      year: r.year ? int(r.year) : null,
      writers: list(r.writers),
      publisher: r.publisher ?? "",
      summary: r.summary ?? "",
      language: r.language ?? "",
      genres: list(r.genres),
      rightToLeft: bool(r.right_to_left),
    });
  }
  return out;
}

/** What a comic is called and where it belongs, from its record and its file's name. */
export interface ComicNaming {
  title: string;
  series: string;
  seriesIndex: number | null;
  year: number | null;
}

/**
 * Name a comic (docs/COMICS.md, section 4). ComicInfo.xml is believed
 * first. Where it says nothing, the file's name counts: "Saga 014
 * (2013)" is Saga, number 14. A name that is only a number ("014.cbz")
 * takes its series from the folder it is in. A comic nobody has read yet
 * (`record` absent) is named by its file alone, so the shelf shows it at
 * once and its details arrive after.
 */
export function nameComic(record: ComicRecord | undefined, fileStem: string, folderName: string): ComicNaming {
  const name = parseComicName(fileStem);
  const fromFolder = name.series === "" && name.number !== null ? parseComicName(folderName).title : "";
  const series = record?.series || name.series || fromFolder;
  // A number means nothing without a series to be a number in.
  const seriesIndex = series ? (record?.series ? record.number : (record?.number ?? name.number)) : null;
  const title = record?.title || (series && seriesIndex !== null ? `${series} #${seriesIndex}` : name.title);
  return { title, series, seriesIndex, year: record?.year ?? name.year };
}

/** True for a book that is a comic. */
export function isComicBook(book: Pick<Book, "comic">): boolean {
  return !!book.comic;
}
