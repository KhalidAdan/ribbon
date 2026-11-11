import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppController } from "../src/app/controller";
import { Holds, proofHost, proofLibrary, proofPlatform, proofWorld, ROOT, settle } from "./support/proof-app";
import type { MemoryHost } from "./support/memory-host";

/** What's on screen, and the dialogs over it, against the library in memory the proofs use. */
describe("what's on screen", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = proofWorld();
  });
  afterEach(() => restore());

  async function app(m: MemoryHost = proofLibrary()): Promise<AppController> {
    const c = new AppController(proofPlatform(proofHost(m, new Holds())));
    await c.boot();
    await settle();
    return c;
  }

  /** Three books tagged as a series, the fewest that make one, arriving in the folder. */
  function aSeriesArrives(m: MemoryHost): void {
    for (const [n, title] of [[1, "First Watch"], [2, "Second Watch"], [3, "Third Watch"]] as const) {
      const rel = `Ann Writer/${title}/01.mp3`;
      m.audio[rel] = { durationMs: 60_000, tags: { album: title, artist: "Ann Writer", series: "The Watch", "series-part": String(n) } };
      m.put(`${ROOT}/${rel}`, "c".repeat(100));
    }
  }

  it("never offers a series' setup over the dialog for making one, and offers it once that's closed", async () => {
    // A scan finding a series while a reading list was being made opened its setup over the dialog: two at once.
    const m = proofLibrary();
    const c = await app(m);
    c.openNewSeries();
    aSeriesArrives(m);
    await c.rescan();
    await settle();
    expect(c.getState()).toMatchObject({ seriesNew: true, seriesSetup: null });

    c.closeNewSeries();
    await c.rescan();
    await settle();
    expect(c.getState().seriesSetup?.name).toBe("The Watch");
    expect(c.getState().seriesNew).toBe(false);
    c.destroy();
  });

  it("has one series dialog open at a time, whichever was opened last", async () => {
    const m = proofLibrary();
    aSeriesArrives(m);
    const c = await app(m);
    // The scan at boot offered it; put away, it's opened again by hand.
    c.closeSeriesSetup();
    c.openNewSeries();
    const key = c.detectedSeries()[0]!.key;
    c.openSeriesSetup(key);
    expect(c.getState()).toMatchObject({ seriesNew: false, seriesSetup: { key } });
    c.openNewSeries();
    expect(c.getState()).toMatchObject({ seriesNew: true, seriesSetup: null });
    c.destroy();
  });
});
