import { blockText, type Ebook } from "../ebook";
import type { Chapter } from "../types";
import type { TextPlace } from "./place";

/**
 * Level 1 of read-along (docs/READING.md, section 6): the text's chapters
 * paired with the audio's, so a place in one maps into the other by how
 * far through its chapter it is. Pure.
 *
 * Pairs are found by name first ("Twenty-one" is "Chapter 21"), then, in
 * the runs between named pairs, by order, where the pace agrees: matter
 * only one side has (a dramatis personae, end credits) reads or plays at a
 * pace unlike the book's, and stays unpaired.
 */

export type How = "chapter" | "proportion";

export interface Pair {
  /** Text range, in characters of the reading order. */
  text: { start: number; end: number };
  audio: { startMs: number; endMs: number };
  /** Names, for the log and for tests. */
  textLabel: string;
  audioTitle: string;
}

export interface Alignment {
  pairs: Pair[];
  how: How;
}

/** A pace this far from the book's own is not the same chapter. */
const PACE_TOLERANCE = 0.35;
/** Audio that is never in the text, whatever its length suggests. */
const CREDITS = /\bcredits\b/i;
/** Chapters shorter than this say little about pace. */
const PACE_MIN_MS = 120_000;

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function wordsToNumber(s: string): number | null {
  const parts = s.split(/[\s-]+/).filter((p) => p && p !== "and");
  if (parts.length === 0) return null;
  let total = 0;
  let current = 0;
  for (const p of parts) {
    const one = ONES.indexOf(p);
    const ten = TENS.indexOf(p);
    if (one >= 0) current += one;
    else if (ten >= 2) current += ten * 10;
    else if (p === "hundred") current = (current || 1) * 100;
    else return null;
  }
  total += current;
  return total;
}

function romanToNumber(s: string): number | null {
  if (!/^[ivxlc]+$/.test(s)) return null;
  const v: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 };
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const a = v[s[i]!]!;
    const b = v[s[i + 1] ?? ""] ?? 0;
    n += a < b ? -a : a;
  }
  return n;
}

/** A chapter's name, compared: "Chapter Twenty-One", "21" and "XXI" are all "21". */
export function chapterKey(title: string): string {
  const s = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const bare = s.replace(/^(chapter|chap|ch|part|book)\s+/, "").trim();
  if (/^\d+$/.test(bare)) return String(Number(bare));
  const words = wordsToNumber(bare);
  if (words !== null) return String(words);
  const roman = bare.length <= 7 ? romanToNumber(bare) : null;
  if (roman !== null && roman > 0) return String(roman);
  return s;
}

/** Characters before a place, counting only the reading order. */
export function globalOffset(ebook: Ebook, p: TextPlace): number {
  let n = 0;
  ebook.sections.forEach((s, i) => {
    if (!s.linear || i > p.section) return;
    if (i < p.section) {
      n += s.chars;
      return;
    }
    for (let b = 0; b < p.block && b < s.blocks.length; b++) n += blockText(s.blocks[b]!).length;
    n += p.offset;
  });
  return n;
}

/** The place at a character of the reading order, at the start of its word. */
export function placeAtGlobal(ebook: Ebook, n: number): TextPlace {
  let left = Math.max(0, Math.round(n));
  let last: TextPlace = { section: 0, block: 0, offset: 0 };
  for (let i = 0; i < ebook.sections.length; i++) {
    const s = ebook.sections[i]!;
    if (!s.linear) continue;
    for (let b = 0; b < s.blocks.length; b++) {
      const text = blockText(s.blocks[b]!);
      if (left < text.length) {
        let offset = left;
        while (offset > 0 && !/\s/.test(text[offset - 1]!)) offset--;
        return { section: i, block: b, offset };
      }
      left -= text.length;
      last = { section: i, block: b, offset: text.length };
    }
  }
  return last;
}

function totalChars(ebook: Ebook): number {
  return ebook.sections.reduce((n, s) => n + (s.linear ? s.chars : 0), 0);
}

interface TextChapter {
  label: string;
  key: string;
  start: number;
  end: number;
}

/** The contents entries in reading order, each running to the next. */
function textChapters(ebook: Ebook): TextChapter[] {
  const entries = ebook.toc
    .filter((t) => ebook.sections[t.section]?.linear)
    .map((t) => ({ label: t.label, start: globalOffset(ebook, { section: t.section, block: t.block, offset: 0 }) }))
    .sort((a, b) => a.start - b.start);
  const out: TextChapter[] = [];
  for (const e of entries) {
    // Two entries at one place: the inner one names it.
    if (out.length > 0 && out[out.length - 1]!.start === e.start) out.pop();
    out.push({ label: e.label, key: chapterKey(e.label), start: e.start, end: 0 });
  }
  const total = totalChars(ebook);
  out.forEach((c, i) => (c.end = out[i + 1]?.start ?? total));
  if (out.length > 0) out[0]!.start = 0;
  return out;
}

