import { describe, expect, it } from "vitest";
import { bytesToSeries, defaultChoices, detectSeries, excludeShorterThan, hiddenBookIds, isHandMade, mergeSeries, newSeriesRecord, normalizeChoices, orderBySeries, parseSeriesTitle, seriesToBytes, slug, uniqueKey } from "../src/core/series";
import type { Book } from "../src/core/types";

const book = (path: string, extra: Partial<Book> = {}): Book => ({
  id: path,
  path,
  title: path.replace(/^\d+\. /, ""),
  rawTitle: path,
  author: "",
  narrator: "",
  series: "",
  seriesIndex: null,
  year: null,
  cover: "",
  durationMs: 10 * 3_600_000,
  sizeBytes: 0,
  fileCount: 1,
  ...extra,
});

const heresy = [
  book("01. Horus Rising", { seriesIndex: 1 }),
  book("02. False Gods", { seriesIndex: 2 }),
  book("03. Galaxy in Flames", { seriesIndex: 3 }),
  book("04. The Flight of the Eisenstein", { seriesIndex: 4, durationMs: 2 * 3_600_000 }),
];

describe("detectSeries", () => {
  it("names numbered folders at the root after the library folder", () => {
    const groups = detectSeries(heresy, "Warhammer 40K - The Horus Heresy");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe("Warhammer 40K - The Horus Heresy");
    expect(groups[0]!.key).toBe("warhammer-40k-the-horus-heresy");
    expect(groups[0]!.bookIds).toEqual(heresy.map((b) => b.id));
  });

  it("names numbered folders under a parent after the parent, and groups a series tag wherever it lives", () => {
    const books = [
      book("Drizzt/1. Homeland", { seriesIndex: 1 }),
      book("Drizzt/2. Exile", { seriesIndex: 2 }),
      book("Drizzt/3. Sojourn", { seriesIndex: 3 }),
      book("Misc/Legion", { series: "The Horus Heresy" }),
      book("Misc/Nemesis", { series: "The Horus Heresy" }),
      book("Elsewhere/Scars", { series: "The Horus Heresy" }),
    ];
    const groups = detectSeries(books, "Audiobooks");
    expect(groups.map((g) => g.name).sort()).toEqual(["Drizzt", "The Horus Heresy"]);
    expect(groups.find((g) => g.name === "Drizzt")!.bookIds).toEqual(["Drizzt/1. Homeland", "Drizzt/2. Exile", "Drizzt/3. Sojourn"]);
  });

  it("needs at least three books, and ignores books with neither tag nor number", () => {
    expect(detectSeries(heresy.slice(0, 2), "Lib")).toEqual([]);
    expect(detectSeries([book("A"), book("B"), book("C")], "Lib")).toEqual([]);
  });

  it("gives each member the number its folder or tag gives it, and orders a tag's books by it", () => {
    const tagged = [
      book("c3d1", { series: "The Expanse", seriesIndex: 3 }),
      book("a9f0", { series: "The Expanse", seriesIndex: 1 }),
      book("b2e7", { series: "The Expanse", seriesIndex: 2 }),
    ];
    const [g] = detectSeries(tagged, "Lib");
    expect(g!.bookIds).toEqual(["a9f0", "b2e7", "c3d1"]);
    expect(g!.numbers).toEqual({ a9f0: 1, b2e7: 2, c3d1: 3 });
    expect(detectSeries(heresy, "Heresy")[0]!.numbers).toEqual({ "01. Horus Rising": 1, "02. False Gods": 2, "03. Galaxy in Flames": 3, "04. The Flight of the Eisenstein": 4 });
  });

  it("drops a folder's number from the title a list of the series shows beside that number", () => {
    const titled = heresy.map((b) => ({ ...b, title: b.path }));
    expect(detectSeries(titled, "Heresy")[0]!.titles).toEqual({ "01. Horus Rising": "Horus Rising", "02. False Gods": "False Gods", "03. Galaxy in Flames": "Galaxy in Flames", "04. The Flight of the Eisenstein": "The Flight of the Eisenstein" });
    expect(detectSeries(heresy, "Heresy")[0]!.titles).toBeUndefined();
  });

  it("makes safe, distinct keys", () => {
    expect(slug("Warhammer 40K: The Horus Heresy (Unabridged)")).toBe("warhammer-40k-the-horus-heresy-unabridged");
    expect(slug("///")).toBe("series");
  });
});

