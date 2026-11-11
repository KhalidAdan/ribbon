import { afterEach, describe, expect, it, vi } from "vitest";
import { PlayerEngine, type EngineState } from "../src/player/engine";
import { PlayerEngine as OldEngine, type EngineState as OldState } from "./before/engine";
import { FakeMedia } from "./support/fake-media";
import { STALL_MS } from "@ribbon/core/recovery";
import { isLoading, isPlaying } from "@ribbon/core/playback";
import type { AudioFile } from "@ribbon/core/types";

/**
 * The player's status became an explicit state machine (core/playback.ts,
 * docs/STATE-MACHINES.md). This proves the engine does what it did: the
 * old engine (before/engine.ts, as it was) and the new one are put through
 * the same events, on the same fake audio, and after every step they must
 * have done the same to the audio (every element's source, place, play
 * count, rate and volume), kept the same place, written the same log,
 * ended alike, and told the app the same: whether it plays, step by step,
 * and where it is, how long, how fast, how loud, what it's waiting for and
 * what's wrong.
 *
 * Four differences are meant, and only these are allowed: each is a word
 * the old engine left up after what it described had stopped.
 * - "Reconnecting…" after something outside Ribbon paused it mid-reconnect.
 * - "Reconnecting…" after the system refused to play mid-reconnect.
 * - "… Still trying…" after the listener paused mid-reconnect.
 * - "Loading…" from a late word from the audio after a pause.
 */

/** Every sequence this long is tried; PROOF_DEPTH=4 tries every one of four (about a minute). */
const DEPTH = Number(process.env.PROOF_DEPTH ?? 3);
/** Then this many longer ones, at random but the same each run: long enough to fail again and again, as a share that has gone does. */
const RANDOM_RUNS = Number(process.env.PROOF_RANDOM ?? 2_000);
const RANDOM_LENGTH = 16;

/** What the app can see of the engine, said the same way for both. */
interface Seen {
  bookId: string | null;
  positionMs: number;
  durationMs: number;
  playing: boolean;
  loading: boolean;
  reconnecting: boolean;
  error: string | null;
  speed: number;
  chapterIndex: number;
  skippingGap: boolean;
  gain: number;
}

function seenOld(s: OldState): Seen {
  // Waiting under a reconnect is never shown: the reconnect is.
  return { bookId: s.bookId, positionMs: s.positionMs, durationMs: s.durationMs, playing: s.playing, loading: s.buffering && !s.reconnecting, reconnecting: s.reconnecting, error: s.error, speed: s.speed, chapterIndex: s.chapterIndex, skippingGap: s.skippingGap, gain: s.gain };
}

function seenNew(s: EngineState): Seen {
  return { bookId: s.bookId, positionMs: s.positionMs, durationMs: s.durationMs, playing: isPlaying(s.status), loading: isLoading(s.status), reconnecting: s.status === "reconnecting", error: s.error, speed: s.speed, chapterIndex: s.chapterIndex, skippingGap: s.skippingGap, gain: s.gain };
}

type Engine = Pick<PlayerEngine, "load" | "play" | "pause" | "seek" | "setStopAt" | "positionMs" | "destroy">;

const files: AudioFile[] = [
  { path: "a.mp3", durationMs: 3_000 } as AudioFile,
  { path: "b.mp3", durationMs: 3_000 } as AudioFile,
];
const book = { id: "b1", files, chapters: [{ title: "One", startMs: 0, endMs: 2_000 }, { title: "Two", startMs: 2_000, endMs: 6_000 }] as never[] };

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 200) {
    for (const m of FakeMedia.all) m.advance(200);
    await vi.advanceTimersByTimeAsync(200);
    await flush();
  }
}

function active(): FakeMedia | undefined {
  return FakeMedia.all.find((m) => m.src && !m.paused) ?? FakeMedia.all.find((m) => m.src);
}

