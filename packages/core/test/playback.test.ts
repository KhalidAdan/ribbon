import { describe, expect, it } from "vitest";
import { isLoading, isPlaying, nextStatus, PLAYBACK_STATUSES, wantsToPlay, type PlaybackEvent } from "@ribbon/core/playback";

const EVENTS: PlaybackEvent[] = ["play", "pause", "load", "sounding", "waiting", "paused-outside", "refused", "retry", "failed", "ended"];

describe("whether a book is playing", () => {
  it("has an answer for every event in every status", () => {
    for (const from of PLAYBACK_STATUSES) for (const e of EVENTS) expect(PLAYBACK_STATUSES).toContain(nextStatus(from, e));
  });

  it("stops for a pause, a load, a pause from outside, a refusal, a failure while paused, or the end, from anywhere", () => {
    for (const from of PLAYBACK_STATUSES) {
      for (const e of ["pause", "load", "paused-outside", "refused", "failed", "ended"] as const) expect(nextStatus(from, e)).toBe("paused");
    }
  });

  it("plays when the audio sounds, and reconnects when a file fails while wanted, from anywhere", () => {
    for (const from of PLAYBACK_STATUSES) {
      expect(nextStatus(from, "sounding")).toBe("playing");
      expect(nextStatus(from, "retry")).toBe("reconnecting");
    }
  });

  it("starts from paused, and a second press changes nothing", () => {
    expect(nextStatus("paused", "play")).toBe("starting");
    for (const from of PLAYBACK_STATUSES.filter((s) => s !== "paused")) expect(nextStatus(from, "play")).toBe(from);
  });

  it("waits for the file only while it's wanted: before the first sound it's loading, after it buffering", () => {
    expect(nextStatus("paused", "waiting")).toBe("paused");
    expect(nextStatus("starting", "waiting")).toBe("loading");
    expect(nextStatus("loading", "waiting")).toBe("loading");
    expect(nextStatus("playing", "waiting")).toBe("buffering");
    expect(nextStatus("buffering", "waiting")).toBe("buffering");
    expect(nextStatus("reconnecting", "waiting")).toBe("reconnecting");
  });

  it("says what the screens ask of it", () => {
    expect(PLAYBACK_STATUSES.filter(isPlaying)).toEqual(["playing", "buffering"]);
    expect(PLAYBACK_STATUSES.filter(wantsToPlay)).toEqual(["starting", "loading", "playing", "buffering", "reconnecting"]);
    expect(PLAYBACK_STATUSES.filter(isLoading)).toEqual(["loading", "buffering"]);
  });
});
