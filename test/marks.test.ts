import { describe, expect, it } from "vitest";
import { sentenceAt, sentencesOf } from "../src/core/reading/sentences";
import { cut, spansIn, type Span } from "../src/reader/marks";
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

const sentence = (start: number, end: number): Span => ({ start, end, tone: "sentence" });
const saved = (start: number, end: number): Span => ({ start, end, tone: "saved" });

describe("cutting a drawn fragment where marks begin and end", () => {
  it("leaves a fragment outside every mark whole", () => {
    expect(cut(10, "hello", true, [sentence(0, 9)])).toEqual([{ start: 10, text: "hello", gap: true, on: [] }]);
    expect(cut(10, "hello", false, [])).toEqual([{ start: 10, text: "hello", gap: false, on: [] }]);
  });

  it("marks the middle, each piece keeping its own offset", () => {
    expect(cut(10, "one two three", false, [sentence(14, 17)])).toEqual([
      { start: 10, text: "one ", gap: false, on: [] },
      { start: 14, text: "two", gap: false, on: ["sentence"] },
      { start: 17, text: " three", gap: false, on: [] },
    ]);
  });

  it("marks the space before a fragment only inside a mark that began before it", () => {
    // The sentence runs on from an earlier fragment: the space is part of it.
    expect(cut(10, "on", true, [sentence(2, 30)])).toEqual([{ start: 10, text: "on", gap: true, on: ["sentence"] }]);
    // The sentence starts at this fragment: the space before stays unmarked.
    expect(cut(10, "Next", true, [sentence(10, 30)])).toEqual([
      { start: 10, text: "", gap: true, on: [] },
      { start: 10, text: "Next", gap: false, on: ["sentence"] },
    ]);
  });

  it("cuts at every mark, and a piece under two marks is under both", () => {
    expect(cut(0, "one two three four", false, [saved(4, 13), sentence(8, 18)])).toEqual([
      { start: 0, text: "one ", gap: false, on: [] },
      { start: 4, text: "two ", gap: false, on: ["saved"] },
      { start: 8, text: "three", gap: false, on: ["sentence", "saved"] },
      { start: 13, text: " four", gap: false, on: ["sentence"] },
    ]);
  });

  it("gives the space before a fragment to the marks that ran on, apart from one that starts there", () => {
    expect(cut(10, "word", true, [saved(0, 20), sentence(10, 20)])).toEqual([
      { start: 10, text: "", gap: true, on: ["saved"] },
      { start: 10, text: "word", gap: false, on: ["sentence", "saved"] },
    ]);
  });
});

describe("the marks in a block", () => {
  const at = (section: number, block: number, offset: number) => ({ section, block, offset });

  it("gives a mark inside one block as its offsets", () => {
    expect(spansIn([{ from: at(1, 2, 5), to: at(1, 2, 9), tone: "saved" }], 1, 2)).toEqual([{ start: 5, end: 9, tone: "saved" }]);
    expect(spansIn([{ from: at(1, 2, 5), to: at(1, 2, 9), tone: "saved" }], 1, 3)).toEqual([]);
  });

  it("runs a mark across blocks and sections to the end and from the start of the blocks between", () => {
    const m = [{ from: at(1, 2, 5), to: at(2, 1, 4), tone: "saved" as const }];
    expect(spansIn(m, 1, 2)).toEqual([{ start: 5, end: Infinity, tone: "saved" }]);
    expect(spansIn(m, 1, 7)).toEqual([{ start: -Infinity, end: Infinity, tone: "saved" }]);
    expect(spansIn(m, 2, 0)).toEqual([{ start: -Infinity, end: Infinity, tone: "saved" }]);
    expect(spansIn(m, 2, 1)).toEqual([{ start: -Infinity, end: 4, tone: "saved" }]);
    expect(spansIn(m, 2, 2)).toEqual([]);
    expect(spansIn(m, 0, 9)).toEqual([]);
  });

  it("draws a mark that runs on into a block whole there", () => {
    const m = [{ from: at(0, 0, 3), to: at(0, 2, 2), tone: "saved" as const }];
    expect(cut(0, "middle", true, spansIn(m, 0, 1))).toEqual([{ start: 0, text: "middle", gap: true, on: ["saved"] }]);
  });
});
