import { describe, expect, it } from "vitest";
import { ribbonClaim, type SessionRecord } from "@ribbon/core/poslog";
import { defaultSettings, lastSpeed, parseSettings, serializeSettings, speedToPlay } from "@ribbon/core/settings";

const session = (book: string, end: string, speed?: number): SessionRecord =>
  ({ v: 1, k: "session", dev: "d", seq: 1, t: end, book: { ids: [ribbonClaim(book)] }, start: end, end, from_ms: 0, to_ms: 60_000, listened_ms: 60_000, ...(speed ? { speed } : {}) }) as SessionRecord;

describe("a book's settings", () => {
  it("keep when the speed was chosen, and read a file from before they did", async () => {
    const kept = { bookId: "b", speed: 1.25, trimSilence: true, speedAt: "2026-11-03T10:00:00.000Z" };
    expect(await parseSettings(await serializeSettings(kept), "b")).toEqual(kept);
    expect(await parseSettings(new TextEncoder().encode("book_id,speed,trim_silence\nb,1.5,0\n"), "b")).toEqual({ bookId: "b", speed: 1.5, trimSilence: false });
  });
});

describe("the speed a book plays at", () => {
  it("is the speed of its newest session, on any device", () => {
    const last = lastSpeed([session("b", "2026-11-01T10:00:00.000Z", 1.25), session("b", "2026-11-02T10:00:00.000Z", 1.5), session("other", "2026-11-03T10:00:00.000Z", 2), session("b", "2026-11-03T10:00:00.000Z")], "b");
    expect(last).toEqual({ speed: 1.5, at: "2026-11-02T10:00:00.000Z" });
    expect(speedToPlay(defaultSettings("b"), last)).toBe(1.5);
  });

  it("is this device's own choice when it was made since", () => {
    const chosen = { ...defaultSettings("b"), speed: 1.1, speedAt: "2026-11-02T12:00:00.000Z" };
    expect(speedToPlay(chosen, { speed: 1.5, at: "2026-11-02T10:00:00.000Z" })).toBe(1.1);
    expect(speedToPlay(chosen, { speed: 1.5, at: "2026-11-02T14:00:00.000Z" })).toBe(1.5);
    expect(speedToPlay(chosen, null)).toBe(1.1);
  });
});
