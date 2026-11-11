/**
 * Before and after (docs/TEST-PLAN.md): the old code and the new are put
 * through the same events, every sequence up to a length and then many
 * longer ones at random (but the same each run), and what each shows is
 * compared after every step. Only the differences a rewrite means to make
 * are let through, and each must be reached at least once, so the walk is
 * known to have got that far.
 */

/** What a difference between old and new is, when it's meant; null when it isn't. */
export type Meant<Seen> = (old: Seen, now: Seen, step: { event: string; earlier: ReadonlySet<string> }) => string[] | null;

export interface Walk<Seen> {
  /** The names of the events, in order: a sequence is their indexes. */
  events: readonly string[];
  /** One run of a sequence through the old code or the new: what it showed after each step. */
  trace(which: "old" | "new", sequence: readonly number[]): Promise<Seen[]>;
  /** How a difference that's meant shows; without it, any difference fails. */
  meant?: Meant<Seen>;
  depth: number;
  random: number;
  length: number;
  seed?: number;
}

export interface Tally {
  sequences: number;
  steps: number;
  /** Each meant difference, and how often it was seen. */
  meant: Map<string, number>;
  /** The first difference that wasn't meant, with the events that led to it. */
  problems: string[];
}

/** A repeatable stream of numbers, so a failing random sequence can be run again. */
export function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}

/** Every sequence of `depth` events, then `random` of `length`; stops at the first difference not meant. */
export async function walk<Seen>(w: Walk<Seen>): Promise<Tally> {
  const tally: Tally = { sequences: 0, steps: 0, meant: new Map(), problems: [] };
  const n = w.events.length;
  const compare = async (sequence: number[]) => {
    const old = await w.trace("old", sequence);
    const now = await w.trace("new", sequence);
    tally.sequences++;
    const earlier = new Set<string>();
    for (let i = 0; i < sequence.length; i++) {
      tally.steps++;
      const o = JSON.stringify(old[i]);
      const m = JSON.stringify(now[i]);
      if (o === m) continue;
      const route = sequence.slice(0, i + 1).map((e) => w.events[e]).join(" → ");
      const kinds = w.meant?.(old[i]!, now[i]!, { event: w.events[sequence[i]!]!, earlier }) ?? null;
      if (kinds === null || kinds.length === 0) {
        tally.problems.push(`${route}:\n  was ${o}\n  is  ${m}`);
        return;
      }
      for (const k of kinds) {
        earlier.add(k);
        tally.meant.set(k, (tally.meant.get(k) ?? 0) + 1);
      }
    }
  };
  for (let i = 0; i < n ** w.depth && tally.problems.length === 0; i++) {
    const sequence: number[] = [];
    for (let d = 0, k = i; d < w.depth; d++, k = Math.floor(k / n)) sequence.push(k % n);
    await compare(sequence);
  }
  const next = seeded(w.seed ?? 20_261_110);
  for (let r = 0; r < w.random && tally.problems.length === 0; r++) {
    await compare(Array.from({ length: w.length }, () => Math.floor(next() * n)));
  }
  return tally;
}
