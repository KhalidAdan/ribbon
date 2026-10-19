import { describe, expect, it } from "vitest";
import { openingMatch, words } from "../src/core/reading/openings";
import { alignBook } from "../src/core/reading/align";
import { EBOOK_FORMAT, type Ebook } from "../src/core/ebook";
import type { Chapter } from "../src/core/types";

describe("the narrator's opening words", () => {
  it("are words: lower case, numbers as digits, apostrophes kept inside words", () => {
    expect(words("TWO. Eluadhri – it wasn’t one of only three!")).toEqual(["2", "eluadhri", "it", "wasnt", "1", "of", "only", "3"]);
  });

  it("match the text's opening though whisper spells names its own way and says the heading", () => {
    const text = "TWO Eluadhri was one of only three planets within its system, flanked by a baked ball of rock further in towards its star";
    expect(openingMatch("2. Eloadri was one of only three planets within its system, flanked by a baked ball of rock", text)).toBeGreaterThan(0.85);
    expect(openingMatch("There is little that gives a commander of the navy such a feeling of dread", text)).toBeLessThan(0.2);
    // Too few words to say anything.
    expect(openingMatch("Two.", text)).toBe(0);
  });
});

/** Four chapters of equal length, each opening with its own words; an unnamed intro track before them, as long as a chapter. */
function equalChapters(): { ebook: Ebook; chapters: Chapter[]; durationMs: number } {
  const openings = ["The storm broke over the harbour at dawn", "Nobody in the village had seen a ship like it", "By noon the captain had gone ashore alone", "The old woman at the well watched him come"];
  const LEN = 10 * 60_000;
  const chars = Math.round(LEN * 0.016);
  const sections = openings.map((o, i) => {
    const t = `${o} ${"and so it went on ".repeat(chars / 18)}`.slice(0, chars);
    return { href: `c${i}.xhtml`, linear: true, overlay: null, chars: t.length, kind: "chapter", blocks: [{ k: "p" as const, runs: [{ t }] }] };
  });
  const ebook: Ebook = { format: EBOOK_FORMAT, meta: { title: "T", authors: [], identifiers: [] }, layout: "reflowable", sections, toc: openings.map((_, i) => ({ label: `Part ${["A", "B", "C", "D"][i]}`, section: i, block: 0, depth: 0 })) };
  const chapters: Chapter[] = Array.from({ length: 5 }, (_, i) => ({ title: `Track ${i + 1}`, startMs: i * LEN, endMs: (i + 1) * LEN }));
  return { ebook, chapters, durationMs: 5 * LEN };
}

describe("pairing by what the narrator says", () => {
  it("finds which track each chapter starts on when length cannot tell", () => {
    const { ebook, chapters, durationMs } = equalChapters();
    const heard = new Map<number, string>([
      [chapters[0]!.startMs, "Welcome to this recording, read for you by a narrator who will be with you"],
      [chapters[1]!.startMs, "Part A. The storm broke over the harbour at dawn"],
      [chapters[2]!.startMs, "Part B. Nobody in the village had seen a ship like it"],
      [chapters[3]!.startMs, "Part C. By noon the captain had gone ashore alone"],
      [chapters[4]!.startMs, "Part D. The old woman at the well watched him come"],
    ]);
    const a = alignBook(ebook, chapters, durationMs, { generated: true, heard });
    expect(a.pairs.map((p) => `${p.textLabel}=${p.audioTitle}`)).toEqual(["Part A=Track 2", "Part B=Track 3", "Part C=Track 4", "Part D=Track 5"]);
    // Heard and agreed: sure.
    expect(a.pairs.every((p) => p.confidence > 0.9)).toBe(true);
  });
});
