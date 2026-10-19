import { describe, expect, it } from "vitest";
import { EBOOK_FORMAT, blockText, type Ebook } from "../src/core/ebook";
import { comparePlaces, highlightOf, inRange, placeAfter, rangeOf, trimRange } from "../src/core/reading/highlights";
import { textBetween, type TextPlace } from "../src/core/reading/place";

const ONE = "The waygate hung before them. It was a giant circle of wraithbone!";
// A soft hyphen inside "wraith­bone", as some EPUBs carry.
const TWO = "“Who made it?” asked Jurilan, and no one knew. The wraith­bone was cold.";
const THREE = "The light came up the steps.";

function book(): Ebook {
  const paras = [ONE, TWO];
  return {
    format: EBOOK_FORMAT,
    meta: { title: "T", authors: [], identifiers: [{ scheme: "isbn", value: "9781836093152" }], language: "en" },
    layout: "reflowable",
    sections: [
      { href: "a.xhtml", linear: true, overlay: null, chars: ONE.length + TWO.length, blocks: [...paras.map((t) => ({ k: "p" as const, runs: [{ t }] })), { k: "hr" as const }] },
      { href: "b.xhtml", linear: true, overlay: null, chars: THREE.length, blocks: [{ k: "p", runs: [{ t: THREE }] }] },
    ],
    toc: [],
  };
}

const at = (section: number, block: number, offset: number): TextPlace => ({ section, block, offset });

describe("a selection as words", () => {
  it("puts its ends in order and leaves out the spaces at either end", () => {
    const b = book();
    const from = ONE.indexOf(" It");
    const to = ONE.indexOf("circle") + "circle ".length;
    expect(trimRange(b, at(0, 0, to), at(0, 0, from))).toEqual({ from: at(0, 0, from + 1), to: at(0, 0, to - 1) });
  });

  it("takes a word cut by either end whole, apostrophes and soft hyphens inside it", () => {
    const b = book();
    // "gi|ant circle of wraith|bone": the whole of both words.
    const from = ONE.indexOf("giant") + 2;
    const to = ONE.indexOf("wraithbone") + 6;
    expect(trimRange(b, at(0, 0, from), at(0, 0, to))).toEqual({ from: at(0, 0, from - 2), to: at(0, 0, ONE.indexOf("!")) });
    // Across the soft hyphen in "wraith­bone".
    const soft = TWO.indexOf("wraith") + 3;
    expect(trimRange(b, at(0, 1, soft), at(0, 1, soft + 1))).toEqual({ from: at(0, 1, TWO.indexOf("wraith")), to: at(0, 1, TWO.indexOf(" was cold")) });
    // A comma before the first word and an opening quote after the last are left out.
    expect(trimRange(b, at(0, 1, TWO.indexOf(", and")), at(0, 1, TWO.indexOf(" no") + 1))).toEqual({ from: at(0, 1, TWO.indexOf("and")), to: at(0, 1, TWO.indexOf(" no")) });
    expect(trimRange(b, at(0, 0, ONE.indexOf("wraithbone")), at(0, 1, 1))).toEqual({ from: at(0, 0, ONE.indexOf("wraithbone")), to: at(0, 1, 0) });
    // A selection ending on punctuation stays where it ends.
    expect(trimRange(b, at(0, 0, 0), at(0, 0, ONE.indexOf(".") + 1))).toEqual({ from: at(0, 0, 0), to: at(0, 0, ONE.indexOf(".") + 1) });
  });

  it("starts in the next paragraph when it starts at the end of one", () => {
    const b = book();
    expect(trimRange(b, at(0, 0, ONE.length), at(0, 1, 4))).toEqual({ from: at(0, 1, 0), to: at(0, 1, 4) });
  });

  it("is nothing when only spaces were selected", () => {
    const b = book();
    const space = ONE.indexOf(" It");
    expect(trimRange(b, at(0, 0, space), at(0, 0, space + 1))).toBeNull();
    expect(trimRange(b, at(0, 0, 3), at(0, 0, 3))).toBeNull();
  });
});

describe("finding a highlight again", () => {
  it("walks its words from the start to their end, across paragraphs and soft hyphens", () => {
    const b = book();
    const from = at(0, 0, ONE.indexOf("circle"));
    const to = at(0, 1, TWO.indexOf(" was cold"));
    const quote = textBetween(b, from, to);
    expect(quote).toBe("circle of wraithbone!\n\n“Who made it?” asked Jurilan, and no one knew. The wraithbone");
    expect(placeAfter(b, from, quote)).toEqual(to);
  });

  it("walks into the next section, past blocks with no text", () => {
    const b = book();
    const from = at(0, 1, TWO.indexOf("The wraith"));
    const to = at(1, 0, "The light".length);
    expect(placeAfter(b, from, textBetween(b, from, to))).toEqual(to);
  });

  it("says when the text there is not the words", () => {
    expect(placeAfter(book(), at(0, 0, 0), "The gateway")).toBeNull();
    expect(placeAfter(book(), at(1, 0, 0), `${THREE}\n\nMore`)).toBeNull();
  });

  it("keeps a selection's words and places, and finds the same range from them", () => {
    const b = book();
    const range = { from: at(0, 0, ONE.indexOf("circle")), to: at(0, 1, TWO.indexOf(" asked")) };
    const h = highlightOf(b, "aec8d2c8", range);
    expect(h.ids).toEqual(["urn:ribbon:aec8d2c8-text", "urn:isbn:9781836093152"]);
    expect(h.start.href).toBe("a.xhtml");
    expect(h.start.text?.highlight?.startsWith("circle of wraithbone")).toBe(true);
    expect(h.end.text?.highlight?.startsWith(" asked Jurilan")).toBe(true);
    expect(h.quote).toBe("circle of wraithbone!\n\n“Who made it?”");
    expect(rangeOf(b, h)).toEqual(range);
  });

  it("falls back to the end's Locator when the words have changed", () => {
    const b = book();
    const range = { from: at(0, 0, ONE.indexOf("giant")), to: at(0, 0, ONE.indexOf(" of")) };
    const h = { ...highlightOf(b, "x", range), quote: "giant ring" };
    expect(rangeOf(b, h)).toEqual(range);
  });

  it("is found by offsets, not by anything drawn: another edition's paragraph before it moves it, not breaks it", () => {
    const b = book();
    const range = { from: at(0, 1, TWO.indexOf("asked")), to: at(0, 1, TWO.indexOf(",")) };
    const h = highlightOf(b, "x", range);
    const moved = book();
    moved.sections[0]!.blocks.unshift({ k: "p", runs: [{ t: "A new foreword." }] });
    moved.sections[0]!.chars += "A new foreword.".length;
    const r = rangeOf(moved, h);
    expect(r).toEqual({ from: at(0, 2, range.from.offset), to: at(0, 2, range.to.offset) });
    expect(blockText(moved.sections[0]!.blocks[2]!).slice(r.from.offset, r.to.offset)).toBe("asked Jurilan");
  });
});

describe("places in a range", () => {
  it("counts from its first character up to its end", () => {
    const r = { from: at(0, 0, 5), to: at(0, 1, 3) };
    expect(inRange(r, at(0, 0, 5))).toBe(true);
    expect(inRange(r, at(0, 0, 900))).toBe(true);
    expect(inRange(r, at(0, 1, 2))).toBe(true);
    expect(inRange(r, at(0, 1, 3))).toBe(false);
    expect(inRange(r, at(0, 0, 4))).toBe(false);
    expect(comparePlaces(at(1, 0, 0), at(0, 9, 9))).toBeGreaterThan(0);
  });
});
