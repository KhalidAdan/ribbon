import { describe, expect, it } from "vitest";
import { combineLoudness, dbToLinear, gainDb, parseEbur128 } from "../src/core/loudness";

const SUMMARY = `
[Parsed_ebur128_0 @ 000001] Summary:

  Integrated loudness:
    I:         -23.4 LUFS
    Threshold: -33.6 LUFS

  Loudness range:
    LRA:         4.1 LU
    Threshold: -43.8 LUFS
    LRA low:   -26.0 LUFS
    LRA high:  -21.9 LUFS

  True peak:
    Peak:       -1.2 dBFS
`;

describe("parseEbur128", () => {
  it("reads integrated loudness and true peak", async () => {
    expect(await parseEbur128(SUMMARY)).toEqual({ integratedLufs: -23.4, truePeakDbtp: -1.2 });
  });

  it("returns null without a summary", async () => {
    expect(await parseEbur128("nothing here")).toBeNull();
    expect(await parseEbur128("")).toBeNull();
  });

  it("tolerates a missing peak block", async () => {
    expect(await parseEbur128("  I:  -20.0 LUFS\n")).toEqual({ integratedLufs: -20, truePeakDbtp: null });
  });

  it("treats -inf as silence", async () => {
    expect(await parseEbur128("  I:  -inf LUFS\n  Peak: -inf dBFS")).toEqual({ integratedLufs: -70, truePeakDbtp: null });
  });

  it("uses the last summary when ffmpeg prints progress lines first", async () => {
    const noisy = "  I:  -50.0 LUFS\n" + SUMMARY;
    expect((await parseEbur128(noisy))?.integratedLufs).toBe(-23.4);
  });
});

describe("gainDb", () => {
  it("brings measured to target", async () => {
    expect(gainDb({ integratedLufs: -23.4, truePeakDbtp: -10 })).toBe(5.4);
    expect(gainDb({ integratedLufs: -12, truePeakDbtp: -1 })).toBe(-6);
  });

  it("clamps to plus or minus 12", async () => {
    expect(gainDb({ integratedLufs: -40, truePeakDbtp: -30 })).toBe(12);
    expect(gainDb({ integratedLufs: 0, truePeakDbtp: 0 })).toBe(-12);
  });

  it("respects the true-peak ceiling", async () => {
    // Wants +5.4 but only 0.2 dB of headroom.
    expect(gainDb({ integratedLufs: -23.4, truePeakDbtp: -1.2 })).toBe(0.2);
  });

  it("is zero for a missing measurement", async () => {
    expect(gainDb(null)).toBe(0);
  });

  it("honours a custom target", async () => {
    expect(gainDb({ integratedLufs: -23, truePeakDbtp: null }, -16)).toBe(7);
  });
});

describe("dbToLinear", () => {
  it("converts", async () => {
    expect(dbToLinear(0)).toBe(1);
    expect(dbToLinear(6.02)).toBeCloseTo(2, 2);
    expect(dbToLinear(-6.02)).toBeCloseTo(0.5, 2);
  });
});

describe("combineLoudness", () => {
  it("returns the value for one file", async () => {
    expect(combineLoudness([{ integratedLufs: -20, truePeakDbtp: -2, durationMs: 1000 }])).toEqual({ integratedLufs: -20, truePeakDbtp: -2 });
  });

  it("weights by duration in the power domain", async () => {
    const r = combineLoudness([
      { integratedLufs: -20, truePeakDbtp: -3, durationMs: 1000 },
      { integratedLufs: -30, truePeakDbtp: -1, durationMs: 1000 },
    ]);
    // Power mean of -20 and -30 is about -22.6, not the arithmetic -25.
    expect(r?.integratedLufs).toBeCloseTo(-22.59, 1);
    expect(r?.truePeakDbtp).toBe(-1);
  });

  it("ignores zero-length parts and returns null for nothing", async () => {
    expect(combineLoudness([{ integratedLufs: -20, truePeakDbtp: null, durationMs: 0 }])).toBeNull();
    expect(combineLoudness([])).toBeNull();
  });
});
