import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nodeHost } from "../src/host/node";
import { LibraryService } from "../src/app/library";
import { openingPlace, parseKeptPlaces, ReadingKeeper, SHARE_AFTER_MS } from "../src/app/reading";
import { compact, isTextPos, mergePlaces, mergeTextPlaces, parseLog, textClaimsFor, type LogRecord } from "../src/core/poslog";
import { locatorOf } from "../src/core/reading/place";
import { EBOOK_FORMAT, type Ebook } from "../src/core/ebook";

const book: Ebook = {
  format: EBOOK_FORMAT,
  meta: { title: "T", authors: [], identifiers: [{ scheme: "isbn", value: "9781836093152" }, { scheme: "uuid", value: "9c3e2701-97e8-4a84-8845-fac671bbf378" }, { scheme: "other", value: "x" }] },
  layout: "reflowable",
  sections: [{ href: "one.xhtml", linear: true, overlay: null, chars: 60, blocks: [{ k: "p", runs: [{ t: "It was a giant circle of wraithbone, five miles across it." }] }] }],
  toc: [],
};

const textPos = (dev: string, seq: number, t: string, progression: number, why = "pause") =>
  JSON.stringify({ v: 1, k: "pos", dev, seq, t, book: { ids: ["urn:ribbon:abc-text"] }, why, loc: { href: "one.xhtml", type: "application/xhtml+xml", locations: { progression, totalProgression: progression } } });
const audioPos = (dev: string, seq: number, t: string, ms: number) => JSON.stringify({ v: 1, k: "pos", dev, seq, t, book: { ids: ["urn:ribbon:abc"] }, why: "pause", ms });

