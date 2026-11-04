import { describe, expect, it } from "vitest";
import { ribbonClaim, type ReadRecord } from "@ribbon/core/poslog";
import { readingStandingOf, standingOf } from "@ribbon/core/progress";

const HOUR = 3_600_000;
const read = (finished?: string): ReadRecord => ({ v: 1, k: "read", dev: "d", seq: 1, t: "2026-10-23T00:00:00.000Z", book: { ids: [ribbonClaim("b1")] }, id: "r1", started: "2026-10-22T00:00:00.000Z", ...(finished ? { finished } : {}) });

describe("standingOf", () => {
  it("is not started with no place and no listen-throughs", () => {
    expect(standingOf(0, 10 * HOUR, [])).toEqual({ started: false, finished: false, fraction: 0 });
  });

  it("is started with a place, and says how far through", () => {
    expect(standingOf(HOUR, 10 * HOUR, [])).toEqual({ started: true, finished: false, fraction: 0.1 });
  });

  it("is finished by a place within a minute of the end", () => {
    expect(standingOf(10 * HOUR - 59_000, 10 * HOUR, []).finished).toBe(true);
    expect(standingOf(10 * HOUR - 61_000, 10 * HOUR, []).finished).toBe(false);
  });

  it("is finished within a tenth of the end of a short book", () => {
    expect(standingOf(95_000, 100_000, []).finished).toBe(true);
    expect(standingOf(85_000, 100_000, []).finished).toBe(false);
  });

  it("takes the latest listen-through's word over the place", () => {
    // Started again from the beginning: the place is at the end of the last time through, and it isn't finished.
    expect(standingOf(10 * HOUR, 10 * HOUR, [read()]).finished).toBe(false);
    // Marked finished partway through.
    expect(standingOf(HOUR, 10 * HOUR, [read("2026-10-23T00:00:00.000Z")])).toEqual({ started: true, finished: true, fraction: 0.1 });
  });
});

describe("readingStandingOf", () => {
  it("is as far as the reading place, for a book that is only its text", () => {
    expect(readingStandingOf(0, [])).toEqual({ started: false, finished: false, fraction: 0 });
    expect(readingStandingOf(0.42, [])).toEqual({ started: true, finished: false, fraction: 0.42 });
  });

  it("is finished by reading to the end, until a read says otherwise", () => {
    expect(readingStandingOf(0.995, []).finished).toBe(true);
    expect(readingStandingOf(0.995, [read()]).finished).toBe(false);
    expect(readingStandingOf(0.3, [read("2026-10-23T00:00:00.000Z")]).finished).toBe(true);
  });
});
