import { describe, expect, it } from "vitest";
import { AppController, sourceProblem, type AppState } from "../src/app/controller";
import { AppController as OldController, type AppState as OldState } from "./before/controller";
import { Holds, proofHost, proofLibrary, proofPlatform, proofWorld, ROOT, settle } from "./support/proof-app";
import { walk, type Meant } from "./support/walk";
import type { MemoryHost } from "./support/memory-host";

/**
 * The library's lifecycle became explicit (core/lifecycle.ts,
 * docs/STATE-MACHINES.md): each folder opening, open or failed, and the
 * phase worked out from them, never set. This proves the controller does
 * what it did: the old controller (before/controller.ts) and the new start
 * from the same folders (none; the books; the books and another that's
 * missing; only the missing one), go through the same events, and after
 * every step must show the same phase, error, folders and what each says,
 * shelf, page, reader and book details.
 *
 * Three differences are meant, and only these are allowed, each the fix of
 * a bug, each reached:
 * - "nothing open is the first screen": removing the one folder that
 *   opened, with another that didn't still listed, showed an empty shelf;
 *   now the first screen, which also leaves the page it was on.
 * - "a folder picked again forgets it failed": one that failed, opened by
 *   picking it again, kept saying it couldn't be opened, on the library
 *   (as "Could not open", or the scan's own words) and beside the folder.
 * - "what showed a gone book closes": removing a folder, or resetting
 *   Ribbon's own, left the reader and a book's details open on books no
 *   longer on the shelf, and a series' page on a series no longer there;
 *   they came back with the folder.
 */

const DEPTH = Number(process.env.PROOF_DEPTH ?? 3);
const RANDOM_RUNS = Number(process.env.PROOF_RANDOM ?? 250);
const RANDOM_LENGTH = 10;
const OTHER = "/other";

interface Seen {
  phase: string;
  error: string | null;
  /** Each folder, and what Settings says beside it. */
  folders: string[];
  shelf: number;
  /** The page, while the library shows. */
  screen: string | null;
  reading: string | null;
  editBook: string | null;
}

type Either = AppController | OldController;

const titleOf = (s: AppState | OldState, id: string) => s.books.find((b) => b.book.id === id)?.book.title ?? "a book gone";
const countOf = (s: AppState | OldState, id: string) => s.books.filter((b) => b.source === id).length;
const shown = (phase: string) => phase === "ready" || phase === "loading";

function seenOld(c: OldController): Seen {
  const s = c.getState();
  const page = s.pane === "reader" ? `reader ${s.readerBookId ? titleOf(s, s.readerBookId) : "none"}` : s.pane === "series" ? `series ${c.detectedSeries().find((g) => g.key === s.seriesKey)?.name ?? "a series gone"}` : s.pane;
  return {
    phase: s.phase,
    error: s.error,
    folders: s.sources.map((f) => `${f.name}: ${s.sourceStatus[f.id]?.error ? `Could not open it: ${s.sourceStatus[f.id]!.error}` : `${countOf(s, f.id)} books`}`),
    shelf: s.books.length,
    screen: shown(s.phase) ? page : null,
    reading: s.reading ? `${titleOf(s, s.reading.bookId)} ${s.reading.status}` : null,
    editBook: s.editBook ? titleOf(s, s.editBook) : null,
  };
}

function seenNew(c: AppController): Seen {
  const s = c.getState();
  const at = s.screen;
  const page = at.pane === "reader" ? `reader ${titleOf(s, at.bookId)}` : at.pane === "series" ? `series ${c.detectedSeries().find((g) => g.key === at.key)?.name ?? "a series gone"}` : at.pane;
  return {
    phase: s.phase,
    error: s.error,
    folders: s.sources.map((f) => {
      const problem = sourceProblem(s.sourceStatus[f.id]);
      return `${f.name}: ${problem ? `Could not open it: ${problem}` : `${countOf(s, f.id)} books`}`;
    }),
    shelf: s.books.length,
    screen: shown(s.phase) ? page : null,
    reading: s.reading ? `${titleOf(s, s.reading.bookId)} ${s.reading.status}` : null,
    editBook: s.editBook ? titleOf(s, s.editBook) : null,
  };
}

const NOTHING_OPEN = "nothing open is the first screen";
const PICKED_AGAIN = "a folder picked again forgets it failed";
const GONE_CLOSES = "what showed a gone book closes";

const meant: Meant<Seen> = (o, n, { event, earlier }) => {
  const kinds = new Set<string>();
  for (const k of Object.keys(o) as (keyof Seen)[]) {
    const was = JSON.stringify(o[k]);
    const is = JSON.stringify(n[k]);
    if (was === is) continue;
    if (k === "phase" && o.phase === "ready" && n.phase === "pick" && n.shelf === 0) kinds.add(NOTHING_OPEN);
    else if (k === "screen" && ((o.phase === "ready" && n.phase === "pick") || (earlier.has(NOTHING_OPEN) && n.screen === "library"))) kinds.add(NOTHING_OPEN);
    else if (k === "screen" && o.screen?.endsWith("gone") && n.screen === "library") kinds.add(GONE_CLOSES);
    else if (k === "error" && o.error !== null && n.error === null && (event.startsWith("pick") || earlier.has(PICKED_AGAIN))) kinds.add(PICKED_AGAIN);
    else if (k === "folders" && o.folders.length === n.folders.length && o.folders.every((f, i) => f === n.folders[i] || (f.includes("Could not open it: not a directory") && !n.folders[i]!.includes("Could not open it")))) kinds.add(PICKED_AGAIN);
    else if ((k === "reading" || k === "editBook") && n[k] === null && (o[k]!.includes("gone") || earlier.has(GONE_CLOSES))) kinds.add(GONE_CLOSES);
    else return null;
  }
  return [...kinds];
};

