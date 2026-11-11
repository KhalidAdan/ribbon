import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bytesToSeries, hiddenBookIds, mergeSeries, orderBySeries, seriesNumber, seriesToBytes, sortByNumber, type SeriesChoice, type SeriesGroup, type SeriesRecord } from "@ribbon/core/series";
import { nodeHost } from "@ribbon/host-node/node";
import { AppController, type Platform } from "../src/app/controller";
import { memorySources } from "../src/app/platform";
import { FIXTURE_ROOT } from "../tools/make-fixtures";

const choice = (bookId: string, order: number, extra: Partial<SeriesChoice> = {}): SeriesChoice => ({ bookId, included: true, order, ...extra });

/** Until the rescan that opening a cached library starts behind it is done. */
async function rescanned(c: AppController): Promise<void> {
  const started = Date.now();
  while (c.getState().scanning !== null || c.getState().lastScanMs === null) {
    if (Date.now() - started > 60_000) throw new Error("timed out waiting for the rescan");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("series numbers", () => {
  it("a numbered book goes where its number says; unnumbered ones keep their neighbours", () => {
    const sorted = sortByNumber([choice("a", 1), choice("b", 2), choice("c", 3, { number: 1.5 }), choice("d", 4)]);
    expect(sorted.map((c) => c.bookId)).toEqual(["a", "c", "b", "d"]);
    expect(sorted.map((c) => c.order)).toEqual([1, 2, 3, 4]);
  });

  it("all numbered: plain numeric order, decimals between whole numbers", () => {
    expect(sortByNumber([choice("x", 1, { number: 3 }), choice("y", 2, { number: 2.5 }), choice("z", 3, { number: 1 })]).map((c) => c.bookId)).toEqual(["z", "y", "x"]);
  });

  it("show as the listener's number, or the position", () => {
    const r: SeriesRecord = { key: "k", name: "S", decidedAt: "", choices: [choice("a", 1, { number: 0.5 }), choice("b", 2)] };
    expect(seriesNumber(r, "a", 1)).toBe("0.5");
    expect(seriesNumber(r, "b", 2)).toBe("2");
    expect(seriesNumber(undefined, "b", 7)).toBe("7");
  });

  it("show as the number detection found when the listener gave none, and sort by it", () => {
    // Book 8 in three parts: the ninth and tenth on the shelf are still book 8.
    const detected = { a: 7, b: 8, c: 8, d: 8 };
    const r: SeriesRecord = { key: "k", name: "S", decidedAt: "", choices: [choice("a", 1), choice("b", 2, { number: 7.5 }), choice("c", 3)] };
    expect(seriesNumber(r, "b", 2, detected)).toBe("7.5");
    expect(seriesNumber(r, "c", 3, detected)).toBe("8");
    expect(seriesNumber(undefined, "d", 4, detected)).toBe("8");
    expect(seriesNumber(undefined, "e", 5, detected)).toBe("5");
    // Numbering the fourth 7.2 puts it before the 7.5, among detected numbers rather than positions.
    expect(sortByNumber([choice("a", 1), choice("b", 2, { number: 7.5 }), choice("c", 3), choice("d", 4, { number: 7.2 })], detected).map((c) => c.bookId)).toEqual(["a", "d", "b", "c"]);
  });

  it("round-trip through the record, with removals", async () => {
    const r: SeriesRecord = { key: "k", name: "The Series", decidedAt: "2026-10-18T00:00:00.000Z", choices: [choice("a", 1, { number: 2.5 }), choice("b", 2, { removed: true }), choice("c", 3, { included: false })] };
    expect(await bytesToSeries("k", await seriesToBytes(r))).toEqual(r);
  });
});

describe("renames and removals", () => {
  const detected: SeriesGroup[] = [{ key: "heresy", name: "Warhammer 40K - The Horus Heresy", bookIds: ["a", "b", "c", "d"] }];
  const onShelf = new Set(["a", "b", "c", "d", "x"]);

  it("a record's name is the series' name", () => {
    const [g] = mergeSeries(detected, [{ key: "heresy", name: "The Horus Heresy", decidedAt: "", choices: [] }], onShelf);
    expect(g!.name).toBe("The Horus Heresy");
  });

  it("a book taken out leaves the series but stays on the shelf", () => {
    const r: SeriesRecord = { key: "heresy", name: "", decidedAt: "", choices: [choice("a", 1), choice("b", 2, { removed: true }), choice("c", 3), choice("d", 4)] };
    const [g] = mergeSeries(detected, [r], onShelf);
    expect(g!.bookIds).toEqual(["a", "c", "d"]);
    expect(g!.name).toBe("Warhammer 40K - The Horus Heresy");
    expect(hiddenBookIds([r]).has("b")).toBe(false);
  });

  it("a removed book does not hold a slot in the series order", () => {
    const r: SeriesRecord = { key: "heresy", name: "", decidedAt: "", choices: [choice("c", 1), choice("b", 2, { removed: true }), choice("a", 3)] };
    expect(orderBySeries(["a", "b", "c"], (x) => x, [r])).toEqual(["c", "b", "a"]);
  });
});

function platform(root: string): Platform {
  return { host: nodeHost(), pickFolder: async () => root, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources() };
}

describe("editing a series through the app", () => {
  afterAll(async () => {
    await fs.rm(path.join(FIXTURE_ROOT, ".ribbon", "series"), { recursive: true, force: true });
  });

  it("renames, numbers, and moves a book into another series, and it all survives a fresh start", async () => {
    const c = new AppController(platform(FIXTURE_ROOT));
    await c.pickLibrary();
    const ids = c.getState().books.map((b) => b.book.id);
    await c.createSeries("First", ids.slice(0, 3));
    await c.createSeries("Second", ids.slice(3, 6));
    const first = c.detectedSeries().find((g) => g.name === "First")!;
    const second = c.detectedSeries().find((g) => g.name === "Second")!;

    c.openSeriesSetup(first.key);
    const record = c.getState().series[first.key]!;
    const choices = record.choices.map((ch, i) => (i === 2 ? { ...ch, number: 0.5 } : ch));
    await c.saveSeries(sortByNumber(choices), { name: "First, renamed", moves: [{ bookId: ids[1]!, toKey: second.key }] });

    const check = (ctl: AppController) => {
      const groups = ctl.detectedSeries();
      const f = groups.find((g) => g.key === first.key)!;
      const s = groups.find((g) => g.key === second.key)!;
      expect(f.name).toBe("First, renamed");
      expect(f.bookIds).not.toContain(ids[1]);
      expect(s.bookIds).toContain(ids[1]);
      const r = ctl.getState().series[first.key]!;
      expect(orderBySeries(f.bookIds, (x) => x, [r])[0]).toBe(ids[2]);
      expect(seriesNumber(r, ids[2]!, 1)).toBe("0.5");
      expect(ctl.getState().books.some((b) => b.book.id === ids[1])).toBe(true);
    };
    check(c);

    const again = new AppController(platform(FIXTURE_ROOT));
    await again.pickLibrary();
    check(again);
    // Both opened a cached library, so a rescan runs behind each. Its logging must not outlive the
    // file: on a slow runner vitest failed the run ("Closing rpc while onUserConsoleLog was pending").
    await rescanned(c);
    await rescanned(again);
  });
});

describe("deleting a series its folders make", () => {
  let root = "";
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("deletes it for good, though the folders still say it's there, and leaves the books on the shelf", async () => {
    // Three numbered folders straight under the library folder: a series named after it.
    root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-delete-series-")), "The Primarchs");
    for (const name of ["01. Lion", "02. Fulgrim", "03. Perturabo"]) await fs.cp(path.join(FIXTURE_ROOT, "20. The Primarchs"), path.join(root, name), { recursive: true });
    const c = new AppController(platform(root));
    await c.pickLibrary();
    await rescanned(c);
    expect(c.detectedSeries().map((g) => [g.key, g.bookIds.length])).toEqual([["the-primarchs", 3]]);
    // Found, and never set up: there's no record of it yet.
    expect(c.getState().series["the-primarchs"]).toBeUndefined();

    c.openSeries("the-primarchs");
    await c.deleteSeries("the-primarchs");
    expect(c.detectedSeries()).toEqual([]);
    expect(c.getState()).toMatchObject({ pane: "library", seriesSetup: null });
    expect(c.getState().books).toHaveLength(3);
    const kept = await bytesToSeries("the-primarchs", await fs.readFile(path.join(root, ".ribbon", "series", "the-primarchs.csv")));
    expect(kept).toMatchObject({ name: "The Primarchs", deleted: true, choices: [] });

    // A fresh start reads the same folders and doesn't bring it back, or offer to set it up.
    const again = new AppController(platform(root));
    await again.pickLibrary();
    await rescanned(again);
    expect(again.getState().books).toHaveLength(3);
    expect(again.detectedSeries()).toEqual([]);
    expect(again.getState().seriesSetup).toBeNull();

    // A series made by hand under the same name is its own, with only the books it's given.
    const [first] = again.getState().books.map((b) => b.book.id);
    await again.createSeries("The Primarchs", [first!]);
    expect(again.detectedSeries()).toEqual([{ key: "the-primarchs-2", name: "The Primarchs", bookIds: [first], added: [first] }]);
  });
});

describe("a book in two series", () => {
  let root = "";
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  // The owner's White Scars list starts at Scars, which The Horus Heresy has too: opened from White Scars, Scars's
  // page listed The Horus Heresy, the series last opened.
  it("lists the series its page was opened from", async () => {
    root = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-two-series-")), "The Primarchs");
    for (const name of ["01. Lion", "02. Fulgrim", "03. Perturabo"]) await fs.cp(path.join(FIXTURE_ROOT, "20. The Primarchs"), path.join(root, name), { recursive: true });
    const c = new AppController(platform(root));
    await c.pickLibrary();
    await rescanned(c);
    const [lion, fulgrim] = orderBySeries(c.detectedSeries()[0]!.bookIds, (x) => x, []);
    await c.createSeries("A reading list", [fulgrim!, lion!]);
    const list = c.detectedSeries().find((g) => g.name === "A reading list")!;
    const listed = () => c.seriesOfBook(c.getState().readerBookId!)[0]!.key;

    // The Primarchs was open last; then the reading list's first book is opened from its card.
    c.openSeries("the-primarchs");
    c.showLibrary();
    c.openReader(fulgrim!, list.key);
    expect(listed()).toBe(list.key);
    // Down its list, to a book The Primarchs has too: still the reading list.
    c.openReader(lion!, list.key);
    expect(listed()).toBe(list.key);
    // From The Primarchs' page, the same book lists The Primarchs.
    c.openSeries("the-primarchs");
    c.openReader(lion!, "the-primarchs");
    expect(listed()).toBe("the-primarchs");
    // Opened from no series, as from Continue: the series opened last.
    c.showLibrary();
    c.openReader(fulgrim!);
    expect(listed()).toBe("the-primarchs");
  });
});
