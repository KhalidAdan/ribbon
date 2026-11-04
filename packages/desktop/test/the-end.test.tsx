// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AppController, type AppState, type Platform } from "../src/app/controller";
import { memorySources } from "../src/app/platform";
import { ribbonClaim, type ReadRecord, type SessionRecord } from "@ribbon/core/poslog";
import type { ScannedBook } from "@ribbon/core/scan/scan";
import type { SeriesGroup } from "@ribbon/core/series";
import { nodeHost } from "@ribbon/host-node/node";
import { howItWent, TheEnd } from "../src/ui/TheEnd";
import { ControllerContext } from "../src/ui/store";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOUR = 3_600_000;
const book = (id: string, title: string): ScannedBook => ({ book: { id, title, author: "An Author", narrator: "", series: "The Waygates", durationMs: 10 * HOUR }, files: [], chapters: [], parts: [] }) as unknown as ScannedBook;
const read = (id: string, started: string, finished?: string): ReadRecord => ({ v: 1, k: "read", dev: "d", seq: 1, t: started, book: { ids: [ribbonClaim(id)] }, id: `r-${id}`, started, ...(finished ? { finished } : {}) });
const session = (id: string, start: string, end: string, listened: number): SessionRecord =>
  ({ v: 1, k: "session", dev: "d", seq: 2, t: end, book: { ids: [ribbonClaim(id)] }, start, end, from_ms: 0, to_ms: listened, listened_ms: listened }) as SessionRecord;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

/** The card for a book just ended, in a controller whose shelf and history are set by hand. */
async function shown(patch: Partial<AppState>, series: SeriesGroup[] = []): Promise<AppController> {
  const platform: Platform = { host: nodeHost(), pickFolder: async () => null, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources() };
  const c = new AppController(platform);
  c.detectedSeries = () => series;
  (c as unknown as { set(p: Partial<AppState>): void }).set(patch);
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => {
    root!.render(
      <ControllerContext.Provider value={c}>
        <TheEnd />
      </ControllerContext.Provider>,
    );
  });
  return c;
}

describe("the end of a book", () => {
  it("says when it was started and finished and the time spent, and offers the next book in the series", async () => {
    const one = book("one", "The Waygate");
    const two = book("two", "The Second Gate");
    const c = await shown(
      {
        books: [one, two],
        theEnd: "one",
        history: { reads: [read("one", "2026-10-01T09:00:00.000Z", "2026-10-09T21:00:00.000Z")], sessions: [session("one", "2026-10-02T09:00:00.000Z", "2026-10-02T20:00:00.000Z", 11 * HOUR + 20 * 60_000)], readings: [], recording: true },
      },
      [{ key: "waygates", name: "The Waygates", bookIds: ["one", "two"] } as SeriesGroup],
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("The end of The Waygate");
    expect(text).toContain("11h 20m of listening, over 9 days.");
    expect(text).toContain("Up next in The Waygates");
    expect(text).toContain("The Second Gate");
    const done = [...document.querySelectorAll("button")].find((b) => b.textContent === "Done")!;
    await act(async () => done.click());
    expect(c.getState().theEnd).toBeNull();
  });

  it("offers nothing next when the series is finished, or the book is in none", async () => {
    await shown({ books: [book("one", "The Waygate")], theEnd: "one", history: { reads: [read("one", "2026-10-01T09:00:00.000Z", "2026-10-09T21:00:00.000Z")], sessions: [], readings: [], recording: true } });
    expect(document.body.textContent).not.toContain("Up next");
    expect([...document.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Done"]);
  });
});

describe("how it went", () => {
  const now = new Date(2026, 10, 3, 18);
  it("says the days as a sentence says them", () => {
    expect(howItWent({ started: new Date(2026, 10, 3, 9).toISOString(), finished: new Date(2026, 10, 3, 17).toISOString(), listenedMs: 2 * HOUR }, now)).toBe("Started and finished today. 2h 0m of listening.");
    expect(howItWent({ started: new Date(2026, 10, 2, 9).toISOString(), finished: new Date(2026, 10, 3, 17).toISOString(), listenedMs: 0 }, now)).toBe("Started yesterday, finished today.");
  });
});
