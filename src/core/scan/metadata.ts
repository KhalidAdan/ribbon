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

export function resolveMetadata(probes: readonly ProbeResult[], folderName: string, fileTitleFallback: string): ResolvedMetadata {
  const tagSets = probes.map((p) => p.tags);
  const rawTitle = mode(tagSets.map((t) => first(t, "album"))) || (probes.length === 1 ? first(tagSets[0]!, "title") : "") || folderName || fileTitleFallback;
  const author = mode(tagSets.map((t) => first(t, "artist", "album_artist", "albumartist", "author")));
  const narrator = mode(tagSets.map((t) => first(t, "composer", "narrator", "performer")));
  const series = mode(tagSets.map((t) => first(t, "series", "mvnm", "grouping", "show")));
  const indexText = mode(tagSets.map((t) => first(t, "series-part", "series_part", "seriespart", "mvin", "part")));
  const seriesIndex = indexText ? parseIndex(indexText) : null;
  const yearText = mode(tagSets.map((t) => first(t, "date", "year", "originaldate")));
  const yearMatch = yearText.match(/\d{4}/);
  return {
    title: rawTitle.replace(UNABRIDGED, "").trim() || rawTitle,
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
