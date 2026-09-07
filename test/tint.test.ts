import { describe, expect, it } from "vitest";
import { dominantHue, toneFor, NEUTRAL_TONE } from "../src/core/tint";

const px = (...colors: [number, number, number][]) => colors.flatMap(([r, g, b]) => [r, g, b, 255]);

describe("dominantHue", () => {
  it("finds the hue of the saturated part and ignores the greys", () => {
    const h = dominantHue(px([20, 20, 20], [200, 200, 200], [180, 30, 60], [170, 40, 70], [255, 255, 255]));
    expect(h).not.toBeNull();
    expect(Math.abs(h! - 0.96) < 0.06 || h! < 0.03).toBe(true); // a crimson, around the red seam
  });

  it("averages across the red seam without landing in cyan", () => {
    const h = dominantHue(px([220, 30, 40], [220, 40, 30]));
    expect(h! < 0.05 || h! > 0.95).toBe(true);
  });

  it("returns null for a grey cover", () => {
    expect(dominantHue(px([10, 10, 10], [128, 128, 128], [240, 240, 240]))).toBeNull();
  });
});

describe("toneFor", () => {
  it("gives six hex colours from one hue, dark ground and pale ink", () => {
    const t = toneFor(0.35);
    for (const v of Object.values(t)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
    expect(t.bg).not.toBe(t.ink);
    expect(parseInt(t.bg.slice(1, 3), 16)).toBeLessThan(parseInt(t.ink.slice(1, 3), 16));
  });

  it("is neutral for a grey cover", () => {
    expect(NEUTRAL_TONE.bg).toBe(toneFor(null).bg);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(NEUTRAL_TONE.bg.slice(i, i + 2), 16));
    expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThan(8);
  });
});
