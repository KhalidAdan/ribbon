import { describe, expect, it } from "vitest";
import { sentenceAt, sentencesOf } from "../src/core/reading/sentences";
import { cut } from "../src/reader/marks";
import { EBOOK_FORMAT, type Ebook } from "../src/core/ebook";

const para = "The waygate hung before them. It was a giant circle of wraithbone! “Who made it?” asked Jurilan.";

function book(): Ebook {
  return {
    format: EBOOK_FORMAT,
    meta: { title: "T", authors: [], identifiers: [], language: "en" },
    layout: "reflowable",
    sections: [{ href: "a.xhtml", linear: true, overlay: null, chars: para.length, blocks: [{ k: "p", runs: [{ t: "The waygate hung " }, { t: "before", i: true }, { t: " them. It was a giant circle of wraithbone! “Who made it?” asked Jurilan." }] }] }],
    toc: [],
  };
}

describe("sentences", () => {
  it("split a block's text into sentences without their trailing spaces", () => {
    const s = sentencesOf(book().sections[0]!.blocks[0]!, "en");
    expect(s.map((x) => para.slice(x.start, x.end))).toEqual(["The waygate hung before them.", "It was a giant circle of wraithbone!", "“Who made it?” asked Jurilan."]);
  });

  it("find the sentence a place is in, and the next one from the space between", () => {
    const b = book();
    const at = (offset: number) => {
      const s = sentenceAt(b, { section: 0, block: 0, offset });
      return s && para.slice(s.start, s.end);
    };
    expect(at(0)).toBe("The waygate hung before them.");
    expect(at(para.indexOf("circle"))).toBe("It was a giant circle of wraithbone!");
    expect(at(para.indexOf(" It"))).toBe("It was a giant circle of wraithbone!");
    expect(sentenceAt(b, { section: 0, block: 3, offset: 0 })).toBeNull();
  });
});

describe("cutting a drawn fragment where a mark begins and ends", () => {
  it("leaves a fragment outside the mark whole", () => {
    expect(cut(10, "hello", true, { start: 0, end: 9 })).toEqual([{ start: 10, text: "hello", gap: true, on: false }]);
    expect(cut(10, "hello", false, undefined)).toEqual([{ start: 10, text: "hello", gap: false, on: false }]);
  });

  it("marks the middle, each piece keeping its own offset", () => {
    expect(cut(10, "one two three", false, { start: 14, end: 17 })).toEqual([
      { start: 10, text: "one ", gap: false, on: false },
      { start: 14, text: "two", gap: false, on: true },
      { start: 17, text: " three", gap: false, on: false },
    ]);
  });

  it("marks the space before a fragment only inside a sentence that began before it", () => {
    // The sentence runs on from an earlier fragment: the space is part of it.
    expect(cut(10, "on", true, { start: 2, end: 30 })).toEqual([{ start: 10, text: "on", gap: true, on: true }]);
    // The sentence starts at this fragment: the space before stays unmarked.
    expect(cut(10, "Next", true, { start: 10, end: 30 })).toEqual([
      { start: 10, text: "", gap: true, on: false },
      { start: 10, text: "Next", gap: false, on: true },
    ]);
  });
});
