import type { ProbeResult } from "./probe";

export interface ResolvedMetadata {
  title: string;
  rawTitle: string;
  author: string;
  narrator: string;
  series: string;
  seriesIndex: number | null;
  year: number | null;
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
  const numbered = parseNumbered(folderName);
  const albumTitle = mode(tagSets.map((t) => first(t, "album"))) || (probes.length === 1 ? first(tagSets[0]!, "title") : "");
  const rawTitle = numbered ? folderName.trim() : albumTitle || folderName || fileTitleFallback;
  const author = mode(tagSets.map((t) => first(t, "artist", "album_artist", "albumartist", "author")));
  const narrator = mode(tagSets.map((t) => first(t, "composer", "narrator", "performer")));
  const parent = parentFolderName ? (parseNumbered(parentFolderName)?.name ?? parentFolderName) : "";
  const series = mode(tagSets.map((t) => first(t, "series", "mvnm", "grouping", "show"))) || (numbered ? parent : "");
  const indexText = mode(tagSets.map((t) => first(t, "series-part", "series_part", "seriespart", "mvin", "part")));
  const seriesIndex = numbered ? numbered.index : indexText ? parseIndex(indexText) : null;
  const yearText = mode(tagSets.map((t) => first(t, "date", "year", "originaldate")));
  const yearMatch = yearText.match(/\d{4}/);
  return {
    title: numbered ? rawTitle : rawTitle.replace(UNABRIDGED, "").trim() || rawTitle,
    rawTitle,
    author,
    narrator,
    series,
    seriesIndex,
    year: yearMatch ? Number(yearMatch[0]) : null,
  };
}

function parseIndex(text: string): number | null {
  const m = text.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}
