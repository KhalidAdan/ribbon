import { blockText, type Ebook, type EbookBlock } from "../ebook";
import type { TextPlace } from "./place";

/**
 * The sentences of a block, as the reader marks them: where listening
 * from a tap starts, and what read-along highlights. Each range runs
 * from a sentence's first character to its last, trailing spaces left
 * out. UTF-16 offsets into the block's text.
 */
export interface Sentence {
  start: number;
  end: number;
}

const cache = new WeakMap<EbookBlock, Sentence[]>();
const segmenters = new Map<string, Intl.Segmenter>();

function segmenter(language: string | undefined): Intl.Segmenter {
  const lang = language || "en";
  let s = segmenters.get(lang);
  if (!s) {
    try {
      s = new Intl.Segmenter(lang, { granularity: "sentence" });
    } catch {
      s = new Intl.Segmenter("en", { granularity: "sentence" });
    }
    segmenters.set(lang, s);
  }
  return s;
}

/** A block's sentences, in order. A block with no text has none. */
export function sentencesOf(block: EbookBlock, language?: string): Sentence[] {
  let out = cache.get(block);
  if (out) return out;
  const text = blockText(block);
  out = [];
  for (const seg of segmenter(language).segment(text)) {
    let start = seg.index;
    let end = seg.index + seg.segment.length;
    while (start < end && /\s/.test(text[start]!)) start++;
    while (end > start && /\s/.test(text[end - 1]!)) end--;
    if (end <= start) continue;
    // Dialogue: “Who made it?” asked Jurilan. is one sentence, though a question mark ends the quote.
    const prev = out[out.length - 1];
    if (prev && /^\p{Ll}/u.test(text.slice(start, start + 1))) prev.end = end;
    else out.push({ start, end });
  }
  cache.set(block, out);
  return out;
}

/** The sentence a place is in: the one it falls in, or the next one after a space between two. */
export function sentenceAt(ebook: Ebook, p: TextPlace): Sentence | null {
  const block = ebook.sections[p.section]?.blocks[p.block];
  if (!block) return null;
  const all = sentencesOf(block, ebook.meta.language);
  for (const s of all) if (p.offset < s.end) return s;
  return all[all.length - 1] ?? null;
}
