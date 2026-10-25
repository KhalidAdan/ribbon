import { describe, expect, it } from "vitest";
import { alignBook, chapterKey, msToText, textToMs } from "../src/core/reading/align";
import { EBOOK_FORMAT, type Ebook, type EbookSection } from "../src/core/ebook";
import type { Chapter } from "../src/core/types";
import { BookText } from "../src/core/reading/booktext";

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
    const a = alignBook(new BookText(ebook), chapters, durationMs);
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
    const a = alignBook(new BookText(ebook), chapters, durationMs);
    const three = a.pairs.find((p) => p.textLabel === "Three")!;
    const mid = Math.round((three.text.start + three.text.end) / 2);
    const ms = textToMs(a, mid);
    expect(Math.abs(ms - (three.audio.startMs + three.audio.endMs) / 2)).toBeLessThan(1000);
    expect(Math.abs(msToText(a, ms) - mid)).toBeLessThan(20);
    // The cast list is not read: reading it means listening from the epigraph.
    const cast = new BookText(ebook).chars({ section: 2, block: 0, offset: 100 });
    expect(textToMs(a, cast)).toBe(chapters[1]!.startMs);
    // The opening credits have no text: they show the journal extract.
    expect(msToText(a, 10_000)).toBe(a.pairs[0]!.text.start);
  });

  it("pairs by pace alone when the audio's titles are only generated numbers, which never number the book", () => {
    const { ebook, chapters, durationMs } = voidscarred();
    // Every marker "Chapter N": the book's One is the audio's third marker.
    const generated = chapters.map((c, i) => ({ ...c, title: `Chapter ${i + 1}` }));
    const a = alignBook(new BookText(ebook), generated, durationMs, { generated: true });
    expect(a.how).toBe("chapter");
    const pairs = a.pairs.map((p) => `${p.textLabel}=${p.audioTitle}`);
    expect(pairs).toContain("One=Chapter 3");
    expect(pairs).toContain("Twelve=Chapter 14");
    expect(pairs).not.toContain("One=Chapter 1");
  });

  it("falls back to the whole book when nothing pairs", () => {
    const { ebook, durationMs } = voidscarred();
    const a = alignBook(new BookText(ebook), [{ title: "End Credits", startMs: 0, endMs: durationMs }], durationMs);
    expect(a.how).toBe("proportion");
    expect(textToMs(a, 0)).toBe(0);
  });

  it("lets one audio chapter cover two of the text's, as a coarser recording does", () => {
    const { ebook, chapters, durationMs } = voidscarred();
    // The recording runs Chapters 4 and 5 together.
    const i = chapters.findIndex((c) => c.title === "Chapter 4");
    const merged = [...chapters.slice(0, i), { title: "Chapters 4 and 5", startMs: chapters[i]!.startMs, endMs: chapters[i + 1]!.endMs }, ...chapters.slice(i + 2)];
    const a = alignBook(new BookText(ebook), merged, durationMs);
    expect(a.pairs.map((p) => `${p.textLabel}=${p.audioTitle}`)).toContain("Four + Five=Chapters 4 and 5");
  });

  it("keeps pairs set by hand, and pairs the rest around them", () => {
    const { ebook, chapters, durationMs } = voidscarred();
    const plain = alignBook(new BookText(ebook), chapters, durationMs);
    const cast = plain.text.find((t) => t.label === "Dramatis Personae")!;
    const three = plain.text.find((t) => t.label === "Three")!;
    expect(cast.pair).toBe(-1);
    // Say the cast list is the opening credits, and Three is not narrated.
    const a = alignBook(new BookText(ebook), chapters, durationMs, { fixes: [{ text: cast.ref, audioMs: chapters[0]!.startMs }, { text: three.ref, audioMs: null }] });
    const pairs = a.pairs.map((p) => `${p.textLabel}=${p.audioTitle}`);
    expect(pairs[0]).toBe("Dramatis Personae=Opening Credits");
    expect(a.pairs[0]!.fixed).toBe(true);
    expect(a.text.find((t) => t.label === "Three")!.pair).toBe(-1);
    expect(pairs).toContain("Four=Chapter 4");
  });

  it("is surer of a pair that agrees by name and pace than of one by pace alone", () => {
    const { ebook, chapters, durationMs } = voidscarred();
    const a = alignBook(new BookText(ebook), chapters, durationMs);
    const named = a.pairs.find((p) => p.textLabel === "Three")!;
    const byPace = a.pairs.find((p) => p.textLabel === "Journal extract")!;
    expect(named.confidence).toBeGreaterThan(byPace.confidence);
  });

  it("finds places by characters of the reading order", () => {
    const { ebook } = voidscarred();
    const text = new BookText(ebook);
    const p = text.place(text.chars({ section: 5, block: 0, offset: 52 }));
    expect(p).toEqual({ section: 5, block: 0, offset: 50 });
  });
});

