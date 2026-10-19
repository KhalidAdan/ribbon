import type { TextPlace } from "../core/reading/booktext";

/** What a mark is: the sentence a tap would listen from or the narrator is reading, or words bookmarked from a highlight. */
export type Tone = "sentence" | "saved";

/** A mark in one block: from `start` up to `end` in its text. */
export interface Span {
  start: number;
  end: number;
  tone: Tone;
}

/** A mark anywhere in the book, across blocks and sections if it runs on. */
export interface Marked {
  from: TextPlace;
  to: TextPlace;
  tone: Tone;
}

export interface Piece {
  start: number;
  text: string;
  gap: boolean;
  /** The marks over this piece, sentence first; none for a piece outside every mark. */
  on: Tone[];
}

/** The marks in one block, as spans of its text. A mark that runs on past the block runs to its end. */
export function spansIn(marks: readonly Marked[], section: number, block: number): Span[] {
  const out: Span[] = [];
  const before = (p: TextPlace) => p.section < section || (p.section === section && p.block < block);
  const after = (p: TextPlace) => p.section > section || (p.section === section && p.block > block);
  for (const m of marks) {
    if (after(m.from) || before(m.to)) continue;
    const start = before(m.from) ? -Infinity : m.from.offset;
    const end = after(m.to) ? Infinity : m.to.offset;
    if (end > start) out.push({ start, end, tone: m.tone });
  }
  return out;
}

/**
 * A fragment cut wherever a mark begins or ends, each piece keeping its
 * own offset so places still read from it. The space before a fragment
 * is marked only by marks that began before it.
 */
export function cut(start: number, text: string, gap: boolean, marks: readonly Span[]): Piece[] {
  const end = start + text.length;
  const over = marks.filter((m) => m.end > start && m.start < end);
  if (over.length === 0) return [{ start, text, gap, on: [] }];
  const cuts = new Set([start, end]);
  for (const m of over) {
    if (m.start > start) cuts.add(m.start);
    if (m.end < end) cuts.add(m.end);
  }
  const at = [...cuts].sort((a, b) => a - b);
  const tones = (f: (m: Span) => boolean) => [...new Set(over.filter(f).map((m) => m.tone))].sort((a, b) => (a === b ? 0 : a === "sentence" ? -1 : 1));
  const out: Piece[] = [];
  // The space before belongs to the marks that ran on into this fragment; when it differs from the first piece's, it is a piece of its own.
  const first = tones((m) => m.start <= start && m.end > start);
  const space = gap ? tones((m) => m.start < start && m.end > start) : [];
  const own = gap && space.join() !== first.join();
  if (own) out.push({ start, text: "", gap: true, on: space });
  for (let i = 0; i + 1 < at.length; i++) {
    const a = at[i]!;
    const b = at[i + 1]!;
    out.push({ start: a, text: text.slice(a - start, b - start), gap: gap && !own && a === start, on: tones((m) => m.start <= a && m.end > a) });
  }
  return out;
}