describe("series named in titles", () => {
  // The Siege of Terra as it came to the server: no series tag, no number, and the names in either order. Ids are hashes, so path order is no order.
  const siege = [
    ["c4e2", "The End and the Death: Volume I: The Horus Heresy: Siege of Terra, Book 8"],
    ["a129", "Echoes of Eternity: The Horus Heresy: Siege of Terra, Book 7"],
    ["35f4", "Mortis: The Horus Heresy: Siege of Terra, Book 5"],
    ["e309", "The End and the Death: Volume II: The Horus Heresy: Siege of Terra, Book 8, Part 2"],
    ["ef31", "Saturnine: Siege of Terra: The Horus Heresy, Book 4"],
    ["b684", "The Solar War: Siege of Terra: The Horus Heresy, Book 1"],
    ["95fb", "The First Wall: Siege of Terra: The Horus Heresy, Book 3"],
    ["c632", "The End and the Death: Volume III: The Horus Heresy: Siege of Terra, Book 8, Part 3"],
    ["661f", "The Lost and the Damned: Siege of Terra: The Horus Heresy, Book 2"],
    ["5b1c", "Warhawk: The Horus Heresy: Siege of Terra, Book 6"],
  ].map(([id, title]) => book(id!, { title: title! }));
  const universe = [book("818e", { title: "Master of Rites: Warhammer 40,000" }), book("f9dc", { title: "Voidscarred: Warhammer 40,000" })];

  it("reads a store's title for its parts, number and part", () => {
    expect(parseSeriesTitle("The End and the Death: Volume II: The Horus Heresy: Siege of Terra, Book 8, Part 2")).toEqual({ parts: ["The End and the Death", "Volume II", "The Horus Heresy", "Siege of Terra"], own: 1, number: 8, part: 2 });
    expect(parseSeriesTitle("Leviathan Wakes (The Expanse, Book 1)")).toEqual({ parts: ["Leviathan Wakes", "The Expanse"], own: 1, number: 1, part: 0 });
    expect(parseSeriesTitle("Caliban's War (The Expanse #2)")).toEqual({ parts: ["Caliban's War", "The Expanse"], own: 1, number: 2, part: 0 });
    expect(parseSeriesTitle("Siege of Terra, Book 2.5")).toEqual({ parts: ["Siege of Terra"], own: 0, number: 2.5, part: 0 });
    expect(parseSeriesTitle("Master of Rites: Warhammer 40,000")).toBeNull();
    expect(parseSeriesTitle("The Book Thief")).toBeNull();
  });

  it("finds the Siege of Terra as one series, in book order, whichever order its names come in", () => {
    const groups = detectSeries([...siege, ...universe], "Ribbon server");
    expect(groups).toHaveLength(1);
    const [g] = groups;
    expect(g!.name).toBe("The Horus Heresy: Siege of Terra");
    expect(g!.key).toBe("siege-of-terra-the-horus-heresy");
    expect(g!.bookIds).toEqual(["b684", "661f", "95fb", "ef31", "35f4", "5b1c", "a129", "c4e2", "e309", "c632"]);
    expect(g!.numbers).toEqual({ b684: 1, "661f": 2, "95fb": 3, ef31: 4, "35f4": 5, "5b1c": 6, a129: 7, c4e2: 8, e309: 8, c632: 8 });
    // A volume belongs to its book's title, not to the series.
    expect(g!.titles).toMatchObject({ b684: "The Solar War", ef31: "Saturnine", c4e2: "The End and the Death: Volume I", e309: "The End and the Death: Volume II" });
  });

  it("keeps the key when more titles come to spell the name the other way", () => {
    const flipped = siege.map((b) => ({ ...b, title: b.title.replace("The Horus Heresy: Siege of Terra", "Siege of Terra: The Horus Heresy") }));
    const [g] = detectSeries(flipped, "Lib");
    expect(g!.name).toBe("Siege of Terra: The Horus Heresy");
    expect(g!.key).toBe("siege-of-terra-the-horus-heresy");
  });

  it("tells a series from the one around it", () => {
    const heresyTitles = ["Horus Rising: The Horus Heresy, Book 1", "False Gods: The Horus Heresy, Book 2", "Galaxy in Flames: The Horus Heresy, Book 3"].map((title, i) => book(`h${i}`, { title }));
    const groups = detectSeries([...heresyTitles, ...siege], "Lib");
    expect(groups.map((g) => [g.name, g.bookIds.length])).toEqual(
      expect.arrayContaining([
        ["The Horus Heresy", 3],
        ["The Horus Heresy: Siege of Terra", 10],
      ]),
    );
  });

  it("needs a name that three titles share, and leaves a tag or a folder number to say first", () => {
    expect(detectSeries(siege.slice(0, 2), "Lib")).toEqual([]);
    const tagged = siege.map((b, i) => (i < 8 ? { ...b, series: "Siege of Terra" } : b));
    expect(detectSeries(tagged, "Lib").map((g) => [g.name, g.bookIds.length])).toEqual([["Siege of Terra", 8]]);
  });
});

