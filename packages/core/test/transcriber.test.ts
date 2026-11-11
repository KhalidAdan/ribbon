import { describe, expect, it } from "vitest";
import { hearing, IDLE, keepsAwake, MAX_WAIT_MS, MIN_WAIT_MS, transcribingAfter, type Transcribing, type TranscribingEvent } from "@ribbon/core/transcriber";

const after = (t: Transcribing, ...events: TranscribingEvent[]) => events.reduce(transcribingAfter, t);

describe("transcribing on this machine", () => {
  it("hears the open book, once more after when asked again meanwhile, and only once more", () => {
    const t = after(IDLE, { type: "hearing began" });
    expect(t.reader).toEqual({ status: "hearing", again: false });
    expect(hearing(t)).toBe(true);
    const again = after(t, { type: "asked again" });
    expect(again.reader).toEqual({ status: "hearing", again: true });
    expect(after(again, { type: "asked again" })).toBe(again);
    expect(after(again, { type: "hearing ended" }).reader).toEqual({ status: "idle" });
    // Asked while nothing is heard, it's simply heard: there's no "again" to keep.
    expect(after(IDLE, { type: "asked again" })).toBe(IDLE);
  });

  it("works on a server's books, and waits a while when it has to: a minute, doubling to half an hour", () => {
    let t = after(IDLE, { type: "work began" }, { type: "wait" });
    expect(t.server).toEqual({ status: "waiting", ms: MIN_WAIT_MS });
    // The work ends; the wait outlasts it.
    t = after(t, { type: "work ended" });
    expect(t.server).toEqual({ status: "waiting", ms: MIN_WAIT_MS });
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      t = after(t, { type: "wait over" }, { type: "work began" }, { type: "wait" }, { type: "work ended" });
      waits.push((t.server as { ms: number }).ms);
    }
    expect(waits).toEqual([2, 4, 8, 16, 30, 30, 30].map((m) => m * MIN_WAIT_MS));
    expect(waits.at(-1)).toBe(MAX_WAIT_MS);
  });

  it("waits once however many reasons there are, and starts from a minute again after a book is whole", () => {
    const waiting = after(IDLE, { type: "work began" }, { type: "wait" });
    expect(after(waiting, { type: "wait" })).toBe(waiting);
    const whole = after(IDLE, { type: "work began" }, { type: "wait" }, { type: "work began" }, { type: "wait" }, { type: "work began" }, { type: "whole" }, { type: "wait" });
    expect(whole.server).toEqual({ status: "waiting", ms: MIN_WAIT_MS });
  });

  it("begins work from a wait, so the wait is over", () => {
    expect(after(IDLE, { type: "work began" }, { type: "wait" }, { type: "work began" }).server).toEqual({ status: "working" });
  });

  it("keeps the computer awake while it hears or works, never while it only waits", () => {
    expect(keepsAwake(IDLE)).toBe(false);
    expect(keepsAwake(after(IDLE, { type: "hearing began" }))).toBe(true);
    expect(keepsAwake(after(IDLE, { type: "work began" }))).toBe(true);
    expect(keepsAwake(after(IDLE, { type: "work began" }, { type: "wait" }))).toBe(false);
    expect(keepsAwake(after(IDLE, { type: "hearing began" }, { type: "work began" }, { type: "hearing ended" }))).toBe(true);
  });

  it("stops everything on a reset, the wait and how long the last one was included", () => {
    const busy = after(IDLE, { type: "hearing began" }, { type: "asked again" }, { type: "work began" }, { type: "wait" });
    expect(after(busy, { type: "reset" })).toEqual(IDLE);
    expect(keepsAwake(after(busy, { type: "reset" }))).toBe(false);
  });
});
