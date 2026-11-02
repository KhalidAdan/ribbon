/**
 * The small files people keep beside their audiobooks, and the marks
 * they put in folder names. Audiobookshelf, Calibre and hand-kept
 * libraries all use some of these:
 *
 *   metadata.opf   Dublin Core: title, authors, narrators, series, the
 *                  description, publisher, language, ISBN and ASIN.
 *   desc.txt       The description, as plain text.
 *   reader.txt     The narrator, as plain text.
 *   Folder names   "{Narrator}", "[ASIN]", a leading "1999 - " year.
 *
 * Everything here is pure: text in, fields out.
 */

export interface SideMeta {
  title?: string;
  subtitle?: string;
  authors?: string[];
  narrators?: string[];
  series?: string;
  seriesIndex?: number;
  description?: string;
  publisher?: string;
  language?: string;
  genres?: string[];
  isbn?: string;
  asin?: string;
  year?: number;
}

/** The names Ribbon reads beside a book. */
export function isSideFileName(name: string): boolean {
  const n = name.toLowerCase();
  return n === "desc.txt" || n === "description.txt" || n === "reader.txt" || n.endsWith(".opf");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Undo XML escapes and strip any markup left inside a value (descriptions often carry HTML). */
export function xmlText(s: string): string {
  const once = unmark(s);
  // HTML escaped inside XML (an OPF description, often) comes out as markup the first time.
  return /<\/?[a-z][^>]*>|&(#x?[0-9a-f]+|[a-z]+);/i.test(once) ? unmark(once) : once;
}

function unmark(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  text: string;
}

/** Every element with a local name in `names` (any namespace prefix), with attributes and inner text. */
function elements(xml: string, names: string[]): XmlElement[] {
  const out: XmlElement[] = [];
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const lower = xml.toLowerCase();
  // Opening tags only, so a container like <metadata> never swallows what is inside it.
  const open = /<([\w.-]+:)?([\w.-]+)(\s[^>]*?)?(\/?)>/g;
  for (const m of xml.matchAll(open)) {
    const local = m[2]!.toLowerCase();
    if (!wanted.has(local)) continue;
    const attrs: Record<string, string> = {};
    for (const a of (m[3] ?? "").matchAll(/([\w.:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const key = a[1]!.toLowerCase().replace(/^.*:/, "");
      attrs[key] = xmlText(a[3] ?? a[4] ?? "");
    }
    let text = "";
    if (m[4] !== "/") {
      const start = m.index + m[0].length;
      const close = lower.indexOf(`</${(m[1] ?? "").toLowerCase()}${local}`, start);
      if (close >= 0) text = xmlText(xml.slice(start, close));
    }
    out.push({ name: local, attrs, text });
  }
  return out;
}

/** Read an OPF package document. Unknown or malformed parts are left out. */
export function parseOpf(xml: string): SideMeta {
  const meta: SideMeta = {};
  const els = elements(xml, ["title", "creator", "contributor", "description", "publisher", "language", "subject", "identifier", "date", "meta"]);
  // EPUB 3 refines a creator's role with <meta refines="#id" property="role">.
  const roles = new Map<string, string>();
  for (const e of els) if (e.name === "meta" && e.attrs.property === "role" && e.attrs.refines) roles.set(e.attrs.refines.replace(/^#/, ""), e.text.toLowerCase());
  const authors: string[] = [];
  const narrators: string[] = [];
  const genres: string[] = [];
  for (const e of els) {
    const v = e.text;
    switch (e.name) {
      case "title":
        if (v && e.attrs.type === "subtitle") meta.subtitle = v;
        else if (v && !meta.title) meta.title = v;
        break;
      case "creator":
      case "contributor": {
        if (!v) break;
        const role = (e.attrs.role ?? (e.attrs.id ? roles.get(e.attrs.id) : undefined) ?? (e.name === "creator" ? "aut" : "")).toLowerCase();
        if (role === "aut" || role === "author") authors.push(v);
        else if (role === "nrt" || role === "narrator" || role === "reader") narrators.push(v);
        break;
      }
      case "description":
        if (v && !meta.description) meta.description = v;
        break;
      case "publisher":
        if (v && !meta.publisher) meta.publisher = v;
        break;
      case "language":
        if (v && !meta.language) meta.language = v;
        break;
      case "subject":
        if (v) genres.push(...splitList(v));
        break;
      case "identifier": {
        const scheme = (e.attrs.scheme ?? e.attrs.id ?? "").toLowerCase();
        const value = v.replace(/^urn:(isbn|asin):/i, "");
        if ((scheme.includes("isbn") || /^urn:isbn:/i.test(v)) && !meta.isbn) meta.isbn = value.replace(/[^0-9xX]/g, "");
        else if ((scheme.includes("asin") || scheme.includes("audible") || /^urn:asin:/i.test(v)) && !meta.asin) meta.asin = value.trim();
        break;
      }
      case "date": {
        const y = v.match(/\d{4}/);
        if (y && !meta.year) meta.year = Number(y[0]);
        break;
      }
      case "meta": {
        // Calibre's series, and EPUB 3's collection.
        const name = (e.attrs.name ?? "").toLowerCase();
        if (name === "calibre:series" && e.attrs.content) meta.series = e.attrs.content;
        if (name === "calibre:series_index" && e.attrs.content) {
          const n = Number(e.attrs.content);
          if (Number.isFinite(n)) meta.seriesIndex = n;
        }
        if (e.attrs.property === "belongs-to-collection" && v && !meta.series) meta.series = v;
        if (e.attrs.property === "group-position" && v) {
          const n = Number(v);
          if (Number.isFinite(n)) meta.seriesIndex = n;
        }
        break;
      }
    }
  }
  if (authors.length > 0) meta.authors = unique(authors);
  if (narrators.length > 0) meta.narrators = unique(narrators);
  if (genres.length > 0) meta.genres = unique(genres);
  return meta;
}

/** Fold the side files of one book folder, by name, into one set of fields. */
export function readSideFiles(files: { name: string; text: string }[]): SideMeta {
  let meta: SideMeta = {};
  const byName = (pred: (n: string) => boolean) => files.find((f) => pred(f.name.toLowerCase()));
  const opf = byName((n) => n === "metadata.opf") ?? byName((n) => n.endsWith(".opf"));
  if (opf) meta = parseOpf(opf.text);
  const desc = byName((n) => n === "desc.txt" || n === "description.txt");
  if (desc) {
    const t = xmlText(desc.text);
    if (t) meta.description = t;
  }
  const reader = byName((n) => n === "reader.txt");
  if (reader) {
    const people = splitPeople(reader.text.trim());
    if (people.length > 0) meta.narrators = people;
  }
  return meta;
}

export interface FolderMarks {
  /** The folder name with the marks taken out. */
  name: string;
  narrator?: string;
  asin?: string;
  year?: number;
}

/**
 * "1999 - Dune {Scott Brick} [B002V1OF70]": the year, the narrator in
 * braces and the ASIN in brackets, and the name without them. A bracket
 * that is not an ASIN-shaped code is left alone; it is part of the title.
 */
export function folderMarks(folder: string): FolderMarks {
  let name = folder;
  const out: FolderMarks = { name };
  const narrator = name.match(/\{([^{}]+)\}/);
  if (narrator) {
    out.narrator = narrator[1]!.trim();
    name = name.replace(narrator[0], " ");
  }
  const asin = name.match(/\[\s*(B0[0-9A-Z]{8}|\d{9}[\dX])\s*\]/i);
  if (asin) {
    out.asin = asin[1]!.toUpperCase();
    name = name.replace(asin[0], " ");
  }
  const year = name.match(/^\s*((?:19|20)\d{2})\s+-\s+(.+)$/);
  if (year) {
    out.year = Number(year[1]);
    name = year[2]!;
  }
  out.name = name.replace(/\s{2,}/g, " ").replace(/\s+-\s*$/, "").trim() || folder.trim();
  return out;
}

/**
 * People in one field: "A; B", "A & B", "A and B", "A, B, C". A single
 * "Last, First" stays one person: a comma splits only when every piece
 * has a space in it, or there are three or more pieces.
 */
export function splitPeople(value: string): string[] {
  const v = value.trim();
  if (!v) return [];
  const bySemi = v.split(/\s*[;/]\s*|\s+&\s+|\s+and\s+/i).filter(Boolean);
  if (bySemi.length > 1) return unique(bySemi.flatMap((p) => splitPeople(p)));
  const byComma = v.split(/\s*,\s*/).filter(Boolean);
  if (byComma.length >= 3 || (byComma.length === 2 && byComma.every((p) => /\s/.test(p)))) return unique(byComma);
  return [v];
}

/** Genres and subjects: "Fantasy; Epic", "Science Fiction / Space Opera", "A, B". */
export function splitList(value: string): string[] {
  return unique(
    value
      .split(/\s*[;,/|]\s*/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function unique(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}
