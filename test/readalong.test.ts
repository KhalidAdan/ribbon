import { describe, expect, it } from "vitest";
import { EBOOK_FORMAT, type Ebook } from "../src/core/ebook";
import { BookText } from "../src/core/reading/booktext";
import { heardFromRows, pairBook, pairingFromRows, transcriptFromRows } from "../src/core/reading/narration";
import { overlayAnchors } from "../src/core/reading/overlay";
import { READ_ALONG_FORMAT, readAlongOf, sentenceAt, sentenceReadAt, sentencesIn, sentencesRange } from "../src/core/reading/readalong";

/**
 * A chapter: its heading, a paragraph of three sentences, a picture, a
 * break and one sentence after it, with a Media Overlay reading each
 * sentence three seconds apart; then notes out of the reading order.
 */
function book(): Ebook {
  const paragraph = "First sentence here. Second one follows. Third ends it.";
  return {
    format: EBOOK_FORMAT,
    meta: { title: "T", authors: [], identifiers: [] },
    layout: "reflowable",
    sections: [
      {
        href: "one.xhtml",
        linear: true,
        overlay: "one.smil",
        chars: 3 + paragraph.length + 16,
        blocks: [
          { k: "h", level: 1, runs: [{ t: "One" }] },
          { k: "p", indent: true, runs: [{ t: "First sentence here. " }, { t: "Second", i: true }, { t: " one follows. Third ends it." }], ids: [{ id: "s1", at: 0 }, { id: "s2", at: 21 }, { id: "s3", at: 41 }] },
          { k: "img", src: "picture.png", w: 10, h: 10, alt: "" },
          { k: "hr" },
          { k: "p", runs: [{ t: "After the break." }], ids: [{ id: "s4", at: 0 }] },
        ],
        narration: ["s1", "s2", "s3", "s4"].map((id, i) => ({ id, audio: "x.mp3", begin: 1000 + i * 3000, end: 4000 + i * 3000 })),
      },
      { href: "notes.xhtml", linear: false, overlay: null, chars: 9, blocks: [{ k: "p", runs: [{ t: "A note." }] }] },
    ],
    toc: [{ label: "One", section: 0, block: 0, depth: 0 }],
  };
}

const DURATION = 20_000;
const chapters = [{ startMs: 0, endMs: DURATION, title: "Chapter 1" }];

function paired(withOverlay: boolean) {
  const text = new BookText(book());
  const overlay = withOverlay ? overlayAnchors(text, { files: [{ path: "x.mp3", durationMs: DURATION }], durationMs: DURATION }) : null;
  const alignment = pairBook(text, chapters, DURATION, { fixes: [], heard: new Map(), anchors: [], overlay });
  return { text, readAlong: readAlongOf(text, alignment) };
}

