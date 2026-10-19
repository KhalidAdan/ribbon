import { beforeAll, describe, expect, it } from "vitest";
import { hyphenateRuns, insertHyphens, SOFT_HYPHEN, toHyphenated, toModel, wordBreaks, type WordBreaks } from "../src/core/reading/hyphens";
import { hyphenatorFor, patternsName } from "../src/reader/hyphenate";
import { EBOOK_FORMAT, type Ebook, type EbookRun } from "../src/core/ebook";
import type { Line } from "../src/core/reading/pages";
import type { Metrics } from "../src/core/reading/typography";

const SHY = SOFT_HYPHEN;
// Six lower-case Deseret letters: each a surrogate pair.
const DESERET = String.fromCodePoint(0x1042e, 0x10437, 0x10438, 0x10439, 0x1043a, 0x1043b);

/** Breaks after every UTF-16 unit, so only Ribbon's own rules decide. */
const everywhere: WordBreaks = (w) => Array.from({ length: w.length - 1 }, (_, i) => i + 1);

/** Every offset into the hyphenated text, mapped back, checked against the text itself. */
function checkMapping(text: string, at: number[]) {
  const h = insertHyphens(text, at);
  expect(h.length).toBe(text.length + at.length);
  expect(h.replaceAll(SHY, "")).toBe(text.replaceAll(SHY, ""));
  // Every model offset survives the round trip.
  for (let o = 0; o <= text.length; o++) expect(toModel(at, toHyphenated(at, o))).toBe(o);
  // Walking the hyphenated text: an added soft hyphen takes no room, everything else one unit.
  let model = 0;
  let k = 0;
  for (let x = 0; x <= h.length; x++) {
    expect(toModel(at, x)).toBe(model);
    if (x === h.length) break;
    const added = k < at.length && at[k]! + k === x;
    if (added) {
      expect(h[x]).toBe(SHY);
      k++;
    } else {
      expect(h[x]).toBe(text[model]);
      model++;
    }
  }
}

describe("soft hyphens added, offsets kept", () => {
  it("puts a soft hyphen before each offset", () => {
    expect(insertHyphens("hyphenation", [2, 6])).toBe(`hy${SHY}phen${SHY}ation`);
    expect(insertHyphens("word", [])).toBe("word");
  });

  it("maps every offset back and forth", () => {
    checkMapping("hyphenation", [2, 6]);
    checkMapping("hyphenation", []);
    checkMapping("a hyphenated paragraph", [4, 8, 15, 17]);
  });

  it("maps the place right after an added hyphen to the same place as before it", () => {
    const at = [2, 6];
    // hy|­|phen|­|ation: 2 and 3 are both before "p"; 7 and 8 both before "a".
    expect([2, 3, 4].map((x) => toModel(at, x))).toEqual([2, 2, 3]);
    expect([7, 8, 9].map((x) => toModel(at, x))).toEqual([6, 6, 7]);
    expect(toModel(at, 13)).toBe(11);
    expect(toHyphenated(at, 2)).toBe(2);
    expect(toHyphenated(at, 3)).toBe(4);
    expect(toHyphenated(at, 11)).toBe(13);
  });

  it("keeps surrogate pairs and the publisher's own soft hyphens where they were", () => {
    const text = `😀 extra${SHY}ordinary ${DESERET} hyphenation`;
    const at = hyphenateRuns([text], everywhere)[0]!;
    expect(at.length).toBeGreaterThan(0);
    checkMapping(text, at);
    const h = insertHyphens(text, at);
    // Nothing cut a pair in two, and the publisher's word was left as it was.
    expect(h).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(h).toContain(`extra${SHY}ordinary `);
    expect(h).toContain("😀 ");
  });

  it("adds hyphens to a word whose letters are styled in parts as one word", () => {
    const runs = ["the ", "hyphen", "ation of ", "everything"];
    const at = hyphenateRuns(runs, everywhere);
    // "hyphenation" starts at 4: breaks 2..8 letters in, the one at the runs' meeting at the end of "hyphen".
    expect(at[1]).toEqual([2, 3, 4, 5, 6]);
    expect(at[2]).toEqual([1, 2]);
    expect(at[3]).toEqual([2, 3, 4, 5, 6, 7]);
    runs.forEach((r, i) => checkMapping(r, at[i]!));
    expect(runs.map((r, i) => insertHyphens(r, at[i]!)).join("")).toBe(`the hy${SHY}p${SHY}h${SHY}e${SHY}n${SHY}a${SHY}t${SHY}ion of ev${SHY}e${SHY}r${SHY}y${SHY}t${SHY}h${SHY}ing`);
  });
});

