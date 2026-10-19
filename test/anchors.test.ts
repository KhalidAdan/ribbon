import { describe, expect, it } from "vitest";
import { locate, wordIndex } from "../src/core/reading/anchors";
import { alignBook, msToText, textToMs } from "../src/core/reading/align";
import { EBOOK_FORMAT, type Ebook } from "../src/core/ebook";

const MIN = 60_000;

/** One chapter of numbered sentences, so every place has its own words. */
function book(): { ebook: Ebook; text: string } {
  const sentences = Array.from({ length: 400 }, (_, i) => `Sentence ${i} tells of the ${["red", "grey", "silver", "black", "gold"][i % 5]} ship number ${i * 7} sailing ${["north", "south", "east", "west"][i % 4]}.`);
  const text = sentences.join(" ");
  return {
    text,
    ebook: { format: EBOOK_FORMAT, meta: { title: "T", authors: [], identifiers: [] }, layout: "reflowable", sections: [{ href: "c.xhtml", linear: true, overlay: null, chars: text.length, kind: "chapter", blocks: [{ k: "p", runs: [{ t: text }] }] }], toc: [{ label: "One", section: 0, block: 0, depth: 0 }] },
  };
}

describe("checkpoints inside chapters", () => {
  it("find heard words where they begin, not a few words early", () => {
    const { ebook, text } = book();
    const index = wordIndex(ebook);
    const truth = text.indexOf("Sentence 200 ");
    const heard = "Sentence 200 tells of the red ship number 1400 sailing north. Sentence 201 tells of the grey ship";
    const found = locate(index, heard, truth + 900, 3000);
    expect(found).not.toBeNull();
    expect(found!.chars).toBe(truth);
    // Words from nowhere near are not found.
    expect(locate(index, "Call me Ishmael. Some years ago, never mind how long precisely", truth, 3000)).toBeNull();
  });

  it("map between checkpoints instead of across the whole chapter", () => {
    const { ebook, text } = book();
    const chapters = [{ title: "Chapter 1", startMs: 0, endMs: 40 * MIN }];
    const plain = alignBook(ebook, chapters, 40 * MIN);
    // The narrator was slow for the first half: the middle of the text is read at 30 minutes, not 20.
    const middle = Math.round(text.length / 2);
    const anchored = alignBook(ebook, chapters, 40 * MIN, { anchors: [{ ms: 30 * MIN, chars: middle }] });
    expect(Math.abs(textToMs(plain, middle) - 20 * MIN)).toBeLessThan(1000);
    expect(textToMs(anchored, middle)).toBe(30 * MIN);
    expect(msToText(anchored, 15 * MIN)).toBe(Math.round(middle / 2));
    // A checkpoint that runs backwards against another is left out.
    const crossed = alignBook(ebook, chapters, 40 * MIN, { anchors: [{ ms: 10 * MIN, chars: middle }, { ms: 20 * MIN, chars: Math.round(middle / 2) }] });
    expect(crossed.pairs[0]!.points).toHaveLength(3);
  });
});
