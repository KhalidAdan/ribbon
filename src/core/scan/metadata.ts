import type { ProbeResult } from "./probe";
import { folderMarks, splitList, type SideMeta } from "./sidefiles";

export interface ResolvedMetadata {
  title: string;
  rawTitle: string;
  author: string;
  narrator: string;
  series: string;
  seriesIndex: number | null;
  year: number | null;
  subtitle?: string;
  genres?: string[];
  publisher?: string;
  description?: string;
  language?: string;
  isbn?: string;
  asin?: string;
}

export interface FileOrderKeys {
  disc: number;
  track: number;
}

/** "3/22" is 3. "0", "", and junk are 0. */
export function parseTrack(value: string | undefined): number {
  if (!value) return 0;
  const m = value.trim().match(/^(\d+)/);
  return m ? Number(m[1]) : 0;
}

export function orderKeys(tags: Record<string, string>): FileOrderKeys {
  const disc = parseTrack(tags.disc ?? tags.discnumber ?? tags.disk);
  const track = parseTrack(tags.track ?? tags.tracknumber);
  return { disc: disc <= 0 ? 1 : disc, track };
}

const UNABRIDGED = /\s*[([]\s*unabridged\s*[)\]]\s*$/i;

/** "Legion (Unabridged)" is "Legion". A title that is only the note stays as it was. */
export function stripUnabridged(title: string): string {
  return title.replace(UNABRIDGED, "").trim() || title;
}
/** "07. Legion", "07 - Legion", "7) Legion", "7.5_Legion": a curated order plus a name. */
const NUMBERED = /^\s*(\d+(?:\.\d+)?)(?:(\s*[.\-_)]+\s*)|(\s+))(.+?)\s*$/;

export interface NumberedName {
  index: number;
  name: string;
}

/**
 * Split a numbered folder name into its order and its title, or null.
 * A colon is never a separator ("2001: A Space Odyssey" is a title), and
 * a four-digit number followed only by a space reads as a year.
 */
export function parseNumbered(folderName: string): NumberedName | null {
  const m = folderName.match(NUMBERED);
  if (!m) return null;
  const digits = m[1]!;
  const explicitSeparator = m[2] !== undefined;
  const name = m[4] ?? "";
  if (!name || name.startsWith(":")) return null;
  if (!explicitSeparator && !digits.includes(".") && digits.length >= 4) return null;
  const index = Number(digits);
  if (!Number.isFinite(index)) return null;
  return { index, name };
}

function first(tags: Record<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    const v = tags[k];
    if (v && v.trim()) return v.trim();
  }
  return "";
}

