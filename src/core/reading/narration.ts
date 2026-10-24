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

/** A book's narration transcribed: each stretch that was (start to end, ms), and each phrase heard in them with where it was found in the text. */
export interface Transcript {
  spans: Map<number, number>;
  said: PlacedPhrase[];
}

/** The fields of an `aligned/` record, in order. */
export const TRANSCRIPT_FIELDS = ["start_ms", "end_ms", "words", "chars"];

/** A transcript as its record's rows, by time: each stretch as a row with no words, before the phrases heard in it. */
export function transcriptRows(t: { spans: ReadonlyMap<number, number>; said: readonly PlacedPhrase[] }): Row[] {
  return [
    ...[...t.spans].map(([s, e]) => ({ start_ms: String(s), end_ms: String(e), words: "", chars: "" })),
    ...t.said.map((x) => ({ start_ms: String(x.startMs), end_ms: String(x.endMs), words: x.words, chars: x.chars === null ? "" : String(x.chars) })),
  ].sort((a, b) => Number(a.start_ms) - Number(b.start_ms) || (a.words ? 1 : 0) - (b.words ? 1 : 0));
}

/**
 * Two transcripts of a book as one: every stretch either transcribed, and
 * each phrase once, by when it starts and what it says. `ours` wins a tie.
 * So what another device heard stays, and nothing is ever taken away.
 */
export function mergeTranscripts(theirs: { spans: ReadonlyMap<number, number>; said: readonly PlacedPhrase[] }, ours: { spans: ReadonlyMap<number, number>; said: readonly PlacedPhrase[] }): Transcript {
  const phrases = new Map(theirs.said.map((x) => [`${x.startMs}|${x.words}`, x]));
  for (const x of ours.said) phrases.set(`${x.startMs}|${x.words}`, x);
  return { spans: new Map([...theirs.spans, ...ours.spans]), said: [...phrases.values()] };
}

/** The narration transcribed: each stretch that was (a row with no words), and each phrase heard in them with where it was found in the text, or null. */
export function transcriptFromRows(rows: readonly Row[]): Transcript {
  const spans = new Map<number, number>();
  const said: PlacedPhrase[] = [];
  for (const r of rows) {
    if (!r.start_ms || !r.end_ms) continue;
    if (!r.words) spans.set(int(r.start_ms), int(r.end_ms));
    else said.push({ startMs: int(r.start_ms), endMs: int(r.end_ms), words: r.words, chars: r.chars ? int(r.chars) : null });
  }
  return { spans, said };
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
