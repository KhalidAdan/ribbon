import { describe, expect, it } from "vitest";
import { AppController, type AppState } from "../src/app/controller";
import { AppController as OldController, type AppState as OldState } from "./before/controller";
import { isPlaying } from "@ribbon/core/playback";
import { Holds, proofHost, proofLibrary, proofPlatform, proofWorld, settle } from "./support/proof-app";
import { walk } from "./support/walk";

/**
 * The reader's session became one status at a time (core/reading/session.ts,
 * docs/STATE-MACHINES.md): opening, failed, or ready, and only a ready one
 * has a text and a place. This proves the controller does with it what it
 * did: the old controller (before/controller.ts, as it was) and the new are
 * opened on the same library, put through the same events, and after every
 * step must show the same: the book open in the reader and how far it has
 * got, its place, its pairing with the audio, whether it follows the
 * narrator, its highlights, its export, and the player and errors around it.
 */

const DEPTH = Number(process.env.PROOF_DEPTH ?? 3);
const RANDOM_RUNS = Number(process.env.PROOF_RANDOM ?? 1_000);
const RANDOM_LENGTH = 10;

/** What anyone could see of the reader, said the same way for both. */
interface Seen {
  reading: {
    book: string;
    status: string;
    message?: string;
    place?: string;
    pairing?: string;
    readsAlong?: boolean;
    listening?: string;
    following?: boolean;
    finding?: boolean;
    highlights?: number;
    found?: string;
    export?: string;
  } | null;
  playerExpanded: boolean;
  error: string | null;
  current: string | null;
  playing: boolean;
}

type Either = AppController | OldController;

function titleOf(state: AppState | OldState, id: string): string {
  return state.books.find((b) => b.book.id === id)?.book.title ?? id;
}

function around(s: AppState | OldState): Omit<Seen, "reading"> {
  const playerExpanded = "fullPlayer" in s ? s.fullPlayer !== null : s.playerExpanded;
  return { playerExpanded, error: s.error, current: s.current ? s.current.book.book.title : null, playing: isPlaying(s.player.status) };
}

function seenOld(s: OldState): Seen {
  const r = s.reading;
  if (!r) return { reading: null, ...around(s) };
  const ready = r.status === "ready";
  return {
    reading: {
      book: titleOf(s, r.bookId),
      status: r.status,
      ...(r.message !== undefined ? { message: r.message } : {}),
      ...(r.listening ? { listening: `${r.listening.what} ${r.listening.done}/${r.listening.total}` } : {}),
      ...(ready
        ? {
            place: r.place ? `${r.place.section}.${r.place.block}.${r.place.offset}` : "none",
            pairing: r.alignment ? `${r.alignment.how}: ${r.alignment.pairs.map((p) => `${p.text.start}-${p.text.end}@${p.audio.startMs}`).join(" ")}` : "none",
            readsAlong: !!r.readsAlong,
            following: !!r.following,
            finding: !!r.finding,
            highlights: r.highlights?.length ?? 0,
            ...(r.found ? { found: JSON.stringify(r.found) } : {}),
            export: r.exporting ? `exporting ${r.exporting.done}/${r.exporting.total}` : r.exported ? ("path" in r.exported ? `made ${r.exported.path}` : `failed: ${r.exported.error}`) : "none",
          }
        : {}),
    },
    ...around(s),
  };
}

function seenNew(s: AppState): Seen {
  const r = s.reading;
  if (!r) return { reading: null, ...around(s) };
  const e = r.status === "ready" ? r.export : null;
  return {
    reading: {
      book: titleOf(s, r.bookId),
      status: r.status,
      ...(r.status === "failed" ? { message: r.message } : {}),
      ...(r.status === "ready" && r.listening ? { listening: `${r.listening.what} ${r.listening.done}/${r.listening.total}` } : {}),
      ...(r.status === "ready"
        ? {
            place: `${r.place.section}.${r.place.block}.${r.place.offset}`,
            pairing: r.alignment ? `${r.alignment.how}: ${r.alignment.pairs.map((p) => `${p.text.start}-${p.text.end}@${p.audio.startMs}`).join(" ")}` : "none",
            readsAlong: r.readsAlong,
            following: r.following,
            finding: r.finding,
            highlights: r.highlights.length,
            ...(r.found ? { found: JSON.stringify(r.found) } : {}),
            export: e!.status === "exporting" ? `exporting ${e!.done}/${e!.total}` : e!.status === "made" ? `made ${e!.path}` : e!.status === "failed" ? `failed: ${e!.error}` : "none",
          }
        : {}),
    },
    ...around(s),
  };
}

