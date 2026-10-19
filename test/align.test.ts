import { describe, expect, it } from "vitest";
import { alignBook, chapterKey, globalOffset, msToText, placeAtGlobal, textToMs } from "../src/core/reading/align";
import { EBOOK_FORMAT, type Ebook, type EbookSection } from "../src/core/ebook";
import type { Chapter } from "../src/core/types";

const MIN = 60_000;
/** Characters per millisecond: about 160 words a minute. */
const PACE = 0.016;

/** A section of n characters, as words of five letters. */
function section(href: string, chars: number, linear = true): EbookSection {
  const text = "aaaa ".repeat(Math.ceil(chars / 5)).slice(0, chars);
  return { href, linear, overlay: null, chars, blocks: [{ k: "p", runs: [{ t: text }] }] };
}

const WORDS = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];

/** Voidscarred's shape: front matter, a journal extract read as the epigraph, numbered chapters, an epilogue, back matter. */
function voidscarred(): { ebook: Ebook; chapters: Chapter[]; durationMs: number } {
  const lengths = WORDS.map((_, i) => (20 + (i % 4) * 5) * MIN);
  const sections: EbookSection[] = [section("cover.xhtml", 0), section("title.xhtml", 60), section("cast.xhtml", 1300), section("journal.xhtml", Math.round(3.3 * MIN * PACE))];
  const toc = [
    { label: "Cover", section: 0, block: 0, depth: 0 },
    { label: "Voidscarred", section: 1, block: 0, depth: 0 },
    { label: "Dramatis Personae", section: 2, block: 0, depth: 1 },
    { label: "Journal extract", section: 3, block: 0, depth: 1 },
  ];
  WORDS.forEach((w, i) => {
    toc.push({ label: w, section: sections.length, block: 0, depth: 1 });
    sections.push(section(`ch${i + 1}.xhtml`, Math.round(lengths[i]! * PACE * (i === 5 ? 0.9 : 1))));
  });
  toc.push({ label: "Epilogue", section: sections.length, block: 0, depth: 1 });
  sections.push(section("epilogue.xhtml", Math.round(4 * MIN * PACE)));
  toc.push({ label: "About the Author", section: sections.length, block: 0, depth: 0 });
  sections.push(section("about.xhtml", 1100));
  const ebook: Ebook = { format: EBOOK_FORMAT, meta: { title: "Voidscarred", authors: [], identifiers: [] }, layout: "reflowable", sections, toc };

  const chapters: Chapter[] = [];
  let t = 0;
  const add = (title: string, ms: number) => {
    chapters.push({ title, startMs: t, endMs: t + ms });
    t += ms;
  };
  add("Opening Credits", 36_000);
  add("Epigraph", 3.3 * MIN);
  WORDS.forEach((_, i) => add(`Chapter ${i + 1}`, lengths[i]!));
  add("Epilogue", 4 * MIN);
  add("End Credits", 42_000);
  return { ebook, chapters, durationMs: t };
}

describe("chapter names, compared", () => {
  it("read numbers in words, digits and Roman numerals as one", () => {
    expect(chapterKey("Twenty-one")).toBe("21");
    expect(chapterKey("Chapter 21")).toBe("21");
    expect(chapterKey("CHAPTER XXI")).toBe("21");
    expect(chapterKey("Thirty-Three")).toBe("33");
    expect(chapterKey("One Hundred and Two")).toBe("102");
    expect(chapterKey("Epilogue")).toBe("epilogue");
    expect(chapterKey("Journal extract")).toBe("journal extract");
  });
});

