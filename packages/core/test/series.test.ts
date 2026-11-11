import { describe, expect, it } from "vitest";
import { bytesToSeries, defaultChoices, deletedSeriesRecord, detectSeries, excludeShorterThan, hiddenBookIds, isHandMade, mergeSeries, newSeriesRecord, normalizeChoices, offTheShelf, orderBySeries, seriesToBytes, slug, uniqueKey } from "@ribbon/core/series";
import type { Book } from "@ribbon/core/types";

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

describe("titles", () => {
  // The Siege of Terra as a store titles it: no series tag and no numbered folder.
  const siege = [
    "The Solar War: Siege of Terra: The Horus Heresy, Book 1",
    "The Lost and the Damned: Siege of Terra: The Horus Heresy, Book 2",
    "The First Wall: Siege of Terra: The Horus Heresy, Book 3",
    "Leviathan Wakes (The Expanse, Book 1)",
    "Caliban's War (The Expanse, Book 2)",
    "Abaddon's Gate (The Expanse, Book 3)",
  ].map((title, i) => book(`b${i}`, { title }));

  it("are never read for a series, however a store words them", () => {
    expect(detectSeries(siege, "Lib")).toEqual([]);
  });

  it("change nothing about the series a tag names", () => {
    const tagged = siege.map((b, i) => (i < 3 ? { ...b, series: "Siege of Terra", seriesIndex: i + 1 } : b));
    expect(detectSeries(tagged, "Lib")).toEqual([{ key: "siege-of-terra", name: "Siege of Terra", bookIds: ["b0", "b1", "b2"], numbers: { b0: 1, b1: 2, b2: 3 } }]);
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

  it("keep a book on the shelf while any series it's in keeps it", () => {
    const heresy = { key: "heresy", name: "The Horus Heresy", bookIds: ["horus", "brotherhood", "scars"] };
    const list = { key: "white-scars", name: "White Scars", bookIds: ["brotherhood", "scars"] };
    const unread = { key: "unread", name: "Unread", bookIds: ["scars"] };
    // The novellas are left out of The Horus Heresy; White Scars, made by hand, keeps Brotherhood of the Storm.
    const records = {
      heresy: { key: "heresy", name: "The Horus Heresy", decidedAt: "", choices: [
        { bookId: "horus", included: true, order: 1 },
        { bookId: "brotherhood", included: false, order: 2 },
        { bookId: "scars", included: false, order: 3 },
      ] },
      "white-scars": { key: "white-scars", name: "White Scars", decidedAt: "", choices: [
        { bookId: "brotherhood", included: true, order: 1 },
        { bookId: "scars", included: false, order: 2 },
      ] },
    };
    expect([...offTheShelf([heresy, list], records)]).toEqual(["scars"]);
    // A series with no record leaves nothing out.
    expect([...offTheShelf([heresy, list, unread], records)]).toEqual([]);
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

describe("a series the listener deleted", () => {
  const onShelf = new Set(["a", "b", "c", "d"]);
  const detected = [
    { key: "heresy", name: "Heresy", bookIds: ["a", "b", "c"] },
    { key: "expanse", name: "The Expanse", bookIds: ["d"] },
  ];

  it("is gone, though its books' tags still name it, and the other series are as they were", () => {
    const gone = deletedSeriesRecord("heresy", "Heresy", "2026-11-10T00:00:00Z");
    expect(mergeSeries(detected, [gone], onShelf)).toEqual([detected[1]]);
    // Its books are off no shelf: it leaves nothing out.
    expect(hiddenBookIds([gone])).toEqual(new Set());
  });

  it("is kept beside the books as a record with no books in it", async () => {
    const gone = deletedSeriesRecord("heresy", "Heresy", "2026-11-10T00:00:00Z");
    expect(gone).toEqual({ key: "heresy", name: "Heresy", decidedAt: "2026-11-10T00:00:00Z", choices: [], deleted: true });
    expect(await bytesToSeries("heresy", await seriesToBytes(gone))).toEqual(gone);
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
