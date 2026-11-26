// A comic's book as Ribbon 0.50.0 named it, before comics had details of their own (docs/BOOK-DETAILS.md), kept for
// book-details.test.ts: a server's data in today's shape is made from comics added now, named again as 0.50.0 named
// them. `parseComicName` and `nameComic` are 0.50.0's (packages/core/src/comic/filename.ts and scan/comics.ts), as
// they were; `bookAsBefore` lays what they say over a comic's book the way 0.50.0's scan built it (scan.ts, `buildComic`).
import { splitPeople } from "@ribbon/core/scan/sidefiles";
import type { Book } from "@ribbon/core/types";

interface ComicName {
  series: string;
  number: number | null;
  year: number | null;
  title: string;
}

function looksLikeYear(digits: string): boolean {
  return digits.length === 4 && Number(digits) >= 1900 && Number(digits) <= 2100;
}

function parseComicName(stem: string): ComicName {
  let year: number | null = null;
  const plain = stem
    .replace(/_/g, " ")
    .replace(/\(([^)]*)\)|\[([^\]]*)\]/g, (_, round: string | undefined, square: string | undefined) => {
      const y = (round ?? square ?? "").match(/\b(19|20)\d{2}\b/);
      if (y && year === null) year = Number(y[0]);
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();
  const title = plain || stem.trim();
  const volume = plain.match(/^(.+?)[\s-]*\bv(?:ol(?:ume)?)?\.?\s*(\d+)$/i);
  if (volume) return { series: volume[1]!.replace(/[\s-]+$/, "").trim(), number: Number(volume[2]), year, title };
  const issue = plain.match(/^(.*?)[\s-]*(?:\bv(?:ol(?:ume)?)?\.?\s*(\d+))?[\s-]*(#)?(\d+(?:\.\d+)?)(?:\s+of\s+\d+)?$/i);
  if (issue) {
    const [, before, , hash, digits] = issue;
    const series = (before ?? "").replace(/[\s-]+$/, "").trim();
    if (hash || !looksLikeYear(digits!) || series === "") return { series, number: Number(digits), year, title };
  }
  return { series: "", number: null, year, title };
}

/** What 0.50.0 read of a ComicInfo.xml that names a comic: its number only when it is one. */
interface ComicRecord {
  title?: string;
  series?: string;
  number?: number;
  year?: number;
}

function nameComic(record: ComicRecord | undefined, fileStem: string, folderName: string) {
  const name = parseComicName(fileStem);
  const fromFolder = name.series === "" && name.number !== null ? parseComicName(folderName).title : "";
  const series = record?.series || name.series || fromFolder;
  const seriesIndex = series ? (record?.series ? record.number : (record?.number ?? name.number)) : null;
  const title = record?.title || (series && seriesIndex !== null ? `${series} #${seriesIndex}` : name.title);
  return { title, series, seriesIndex: seriesIndex ?? null, year: record?.year ?? name.year };
}

function authorsOf(authors: readonly string[]): string {
  return authors.join(authors.every((a) => /\s/.test(a.trim())) ? ", " : "; ");
}

/** The details a comic's book has had since this change, which 0.50.0's never had. */
const NEW = ["credits", "issue", "volume", "collects", "imprint", "coverDate", "onSale", "storyArcs", "comicvine"] as const;

/**
 * A comic's book as 0.50.0 kept it: named by its ComicInfo.xml (given as
 * the fields it was made with, `Title`, `Series`, `Number`, `Year`,
 * `Writer`), its file's name and its folder's, its whole name its title,
 * its writers its author, its number its place, and none of a comic's own
 * details.
 */
export function bookAsBefore(book: Book, info: Record<string, string | number> | undefined, fileStem: string, folderName: string): Book {
  const number = info?.Number === undefined ? undefined : Number(info.Number);
  const record: ComicRecord | undefined = info && {
    ...(info.Title ? { title: String(info.Title) } : {}),
    ...(info.Series ? { series: String(info.Series) } : {}),
    ...(number !== undefined && Number.isFinite(number) ? { number } : {}),
    ...(info.Year ? { year: Number(info.Year) } : {}),
  };
  const naming = nameComic(record, fileStem, folderName);
  const old: Book = { ...book, title: naming.title, rawTitle: naming.title, author: authorsOf(info?.Writer ? splitPeople(String(info.Writer)) : []), series: naming.series, seriesIndex: naming.seriesIndex, year: naming.year };
  for (const detail of NEW) delete old[detail];
  return old;
}
