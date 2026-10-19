import { describe, expect, it } from "vitest";
import { wordIndex } from "../src/core/reading/anchors";
import { matchTranscript } from "../src/core/reading/transcript";
import { EBOOK_FORMAT, type Ebook } from "../src/core/ebook";
import { BookText } from "../src/core/reading/booktext";

const paras = [
  "The waygate hung in the void before them. It was a giant circle of wraithbone, and at fully forty feet across it dwarfed the Aeldari who stood before it.",
  "Eluadhri watched the runes along its rim kindle one by one. ‘Is it ready?’ she asked. Jurilan did not answer at once.",
  "Somewhere beyond, the webway waited, older than any of them, patient as stone.",
];

function book(): Ebook {
  return {
    format: EBOOK_FORMAT,
    meta: { title: "T", authors: [], identifiers: [] },
    layout: "reflowable",
    sections: [{ href: "a.xhtml", linear: true, overlay: null, chars: paras.join("").length, blocks: paras.map((t) => ({ k: "p" as const, runs: [{ t }] })) }],
    toc: [],
  };
}

const at = (s: string) => paras.join("").indexOf(s);

describe("matching a transcribed stretch to the text", () => {
  it("puts a checkpoint where each phrase begins, through mishearings and skipped words", () => {
    const index = wordIndex(new BookText(book()));
    const said = [
      { startMs: 61_000, endMs: 64_200, words: " The waygate hung in the void before them." },
      { startMs: 64_200, endMs: 70_000, words: " It was a giant circle of wraith bone and at fully 40 feet across it dwarfed the Eldar who stood before it." },
      { startMs: 70_400, endMs: 74_000, words: " Eloadri watched the runes along its rim kindle one by one." },
      { startMs: 74_000, endMs: 76_500, words: " Is it ready, she asked." },
    ];
    const m = matchTranscript(index, said, 0, 10_000);
    expect(m.matched / m.heard).toBeGreaterThan(0.8);
    expect(m.anchors).toEqual([
      { ms: 61_000, chars: at("The waygate") },
      { ms: 64_200, chars: at("It was") },
      // Eloadri is too far from Eluadhri to be sure of: the phrase is placed by its next word, a share of the way in.
      { ms: 70_400 + Math.round(3600 / 11), chars: at("watched") },
      { ms: 74_000, chars: at("Is it ready") },
    ]);
  });

  it("finds nothing in text the stretch is not from", () => {
    const index = wordIndex(new BookText(book()));
    const m = matchTranscript(index, [{ startMs: 0, endMs: 9000, words: "This is Audible. Voidscarred, by Mike Brooks, narrated by somebody else entirely, copyright twenty twenty five." }], 0, 10_000);
    expect(m.anchors).toEqual([]);
  });
});
