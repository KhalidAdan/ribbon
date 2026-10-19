import { describe, expect, it } from "vitest";
import { overlayAnchors } from "../src/core/reading/overlay";
import { alignBook, byOverlay, msToText, precise, textToMs } from "../src/core/reading/align";
import { EBOOK_FORMAT, type Ebook, type EbookSection } from "../src/core/ebook";
import { BookText } from "../src/core/reading/booktext";

/** A chapter of three sentences, each an element with an id, read from `at` in `audio`. */
function chapter(href: string, audio: string, at: number): EbookSection {
  const sentences = ["First sentence here. ", "Second one follows. ", "Third ends it."];
  let n = 0;
  const ids = sentences.map((s, i) => {
    const id = `${href}-s${i}`;
    const a = { id, at: n };
    n += s.length;
    return a;
  });
  return {
    href,
    linear: true,
    overlay: `${href}.smil`,
    chars: n,
    blocks: [{ k: "p", runs: [{ t: sentences.join("") }], ids }],
    narration: ids.map((x, i) => ({ id: x.id, audio, begin: at + i * 3000, end: at + (i + 1) * 3000 })),
  };
}

function book(audio: [string, string]): Ebook {
  return { format: EBOOK_FORMAT, meta: { title: "T", authors: [], identifiers: [] }, layout: "reflowable", sections: [chapter("a.xhtml", audio[0], 1000), chapter("b.xhtml", audio[1], 500)], toc: [{ label: "One", section: 0, block: 0, depth: 0 }, { label: "Two", section: 1, block: 0, depth: 0 }] };
}

describe("a Media Overlay as points of the recording", () => {
  it("places each passage by the audiobook file of the same name", () => {
    const e = book(["OEBPS/Audio/Part 01.mp3", "OEBPS/Audio/Part 02.mp3"]);
    const anchors = overlayAnchors(new BookText(e), { files: [{ path: "Book/part 01.m4a", durationMs: 60_000 }, { path: "Book/part 02.m4a", durationMs: 60_000 }], durationMs: 120_000 });
    expect(anchors).toEqual([
      { ms: 1000, chars: 0 },
      { ms: 4000, chars: 21 },
      { ms: 7000, chars: 41 },
      { ms: 60_500, chars: 55 },
      { ms: 63_500, chars: 76 },
      { ms: 66_500, chars: 96 },
    ]);
  });

  it("takes files in order when together they are as long as the audiobook, and refuses another recording", () => {
    const e = book(["one.mp4", "two.mp4"]);
    // Each file is as long as its last passage: 10 s and 9.5 s, stretched to the recording's 19.5 s.
    const same = overlayAnchors(new BookText(e), { files: [{ path: "x.mp3", durationMs: 19_500 }], durationMs: 19_500 });
    expect(same?.[3]).toEqual({ ms: 10_000 + 500, chars: 55 });
    expect(overlayAnchors(new BookText(e), { files: [{ path: "x.mp3", durationMs: 600_000 }], durationMs: 600_000 })).toBeNull();
  });

  it("maps exactly, and says a moment is placed to the sentence", () => {
    const e = book(["Part 01.mp3", "Part 02.mp3"]);
    const files = [{ path: "Part 01.mp3", durationMs: 60_000 }, { path: "Part 02.mp3", durationMs: 60_000 }];
    const chapters = [{ title: "One", startMs: 0, endMs: 60_000 }, { title: "Two", startMs: 60_000, endMs: 120_000 }];
    const a = byOverlay(new BookText(e), alignBook(new BookText(e), chapters, 120_000), overlayAnchors(new BookText(e), { files, durationMs: 120_000 })!, 120_000);
    expect(a.how).toBe("overlay");
    expect(textToMs(a, 21)).toBe(4000);
    expect(msToText(a, 63_500)).toBe(76);
    expect(precise(a, 5000)).toBe(true);
    // Between the chapters' last and first passages, 50 s apart: not to the sentence.
    expect(precise(a, 30_000)).toBe(false);
    // Paired by chapters alone, nothing is.
    expect(precise(alignBook(new BookText(e), chapters, 120_000), 5000)).toBe(false);
  });
});
