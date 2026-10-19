import { alike, words } from "./openings";
import type { Anchor, WordAt } from "./anchors";

/**
 * Level 2 of read-along (#57): a stretch of the narration, transcribed on
 * this machine phrase by phrase, matched word by word to the text where
 * the pairing expects it. Each phrase that matches well becomes a
 * checkpoint, a few seconds apart, so a sentence maps to the moment it is
 * read. Pure.
 */

/** A phrase heard, with when it is said, in milliseconds of the book. */
export interface Said {
  startMs: number;
  endMs: number;
  words: string;
}

export interface TranscriptMatch {
  anchors: Anchor[];
  /** Heard words found in the text, and all heard words: how well the stretch matched. */
  matched: number;
  heard: number;
}

const MATCH = 2;
const MISS = -1;
const GAP = -1;
/** Below this share of its words found, a stretch is not the text it was thought to be (credits, a wrong guess). */
const ENOUGH = 0.35;

/** The same word, as heard: alike, checked only for words that could be (the same first letter, about as long), which keeps the search fast. */
function same(a: string, b: string): boolean {
  return a === b || (a[0] === b[0] && Math.abs(a.length - b.length) <= 2 && alike(a, b));
}

/** The first word at or after a character, by binary search. */
function firstAt(index: readonly WordAt[], chars: number): number {
  let lo = 0;
  let hi = index.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (index[mid]!.at < chars) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Match a transcribed stretch to the text between two characters of the
 * reading order: the best local alignment of the heard words with the
 * text's (a narrator skips a heading, whisper mishears a name), then a
 * checkpoint at each phrase whose opening words were found.
 */
export function matchTranscript(index: readonly WordAt[], said: readonly Said[], from: number, to: number): TranscriptMatch {
  const heard: { w: string; phrase: number; k: number }[] = [];
  said.forEach((s, phrase) => words(s.words).forEach((w, k) => heard.push({ w, phrase, k })));
  const lo = firstAt(index, from);
  const hi = Math.max(lo, firstAt(index, to));
  const text = index.slice(lo, hi);
  const n = heard.length;
  const m = text.length;
  if (n === 0 || m === 0) return { anchors: [], matched: 0, heard: n };

  // Smith–Waterman: scores a row at a time, the way back kept for every cell.
  const way = new Uint8Array((n + 1) * (m + 1)); // 1 diagonal, 2 up (a heard word not in the text), 3 left (a text word not heard)
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  let best = 0;
  let bi = 0;
  let bj = 0;
  for (let i = 1; i <= n; i++) {
    cur[0] = 0;
    const hw = heard[i - 1]!.w;
    for (let j = 1; j <= m; j++) {
      const d = prev[j - 1]! + (same(hw, text[j - 1]!.w) ? MATCH : MISS);
      const u = prev[j]! + GAP;
      const l = cur[j - 1]! + GAP;
      let v = 0;
      let w = 0;
      if (d > v) (v = d), (w = 1);
      if (u > v) (v = u), (w = 2);
      if (l > v) (v = l), (w = 3);
      cur[j] = v;
      way[i * (m + 1) + j] = w;
      if (v > best) (best = v), (bi = i), (bj = j);
    }
    [prev, cur] = [cur, prev];
  }

  // Back from the best cell: which text word each heard word is.
  const at = new Int32Array(n).fill(-1);
  let matched = 0;
  for (let i = bi, j = bj; i > 0 && j > 0; ) {
    const w = way[i * (m + 1) + j];
    if (w === 1) {
      if (same(heard[i - 1]!.w, text[j - 1]!.w)) {
        at[i - 1] = j - 1;
        matched++;
      }
      i--;
      j--;
    } else if (w === 2) i--;
    else if (w === 3) j--;
    else break;
  }
  if (matched < Math.max(3, n * ENOUGH)) return { anchors: [], matched, heard: n };

  // A checkpoint where each phrase begins, when one of its first three words was found.
  const anchors: Anchor[] = [];
  let i = 0;
  for (let p = 0; p < said.length; p++) {
    const start = i;
    while (i < n && heard[i]!.phrase === p) i++;
    const count = i - start;
    for (let k = 0; k < Math.min(3, count); k++) {
      const j = at[start + k]!;
      if (j < 0) continue;
      const s = said[p]!;
      // A later word of the phrase: its time by its share of the phrase.
      const ms = Math.round(s.startMs + ((s.endMs - s.startMs) * k) / Math.max(1, count));
      anchors.push({ ms, chars: text[j]!.at });
      break;
    }
  }
  return { anchors, matched, heard: n };
}
