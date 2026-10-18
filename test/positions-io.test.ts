import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { nodeHost } from "../src/host/node";
import { LibraryService } from "../src/app/library";
import { recoveryDelayMs } from "../src/core/recovery";

let dir = "";

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ribbon-positions-"));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("positions beside the books", () => {
  it("a record written is the record read, conflict copies included", async () => {
    const lib = new LibraryService(nodeHost(), dir);
    const p = await lib.positionAt("abc", 12_345.6, Date.parse("2026-10-18T12:00:00Z"));
    expect(p.offsetMs).toBe(12_346);
    await lib.writePositionRecord(p);
    const older = { ...p, offsetMs: 5, updatedAt: "2026-10-18T11:00:00.000Z", device: "laptop" };
    await fs.writeFile(path.join(dir, ".ribbon", "positions", "abc (conflict).csv"), `book_id,offset_ms,updated_at,device\nabc,5,${older.updatedAt},laptop\n`);
    const all = await lib.readAllPositions();
    expect(all.get("abc")!.offsetMs).toBe(12_346);
  });

  it("a folder that is not there is an error, not an empty library", async () => {
    const lib = new LibraryService(nodeHost(), path.join(dir, "share-that-went-away"));
    await expect(lib.readAllPositions()).rejects.toThrow(/not reachable/);
  });

  it("a position is never NaN or negative", async () => {
    const lib = new LibraryService(nodeHost(), dir);
    expect((await lib.positionAt("x", Number.NaN)).offsetMs).toBe(0);
    expect((await lib.positionAt("x", -40)).offsetMs).toBe(0);
  });
});

describe("recovery backoff", () => {
  it("is quick at first, then patient, and never stops", () => {
    expect(recoveryDelayMs(0)).toBe(500);
    expect(recoveryDelayMs(1)).toBeGreaterThan(recoveryDelayMs(0));
    expect(recoveryDelayMs(50)).toBe(30_000);
    expect(recoveryDelayMs(-1)).toBe(500);
  });
});
