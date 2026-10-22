// @vitest-environment happy-dom
import { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppController, type AppState, type Platform } from "../src/app/controller";
import { memorySources } from "../src/app/platform";
import { nodeHost } from "../src/host/node";
import type { ScannedBook } from "../src/core/scan/scan";
import type { Book, Position } from "../src/core/types";
import { defaultSettings } from "../src/core/settings";
import { newSeriesRecord } from "../src/core/series";
import { Screen } from "../src/ui/App";
import { ControllerContext, shallowEqual, useAppState } from "../src/ui/store";

/**
 * The player reports its place five times a second. These tests render
 * the app's shell around a controller whose state they set by hand, play
 * a few seconds of ticks, and count what React drew for each: only the
 * parts that show the time should redraw.
 */

const { counts, profiled } = vi.hoisted(() => {
  const counts = new Map<string, { renders: number; ms: number }>();
  /** The module with each named component wrapped in a Profiler that counts its updates. */
  const profiled = async <M extends Record<string, unknown>>(mod: M, ...names: string[]): Promise<M> => {
    const { createElement, Profiler } = await import("react");
    const out: Record<string, unknown> = { ...mod };
    for (const name of names) {
      const C = mod[name] as (p: object) => React.ReactNode;
      out[name] = function Counted(props: object) {
        return createElement(
          Profiler,
          {
            id: name,
            onRender: (_id: string, phase: string, ms: number) => {
              if (phase === "mount") return;
              const c = counts.get(name) ?? { renders: 0, ms: 0 };
              c.renders += 1;
              c.ms += ms;
              counts.set(name, c);
            },
          },
          createElement(C, props),
        );
      };
    }
    return out as M;
  };
  return { counts, profiled };
});

vi.mock("../src/ui/Shell", async (orig) => profiled(await orig(), "TopBar", "Tabs"));
vi.mock("../src/ui/LibraryPane", async (orig) => profiled(await orig(), "LibraryPane"));
vi.mock("../src/ui/SettingsPane", async (orig) => profiled(await orig(), "SettingsPane"));
vi.mock("../src/ui/StatsPane", async (orig) => profiled(await orig(), "StatsPane"));
vi.mock("../src/ui/ReaderPage", async (orig) => profiled(await orig(), "ReaderPage"));
vi.mock("../src/ui/PlayerBar", async (orig) => profiled(await orig(), "PlayerBar"));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// What vite.config.ts defines for the app.
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = "test";

const HOUR = 3_600_000;

function sb(i: number): ScannedBook {
  const id = `book-${i}`;
  const durationMs = (6 + (i % 10)) * HOUR;
  const book: Book = { id, path: id, title: `Book ${i}`, rawTitle: id, author: `Author ${i % 25}`, narrator: `Narrator ${i % 30}`, series: "", seriesIndex: null, year: 2000 + (i % 25), cover: "", durationMs, sizeBytes: 1, fileCount: 1, genres: [i % 2 ? "Fantasy" : "History"] };
  return {
    book,
    source: "s1",
    files: [{ path: `${id}.mp3`, order: 0, durationMs, sizeBytes: 1, mtimeMs: 0, title: "", part: "", partAuthor: "", disc: 1, track: 0, hasCover: false, coverFile: "", chapters: [], chaptersProbed: true }],
    chapters: Array.from({ length: 20 }, (_, k) => ({ title: `Chapter ${k + 1}`, startMs: (k * durationMs) / 20, endMs: ((k + 1) * durationMs) / 20 })),
    parts: [],
  };
}

/** A shelf of 200 books, a third of them started, five in a series, the first one playing an hour in. */
function controller(pane: AppState["pane"]): AppController {
  const platform: Platform = { host: nodeHost(), pickFolder: async () => null, allowFolder: async () => undefined, fileUrl: (p) => `file:///${p}`, sources: memorySources() };
  const c = new AppController(platform);
  const books = Array.from({ length: 200 }, (_, i) => sb(i));
  const positions: Record<string, Position | null> = {};
  for (let i = 0; i < books.length; i += 3) positions[books[i]!.book.id] = { bookId: books[i]!.book.id, offsetMs: HOUR + i * 1000, updatedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), device: "test" };
  const playing = books[0]!;
  const series = newSeriesRecord("saga", "The Saga", books.slice(10, 15).map((b) => b.book.id));
  set(c, {
    phase: "ready",
    sources: [{ id: "s1", root: "/library", name: "library", addedAt: "2026-01-01T00:00:00.000Z" }],
    sourceStatus: { s1: { scanning: null, lastScanMs: 1200, error: null, readOnly: false } },
    books,
    positions,
    series: { saga: series },
    assetsReady: true,
    pane,
    readerBookId: playing.book.id,
    current: { book: playing, settings: defaultSettings(playing.book.id), bookmarks: [], loudnessGainDb: null, silence: null, corrections: [] },
    player: { ...c.getState().player, bookId: playing.book.id, positionMs: HOUR + 1000, durationMs: playing.book.durationMs, playing: true, chapterIndex: 3 },
  });
  return c;
}

function set(c: AppController, patch: Partial<AppState>): void {
  (c as unknown as { set(p: Partial<AppState>): void }).set(patch);
}

/** One report from the engine: 200 ms further on. */
function tick(c: AppController, ms = 200): void {
  const p = c.getState().player;
  set(c, { player: { ...p, positionMs: p.positionMs + ms } });
}

