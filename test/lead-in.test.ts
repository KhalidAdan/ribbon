import { describe, expect, it } from "vitest";
import { followedMs, LEAD_IN_MS } from "../src/core/reading/align";

describe("listening from a sentence, a moment early", () => {
  const from = 60_000;

  it("holds the text at the sentence through the lead-in", () => {
    expect(followedMs(from - LEAD_IN_MS, from)).toBe(from);
    expect(followedMs(from - 1, from)).toBe(from);
  });

  it("allows for a seek that lands a frame or two early", () => {
    expect(followedMs(from - LEAD_IN_MS - 40, from)).toBe(from);
  });

  it("follows the player once it reaches the sentence", () => {
    expect(followedMs(from, from)).toBe(from);
    expect(followedMs(from + 1_500, from)).toBe(from + 1_500);
  });

  it("follows the player anywhere else, and when nothing was listened from", () => {
    expect(followedMs(from - 30_000, from)).toBe(from - 30_000);
    expect(followedMs(12_345, null)).toBe(12_345);
  });
});
