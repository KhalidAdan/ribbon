import type { Locator } from "../poslog";
import { blockText, type Ebook } from "../ebook";
import { sentencesOf, type Sentence } from "./sentences";

/**
 * A place in the text (docs/READING.md, section 5): a section of the
 * spine, a block in it, and a UTF-16 offset in the block's text. Every
 * part of Ribbon that points into a book speaks it: the reader, reading
 * places, highlights, read-along and the export.
 */
export interface TextPlace {
  section: number;
  block: number;
  offset: number;
}

/** A stretch of text: from its first character up to, not including, `to`. */
export interface TextRange {
  from: TextPlace;
  to: TextPlace;
}

/** The order of two places in the book: negative when `a` comes first. */
export function comparePlaces(a: TextPlace, b: TextPlace): number {
  return a.section - b.section || a.block - b.block || a.offset - b.offset;
}

export const TEXT_TYPE = "application/xhtml+xml";

const SOFT_HYPHEN = "­";
/** How much of the text around a place a Locator keeps, to find it again. */
const BEFORE = 32;
const HIGHLIGHT = 48;
const AFTER = 32;

/**
 * A book's text, and every way of pointing into it. Places go in; out
 * come the words, how far through the book they are, and the forms other
 * things use: characters of the reading order (read-along's timing), Readium
 * Locators (the position log), and links by id (the book's own, and its
 * Media Overlays).
 *
 * The reading order is the spine's linear sections, end to end; a section
 * out of it (notes, say) is found at the place it would be, and adds no
 * characters. Made once when a book is opened: where every block begins is
 * worked out here, so finding a place costs a lookup, not a walk.
 */
export class BookText {
  readonly ebook: Ebook;
  /** Characters of the reading order. */
  readonly total: number;
  /** Each block's text, by section. */
  private readonly texts: string[][];
  /** Where each section begins in the reading order, and each of its blocks. */
  private readonly sectionStarts: number[];
  private readonly blockStarts: number[][];
  /** The linear sections, in order: what `place` searches. */
  private readonly linear: number[];
  private readonly ids = new Map<string, TextPlace>();

  constructor(ebook: Ebook) {
    this.ebook = ebook;
    this.texts = ebook.sections.map((s) => s.blocks.map(blockText));
    this.sectionStarts = [];
    this.blockStarts = [];
    this.linear = [];
    let n = 0;
    ebook.sections.forEach((s, i) => {
      this.sectionStarts.push(n);
      let k = n;
      this.blockStarts.push(this.texts[i]!.map((t) => ((k += t.length), k - t.length)));
      if (s.linear) {
        this.linear.push(i);
        n = k;
      }
      s.blocks.forEach((b, block) => b.ids?.forEach((a) => this.ids.set(`${s.href}#${a.id}`, { section: i, block, offset: a.at })));
    });
    this.total = n;
  }

  // The text ------------------------------------------------------------

  /** A block's text, its runs joined. */
  blockText(section: number, block: number): string {
    return this.texts[section]?.[block] ?? "";
  }

  /** The text of a range, paragraphs on lines of their own and soft hyphens left out: what copying gives. */
  text(range: TextRange): string {
    const [from, to] = comparePlaces(range.from, range.to) <= 0 ? [range.from, range.to] : [range.to, range.from];
    const parts: string[] = [];
    for (let s = from.section; s <= to.section; s++) {
      const blocks = this.texts[s] ?? [];
      const first = s === from.section ? from.block : 0;
      const last = s === to.section ? to.block : blocks.length - 1;
      for (let i = first; i <= last && i < blocks.length; i++) {
        const t = blocks[i]!;
        const start = s === from.section && i === from.block ? from.offset : 0;
        const end = s === to.section && i === to.block ? to.offset : t.length;
        const piece = t.slice(start, end).replaceAll(SOFT_HYPHEN, "");
        if (piece) parts.push(piece);
      }
    }
    return parts.join("\n\n");
  }

  /** The first block after this one, in this section or a later one, with any text. */
  nextBlock(section: number, block: number): { section: number; block: number } | null {
    for (let s = section, b = block + 1; s < this.texts.length; s++, b = 0) {
      for (const blocks = this.texts[s]!; b < blocks.length; b++) if (blocks[b]!.replaceAll(SOFT_HYPHEN, "")) return { section: s, block: b };
    }
    return null;
  }

