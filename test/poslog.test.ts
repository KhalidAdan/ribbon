import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compact, encodeRecord, FUTURE_SLACK_MS, locatorFor, mergeById, mergePlace, mergePlaces, nextSeq, parseLog, ribbonClaim, type LogRecord, type PosRecord, type ReadRecord } from "../src/core/poslog";
import { LibraryService } from "../src/app/library";
import { nodeHost } from "../src/host/node";

const T0 = Date.parse("2026-10-18T12:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function pos(dev: string, seq: number, min: number, ms: number, why: PosRecord["why"] = "pause", ids = [ribbonClaim("b1")]): PosRecord {
  return { v: 1, k: "pos", dev, seq, t: at(min), book: { ids }, ms, why };
}

describe("reading a log", () => {
  it("ignores a cut-off last line and lines it does not understand", () => {
    const text = encodeRecord(pos("d1", 1, 0, 1000)) + encodeRecord({ v: 1, k: "wobble", dev: "d1", seq: 2, t: at(1), book: { ids: [] } }) + '{"v":1,"k":"pos","dev":"d1","se';
    const { records, raw, skipped } = parseLog(text);
    expect(records).toHaveLength(1);
    expect(raw).toHaveLength(2);
    expect(skipped).toBe(2);
  });
});

describe("the place", () => {
  it("latest across devices wins, and a deliberate rewind is a real place", () => {
    const place = mergePlace([pos("phone", 5, 10, 50_000), pos("desktop", 9, 20, 20_000, "seek")], T0 + 3_600_000);
    expect(place!.ms).toBe(20_000);
  });

  it("within one device its sequence decides, whatever its clock said", () => {
    const place = mergePlace([pos("d", 2, 30, 1000), pos("d", 3, 5, 9000)], T0 + 3_600_000);
    expect(place!.ms).toBe(9000);
  });

  it("a fast clock cannot win for days", () => {
    const now = T0 + 60 * 60_000;
    const fast = pos("fast", 1, 60 * 24 * 3, 99_000);
    // Counted as five minutes ago: it loses to a minute ago...
    expect(mergePlace([fast, pos("honest", 1, 59, 5_000)], now)!.dev).toBe("honest");
    // ...and still beats an hour ago.
    expect(mergePlace([fast, pos("honest", 1, 0, 5_000)], now)!.dev).toBe("fast");
    // A few minutes ahead is only a clock a little off, and counts as written.
    expect(mergePlace([pos("slightly", 1, 63, 7_000), pos("honest", 1, 59, 5_000)], now)!.dev).toBe("slightly");
    expect(FUTURE_SLACK_MS).toBe(300_000);
  });

  it("a fresh start never beats real progress", () => {
    const place = mergePlace([pos("phone", 1, 10, 40_000, "pause"), pos("new-laptop", 1, 50, 0, "open")], T0 + 3_600_000);
    expect(place!.ms).toBe(40_000);
    // A deliberate move to the start does win.
    expect(mergePlace([pos("phone", 1, 10, 40_000), pos("laptop", 1, 50, 0, "seek")], T0 + 3_600_000)!.ms).toBe(0);
  });

  it("ties go to the greater device, the same for every reader", () => {
    expect(mergePlace([pos("aaa", 1, 10, 1), pos("bbb", 1, 10, 2)], T0)!.ms).toBe(2);
    expect(mergePlace([pos("bbb", 1, 10, 2), pos("aaa", 1, 10, 1)], T0)!.ms).toBe(2);
  });

  it("books are the same when any claim is shared", () => {
    const fromDesktop = pos("desktop", 1, 10, 1000, "pause", [ribbonClaim("b1"), "urn:asin:B00X"]);
    const fromPhoneApp = pos("phone", 1, 20, 7000, "pause", ["urn:asin:B00X"]);
    const places = mergePlaces([fromDesktop, fromPhoneApp], T0 + 3_600_000);
    expect(places.get("b1")!.ms).toBe(7000);
  });
});

describe("reads and marks", () => {
  it("are the union, latest per id, minus what was taken back", () => {
    const read = (dev: string, min: number, id: string, finished?: string): ReadRecord => ({ v: 1, k: "read", dev, seq: min, t: at(min), book: { ids: [ribbonClaim("b1")] }, id, started: at(0), ...(finished ? { finished } : {}) });
    const records: LogRecord[] = [read("a", 1, "r1"), read("b", 5, "r1", at(5)), read("a", 2, "r2"), { v: 1, k: "del", dev: "a", seq: 9, t: at(9), book: { ids: [] }, of: "r2" }];
    const reads = mergeById<ReadRecord>(records, "read", T0 + 3_600_000);
    expect(reads.map((r) => [r.id, r.finished])).toEqual([["r1", at(5)]]);
  });
});

