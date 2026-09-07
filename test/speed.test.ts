import { describe, expect, it } from "vitest";
import { clampSpeed, formatDuration, formatLeft, formatSpeed, remainingAtSpeed, snapSpeed } from "../src/core/speed";

describe("speed", () => {
  it("computes remaining wall time", () => {
    expect(remainingAtSpeed(3_600_000, 1)).toBe(3_600_000);
    expect(remainingAtSpeed(3_600_000, 2)).toBe(1_800_000);
    expect(remainingAtSpeed(3_600_000, 1.25)).toBe(2_880_000);
    expect(remainingAtSpeed(-10, 1)).toBe(0);
  });

  it("clamps to 0.5..3.0", () => {
    expect(clampSpeed(0.1)).toBe(0.5);
    expect(clampSpeed(9)).toBe(3);
    expect(clampSpeed(Number.NaN)).toBe(1);
    expect(clampSpeed(1.5)).toBe(1.5);
  });

  it("snaps to 0.05 steps without float noise", () => {
    expect(snapSpeed(1.2500000001)).toBe(1.25);
    expect(snapSpeed(1.26)).toBe(1.25);
    expect(snapSpeed(1.28)).toBe(1.3);
    expect(snapSpeed(0.4)).toBe(0.5);
  });

  it("formats durations", () => {
    expect(formatDuration(3_600_000)).toBe("1:00:00");
    expect(formatDuration(3_599_000)).toBe("59:59");
    expect(formatDuration(5_000)).toBe("0:05");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
    expect(formatDuration(-1)).toBe("0:00");
    expect(formatDuration(999)).toBe("0:00");
  });

  it("formats speeds", () => {
    expect(formatSpeed(1)).toBe("1×");
    expect(formatSpeed(1.5)).toBe("1.5×");
    expect(formatSpeed(1.25)).toBe("1.25×");
    expect(formatSpeed(2)).toBe("2×");
  });
});

describe("formatLeft", () => {
  it("is coarse: hours and minutes, then minutes, then seconds", () => {
    expect(formatLeft(13 * 3_600_000 + 24 * 60_000 + 59_000)).toBe("13h 24m");
    expect(formatLeft(24 * 60_000 + 5_000)).toBe("24 min");
    expect(formatLeft(36_000)).toBe("36 sec");
    expect(formatLeft(-5)).toBe("0 sec");
  });
});
