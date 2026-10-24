import type { Chapter } from "../types";
import type { BookText } from "./booktext";
import { openingMatch, OTHER, SAME, words } from "./openings";
import type { Anchor } from "./anchors";

/**
 * Level 1 of read-along (docs/READING.md, section 6): the text's chapters
 * paired with the audio's, so a place in one maps into the other by how
 * far through its chapter it is. Pure.
 *
 * Pairing is one search for the best-scoring pairing in order (#63):
 * - pace is the backbone: a narrator reads at a steady rate, so a pair's
 *   characters per minute should match the book's;
 * - a name that matches ("Twenty-one" is "Chapter 21") adds confidence;
 * - what the publisher says a section is (chapter, epilogue, credits…)
 *   says how likely it is to be narrated, so skipping it costs more or less;
 * - one audio chapter may cover up to three text chapters, and the other
 *   way round;
 * - pairs set by hand are kept, and the rest is paired around them.
 */

/** How the text maps to the audio: by paired chapters, by the book's Media Overlay (exact), or by proportion of the whole. */
export type How = "chapter" | "overlay" | "proportion";

export interface Pair {
  /** Text range, in characters of the reading order. */
  text: { start: number; end: number };
  audio: { startMs: number; endMs: number };
  /** Names, for the contents and the log. */
  textLabel: string;
  audioTitle: string;
  /** How sure the pairing is, 0 to 1; 1 for a pair set by hand. */
  confidence: number;
  fixed: boolean;
  /** What the narrator was heard saying at its start is how its text opens (#65): the narration says it's this chapter. */
  heard?: true;
  /**
   * Checkpoints inside it, as [ms, characters], from its start to its end:
   * a place maps by the two around it. Just the ends without checkpoints.
   */
  points: [number, number][];
}

/** A contents entry of the text, as paired. */
export interface TextUnit {
  /** The entry's place in the book, `href#block`: how a correction names it. */
  ref: string;
  label: string;
  kind?: string;
  start: number;
  end: number;
  /** The pair it is part of, or -1 when it is not narrated. */
  pair: number;
}

export interface AudioUnit {
  title: string;
  startMs: number;
  endMs: number;
  pair: number;
}

export interface Alignment {
  pairs: Pair[];
  how: How;
  text: TextUnit[];
  audio: AudioUnit[];
}

/** A pairing set by hand: this contents entry is this audio chapter (by its start), or is not narrated. */
export interface PairingFix {
  text: string;
  audioMs: number | null;
}

/** Audio that is never in the text, whatever its length suggests. */
const CREDITS = /\bcredits\b/i;
/** A pace this far from the book's own counts against a pair; beyond, it argues for another. */
const PACE_TOLERANCE = Math.log(1.35);
/** Chapters shorter than this say little about pace. */
const PACE_MIN_MS = 30_000;
/** A chapter this long says all a chapter can about pace. */
const PACE_FULL_MS = 5 * 60_000;
/** How far a fixed pair's audio start may have moved (a chapter nudged) and still be the same chapter. */
const FIX_SLACK_MS = 2_000;

