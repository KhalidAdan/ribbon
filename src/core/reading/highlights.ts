import { blockText, type Ebook } from "../ebook";
import { textClaimsFor } from "../poslog";
import type { HighlightText } from "../types";
import { locatorOf, placeOf, textBetween, type TextPlace } from "./place";

/**
 * Highlights in the text (docs/READING.md, section 5): words marked by a
 * selection, kept as Locators and the words themselves, and found again
 * as a range of places in any layout. Pure.
 */

export interface TextRange {
  from: TextPlace;
  to: TextPlace;
}

const SOFT_HYPHEN = "­";

export function comparePlaces(a: TextPlace, b: TextPlace): number {
  return a.section - b.section || a.block - b.block || a.offset - b.offset;
}

function textAt(ebook: Ebook, section: number, block: number): string {
  const b = ebook.sections[section]?.blocks[block];
  return b ? blockText(b) : "";
}

/** The first block after this one, in this section or a later one, with any text. */
function nextBlock(ebook: Ebook, section: number, block: number): { section: number; block: number } | null {
  for (let s = section, b = block + 1; s < ebook.sections.length; s++, b = 0) {
    const blocks = ebook.sections[s]!.blocks;
    for (; b < blocks.length; b++) if (blockText(blocks[b]!).replaceAll(SOFT_HYPHEN, "")) return { section: s, block: b };
  }
  return null;
}

/** Letters, digits and what joins them inside a word. */
const WORD = /[\p{L}\p{N}\p{M}'’­]/u;

/**
 * A selection as a range of words: its ends in order, the spaces at either
 * end left out, a start at the end of a paragraph moved to the next, and
 * a word cut by either end taken whole. Null when nothing but space was
 * selected.
 */
export function trimRange(ebook: Ebook, a: TextPlace, b: TextPlace): TextRange | null {
  let [from, to] = comparePlaces(a, b) <= 0 ? [a, b] : [b, a];
  const blank = (c: string | undefined) => c !== undefined && (/\s/.test(c) || c === SOFT_HYPHEN);
  // Punctuation that ends what comes before is never the first of a highlight, nor what opens what comes after its last.
  const closing = (c: string | undefined) => c !== undefined && (blank(c) || /[,.;:!?)\]}»”…—–]/.test(c));
  const opening = (c: string | undefined) => c !== undefined && (blank(c) || /[([{«“]/.test(c));
  const word = (c: string | undefined) => c !== undefined && WORD.test(c);
  for (;;) {
    const text = textAt(ebook, from.section, from.block);
    let o = Math.min(from.offset, text.length);
    while (o < text.length && closing(text[o])) o++;
    if (o < text.length) {
      while (o > 0 && word(text[o - 1]) && word(text[o])) o--;
      from = { ...from, offset: o };
      break;
    }
    const next = nextBlock(ebook, from.section, from.block);
    if (!next) return null;
    from = { ...next, offset: 0 };
  }
  const end = textAt(ebook, to.section, to.block);
  let o = Math.min(to.offset, end.length);
  while (o > 0 && opening(end[o - 1])) o--;
  while (o > 0 && o < end.length && word(end[o - 1]) && word(end[o])) o++;
  to = { ...to, offset: o };
  return comparePlaces(from, to) < 0 ? { from, to } : null;
}

/** What a highlight keeps of a selection: the text edition's claims, where it starts and ends, and its words. */
export function highlightOf(ebook: Ebook, bookId: string, range: TextRange): HighlightText {
  return { ids: textClaimsFor(bookId, ebook.meta.identifiers), start: locatorOf(ebook, range.from), end: locatorOf(ebook, range.to), quote: textBetween(ebook, range.from, range.to) };
}

/**
 * Where words that start at a place end: the words walked through the
 * text as `textBetween` gave them, paragraphs apart and soft hyphens
 * left out. Null when the text there is not those words.
 */
export function placeAfter(ebook: Ebook, start: TextPlace, quote: string): TextPlace | null {
  let { section, block } = start;
  let text = textAt(ebook, section, block);
  let o = start.offset;
  const atEnd = () => {
    while (o < text.length && text[o] === SOFT_HYPHEN) o++;
    return o >= text.length;
  };
  for (let q = 0; q < quote.length; ) {
    if (quote.startsWith("\n\n", q) && atEnd()) {
      const next = nextBlock(ebook, section, block);
      if (!next) return null;
      ({ section, block } = next);
      text = textAt(ebook, section, block);
      o = 0;
      q += 2;
      continue;
    }
    while (o < text.length && text[o] === SOFT_HYPHEN) o++;
    if (text[o] !== quote[q]) return null;
    o++;
    q++;
  }
  return { section, block, offset: o };
}

/**
 * A highlight's words in this book: its start found by its Locator, its
 * end by walking its words from there, or by the end's Locator when the
 * text has changed.
 */
export function rangeOf(ebook: Ebook, h: HighlightText): TextRange {
  const from = placeOf(ebook, h.start);
  const after = placeAfter(ebook, from, h.quote);
  const to = after ?? placeOf(ebook, h.end);
  return comparePlaces(from, to) <= 0 ? { from, to } : { from: to, to: from };
}

/** Whether a place is inside a range: from its first character up to, not including, its end. */
export function inRange(r: TextRange, p: TextPlace): boolean {
  return comparePlaces(r.from, p) <= 0 && comparePlaces(p, r.to) < 0;
}
