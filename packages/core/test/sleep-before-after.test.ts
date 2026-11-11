import { describe, expect, it } from "vitest";
import * as after from "@ribbon/core/sleep";
import * as before from "./before/sleep";

/**
 * The sleep timer became an explicit state machine (docs/STATE-MACHINES.md).
 * This proves it does what the old one did, event for event, in every
 * sequence of up to DEPTH events from a world of choices, waits, pauses,
 * seeks and ticks: after every event the old timer's state, read as the
 * new kind, is the new timer's state, and every tick says the same.
 *
 * One difference is meant, and only one is allowed: adding minutes to a
 * timer held while nothing plays. The old timer counted the time it had
 * been held as spent (a 10-minute timer held at minute 2 and given 5 more
 * at minute 5 had 10 left, not 13) and started its clock again though
 * nothing played. `before/sleep.ts` is the old timer, as it was.
 */

const DEPTH = 6;

/** What the timer is fed: the wall clock and where the book is. */
interface World {
  now: number;
  positionMs: number;
  chapterEndMs: number | null;
  speed: number;
}

type Event = { name: string; world?: (w: World) => World; old?: (s: before.SleepState, w: World) => before.SleepState; now?: (s: after.SleepState, w: World) => after.SleepState; tick?: true };

const EVENTS: Event[] = [
  { name: "start 60 s", old: (_, w) => before.start({ kind: "duration", ms: 60_000 }, w.now), now: (_, w) => after.start({ kind: "duration", ms: 60_000 }, w.now) },
  { name: "start chapter", old: (_, w) => before.start({ kind: "chapter" }, w.now), now: (_, w) => after.start({ kind: "chapter" }, w.now) },
  { name: "cancel", old: () => before.cancel(), now: () => after.cancel() },
  { name: "extend 30 s", old: (s, w) => before.extend(s, 30_000, w.now), now: (s, w) => after.extend(s, 30_000, w.now) },
  { name: "pause", old: (s, w) => before.pause(s, w.now), now: (s, w) => after.pause(s, w.now) },
  { name: "resume", old: (s, w) => before.resume(s, w.now), now: (s, w) => after.resume(s, w.now) },
  { name: "wait 5 s", world: (w) => ({ ...w, now: w.now + 5_000, positionMs: w.positionMs + 5_000 * w.speed }) },
  { name: "wait 50 s", world: (w) => ({ ...w, now: w.now + 50_000, positionMs: w.positionMs + 50_000 * w.speed }) },
  { name: "seek near the chapter's end", world: (w) => ({ ...w, positionMs: 117_000 }) },
  { name: "chapter end unknown, or known again", world: (w) => ({ ...w, chapterEndMs: w.chapterEndMs === null ? 120_000 : null }) },
  { name: "speed 2x, or 1x again", world: (w) => ({ ...w, speed: w.speed === 1 ? 2 : 1 }) },
  { name: "tick", tick: true },
];

/** The old timer's state, said as the new one says it. */
function said(s: before.SleepState): after.SleepState {
  if (!s.mode) return { status: "off" };
  if (s.fired) return { status: "done" };
  if (s.mode.kind === "chapter") return { status: "chapter" };
  if (s.pausedAt !== null) return { status: "held", leftMs: s.fireAt! - s.pausedAt };
  return { status: "counting", endsAt: s.fireAt! };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The one difference the change means: minutes added while held. */
function meant(event: Event, old: before.SleepState): boolean {
  return event.name.startsWith("extend") && old.mode?.kind === "duration" && !old.fired && old.pausedAt !== null;
}

describe("the sleep timer, before and after it was made explicit", () => {
  it(`does what it did in every sequence of up to ${DEPTH} events, except add minutes to a held timer properly`, () => {
    let steps = 0;
    let meantDifferences = 0;
    const problems: string[] = [];

    const walk = (path: string[], w: World, old: before.SleepState, now: after.SleepState): void => {
      if (path.length === DEPTH || problems.length > 0) return;
      for (const event of EVENTS) {
        steps++;
        const w2 = event.world ? event.world(w) : w;
        let old2 = event.old ? event.old(old, w2) : old;
        let now2 = event.now ? event.now(now, w2) : now;
        const route = [...path, event.name];
        if (event.tick) {
          const t = { nowMs: w2.now, positionMs: w2.positionMs, chapterEndMs: w2.chapterEndMs, speed: w2.speed, playing: true };
          const [o, oldOut] = before.tick(old2, t);
          const [n, nowOut] = after.tick(now2, t);
          old2 = o;
          now2 = n;
          if (!same(oldOut, nowOut)) problems.push(`${route.join(" → ")}: the old tick said ${JSON.stringify(oldOut)}, the new ${JSON.stringify(nowOut)}`);
        }
        if (!same(said(old2), now2)) {
          if (meant(event, old)) {
            meantDifferences++;
            continue;
          }
          problems.push(`${route.join(" → ")}: the old timer is ${JSON.stringify(said(old2))}, the new ${JSON.stringify(now2)}`);
        }
        walk(route, w2, old2, now2);
      }
    };

    walk([], { now: 1_000_000, positionMs: 0, chapterEndMs: 120_000, speed: 1 }, before.IDLE, after.OFF);
    expect(problems.slice(0, 5)).toEqual([]);
    // The walk reached the one place they differ, so it would have seen any other.
    expect(meantDifferences).toBeGreaterThan(0);
    expect(steps).toBeGreaterThan(3_000_000);
  }, 600_000);

  it("minutes added while held count from where the clock stopped", () => {
    // Ten minutes, held at minute 2, five more at minute 5.
    let s = after.start({ kind: "duration", ms: 10 * 60_000 }, 0);
    s = after.pause(s, 2 * 60_000);
    s = after.extend(s, 5 * 60_000, 5 * 60_000);
    const t = { positionMs: 0, chapterEndMs: null, speed: 1, playing: false };
    expect(after.tick(s, { ...t, nowMs: 5 * 60_000 })[1].remainingMs).toBe(13 * 60_000);
    // Held as long as nothing plays.
    expect(after.tick(s, { ...t, nowMs: 60 * 60_000 })[1].remainingMs).toBe(13 * 60_000);
    // The old timer had lost the three minutes held, and started counting though nothing played.
    let o = before.start({ kind: "duration", ms: 10 * 60_000 }, 0);
    o = before.pause(o, 2 * 60_000);
    o = before.extend(o, 5 * 60_000, 5 * 60_000);
    expect(before.tick(o, { ...t, nowMs: 5 * 60_000 })[1].remainingMs).toBe(10 * 60_000);
  });

  it("a timer held past its end has nothing left to add to, so it gets just the minutes added", () => {
    let s = after.start({ kind: "duration", ms: 60_000 }, 0);
    s = after.pause(s, 70_000);
    expect(after.extend(s, 30_000, 90_000)).toEqual({ status: "held", leftMs: 30_000 });
  });
});