let root: Root | null = null;
let appMs = 0;
let appCommits = 0;

async function mount(c: AppController): Promise<void> {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => {
    root!.render(
      <ControllerContext.Provider value={c}>
        <Profiler
          id="app"
          onRender={(_id, phase, ms) => {
            if (phase === "mount") return;
            appCommits += 1;
            appMs += ms;
          }}
        >
          <Screen />
        </Profiler>
      </ControllerContext.Provider>,
    );
  });
  // Let the search index and anything else asynchronous settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 100));
  });
  counts.clear();
  appMs = 0;
  appCommits = 0;
}

/** Play `n` ticks; what redrew, per tick, and React's time for each tick (the median). */
async function play(c: AppController, n: number): Promise<{ perTick: Record<string, number>; msPerTick: Record<string, number>; appMsMedian: number; appCommitsPerTick: number }> {
  counts.clear();
  appCommits = 0;
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    appMs = 0;
    act(() => tick(c));
    times.push(appMs);
  }
  const perTick = Object.fromEntries([...counts].map(([k, v]) => [k, v.renders / n]));
  const msPerTick = Object.fromEntries([...counts].map(([k, v]) => [k, Math.round((v.ms / n) * 100) / 100]));
  times.sort((a, b) => a - b);
  return { perTick, msPerTick, appMsMedian: times[Math.floor(n / 2)]!, appCommitsPerTick: appCommits / n };
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

const TICKS = 50;

describe("useAppState", () => {
  it("redraws with every change without a selector, and only when the selection changes with one", async () => {
    const c = controller("library");
    const drawn = { whole: 0, count: 0, book: 0 };
    let title = "";
    function Whole() {
      useAppState();
      drawn.whole += 1;
      return null;
    }
    function Count() {
      useAppState((s) => ({ n: s.books.length, playing: s.player.playing }));
      drawn.count += 1;
      return null;
    }
    function Title({ id }: { id: string }) {
      title = useAppState((s) => s.books.find((b) => b.book.id === id)?.book.title ?? "");
      drawn.book += 1;
      return null;
    }
    const el = document.createElement("div");
    root = createRoot(el);
    const draw = (id: string) =>
      act(() =>
        root!.render(
          <ControllerContext.Provider value={c}>
            <Whole />
            <Count />
            <Title id={id} />
          </ControllerContext.Provider>,
        ),
      );
    draw("book-1");
    expect(title).toBe("Book 1");
    drawn.whole = drawn.count = drawn.book = 0;
    for (let i = 0; i < 10; i++) act(() => tick(c));
    expect(drawn).toEqual({ whole: 10, count: 0, book: 0 });
    act(() => set(c, { player: { ...c.getState().player, playing: false } }));
    expect(drawn.count).toBe(1);
    // A selector that closes over a prop follows the prop.
    draw("book-2");
    expect(title).toBe("Book 2");
  });

  it("compares plain objects and arrays by their items, anything else by identity", () => {
    expect(shallowEqual({ a: 1, b: "x" }, { a: 1, b: "x" })).toBe(true);
    expect(shallowEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(shallowEqual([1, 2], [1, 2])).toBe(true);
    expect(shallowEqual([1, 2], { 0: 1, 1: 2 } as unknown as number[])).toBe(false);
    expect(shallowEqual({ a: {} }, { a: {} })).toBe(false);
    expect(shallowEqual(new Map([[1, 1]]), new Map([[1, 2]]))).toBe(false);
    expect(shallowEqual(NaN, NaN)).toBe(true);
  });
});

describe("a player tick", () => {
  for (const pane of ["library", "settings", "stats", "reader"] as const) {
    it(`redraws only the player bar on the ${pane} page`, async () => {
      const c = controller(pane);
      await mount(c);
      await play(c, 20); // warm up
      const r = await play(c, TICKS);
      console.log(`${pane}: redrawn per tick ${JSON.stringify(r.perTick)}, ms per tick ${JSON.stringify(r.msPerTick)}; React ${r.appMsMedian.toFixed(2)} ms a tick (median)`);
      expect(r.perTick.PlayerBar).toBe(1);
      for (const name of ["Tabs", "TopBar", "LibraryPane", "SettingsPane", "StatsPane", "ReaderPage"]) expect(r.perTick[name] ?? 0, name).toBe(0);
    });
  }

  it("still redraws the shelf when what it shows changes", async () => {
    const c = controller("library");
    await mount(c);
    // A minute on: the shelf's "left" for the playing book moves.
    let r = await play(c, 300);
    expect(r.perTick.LibraryPane! * 300).toBe(1);
    // Pausing changes the card's button.
    counts.clear();
    act(() => set(c, { player: { ...c.getState().player, playing: false } }));
    expect(counts.get("LibraryPane")?.renders).toBe(1);
    expect(counts.get("Tabs")).toBeUndefined();
    // A saved place moves the book up the shelf.
    counts.clear();
    act(() => set(c, { positions: { ...c.getState().positions, "book-1": { bookId: "book-1", offsetMs: 5000, updatedAt: new Date().toISOString(), device: "test" } } }));
    expect(counts.get("LibraryPane")?.renders).toBe(1);
    // A new pane redraws the shell.
    counts.clear();
    act(() => c.showSettings());
    expect(counts.get("Tabs")?.renders).toBe(1);
    r = await play(c, 5);
    expect(r.perTick.SettingsPane ?? 0).toBe(0);
  });
});