describe("which words break, and where", () => {
  it("needs six letters, two before a break and three after", () => {
    expect(wordBreaks("short", everywhere)).toEqual([]);
    expect(wordBreaks("shorts", everywhere)).toEqual([2, 3]);
    expect(wordBreaks("hyphenation", everywhere)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it("leaves capitals-only words, digits and the publisher's soft hyphens alone", () => {
    expect(wordBreaks("NATIONAL", everywhere)).toEqual([]);
    expect(wordBreaks("National", everywhere)).toEqual([2, 3, 4, 5]);
    expect(wordBreaks("abc123defghi", everywhere)).toEqual([]);
    expect(wordBreaks(`extra${SHY}ordinary`, everywhere)).toEqual([]);
  });

  it("counts letters, not UTF-16 units, and never breaks a pair or before an accent", () => {
    // Six letters, twelve units.
    expect(wordBreaks(DESERET, everywhere)).toEqual([4, 6]);
    // e + combining acute: the accent stays with its letter.
    expect(wordBreaks("cafe\u0301teria", everywhere)).toEqual([2, 3, 5, 6, 7]);
  });

  it("skips addresses, and finds words between punctuation", () => {
    const at = hyphenateRuns(["see https://example.com/hyphenation or mail someone@somewhere.org, “wonderful”"], everywhere)[0]!;
    const h = insertHyphens("see https://example.com/hyphenation or mail someone@somewhere.org, “wonderful”", at);
    expect(h).toContain("https://example.com/hyphenation ");
    expect(h).toContain("someone@somewhere.org,");
    expect(h).toContain(`“wo${SHY}n${SHY}d${SHY}e${SHY}r${SHY}ful”`);
  });

  it("trusts what the patterns give, filtered by the rules", () => {
    const odd: WordBreaks = () => [0, 1, 4, 4, 99, 3];
    expect(wordBreaks("abcdefgh", odd)).toEqual([3, 4]);
  });
});

describe("patterns by language", () => {
  it("names the patterns for a book's language, English when it names none", () => {
    expect(patternsName(undefined)).toBe("en");
    expect(patternsName("")).toBe("en");
    expect(patternsName("en-US")).toBe("en");
    expect(patternsName("en_GB")).toBe("en-gb");
    expect(patternsName("en-AU")).toBe("en-gb");
    expect(patternsName("de-DE")).toBe("de");
    expect(patternsName("no")).toBe("nb");
    expect(patternsName("ja")).toBeNull();
  });

  it("loads English and breaks words where a dictionary would", async () => {
    const en = await hyphenatorFor("en");
    expect(en).not.toBeNull();
    const show = (w: string) => insertHyphens(w, wordBreaks(w, en!)).replaceAll(SHY, "-");
    expect(show("hyphenation")).toBe("hy-phen-ation");
    expect(show("extraordinary")).toBe("ex-tra-or-di-nary");
    expect(show("Encyclopedia")).toBe("En-cy-clo-pe-dia");
    expect(show("table")).toBe("table");
  });

  it("does not hyphenate a language it has no patterns for", async () => {
    expect(await hyphenatorFor("ja")).toBeNull();
  });
});

/** Every character the same width, half the font's size, as canvas would measure a monospaced face. */
function fakeCanvas() {
  const context = {
    font: "10px serif",
    letterSpacing: "0px",
    measureText(text: string) {
      const px = Number(/([\d.]+)px/.exec(this.font)?.[1] ?? 10);
      return { width: [...text].length * px * 0.5 };
    },
  };
  (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = class {
    getContext() {
      return context;
    }
  };
}

const metrics = (column: number): Metrics => ({ size: 16, lineHeight: 24, column, pageHeight: 600, margin: 24, columns: 1, gap: 0 }) as Metrics;

function book(runs: EbookRun[], language = "en"): Ebook {
  return {
    format: EBOOK_FORMAT,
    meta: { title: "T", authors: [], language, identifiers: [] },
    layout: "reflowable",
    sections: [{ href: "a.xhtml", linear: true, overlay: null, chars: 0, blocks: [{ k: "p", runs }, { k: "h", level: 2, runs: [{ t: "Extraordinarily considerable headings" }] }] }],
    toc: [],
  };
}

describe("typesetting with hyphens", () => {
  let Typesetter: typeof import("../src/reader/typeset").Typesetter;
  beforeAll(async () => {
    fakeCanvas();
    ({ Typesetter } = await import("../src/reader/typeset"));
  });

  const runs: EbookRun[] = [
    { t: "Notwithstanding the extraordinary circumstances, the " },
    { t: "administration", i: true },
    { t: " considered its responsibilities in unpredictable, " },
    { t: `incom${SHY}prehensible`, b: true },
    { t: " and 😀 unexpectedly characteristic ways, documenting everything at " },
    { t: "https://example.com/documentation", href: "https://example.com/documentation" },
    { t: " with considerable determination." },
  ];
  const text = runs.map((r) => r.t).join("");

  async function lay(column: number, justify: boolean, language = "en") {
    const t = new Typesetter(book(runs, language), () => undefined);
    await t.ready;
    return t.section(0, metrics(column), justify);
  }

  /** The lines of the paragraph, checked against the model's text. */
  function check(lines: Line[]) {
    expect(lines[0]!.start).toBe(0);
    expect(lines[lines.length - 1]!.end).toBe(text.length);
    lines.forEach((line, n) => {
      if (n > 0) {
        // Between two lines, only the space a break took.
        const between = text.slice(lines[n - 1]!.end, line.start);
        expect(lines[n - 1]!.end).toBeLessThanOrEqual(line.start);
        expect(between.trim()).toBe("");
      }
      for (const f of line.frags) {
        expect(f.text).not.toContain(SHY);
        const own = text.slice(f.start, f.end).replaceAll(SHY, "");
        const last = f === line.frags[line.frags.length - 1];
        const drawn = last && f.text.endsWith("-") && !own.endsWith("-") ? f.text.slice(0, -1) : f.text;
        expect(drawn.trimEnd()).toBe(own.trimEnd());
      }
    });
  }

  it("breaks words at added hyphens, with every offset into the model's text", async () => {
    const [p, h] = await lay(160, true);
    check(p!.lines);
    // Some line broke inside a word where the model has no hyphen of its own.
    const inserted = p!.lines.filter((l, n) => {
      const tail = l.frags[l.frags.length - 1]!;
      return n < p!.lines.length - 1 && tail.text.endsWith("-") && /\p{L}/u.test(text[l.end - 1]!) && /\p{L}/u.test(text[l.end]!);
    });
    expect(inserted.length).toBeGreaterThan(0);
    // Headings are never hyphenated.
    expect(h!.lines.every((l) => !l.frags[l.frags.length - 1]!.text.endsWith("-"))).toBe(true);
  });

  it("does not hyphenate unjustified text, or a language without patterns", async () => {
    for (const [justify, language] of [
      [false, "en"],
      [true, "ja"],
    ] as const) {
      const [p] = await lay(160, justify, language);
      check(p!.lines);
      for (const l of p!.lines) {
        const tail = l.frags[l.frags.length - 1]!;
        // Only the publisher's soft hyphen in "incom-prehensible" may show.
        if (tail.text.endsWith("-")) expect(text.slice(0, l.end).endsWith(`incom${SHY}`) || text.slice(0, l.end).endsWith("incom")).toBe(true);
      }
    }
  });

  it("maps every line back to the model at any width", async () => {
    for (const column of [120, 160, 240, 400, 2000]) {
      const [p] = await lay(column, true);
      check(p!.lines);
    }
  });
});