const PAIRED = "Paired";
const bookId = (c: Either, title: string) => c.getState().books.find((b) => b.book.title === title)!.book.id;

const EVENTS: { name: string; act: (c: Either, holds: Holds) => unknown }[] = [
  { name: "open Paired", act: (c) => void c.openReading(bookId(c, PAIRED)) },
  { name: "open Only", act: (c) => void c.openReading(bookId(c, "Only")) },
  { name: "open Broken", act: (c) => void c.openReading(bookId(c, "Broken")) },
  { name: "texts load slowly, or at once again", act: (_c, h) => void (h.slowTexts = !h.slowTexts) },
  { name: "the texts arrive", act: (_c, h) => h.texts.resolveAll() },
  { name: "close the reader", act: (c) => void c.closeReading() },
  {
    name: "turn the page by hand",
    act: (c) => {
      const r = c.getState().reading as { status: string; place?: { section: number } } | null;
      if (r?.status === "ready" && r.place) c.moveReading(r.place.section === 0 ? { section: 1, block: 0, offset: 0 } : { section: 0, block: 1, offset: 0 }, "periodic", "hand");
    },
  },
  {
    name: "follow the narrator, or stop",
    act: (c) => {
      const r = c.getState().reading as { following?: boolean } | null;
      if (r) c.setFollowing(!r.following);
    },
  },
  { name: "export the read-along", act: (c) => void c.exportReadAlong() },
  { name: "the export is made", act: (_c, h) => h.exports.resolveAll("/books/Ann Writer/Paired/Paired (read-along).epub") },
  { name: "the export fails", act: (_c, h) => h.exports.rejectAll(new Error("the disk is full")) },
  { name: "play Paired", act: (c) => void c.playBook(c.getState().books.find((b) => b.book.title === PAIRED)!) },
  { name: "pause", act: (c) => c.pause() },
  { name: "the first chapter is not narrated, or is again", act: (c) => void c.fixPairing("one.xhtml#0", c.pairingFixes().length === 0 ? null : "auto") },
  { name: "highlight a line", act: (c) => void c.addHighlight({ section: 0, block: 0, offset: 4 }, { section: 0, block: 0, offset: 20 }) },
];

/** What the walk got to, so it's known to have gone everywhere it should. */
const reached = new Set<string>();

function note(seen: Seen): void {
  const r = seen.reading;
  reached.add(r ? `${r.book} ${r.status}` : "closed");
  if (r?.export && r.export !== "none") reached.add(`export ${r.export.split(" ")[0]}`);
  if (r?.following) reached.add("following");
  if (r?.highlights) reached.add("a highlight");
  if (r?.pairing?.startsWith("chapter")) reached.add("paired");
  if (seen.playing) reached.add("playing");
}

async function trace(which: "old" | "new", sequence: readonly number[]): Promise<Seen[]> {
  const restore = proofWorld();
  const holds = new Holds();
  const platform = proofPlatform(proofHost(proofLibrary(), holds));
  const c: Either = which === "old" ? new OldController(platform) : new AppController(platform);
  const seen = () => (which === "old" ? seenOld((c as OldController).getState()) : seenNew((c as AppController).getState()));
  try {
    await c.boot();
    await settle();
    const out: Seen[] = [];
    for (const e of sequence) {
      await EVENTS[e]!.act(c, holds);
      await settle();
      out.push(seen());
      note(out[out.length - 1]!);
    }
    return out;
  } finally {
    c.destroy();
    restore();
  }
}

describe("the reader's session, before and after it was one status at a time", () => {
  it(`does what it did for every sequence of ${DEPTH} events and ${RANDOM_RUNS} longer ones`, async () => {
    const tally = await walk<Seen>({ events: EVENTS.map((e) => e.name), trace, depth: DEPTH, random: RANDOM_RUNS, length: RANDOM_LENGTH });
    expect(tally.problems).toEqual([]);
    expect(tally.sequences).toBe(EVENTS.length ** DEPTH + RANDOM_RUNS);
    // Every status of every book, and every status of the export, so a difference in any would have shown.
    expect([...reached].sort()).toEqual(
      ["Broken failed", "Broken opening", "Only opening", "Only ready", "Paired opening", "Paired ready", "a highlight", "closed", "export exporting", "export failed:", "export made", "following", "paired", "playing"].sort(),
    );
  }, 900_000);
});
