import { describe, expect, it } from "vitest";
import {
  AUTHOR_FACE,
  BINDINGS,
  bindingOf,
  DEFAULT_SHELF,
  hueOfHex,
  isLight,
  isNewThisWeek,
  layOutSpine,
  leanRoom,
  orderShelf,
  packShelves,
  parseShelf,
  shelfLabel,
  spineColours,
  spineSize,
  surnameOf,
  TITLE_FACE,
  titleLines,
  type Measure,
  type SpineBook,
} from "@ribbon/core/shelf";
import type { ScannedBook } from "@ribbon/core/scan/scan";
import type { Book } from "@ribbon/core/types";

// Every character half as long as the type is big, plus the face's tracking: near enough to Inter and Newsreader.
const measure: Measure = (text, face) => text.length * 0.5 + face.tracking * Math.max(0, text.length - 1);

const spineBook = (title: string, extra: Partial<SpineBook> = {}): SpineBook => ({ id: title, title, author: "Robert Louis Stevenson", durationMs: 8 * 3_600_000, textOnly: false, finished: false, ...extra });

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 7, 21);

function sb(title: string, extra: Partial<Book> = {}, added = NOW - 400 * DAY): ScannedBook {
  const book: Book = { id: title, path: title, title, rawTitle: title, author: "", narrator: "", series: "", seriesIndex: null, year: null, cover: "", durationMs: 10 * 3_600_000, sizeBytes: 1, fileCount: 1, ...extra };
  return {
    book,
    files: [{ path: `${title}.mp3`, order: 0, durationMs: book.durationMs, sizeBytes: 1, mtimeMs: added, title: "", part: "", partAuthor: "", disc: 1, track: 0, hasCover: false, coverFile: "", chapters: [], chaptersProbed: true }],
    chapters: [],
    parts: [],
  } as unknown as ScannedBook;
}

describe("the spine's binding", () => {
  it("is the same every time for a book, and the shelf has all five", () => {
    expect(bindingOf("moby-dick")).toBe(bindingOf("moby-dick"));
    const seen = new Set(Array.from({ length: 200 }, (_, i) => bindingOf(`book-${i}`)));
    expect([...seen].sort()).toEqual([...BINDINGS].sort());
  });
});

describe("spineSize", () => {
  it("is thicker for a longer book, within a thinnest and a thickest", () => {
    const short = spineSize(spineBook("A", { durationMs: 2 * 3_600_000 }), 1).width;
    const long = spineSize(spineBook("A", { durationMs: 20 * 3_600_000 }), 1).width;
    const epic = spineSize(spineBook("A", { durationMs: 80 * 3_600_000 }), 1).width;
    expect(short).toBe(22);
    expect(long).toBeGreaterThan(short);
    expect(epic).toBe(62);
  });

  it("scales with the screen", () => {
    const big = spineSize(spineBook("A"), 1);
    const small = spineSize(spineBook("A"), 0.5);
    expect(small.width).toBe(Math.round(big.width / 2));
    expect(small.height).toBeCloseTo(big.height / 2, -1);
  });
});

describe("titleLines", () => {
  it("offers one line, then the most even break into two and into three", () => {
    const options = titleLines("The Count of Monte Cristo", TITLE_FACE.plain, measure);
    expect(options[0]).toEqual(["The Count of Monte Cristo"]);
    expect(options[1]).toEqual(["The Count of", "Monte Cristo"]);
    expect(options[2]).toHaveLength(3);
    expect(titleLines("Emma", TITLE_FACE.plain, measure)).toEqual([["Emma"]]);
  });
});

describe("layOutSpine", () => {
  const titles = ["Emma", "Kim", "Strange Case of Dr Jekyll and Mr Hyde", "Twenty Thousand Leagues Under the Seas", "The Unpleasantness at the Bellona Club", "Les Misérables", "Tess of the d’Urbervilles"];

  for (const scale of [1, 0.78, 1.6]) {
    it(`fits every title whole, along and across, at ${scale}×`, () => {
      for (const title of titles) {
        for (const durationMs of [2, 8, 40].map((h) => h * 3_600_000)) {
          const s = layOutSpine(spineBook(title, { durationMs }), scale, measure);
          const face = TITLE_FACE[s.binding];
          const along = Math.max(...s.title.lines.map((l) => measure(l, face))) * s.title.size;
          const room = s.height - s.head - s.foot - s.stickerZone - (s.author?.zone ?? 0) - 2 * s.padY;
          expect(along, title).toBeLessThanOrEqual(room);
          expect(s.title.lines.length * s.title.size * face.lineHeight, title).toBeLessThanOrEqual(s.width);
          expect(s.title.size, title).toBeGreaterThanOrEqual(8.5 * scale);
          expect(s.title.lines.join(" "), title).toBe(face.upper ? title.toUpperCase() : title);
        }
      }
    });
  }

  it("gives a thin book with a long title a little more spine, not a cut title", () => {
    const book = spineBook("Strange Case of Dr Jekyll and Mr Hyde", { durationMs: 2.8 * 3_600_000 });
    expect(layOutSpine(book, 1, measure).width).toBeGreaterThan(spineSize(book, 1).width);
  });

  it("names the author in spaced capitals, smaller than the title", () => {
    const s = layOutSpine(spineBook("Emma", { author: "Jane Austen", durationMs: 16 * 3_600_000 }), 1, measure);
    expect(s.author?.text).toBe("AUSTEN");
    expect(s.author!.size).toBeLessThan(s.title.size);
    expect(measure("AUSTEN", AUTHOR_FACE)).toBeGreaterThan(0);
  });

  it("makes room for a finished book's sticker", () => {
    const open = layOutSpine(spineBook("Treasure Island"), 1, measure);
    const done = layOutSpine(spineBook("Treasure Island", { finished: true }), 1, measure);
    expect(open.sticker).toBe(0);
    expect(done.sticker).toBeGreaterThan(0);
    expect(done.stickerZone).toBeGreaterThan(done.sticker);
  });
});