describe("a read-along", () => {
  it("is the reading order's headings, paragraphs and breaks, without pictures or notes", () => {
    const { readAlong } = paired(true);
    expect(readAlong.format).toBe(READ_ALONG_FORMAT);
    expect(readAlong.blocks.map((b) => b.k)).toEqual(["h", "p", "hr", "p"]);
    expect(readAlong.blocks[0]).toMatchObject({ k: "h", level: 1, runs: [{ t: "One" }] });
    expect(readAlong.blocks[1]).toMatchObject({ indent: true, runs: [{ t: "First sentence here. " }, { t: "Second", i: true }, { t: " one follows. Third ends it." }] });
    expect(readAlong.contents).toEqual([{ title: "One", block: 0 }]);
  });

  it("says when each sentence is read, exactly where the narration is placed to the sentence", () => {
    const { readAlong } = paired(true);
    const sentences = readAlong.blocks[1]!.sentences!;
    expect(sentences.map((s) => [s.start, s.end])).toEqual([
      [0, 20],
      [21, 40],
      [41, 55],
    ]);
    expect(sentences.map((s) => s.ms)).toEqual([1000, 4000, 7000]);
    expect(sentences.every((s) => s.exact && s.endMs > s.ms)).toBe(true);
    expect(readAlong.blocks[3]!.sentences![0]).toMatchObject({ ms: 10_000, exact: true });
  });

  it("marks nothing exact when the text is paired with the audio only by its chapters", () => {
    const { readAlong } = paired(false);
    const all = readAlong.blocks.flatMap((b) => b.sentences ?? []);
    expect(all.some((s) => s.exact)).toBe(false);
    // Still in order through the chapter, so a sentence can be listened from.
    expect(all.map((s) => s.ms)).toEqual([...all.map((s) => s.ms)].sort((a, b) => a - b));
  });

  it("names a place in the text by the sentence it's in, counted across the book", () => {
    const { text } = paired(true);
    expect(sentenceAt(text, { section: 0, block: 0, offset: 0 })).toBe(0);
    expect(sentenceAt(text, { section: 0, block: 1, offset: 25 })).toBe(2);
    // Between two sentences: the next one.
    expect(sentenceAt(text, { section: 0, block: 1, offset: 20 })).toBe(2);
    // In the picture, which isn't shown: the sentence after it.
    expect(sentenceAt(text, { section: 0, block: 2, offset: 0 })).toBe(4);
    expect(sentenceAt(text, { section: 1, block: 0, offset: 3 })).toBe(4);
  });

  it("finds whole sentences in the text, and the sentences words are in", () => {
    const { text } = paired(true);
    const two = sentencesRange(text, 1, 2)!;
    expect(text.text(two)).toBe("First sentence here. Second one follows.");
    expect(sentencesIn(text, two)).toEqual({ first: 1, last: 2 });
    // Across the break between scenes, which has no sentences.
    const across = sentencesRange(text, 3, 4)!;
    expect(text.text(across)).toBe("Third ends it.\n\nAfter the break.");
    expect(sentencesIn(text, across)).toEqual({ first: 3, last: 4 });
    // One sentence, and words inside one.
    expect(sentencesIn(text, sentencesRange(text, 2, 2)!)).toEqual({ first: 2, last: 2 });
    expect(sentencesIn(text, { from: { section: 0, block: 1, offset: 3 }, to: { section: 0, block: 1, offset: 9 } })).toEqual({ first: 1, last: 1 });
    expect(sentencesRange(text, 4, 5)).toBeNull();
  });

  it("finds the sentence being read at a moment of the recording", () => {
    const { readAlong } = paired(true);
    expect(sentenceReadAt(readAlong, 0)).toBe(0);
    expect(sentenceReadAt(readAlong, 5_500)).toBe(2);
    expect(sentenceReadAt(readAlong, 7_000)).toBe(3);
    expect(sentenceReadAt(readAlong, 19_000)).toBe(4);
  });
});

describe("a book's narration records", () => {
  it("are read from their rows as the apps and the server keep them", () => {
    expect(pairingFromRows([{ text: "one.xhtml#0", audio_ms: "1200" }, { text: "notes.xhtml#0", audio_ms: "" }, { text: "", audio_ms: "5" }])).toEqual([
      { text: "one.xhtml#0", audioMs: 1200 },
      { text: "notes.xhtml#0", audioMs: null },
    ]);
    const heard = heardFromRows([{ audio_ms: "1000", words: "first sentence", chars: "3" }, { audio_ms: "9000", words: "unheard", chars: "" }]);
    expect([...heard.heard]).toEqual([
      [1000, "first sentence"],
      [9000, "unheard"],
    ]);
    expect([...heard.anchors]).toEqual([[1000, 3]]);
    const transcript = transcriptFromRows([
      { start_ms: "0", end_ms: "60000", words: "", chars: "" },
      { start_ms: "1000", end_ms: "3800", words: "First sentence here.", chars: "3" },
      { start_ms: "4000", end_ms: "6500", words: "Second one follows", chars: "" },
    ]);
    expect([...transcript.spans]).toEqual([[0, 60_000]]);
    expect(transcript.said.map((s) => s.chars)).toEqual([3, null]);
  });
});
