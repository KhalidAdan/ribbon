import { describe, expect, it } from "vitest";
import { Rerun } from "@ribbon/core/rerun";

/** A run the test ends by hand, and what each run was asked. */
function runs() {
  const asked: string[][] = [];
  const ends: { ok: () => void; fail: (e: Error) => void }[] = [];
  const idle: boolean[] = [];
  const rerun = new Rerun<string[]>(
    (a) => {
      asked.push(a);
      return new Promise<void>((ok, fail) => ends.push({ ok, fail }));
    },
    (a, b) => [...a, ...b],
    (ok) => idle.push(ok),
  );
  return { rerun, asked, ends, idle };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("work that runs once more when asked for while it runs", () => {
  it("runs at once when idle, and is idle again when it ends", async () => {
    const r = runs();
    let done = false;
    void r.rerun.ask(["first"]).then(() => (done = true));
    expect(r.asked).toEqual([["first"]]);
    expect(r.rerun.running).toBe(true);
    r.ends[0]!.ok();
    await settle();
    expect(done).toBe(true);
    expect(r.rerun.running).toBe(false);
    expect(r.idle).toEqual([true]);
  });

  it("runs once more after, for every ask made while it ran, with what they asked put together", async () => {
    const r = runs();
    const first = r.rerun.ask(["first"]);
    let secondDone = false;
    let thirdDone = false;
    void r.rerun.ask(["second"]).then(() => (secondDone = true));
    void r.rerun.ask(["third"]).then(() => (thirdDone = true));
    expect(r.asked).toEqual([["first"]]);

    r.ends[0]!.ok();
    await first;
    await settle();
    // The asks made meanwhile wait for a run that began after them, not the one under way.
    expect(r.asked).toEqual([["first"], ["second", "third"]]);
    expect(secondDone).toBe(false);
    expect(r.idle).toEqual([]);

    r.ends[1]!.ok();
    await settle();
    expect(secondDone && thirdDone).toBe(true);
    expect(r.idle).toEqual([true]);
  });

  it("an ask after the run after has begun gets a run of its own", async () => {
    const r = runs();
    void r.rerun.ask(["first"]);
    void r.rerun.ask(["second"]);
    r.ends[0]!.ok();
    await settle();
    void r.rerun.ask(["third"]);
    r.ends[1]!.ok();
    await settle();
    expect(r.asked).toEqual([["first"], ["second"], ["third"]]);
  });

  it("a run that fails rejects for those who asked for it, and the run after still runs", async () => {
    const r = runs();
    const first = r.rerun.ask(["first"]);
    const second = r.rerun.ask(["second"]);
    r.ends[0]!.fail(new Error("the share went away"));
    await expect(first).rejects.toThrow("the share went away");
    await settle();
    expect(r.asked).toEqual([["first"], ["second"]]);
    r.ends[1]!.ok();
    await expect(second).resolves.toBeUndefined();
    expect(r.idle).toEqual([true]);
  });

  it("says when the last run failed", async () => {
    const r = runs();
    const first = r.rerun.ask(["first"]);
    r.ends[0]!.fail(new Error("no"));
    await expect(first).rejects.toThrow();
    await settle();
    expect(r.idle).toEqual([false]);
    expect(r.rerun.running).toBe(false);
  });
});
