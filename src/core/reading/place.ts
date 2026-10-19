import type { Locator } from "../poslog";
import { blockText, type Ebook } from "../ebook";

/**
 * A place in the text (docs/READING.md, section 5): a section of the
 * spine, a block in it, and a UTF-16 offset in the block's text.
 */
export interface TextPlace {
  section: number;
  block: number;
  offset: number;
}

export const TEXT_TYPE = "application/xhtml+xml";

const BEFORE = 32;
const HIGHLIGHT = 48;
const AFTER = 32;

function round(x: number): number {
  return Math.round(Math.max(0, Math.min(1, x)) * 10000) / 10000;
}

/** Characters before a place in its section. */
function charsBefore(ebook: Ebook, p: TextPlace): number {
  const blocks = ebook.sections[p.section]?.blocks ?? [];
  let n = 0;
  for (let i = 0; i < p.block && i < blocks.length; i++) n += blockText(blocks[i]!).length;
  return n + p.offset;
}

/** How far through the whole book a place is, by characters, counting only the reading order. */
export function bookProgress(ebook: Ebook, p: TextPlace): number {
  let total = 0;
  let before = 0;
  ebook.sections.forEach((s, i) => {
    if (!s.linear) return;
    if (i < p.section) before += s.chars;
    total += s.chars;
  });
  if (ebook.sections[p.section]?.linear) before += charsBefore(ebook, p);
  return total > 0 ? round(before / total) : 0;
}

