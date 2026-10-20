import { describe, expect, it } from "vitest";
import { format, record, reset, summary, time } from "../src/app/perf";

describe("measuring how fast Ribbon feels", () => {
  it("summarises samples as median, 95th percentile and worst", () => {
    reset();
    for (let i = 1; i <= 100; i++) record("page turn", i);
    record("page turn", Number.NaN);
    record("page turn", -1);
    expect(summary()["page turn"]).toEqual({ n: 100, p50: 51, p95: 96, max: 100 });
    expect(format(summary())).toBe("page turn n=100 p50=51 p95=96 max=100");
  });

  it("times work", () => {
    reset();
    expect(time("work", () => 42)).toBe(42);
    expect(summary().work!.n).toBe(1);
  });
});
