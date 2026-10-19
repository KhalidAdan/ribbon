import type { Sentence } from "../core/reading/sentences";

export interface Piece {
  start: number;
  text: string;
  gap: boolean;
  on: boolean;
}

/** A fragment cut where a mark begins and ends, each piece keeping its own offset so places still read from it. */
export function cut(start: number, text: string, gap: boolean, mark: Sentence | undefined): Piece[] {
  const end = start + text.length;
  if (!mark || mark.end <= start || mark.start >= end) return [{ start, text, gap, on: false }];
  const a = Math.max(start, mark.start);
  const b = Math.min(end, mark.end);
  const out: Piece[] = [];
  // The space before a fragment is marked only inside a sentence that began before it.
  if (a > start || (gap && mark.start >= start)) out.push({ start, text: text.slice(0, a - start), gap, on: false });
  out.push({ start: a, text: text.slice(a - start, b - start), gap: gap && a === start && mark.start < start, on: true });
  if (b < end) out.push({ start: b, text: text.slice(b - start), gap: false, on: false });
  return out;
}
