import { describe, expect, it } from "vitest";
import { flow, pageOf, paginate, placeAtY, yOfPlace, type LaidBlock, type Line } from "../src/core/reading/pages";
import { BookText } from "../src/core/reading/booktext";
import { EBOOK_FORMAT, type Ebook, type EbookBlock } from "../src/core/ebook";

const LH = 10;

/** A paragraph of n lines, each 10 characters of the block. */
function para(block: number, n: number, extra: Partial<LaidBlock> = {}): LaidBlock {
  const lines: Line[] = Array.from({ length: n }, (_, i) => ({ frags: [{ text: "x", gap: false, start: i * 10, end: i * 10 + 10 }], start: i * 10, end: i * 10 + 10, width: 100 }));
  return { section: 0, block, kind: "p", lines, lineHeight: LH, size: 10, before: 0, indent: 0, inset: 0, align: "start", ...extra };
}

const heading = (block: number) => para(block, 1, { kind: "h", before: 20 });
const image = (block: number, h: number): LaidBlock => ({ ...para(block, 0), kind: "img", lineHeight: h, image: { src: "a.png", width: 10, height: h, alt: "", tone: "picture" } });

/** Each page as "block:line" items. */
const shape = (blocks: LaidBlock[], height: number, sink = 0) => paginate(0, blocks, height, sink).map((p) => p.items.map((i) => `${blocks[i.at]!.block}:${i.line}`));

describe("pages", () => {
  it("fills a page and carries the rest over", () => {
    expect(shape([para(0, 2), para(1, 4)], 50)).toEqual([
      ["0:0", "0:1", "1:0", "1:1"],
      ["1:2", "1:3"],
    ]);
  });

  it("never leaves a paragraph's first line alone at a page's foot", () => {
    // Four lines of room: the first paragraph takes three, the second would leave one.
    expect(shape([para(0, 3), para(1, 4)], 40)).toEqual([
      ["0:0", "0:1", "0:2"],
      ["1:0", "1:1", "1:2", "1:3"],
    ]);
  });

  it("never carries a paragraph's last line alone to the next page", () => {
    // Five lines of a six-line paragraph would fit; four go, so two follow.
    expect(shape([para(0, 6)], 50)).toEqual([
      ["0:0", "0:1", "0:2", "0:3"],
      ["0:4", "0:5"],
    ]);
  });

  it("keeps a heading with the start of what follows", () => {
    const pages = shape([para(0, 3), heading(1), para(2, 4)], 70);
    expect(pages[0]).toEqual(["0:0", "0:1", "0:2"]);
    expect(pages[1]![0]).toBe("1:0");
  });

  it("starts an image too tall for the rest of the page on the next", () => {
    expect(shape([para(0, 3), image(1, 25), para(2, 1)], 40)).toEqual([["0:0", "0:1", "0:2"], ["1:-1", "2:0"]]);
  });

  it("sinks a chapter that opens with a heading, and places a page by its first line", () => {
    const pages = paginate(0, [heading(0), para(1, 8)], 60, 20);
    expect(pages[0]!.items[0]!.y).toBe(20);
    expect(pages[1]!.start).toEqual({ block: 1, offset: pages[1]!.start.offset });
    expect(pageOf(pages, { block: 1, offset: 0 })).toBe(0);
    expect(pageOf(pages, pages[1]!.start)).toBe(1);
    expect(pageOf(pages, { block: 1, offset: 79 })).toBe(pages.length - 1);
  });

  it("flows the same lines into one column for scrolling", () => {
    const blocks = [para(0, 2), para(1, 2, { before: 5 })];
    const f = flow(0, blocks);
    expect(f.items.map((i) => i.y)).toEqual([0, 10, 25, 35]);
    expect(f.height).toBe(45);
    expect(placeAtY(blocks, f, 12)).toEqual({ block: 0, offset: 10 });
    expect(placeAtY(blocks, f, 21)).toEqual({ block: 1, offset: 0 });
    expect(yOfPlace(blocks, f, { block: 1, offset: 15 })).toBe(35);
  });
});

