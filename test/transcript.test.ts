import { describe, expect, it } from "vitest";
import { wordIndex } from "../src/core/reading/anchors";
import { matchTranscript, narrationLanguage, placeStretch, stretchesOf } from "../src/core/reading/transcript";
import { mergeTranscripts, transcriptFromRows, transcriptRows } from "../src/core/reading/narration";
import { alignBook } from "../src/core/reading/align";
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

describe("the narration, a minute at a time", () => {
  it("is heard in the same minutes everywhere: from the start of each file, the last one shorter", () => {
    expect(stretchesOf([{ durationMs: 90_000 }, { durationMs: 60_500 }])).toEqual([
      { startMs: 0, endMs: 60_000, file: 0, offset: 0 },
      { startMs: 60_000, endMs: 90_000, file: 0, offset: 60_000 },
      // Under a second left over is no stretch of its own.
      { startMs: 90_000, endMs: 150_000, file: 1, offset: 0 },
    ]);
  });

  it("is placed in the text where the pairing puts it, each phrase found starting at its checkpoint", () => {
    const text = new BookText(book());
    const alignment = alignBook(text, [{ title: "One", startMs: 60_000, endMs: 80_000 }], 80_000, { generated: false, fixes: [], heard: new Map(), anchors: [] });
    const said = [
      { startMs: 61_000, endMs: 64_200, words: "The waygate hung in the void before them." },
      { startMs: 64_300, endMs: 65_000, words: "Uh." },
    ];
    const placed = placeStretch(wordIndex(text), alignment, { startMs: 60_000, endMs: 80_000 }, said);
    expect(placed.said).toEqual([
      { ...said[0], chars: at("The waygate") },
      { ...said[1], chars: null },
    ]);
    expect(placed.anchors).toEqual([{ ms: 61_000, chars: at("The waygate") }]);
  });

  it("is merged from every device that heard it: every stretch, each phrase once, nothing taken away", () => {
    const theirs = transcriptFromRows(transcriptRows({ spans: new Map([[0, 60_000]]), said: [{ startMs: 1000, endMs: 2000, words: "Before", chars: 4 }] }));
    const ours = { spans: new Map([[60_000, 120_000]]), said: [{ startMs: 1000, endMs: 2000, words: "Before", chars: 5 }, { startMs: 61_000, endMs: 62_000, words: "After", chars: 90 }] };
    const both = mergeTranscripts(theirs, ours);
    expect([...both.spans]).toEqual([
      [0, 60_000],
      [60_000, 120_000],
    ]);
    // The same phrase heard twice is one, and this device's word for where it is wins.
    expect(both.said).toEqual(ours.said);
    expect(transcriptRows(both).map((r) => r.start_ms)).toEqual(["0", "1000", "60000", "61000"]);
  });

  it("is heard in the EPUB's language, else the audiobook's, as two letters", () => {
    expect(narrationLanguage("en-GB", "fr")).toBe("en");
    expect(narrationLanguage("", "eng")).toBe("en");
    expect(narrationLanguage(undefined, "")).toBeNull();
  });
});