  /** The sentences of a block (sentences.ts). */
  sentences(section: number, block: number): Sentence[] {
    const b = this.ebook.sections[section]?.blocks[block];
    return b ? sentencesOf(b, this.ebook.meta.language) : [];
  }

  /** The sentence a place is in, or the next one after a space between two; null in a block with none. */
  sentenceAt(p: TextPlace): (Sentence & { section: number; block: number }) | null {
    const all = this.sentences(p.section, p.block);
    const s = all.find((x) => p.offset < x.end) ?? all[all.length - 1];
    return s ? { section: p.section, block: p.block, ...s } : null;
  }

  // Places in the reading order -------------------------------------------

  /** Where a book opens with no place yet: the start of its first linear section. */
  start(): TextPlace {
    return { section: this.linear[0] ?? 0, block: 0, offset: 0 };
  }

  /** Characters of the reading order before a place. In a section out of the reading order, where that section would be. */
  chars(p: TextPlace): number {
    const section = this.ebook.sections[p.section];
    if (!section) return this.total;
    if (!section.linear) return this.sectionStarts[p.section]!;
    const starts = this.blockStarts[p.section]!;
    const blockStart = p.block < starts.length ? starts[p.block]! : this.sectionStarts[p.section]! + section.chars;
    return blockStart + p.offset;
  }

