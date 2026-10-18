import { describe, expect, it } from "vitest";
import { bookIdOf, dayOf, finishedByRead, formatSpan, heatmap, openRead, readsOf, timeBy, totals } from "../src/core/stats";
import { ribbonClaim, type ReadRecord, type SessionRecord } from "../src/core/poslog";

const NOW = Date.parse("2026-10-18T20:00:00.000Z"); // a Sunday
const H = 3_600_000;

function session(book: string, startIso: string, listenedMs: number): SessionRecord {
  const start = Date.parse(startIso);
  return { v: 1, k: "session", dev: "d", seq: start, t: new Date(start + listenedMs).toISOString(), book: { ids: [ribbonClaim(book)] }, start: startIso, end: new Date(start + listenedMs).toISOString(), from_ms: 0, to_ms: listenedMs, listened_ms: listenedMs };
}

function read(book: string, id: string, started: string, finished?: string): ReadRecord {
  return { v: 1, k: "read", dev: "d", seq: 1, t: finished ?? started, book: { ids: [ribbonClaim(book)] }, id, started, ...(finished ? { finished } : {}) };
}

describe("reads", () => {
  const reads = [read("dune", "r1", "2025-01-01T00:00:00.000Z", "2025-02-01T00:00:00.000Z"), read("dune", "r2", "2026-10-01T00:00:00.000Z"), read("ego", "r3", "2026-03-01T00:00:00.000Z", "2026-03-20T00:00:00.000Z")];
  it("know which book, which is open, and whether the last was finished", () => {
    expect(bookIdOf(reads[0]!)).toBe("dune");
    expect(readsOf(reads, "dune").map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(openRead(reads, "dune")!.id).toBe("r2");
    expect(finishedByRead(reads, "dune")).toBe(false);
    expect(finishedByRead(reads, "ego")).toBe(true);
    expect(openRead(reads, "ego")).toBeNull();
  });
});

describe("totals", () => {
  const sessions = [
    session("dune", "2026-10-18T08:00:00.000Z", 1 * H),
    session("dune", "2026-10-17T21:00:00.000Z", 2 * H),
    session("ego", "2026-10-16T12:00:00.000Z", 0.5 * H),
    session("ego", "2026-10-10T12:00:00.000Z", 1 * H),
    session("dune", "2026-10-01T12:00:00.000Z", 3 * H),
  ];
  const reads = [read("ego", "r3", "2026-03-01T00:00:00.000Z", "2026-03-20T00:00:00.000Z"), read("dune", "r1", "2025-01-01T00:00:00.000Z", "2025-12-31T23:00:00.000Z")];
  it("today, the week, the streak and the year", () => {
    const t = totals(sessions, reads, NOW, 0);
    expect(t.todayMs).toBe(1 * H);
    expect(t.weekMs).toBe(3.5 * H);
    expect(t.streakDays).toBe(3);
    expect(t.longestStreakDays).toBe(3);
    expect(t.finishedThisYear).toBe(1);
    expect(t.totalMs).toBe(7.5 * H);
    expect(t.dailyAverageMs).toBe((7.5 * H) / 30);
  });

  it("a streak still counts when today has not started yet", () => {
    const t = totals(sessions.slice(1), [], NOW, 0);
    expect(t.streakDays).toBe(2);
  });

  it("days are local days", () => {
    // 23:30 UTC on the 17th is the 18th in UTC+1 (offset -60 minutes in JS terms).
    expect(dayOf(Date.parse("2026-10-17T23:30:00.000Z"), -60)).toBe(dayOf(Date.parse("2026-10-18T12:00:00.000Z"), 0));
  });

  it("time by book, most first", () => {
    expect(timeBy(sessions, (id) => [id])).toEqual([
      { key: "dune", ms: 6 * H },
      { key: "ego", ms: 1.5 * H },
    ]);
  });

  it("a year of weeks, Monday first, ending today, levels relative to the busy days", () => {
    const weeks = heatmap(sessions, NOW, 0);
    expect(weeks).toHaveLength(53);
    const last = weeks[weeks.length - 1]!;
    expect(last).toHaveLength(7); // Monday to Sunday the 18th
    expect(last[6]!.ms).toBe(1 * H);
    expect(last[5]!.ms).toBe(2 * H);
    expect(last[5]!.level).toBeGreaterThanOrEqual(last[6]!.level);
    expect(weeks.flat().filter((d) => d.level > 0)).toHaveLength(5);
  });

  it("formats spans", () => {
    expect(formatSpan(6 * H + 12 * 60_000)).toBe("6h 12m");
    expect(formatSpan(41 * 60_000)).toBe("41m");
    expect(formatSpan(0)).toBe("0m");
  });
});
