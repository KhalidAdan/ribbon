import { bytesToRows, rowsToBytes } from "./csv";
import { fold } from "./search";

/**
 * What a book database said about a book, kept beside the books so the
 * question is asked once. `source: "none"` records a miss, so a book with
 * no match is not searched again every launch. Open Library is the
 * database: free, no key, and it answers with a work key, a title, the
 * authors and a description.
 */
export interface BookAbout {
  bookId: string;
  source: "openlibrary" | "none";
  /** Open Library work key, like `/works/OL123W`; empty for a miss. */
  key: string;
  /** The title the database used, for the settings page to show what matched. */
  title: string;
  description: string;
  /** ISO 8601. */
  fetchedAt: string;
}

export const ABOUT_HEADERS = ["book_id", "source", "key", "title", "description", "fetched_at"];
/** A miss is asked again after this long; a hit is kept. */
export const RETRY_MISS_AFTER_MS = 30 * 24 * 3_600_000;
/** Open Library asks for gentle use; one request a second is well inside it. */
export const REQUEST_GAP_MS = 1200;

export function aboutToBytes(list: readonly BookAbout[]): Promise<Uint8Array> {
  return rowsToBytes(
    list.map((a) => ({ book_id: a.bookId, source: a.source, key: a.key, title: a.title, description: a.description, fetched_at: a.fetchedAt })),
    ABOUT_HEADERS,
  );
}

export async function bytesToAbout(bytes: Uint8Array): Promise<BookAbout[]> {
  const { rows } = await bytesToRows(bytes);
  return rows
    .filter((r) => r.book_id)
    .map((r) => ({
      bookId: r.book_id!,
      source: r.source === "openlibrary" ? "openlibrary" : "none",
      key: r.key ?? "",
      title: r.title ?? "",
      description: r.description ?? "",
      fetchedAt: r.fetched_at ?? "",
    }));
}

/** Whether a book should be asked about now. */
export function needsLookup(about: BookAbout | undefined, nowMs = Date.now()): boolean {
  if (!about) return true;
  if (about.source === "openlibrary") return false;
  const at = Date.parse(about.fetchedAt);
  return !Number.isFinite(at) || nowMs - at > RETRY_MISS_AFTER_MS;
}

/**
 * The title as a database knows it: no leading folder number, no
 * "(Unabridged)", no trailing series note that rippers add.
 */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/^\s*\d+(?:\.\d+)?(?:\s*[.\-_)]+\s*|\s+)/, "")
    .replace(/\s*[([]\s*unabridged\s*[)\]]/gi, "")
    .replace(/\s*[:\-–—]\s*(the\s+)?[\w' ]*\bseries\b.*$/i, "")
    .replace(/\s*\(\d{4}\)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface WorkCandidate {
  key: string;
  title: string;
  authors: string[];
  firstYear: number | null;
}

/** Candidates out of Open Library's search response. Tolerates anything. */
export function parseSearch(json: unknown): WorkCandidate[] {
  const docs = (json as { docs?: unknown[] } | null)?.docs;
  if (!Array.isArray(docs)) return [];
  const out: WorkCandidate[] = [];
  for (const d of docs) {
    const doc = d as { key?: unknown; title?: unknown; author_name?: unknown; first_publish_year?: unknown };
    if (typeof doc.key !== "string" || typeof doc.title !== "string") continue;
    out.push({
      key: doc.key,
      title: doc.title,
      authors: Array.isArray(doc.author_name) ? doc.author_name.filter((a): a is string => typeof a === "string") : [],
      firstYear: typeof doc.first_publish_year === "number" ? doc.first_publish_year : null,
    });
  }
  return out;
}

/** The description out of a work record: a string, or `{ value }`, or nothing. */
export function parseWork(json: unknown): string {
  const d = (json as { description?: unknown } | null)?.description;
  const text = typeof d === "string" ? d : d && typeof (d as { value?: unknown }).value === "string" ? (d as { value: string }).value : "";
  // Open Library descriptions often end in a source line or markdown links; keep the prose.
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n-{3,}[\s\S]*$/, "")
    .trim();
}

function lastName(author: string): string {
  const parts = fold(author).replace(/[.,]/g, " ").split(" ").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * The candidate that is this book, or null. A wrong description is worse
 * than none, so the title must match after folding, allowing only a
 * subtitle after a colon, and when an author is known one of the
 * candidate's authors must share a surname.
 */
export function matchWork(candidates: readonly WorkCandidate[], title: string, author: string): WorkCandidate | null {
  const want = fold(cleanTitle(title));
  if (!want) return null;
  const surname = author ? lastName(author) : "";
  const exact = (have: string) => have === want || have.startsWith(want + ":") || want.startsWith(have + ":");
  // Database titles sometimes trail off into series notes ("The First
  // Heretic   Warhammer 40000 Novels"); a prefix is enough when the
  // author confirms it.
  const prefix = (have: string) => have.startsWith(want + " ");
  for (const c of candidates) {
    const have = fold(c.title);
    const byAuthor = surname !== "" && c.authors.some((a) => lastName(a) === surname);
    if (surname && !byAuthor) continue;
    if (exact(have) || (byAuthor && prefix(have))) return c;
  }
  return null;
}

const enc = encodeURIComponent;

export function searchUrl(title: string, author: string): string {
  const q = `title=${enc(cleanTitle(title))}${author ? `&author=${enc(author)}` : ""}`;
  return `https://openlibrary.org/search.json?${q}&limit=5&fields=key,title,author_name,first_publish_year`;
}

export function workUrl(key: string): string {
  return `https://openlibrary.org${key}.json`;
}