const p = (t: string, ids?: EbookBlock["ids"]): EbookBlock => ({ k: "p", runs: [{ t }], ...(ids ? { ids } : {}) });
const book: Ebook = {
  format: EBOOK_FORMAT,
  meta: { title: "T", authors: [], identifiers: [] },
  layout: "reflowable",
  sections: [
    { href: "cover.xhtml", linear: false, overlay: null, chars: 5, blocks: [p("Cover")] },
    { href: "one.xhtml", linear: true, overlay: null, chars: 0, blocks: [{ k: "h", runs: [{ t: "ONE" }], ids: [{ id: "one", at: 0 }] }, p("It was a giant circle of wraithbone, and at fully five miles across it was of sufficient size."), p("The ship was not one of those giants, although it was a formidable vessel nonetheless.", [{ id: "mid", at: 4 }])] },
    { href: "two.xhtml", linear: true, overlay: null, chars: 0, blocks: [p("Two begins here and goes on.")] },
  ],
  toc: [
    { label: "One", section: 1, block: 0, depth: 0 },
    { label: "Two", section: 2, block: 0, depth: 0 },
  ],
};
for (const s of book.sections) s.chars = s.blocks.reduce((n, b) => n + (b.runs ?? []).map((r) => r.t).join("").length, 0);

describe("places in the text", () => {
  it("say how far through the section and the book they are, counting only the reading order", () => {
    expect(new BookText(book).sectionProgress({ section: 1, block: 0, offset: 0 })).toBe(0);
    expect(new BookText(book).progress({ section: 2, block: 0, offset: 0 })).toBeCloseTo(book.sections[1]!.chars / (book.sections[1]!.chars + book.sections[2]!.chars), 3);
  });

  it("become a Readium Locator with the words at the place, and come back from it", () => {
    const place = { section: 1, block: 2, offset: 9 };
    const loc = new BookText(book).locator(place);
    expect(loc.href).toBe("one.xhtml");
    expect(loc.type).toBe("application/xhtml+xml");
    expect(loc.locations?.fragments).toEqual(["mid"]);
    expect(loc.text?.highlight?.startsWith("was not one of those giants")).toBe(true);
    expect(loc.text?.highlight?.endsWith(" ")).toBe(false);
    expect(new BookText(book).fromLocator(loc)).toEqual(place);
  });

  it("are found by their words even when the progression has drifted, and by progression when the words are gone", () => {
    const loc = new BookText(book).locator({ section: 1, block: 1, offset: 9 });
    expect(new BookText(book).fromLocator({ ...loc, locations: { progression: 0.9 } })).toEqual({ section: 1, block: 1, offset: 9 });
    const lost = new BookText(book).fromLocator({ href: "one.xhtml", locations: { progression: 0.6 }, text: { highlight: "nowhere in this book" } });
    expect(lost.section).toBe(1);
    expect(lost.block).toBe(2);
    const text = book.sections[1]!.blocks[2]!.runs![0]!.t;
    expect(lost.offset === 0 || /\s/.test(text[lost.offset - 1]!)).toBe(true);
    // An href this book does not have: by how far through the book.
    expect(new BookText(book).fromLocator({ href: "elsewhere.xhtml", locations: { totalProgression: 0.95 } }).section).toBe(2);
    expect(new BookText(book).placeAtProgress(2, 1).block).toBe(0);
  });

  it("know which contents entry they are under", () => {
    expect(new BookText(book).tocEntryAt({ section: 1, block: 2, offset: 0 })).toBe(0);
    expect(new BookText(book).tocEntryAt({ section: 2, block: 0, offset: 3 })).toBe(1);
    expect(new BookText(book).tocEntryAt({ section: 0, block: 0, offset: 0 })).toBe(-1);
  });
});