describe("choices", () => {
  it("start with everything in, in order", () => {
    const [g] = detectSeries(heresy, "Heresy");
    expect(defaultChoices(g!)).toEqual([
      { bookId: "01. Horus Rising", included: true, order: 1 },
      { bookId: "02. False Gods", included: true, order: 2 },
      { bookId: "03. Galaxy in Flames", included: true, order: 3 },
      { bookId: "04. The Flight of the Eisenstein", included: true, order: 4 },
    ]);
  });

  it("exclude the short ones in one move", () => {
    const [g] = detectSeries(heresy, "Heresy");
    const durations = new Map(heresy.map((b) => [b.id, b.durationMs]));
    const out = excludeShorterThan(defaultChoices(g!), durations, 4 * 3_600_000);
    expect(out.map((c) => c.included)).toEqual([true, true, true, false]);
  });

  it("normalise to contiguous orders and list the hidden", () => {
    const choices = normalizeChoices([
      { bookId: "b", included: false, order: 7 },
      { bookId: "a", included: true, order: 2 },
    ]);
    expect(choices).toEqual([
      { bookId: "a", included: true, order: 1 },
      { bookId: "b", included: false, order: 2 },
    ]);
    expect([...hiddenBookIds([{ key: "k", name: "n", choices, decidedAt: "" }])]).toEqual(["b"]);
  });
});

describe("orderBySeries", () => {
  it("reorders series members within the slots they occupy and leaves others alone", () => {
    const shelf = ["x", "a", "y", "b", "c", "z"];
    const record = { key: "k", name: "n", decidedAt: "", choices: [
      { bookId: "a", included: true, order: 3 },
      { bookId: "b", included: true, order: 1 },
      { bookId: "c", included: true, order: 2 },
    ] };
    expect(orderBySeries(shelf, (s) => s, [record])).toEqual(["x", "b", "y", "c", "a", "z"]);
  });
});

describe("series made by hand", () => {
  const onShelf = new Set(["a", "b", "c", "d", "e"]);
  const detected = [{ key: "heresy", name: "Heresy", bookIds: ["a", "b", "c"] }];

  it("gives a new series a key no other has", () => {
    expect(uniqueKey("The Horus Heresy", [])).toBe("the-horus-heresy");
    expect(uniqueKey("Heresy", ["heresy"])).toBe("heresy-2");
    expect(uniqueKey("Heresy", ["heresy", "heresy-2"])).toBe("heresy-3");
  });

  it("makes a record with every book in, in the order given", () => {
    const r = newSeriesRecord("mine", "  Mine ", ["d", "e"], "2026-09-08T00:00:00Z");
    expect(r).toEqual({ key: "mine", name: "Mine", decidedAt: "2026-09-08T00:00:00Z", choices: [
      { bookId: "d", included: true, order: 1 },
      { bookId: "e", included: true, order: 2 },
    ] });
  });

  it("is a series of its own when detection found nothing, without the books that left the shelf", () => {
    const r = newSeriesRecord("mine", "Mine", ["e", "gone", "d"]);
    const [g] = mergeSeries([], [r], onShelf);
    expect(g).toEqual({ key: "mine", name: "Mine", bookIds: ["e", "d"], added: ["e", "d"] });
    expect(isHandMade(g!)).toBe(true);
    expect(mergeSeries([], [newSeriesRecord("empty", "Empty", ["gone"])], onShelf)).toEqual([]);
  });

  it("adds the books a record names to the series detection found", () => {
    const r = { key: "heresy", name: "Heresy", decidedAt: "", choices: [
      { bookId: "b", included: true, order: 1 },
      { bookId: "d", included: false, order: 2 },
      { bookId: "a", included: true, order: 3 },
    ] };
    const [g] = mergeSeries(detected, [r], onShelf);
    expect(g).toEqual({ key: "heresy", name: "Heresy", bookIds: ["a", "b", "c", "d"], added: ["d"] });
    expect(isHandMade(g!)).toBe(false);
    // A record that only orders the detected books adds nothing.
    expect(mergeSeries(detected, [{ ...r, choices: r.choices.slice(0, 1) }], onShelf)[0]).toEqual(detected[0]);
  });
});

describe("series record", () => {
  it("round-trips through CSV", async () => {
    const record = { key: "heresy", name: "The Horus Heresy", decidedAt: "2026-09-07T02:00:00.000Z", choices: [
      { bookId: "a", included: true, order: 1 },
      { bookId: "b", included: false, order: 2 },
    ] };
    expect(await bytesToSeries("heresy", await seriesToBytes(record))).toEqual(record);
    expect(await bytesToSeries("empty", await seriesToBytes({ ...record, choices: [] }))).toBeNull();
  });
});
