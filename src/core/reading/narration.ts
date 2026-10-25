import { int, type Row } from "../csv";
import { generatedTitles, headingsOf, namesFromContents, type ChapterName } from "../chapternames";
import type { Chapter } from "../types";
import { alignBook, byOverlay, type Alignment, type PairingFix } from "./align";
import type { Anchor } from "./anchors";
import type { BookText } from "./booktext";
import type { PlacedPhrase } from "./transcript";

/**
 * What a book's records say about its narration (docs/READING.md, section
 * 6), and its text paired with its audio from them. The records are CSVs,
 * kept beside the book in a folder's `.ribbon/` (`pairing/`, `heard/`,
 * `aligned/`) or with the book on a server (`records/`); they are read
 * from their rows here, so the apps and the server read them alike and
 * pair a book's text with its audio alike.
 */

/** Pairings set by hand: a contents entry (`href#block`) and the start of its audio chapter, or none for "not narrated". */
export function pairingFromRows(rows: readonly Row[]): PairingFix[] {
  return rows.filter((r) => r.text).map((r) => ({ text: r.text!, audioMs: r.audio_ms ? int(r.audio_ms) : null }));
}

/** What the narrator was heard saying at moments of the recording, and where each was found in the text (characters of the reading order). */
export function heardFromRows(rows: readonly Row[]): { heard: Map<number, string>; anchors: Map<number, number> } {
  const heard = new Map<number, string>();
  const anchors = new Map<number, number>();
  for (const r of rows) {
    if (!r.audio_ms) continue;
    const ms = int(r.audio_ms);
    heard.set(ms, r.words ?? "");
    if (r.chars) anchors.set(ms, int(r.chars));
  }
  return { heard, anchors };
}

/** The fields of a `heard/` record, in order. */
export const HEARD_FIELDS = ["audio_ms", "words", "chars"];

/** What was heard as its record's rows, by time: the words, and where they were found when they were. */
export function heardRows(heard: ReadonlyMap<number, string>, anchors: ReadonlyMap<number, number>): Row[] {
  return [...heard].sort((a, b) => a[0] - b[0]).map(([ms, words]) => ({ audio_ms: String(ms), words, chars: anchors.has(ms) ? String(anchors.get(ms)) : "" }));
}

/** Two records of what was heard as one: every moment either heard, and where it was found. `ours` wins a tie. */
export function mergeHeard(
  theirs: { heard: ReadonlyMap<number, string>; anchors: ReadonlyMap<number, number> },
  ours: { heard: ReadonlyMap<number, string>; anchors: ReadonlyMap<number, number> },
): { heard: Map<number, string>; anchors: Map<number, number> } {
  return { heard: new Map([...theirs.heard, ...ours.heard]), anchors: new Map([...theirs.anchors, ...ours.anchors]) };
}

/**
 * A book's narration transcribed: each stretch that was (start to end, ms),
 * which speech model heard each, and each phrase heard in them with where it
 * was found in the text.
 */
export interface Transcript {
  spans: Map<number, number>;
  said: PlacedPhrase[];
  /** The model each stretch was heard by (`ggml-small-q5_1`), by its start: how a stretch heard to have nothing in it is told from one that failed (#152). */
  heardBy: Map<number, string>;
}

/** The fields of an `aligned/` record, in order. `word_ms` is when each of a phrase's words starts, in ms of the book, apart by spaces. */
export const TRANSCRIPT_FIELDS = ["start_ms", "end_ms", "words", "chars", "heard_by", "word_ms"];

/** A transcript as its record's rows, by time: each stretch as a row with no words and the model that heard it, before the phrases heard in it. */
export function transcriptRows(t: { spans: ReadonlyMap<number, number>; said: readonly PlacedPhrase[]; heardBy?: ReadonlyMap<number, string> }): Row[] {
  return [
    ...[...t.spans].map(([s, e]) => ({ start_ms: String(s), end_ms: String(e), words: "", chars: "", heard_by: t.heardBy?.get(s) ?? "", word_ms: "" })),
    ...t.said.map((x) => ({ start_ms: String(x.startMs), end_ms: String(x.endMs), words: x.words, chars: x.chars === null ? "" : String(x.chars), heard_by: "", word_ms: x.wordMs?.join(" ") ?? "" })),
  ].sort((a, b) => Number(a.start_ms) - Number(b.start_ms) || (a.words ? 1 : 0) - (b.words ? 1 : 0));
}

/**
 * Two transcripts of a book as one: every stretch either transcribed, and
 * each phrase once, by when it starts and what it says. `ours` wins a tie.
 * One device keeps its own record this way across sessions; a book's
 * transcript on a server is only ever replaced whole.
 */
export function mergeTranscripts(theirs: { spans: ReadonlyMap<number, number>; said: readonly PlacedPhrase[]; heardBy?: ReadonlyMap<number, string> }, ours: { spans: ReadonlyMap<number, number>; said: readonly PlacedPhrase[]; heardBy?: ReadonlyMap<number, string> }): Transcript {
  const phrases = new Map(theirs.said.map((x) => [`${x.startMs}|${x.words}`, x]));
  for (const x of ours.said) phrases.set(`${x.startMs}|${x.words}`, x);
  return { spans: new Map([...theirs.spans, ...ours.spans]), said: [...phrases.values()], heardBy: new Map([...(theirs.heardBy ?? []), ...(ours.heardBy ?? [])]) };
}