describe("pairing the text's chapters with the audio's", () => {
  it("pairs Voidscarred by name, the journal extract with the epigraph by pace, and leaves the cast list and credits alone", () => {
    const { ebook, chapters, durationMs } = voidscarred();
    const a = alignBook(ebook, chapters, durationMs);
    expect(a.how).toBe("chapter");
    const pairs = a.pairs.map((p) => `${p.textLabel}=${p.audioTitle}`);
    expect(pairs[0]).toBe("Journal extract=Epigraph");
    expect(pairs[1]).toBe("One=Chapter 1");
    expect(pairs).toContain("Twelve=Chapter 12");
    expect(pairs[pairs.length - 1]).toBe("Epilogue=Epilogue");
    expect(pairs.some((p) => p.startsWith("Dramatis") || p.startsWith("About") || p.includes("Credits"))).toBe(false);
  });

  it("maps a place through its chapter both ways, and the text only one side has to what follows", () => {
    const { ebook, chapters, durationMs } = voidscarred();
    const a = alignBook(ebook, chapters, durationMs);
    const three = a.pairs.find((p) => p.textLabel === "Three")!;
    const mid = Math.round((three.text.start + three.text.end) / 2);
    const ms = textToMs(a, mid);
    expect(Math.abs(ms - (three.audio.startMs + three.audio.endMs) / 2)).toBeLessThan(1000);
    expect(Math.abs(msToText(a, ms) - mid)).toBeLessThan(20);
    // The cast list is not read: reading it means listening from the epigraph.
    const cast = globalOffset(ebook, { section: 2, block: 0, offset: 100 });
    expect(textToMs(a, cast)).toBe(chapters[1]!.startMs);
    // The opening credits have no text: they show the journal extract.
    expect(msToText(a, 10_000)).toBe(a.pairs[0]!.text.start);
  });

  it("pairs by pace alone when the audio's titles are only generated numbers, which never number the book", () => {
    const { ebook, chapters, durationMs } = voidscarred();
    // Every marker "Chapter N": the book's One is the audio's third marker.
    const generated = chapters.map((c, i) => ({ ...c, title: `Chapter ${i + 1}` }));
    const a = alignBook(ebook, generated, durationMs, { generated: true });
    expect(a.how).toBe("chapter");
    const pairs = a.pairs.map((p) => `${p.textLabel}=${p.audioTitle}`);
    expect(pairs).toContain("One=Chapter 3");
    expect(pairs).toContain("Twelve=Chapter 14");
    expect(pairs).not.toContain("One=Chapter 1");
  });

  it("falls back to the whole book when nothing pairs", () => {
    const { ebook, durationMs } = voidscarred();
    const a = alignBook(ebook, [{ title: "End Credits", startMs: 0, endMs: durationMs }], durationMs);
    expect(a.how).toBe("proportion");
    expect(textToMs(a, 0)).toBe(0);
  });

  it("lets one audio chapter cover two of the text's, as a coarser recording does", () => {
    const { ebook, chapters, durationMs } = voidscarred();
    // The recording runs Chapters 4 and 5 together.
    const i = chapters.findIndex((c) => c.title === "Chapter 4");
    const merged = [...chapters.slice(0, i), { title: "Chapters 4 and 5", startMs: chapters[i]!.startMs, endMs: chapters[i + 1]!.endMs }, ...chapters.slice(i + 2)];
    const a = alignBook(ebook, merged, durationMs);
    expect(a.pairs.map((p) => `${p.textLabel}=${p.audioTitle}`)).toContain("Four + Five=Chapters 4 and 5");
  });

  it("keeps pairs set by hand, and pairs the rest around them", () => {
    const { ebook, chapters, durationMs } = voidscarred();
    const plain = alignBook(ebook, chapters, durationMs);
    const cast = plain.text.find((t) => t.label === "Dramatis Personae")!;
    const three = plain.text.find((t) => t.label === "Three")!;
    expect(cast.pair).toBe(-1);
    // Say the cast list is the opening credits, and Three is not narrated.
    const a = alignBook(ebook, chapters, durationMs, { fixes: [{ text: cast.ref, audioMs: chapters[0]!.startMs }, { text: three.ref, audioMs: null }] });
    const pairs = a.pairs.map((p) => `${p.textLabel}=${p.audioTitle}`);
    expect(pairs[0]).toBe("Dramatis Personae=Opening Credits");
    expect(a.pairs[0]!.fixed).toBe(true);
    expect(a.text.find((t) => t.label === "Three")!.pair).toBe(-1);
    expect(pairs).toContain("Four=Chapter 4");
  });

  it("is surer of a pair that agrees by name and pace than of one by pace alone", () => {
    const { ebook, chapters, durationMs } = voidscarred();
    const a = alignBook(ebook, chapters, durationMs);
    const named = a.pairs.find((p) => p.textLabel === "Three")!;
    const byPace = a.pairs.find((p) => p.textLabel === "Journal extract")!;
    expect(named.confidence).toBeGreaterThan(byPace.confidence);
  });

  it("finds places by characters of the reading order", () => {
    const { ebook } = voidscarred();
    const p = placeAtGlobal(ebook, globalOffset(ebook, { section: 5, block: 0, offset: 52 }));
    expect(p).toEqual({ section: 5, block: 0, offset: 50 });
  });
});
