import { describe, expect, it } from "vitest";
import {
  caseLabel,
  caseOrder,
  caseSurname,
  isPaperback,
  layOutCase,
  layOutCaseSpine,
  spineSize,
  spineTitle,
  thickness,
  type CaseBook,
  type MeasureRun,
} from "@ribbon/core/bookcase/case";
import { findOnShelf, foldForSearch, searchScore } from "@ribbon/core/bookcase/search";
import { clothForBook, coverColour, fromHsl, hexOf, hslOf, nearestCloth, rgb, SWATCHES } from "@ribbon/core/bookcase/cloth";

// Every character half as long as the type is big, plus the face's tracking: near enough to Inter and Newsreader.
const measure: MeasureRun = (text, face) => text.length * 0.5 + face.tracking * Math.max(0, text.length - 1);

const NOW = Date.UTC(2026, 10, 10), DAY = 86_400_000;

const book = (title: string, extra: Partial<CaseBook> = {}): CaseBook => ({
  id: title, title, author: "Robert Louis Stevenson", words: 90_000, fraction: 0, finished: false, addedAt: NOW - 40 * DAY, ...extra,
});

describe("a spine's words", () => {
  it("takes the volume number from the front of a title, or from its subtitle", () => {
    expect(spineTitle("29. Vengeful Spirit")).toEqual({ number: "29", main: "Vengeful Spirit" });
    expect(spineTitle("Kidnapped: Book 2")).toEqual({ number: "2", main: "Kidnapped" });
    expect(spineTitle("Moby-Dick: or, The Whale")).toEqual({ number: null, main: "Moby-Dick" });
  });

  it("carries the first author's last name", () => {
    expect(caseSurname("Robert Louis Stevenson")).toBe("Stevenson");
    expect(caseSurname("Terry Pratchett & Neil Gaiman")).toBe("Pratchett");
    expect(caseSurname("")).toBe("");
  });
});

describe("a book's size on the shelf", () => {
  it("is as thick as it is long, between the thinnest and the thickest a spine goes", () => {
    const short = thickness(book("a", { words: 5_000 }), 1), long = thickness(book("a", { words: 2_000_000 }), 1);
    expect(short).toBe(16);
    expect(long).toBe(84);
    expect(thickness(book("a", { words: 200_000 }), 1)).toBeGreaterThan(thickness(book("a", { words: 100_000 }), 1));
    expect(thickness(book("a"), 2)).toBe(thickness(book("a"), 1) * 2);
  });

  it("stands between three quarters of the shelf's height and nearly all of it, the same every time", () => {
    for (const title of ["Emma", "Dracula", "Persuasion", "The Odyssey"]) {
      const { height } = spineSize(book(title), 1);
      expect(height).toBeGreaterThanOrEqual(144);
      expect(height).toBeLessThanOrEqual(185);
      expect(spineSize(book(title), 1)).toEqual(spineSize(book(title), 1));
    }
  });

  it("makes about a third of the books paperbacks", () => {
    const paperbacks = Array.from({ length: 1000 }, (_, i) => isPaperback(`book-${i}`)).filter(Boolean).length;
    expect(paperbacks).toBeGreaterThan(230);
    expect(paperbacks).toBeLessThan(370);
  });
});

describe("fitting a spine", () => {
  it("never cuts a title: a long one breaks into lines, shrinks, or widens the spine", () => {
    const spine = layOutCaseSpine(book("The Strange Case of Dr Jekyll and Mr Hyde", { words: 20_000 }), 1, measure);
    expect(spine.lines.join(" ")).toBe("THE STRANGE CASE OF DR JEKYLL AND MR HYDE");
    expect(spine.size).toBeGreaterThanOrEqual(7.5 * 0.9);
    const longest = Math.max(...spine.lines.map((l) => measure(l, { serif: true, weight: 500, upper: true, tracking: 0.09, lineHeight: 1.12 })));
    expect(longest * spine.size).toBeLessThanOrEqual(spine.titleBottom - spine.titleTop + 0.01);
  });

  it("sets a short title at the shelf's one size, with the surname at the foot", () => {
    const spine = layOutCaseSpine(book("Emma", { words: 150_000 }), 1, measure);
    expect(spine.lines).toEqual(["EMMA"]);
    expect(spine.size).toBe(12);
    expect(spine.author).toBe("STEVENSON");
  });

  it("leaves room for a finished book's tick and a volume number above the title", () => {
    const plain = layOutCaseSpine(book("Emma"), 1, measure);
    const marked = layOutCaseSpine(book("3. Emma", { id: "Emma", finished: true }), 1, measure);
    expect(marked.number).toBe("3");
    expect(marked.tick).toBeGreaterThan(0);
    expect(marked.titleTop).toBeGreaterThan(plain.titleTop);
  });
});

