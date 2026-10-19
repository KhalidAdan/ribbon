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

/** Edit distance, for words of a few letters. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

/** The same word as heard: equal, or a name spelled another way (a letter or two off in five). */
function alike(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  return distance(a, b) <= Math.max(1, Math.floor(Math.max(a.length, b.length) / 5));
}

/**
 * How well heard words match the start of a text, 0 to 1: the share of
 * the heard words found in order (a longest common subsequence) among the
 * text's opening words. A narrator may skip a heading or say one the text
 * does not have, so the text's window is a little longer than what was heard.
 */
export function openingMatch(heard: string, text: string): number {
  // Words every passage shares say nothing about which passage it is.
  const h = words(heard).filter((w) => !COMMON.has(w)).slice(0, 24);
  if (h.length < 3) return 0;
  const t = words(text).filter((w) => !COMMON.has(w)).slice(0, h.length + 10);
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