/** Sections publishers mark that a narrator almost never reads. */
const UNNARRATED = new Set(["toc", "cover", "titlepage", "halftitlepage", "copyright-page", "credits", "credit", "colophon", "imprint", "index", "landmarks", "loi", "lot", "seriespage", "other-credits", "errata", "notice", "backlink", "bibliography", "glossary"]);
/** Sections a narrator almost always reads. */
const NARRATED = new Set(["chapter", "prologue", "epilogue", "part", "introduction", "preface", "foreword", "afterword", "conclusion", "bodymatter"]);

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function wordsToNumber(s: string): number | null {
  const parts = s.split(/[\s-]+/).filter((p) => p && p !== "and");
  if (parts.length === 0) return null;
  let current = 0;
  for (const p of parts) {
    const one = ONES.indexOf(p);
    const ten = TENS.indexOf(p);
    if (one >= 0) current += one;
    else if (ten >= 2) current += ten * 10;
    else if (p === "hundred") current = (current || 1) * 100;
    else return null;
  }
  return current;
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

interface TextIn {
  ref: string;
  label: string;
  key: string;
  kind?: string;
  start: number;
  end: number;
  /** Characters a narrator could read: the range less sections never narrated. */
  spoken: number;
  /** Its first few hundred characters, to match against what the narrator says. */
  opening: string;
}

/** The text from a character of the reading order, blocks joined by spaces, up to `max` characters. */
function textFrom(book: BookText, start: number, max: number): string {
  const p = book.place(start);
  const out: string[] = [];
  let n = 0;
  for (let s = p.section; s < book.ebook.sections.length && n < max; s++) {
    const sec = book.ebook.sections[s]!;
    if (!sec.linear) continue;
    for (let b = s === p.section ? p.block : 0; b < sec.blocks.length && n < max; b++) {
      const t = book.blockText(s, b).slice(s === p.section && b === p.block ? p.offset : 0);
      if (!t) continue;
      out.push(t);
      n += t.length;
    }
  }
  return out.join(" ").slice(0, max);
}

interface AudioIn {
  title: string;
  key: string;
  startMs: number;
  endMs: number;
  credits: boolean;
  /** What the narrator says at its start, when it was heard (#65), and how many words that is. */
  heard?: string;
  heardWords?: number;
}

/** Heard openings with at least this many words say something. */
const HEARD_MIN_WORDS = 5;

/** The contents entries in reading order, each running to the next. */
function textUnits(book: BookText): TextIn[] {
  const ebook = book.ebook;
  const entries = ebook.toc
    .filter((t) => ebook.sections[t.section]?.linear)
    .map((t) => ({ label: t.label, ref: `${ebook.sections[t.section]!.href}#${t.block}`, kind: ebook.sections[t.section]!.kind, start: book.chars({ section: t.section, block: t.block, offset: 0 }) }))
    .sort((a, b) => a.start - b.start);
  const out: TextIn[] = [];
  for (const e of entries) {
    // Two entries at one place: the inner one names it.
    if (out.length > 0 && out[out.length - 1]!.start === e.start) out.pop();
    out.push({ ref: e.ref, label: e.label, key: chapterKey(e.label), ...(e.kind ? { kind: e.kind } : {}), start: e.start, end: 0, spoken: 0, opening: "" });
  }
  const total = book.total;
  out.forEach((c, i) => (c.end = out[i + 1]?.start ?? total));
  if (out.length > 0) out[0]!.start = 0;
  // What a narrator could read in each: its text, less sections marked as never narrated (a contents page inside "Cover").
  const silent: [number, number][] = [];
  let at = 0;
  for (const s of ebook.sections) {
    if (!s.linear) continue;
    if (s.kind && UNNARRATED.has(s.kind)) silent.push([at, at + s.chars]);
    at += s.chars;
  }
  for (const c of out) {
    const quiet = silent.reduce((n, [a, b]) => n + Math.max(0, Math.min(b, c.end) - Math.max(a, c.start)), 0);
    c.spoken = Math.max(0, c.end - c.start - quiet);
    c.opening = textFrom(book, c.start, Math.min(400, c.end - c.start));
  }
  return out.filter((c) => c.end > c.start);
}

const durationOf = (a: AudioIn) => Math.max(1, a.endMs - a.startMs);

interface Step {
  /** Text and audio units this step consumes. */
  dt: number;
  da: number;
  /** Paired (true) or skipped. */
  pair: boolean;
  score: number;
}

/**
 * The best pairing in order, by dynamic programming over (text so far,
 * audio so far). Steps skip one unit of either side, or pair a run of up
 * to three on one side with one on the other.
 */
function bestPairing(text: TextIn[], audio: AudioIn[], pace: number, fixes: Map<number, number | null>, fixedAudio: Map<number, number>) {
  const n = text.length;
  const m = audio.length;
  const totalText = text.reduce((s, t) => s + (t.end - t.start), 0) || 1;
  const totalAudio = audio.reduce((s, a) => s + durationOf(a), 0) || 1;

  const skipText = (t: TextIn, i: number): number => {
    const f = fixes.get(i);
    if (f === null) return 0;
    if (f !== undefined) return -1000;
    const share = (t.end - t.start) / totalText;
    if (t.kind && UNNARRATED.has(t.kind)) return -0.1;
    if (t.kind && NARRATED.has(t.kind)) return -(1 + 30 * share);
    return -(0.4 + 15 * share);
  };
  const skipAudio = (a: AudioIn, j: number): number => {
    if (fixedAudio.has(j)) return -1000;
    if (a.credits) return 0;
    return -(0.3 + 30 * (durationOf(a) / totalAudio));
  };
  const pairScore = (i0: number, i1: number, j0: number, j1: number): number => {
    const ts = text.slice(i0, i1);
    const as = audio.slice(j0, j1);
    // A pair set by hand is one text unit and one audio chapter, and is always taken.
    for (let i = i0; i < i1; i++) {
      const f = fixes.get(i);
      if (f === null) return -Infinity;
      if (f !== undefined) return i1 - i0 === 1 && j1 - j0 === 1 && f === j0 ? 1000 : -Infinity;
    }
    for (let j = j0; j < j1; j++) if (fixedAudio.has(j)) return -Infinity;
    if (as.some((a) => a.credits)) return -Infinity;
    const chars = ts.reduce((s, t) => s + t.spoken, 0);
    const ms = as.reduce((s, a) => s + durationOf(a), 0);
    const off = Math.abs(Math.log(Math.max(1, chars) / ms / pace));
    let score = 0.5;
    if (ms >= PACE_MIN_MS) {
      const weight = Math.min(1, ms / PACE_FULL_MS);
      score += weight * Math.max(-6, 2 - (2 * off) / PACE_TOLERANCE);
    }
    // Three times too fast or too slow is not the same text, however short: a cover is not the opening credits.
    if (off > Math.log(3)) score -= 3;
    const oneToOne = ts.length === 1 && as.length === 1;
    if (oneToOne && ts[0]!.key && ts[0]!.key === as[0]!.key) score += 3;
    else if (!oneToOne && ts.some((t) => t.key && as.some((a) => a.key === t.key))) score += 1;
    for (const t of ts) {
      if (t.kind && UNNARRATED.has(t.kind)) score -= 3;
      else if (t.kind && NARRATED.has(t.kind)) score += 0.5;
    }
    score -= 0.75 * (ts.length + as.length - 2);
    // What the narrator says: the strongest evidence there is. The first audio chapter opens with the first text chapter.
    const heard = as[0]!.heard;
    // Not looked at for a pair pace has already ruled out: hearing is what costs time here.
    if (heard && as[0]!.heardWords! >= HEARD_MIN_WORDS && off <= Math.log(3)) {
      const m = openingMatch(heard, ts[0]!.opening);
      if (m >= SAME) score += 6;
      else if (m < OTHER) score -= 3;
    }
    return score;
  };

  const best: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(-Infinity));
  const from: (Step | null)[][] = Array.from({ length: n + 1 }, () => new Array<Step | null>(m + 1).fill(null));
  best[0]![0] = 0;
  const shapes: [number, number][] = [
    [1, 1],
    [2, 1],
    [3, 1],
    [1, 2],
    [1, 3],
  ];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const here = best[i]![j]!;
      if (here === -Infinity) continue;
      const offer = (ni: number, nj: number, step: Step) => {
        const v = here + step.score;
        if (v > best[ni]![nj]!) {
          best[ni]![nj] = v;
          from[ni]![nj] = step;
        }
      };
      if (i < n) offer(i + 1, j, { dt: 1, da: 0, pair: false, score: skipText(text[i]!, i) });
      if (j < m) offer(i, j + 1, { dt: 0, da: 1, pair: false, score: skipAudio(audio[j]!, j) });
      for (const [dt, da] of shapes) {
        if (i + dt > n || j + da > m) continue;
        const s = pairScore(i, i + dt, j, j + da);
        if (s > -Infinity) offer(i + dt, j + da, { dt, da, pair: true, score: s });
      }
    }
  }
  const steps: { i: number; j: number; step: Step }[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const step = from[i]![j];
    if (!step) break;
    i -= step.dt;
    j -= step.da;
    steps.push({ i, j, step });
  }
  return steps.reverse().filter((s) => s.step.pair);
}

