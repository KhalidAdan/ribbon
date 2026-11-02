/**
 * The narrator's opening words matched against the text (#65). Whisper
 * spells names its own way ("Eloadri" for "Eluadhri") and writes numbers
 * as digits, so words are compared loosely: by their first letters, with
 * small spelling differences allowed, and numbers as numbers.
 */

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20",
};

/** The commonest English words, left out of matching. */
const COMMON = new Set(["the", "a", "an", "of", "to", "and", "in", "on", "at", "by", "for", "with", "from", "as", "it", "its", "is", "was", "were", "be", "been", "had", "has", "have", "that", "this", "but", "or", "so", "not", "he", "she", "his", "her", "they", "their", "we", "you", "i"]);

/** Words, lower case, letters and digits only, numbers as digits. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’']/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => NUMBER_WORDS[w] ?? w);
}

/** One row of the edit distance, reused: words are short, and this runs millions of times when a book is paired. */
const row = new Int32Array(64);

/** Edit distance, for words of a few letters; any answer above `most` is `most + 1`, found as soon as it is sure. */
function distance(a: string, b: string, most: number): number {
  if (a === b) return 0;
  if (b.length >= row.length) return most + 1;
  for (let j = 0; j <= b.length; j++) row[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0]!;
    row[0] = i;
    let least = i;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j]!;
      const v = Math.min(up + 1, row[j - 1]! + 1, diag + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1));
      row[j] = v;
      if (v < least) least = v;
      diag = up;
    }
    if (least > most) return most + 1;
  }
  return row[b.length]!;
}

/** The same word as heard: equal, or a name spelled another way (a letter or two off in five). */
export function alike(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  const most = Math.max(1, Math.floor(Math.max(a.length, b.length) / 5));
  // Words further apart in length than that are never alike.
  if (Math.abs(a.length - b.length) > most) return false;
  return distance(a, b, most) <= most;
}

/** Matches already made: pairing asks for the same opening against the same text again and again (#79). */
const matched = new Map<string, number>();

/**
 * How well heard words match the start of a text, 0 to 1: the share of
 * the heard words found in order (a longest common subsequence) among the
 * text's opening words. A narrator may skip a heading or say one the text
 * does not have, so the text's window is a little longer than what was heard.
 */
export function openingMatch(heard: string, text: string): number {
  const key = heard + "\u0000" + text;
  const known = matched.get(key);
  if (known !== undefined) return known;
  const m = matchOpening(heard, text);
  if (matched.size > 50_000) matched.clear();
  matched.set(key, m);
  return m;
}

/** A text's words less the commonest, kept: the same openings come back for every pair. */
const kept = new Map<string, string[]>();
function meaningful(text: string): string[] {
  let w = kept.get(text);
  if (!w) {
    w = words(text).filter((x) => !COMMON.has(x));
    if (kept.size > 10_000) kept.clear();
    kept.set(text, w);
  }
  return w;
}

function matchOpening(heard: string, text: string): number {
  // Words every passage shares say nothing about which passage it is.
  const h = meaningful(heard).slice(0, 24);
  if (h.length < 3) return 0;
  const t = meaningful(text).slice(0, h.length + 10);
  const dp = Array.from({ length: h.length + 1 }, () => new Array<number>(t.length + 1).fill(0));
  for (let i = 1; i <= h.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      dp[i]![j] = alike(h[i - 1]!, t[j - 1]!) ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return dp[h.length]![t.length]! / h.length;
}

/** A match this good is the same passage. */
export const SAME = 0.6;
/** Below this, with enough words heard, it is another passage. */
export const OTHER = 0.2;
