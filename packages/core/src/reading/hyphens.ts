/**
 * Hyphenation without moving the text (docs/READING.md, section 8). Soft
 * hyphens are put into a paragraph's runs only for pretext to break at;
 * every offset Ribbon keeps is into the model's text, so a range pretext
 * gives in the hyphenated text is mapped back before anything sees it.
 *
 * A run's added hyphens are a sorted list of offsets into the run's own
 * text: a soft hyphen goes before the character at each.
 */

export const SOFT_HYPHEN = "\u00AD";

/** Where a word may break: offsets inside it, in UTF-16 units, from Liang's patterns for a language. */
export type WordBreaks = (word: string) => number[];

/** Letters a word needs before it is hyphenated, and on each side of a break. */
export const MIN_WORD = 6;
export const MIN_BEFORE = 2;
export const MIN_AFTER = 3;

const LETTER = /\p{L}/u;
const MARK = /\p{M}/u;
// A word, with what would stop it being hyphenated: digits, and the publisher's own soft hyphens.
const WORD = /[\p{L}\p{M}\p{N}\u00AD]+/gu;
// Text between spaces that is an address, whose words are not words: a URL, an email, a path.
const ADDRESS = /:\/\/|^\W*www\.|\S@\S|\//u;

/** A run's text with its added soft hyphens. */
export function insertHyphens(text: string, at: readonly number[]): string {
  if (at.length === 0) return text;
  let out = "";
  let from = 0;
  for (const p of at) {
    out += text.slice(from, p) + SOFT_HYPHEN;
    from = p;
  }
  return out + text.slice(from);
}

/** An offset into a run's hyphenated text, as an offset into its own: an added soft hyphen takes no room. */
export function toModel(at: readonly number[], x: number): number {
  // The k-th added hyphen sits at at[k] + k in the hyphenated text; count those before x.
  let lo = 0;
  let hi = at.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at[mid]! + mid < x) lo = mid + 1;
    else hi = mid;
  }
  return x - lo;
}

/** An offset into a run's own text, as an offset into its hyphenated text, before any hyphen added there. */
export function toHyphenated(at: readonly number[], offset: number): number {
  let lo = 0;
  let hi = at.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at[mid]! < offset) lo = mid + 1;
    else hi = mid;
  }
  return offset + lo;
}

function letters(s: string): number {
  let n = 0;
  for (const ch of s) if (LETTER.test(ch)) n++;
  return n;
}

/** Whether a word is left whole: too short, with digits, all capitals, or already hyphenated by the publisher. */
function keepWhole(word: string): boolean {
  if (word.includes(SOFT_HYPHEN) || /\p{N}/u.test(word)) return true;
  if (letters(word) < MIN_WORD) return true;
  return word === word.toLocaleUpperCase() && word !== word.toLocaleLowerCase();
}

/** Where one word may break, with Ribbon's rules on top of the patterns'. */
export function wordBreaks(word: string, breaks: WordBreaks): number[] {
  if (keepWhole(word)) return [];
  const out: number[] = [];
  for (const p of breaks(word)) {
    if (p <= 0 || p >= word.length) continue;
    // Never inside a surrogate pair, or between a letter and its accent.
    const c = word.charCodeAt(p);
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    if (MARK.test(word[p]!)) continue;
    if (letters(word.slice(0, p)) < MIN_BEFORE || letters(word.slice(p)) < MIN_AFTER) continue;
    out.push(p);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Where to add soft hyphens to a paragraph's runs: for each run, offsets
 * into its text. Words are found in the paragraph's whole text, so a word
 * whose letters are styled in parts is still one word; a break where two
 * runs meet goes at the end of the first.
 */
export function hyphenateRuns(texts: readonly string[], breaks: WordBreaks): number[][] {
  const whole = texts.join("");
  const found: number[] = [];
  for (const chunk of whole.matchAll(/\S+/g)) {
    if (ADDRESS.test(chunk[0])) continue;
    for (const w of chunk[0].matchAll(WORD)) {
      const start = chunk.index + w.index;
      for (const p of wordBreaks(w[0], breaks)) found.push(start + p);
    }
  }
  const out: number[][] = texts.map(() => []);
  let run = 0;
  let runStart = 0;
  for (const g of found) {
    while (run < texts.length - 1 && g > runStart + texts[run]!.length) {
      runStart += texts[run]!.length;
      run++;
    }
    out[run]!.push(g - runStart);
  }
  return out;
}
