import { bytesToRows, int, bool, rowsToBytes } from "../csv";
import { splitPeople } from "./sidefiles";

/**
 * What a scan reads of an EPUB: its package's metadata, no chapters
 * (docs/READING.md, section 2). Rust reads it, once per file; it is kept
 * in `.ribbon/ebooks.csv` so an unchanged EPUB is not opened again.
 */
export interface EbookPackage {
  /** Library-relative, forward slashes. */
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  title: string;
  authors: string[];
  /** ISBNs among the package's identifiers, as Rust wrote them (digits, an X last). */
  isbns: string[];
  language: string;
  publisher: string;
  date: string;
  description: string;
  /** The package names a cover image. */
  hasCover: boolean;
}

export const EBOOK_HEADERS = ["path", "size_bytes", "mtime_ms", "title", "authors", "isbn", "language", "publisher", "date", "description", "has_cover"];

/** A package from the tags the scanner sent: authors by semicolons, ISBNs by spaces. */
export function packageFromTags(file: { path: string; sizeBytes: number; mtimeMs: number }, tags: Record<string, string>, hasCover: boolean): EbookPackage {
  return {
    path: file.path,
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    title: tags.title ?? "",
    authors: (tags.author ?? "").split(/\s*;\s*/).filter(Boolean),
    isbns: (tags.isbn ?? "").split(/\s+/).filter(Boolean),
    language: tags.language ?? "",
    publisher: tags.publisher ?? "",
    date: tags.date ?? "",
    description: tags.description ?? "",
    hasCover,
  };
}

export function ebooksToBytes(list: readonly EbookPackage[]): Promise<Uint8Array> {
  return rowsToBytes(
    list.map((e) => ({
      path: e.path,
      size_bytes: String(e.sizeBytes),
      mtime_ms: String(e.mtimeMs),
      title: e.title,
      authors: e.authors.join("; "),
      isbn: e.isbns.join(" "),
      language: e.language,
      publisher: e.publisher,
      date: e.date,
      description: e.description,
      has_cover: e.hasCover ? "1" : "0",
    })),
    EBOOK_HEADERS,
  );
}

export async function bytesToEbooks(bytes: Uint8Array): Promise<Map<string, EbookPackage>> {
  const { rows } = await bytesToRows(bytes);
  const out = new Map<string, EbookPackage>();
  for (const r of rows) {
    if (!r.path) continue;
    out.set(r.path, packageFromTags({ path: r.path, sizeBytes: int(r.size_bytes), mtimeMs: int(r.mtime_ms) }, { title: r.title ?? "", author: r.authors ?? "", isbn: r.isbn ?? "", language: r.language ?? "", publisher: r.publisher ?? "", date: r.date ?? "", description: r.description ?? "" }, bool(r.has_cover)));
  }
  return out;
}

/** An ISBN-10 or ISBN-13 as ISBN-13, so the two forms of one number agree; null when it is not one. */
export function isbn13(raw: string): string | null {
  const d = raw.replace(/^(urn:)?isbn:?/i, "").replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{13}$/.test(d)) {
    const sum = [...d].reduce((s, c, i) => s + Number(c) * (i % 2 === 0 ? 1 : 3), 0);
    return sum % 10 === 0 ? d : null;
  }
  if (/^\d{9}[\dX]$/.test(d)) {
    const sum = [...d].reduce((s, c, i) => s + (10 - i) * (c === "X" ? 10 : Number(c)), 0);
    if (sum % 11 !== 0) return null;
    const body = `978${d.slice(0, 9)}`;
    const check = (10 - ([...body].reduce((s, c, i) => s + Number(c) * (i % 2 === 0 ? 1 : 3), 0) % 10)) % 10;
    return body + check;
  }
  return null;
}

/** Every ISBN in a tag's value, which may hold several. */
function isbnsIn(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,;/|]+|\s{2,}|\s+(?=\d{3}[\d-]{7,})/)
    .map(isbn13)
    .filter((x): x is string => !!x);
}

/** Letters and digits only, lower case, accents gone. */
function squash(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * The forms a title is compared in: whole, and either side of a colon
 * ("The Horus Heresy: Horus Rising" agrees with "Horus Rising"), with
 * anything in brackets and a leading article left out.
 */
export function titleKeys(title: string): string[] {
  const plain = title.replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
  const forms = [plain, ...(plain.includes(":") ? plain.split(":") : [])];
  return [...new Set(forms.map((f) => squash(f.trim().replace(/^(the|a|an)\s+/i, ""))).filter(Boolean))];
}

/** The forms each author is compared in: "Dan Abnett", "Abnett, Dan" and "D. Abnett" do not all agree, but the first two do. */
export function authorKeys(authors: string | readonly string[]): string[] {
  const people = (typeof authors === "string" ? [authors] : authors).flatMap((a) => splitPeople(a));
  const keys = new Set<string>();
  for (const p of people) {
    keys.add(squash(p));
    const parts = p.split(/\s*,\s*/);
    if (parts.length === 2 && parts[0] && parts[1]) keys.add(squash(`${parts[1]} ${parts[0]}`));
  }
  keys.delete("");
  return [...keys];
}

/** What metadata pairing knows of an audiobook. */
export interface Pairable {
  title: string;
  rawTitle?: string;
  author: string;
  isbn?: string;
}

/**
 * Pair EPUBs with audiobooks elsewhere in the library by what their
 * metadata says: first by an ISBN in the audiobook's tags that is one of
 * the EPUB's identifiers, then by title and author together. A pair is
 * taken only when it is the only one both ways: an EPUB that agrees with
 * two audiobooks, or an audiobook two EPUBs agree with, pairs with
 * nothing. Returns, for each EPUB that pairs, the audiobook's index.
 */
export function pairByMetadata(audiobooks: readonly Pairable[], ebooks: readonly Pick<EbookPackage, "title" | "authors" | "isbns">[]): Map<number, number> {
  const pairs = new Map<number, number>();
  const taken = new Set<number>();
  const pass = (agree: (e: number, a: number) => boolean) => {
    const open = ebooks.map((_, e) => e).filter((e) => !pairs.has(e));
    const free = audiobooks.map((_, a) => a).filter((a) => !taken.has(a));
    const candidates = new Map(open.map((e) => [e, free.filter((a) => agree(e, a))]));
    for (const [e, list] of candidates) {
      if (list.length !== 1) continue;
      const a = list[0]!;
      const rivals = open.filter((o) => o !== e && candidates.get(o)!.includes(a));
      if (rivals.length > 0) continue;
      pairs.set(e, a);
      taken.add(a);
    }
  };
  const audioIsbns = audiobooks.map((b) => new Set(isbnsIn(b.isbn)));
  const ebookIsbns = ebooks.map((e) => e.isbns.map(isbn13).filter((x): x is string => !!x));
  pass((e, a) => ebookIsbns[e]!.some((i) => audioIsbns[a]!.has(i)));
  const audioTitles = audiobooks.map((b) => new Set([...titleKeys(b.title), ...titleKeys(b.rawTitle ?? "")]));
  const audioAuthors = audiobooks.map((b) => new Set(authorKeys(b.author)));
  const ebookTitles = ebooks.map((e) => titleKeys(e.title));
  const ebookAuthors = ebooks.map((e) => authorKeys(e.authors));
  pass((e, a) => ebookTitles[e]!.some((t) => audioTitles[a]!.has(t)) && ebookAuthors[e]!.some((k) => audioAuthors[a]!.has(k)));
  return pairs;
}