/** Where a run starts: the folders Ribbon was left with. */
const STARTS: { name: string; roots: string[]; other: boolean }[] = [
  { name: "no folders", roots: [], other: true },
  { name: "the books", roots: [ROOT], other: true },
  { name: "the books, and another that's missing", roots: [ROOT, OTHER], other: false },
  { name: "only the missing one", roots: [OTHER], other: false },
];

interface Run {
  m: MemoryHost;
  picks: { next: string };
}

const otherHere = (m: MemoryHost) => m.has(`${OTHER}/Elsewhere.epub`);
const idOf = (c: Either, root: string) => c.getState().sources.find((s) => s.root === root)?.id;
const bookId = (c: Either, title: string) => c.getState().books.find((b) => b.book.title === title)?.book.id;

const EVENTS: { name: string; act: (c: Either, r: Run) => unknown }[] = [
  { name: "pick the books' folder", act: (c, r) => ((r.picks.next = ROOT), c.pickLibrary()) },
  { name: "pick the other folder", act: (c, r) => ((r.picks.next = OTHER), c.pickLibrary()) },
  { name: "the other folder comes, or goes", act: (_c, r) => (otherHere(r.m) ? r.m.host().remove(OTHER) : r.m.put(`${OTHER}/Elsewhere.epub`, "PK4")) },
  { name: "the books' folder's scans fail, or work again", act: (_c, r) => void (r.m.failingScans.has(ROOT) ? r.m.failingScans.delete(ROOT) : r.m.failingScans.add(ROOT)) },
  { name: "remove the books' folder", act: (c) => { const id = idOf(c, ROOT); if (id) return c.removeSource(id); } },
  { name: "remove the other folder", act: (c) => { const id = idOf(c, OTHER); if (id) return c.removeSource(id); } },
  { name: "check every folder", act: (c) => c.rescan() },
  { name: "open Only to read", act: (c) => { const id = bookId(c, "Only"); if (id) return c.openReading(id); } },
  { name: "open Paired's details", act: (c) => { const id = bookId(c, "Paired"); if (id) c.openEditBook(id); } },
  { name: "open Paired's page", act: (c) => { const id = bookId(c, "Paired"); if (id) c.openReader(id); } },
  { name: "show settings", act: (c) => c.showSettings() },
  { name: "reset Ribbon's folder", act: (c) => c.resetHome() },
];

const reached = new Set<string>();

function traceFrom(start: (typeof STARTS)[number]) {
  return async (which: "old" | "new", sequence: readonly number[]): Promise<Seen[]> => {
    const restore = proofWorld();
    const m = proofLibrary();
    if (start.other) m.put(`${OTHER}/Elsewhere.epub`, "PK4");
    const run: Run = { m, picks: { next: ROOT } };
    const platform = proofPlatform(proofHost(m, new Holds()), { pickFolder: async () => run.picks.next, home: { path: async () => "/ribbon-home", reveal: async () => undefined, reset: async () => true } }, start.roots);
    const c: Either = which === "old" ? new OldController(platform) : new AppController(platform);
    const seen = () => (which === "old" ? seenOld(c as OldController) : seenNew(c as AppController));
    try {
      await c.boot();
      await settle();
      const out: Seen[] = [];
      for (const e of sequence) {
        await EVENTS[e]!.act(c, run);
        await settle();
        const s = seen();
        out.push(s);
        reached.add(`phase ${s.phase}`);
        for (const f of s.folders) reached.add(f.includes("Could not open it") ? `a folder that ${f.includes("not a directory") ? "is missing" : "fails its scans"}` : "a folder open");
      }
      return out;
    } finally {
      c.destroy();
      restore();
    }
  };
}

describe("the library's lifecycle, before and after it was written down", () => {
  for (const start of STARTS) {
    it(`does what it did from ${start.name}, for every sequence of ${DEPTH} events and ${RANDOM_RUNS} longer ones, but for three fixes`, async () => {
      const tally = await walk<Seen>({ events: EVENTS.map((e) => e.name), trace: traceFrom(start), meant, depth: DEPTH, random: RANDOM_RUNS, length: RANDOM_LENGTH });
      expect(tally.problems).toEqual([]);
      expect(tally.sequences).toBe(EVENTS.length ** DEPTH + RANDOM_RUNS);
      for (const [k, n] of tally.meant) reached.add(`${k} (${n > 0 ? "seen" : ""})`);
    }, 900_000);
  }

  it("reached every phase after boot, every kind of folder, and each fix", () => {
    expect([...reached].filter((r) => !r.endsWith("(seen)")).sort()).toEqual(["a folder open", "a folder that fails its scans", "a folder that is missing", "phase pick", "phase ready"]);
    expect([...reached].filter((r) => r.endsWith("(seen)")).sort()).toEqual([`${GONE_CLOSES} (seen)`, `${NOTHING_OPEN} (seen)`, `${PICKED_AGAIN} (seen)`].sort());
  });
});