  /** The place at a character of the reading order, at the start of its word. Past the end, the end. */
  place(chars: number): TextPlace {
    const n = Math.max(0, Math.round(chars));
    // The linear section it falls in, then the block, by binary search.
    let lo = 0;
    let hi = this.linear.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.sectionStarts[this.linear[mid]!]! <= n) lo = mid;
      else hi = mid - 1;
    }
    for (let i = lo; i < this.linear.length; i++) {
      const section = this.linear[i]!;
      const starts = this.blockStarts[section]!;
      const texts = this.texts[section]!;
      for (let b = 0; b < texts.length; b++) {
        const left = n - starts[b]!;
        if (left >= 0 && left < texts[b]!.length) {
          let offset = left;
          while (offset > 0 && !/\s/.test(texts[b]![offset - 1]!)) offset--;
          return { section, block: b, offset };
        }
      }
    }
    // Past the end: the end of the last block with text.
    for (let i = this.linear.length - 1; i >= 0; i--) {
      const section = this.linear[i]!;
      const texts = this.texts[section]!;
      for (let b = texts.length - 1; b >= 0; b--) if (texts[b]!.length > 0) return { section, block: b, offset: texts[b]!.length };
    }
    return { section: 0, block: 0, offset: 0 };
  }

  /** How far through the whole book a place is, 0 to 1, by characters of the reading order. */
  progress(p: TextPlace): number {
    return this.total > 0 ? round(this.chars(p) / this.total) : 0;
  }

  /** How far through its own section a place is, 0 to 1. */
  sectionProgress(p: TextPlace): number {
    const s = this.ebook.sections[p.section];
    if (!s || s.chars <= 0) return 0;
    const starts = this.blockStarts[p.section]!;
    const before = (p.block < starts.length ? starts[p.block]! : this.sectionStarts[p.section]! + s.chars) - this.sectionStarts[p.section]!;
    return round((before + p.offset) / s.chars);
  }

  /** The place a fraction of the way through a section, at the start of its word. */
  placeAtProgress(section: number, progression: number): TextPlace {
    const texts = this.texts[section] ?? [];
    const total = texts.reduce((n, t) => n + t.length, 0);
    let target = Math.round(Math.max(0, Math.min(1, progression)) * total);
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]!;
      if (target < text.length || i === texts.length - 1) {
        let offset = Math.min(target, text.length);
        while (offset > 0 && !/\s/.test(text[offset - 1]!)) offset--;
        return { section, block: i, offset };
      }
      target -= text.length;
    }
    return { section, block: 0, offset: 0 };
  }

  /** The contents entry a place is under: the last one at or before it, or -1. */
  tocEntryAt(p: TextPlace): number {
    let found = -1;
    this.ebook.toc.forEach((t, i) => {
      if (t.section < p.section || (t.section === p.section && t.block <= p.block)) found = i;
    });
    return found;
  }

  // Places as other things name them ----------------------------------------

  /** Where a link inside the book goes ("chapter.xhtml#id"): the place of its id, or its section's start. Null for a file not in the spine. */
  fromHref(href: string): TextPlace | null {
    const hash = href.indexOf("#");
    const path = hash < 0 ? href : href.slice(0, hash);
    const section = this.ebook.sections.findIndex((s) => s.href === path);
    if (section < 0) return null;
    return (hash >= 0 && this.ids.get(href)) || { section, block: 0, offset: 0 };
  }

  /** The place of an element's id in a section, or null. */
  idAt(section: number, id: string): TextPlace | null {
    const s = this.ebook.sections[section];
    return (s && this.ids.get(`${s.href}#${id}`)) ?? null;
  }

  /** A place as a Readium Locator, with the words there so it can be found again in any layout. */
  locator(p: TextPlace): Locator {
    const section = this.ebook.sections[p.section]!;
    const text = this.blockText(p.section, p.block);
    const offset = Math.max(0, Math.min(text.length, p.offset));
    let before = text.slice(Math.max(0, offset - BEFORE), offset);
    if (offset < BEFORE && p.block > 0) {
      const prev = this.texts[p.section]!.slice(0, p.block).filter(Boolean).pop();
      if (prev) before = `${prev.slice(-(BEFORE - offset))} ${before}`.trimStart();
    }
    const rest = text.slice(offset);
    const highlight = rest.length > HIGHLIGHT ? words(rest.slice(0, HIGHLIGHT), "end") : rest;
    const after = text.slice(offset + highlight.length, offset + highlight.length + AFTER);
    // The nearest id at or before the place, for apps that go by fragments.
    let fragment: string | undefined;
    for (let i = 0; i <= p.block && i < section.blocks.length; i++) {
      for (const a of section.blocks[i]!.ids ?? []) if (i < p.block || a.at <= offset) fragment = a.id;
    }
    const loc: Locator = {
      href: section.href,
      type: TEXT_TYPE,
      locations: { progression: this.sectionProgress(p), totalProgression: this.progress(p), ...(fragment ? { fragments: [fragment] } : {}) },
    };
    const quote: NonNullable<Locator["text"]> = {};
    if (before) quote.before = offset - BEFORE > 0 ? words(before, "start") : before;
    if (highlight) quote.highlight = highlight;
    if (after) quote.after = words(after, "end");
    if (Object.keys(quote).length > 0) loc.text = quote;
    return loc;
  }

  /**
   * A Locator's place in this book: its section by href (or by how far
   * through the book it was), then its words nearest the progression it
   * gives, then that progression alone.
   */
  fromLocator(loc: Locator): TextPlace {
    let section = this.ebook.sections.findIndex((s) => s.href === loc.href);
    if (section < 0) {
      const total = loc.locations?.totalProgression;
      if (typeof total !== "number") return this.start();
      section = this.place(total * this.total).section;
    }
    const progression = loc.locations?.progression ?? 0;
    const highlight = loc.text?.highlight;
    if (highlight) {
      const total = Math.max(1, this.ebook.sections[section]!.chars);
      let best: { place: TextPlace; score: number } | null = null;
      let before = 0;
      this.texts[section]!.forEach((text, block) => {
        for (let at = text.indexOf(highlight); at >= 0; at = text.indexOf(highlight, at + 1)) {
          const distance = Math.abs((before + at) / total - progression);
          // Matching words before the place make a candidate much likelier.
          const context = loc.text?.before && text.slice(0, at).endsWith(loc.text.before) ? 0.5 : 0;
          const score = distance - context;
          if (!best || score < best.score) best = { place: { section, block, offset: at }, score };
        }
        before += text.length;
      });
      if (best) return (best as { place: TextPlace }).place;
    }
    return this.placeAtProgress(section, progression);
  }
}

function round(x: number): number {
  return Math.round(Math.max(0, Math.min(1, x)) * 10000) / 10000;
}

/** Cut at a word boundary on the side away from the place, so a quote never starts or ends mid-word. */
function words(text: string, side: "start" | "end"): string {
  if (side === "end") {
    const cut = text.search(/\s\S*$/);
    return cut > 0 ? text.slice(0, cut) : text;
  }
  const cut = text.search(/\s/);
  return cut >= 0 && cut < text.length - 1 ? text.slice(cut + 1) : text;
}
