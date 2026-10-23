import { blockText, type EbookBlock } from "../ebook";
import { precise, textToMs, type Alignment } from "./align";
import type { BookText, TextPlace } from "./booktext";

/**
 * A book's text with when each of its sentences is read: all a device
 * needs to read a book along with its narration when it can neither parse
 * the EPUB nor pair it with the audio itself (the Apple TV). The server
 * makes it from the same text and the same pairing the apps make, so a
 * sentence here is the sentence the reader marks.
 *
 * The sentences are counted across the whole book, in order: the tenth
 * sentence is the tenth of the first blocks' sentences put end to end.
 * That count is how a place is named to a device (`sentenceAt`).
 */
export const READ_ALONG_FORMAT = "ribbon-readalong/1";

export interface ReadAlong {
  format: typeof READ_ALONG_FORMAT;
  /** The contents: each entry's title and the block it starts at. */
  contents: { title: string; block: number }[];
  /** The reading order's paragraphs, headings and breaks between scenes. Pictures are left out. */
  blocks: ReadAlongBlock[];
}

export interface ReadAlongBlock {
  /** A paragraph, a heading, or a break between scenes. */
  k: "p" | "h" | "hr";
  /** A heading's level, 1 to 6. */
  level?: number;
  /** The text, italic or bold where the book says so. Sentences count in their text joined. */
  runs?: ReadAlongRun[];
  /** As the book sets it: the first line indented, centred, set apart from the paragraph before, inset. */
  indent?: true;
  center?: true;
  space?: true;
  quote?: true;
  sentences?: ReadAlongSentence[];
}

export interface ReadAlongRun {
  t: string;
  i?: true;
  b?: true;
}

/** A sentence: where it starts and ends in its block's text (UTF-16), and when it's read. */
export interface ReadAlongSentence {
  start: number;
  end: number;
  /** When the narrator starts it and finishes it, in ms of the whole recording. Text the narration skips starts and ends at once. */
  ms: number;
  endMs: number;
  /** Placed to the sentence by a transcript or a Media Overlay, not only by its chapter: read-along marks it. */
  exact: boolean;
}

/** The blocks a read-along shows, in the reading order, with where each is in the book. */
function* shownBlocks(text: BookText): Generator<{ section: number; block: number; source: EbookBlock }> {
  for (const [section, s] of text.ebook.sections.entries()) {
    if (!s.linear) continue;
    for (const [block, source] of s.blocks.entries()) {
      if (source.k === "hr" || (source.k !== "img" && blockText(source).trim())) yield { section, block, source };
    }
  }
}

/** A book's read-along, from its text and the text paired with its audio. */
export function readAlongOf(text: BookText, alignment: Alignment): ReadAlong {
  const blocks: ReadAlongBlock[] = [];
  const where: { section: number; block: number }[] = [];
  for (const { section, block, source } of shownBlocks(text)) {
    where.push({ section, block });
    if (source.k === "hr") {
      blocks.push({ k: "hr" });
      continue;
    }
    const at = (offset: number) => textToMs(alignment, text.chars({ section, block, offset }));
    const sentences = text.sentences(section, block).map((s) => {
      const ms = at(s.start);
      const endMs = at(s.end);
      return { start: s.start, end: s.end, ms, endMs, exact: endMs > ms && precise(alignment, ms) };
    });
    blocks.push({
      k: source.k === "h" ? "h" : "p",
      ...(source.k === "h" ? { level: source.level ?? 1 } : {}),
      runs: (source.runs ?? []).map((r) => ({ t: r.t, ...(r.i ? { i: true as const } : {}), ...(r.b ? { b: true as const } : {}) })),
      ...(source.indent ? { indent: true as const } : {}),
      ...(source.align === "center" ? { center: true as const } : {}),
      ...(source.space ? { space: true as const } : {}),
      ...(source.quote ? { quote: true as const } : {}),
      sentences,
    });
  }
  // Each contents entry starts at the first block shown at or after its place.
  const contents: ReadAlong["contents"] = [];
  for (const entry of text.ebook.toc) {
    const block = where.findIndex((w) => w.section > entry.section || (w.section === entry.section && w.block >= entry.block));
    if (block >= 0 && contents.at(-1)?.block !== block) contents.push({ title: entry.label, block });
  }
  return { format: READ_ALONG_FORMAT, contents, blocks };
}

/**
 * The sentence a place in the text is in, counted across the whole
 * read-along. A place between two sentences, or in a block the read-along
 * leaves out, is at the next one.
 */
export function sentenceAt(text: BookText, place: TextPlace): number {
  let count = 0;
  for (const { section, block } of shownBlocks(text)) {
    const sentences = text.sentences(section, block);
    if (section > place.section || (section === place.section && block > place.block)) return count;
    if (section === place.section && block === place.block) {
      const i = sentences.findIndex((s) => place.offset < s.end);
      return count + (i >= 0 ? i : Math.max(0, sentences.length - 1));
    }
    count += sentences.length;
  }
  return Math.max(0, count - 1);
}

/** A sentence by its count across the whole read-along, or null past the end. */
export function nthSentence(readAlong: ReadAlong, n: number): ReadAlongSentence | null {
  let count = 0;
  for (const b of readAlong.blocks) {
    const sentences = b.sentences ?? [];
    if (n < count + sentences.length) return sentences[n - count] ?? null;
    count += sentences.length;
  }
  return null;
}

/** The sentence being read at a moment of the recording, counted across the whole read-along: the last one started by then. */
export function sentenceReadAt(readAlong: ReadAlong, ms: number): number {
  let count = 0;
  let found = 0;
  for (const b of readAlong.blocks) {
    for (const s of b.sentences ?? []) {
      // Text the narration skips is never the one being read.
      if (s.endMs > s.ms && s.ms <= ms) found = count;
      count++;
    }
  }
  return found;
}