/**
 * The narration transcribed: each stretch that was (a row with no words),
 * and each phrase heard in them with where it was found in the text, or
 * null.
 *
 * A stretch counts as transcribed when it names the model that heard it, or
 * when something was heard in it. One from before Ribbon named the model,
 * with nothing heard in it, may be a clip that failed and was kept as if
 * nothing was said (#152), so it's left out, to be heard again.
 */
export function transcriptFromRows(rows: readonly Row[]): Transcript {
  const stretches: { start: number; end: number; by: string }[] = [];
  const said: PlacedPhrase[] = [];
  for (const r of rows) {
    if (!r.start_ms || !r.end_ms) continue;
    if (!r.words) stretches.push({ start: int(r.start_ms), end: int(r.end_ms), by: r.heard_by ?? "" });
    else said.push({ startMs: int(r.start_ms), endMs: int(r.end_ms), words: r.words, chars: r.chars ? int(r.chars) : null, ...(r.word_ms ? { wordMs: r.word_ms.split(" ").map(int) } : {}) });
  }
  const starts = said.map((x) => x.startMs).sort((a, b) => a - b);
  const spans = new Map<number, number>();
  const heardBy = new Map<number, string>();
  for (const x of stretches) {
    if (x.by) heardBy.set(x.start, x.by);
    else if (!somethingIn(starts, x.start, x.end)) continue;
    spans.set(x.start, x.end);
  }
  return { spans, said, heardBy };
}

/** Whether any of these times, in order, falls in [from, to). */
function somethingIn(sorted: readonly number[], from: number, to: number): boolean {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length && sorted[lo]! < to;
}

/**
 * A transcript, with the minutes another has that it hasn't. Each minute is
 * one transcript's, never both, so two hearings of the same minute are
 * never mixed: a device takes a server's transcript, keeping only the
 * minutes it heard itself that the server's lacks.
 */
export function withMinutesOf(base: Transcript, more: Transcript): Transcript {
  const spans = new Map(base.spans);
  const heardBy = new Map(base.heardBy);
  const said = [...base.said];
  const extra = [...more.spans].filter(([start]) => !base.spans.has(start));
  for (const [start, end] of extra) {
    spans.set(start, end);
    const by = more.heardBy.get(start);
    if (by) heardBy.set(start, by);
  }
  for (const p of more.said) if (extra.some(([start, end]) => p.startMs >= start && p.startMs < end)) said.push(p);
  return { spans, heardBy, said };
}

/** Where each transcribed phrase begins in the text, by when it's said: the phrases found there. */
export function transcriptAnchors(said: readonly PlacedPhrase[]): Map<number, number> {
  return new Map(said.filter((s) => s.chars !== null).map((s) => [s.startMs, s.chars!]));
}

/** Every moment of the recording found in the text, as checkpoints: the ones heard, and the transcript's. */
export function anchorsOf(heard: ReadonlyMap<number, number>, transcript: ReadonlyMap<number, number>): Anchor[] {
  return [...heard, ...transcript].map(([ms, chars]) => ({ ms, chars }));
}

/** Everything that pairs a book's text with its narration. */
export interface Narration {
  fixes: readonly PairingFix[];
  /** What was heard at the starts of chapters, by moment: the strongest evidence a pair is right. */
  heard: ReadonlyMap<number, string>;
  /** Moments of the recording found in the text: checkpoints heard, and the transcript's phrases. */
  anchors: readonly Anchor[];
  /** The book's own Media Overlay for this recording, when it has one: exact, so the chapters aren't paired at all. */
  overlay: readonly Anchor[] | null;
}

/** A book's text paired with its audio: by its Media Overlay when it has one for this recording, else by chapters, with every checkpoint. */
export function pairBook(text: BookText, chapters: readonly Chapter[], durationMs: number, n: Narration): Alignment {
  const a = alignBook(text, chapters, durationMs, { generated: generatedTitles(chapters), fixes: n.fixes, heard: n.heard, anchors: n.anchors });
  return n.overlay ? byOverlay(text, a, n.overlay, durationMs) : a;
}

/**
 * Real names for chapters the files only number, from the book's text
 * (chapternames.ts, `namesFromContents`): the chapters to rename, and to
 * what. Once named, the chapters are paired by their names too, as every
 * device will pair them; names that would move the pairing they came from
 * aren't sure, and none are given.
 */
export function chapterNamesFromText(text: BookText, chapters: readonly Chapter[], durationMs: number, n: Narration): ChapterName[] {
  if (!generatedTitles(chapters)) return [];
  const headings = headingsOf(text);
  const names = namesFromContents(pairBook(text, chapters, durationMs, n), headings);
  const named = chapters.map((c) => ({ ...c }));
  for (const { index, title } of names) named[index]!.title = title;
  const again = new Map(namesFromContents(pairBook(text, named, durationMs, n), headings).map((x) => [x.index, x.title]));
  if (names.some((x) => again.get(x.index) !== x.title)) return [];
  return names.filter((x) => x.title !== chapters[x.index]!.title);
}