/**
 * Pair a book's text chapters with its audio chapters. Generated audio
 * titles ("Chapter 1", "Chapter 2" for every marker) are not trusted to
 * number the book's own chapters. With no pairs at all, the whole text
 * maps to the whole recording by proportion.
 */
export function alignBook(book: BookText, chapters: readonly Chapter[], durationMs: number, opts: { generated?: boolean; fixes?: readonly PairingFix[]; heard?: ReadonlyMap<number, string>; anchors?: readonly Anchor[] } = {}): Alignment {
  const text = textUnits(book);
  // Audible books open and close with credits; generated titles hide them, so a short first or last track is taken for them.
  const creditsLike = (c: Chapter, j: number) => CREDITS.test(c.title) || (!!opts.generated && (j === 0 || j === chapters.length - 1) && c.endMs - c.startMs < 75_000);
  const audio: AudioIn[] = chapters.map((c, j) => ({ title: c.title, startMs: c.startMs, endMs: c.endMs, credits: creditsLike(c, j), key: opts.generated && /^\d+$/.test(chapterKey(c.title)) ? "" : chapterKey(c.title), ...(opts.heard?.has(c.startMs) ? { heard: opts.heard.get(c.startMs)!, heardWords: words(opts.heard.get(c.startMs)!).length } : {}) }));
  const total = book.total;
  const whole = (): Alignment => ({
    how: "proportion",
    pairs: [withPoints({ text: { start: 0, end: total }, audio: { startMs: 0, endMs: durationMs }, textLabel: "", audioTitle: "", confidence: 0, fixed: false, points: [] }, opts.anchors)],
    text: text.map((t) => ({ ref: t.ref, label: t.label, ...(t.kind ? { kind: t.kind } : {}), start: t.start, end: t.end, pair: 0 })),
    audio: audio.map((a) => ({ title: a.title, startMs: a.startMs, endMs: a.endMs, pair: 0 })),
  });
  if (text.length === 0 || audio.length === 0 || total === 0) return whole();

  const fixes = new Map<number, number | null>();
  const fixedAudio = new Map<number, number>();
  for (const f of opts.fixes ?? []) {
    const i = text.findIndex((t) => t.ref === f.text);
    if (i < 0) continue;
    if (f.audioMs === null) {
      fixes.set(i, null);
      continue;
    }
    const j = audio.findIndex((a) => Math.abs(a.startMs - f.audioMs!) <= FIX_SLACK_MS);
    if (j < 0 || fixedAudio.has(j)) continue;
    fixes.set(i, j);
    fixedAudio.set(j, i);
  }

  // The book's pace, first from everything likely narrated, then from what paired.
  const narratedChars = text.reduce((s, t) => s + t.spoken, 0);
  const spokenMs = audio.filter((a) => !a.credits).reduce((s, a) => s + durationOf(a), 0);
  let pace = narratedChars / Math.max(1, spokenMs);
  let steps = bestPairing(text, audio, pace, fixes, fixedAudio);
  const paces = steps
    .filter((s) => audio.slice(s.j, s.j + s.step.da).reduce((t, a) => t + durationOf(a), 0) >= PACE_FULL_MS)
    .map((s) => text.slice(s.i, s.i + s.step.dt).reduce((t, x) => t + x.spoken, 0) / audio.slice(s.j, s.j + s.step.da).reduce((t, a) => t + durationOf(a), 0))
    .sort((a, b) => a - b);
  if (paces.length >= 3) {
    pace = paces[Math.floor(paces.length / 2)]!;
    steps = bestPairing(text, audio, pace, fixes, fixedAudio);
  }
  if (steps.length === 0) return whole();

  const textOut: TextUnit[] = text.map((t) => ({ ref: t.ref, label: t.label, ...(t.kind ? { kind: t.kind } : {}), start: t.start, end: t.end, pair: -1 }));
  const audioOut: AudioUnit[] = audio.map((a) => ({ title: a.title, startMs: a.startMs, endMs: a.endMs, pair: -1 }));
  const pairs: Pair[] = steps.map((s, k) => {
    const ts = text.slice(s.i, s.i + s.step.dt);
    const as = audio.slice(s.j, s.j + s.step.da);
    for (let x = s.i; x < s.i + s.step.dt; x++) textOut[x]!.pair = k;
    for (let x = s.j; x < s.j + s.step.da; x++) audioOut[x]!.pair = k;
    const fixed = s.step.score >= 1000;
    const heard = as[0]!.heard;
    const said = !!heard && as[0]!.heardWords! >= HEARD_MIN_WORDS && openingMatch(heard, ts[0]!.opening) >= SAME;
    return withPoints(
      {
        text: { start: ts[0]!.start, end: ts[ts.length - 1]!.end },
        audio: { startMs: as[0]!.startMs, endMs: as[as.length - 1]!.endMs },
        textLabel: ts.map((t) => t.label).join(" + "),
        audioTitle: as.map((a) => a.title).join(" + "),
        confidence: fixed ? 1 : Math.max(0, Math.min(1, s.step.score / 5)),
        fixed,
        ...(said ? { heard: true as const } : {}),
        points: [],
      },
      opts.anchors,
    );
  });
  return { how: "chapter", pairs, text: textOut, audio: audioOut };
}