/** How far through its section a place is. */
export function sectionProgress(ebook: Ebook, p: TextPlace): number {
  const s = ebook.sections[p.section];
  return s && s.chars > 0 ? round(charsBefore(ebook, p) / s.chars) : 0;
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

/** A place as a Readium Locator, with the words there so it can be found again in any layout. */
export function locatorOf(ebook: Ebook, p: TextPlace): Locator {
  const section = ebook.sections[p.section]!;
  const blocks = section.blocks;
  const text = blockText(blocks[p.block] ?? { k: "p" });
  const offset = Math.max(0, Math.min(text.length, p.offset));
  let before = text.slice(Math.max(0, offset - BEFORE), offset);
  if (offset < BEFORE && p.block > 0) {
    const prev = blocks
      .slice(0, p.block)
      .map((b) => blockText(b))
      .filter(Boolean)
      .pop();
    if (prev) before = `${prev.slice(-(BEFORE - offset))} ${before}`.trimStart();
  }
  const rest = text.slice(offset);
  const highlight = rest.length > HIGHLIGHT ? words(rest.slice(0, HIGHLIGHT), "end") : rest;
  const after = text.slice(offset + highlight.length, offset + highlight.length + AFTER);
  // The nearest id at or before the place, for apps that go by fragments.
  let fragment: string | undefined;
  for (let i = 0; i <= p.block && i < blocks.length; i++) {
    for (const a of blocks[i]!.ids ?? []) if (i < p.block || a.at <= offset) fragment = a.id;
  }
  const loc: Locator = {
    href: section.href,
    type: TEXT_TYPE,
    locations: { progression: sectionProgress(ebook, p), totalProgression: bookProgress(ebook, p), ...(fragment ? { fragments: [fragment] } : {}) },
  };
  const quote: NonNullable<Locator["text"]> = {};
  if (before) quote.before = offset - BEFORE > 0 ? words(before, "start") : before;
  if (highlight) quote.highlight = highlight;
  if (after) quote.after = words(after, "end");
  if (Object.keys(quote).length > 0) loc.text = quote;
  return loc;
}

/** The place at a fraction of a section's characters. */
export function placeAtProgress(ebook: Ebook, section: number, progression: number): TextPlace {
  const blocks = ebook.sections[section]?.blocks ?? [];
  const total = blocks.reduce((n, b) => n + blockText(b).length, 0);
  let target = Math.round(Math.max(0, Math.min(1, progression)) * total);
  for (let i = 0; i < blocks.length; i++) {
    const len = blockText(blocks[i]!).length;
    if (target < len || i === blocks.length - 1) {
      const text = blockText(blocks[i]!);
      // Back to the start of the word.
      let offset = Math.min(target, len);
      while (offset > 0 && !/\s/.test(text[offset - 1]!)) offset--;
      return { section, block: i, offset };
    }
    target -= len;
  }
  return { section, block: 0, offset: 0 };
}

/**
 * Find a Locator's place in this book: its section by href (or by how far
 * through the book it was), then its words nearest the progression it
 * gives, then that progression alone.
 */
export function placeOf(ebook: Ebook, loc: Locator): TextPlace {
  let section = ebook.sections.findIndex((s) => s.href === loc.href);
  if (section < 0) {
    const total = loc.locations?.totalProgression;
    if (typeof total !== "number") return { section: firstLinear(ebook), block: 0, offset: 0 };
    section = sectionAt(ebook, total);
  }
  const progression = loc.locations?.progression ?? 0;
  const highlight = loc.text?.highlight;
  if (highlight) {
    const s = ebook.sections[section]!;
    const total = Math.max(1, s.chars);
    let best: { place: TextPlace; score: number } | null = null;
    let before = 0;
    s.blocks.forEach((b, block) => {
      const text = blockText(b);
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
  return placeAtProgress(ebook, section, progression);
}

function firstLinear(ebook: Ebook): number {
  const i = ebook.sections.findIndex((s) => s.linear);
  return i < 0 ? 0 : i;
}

/** The section a fraction of the whole book falls in. */
function sectionAt(ebook: Ebook, total: number): number {
  const linear = ebook.sections.map((s, i) => ({ s, i })).filter(({ s }) => s.linear);
  const sum = linear.reduce((n, { s }) => n + s.chars, 0);
  let target = total * sum;
  for (const { s, i } of linear) {
    if (target < s.chars) return i;
    target -= s.chars;
  }
  return linear[linear.length - 1]?.i ?? 0;
}

/** Where a book opens with no place yet: the first contents entry in the reading order, else the first linear section. */
export function startOf(ebook: Ebook): TextPlace {
  const first = firstLinear(ebook);
  return { section: first, block: 0, offset: 0 };
}

/** The contents entry a place is under: the last one at or before it. */
export function tocEntryAt(ebook: Ebook, p: TextPlace): number {
  let found = -1;
  ebook.toc.forEach((t, i) => {
    if (t.section < p.section || (t.section === p.section && t.block <= p.block)) found = i;
  });
  return found;
}

/** The text between two places, paragraphs on lines of their own, for copying. */
export function textBetween(ebook: Ebook, a: TextPlace, b: TextPlace): string {
  const [from, to] = a.section < b.section || (a.section === b.section && (a.block < b.block || (a.block === b.block && a.offset <= b.offset))) ? [a, b] : [b, a];
  const parts: string[] = [];
  for (let s = from.section; s <= to.section; s++) {
    const blocks = ebook.sections[s]?.blocks ?? [];
    const first = s === from.section ? from.block : 0;
    const last = s === to.section ? to.block : blocks.length - 1;
    for (let i = first; i <= last && i < blocks.length; i++) {
      const text = blockText(blocks[i]!);
      const start = s === from.section && i === from.block ? from.offset : 0;
      const end = s === to.section && i === to.block ? to.offset : text.length;
      // Soft hyphens are line-breaking hints, not text.
      const piece = text.slice(start, end).replace(/­/g, "");
      if (piece) parts.push(piece);
    }
  }
  return parts.join("\n\n");
}

/** Where a link inside the book goes: its section, and the block holding its fragment. */
export function placeOfHref(ebook: Ebook, href: string): TextPlace | null {
  const hash = href.indexOf("#");
  const path = hash < 0 ? href : href.slice(0, hash);
  const fragment = hash < 0 ? "" : href.slice(hash + 1);
  const section = ebook.sections.findIndex((s) => s.href === path);
  if (section < 0) return null;
  if (!fragment) return { section, block: 0, offset: 0 };
  const blocks = ebook.sections[section]!.blocks;
  for (let i = 0; i < blocks.length; i++) {
    const a = (blocks[i]!.ids ?? []).find((x) => x.id === fragment);
    if (a) return { section, block: i, offset: a.at };
  }
  return { section, block: 0, offset: 0 };
}