describe("the case", () => {
  const books = [
    book("Old", { addedAt: NOW - 400 * DAY }),
    book("New", { addedAt: NOW - 2 * DAY }),
    book("Undated", { addedAt: null }),
    book("New too", { addedAt: NOW - 2 * DAY, author: "Jane Austen" }),
  ];

  it("stands the newest first, books that came together by surname, and undated books last", () => {
    expect(caseOrder(books, NOW).map((b) => b.title)).toEqual(["New too", "New", "Old", "Undated"]);
  });

  it("labels the last two weeks, then each month", () => {
    expect(caseLabel(books[1]!, NOW)).toBe("Last two weeks");
    expect(caseLabel(books[0]!, NOW)).toBe("Oct 2025");
    expect(caseLabel(books[2]!, NOW)).toBeNull();
  });

  it("packs shelves no wider than the case, labelling only where a label changes", () => {
    const many = Array.from({ length: 40 }, (_, i) => book(`Book ${i}`, { addedAt: NOW - (20 + i) * DAY, words: 60_000 + i * 9_000 }));
    const shelves = layOutCase(many, 600, 1, measure, NOW);
    expect(shelves.length).toBeGreaterThan(1);
    expect(shelves.flat()).toHaveLength(40);
    for (const shelf of shelves) {
      for (const item of shelf) if (!item.lean) expect(item.x + item.spine.width).toBeLessThanOrEqual(600 - 12);
    }
    const labels = shelves.flat().map((i) => i.label).filter((l) => l !== null);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("never binds a book in the cloth of either of the two before it", () => {
    const alike = Array.from({ length: 12 }, (_, i) => book(`Volume ${i}`, { cloth: nearestCloth(rgb(0x6b1f24)) }));
    const grounds = layOutCase(alike, 2000, 1, measure, NOW).flat().map((i) => hexOf(i.cloth.ground));
    grounds.forEach((g, i) => {
      expect(grounds[i - 1]).not.toBe(g);
      expect(grounds[i - 2]).not.toBe(g);
    });
  });
});

describe("cloths", () => {
  it("turns a colour to hue, strength and lightness and back", () => {
    for (const swatch of SWATCHES) {
      const { h, s, l } = hslOf(swatch.ground);
      const back = fromHsl(h, s, l);
      expect(Math.abs(back.r - swatch.ground.r) + Math.abs(back.g - swatch.ground.g) + Math.abs(back.b - swatch.ground.b)).toBeLessThanOrEqual(3);
    }
  });

  it("binds a colour in the swatch nearest it, with four more behind", () => {
    expect(hexOf(nearestCloth(rgb(0x6b1f24)).ground)).toBe("#6b1f24");
    expect(hexOf(nearestCloth(rgb(0x1a2a50)).ground)).toBe("#1d2c4c");
    expect(nearestCloth(rgb(0x1a2a50)).alternatives).toHaveLength(4);
  });

  it("gives a book with no cover a cloth of its own, the same every time", () => {
    expect(hexOf(clothForBook("proof-00").ground)).toBe(hexOf(clothForBook("proof-00").ground));
    expect(new Set(Array.from({ length: 60 }, (_, i) => hexOf(clothForBook(`book-${i}`).ground))).size).toBeGreaterThan(6);
  });

  it("reads a cover's most characteristic colour, not its commonest", () => {
    // Mostly grey, with a quarter of strong red: the red is what the cover is remembered by.
    const px: number[] = [];
    for (let i = 0; i < 400; i++) px.push(...(i % 4 === 0 ? [200, 30, 30, 255] : [120, 120, 120, 255]));
    const { h, s } = hslOf(coverColour(px));
    expect(Math.min(h, 1 - h)).toBeLessThan(0.03);
    expect(s).toBeGreaterThan(0.5);
    // Hardly any colour at all: a quiet neutral, dark for a dark cover.
    const grey = hslOf(coverColour(Array.from({ length: 400 }, (_, i) => (i % 4 === 3 ? 255 : 40))));
    expect(grey.s).toBeLessThan(0.1);
    expect(grey.l).toBeLessThan(0.3);
  });
});

describe("finding a book on the shelf", () => {
  const shelf = [
    { title: "The High Kâhl's Oath", author: "Gav Thorpe" },
    { title: "Horus Rising", author: "Dan Abnett" },
    { title: "The Horus Heresy: Fulgrim", author: "Graham McNeill" },
    { title: "Emma", author: "Jane Austen" },
  ];
  const found = (q: string) => findOnShelf(q, shelf, (b) => b).map((b) => b.title);

  it("folds accents and punctuation away", () => {
    expect(foldForSearch("The High Kâhl's Oath")).toBe("the high kahl s oath");
    expect(found("kahl")).toEqual(["The High Kâhl's Oath"]);
  });

  it("puts a title that starts with what was typed first, and finds a book by its author", () => {
    expect(found("horus")).toEqual(["Horus Rising", "The Horus Heresy: Fulgrim"]);
    expect(found("austen")).toEqual(["Emma"]);
    expect(found("abnett rising")).toEqual(["Horus Rising"]);
  });

  it("forgives a slip of the finger, but every word must match something", () => {
    expect(found("fulgirm")).toEqual(["The Horus Heresy: Fulgrim"]);
    expect(found("horus zzz")).toEqual([]);
    expect(searchScore("", shelf[0]!)).toBeNull();
  });
});
