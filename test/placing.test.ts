import { describe, expect, it } from "vitest";
import { alignBook } from "../src/core/reading/align";
import { wordIndex } from "../src/core/reading/anchors";
import { BookText } from "../src/core/reading/booktext";
import { EBOOK_FORMAT, type Ebook, type EbookSection } from "../src/core/ebook";
import { backbone, placeTranscript } from "../src/core/reading/placing";
import { placeStretch, type Said } from "../src/core/reading/transcript";

/** Made-up words, the same every run: a book whose runs of five words are each in it once. */
function sentences(count: number, seed: number): string[] {
  const syllables = ["ka", "lo", "mi", "ren", "tor", "va", "shi", "dun", "pel", "ar", "eth", "quo", "zim", "bra", "nol"];
  let x = seed;
  const next = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  const word = () => Array.from({ length: 2 + Math.floor(next() * 2) }, () => syllables[Math.floor(next() * syllables.length)]).join("");
  return Array.from({ length: count }, () => {
    const s = Array.from({ length: 8 + Math.floor(next() * 6) }, word).join(" ");
    return s[0]!.toUpperCase() + s.slice(1) + ".";
  });
}

const section = (href: string, text: string): EbookSection => ({ href, linear: true, overlay: null, chars: text.length, blocks: [{ k: "p", runs: [{ t: text }] }] });

/**
 * Saturnine's opening (#163): a long cast list the narrator never reads,
 * then the prologue he does, one sentence every five seconds from half a
 * minute in.
 */
function saturnine() {
  const cast = sentences(140, 7).join(" ");
  const prologue = sentences(60, 11);
  const ebook: Ebook = { format: EBOOK_FORMAT, meta: { title: "Saturnine", authors: [], identifiers: [] }, layout: "reflowable", sections: [section("cast.xhtml", cast), section("prologue.xhtml", prologue.join(" "))], toc: [{ label: "Dramatis Personae", section: 0, block: 0, depth: 0 }, { label: "Prologue", section: 1, block: 0, depth: 0 }] };
  const text = new BookText(ebook);
  const at: number[] = [];
  let offset = text.chars({ section: 1, block: 0, offset: 0 });
  for (const s of prologue) {
    at.push(offset);
    offset += s.length + 1;
  }
  const said: Said[] = prologue.map((words, i) => ({ startMs: 30_000 + i * 5000, endMs: 34_500 + i * 5000, words: words.toLowerCase() }));
  const durationMs = 30_000 + prologue.length * 5000;
  return { text, at, said, durationMs };
}

describe("a whole transcript placed by what was said (#163)", () => {
  it("finds the prologue behind a cast list nobody reads, where looking near the chapters' guess finds nothing", () => {
    const { text, at, said, durationMs } = saturnine();
    const index = wordIndex(text);
    // The old way: the first minute looked for near where the book's proportion puts it, which is in the cast list.
    const guess = alignBook(text, [{ title: "Dramatis Personae", startMs: 0, endMs: durationMs }], durationMs);
    const near = placeStretch(index, guess, { startMs: 0, endMs: 60_000 }, said.filter((s) => s.startMs < 60_000));
    expect(near.said.every((s) => s.chars === null)).toBe(true);
    // Placed by what was said: every sentence found where it starts.
    const placed = placeTranscript(index, said);
    expect(placed.map((p) => p.chars)).toEqual(at);
  });

  it("still finds a phrase with a word misheard, by the words around it", () => {
    const { text, at, said } = saturnine();
    const misheard = said.map((s, i) => (i === 20 ? { ...s, words: s.words.replace(/^\S+ \S+/, (two) => two.split(" ")[0] + " eloadri") } : s));
    const placed = placeTranscript(wordIndex(text), misheard);
    expect(placed[20]!.chars).toBe(at[20]);
  });

  it("keeps a backbone that only goes forward: a passage heard again later doesn't pull it back", () => {
    const { text, said } = saturnine();
    // The narrator reads an early sentence again near the end (a recap), heard after everything else.
    const recap = { ...said[5]!, startMs: said.at(-1)!.endMs + 1000, endMs: said.at(-1)!.endMs + 5500 };
    const points = backbone(wordIndex(text), [...said, recap]);
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!.ms).toBeGreaterThanOrEqual(points[i - 1]!.ms);
      expect(points[i]!.chars).toBeGreaterThan(points[i - 1]!.chars);
    }
    expect(points.some((p) => p.ms >= recap.startMs)).toBe(false);
  });
});