const ACTIONS: { name: string; act: (e: Engine) => Promise<void> | void }[] = [
  // Not waited for: a play waits for the audio, which may be waiting for files that are slow to arrive.
  { name: "play", act: (e) => void e.play() },
  { name: "pause", act: (e) => e.pause() },
  { name: "seek into the second file", act: (e) => e.seek(4_000) },
  { name: "seek near the start", act: (e) => e.seek(1_000) },
  { name: "a second passes", act: () => run(1_000) },
  { name: "the file stalls for a while", act: () => { const a = active(); if (a) a.stalled = true; return run(STALL_MS + 1_000); } },
  { name: "the network fails", act: () => active()?.fail(2) },
  {
    name: "the share goes away, or comes back",
    act: () => {
      const gone = FakeMedia.broken.size > 0;
      for (const f of files) {
        if (gone) FakeMedia.broken.delete(`url:${f.path}`);
        else FakeMedia.broken.set(`url:${f.path}`, 2);
      }
    },
  },
  { name: "the file is damaged here", act: () => active()?.fail(3) },
  { name: "paused from outside", act: () => active()?.externalPause() },
  { name: "the audio waits for data", act: () => active()?.waitForData() },
  { name: "the system refuses play, or allows it again", act: () => void (FakeMedia.refusePlay = !FakeMedia.refusePlay) },
  { name: "files load slowly, or quickly again", act: () => void (FakeMedia.manualLoad = !FakeMedia.manualLoad) },
  { name: "the files arrive", act: () => FakeMedia.loadAll() },
  { name: "the book is loaded again", act: (e) => e.load(book, 2_000) },
  { name: "stop half a second on", act: (e) => e.setStopAt(e.positionMs() + 500) },
];

/** Everything one engine did after each step of a sequence. */
interface Step {
  /** Whether it played, each time that changed during the step: the app keeps the place and the listening on these. */
  playingChanges: boolean[];
  last: Seen;
  position: number;
  audio: string;
  ended: number;
  log: string[];
}

async function trace(make: "old" | "new", actions: number[]): Promise<Step[]> {
  FakeMedia.reset();
  for (const f of files) FakeMedia.durations.set(`url:${f.path}`, f.durationMs / 1000);
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let seen: Seen[] = [];
  let ended = 0;
  const log: string[] = [];
  const opts = {
    resolveUrl: (p: string) => `url:${p}`,
    onEnded: () => void ended++,
    onLog: (m: string) => void log.push(m),
    createElement: () => new FakeMedia(),
  };
  const oldEngine = make === "old" ? new OldEngine({ ...opts, onState: (s: OldState) => void seen.push(seenOld(s)) }) : null;
  const newEngine = make === "new" ? new PlayerEngine({ ...opts, onState: (s: EngineState) => void seen.push(seenNew(s)) }) : null;
  const engine: Engine = (oldEngine ?? newEngine)!;
  /** What it shows at the end of a step. */
  const now = (): Seen => (oldEngine ? seenOld(oldEngine.current) : seenNew(newEngine!.current));
  await engine.load(book, 0);
  await flush();
  const steps: Step[] = [];
  let was = false;
  for (const i of actions) {
    seen = [];
    log.length = 0;
    await ACTIONS[i]!.act(engine);
    await flush();
    const playingChanges: boolean[] = [];
    for (const s of seen) if (s.playing !== was) playingChanges.push((was = s.playing));
    steps.push({
      playingChanges,
      last: now(),
      position: engine.positionMs(),
      audio: JSON.stringify(FakeMedia.all.map((m) => [m.src, m.paused, Math.round(m.currentTime * 1000), m.playbackRate, m.volume, m.plays, m.readyState, m.error?.code ?? 0])),
      ended,
      log: [...log],
    });
  }
  engine.destroy();
  vi.useRealTimers();
  return steps;
}

type Meant = "reconnecting after a pause from outside" | "reconnecting after a refusal" | "still trying after a pause" | "loading after a pause";

/**
 * Whether what the old engine showed differs from the new only in a word it
 * left up after what the word described had stopped. Returns which, or null
 * when the difference is anything else.
 */
