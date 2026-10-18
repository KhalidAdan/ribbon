import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PositionKeeper } from "../src/app/positions";
import type { Position } from "../src/core/types";

function pos(bookId: string, offsetMs: number, at: string, device = "here"): Position {
  return { bookId, offsetMs, updatedAt: new Date(at).toISOString(), device };
}

function sinks() {
  const local: Position[][] = [];
  const share: Position[] = [];
  const logs: string[] = [];
  let shareDown = false;
  return {
    local,
    share,
    logs,
    down(v: boolean) {
      shareDown = v;
    },
    sinks: {
      local: async (all: Position[]) => void local.push(all.map((p) => ({ ...p }))),
      share: async (p: Position) => {
        await Promise.resolve();
        if (shareDown) throw new Error("the network name cannot be found");
        share.push(p);
      },
      log: (m: string) => void logs.push(m),
    },
  };
}

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
});

afterEach(() => vi.useRealTimers());

describe("PositionKeeper", () => {
  it("writes an urgent position to this machine and beside the books at once", async () => {
    const s = sinks();
    const k = new PositionKeeper(s.sinks);
    k.record(pos("a", 1000, "2026-10-18T12:00:00Z"), true);
    await settle();
    expect(s.local.at(-1)?.map((p) => p.offsetMs)).toEqual([1000]);
    expect(s.share.map((p) => p.offsetMs)).toEqual([1000]);
  });

  it("throttles the steady positions of a playing book", async () => {
    const s = sinks();
    const k = new PositionKeeper(s.sinks, { localEveryMs: 2_000, shareEveryMs: 15_000 });
    for (let i = 1; i <= 30; i++) {
      k.record(pos("a", i * 1000, new Date(Date.now()).toISOString()), false);
      await settle(1_000);
    }
    // 30 s of playing: a local write every 2 s or so, the share every 15 s or so.
    expect(s.local.length).toBeGreaterThanOrEqual(12);
    expect(s.local.length).toBeLessThanOrEqual(17);
    expect(s.share.length).toBeGreaterThanOrEqual(2);
    expect(s.share.length).toBeLessThanOrEqual(3);
    await k.flush();
    expect(s.share.at(-1)!.offsetMs).toBe(30_000);
    expect(s.local.at(-1)![0]!.offsetMs).toBe(30_000);
  });

  it("a burst of urgent positions writes the latest, not every one", async () => {
    const s = sinks();
    const k = new PositionKeeper(s.sinks);
    for (let i = 1; i <= 10; i++) k.record(pos("a", i * 15_000, "2026-10-18T12:00:00Z"), true);
    await settle(100);
    expect(s.share.at(-1)!.offsetMs).toBe(150_000);
    expect(s.share.length).toBeLessThanOrEqual(2);
  });

  it("keeps the position here while the share is away, and writes it when it is back", async () => {
    const s = sinks();
    const k = new PositionKeeper(s.sinks, { retryDelayMs: () => 1_000 });
    s.down(true);
    k.record(pos("a", 42_000, "2026-10-18T12:00:00Z"), true);
    await settle(100);
    expect(s.local.at(-1)![0]!.offsetMs).toBe(42_000);
    expect(s.share).toEqual([]);
    expect(k.pendingShare()).toBe(1);
    expect(s.logs.some((l) => l.includes("kept on this machine"))).toBe(true);
    await settle(5_000);
    expect(s.share).toEqual([]);
    s.down(false);
    await settle(1_500);
    expect(s.share.map((p) => p.offsetMs)).toEqual([42_000]);
    expect(k.pendingShare()).toBe(0);
  });

  it("a newer position recorded while a write fails is the one that lands", async () => {
    const s = sinks();
    const k = new PositionKeeper(s.sinks, { retryDelayMs: () => 500 });
    s.down(true);
    k.record(pos("a", 1_000, "2026-10-18T12:00:00Z"), true);
    await settle(100);
    k.record(pos("a", 9_000, "2026-10-18T12:00:05Z"), true);
    s.down(false);
    await settle(1_000);
    expect(s.share.at(-1)!.offsetMs).toBe(9_000);
  });

  it("an older position read from the share never replaces a newer one kept here", () => {
    const k = new PositionKeeper(sinks().sinks);
    k.record(pos("a", 90_000, "2026-10-18T12:00:00Z"), true);
    const changed = k.absorb([pos("a", 10_000, "2026-10-18T11:00:00Z", "laptop")]);
    expect(changed).toEqual([]);
    expect(k.get("a")!.offsetMs).toBe(90_000);
  });

  it("a newer position from another device is taken", () => {
    const k = new PositionKeeper(sinks().sinks);
    k.absorb([pos("a", 10_000, "2026-10-18T11:00:00Z")], { fromLocal: true });
    const changed = k.absorb([pos("a", 50_000, "2026-10-18T11:30:00Z", "phone")]);
    expect(changed).toEqual(["a"]);
    expect(k.get("a")!.device).toBe("phone");
  });

  it("positions newer here than beside the books are written back", async () => {
    const s = sinks();
    const k = new PositionKeeper(s.sinks);
    k.absorb([pos("a", 70_000, "2026-10-18T11:00:00Z"), pos("b", 5_000, "2026-10-18T10:00:00Z")], { fromLocal: true });
    const share = new Map([
      ["a", pos("a", 20_000, "2026-10-18T09:00:00Z")],
      ["b", pos("b", 5_000, "2026-10-18T10:00:00Z")],
    ]);
    expect(k.reconcile(share)).toBe(1);
    await settle(100);
    expect(s.share.map((p) => [p.bookId, p.offsetMs])).toEqual([["a", 70_000]]);
  });

  it("what the listener just did wins even when a clock elsewhere ran ahead", () => {
    const k = new PositionKeeper(sinks().sinks);
    k.absorb([pos("a", 99_000, "2026-10-18T13:00:00Z", "fast-clock")]);
    const kept = k.record(pos("a", 12_000, "2026-10-18T12:00:00Z"), true);
    expect(k.get("a")!.offsetMs).toBe(12_000);
    expect(Date.parse(kept.updatedAt)).toBeGreaterThan(Date.parse("2026-10-18T13:00:00Z"));
  });

  it("flush waits for both copies and never rejects", async () => {
    const s = sinks();
    const k = new PositionKeeper(s.sinks);
    s.down(true);
    k.record(pos("a", 1, "2026-10-18T12:00:00Z"), false);
    await expect(k.flush()).resolves.toBeUndefined();
    expect(s.local.length).toBe(1);
  });

  it("a failing local copy is retried with the next write", async () => {
    const s = sinks();
    let fail = true;
    const k = new PositionKeeper({
      ...s.sinks,
      local: async (all) => {
        if (fail) throw new Error("disk full");
        s.local.push(all);
      },
    });
    k.record(pos("a", 1, "2026-10-18T12:00:00Z"), true);
    await settle(10);
    expect(s.local.length).toBe(0);
    fail = false;
    await k.flush();
    expect(s.local.length).toBe(1);
  });
});
