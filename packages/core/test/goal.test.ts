import { describe, expect, it } from "vitest";
import { goalToday, GoalWatch, newerGoal, NO_GOAL } from "@ribbon/core/goal";
import { ribbonClaim, type SessionRecord } from "@ribbon/core/poslog";
import { totals } from "@ribbon/core/stats";

const MIN = 60_000;
const listened = (start: string, ms: number): SessionRecord => ({ v: 1, k: "session", dev: "d", seq: 1, t: start, book: { ids: [ribbonClaim("b")] }, start, end: start, from_ms: 0, to_ms: ms, listened_ms: ms });
const noon = (day: number) => Date.parse(`2026-11-${String(day).padStart(2, "0")}T12:00:00.000Z`);

describe("a daily goal", () => {
  const days = [listened("2026-11-01T09:00:00.000Z", 25 * MIN), listened("2026-11-02T09:00:00.000Z", 20 * MIN), listened("2026-11-03T09:00:00.000Z", 12 * MIN)];

  it("is met by the time kept today and what's going on now, and counts the days in a row", () => {
    expect(goalToday(days, 20, noon(3), 0)).toEqual({ todayMs: 12 * MIN, met: false, streakDays: 2 });
    expect(goalToday(days, 20, noon(3), 0, 8 * MIN)).toEqual({ todayMs: 20 * MIN, met: true, streakDays: 3 });
    // A day missed ends the streak.
    expect(goalToday(days, 25, noon(3), 0, 13 * MIN)).toMatchObject({ met: true, streakDays: 1 });
  });

  it("is off at nothing", () => {
    expect(goalToday(days, 0, noon(3), 0, 60 * MIN)).toMatchObject({ met: false, streakDays: 0 });
  });

  it("is the one chosen later, on whichever device", () => {
    const here = { minutes: 20, chosenAt: "2026-11-03T10:00:00.000Z" };
    const there = { minutes: 30, chosenAt: "2026-11-03T11:00:00.000Z" };
    expect(newerGoal(here, there)).toBe(there);
    expect(newerGoal(there, here)).toBe(there);
    expect(newerGoal(NO_GOAL, here)).toBe(here);
  });

  it("makes the Stats' streak count days it was met", () => {
    expect(totals(days, [], noon(3), 0).streakDays).toBe(3);
    expect(totals(days, [], noon(3), 0, 20).streakDays).toBe(2);
    expect(totals(days, [], noon(3), 0, 20).longestStreakDays).toBe(2);
  });
});

describe("saying the goal was met", () => {
  it("says so once, when it's met here after being seen not met today", () => {
    const watch = new GoalWatch();
    expect(watch.see({ todayMs: 10 * MIN, met: false, streakDays: 0 }, noon(3), 0, true)).toBe(false);
    expect(watch.see({ todayMs: 20 * MIN, met: true, streakDays: 1 }, noon(3), 0, true)).toBe(true);
    expect(watch.see({ todayMs: 25 * MIN, met: true, streakDays: 1 }, noon(3) + MIN, 0, true)).toBe(false);
    expect(watch.celebrated).not.toBeNull();
  });

  it("stays quiet about a goal already met when it starts, or already said today", () => {
    expect(new GoalWatch().see({ todayMs: 20 * MIN, met: true, streakDays: 1 }, noon(3), 0, true)).toBe(false);
    const said = new GoalWatch(Math.floor(noon(3) / 86_400_000));
    said.see({ todayMs: 0, met: false, streakDays: 0 }, noon(3), 0, true);
    expect(said.see({ todayMs: 20 * MIN, met: true, streakDays: 1 }, noon(3), 0, true)).toBe(false);
  });

  it("leaves a goal met by another device's time for that device to say", () => {
    const watch = new GoalWatch();
    watch.see({ todayMs: 10 * MIN, met: false, streakDays: 0 }, noon(3), 0, false);
    // The phone's listening synced in, and met it: nothing here.
    expect(watch.see({ todayMs: 20 * MIN, met: true, streakDays: 1 }, noon(3), 0, false)).toBe(false);
    expect(watch.see({ todayMs: 21 * MIN, met: true, streakDays: 1 }, noon(3) + MIN, 0, true)).toBe(false);
  });
});
