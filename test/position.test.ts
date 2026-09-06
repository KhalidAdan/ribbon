import { describe, expect, it } from "vitest";
import { comparePositions, mergePositions, nowIso, parsePositions, serializePosition } from "../src/core/position";
import type { Position } from "../src/core/types";

const p = (over: Partial<Position> = {}): Position => ({
  bookId: "abcd1234",
  offsetMs: 123_456,
  updatedAt: "2026-09-05T20:00:00.000Z",
  device: "kitchen",
  ...over,
});

describe("position file", () => {
  it("round-trips", async () => {
    const bytes = await serializePosition(p());
    const text = new TextDecoder().decode(bytes);
    expect(text).toBe("book_id,offset_ms,updated_at,device\nabcd1234,123456,2026-09-05T20:00:00.000Z,kitchen\n");
    const { positions, problems } = await parsePositions(bytes);
    expect(problems).toEqual([]);
    expect(positions).toEqual([p()]);
  });

  it("writes ISO 8601 with milliseconds and Z", () => {
    expect(nowIso(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(nowIso(1_757_102_400_123)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("rounds and floors offsets", async () => {
    const bytes = await serializePosition(p({ offsetMs: -4.6 }));
    expect((await parsePositions(bytes)).positions[0]?.offsetMs).toBe(0);
    const b2 = await serializePosition(p({ offsetMs: 10.6 }));
    expect((await parsePositions(b2)).positions[0]?.offsetMs).toBe(11);
  });

  it("skips malformed rows and reports them", async () => {
    const text = "book_id,offset_ms,updated_at,device\nabcd,1\nabcd,5,not-a-date,y\nabcd,7,2026-01-01T00:00:00.000Z,z\n";
    const { positions, problems } = await parsePositions(new TextEncoder().encode(text));
    expect(positions.map((x) => x.offsetMs)).toEqual([7]);
    expect(problems).toHaveLength(2);
  });

  it("does not throw on an unterminated quote", async () => {
    const text = 'book_id,offset_ms,updated_at,device\n"abcd,1,2026-01-01T00:00:00.000Z,x\n';
    const { positions, problems } = await parsePositions(new TextEncoder().encode(text));
    expect(positions).toEqual([]);
    expect(problems.length).toBeGreaterThanOrEqual(1);
  });

  it("survives CRLF and a BOM", async () => {
    const text = "﻿book_id,offset_ms,updated_at,device\r\nabcd,9,2026-01-01T00:00:00.000Z,z\r\n";
    const { positions } = await parsePositions(new TextEncoder().encode(text));
    expect(positions).toHaveLength(1);
    expect(positions[0]?.bookId).toBe("abcd");
  });
});

describe("mergePositions", () => {
  it("keeps the latest", () => {
    const a = p({ offsetMs: 1, updatedAt: "2026-09-05T20:00:00.000Z" });
    const b = p({ offsetMs: 2, updatedAt: "2026-09-05T20:00:01.000Z", device: "car" });
    expect(mergePositions([a, b], "abcd1234")).toEqual(b);
    expect(mergePositions([b, a], "abcd1234")).toEqual(b);
  });

  it("breaks ties by device name", () => {
    const a = p({ offsetMs: 1, device: "alpha" });
    const b = p({ offsetMs: 2, device: "beta" });
    expect(mergePositions([a, b], "abcd1234")).toEqual(b);
    expect(mergePositions([b, a], "abcd1234")).toEqual(b);
  });

  it("ignores other books and empty input", () => {
    expect(mergePositions([p({ bookId: "other" })], "abcd1234")).toBeNull();
    expect(mergePositions([], "abcd1234")).toBeNull();
  });

  it("compares by parsed time, not string", () => {
    const a = p({ updatedAt: "2026-09-05T20:00:00.000Z" });
    const b = p({ updatedAt: "2026-09-05T21:00:00.000+01:00" });
    expect(comparePositions(a, b)).toBe(0);
  });
});