/**
 * Books whose text and recording don't line up at their edges (#163), as the
 * Siege of Terra and Dark Imperium books were found: paired by what was heard
 * in each audio chapter, not by its name alone.
 */
describe("pairing by what each audio chapter was heard to say", () => {
  /**
   * Plague War's last pages: chapters named in words, a page about the author, and a preview of another book, in its
   * proportions. Its last audio chapter is 30.8 minutes; Twenty-Eight is 28 minutes at the book's pace, the preview 30.
   */
  function plagueWar(lastAudioTitle: string): { ebook: Ebook; chapters: Chapter[]; durationMs: number } {
    const names = ["Twenty-Five", "Twenty-Six", "Twenty-Seven", "Twenty-Eight"];
    const sections: EbookSection[] = names.map((n, i) => section(`ch${i}.xhtml`, Math.round((i < 3 ? 25 : 28) * MIN * PACE)));
    sections.push(section("about.xhtml", 700), section("extract.xhtml", Math.round(30 * MIN * PACE)));
    const toc = [...names, "About the Author", "An Extract from Dawn of Fire"].map((label, i) => ({ label, section: i, block: 0, depth: 0 }));
    const ebook: Ebook = { format: EBOOK_FORMAT, meta: { title: "Plague War", authors: [], identifiers: [] }, layout: "reflowable", sections, toc };
    const titles = ["Chapter Twenty-Five", "Chapter Twenty-Six", "Chapter Twenty-Seven", lastAudioTitle];
    const chapters = titles.map((title, i) => ({ title, startMs: i * 25 * MIN, endMs: i < 3 ? (i + 1) * 25 * MIN : 75 * MIN + 30.8 * MIN }));
    return { ebook, chapters, durationMs: chapters.at(-1)!.endMs };
  }

  it("pairs a last audio chapter named for the wrong number with the chapter its words are in, not the preview after it", () => {
    // Plague War's file names its last chapter "Chapter 29" where the book has "Twenty-Eight": by name and pace alone it went
    // with the preview of another book, and the final chapter was read along against the preview's pages.
    const { ebook, chapters, durationMs } = plagueWar("Chapter 29");
    const text = new BookText(ebook);
    const byName = alignBook(text, chapters, durationMs);
    expect(byName.pairs.at(-1)!.textLabel).toBe("An Extract from Dawn of Fire");
    // Its words, heard twenty seconds in, are at the start of Twenty-Eight.
    const twentyEight = text.chars({ section: 3, block: 0, offset: 0 });
    const heard = [{ ms: 75 * MIN + 20_000, chars: twentyEight + 300 }, { ms: 75 * MIN + 60_000, chars: twentyEight + 950 }];
    const a = alignBook(text, chapters, durationMs, { anchors: heard });
    expect(a.pairs.at(-1)!.textLabel).toBe("Twenty-Eight");
    expect(a.text.find((t) => t.label === "An Extract from Dawn of Fire")!.pair).toBe(-1);
  });

  it("reaches the text its own words were found in, through pages no other audio was paired with", () => {
    // The First Wall: the opening audio chapter (the series' epigraph, then the prologue) went with the epigraph's page, and
    // the prologue, a page of its own after a cast list, was left out though its words were heard.
    const sections = [section("epigraph.xhtml", 600), section("cast.xhtml", 2500), section("prologue.xhtml", 1700), section("one.xhtml", Math.round(20 * MIN * PACE))];
    const toc = ["The Horus Heresy", "Dramatis Personae", "Prologue", "One"].map((label, i) => ({ label, section: i, block: 0, depth: 0 }));
    const ebook: Ebook = { format: EBOOK_FORMAT, meta: { title: "The First Wall", authors: [], identifiers: [] }, layout: "reflowable", sections, toc };
    const chapters = [
      { title: "Chapter 1", startMs: 0, endMs: 3 * MIN },
      { title: "One", startMs: 3 * MIN, endMs: 23 * MIN },
    ];
    const text = new BookText(ebook);
    const prologue = text.chars({ section: 2, block: 0, offset: 0 });
    // The epigraph heard half a minute in, the prologue from a minute and a quarter.
    const heard = [{ ms: 30_000, chars: 100 }, ...[75_000, 100_000, 125_000, 150_000].map((ms, i) => ({ ms, chars: prologue + 50 + i * 400 }))];
    const a = alignBook(text, chapters, 23 * MIN, { anchors: heard });
    const first = a.pairs[0]!;
    expect(first.text.end).toBe(text.chars({ section: 3, block: 0, offset: 0 }));
    expect(a.text.find((t) => t.label === "Prologue")!.pair).toBe(0);
    // So the prologue's place is found to the moment it was heard.
    expect(textToMs(a, prologue + 50 + 400)).toBe(100_000);
  });
});
