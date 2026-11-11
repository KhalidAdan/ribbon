import { describe, expect, it } from "vitest";
import { AppController, transcribingIn } from "../src/app/controller";
import { AppController as OldController } from "./before/controller";
import { transcribingIn as oldTranscribingIn } from "./before/controller";
import { HEARING_DEADLINE_MS } from "../src/app/transcribing";
import { Held } from "./support/memory-host";
import { Holds, proofHost, proofLibrary, proofPlatform, proofWorld, ROOT, settle } from "./support/proof-app";
import { walk } from "./support/walk";

/**
 * Transcribing became one status for the open book's hearing and one for
 * a server's worker, with the computer kept awake worked out from them
 * (core/transcriber.ts, docs/STATE-MACHINES.md). This proves the open
 * book's hearing does what it did: the old controller (before/controller.ts)
 * and the new open the same library with a speech model whose answers the
 * test holds, go through the same events, and after every step must have
 * asked the model the same (every call, its clips, gently or not), kept the
 * computer awake alike, and shown the same: the reader, how far its
 * narration is transcribed, whether it reads along, the notes, and the top
 * bar's word on transcribing.
 *
 * A server's worker needs a server: what it does is in
 * desktop-on-server.test.ts, which runs the app against a real one.
 */

const DEPTH = Number(process.env.PROOF_DEPTH ?? 3);
const RANDOM_RUNS = Number(process.env.PROOF_RANDOM ?? 500);
const RANDOM_LENGTH = 10;

interface Seen {
  reading: string | null;
  listening: string | null;
  readsAlong: boolean;
  /** Every call to the speech model so far: openings or minutes, which clips, gently while a book plays. */
  asked: string[];
  awake: boolean | null;
  notices: string[];
  topBar: string | null;
}

type Either = AppController | OldController;

interface Speech {
  asked: string[];
  awake: (boolean | null)[];
  answers: Held<void>;
  failing: boolean;
}

function seen(c: Either, speech: Speech, which: "old" | "new"): Seen {
  const s = c.getState();
  const r = s.reading as { bookId: string; status: string; listening?: { done: number; total: number; what: string } | null; readsAlong?: boolean } | null;
  return {
    reading: r ? `${s.books.find((b) => b.book.id === r.bookId)?.book.title} ${r.status}` : null,
    listening: r?.listening ? `${r.listening.what} ${r.listening.done}/${r.listening.total}` : null,
    readsAlong: !!r?.readsAlong,
    asked: [...speech.asked],
    awake: speech.awake[speech.awake.length - 1] ?? null,
    notices: s.notices.map((n) => `${n.what} ${n.title}${n.what === "not-transcribed" ? `: ${n.why}` : ""}`),
    topBar: which === "old" ? oldTranscribingIn((c as OldController).getState()) : transcribingIn((c as AppController).getState()),
  };
}

const idOf = (c: Either, t: string) => c.getState().books.find((b) => b.book.title === t)?.book.id;

const EVENTS: { name: string; act: (c: Either, s: Speech) => unknown }[] = [
  { name: "open Paired to read", act: (c) => { const id = idOf(c, "Paired"); if (id) void c.openReading(id); } },
  { name: "open Only to read", act: (c) => { const id = idOf(c, "Only"); if (id) void c.openReading(id); } },
  { name: "close the reader", act: (c) => void c.closeReading() },
  {
    name: "turn into the other chapter",
    act: (c) => {
      const r = c.getState().reading as { status: string; place?: { section: number } } | null;
      if (r?.status === "ready" && r.place) c.moveReading({ section: r.place.section === 0 ? 1 : 0, block: 0, offset: 0 }, "periodic", "hand");
    },
  },
  { name: "the model answers", act: (_c, s) => s.answers.resolveAll() },
  { name: "the model fails", act: (_c, s) => s.answers.rejectAll(new Error("the model crashed")) },
  { name: "the model stops answering, and the deadline passes", act: async () => { const { vi } = await import("vitest"); await vi.advanceTimersByTimeAsync(HEARING_DEADLINE_MS); } },
  { name: "a minute passes", act: async () => { const { vi } = await import("vitest"); await vi.advanceTimersByTimeAsync(60_000); } },
  { name: "play Paired", act: (c) => { const b = c.getState().books.find((x) => x.book.title === "Paired"); if (b) void c.playBook(b); } },
  { name: "pause", act: (c) => c.pause() },
];

const reached = new Set<string>();

async function trace(which: "old" | "new", sequence: readonly number[]): Promise<Seen[]> {
  const restore = proofWorld();
  const speech: Speech = { asked: [], awake: [], answers: new Held<void>(), failing: false };
  const host = proofHost(proofLibrary(), new Holds(), {
    speechOpenings: async (_model, clips) => {
      speech.asked.push(`openings ${clips.map((c) => `${c.path.split("/").pop()}@${c.startMs}`).join(",")}`);
      return clips.map((c) => (c.path.endsWith("one.mp3") ? "Chapter One. The lamp was lit at dusk" : "Chapter Two. By morning the sea was calm"));
    },
    speechTranscribe: async (_model, clips, seconds, _language, gentle) => {
      speech.asked.push(`minutes ${clips.map((c) => `${c.path.split("/").pop()}@${c.startMs}`).join(",")}${gentle ? ", gently" : ""}`);
      await speech.answers.wait();
      return clips.map((c) => [{ startMs: c.startMs, endMs: c.startMs + seconds * 1000, words: c.path.endsWith("one.mp3") ? "The lamp was lit at dusk, and the keeper sat down with the ledger." : "By morning the sea was calm and grey." }]);
    },
    stayAwake: async (on) => void speech.awake.push(on),
  });
  const platform = proofPlatform(host, {}, [ROOT], { speechModel: "/models/ggml-small.bin", speechClipMs: 100 });
  const c: Either = which === "old" ? new OldController(platform) : new AppController(platform);
  try {
    await c.boot();
    await settle();
    const out: Seen[] = [];
    for (const e of sequence) {
      await EVENTS[e]!.act(c, speech);
      await settle();
      const s = seen(c, speech, which);
      out.push(s);
      if (s.listening) reached.add("transcribing, part way");
      if (s.readsAlong) reached.add("reads along");
      if (s.awake) reached.add("awake");
      if (s.awake === false) reached.add("asleep again");
      if (s.topBar) reached.add("the top bar says so");
      if (s.asked.some((a) => a.endsWith("gently"))) reached.add("gently while it plays");
      if (s.asked.filter((a) => a.startsWith("minutes")).length > 1) reached.add("heard again");
      for (const n of s.notices) reached.add(n.split(" ")[0]!);
    }
    return out;
  } finally {
    c.destroy();
    restore();
  }
}

describe("transcribing, before and after it was one status", () => {
  it(`hears the open book as it did, for every sequence of ${DEPTH} events and ${RANDOM_RUNS} longer ones`, async () => {
    const tally = await walk<Seen>({ events: EVENTS.map((e) => e.name), trace, depth: DEPTH, random: RANDOM_RUNS, length: RANDOM_LENGTH });
    expect(tally.problems).toEqual([]);
    expect(tally.sequences).toBe(EVENTS.length ** DEPTH + RANDOM_RUNS);
    expect([...reached].sort()).toEqual(["asleep again", "awake", "gently while it plays", "heard again", "reads along", "reads-along", "the top bar says so", "transcribing", "transcribing, part way"].sort());
  }, 900_000);
});