function meantDifference(old: Seen, now: Seen, action: string, stale: Set<Meant>): Meant[] | null {
  const kinds: Meant[] = [];
  const keys = Object.keys(old) as (keyof Seen)[];
  for (const k of keys) {
    if (old[k] === now[k]) continue;
    if (now.playing || now.reconnecting) return null;
    if (k === "reconnecting" && old.reconnecting && !now.reconnecting) {
      if (action === "paused from outside" || stale.has("reconnecting after a pause from outside")) kinds.push("reconnecting after a pause from outside");
      else if (now.error === "Press play to continue" || stale.has("reconnecting after a refusal")) kinds.push("reconnecting after a refusal");
      else return null;
    } else if (k === "error" && now.error === null && old.error?.endsWith("Still trying…")) {
      kinds.push(action === "paused from outside" || stale.has("reconnecting after a pause from outside") ? "reconnecting after a pause from outside" : "still trying after a pause");
    } else if (k === "loading" && old.loading && !now.loading) {
      kinds.push("loading after a pause");
    } else return null;
  }
  return kinds;
}

interface Tally {
  sequences: number;
  steps: number;
  meant: Map<Meant, number>;
  problems: string[];
}

async function compare(actions: number[], tally: Tally): Promise<void> {
  const old = await trace("old", actions);
  const now = await trace("new", actions);
  tally.sequences++;
  const stale = new Set<Meant>();
  for (let i = 0; i < actions.length; i++) {
    tally.steps++;
    const route = actions.slice(0, i + 1).map((a) => ACTIONS[a]!.name).join(" → ");
    const o = old[i]!;
    const n = now[i]!;
    for (const k of ["position", "audio", "ended"] as const) {
      if (o[k] !== n[k]) tally.problems.push(`${route}: ${k} was ${o[k]}, is ${n[k]}`);
    }
    if (o.log.join("\n") !== n.log.join("\n")) tally.problems.push(`${route}: the log said ${JSON.stringify(o.log)}, says ${JSON.stringify(n.log)}`);
    if (o.playingChanges.join() !== n.playingChanges.join()) tally.problems.push(`${route}: playing went ${o.playingChanges.join()}, goes ${n.playingChanges.join()}`);
    const kinds = meantDifference(o.last, n.last, ACTIONS[actions[i]!]!.name, stale);
    if (kinds === null) tally.problems.push(`${route}: showed ${JSON.stringify(o.last)}, shows ${JSON.stringify(n.last)}`);
    else {
      stale.clear();
      for (const k of kinds) {
        stale.add(k);
        tally.meant.set(k, (tally.meant.get(k) ?? 0) + 1);
      }
    }
    if (tally.problems.length > 0) return;
  }
}

/** A repeatable stream of numbers, so a failing random sequence can be run again. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the player, before and after its status was made explicit", () => {
  it(`does what it did for every sequence of ${DEPTH} events and ${RANDOM_RUNS} longer ones, but for four words left up`, async () => {
    const tally: Tally = { sequences: 0, steps: 0, meant: new Map(), problems: [] };
    const n = ACTIONS.length;
    for (let i = 0; i < n ** DEPTH && tally.problems.length === 0; i++) {
      const actions: number[] = [];
      for (let d = 0, k = i; d < DEPTH; d++, k = Math.floor(k / n)) actions.push(k % n);
      await compare(actions, tally);
    }
    const next = seeded(20_261_110);
    for (let r = 0; r < RANDOM_RUNS && tally.problems.length === 0; r++) {
      await compare(Array.from({ length: RANDOM_LENGTH }, () => Math.floor(next() * n)), tally);
    }
    expect(tally.problems).toEqual([]);
    // Each meant difference was reached, so the walk would have seen any other.
    expect([...tally.meant.keys()].sort()).toEqual(["loading after a pause", "reconnecting after a pause from outside", "reconnecting after a refusal", "still trying after a pause"]);
    expect(tally.sequences).toBe(n ** DEPTH + RANDOM_RUNS);
  }, 600_000);
});
