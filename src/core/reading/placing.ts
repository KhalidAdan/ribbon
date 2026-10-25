import type { Anchor, WordAt } from "./anchors";
import { words } from "./openings";
import { matchTranscript, STRETCH_MS, STRETCH_SLACK, type PlacedPhrase, type Said } from "./transcript";

/**
 * A whole transcript placed in the text by what was said in it, wherever
 * that is in the book (#163). Phrases were found near where the chapters
 * were thought to be, which fails for minutes on end where the book and the
 * recording don't line up: a character list or a preview of another book the
 * narrator never reads, an audio chapter named "Chapter 29" for the book's
 * "Chapter Twenty-Eight". With the whole narration heard, there's no need to
 * guess: five words in a row that are in the book once are surely where they
 * were said, and the longest run of those that goes forward in both the text
 * and the recording is a backbone nothing can lead astray. The phrases are
 * then matched word by word around where the backbone puts them, as before,
 * so a misheard name still matches. Pure.
 */

/** Words in a row that, found once in the whole book, are surely where they were said. */
const RUN = 5;

/** Each word heard, in order, with when it was said: its own time, or else by its place in its phrase. */
function heardWords(said: readonly Said[]): { w: string; ms: number }[] {
  const out: { w: string; ms: number }[] = [];
  for (const s of said) {
    const tokens = s.words.split(/\s+/).filter(Boolean);
    const timed = s.wordMs?.length === tokens.length ? s.wordMs : null;
    tokens.forEach((token, t) => {
      const ms = timed ? timed[t]! : Math.round(s.startMs + ((s.endMs - s.startMs) * t) / Math.max(1, tokens.length));
      for (const w of words(token)) out.push({ w, ms });
    });
  }
  return out;
}

/**
 * The backbone: moments of the recording whose next five words are in the
 * book exactly once, as checkpoints, keeping the longest run of them that
 * goes forward in the text as it goes forward in time.
 */
export function backbone(index: readonly WordAt[], said: readonly Said[]): Anchor[] {
  // Every run of five words in the book, and where it is: -1 when it's there more than once.
  const once = new Map<string, number>();
  for (let j = 0; j + RUN <= index.length; j++) {
    let key = index[j]!.w;
    for (let k = 1; k < RUN; k++) key += " " + index[j + k]!.w;
    once.set(key, once.has(key) ? -1 : j);
  }
  const heard = heardWords(said);
  const found: { ms: number; j: number }[] = [];
  for (let i = 0; i + RUN <= heard.length; i++) {
    let key = heard[i]!.w;
    for (let k = 1; k < RUN; k++) key += " " + heard[i + k]!.w;
    const j = once.get(key);
    if (j !== undefined && j >= 0) found.push({ ms: heard[i]!.ms, j });
  }
  // The longest run going forward in the text, in the order it was heard (patience sorting).
  const tails: number[] = [];
  const before = new Int32Array(found.length).fill(-1);
  for (let x = 0; x < found.length; x++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (found[tails[mid]!]!.j < found[x]!.j) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) before[x] = tails[lo - 1]!;
    tails[lo] = x;
  }
  const chain: Anchor[] = [];
  for (let x = tails.length > 0 ? tails[tails.length - 1]! : -1; x >= 0; x = before[x]!) chain.push({ ms: found[x]!.ms, chars: index[found[x]!.j]!.at });
  return chain.reverse();
}

/** Where the backbone puts a moment, in characters: between the checkpoints either side of it, by time. */
function charsAt(points: readonly Anchor[], ms: number): number {
  if (ms <= points[0]!.ms) return points[0]!.chars;
  if (ms >= points[points.length - 1]!.ms) return points[points.length - 1]!.chars;
  let lo = 1;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ms < points[mid]!.ms) hi = mid;
    else lo = mid + 1;
  }
  const a = points[lo - 1]!;
  const b = points[lo]!;
  return Math.round(a.chars + ((ms - a.ms) / Math.max(1, b.ms - a.ms)) * (b.chars - a.chars));
}

/**
 * A whole transcript's phrases, each with where it is in the text: matched a
 * minute at a time around where the backbone puts that minute. A phrase that
 * isn't found keeps no place. With no backbone at all (a different book), none
 * are placed.
 */
export function placeTranscript(index: readonly WordAt[], said: readonly Said[]): PlacedPhrase[] {
  const phrases = [...said].sort((a, b) => a.startMs - b.startMs);
  const points = backbone(index, phrases);
  if (points.length === 0) return phrases.map((p) => ({ ...p, chars: null }));
  const placed: PlacedPhrase[] = [];
  for (let from = 0; from < phrases.length; ) {
    // About a minute of phrases at a time, as they were heard.
    let to = from + 1;
    while (to < phrases.length && phrases[to]!.startMs < phrases[from]!.startMs + STRETCH_MS) to++;
    const minute = phrases.slice(from, to);
    const start = charsAt(points, minute[0]!.startMs) - STRETCH_SLACK;
    const end = charsAt(points, minute[minute.length - 1]!.endMs) + STRETCH_SLACK;
    const m = matchTranscript(index, minute, start, end);
    for (const p of minute) {
      const an = m.anchors.find((z) => z.ms >= p.startMs && z.ms < p.endMs);
      placed.push(an ? { ...p, startMs: an.ms, chars: an.chars } : { ...p, chars: null });
    }
    from = to;
  }
  return placed;
}
