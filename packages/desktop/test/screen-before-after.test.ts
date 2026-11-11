import { describe, expect, it } from "vitest";
import { AppController, type AppState } from "../src/app/controller";
import { AppController as OldController, type AppState as OldState } from "./before/controller";
import { Holds, proofHost, proofLibrary, proofPlatform, proofWorld, ROOT, settle } from "./support/proof-app";
import { walk, type Meant } from "./support/walk";

/**
 * What's on screen became one status (core/screen.ts, docs/STATE-MACHINES.md):
 * the page above the player bar carries what it shows, a book's page its
 * book and a series' page its series, and the full player is open on a
 * drawer or closed. This proves the controller does with them what it did:
 * the old controller (before/controller.ts) and the new are opened on the
 * same library, put through the same events, and after every step must
 * show the same page, for the same book or series, the same way back, the
 * same full player and drawer, and the same reader over them.
 *
 * One difference is meant, the library's lifecycle's (lifecycle-before-after.test.ts):
 * removing a folder closes the reader open on one of its books, which the old
 * controller left open over a shelf without it.
 */

const DEPTH = Number(process.env.PROOF_DEPTH ?? 3);
const RANDOM_RUNS = Number(process.env.PROOF_RANDOM ?? 1_000);
const RANDOM_LENGTH = 10;

/** What anyone could see, said the same way for both. */
interface Seen {
  phase: string;
  pane: string;
  /** A book's page: its book, and whether the way back leads to the bookcase. */
  page?: string;
  /** A series' page: its series. */
  series?: string;
  /** The series Paired's page lists first: the one last opened, when it's in several. */
  pairedListsFirst: string | null;
  fullPlayer: string;
  reading: string | null;
  current: string | null;
}

type Either = AppController | OldController;

const title = (s: AppState | OldState, id: string | null) => (id ? (s.books.find((b) => b.book.id === id)?.book.title ?? `gone ${id}`) : null);
const nameOf = (c: Either, key: string) => c.detectedSeries().find((g) => g.key === key)?.name ?? `no series ${key}`;
const firstFor = (c: Either, t: string) => {
  const b = c.getState().books.find((x) => x.book.title === t);
  return b ? (c.seriesOfBook(b.book.id)[0]?.name ?? null) : null;
};

function seenOld(c: OldController): Seen {
  const s = c.getState();
  return {
    phase: s.phase,
    pane: s.pane,
    ...(s.pane === "reader" ? { page: `${title(s, s.readerBookId)}${s.readerFromBookcase ? ", from the bookcase" : ""}` } : {}),
    ...(s.pane === "series" ? { series: nameOf(c, s.seriesKey!) } : {}),
    pairedListsFirst: firstFor(c, "Paired"),
    fullPlayer: s.playerExpanded ? `open on ${s.playerDrawer ?? "nothing"}` : "closed",
    reading: s.reading ? `${title(s, s.reading.bookId)} ${s.reading.status}` : null,
    current: s.current?.book.book.title ?? null,
  };
}

function seenNew(c: AppController): Seen {
  const s = c.getState();
  const at = s.screen;
  return {
    phase: s.phase,
    pane: at.pane,
    ...(at.pane === "reader" ? { page: `${title(s, at.bookId)}${at.fromBookcase ? ", from the bookcase" : ""}` } : {}),
    ...(at.pane === "series" ? { series: nameOf(c, at.key) } : {}),
    pairedListsFirst: firstFor(c, "Paired"),
    fullPlayer: s.fullPlayer ? `open on ${s.fullPlayer.drawer ?? "nothing"}` : "closed",
    reading: s.reading ? `${title(s, s.reading.bookId)} ${s.reading.status}` : null,
    current: s.current?.book.book.title ?? null,
  };
}

const GONE_CLOSES = "the reader on a removed folder's book closes";

const meant: Meant<Seen> = (o, n, { earlier }) => {
  for (const k of Object.keys(o) as (keyof Seen)[]) {
    if (JSON.stringify(o[k]) === JSON.stringify(n[k])) continue;
    if (k === "reading" && n.reading === null && (o.reading!.startsWith("gone") || earlier.has(GONE_CLOSES))) continue;
    return null;
  }
  return [GONE_CLOSES];
};

