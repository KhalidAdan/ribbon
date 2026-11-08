import { describe, expect, it } from "vitest";
import { combineLoudness, dbToLinear, gainDb, nothingMeasured, parseEbur128 } from "@ribbon/core/loudness";
import { analyzeArgs } from "@ribbon/core/analysis";

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

/** What ffmpeg 5.1 printed on the server for every book, refusing `framelog=quiet` (#228): a summary from a filter that never ran. */
const REFUSED = `
[ebur128 @ 0x5a13fea9bf40] Unable to parse option value "quiet"
[ebur128 @ 0x5a13fea9bf40] Error setting option framelog to value quiet.
[AVFilterGraph @ 0x5a13fe960e80] Error initializing filter 'ebur128' with args 'peak=true:framelog=quiet'
[Parsed_ebur128_1 @ 0x5a13fea114c0] Summary:

  Integrated loudness:
    I:           0.0 LUFS
    Threshold:   0.0 LUFS

  True peak:
    Peak:       -inf dBFS
Error initializing complex filters.
Invalid argument
`;

describe("parseEbur128", () => {
  it("takes the summary of a scan ffmpeg refused for no measurement, not 0 LUFS (#228)", async () => {
    expect(await parseEbur128(REFUSED)).toBeNull();
  });

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

describe("a reading that measured nothing (#228)", () => {
  it("is 0 LUFS or more, which no recording is", () => {
    expect(nothingMeasured({ integratedLufs: 0, truePeakDbtp: null })).toBe(true);
    expect(nothingMeasured({ integratedLufs: -17.6, truePeakDbtp: -1.4 })).toBe(false);
    expect(nothingMeasured(null)).toBe(false);
    expect(nothingMeasured(undefined)).toBe(false);
  });

  it("isn't asked for: the scan hides each tenth of a second in a way ffmpeg 5.1 knows", () => {
    const filter = analyzeArgs("/books/a.m4b").join(" ");
    expect(filter).toContain("framelog=verbose");
    expect(filter).not.toContain("framelog=quiet");
  });
});
