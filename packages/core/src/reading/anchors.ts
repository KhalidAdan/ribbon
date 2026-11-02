import type { BookText } from "./booktext";
import { openingMatch, SAME, words } from "./openings";

/**
 * Checkpoints inside chapters (#55's precision): a moment of the
 * recording heard on this machine and found in the text, so a place maps
 * between the two by the nearest checkpoints rather than by the chapter's
 * proportion alone. Chapter and proportion was measured on Voidscarred at
 * a median of 15 s off and 52 s at worst; a checkpoint every minute and a
 * half bounds the drift to what a narrator's pace can do in that time.
 */

export interface Anchor {
  ms: number;
  /** Characters of the reading order at which the heard words begin. */
  chars: number;
}

export interface WordAt {
  w: string;
  at: number;
}

/** Every word of the reading order, as matching compares them, with the character it starts at. */
export function wordIndex(book: BookText): WordAt[] {
  const out: WordAt[] = [];
  let base = 0;
  for (const [i, s] of book.ebook.sections.entries()) {
    if (!s.linear) continue;
    for (let b = 0; b < s.blocks.length; b++) {
      const t = book.blockText(i, b);
      for (const m of t.matchAll(/[\p{L}\p{N}’']+/gu)) {
        const w = words(m[0])[0];
        if (w) out.push({ w, at: base + m.index! });
      }
      base += t.length;
    }
  }
  return out;
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
 * Where heard words begin in the text, searched within `radius`
 * characters of an estimate: the window whose words match best, when it
 * matches well enough to be the same passage. Null when they are not
 * found, or found equally well in two places.
 */
export function locate(index: readonly WordAt[], heard: string, estimate: number, radius: number): { chars: number; score: number } | null {
  if (words(heard).length < 5) return null;
  const from = firstAt(index, estimate - radius);
  const to = firstAt(index, estimate + radius);
  let best = { chars: -1, score: 0 };
  let second = 0;
  for (let i = from; i < to; i++) {
    const window = index
      .slice(i, i + 45)
      .map((x) => x.w)
      .join(" ");
    const score = openingMatch(heard, window);
    const near = best.chars >= 0 && Math.abs(index[i]!.at - best.chars) <= 200;
    if (score > best.score) {
      // A neighbour of the best is the same place, not a rival.
      if (best.chars >= 0 && !near) second = Math.max(second, best.score);
      best = { chars: index[i]!.at, score };
    } else if (score === best.score && near) {
      // Windows starting a few words early hold every heard word too: the place is where the plateau ends.
      best = { chars: index[i]!.at, score };
    } else if (!near) second = Math.max(second, score);
  }
  if (best.score < SAME || second >= best.score - 0.1) return null;
  return best;
}