/** Pairs by name, as the longest run in order (a longest common subsequence). */
function byName(text: TextChapter[], audio: { key: string }[]): [number, number][] {
  const n = text.length;
  const m = audio.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = text[i]!.key && text[i]!.key === audio[j]!.key ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (text[i]!.key && text[i]!.key === audio[j]!.key) {
      out.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

/**
 * Pair a book's text chapters with its audio chapters. Generated audio
 * titles ("Chapter 1", "Chapter 2" for every marker) are not trusted to
 * number the book's own chapters. With no pairs at all, the whole text
 * maps to the whole recording by proportion.
 */
export function alignBook(ebook: Ebook, chapters: readonly Chapter[], durationMs: number, generated = false): Alignment {
  const text = textChapters(ebook);
  const audio = chapters.map((c) => ({ ...c, key: generated && /^\d+$/.test(chapterKey(c.title)) ? "" : chapterKey(c.title), credits: CREDITS.test(c.title) }));
  const whole: Alignment = { how: "proportion", pairs: [{ text: { start: 0, end: totalChars(ebook) }, audio: { startMs: 0, endMs: durationMs }, textLabel: "", audioTitle: "" }] };
  if (text.length === 0 || audio.length === 0) return whole;

  let anchors = byName(text, audio);
  const paceOf = ([i, j]: [number, number]) => (text[i]!.end - text[i]!.start) / Math.max(1, audio[j]!.endMs - audio[j]!.startMs);
  const sample = anchors.filter(([, j]) => audio[j]!.endMs - audio[j]!.startMs >= PACE_MIN_MS).map(paceOf);
  if (sample.length === 0) return whole;
  const pace = [...sample].sort((a, b) => a - b)[Math.floor(sample.length / 2)]!;
  const agrees = (pair: [number, number]) => !audio[pair[1]]!.credits && (audio[pair[1]]!.endMs - audio[pair[1]]!.startMs < PACE_MIN_MS / 4 || Math.abs(paceOf(pair) / pace - 1) <= PACE_TOLERANCE);
  // A long chapter named alike but read at another pace is a coincidence of names.
  anchors = anchors.filter((a) => audio[a[1]]!.endMs - audio[a[1]]!.startMs < PACE_MIN_MS || agrees(a));

  // The runs between named pairs: pair outward from each anchor while the pace agrees.
  const extra: [number, number][] = [];
  const bounds: [number, number][] = [[-1, -1], ...anchors, [text.length, audio.length]];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const [ti0, ai0] = bounds[k]!;
    const [ti1, ai1] = bounds[k + 1]!;
    const ts = Array.from({ length: ti1 - ti0 - 1 }, (_, x) => ti0 + 1 + x);
    const as = Array.from({ length: ai1 - ai0 - 1 }, (_, x) => ai0 + 1 + x);
    if (ts.length === 0 || as.length === 0) continue;
    if (ts.length === as.length) {
      for (let x = 0; x < ts.length; x++) if (agrees([ts[x]!, as[x]!])) extra.push([ts[x]!, as[x]!]);
      continue;
    }
    // Unequal runs: pair from the named pair after the run backwards, then from the one before it forwards.
    let a = ts.length - 1;
    let b = as.length - 1;
    const taken = new Set<number>();
    if (k + 1 < bounds.length - 1) {
      while (a >= 0 && b >= 0 && agrees([ts[a]!, as[b]!])) {
        extra.push([ts[a]!, as[b]!]);
        taken.add(a);
        a--;
        b--;
      }
    }
    if (k > 0) {
      let c = 0;
      let d = 0;
      while (c <= a && d <= b && !taken.has(c) && agrees([ts[c]!, as[d]!])) {
        extra.push([ts[c]!, as[d]!]);
        c++;
        d++;
      }
    }
  }
  const all = [...anchors, ...extra].sort((x, y) => x[0] - y[0]);
  if (all.length === 0) return whole;
  return {
    how: "chapter",
    pairs: all.map(([i, j]) => ({ text: { start: text[i]!.start, end: text[i]!.end }, audio: { startMs: audio[j]!.startMs, endMs: audio[j]!.endMs }, textLabel: text[i]!.label, audioTitle: audio[j]!.title })),
  };
}

/** Where in the recording a character of the text is read. Text only one side has maps to the start of what follows. */
export function textToMs(a: Alignment, chars: number): number {
  const pairs = a.pairs;
  for (const p of pairs) {
    if (chars < p.text.start) return p.audio.startMs;
    if (chars < p.text.end) {
      const f = (chars - p.text.start) / Math.max(1, p.text.end - p.text.start);
      return Math.round(p.audio.startMs + f * (p.audio.endMs - p.audio.startMs));
    }
  }
  const last = pairs[pairs.length - 1];
  return last ? last.audio.endMs : 0;
}

/** Which character of the text a moment of the recording reads. Audio only one side has maps to the start of what follows. */
export function msToText(a: Alignment, ms: number): number {
  const pairs = a.pairs;
  for (const p of pairs) {
    if (ms < p.audio.startMs) return p.text.start;
    if (ms < p.audio.endMs) {
      const f = (ms - p.audio.startMs) / Math.max(1, p.audio.endMs - p.audio.startMs);
      return Math.round(p.text.start + f * (p.text.end - p.text.start));
    }
  }
  const last = pairs[pairs.length - 1];
  return last ? last.text.end : 0;
}