describe("compaction", () => {
  it("keeps the latest place per book and every other record, in order", () => {
    const raw = [pos("d", 1, 1, 1), { v: 1, k: "read", id: "r" }, pos("d", 2, 2, 2), pos("d", 3, 3, 3, "pause", [ribbonClaim("b2")]), { v: 1, k: "future-kind" }].map((r) => r as unknown as Record<string, unknown>);
    const kept = compact(raw);
    expect(kept.map((r) => (r.k === "pos" ? `pos:${r.ms}` : r.k))).toEqual(["read", "pos:2", "pos:3", "future-kind"]);
  });
});

describe("sequence and locator", () => {
  it("the sequence only increases", () => {
    expect(nextSeq(0, 1000)).toBe(1000);
    expect(nextSeq(5000, 1000)).toBe(5001);
  });

  it("a locator names the file, the time in it, and both progressions", () => {
    const loc = locatorFor([{ path: "a.mp3", durationMs: 60_000 }, { path: "b.m4a", durationMs: 40_000 }], 70_000, 100_000)!;
    expect(loc).toEqual({ href: "b.m4a", type: "audio/mp4", locations: { fragments: ["t=10.00"], progression: 0.25, totalProgression: 0.7, position: 2 } });
  });
});

describe("two devices, one folder", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-poslog-"));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("each writes only its own log, and both read the same place", async () => {
    const desktop = new LibraryService(nodeHost(), dir);
    desktop.setDevice("11111111-1111-4111-8111-111111111111");
    const laptop = new LibraryService(nodeHost(), dir);
    laptop.setDevice("22222222-2222-4222-8222-222222222222");
    await desktop.writePositionRecord(await desktop.positionAt("b1", 60_000, T0, "pause"));
    await laptop.writePositionRecord(await laptop.positionAt("b1", 90_000, T0 + 60_000, "pause"));
    await desktop.writePositionRecord(await desktop.positionAt("b2", 5_000, T0 + 120_000, "seek"));
    const names = (await fs.readdir(path.join(dir, ".ribbon", "positions"))).sort();
    expect(names).toContain("11111111-1111-4111-8111-111111111111.ndjson");
    expect(names).toContain("22222222-2222-4222-8222-222222222222.ndjson");
    expect(names).toContain("11111111-1111-4111-8111-111111111111.json");
    const a = await desktop.readAllPositions();
    const b = await laptop.readAllPositions();
    expect(a.get("b1")!.offsetMs).toBe(90_000);
    expect(b.get("b1")!.offsetMs).toBe(90_000);
    expect(a.get("b2")!.offsetMs).toBe(5_000);
  });

  it("still reads, and still writes, the per-book file of earlier versions", async () => {
    await fs.writeFile(path.join(dir, ".ribbon", "positions", "b3.csv"), `book_id,offset_ms,updated_at,device\nb3,123000,${at(1)},old-ribbon\n`);
    const lib = new LibraryService(nodeHost(), dir);
    expect((await lib.readAllPositions()).get("b3")).toMatchObject({ offsetMs: 123_000, device: "old-ribbon" });
    expect(await fs.readFile(path.join(dir, ".ribbon", "positions", "b1.csv"), "utf8")).toContain("90000");
  });

  it("a log over the size limit is compacted by its owner, and nothing is lost", async () => {
    const lib = new LibraryService(nodeHost(), dir);
    lib.setDevice("33333333-3333-4333-8333-333333333333");
    for (let i = 0; i < 1500; i++) await lib.appendRecord({ k: "pos", t: new Date(T0 + i).toISOString(), book: { ids: [ribbonClaim("b9")] }, why: "periodic", ms: i * 1000 });
    const file = path.join(dir, ".ribbon", "positions", "33333333-3333-4333-8333-333333333333.ndjson");
    expect((await fs.stat(file)).size).toBeGreaterThan(128 * 1024);
    await lib.compactOwnLog();
    const after = await fs.readFile(file, "utf8");
    expect(after.trim().split("\n")).toHaveLength(1);
    expect((await lib.readAllPositions()).get("b9")!.offsetMs).toBe(1_499_000);
  });
});
