import { parseNumbered } from "../../../src/core/scan/metadata.ts";
import { bookDir, type BookIndex, type StoredBook } from "./books.ts";
import { hydrateStamp } from "./hydrate.ts";
import { readStored, writeStored } from "./prepare.ts";

/**
 * Descriptions from Audible's catalog, for the books that came with none of
 * their own and have no EPUB that has one: an audiobook folder of MP3s
 * usually says nothing about itself. The same lookup the apps make behind
 * their "Descriptions and chapter names" switch (src-tauri/src/online.rs),
 * here only when the server's admin turns it on (RIBBON_DESCRIPTIONS,
 * docs/SERVER.md), since it asks someone else's service: only a book's
 * title and author are sent.
 *
 * A match must be by one of the book's authors and as long as the
 * recording, so another edition or a namesake is never taken. A
 * description already there, from the files, the EPUB or a person, is never
 * replaced. A book is asked about once (`StoredBook.described`), and again
 * only when its title, author or length changes.
 */

/** Audible's catalog by store, as the apps ask it. */
const HOSTS: Record<string, string> = {
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

/** A recording in the catalog. */
export interface CatalogProduct {
  asin: string;
  title: string;
  authors: string[];
  minutes: number | null;
}

/** What the server asks of a catalog: the recordings by a title and author, and one's summary. */
export interface Catalog {
  search(title: string, author: string): Promise<CatalogProduct[]>;
  summary(asin: string): Promise<string | null>;
}

/** Audible's catalog in one of its stores (`us` unless given). */
export function audibleCatalog(store = "us", fetchFn: typeof fetch = fetch): Catalog {
  const host = HOSTS[store] ?? HOSTS.us!;
  const get = async (path: string, params: Record<string, string>): Promise<unknown> => {
    const url = new URL(`https://${host}/1.0/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const r = await fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`Audible's catalog answered ${r.status}`);
    return r.json();
  };
  return {
    async search(title, author) {
      const d = (await get("catalog/products", { title, author, num_results: "10", products_sort_by: "Relevance", response_groups: "product_attrs,contributors" })) as {
        products?: { asin: string; title?: string; authors?: { name: string }[]; runtime_length_min?: number }[];
      };
      return (d.products ?? []).map((p) => ({ asin: p.asin, title: p.title ?? "", authors: (p.authors ?? []).map((a) => a.name), minutes: p.runtime_length_min ?? null }));
    },
    async summary(asin) {
      const d = (await get(`catalog/products/${encodeURIComponent(asin)}`, { response_groups: "product_desc,product_extended_attrs" })) as { product?: { publisher_summary?: string } };
      return summaryText(d.product?.publisher_summary ?? "") || null;
    },
  };
}

/** The named entities summaries use: markup's own, and typography's. */
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", mdash: "—", ndash: "–", hellip: "…" };

/** A summary as the catalog writes it, in HTML, as plain paragraphs. */
export function summaryText(html: string): string {
  return html
    .replace(/<\/p>\s*/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
      if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? whole;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The titles to ask the catalog by: the book's own, without a folder's
 * number ("01. Horus Rising"), then without what follows its first colon
 * ("Raven's Flight: The Horus Heresy Series").
 */
export function catalogTitles(title: string): string[] {
  const own = (parseNumbered(title.trim())?.name ?? title).trim();
  const short = own.split(/\s*:\s+/)[0]!.trim();
  return [...new Set([own, short].filter(Boolean))];
}

/** How far a recording's length may be from the catalog's and still be the same one: 3%, and never less than three minutes. */
function sameLength(bookMinutes: number, catalogMinutes: number): boolean {
  return Math.abs(bookMinutes - catalogMinutes) <= Math.max(3, bookMinutes * 0.03);
}

/** A name compared loosely: letters only, lower case. */
const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}]+/gu, " ").trim();

/**
 * The catalog's recording of this book: by one of its authors (by surname)
 * and as long as it, the closest in length when several are. Null when none
 * is.
 */
export function matchProduct(book: { author: string; durationMs: number }, products: readonly CatalogProduct[]): CatalogProduct | null {
  const surnames = book.author
    .split(/\s*(?:,|&|;|\band\b)\s*/i)
    .map((a) => plain(a).split(" ").at(-1) ?? "")
    .filter((s) => s.length > 1);
  const minutes = book.durationMs / 60_000;
  const fits = products.filter((p) => p.minutes !== null && sameLength(minutes, p.minutes) && p.authors.some((a) => surnames.some((s) => plain(a).split(" ").includes(s))));
  fits.sort((a, b) => Math.abs(a.minutes! - minutes) - Math.abs(b.minutes! - minutes));
  return fits[0] ?? null;
}

/** What a book is asked about by: once asked, it isn't asked again until its title, author or length changes. */
function askedBy(book: StoredBook["book"]): string {
  return `${book.title}|${book.author}|${Math.round(book.durationMs / 60_000)}`;
}

/**
 * The books with no description, not asked about as they are now. A book
 * with an EPUB waits until the server has looked in it (hydrate.ts), so its
 * own description comes first.
 */
export async function booksToDescribe(dataDir: string, index: BookIndex): Promise<string[]> {
  const out: string[] = [];
  for (const b of index.list()) {
    const stored = await readStored(dataDir, b.id);
    if (!stored || stored.book.description?.trim() || stored.described?.asked === askedBy(stored.book)) continue;
    if (stored.book.ebook && stored.filled?.from !== (await hydrateStamp(bookDir(dataDir, b.id), stored))) continue;
    out.push(b.id);
  }
  return out;
}

/** How describing the books is going. */
export interface DescribeProgress {
  books: number;
  done: number;
  described: number;
  current: string | null;
}

/** Ask the catalog for this many books in a row unreachable, and it's taken to be out of reach until the next run. */
const GIVE_UP_AFTER = 3;

/**
 * Describe each book from the catalog, one at a time, a moment apart. A
 * book the catalog has no recording of is noted as asked; one it couldn't
 * be asked about (out of reach) isn't, so it's asked next time.
 */
export async function describeBooks(catalog: Catalog, dataDir: string, ids: readonly string[], report: (p: DescribeProgress) => void, pause = () => new Promise<void>((r) => setTimeout(r, 1_000))): Promise<DescribeProgress> {
  const progress: DescribeProgress = { books: ids.length, done: 0, described: 0, current: null };
  let unreachable = 0;
  for (const id of ids) {
    if (unreachable >= GIVE_UP_AFTER) break;
    const stored = await readStored(dataDir, id);
    if (stored && !stored.book.description?.trim()) {
      progress.current = stored.book.title;
      report(progress);
      try {
        const description = await describe(catalog, stored.book);
        unreachable = 0;
        // Read again just before writing: other work writes the record too.
        const now = await readStored(dataDir, id);
        if (now && !now.book.description?.trim()) {
          const asked = { asked: askedBy(now.book), asin: description?.asin ?? null };
          await writeStored(dataDir, id, { ...now, book: description ? { ...now.book, description: description.text } : now.book, described: asked });
          if (description) progress.described++;
        }
      } catch {
        unreachable++;
      }
      await pause();
    }
    progress.done++;
    report(progress);
  }
  progress.current = null;
  return progress;
}

/** A book's description from the catalog, and the recording it's from; null when the catalog has no recording of it with one. */
async function describe(catalog: Catalog, book: StoredBook["book"]): Promise<{ text: string; asin: string } | null> {
  for (const title of catalogTitles(book.title)) {
    const product = matchProduct(book, await catalog.search(title, book.author));
    if (!product) continue;
    const text = await catalog.summary(product.asin);
    return text ? { text, asin: product.asin } : null;
  }
  return null;
}
