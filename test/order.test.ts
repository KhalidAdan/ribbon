import { describe, expect, it } from "vitest";
import { compareBooks, compareOrderKeys, orderKey } from "../src/core/order";
import type { Book } from "../src/core/types";

const book = (path: string, title = path): Book => ({
  id: path,
  path,
  title,
  rawTitle: title,
  author: "",
  narrator: "",
  series: "",
  seriesIndex: null,
  year: null,
  cover: "",
  durationMs: 0,
  sizeBytes: 0,
  fileCount: 1,
});

describe("orderKey", () => {
  it("turns numbered segments into numbers and keeps the rest as text", () => {
    expect(orderKey("50. Born of Flame/1. Promethian Sun")).toEqual([50, 1]);
    expect(orderKey("01. Horus Rising")).toEqual([1]);
    expect(orderKey("Extras/Interviews")).toEqual(["Extras", "Interviews"]);
    expect(orderKey("2001: A Space Odyssey")).toEqual(["2001: A Space Odyssey"]);
  });
});

describe("compareOrderKeys", () => {
  it("orders numbers numerically and before names", () => {
    expect(compareOrderKeys([2], [10])).toBeLessThan(0);
    expect(compareOrderKeys([10], ["Appendix"])).toBeLessThan(0);
    expect(compareOrderKeys(["b"], ["a"])).toBeGreaterThan(0);
  });

  it("keeps an anthology's children together right after its number", () => {
    const keys = [[51], [50, 2], [49], [50, 1], [50]].sort(compareOrderKeys);
    expect(keys).toEqual([[49], [50], [50, 1], [50, 2], [51]]);
  });
});

describe("compareBooks", () => {
  it("files novellas under their anthology, not by their title letter", () => {
    const books = [book("50. Born of Flame/1. Promethian Sun", "Promethian Sun"), book("02. False Gods", "False Gods"), book("49. Wolfsbane", "Wolfsbane"), book("50. Born of Flame/2. Scorched Earth", "Scorched Earth"), book("01. Horus Rising", "Horus Rising"), book("51. Slaves to Darkness", "Slaves to Darkness")];
    const sorted = [...books].sort(compareBooks).map((b) => b.title);
    expect(sorted).toEqual(["Horus Rising", "False Gods", "Wolfsbane", "Promethian Sun", "Scorched Earth", "Slaves to Darkness"]);
  });

  it("falls back to natural title order for unnumbered folders", () => {
    const sorted = [book("Zeta", "Zeta"), book("alpha 10", "alpha 10"), book("alpha 2", "alpha 2")].sort(compareBooks).map((b) => b.title);
    expect(sorted).toEqual(["alpha 2", "alpha 10", "Zeta"]);
  });
});