/** The most common non-empty value across files, ties to the first seen. */
function mode(values: string[]): string {
  const counts = new Map<string, number>();
  let best = "";
  let bestCount = 0;
  for (const v of values) {
    if (!v) continue;
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

/**
 * Resolve a book's metadata from its files' tags and its folder.
 *
 * A numbered folder ("07. Legion") is a curated choice and wins: the
 * folder name is shown exactly as written, and its number becomes the
 * series order. Someone who numbered their folders by hand chose that
 * text; we do not tidy it. Otherwise the album tag wins, then the
 * folder, then the file. `parentFolderName` is the folder above the
 * book when that is not the library root, and it names the series when
 * the tags do not.
 */
export function resolveMetadata(probes: readonly ProbeResult[], folderName: string, fileTitleFallback: string, parentFolderName = ""): ResolvedMetadata {
  const tagSets = probes.map((p) => p.tags);
  // "{Narrator}", "[ASIN]" and a leading year are marks, not the name.
  const marks = folderMarks(folderName);
  const folder = folderName ? marks.name : "";
  const numbered = parseNumbered(folder);
  const albumTitle = mode(tagSets.map((t) => first(t, "album"))) || (probes.length === 1 ? first(tagSets[0]!, "title") : "");
  const rawTitle = numbered ? folder.trim() : albumTitle || folder || fileTitleFallback;
  const author = mode(tagSets.map((t) => first(t, "artist", "album_artist", "albumartist", "author")));
  const narrator = mode(tagSets.map((t) => first(t, "composer", "narrator", "performer"))) || marks.narrator || "";
  const parent = parentFolderName ? (parseNumbered(parentFolderName)?.name ?? parentFolderName) : "";
  const series = mode(tagSets.map((t) => first(t, "series", "mvnm", "grouping", "show"))) || (numbered ? parent : "");
  const indexText = mode(tagSets.map((t) => first(t, "series-part", "series_part", "seriespart", "mvin", "part")));
  const seriesIndex = numbered ? numbered.index : indexText ? parseIndex(indexText) : null;
  const yearText = mode(tagSets.map((t) => first(t, "date", "year", "originaldate")));
  const yearMatch = yearText.match(/\d{4}/);
  const pick = (...keys: string[]) => mode(tagSets.map((t) => first(t, ...keys)));
  const out: ResolvedMetadata = {
    title: numbered ? rawTitle : stripUnabridged(rawTitle),
    rawTitle,
    author,
    narrator,
    series,
    seriesIndex,
    year: yearMatch ? Number(yearMatch[0]) : (marks.year ?? null),
  };
  const subtitle = pick("subtitle");
  if (subtitle && subtitle !== out.title) out.subtitle = subtitle;
  const genres = splitList(pick("genre"));
  if (genres.length > 0) out.genres = genres;
  const publisher = pick("publisher", "label", "organization");
  if (publisher) out.publisher = publisher;
  const language = pick("language", "lang");
  if (language) out.language = language;
  const isbn = pick("isbn").replace(/[^0-9xX]/g, "");
  if (isbn.length === 10 || isbn.length === 13) out.isbn = isbn;
  const asin = pick("asin", "audible_asin", "audible asin") || marks.asin || "";
  if (asin) out.asin = asin.trim();
  const description = describe(tagSets);
  if (description) out.description = description;
  return out;
}

/** Words that open a comment written by a tool, not about the book. */
const TOOL_COMMENT = /^(encoded|ripped|downloaded|converted|created|amazon|itunes|purchased|audible\.com|https?:|www\.)/i;

/**
 * The longest description any file carries: the long description atom,
 * then a description, then a synopsis; a comment only when it reads
 * like prose about the book.
 */
function describe(tagSets: readonly Record<string, string>[]): string {
  let best = "";
  for (const t of tagSets) {
    for (const k of ["ldes", "description", "desc", "synopsis"]) {
      const v = (t[k] ?? "").trim();
      if (v.length > best.length) best = v;
    }
  }
  if (best) return best;
  for (const t of tagSets) {
    const v = (t.comment ?? "").trim();
    if (v.length >= 60 && /\s/.test(v) && !TOOL_COMMENT.test(v) && v.length > best.length) best = v;
  }
  return best;
}

/**
 * What the side files say goes over what the tags say: someone wrote
 * them on purpose. A numbered folder keeps its name and its number,
 * because that was on purpose too.
 */
export function withSideFiles(meta: ResolvedMetadata, side: SideMeta, numberedFolder: boolean): ResolvedMetadata {
  const out = { ...meta };
  if (side.title && !numberedFolder) {
    out.title = side.title;
    out.rawTitle = side.title;
  }
  if (side.subtitle) out.subtitle = side.subtitle;
  if (side.authors && side.authors.length > 0) out.author = side.authors.join(", ");
  if (side.narrators && side.narrators.length > 0) out.narrator = side.narrators.join(", ");
  if (side.series) out.series = side.series;
  if (side.seriesIndex !== undefined && !numberedFolder) out.seriesIndex = side.seriesIndex;
  if (side.year) out.year = side.year;
  if (side.description) out.description = side.description;
  if (side.publisher) out.publisher = side.publisher;
  if (side.language) out.language = side.language;
  if (side.genres && side.genres.length > 0) out.genres = side.genres;
  if (side.isbn) out.isbn = side.isbn;
  if (side.asin) out.asin = side.asin;
  return out;
}

function parseIndex(text: string): number | null {
  const m = text.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}
