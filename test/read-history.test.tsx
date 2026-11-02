// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AppController, type AppState, type Platform } from "../src/app/controller";
import { memorySources } from "../src/app/platform";
import { ribbonClaim, type ReadRecord } from "@ribbon/core/poslog";
import type { ScannedBook } from "@ribbon/core/scan/scan";
import { nodeHost } from "@ribbon/host-node/node";
import { ReadHistory } from "../src/ui/ReadHistory";
import { ControllerContext } from "../src/ui/store";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const book = { book: { id: "book" } } as ScannedBook;

function read(id: string, started: string, finished?: string): ReadRecord {
  return { v: 1, k: "read", dev: "d", seq: 1, t: started, book: { ids: [ribbonClaim("book")] }, id, started, ...(finished ? { finished } : {}) };
}

/** A date as the screen writes it, in whatever language and time zone the test runs. */
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

let root: Root | null = null;

/** What the screen says of each listen-through, top row first, for a controller whose history is set by hand. */
async function rowsOf(reads: ReadRecord[]): Promise<string[]> {
  const platform: Platform = { host: nodeHost(), pickFolder: async () => null, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources() };
  const c = new AppController(platform);
  (c as unknown as { set(p: Partial<AppState>): void }).set({ history: { reads, sessions: [], recording: true } });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => {
    root!.render(
      <ControllerContext.Provider value={c}>
        <ReadHistory book={book} />
      </ControllerContext.Provider>,
    );
  });
  return [...el.querySelectorAll("li p")].map((p) => p.textContent ?? "");
}

describe("a book's history on screen", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("runs only the latest listen-through to now, as Echoes of Eternity's three should", async () => {
    // Its real dates: heard on a folder, opened again by the TV, then started over on the Mac. None was ever finished.
    const first = "2026-10-19T21:29:19.431Z";
    const second = "2026-10-24T13:06:31.108Z";
    const third = "2026-11-01T22:55:03.229Z";

    const rows = await rowsOf([read("first", first), read("second", second), read("third", third)]);

    expect(rows).toEqual([`${day(third)} to now`, `${day(second)} to ${day(third)} · not finished`, `${day(first)} to ${day(second)} · not finished`]);
  });

  it("says nothing runs to now once the latest is finished, and keeps an earlier one apart from a finish", async () => {
    const rows = await rowsOf([read("left", "2026-09-01T12:00:00.000Z"), read("heard", "2026-10-01T12:00:00.000Z", "2026-10-11T12:00:00.000Z")]);

    expect(rows).toEqual([`${day("2026-10-01T12:00:00.000Z")} to ${day("2026-10-11T12:00:00.000Z")} · 10 days`, `${day("2026-09-01T12:00:00.000Z")} to ${day("2026-10-01T12:00:00.000Z")} · not finished`]);
  });

  it("still runs a book's one listen-through to now", async () => {
    const started = "2026-10-24T13:06:31.108Z";

    expect(await rowsOf([read("only", started)])).toEqual([`${day(started)} to now`]);
  });
});