describe("spineColours", () => {
  it("are written as #rrggbb, with ink that shows on the ground", () => {
    for (const binding of BINDINGS) {
      for (const hue of [0, 0.3, 0.6, null]) {
        const c = spineColours(hue, binding, "a book");
        for (const v of [c.ground, c.ink, c.paper]) expect(v).toMatch(/^#[0-9a-f]{6}$/);
        const ground = binding === "paperback" ? c.paper : c.ground;
        expect(isLight(ground), `${binding} ${hue}`).not.toBe(isLight(c.ink));
      }
    }
  });

  it("take the cover's hue", () => {
    expect(hueOfHex(spineColours(0.6, "cloth", "x").ground)).toBeCloseTo(0.6, 1);
    expect(hueOfHex("#808080")).toBeNull();
    expect(hueOfHex("not a colour")).toBeNull();
  });
});

describe("surnameOf", () => {
  it("is the last word of the first author", () => {
    expect(surnameOf("Robert Louis Stevenson")).toBe("Stevenson");
    expect(surnameOf("Homer")).toBe("Homer");
    expect(surnameOf("Dan Abnett, Graham McNeill")).toBe("Abnett");
    expect(surnameOf("")).toBe("");
  });
});

describe("orderShelf", () => {
  const books = [
    sb("The Time Machine", { author: "H. G. Wells", durationMs: 3.5 * 3_600_000 }, NOW - 30 * DAY),
    sb("Emma", { author: "Jane Austen", durationMs: 16 * 3_600_000 }, NOW - 2 * DAY),
    sb("A Little Princess", { author: "Frances Hodgson Burnett", durationMs: 7.6 * 3_600_000 }, NOW - 300 * DAY),
    sb("Walden", { author: "Henry David Thoreau", durationMs: 0, fileCount: 0, ebook: "walden.epub" } as Partial<Book>, NOW - 100 * DAY),
  ];
  const titles = (order: Parameters<typeof orderShelf>[1]) => orderShelf(books, order).map((b) => b.book.title);

  it("puts the newest first", () => expect(titles("added")).toEqual(["Emma", "The Time Machine", "Walden", "A Little Princess"]));
  it("files titles without a first The or A", () => expect(titles("title")).toEqual(["Emma", "A Little Princess", "The Time Machine", "Walden"]));
  it("files authors by surname", () => expect(titles("author")).toEqual(["Emma", "A Little Princess", "Walden", "The Time Machine"]));
  it("puts the shortest first and the books that are only text last", () => expect(titles("length")).toEqual(["The Time Machine", "A Little Princess", "Emma", "Walden"]));
});

describe("shelf labels and the week's new books", () => {
  it("say a letter, a length, or when", () => {
    const b = sb("The Time Machine", { author: "H. G. Wells", durationMs: 3.5 * 3_600_000 }, NOW - 40 * DAY);
    expect(shelfLabel(b, "title", NOW)).toBe("T");
    expect(shelfLabel(b, "author", NOW)).toBe("W");
    expect(shelfLabel(b, "length", NOW)).toBe("Under 5 h");
    expect(shelfLabel(b, "added", NOW, "en-GB")).toBe("Sept 2026");
    expect(shelfLabel(sb("New", {}, NOW - 3 * DAY), "added", NOW)).toBe("Last two weeks");
  });

  it("stand this week's books face-out", () => {
    expect(isNewThisWeek(sb("New", {}, NOW - 3 * DAY), NOW)).toBe(true);
    expect(isNewThisWeek(sb("Old", {}, NOW - 8 * DAY), NOW)).toBe(false);
  });
});

describe("packShelves", () => {
  it("fills each shelf in order, never past its width", () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ id: i, width: 20 + (i % 7) * 6, gapAfter: 2 }));
    const shelves = packShelves(items, 300);
    expect(shelves.flat().map((p) => p.item.id)).toEqual(items.map((i) => i.id));
    for (const shelf of shelves) {
      const last = shelf[shelf.length - 1]!;
      expect(last.x + last.item.width).toBeLessThanOrEqual(300);
      expect(shelf[0]!.x).toBe(0);
    }
  });

  it("gives a thing wider than the shelf a shelf of its own", () => {
    expect(packShelves([{ width: 500, gapAfter: 0 }, { width: 10, gapAfter: 0 }], 300)).toHaveLength(2);
  });

  it("leaves room for a lean in proportion to the book's height", () => {
    expect(leanRoom(190)).toBe(26);
  });
});

describe("parseShelf", () => {
  it("keeps what it knows and defaults the rest", () => {
    expect(parseShelf(null)).toEqual(DEFAULT_SHELF);
    expect(parseShelf({ order: "author", look: "covers" })).toEqual({ order: "author", look: "covers" });
    expect(parseShelf({ order: "colour", look: "3d" })).toEqual(DEFAULT_SHELF);
  });
});