const idOf = (c: Either, t: string) => c.getState().books.find((b) => b.book.title === t)?.book.id;
const LIST = "A reading list";
const listKey = (c: Either) => c.detectedSeries().find((g) => g.name === LIST)?.key;

const EVENTS: { name: string; act: (c: Either) => unknown }[] = [
  { name: "show the library", act: (c) => c.showLibrary() },
  { name: "show settings", act: (c) => c.showSettings() },
  { name: "show stats", act: (c) => c.showStats() },
  { name: "open the bookcase", act: (c) => c.openBookcase() },
  { name: "make a reading list of Only then Paired", act: (c) => { const a = idOf(c, "Only"); const b = idOf(c, "Paired"); if (a && b && !listKey(c)) return c.createSeries(LIST, [a, b]); } },
  { name: "open the reading list", act: (c) => { const k = listKey(c); if (k) c.openSeries(k); } },
  { name: "delete the reading list", act: (c) => { const k = listKey(c); if (k) return c.deleteSeries(k); } },
  { name: "open Paired's page", act: (c) => { const id = idOf(c, "Paired"); if (id) c.openReader(id); } },
  { name: "open Only's page from the reading list", act: (c) => { const id = idOf(c, "Only"); const k = listKey(c); if (id) c.openReader(id, k); } },
  { name: "open Paired in the player", act: (c) => { const b = c.getState().books.find((x) => x.book.title === "Paired"); if (b) return c.openBook(b); } },
  { name: "play Paired", act: (c) => { const b = c.getState().books.find((x) => x.book.title === "Paired"); if (b) void c.playBook(b); } },
  { name: "open the full player", act: (c) => c.expandPlayer() },
  { name: "open the full player on its chapters", act: (c) => c.expandPlayer("chapters") },
  { name: "show the bookmarks drawer", act: (c) => c.setPlayerDrawer("bookmarks") },
  { name: "close the full player", act: (c) => c.collapsePlayer() },
  { name: "open Only to read", act: (c) => { const id = idOf(c, "Only"); if (id) void c.openReading(id); } },
  { name: "close the reader", act: (c) => void c.closeReading() },
  { name: "remove the folder", act: (c) => { const id = c.getState().sources.find((s) => s.root === ROOT)?.id; if (id) return c.removeSource(id); } },
];

const reached = new Set<string>();

async function trace(which: "old" | "new", sequence: readonly number[]): Promise<Seen[]> {
  const restore = proofWorld();
  const platform = proofPlatform(proofHost(proofLibrary(), new Holds()));
  const c: Either = which === "old" ? new OldController(platform) : new AppController(platform);
  const seen = () => (which === "old" ? seenOld(c as OldController) : seenNew(c as AppController));
  try {
    await c.boot();
    await settle();
    const out: Seen[] = [];
    for (const e of sequence) {
      await EVENTS[e]!.act(c);
      await settle();
      const s = seen();
      out.push(s);
      reached.add(s.pane + (s.page ? ` ${s.page}` : "") + (s.series ? ` ${s.series}` : ""));
      reached.add(`full player ${s.fullPlayer}`);
      if (s.reading) reached.add("reading over it");
    }
    return out;
  } finally {
    c.destroy();
    restore();
  }
}

describe("what's on screen, before and after it was one status", () => {
  it(`does what it did for every sequence of ${DEPTH} events and ${RANDOM_RUNS} longer ones`, async () => {
    const tally = await walk<Seen>({ events: EVENTS.map((e) => e.name), trace, meant, depth: DEPTH, random: RANDOM_RUNS, length: RANDOM_LENGTH });
    expect(tally.problems).toEqual([]);
    expect(tally.sequences).toBe(EVENTS.length ** DEPTH + RANDOM_RUNS);
    expect([...tally.meant.keys()]).toEqual([GONE_CLOSES]);
    // Every page, both ways to a book's page, the full player on each drawer, and the reader over them.
    expect([...reached].sort()).toEqual(
      [
        "bookcase",
        "full player closed",
        "full player open on bookmarks",
        "full player open on chapters",
        "full player open on nothing",
        "library",
        "reader Only",
        "reader Paired",
        "reader Paired, from the bookcase",
        "reader Only, from the bookcase",
        "reading over it",
        "series A reading list",
        "settings",
        "stats",
      ].sort(),
    );
  }, 900_000);
});