describe("reading places in the position log (format 1.1)", () => {
  it("claim the text edition only: Ribbon's text claim and the EPUB's ISBN and uuid", () => {
    expect(textClaimsFor("abc", book.meta.identifiers)).toEqual(["urn:ribbon:abc-text", "urn:isbn:9781836093152", "urn:uuid:9c3e2701-97e8-4a84-8845-fac671bbf378"]);
  });

  it("are read beside listening places without either touching the other", () => {
    const { records, skipped } = parseLog([audioPos("a", 1, "2026-10-01T10:00:00.000Z", 5000), textPos("a", 2, "2026-10-01T11:00:00.000Z", 0.4), textPos("b", 1, "2026-10-01T12:00:00.000Z", 0.6)].join("\n"));
    expect(skipped).toBe(0);
    expect(records.filter(isTextPos)).toHaveLength(2);
    // The newer reading place does not move the listening place, nor the other way round.
    expect(mergePlaces(records).get("abc")!.ms).toBe(5000);
    expect(mergeTextPlaces(records).get("abc")!.loc.locations!.progression).toBe(0.6);
  });

  it("let a fresh start lose to real progress, as listening places do", () => {
    const { records } = parseLog([textPos("a", 1, "2026-10-01T10:00:00.000Z", 0.3), JSON.stringify({ ...JSON.parse(textPos("b", 1, "2026-10-02T10:00:00.000Z", 0)), why: "open" })].join("\n"));
    expect(mergeTextPlaces(records).get("abc")!.loc.locations!.progression).toBe(0.3);
  });

  it("are refused when they carry neither a time nor a locator", () => {
    const { records, skipped } = parseLog(JSON.stringify({ v: 1, k: "pos", dev: "a", seq: 1, t: "2026-10-01T10:00:00.000Z", book: { ids: ["x"] }, why: "pause" }));
    expect(records).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it("are compacted per edition: the latest text place stays beside the latest audio place", () => {
    const raw = [audioPos("a", 1, "2026-10-01T10:00:00.000Z", 1), textPos("a", 2, "2026-10-01T10:01:00.000Z", 0.1), audioPos("a", 3, "2026-10-01T10:02:00.000Z", 2), textPos("a", 4, "2026-10-01T10:03:00.000Z", 0.2)].map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(compact(raw).map((r) => r.seq)).toEqual([3, 4]);
  });
});

describe("keeping the reading place", () => {
  it("keeps it on this machine at every move, and beside the books once the page settles, or at once for a jump", async () => {
    vi.useFakeTimers();
    try {
      const local: string[] = [];
      const shared: string[] = [];
      const k = new ReadingKeeper(book, { section: 0, block: 0, offset: 0 }, { keepLocal: (kept) => local.push(kept.loc.text!.highlight!), share: async (loc, why) => void shared.push(`${why}:${loc.text!.highlight!.split(" ")[0]}`) });
      k.move({ section: 0, block: 0, offset: 9 }, "periodic");
      k.move({ section: 0, block: 0, offset: 15 }, "periodic");
      expect(local).toHaveLength(2);
      expect(shared).toEqual([]);
      await vi.advanceTimersByTimeAsync(SHARE_AFTER_MS);
      // One write for the page the reader settled on.
      expect(shared).toEqual(["periodic:circle"]);
      k.move({ section: 0, block: 0, offset: 25 }, "seek");
      await vi.advanceTimersByTimeAsync(0);
      expect(shared).toEqual(["periodic:circle", "seek:wraithbone,"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tries a failed write beside the books again with the next one", async () => {
    let fail = true;
    const shared: string[] = [];
    const k = new ReadingKeeper(book, { section: 0, block: 0, offset: 0 }, {
      keepLocal: () => undefined,
      share: async (loc) => {
        if (fail) throw new Error("share away");
        shared.push(loc.text!.highlight!.split(" ")[0]!);
      },
    });
    k.move({ section: 0, block: 0, offset: 9 }, "seek");
    await k.flush();
    expect(shared).toEqual([]);
    fail = false;
    await k.flush();
    expect(shared).toEqual(["giant"]);
  });

  it("opens at the newer of this machine's place and the log's, else at the start", () => {
    const at = (offset: number) => locatorOf(book, { section: 0, block: 0, offset });
    expect(openingPlace(book, { loc: at(9), t: "2026-10-02T00:00:00.000Z" }, { loc: at(25), t: "2026-10-01T00:00:00.000Z" }).offset).toBe(9);
    expect(openingPlace(book, { loc: at(9), t: "2026-10-01T00:00:00.000Z" }, { loc: at(25), t: "2026-10-02T00:00:00.000Z" }).offset).toBe(25);
    expect(openingPlace(book, undefined, undefined)).toEqual({ section: 0, block: 0, offset: 0 });
    expect(parseKeptPlaces({ a: { loc: at(9), t: "x" }, b: { t: "x" }, c: null })).toEqual({ a: { loc: at(9), t: "x" } });
  });
});

describe("reading places beside the books", () => {
  let root = "";
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-reading-"));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("are written to this device's log and read back merged", async () => {
    const lib = new LibraryService(nodeHost(), root);
    lib.setDevice("11111111-1111-1111-1111-111111111111");
    await lib.writeTextPlace("abc", book.meta.identifiers, locatorOf(book, { section: 0, block: 0, offset: 9 }), "pause", Date.parse("2026-10-01T10:00:00.000Z"));
    await lib.writeTextPlace("abc", book.meta.identifiers, locatorOf(book, { section: 0, block: 0, offset: 15 }), "close", Date.parse("2026-10-01T10:05:00.000Z"));
    const places = await lib.readTextPlaces(Date.parse("2026-10-02T00:00:00.000Z"));
    expect(places.get("abc")!.loc.text!.highlight!.startsWith("circle")).toBe(true);
    // Nothing in the log looks like a listening place.
    expect((await lib.readAllPositions()).size).toBe(0);
    const text = await fs.readFile(path.join(root, ".ribbon", "positions", "11111111-1111-1111-1111-111111111111.ndjson"), "utf8");
    const records = text.trim().split("\n").map((l) => JSON.parse(l) as LogRecord);
    expect(records.every((r) => r.k === "pos" && r.ms === undefined)).toBe(true);
  });
});
