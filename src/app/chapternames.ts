import type { Host } from "../host/host";
import type { ScannedBook } from "../core/scan/scan";
import { chaptersUrl, parseChapters, type Region } from "../core/audnexus";
import { generatedTitles, parseCatalog, pickProduct, planNames, searchTitle, type Plan } from "../core/chapternames";
import { splitPeople } from "../core/scan/sidefiles";
import { bytesToRows, rowsToBytes } from "../core/csv";

/**
 * What came of asking about one book's chapter names: kept beside the
 * books in `.ribbon/chapter-names.csv` so each book is asked about once.
 */
export interface NameRecord {
  bookId: string;
  /** The ASIN the names came from, or the one tried, or empty. */
  asin: string;
  outcome: "applied" | "kept" | "not-found";
  /** Why nothing was applied, in a few words. */
  reason: string;
  at: string;
}

export const NAME_HEADERS = ["book_id", "asin", "outcome", "reason", "at"];

export function nameRecordsToBytes(list: readonly NameRecord[]): Promise<Uint8Array> {
  return rowsToBytes(
    list.map((r) => ({ book_id: r.bookId, asin: r.asin, outcome: r.outcome, reason: r.reason, at: r.at })),
    NAME_HEADERS,
  );
}

export async function bytesToNameRecords(bytes: Uint8Array): Promise<NameRecord[]> {
  const { rows } = await bytesToRows(bytes);
  return rows
    .filter((r) => r.book_id && (r.outcome === "applied" || r.outcome === "kept" || r.outcome === "not-found"))
    .map((r) => ({ bookId: r.book_id!, asin: r.asin ?? "", outcome: r.outcome as NameRecord["outcome"], reason: r.reason ?? "", at: r.at ?? "" }));
}

/** True when a book's chapters are worth asking about: read, and only numbered. */
export function wantsNames(book: ScannedBook): boolean {
  const known = book.files.length > 1 || book.files.every((f) => f.chaptersProbed);
  return known && generatedTitles(book.chapters);
}

/**
 * Finds a book's real chapter names: its ASIN from the tags, the side
 * files or the folder name, else from Audible's catalog by title and
 * author (taken only when the length matches), then its chapters from
 * Audnexus, and a plan for putting the names on the markers there are.
 */
export class ChapterNamer {
  constructor(
    private readonly host: Host,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly region: Region = "us",
  ) {}

  async findAsin(book: ScannedBook): Promise<string | null> {
    const b = book.original ?? book.book;
    if (book.book.asin) return book.book.asin;
    if (!this.host.catalogSearch) return null;
    const author = splitPeople(b.author)[0] ?? "";
    const text = await this.host.catalogSearch(searchTitle(book.book.title), author, this.region);
    const product = pickProduct(parseCatalog(JSON.parse(text)), { title: book.book.title, narrator: book.book.narrator, durationMs: book.book.durationMs });
    return product?.asin ?? null;
  }

  /** Ask, and say what to do. Throws on a network failure, so the book can be asked about again later. */
  async plan(book: ScannedBook): Promise<{ asin: string; plan: Plan }> {
    const asin = await this.findAsin(book);
    if (!asin) return { asin: "", plan: { apply: false, reason: "not in Audible's catalog at this length" } };
    const r = await this.fetchImpl(chaptersUrl(asin, this.region), { headers: { accept: "application/json" } });
    if (r.status === 404) return { asin, plan: { apply: false, reason: "no chapters for this ASIN" } };
    if (!r.ok) throw new Error(`Audnexus answered ${r.status}`);
    const lookup = parseChapters(await r.json().catch(() => null));
    if (!lookup) return { asin, plan: { apply: false, reason: "no chapters for this ASIN" } };
    return { asin, plan: planNames(lookup, book.chapters, book.book.durationMs) };
  }
}
