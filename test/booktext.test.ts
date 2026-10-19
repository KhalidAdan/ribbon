import { describe, expect, it } from "vitest";
import { BookText, comparePlaces } from "../src/core/reading/booktext";
import { EBOOK_FORMAT, type Ebook, type EbookSection } from "../src/core/ebook";

/** A section of paragraphs, each given as its text. */
function section(href: string, paras: string[], linear = true): EbookSection {
  return { href, linear, overlay: null, chars: paras.join("").length, blocks: paras.map((t, i) => ({ k: "p" as const, runs: [{ t }], ...(i === 1 ? { ids: [{ id: "mid", at: 4 }] } : {}) })) };
}

/** Two chapters around a note out of the reading order. */
function book(): Ebook {
  return {
    format: EBOOK_FORMAT,
    meta: { title: "T", authors: [], identifiers: [], language: "en" },
    layout: "reflowable",
    sections: [section("one.xhtml", ["The waygate hung. ", "It was a giant circle."]), section("note.xhtml", ["A note."], false), section("two.xhtml", ["", "Eluadhri said nothing. Then she laughed."])],
    toc: [
      { label: "One", section: 0, block: 0, depth: 0 },
      { label: "Two", section: 2, block: 0, depth: 0 },
    ],
  };
}

describe("a book's text, and pointing into it", () => {
  it("counts characters of the reading order, a section out of it adding none", () => {
    const text = new BookText(book());
    expect(text.total).toBe(18 + 22 + 0 + 40);
    expect(text.chars({ section: 0, block: 1, offset: 3 })).toBe(21);
    // The note is where it would be, and adds nothing.
    expect(text.chars({ section: 1, block: 0, offset: 5 })).toBe(40);
    expect(text.chars({ section: 2, block: 1, offset: 0 })).toBe(40);
  });

  it("finds the place at a character, at the start of its word, skipping empty blocks, and the end past the end", () => {
    const text = new BookText(book());
    expect(text.place(23)).toEqual({ section: 0, block: 1, offset: 3 });
    expect(text.place(40)).toEqual({ section: 2, block: 1, offset: 0 });
    expect(text.place(10_000)).toEqual({ section: 2, block: 1, offset: 40 });
    for (const n of [0, 5, 18, 39, 41, 60, 79]) expect(text.chars(text.place(n))).toBeLessThanOrEqual(n);
  });

  it("gives text, sentences and contents entries", () => {
    const text = new BookText(book());
    expect(text.text({ from: { section: 0, block: 0, offset: 4 }, to: { section: 0, block: 1, offset: 5 } })).toBe("waygate hung. \n\nIt wa");
    expect(text.sentenceAt({ section: 2, block: 1, offset: 30 })).toEqual({ section: 2, block: 1, start: 23, end: 40 });
    expect(text.tocEntryAt({ section: 1, block: 0, offset: 0 })).toBe(0);
    expect(text.tocEntryAt({ section: 2, block: 1, offset: 0 })).toBe(1);
    expect(text.nextBlock(0, 1)).toEqual({ section: 1, block: 0 });
  });

  it("goes to links by id, and back and forth through Locators", () => {
    const text = new BookText(book());
    expect(text.fromHref("one.xhtml#mid")).toEqual({ section: 0, block: 1, offset: 4 });
    expect(text.fromHref("two.xhtml#nowhere")).toEqual({ section: 2, block: 0, offset: 0 });
    expect(text.fromHref("missing.xhtml")).toBeNull();
    expect(text.idAt(0, "mid")).toEqual({ section: 0, block: 1, offset: 4 });
    const place = { section: 2, block: 1, offset: 23 };
    const loc = text.locator(place);
    expect(loc.href).toBe("two.xhtml");
    expect(text.fromLocator(loc)).toEqual(place);
    expect(text.progress(place)).toBeCloseTo(63 / 80, 3);
  });

  it("orders places", () => {
    expect(comparePlaces({ section: 1, block: 0, offset: 0 }, { section: 0, block: 9, offset: 9 })).toBeGreaterThan(0);
    expect(comparePlaces({ section: 0, block: 2, offset: 1 }, { section: 0, block: 2, offset: 1 })).toBe(0);
  });
});