/**
 * A pair with the checkpoints that fall inside it, in order both ways: a
 * checkpoint that would run backwards against its neighbours (a phrase
 * heard twice, found in the wrong place) is left out.
 */
function withPoints(p: Pair, anchors: readonly Anchor[] | undefined): Pair {
  const inside = (anchors ?? [])
    .filter((x) => x.ms > p.audio.startMs && x.ms < p.audio.endMs && x.chars > p.text.start && x.chars < p.text.end)
    .sort((x, y) => x.ms - y.ms);
  const points: [number, number][] = [[p.audio.startMs, p.text.start]];
  for (const x of inside) {
    const prev = points[points.length - 1]!;
    if (x.chars > prev[1] && x.ms > prev[0]) points.push([x.ms, x.chars]);
  }
  while (points.length > 1 && points[points.length - 1]![1] >= p.text.end) points.pop();
  points.push([p.audio.endMs, p.text.end]);
  return { ...p, points };
}

/** The first point past a value, by binary search: a pair transcribed whole has a point every few seconds. */
function after(points: readonly [number, number][], value: number, from: 0 | 1): number {
  let lo = 1;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (value < points[mid]![from]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Between two points of a pair, by proportion. */
function between(points: readonly [number, number][], value: number, from: 0 | 1): number {
  const to = from === 0 ? 1 : 0;
  if (points.length < 2) return points[0]![to];
  const i = after(points, value, from);
  const a = points[i - 1]!;
  const b = points[i]!;
  const f = (value - a[from]) / Math.max(1, b[from] - a[from]);
  return Math.round(a[to] + Math.max(0, Math.min(1, f)) * (b[to] - a[to]));
}

/** Closer together than this, the points around a moment place it to the sentence: read-along can highlight. */
export const PRECISE_MS = 20_000;

/** True when a moment of the recording is placed in the text to the sentence: between points close together, from a Media Overlay or a transcription. */
export function precise(a: Alignment, ms: number): boolean {
  const p = a.pairs.find((x) => ms >= x.audio.startMs && ms < x.audio.endMs);
  if (!p || p.points.length < 3) return false;
  const i = after(p.points, ms, 0);
  return p.points[i]![0] - p.points[i - 1]![0] <= PRECISE_MS;
}

/**
 * Listen from here starts this long before the sentence. A sentence's
 * moment is placed between checkpoints a few seconds apart, so it lands
 * within a few hundred milliseconds of the voice, either way; late, the
 * first word is clipped ("They" heard as "ay"). On the public Oz
 * recording, chapters I to III, a third of 296 sentences started more
 * than 100 ms after the voice; with this lead-in, 6% do, and about a
 * quarter start on the last sound of the sentence before.
 */
export const LEAD_IN_MS = 250;

/**
 * The moment the text follows: the player's, except during a Listen from
 * here's lead-in, when it is the moment listened from. The page and the
 * mark then wait for the sentence rather than going back to the one
 * before, perhaps on the page before. The window allows for a seek that
 * lands a frame or two early.
 */
export function followedMs(positionMs: number, listenedFrom: number | null): number {
  if (listenedFrom === null) return positionMs;
  return positionMs >= listenedFrom - 2 * LEAD_IN_MS && positionMs < listenedFrom ? listenedFrom : positionMs;
}

/**
 * The text mapped to the audio by the book's own Media Overlay (level 3):
 * every narrated passage is a point, exact, so the chapters are not
 * paired at all. The contents keep their units, all in the one pair.
 */
export function byOverlay(book: BookText, base: Alignment, anchors: readonly Anchor[], durationMs: number): Alignment {
  const total = book.total;
  const pair = withPoints({ text: { start: 0, end: total }, audio: { startMs: 0, endMs: durationMs }, textLabel: "", audioTitle: "", confidence: 1, fixed: false, points: [] }, anchors);
  return { how: "overlay", pairs: [pair], text: base.text.map((t) => ({ ...t, pair: 0 })), audio: base.audio.map((x) => ({ ...x, pair: 0 })) };
}

/** Where in the recording a character of the text is read. Text only one side has maps to the start of what follows. */
export function textToMs(a: Alignment, chars: number): number {
  const pairs = a.pairs;
  for (const p of pairs) {
    if (chars < p.text.start) return p.audio.startMs;
    if (chars < p.text.end) return between(p.points, chars, 1);
  }
  const last = pairs[pairs.length - 1];
  return last ? last.audio.endMs : 0;
}

/** Which character of the text a moment of the recording reads. Audio only one side has maps to the start of what follows. */
export function msToText(a: Alignment, ms: number): number {
  const pairs = a.pairs;
  for (const p of pairs) {
    if (ms < p.audio.startMs) return p.text.start;
    if (ms < p.audio.endMs) return between(p.points, ms, 0);
  }
  const last = pairs[pairs.length - 1];
  return last ? last.text.end : 0;
}
