import { describe, expect, it } from "vitest";
import { readAfter, type Read } from "@ribbon/core/listen-through";
import * as before from "./before/listen-through.ts";

/**
 * The server's three routes that write a book's listen-throughs (/listened,
 * /finished, /unfinished) each had their own lines; now they ask one
 * function (core/listen-through.ts). This proves the function writes what
 * the routes wrote, in every sequence of up to DEPTH events from a world of
 * listening, starting again, finishing and unfinishing, with and without a
 * place heard before the first listen-through, as time passes: after every
 * event, the record written is the same, so the book's history is too.
 * No difference is meant. `before/listen-through.ts` is the routes' lines,
 * as they were.
 */

const DEPTH = 7;

interface World {
  /** The book's listen-throughs so far, as the log has them. */
  reads: Read[];
  now: number;
  /** When the book was first heard since its last finish, if it was. */
  firstHeard: string | null;
}

type Ask<T> = (last: Read | undefined, w: World, newId: () => string) => T | null;

const iso = (ms: number) => new Date(ms).toISOString();

const EVENTS: { name: string; old?: Ask<Record<string, unknown>>; now?: Ask<Read>; world?: (w: World) => World }[] = [
  { name: "listened", old: (last, w, id) => before.listened(last, false, iso(w.now), id), now: (last, w, id) => readAfter(last, { k: "playing" }, iso(w.now), id) },
  { name: "listened again", old: (last, w, id) => before.listened(last, true, iso(w.now), id), now: (last, w, id) => readAfter(last, { k: "again" }, iso(w.now), id) },
  { name: "finished", old: (last, w, id) => before.finished(last, w.firstHeard, iso(w.now), id), now: (last, w, id) => readAfter(last, { k: "finished", firstHeard: w.firstHeard }, iso(w.now), id) },
  { name: "unfinished", old: (last, w, id) => before.unfinished(last, iso(w.now), id), now: (last, w, id) => readAfter(last, { k: "unfinished" }, iso(w.now), id) },
  { name: "heard, or not", world: (w) => ({ ...w, firstHeard: w.firstHeard ? null : iso(w.now) }) },
  { name: "an hour passes", world: (w) => ({ ...w, now: w.now + 3_600_000 }) },
];

/** The book's latest listen-through, as the routes find it: the last to start, and of two at once, the last written. */
function lastOf(reads: readonly Read[]): Read | undefined {
  return [...reads].sort((a, b) => Date.parse(a.started) - Date.parse(b.started)).at(-1);
}

/** A record written into the log: one with an id it has already takes its place. */
function written(reads: readonly Read[], read: Read): Read[] {
  return [...reads.filter((r) => r.id !== read.id), read];
}

describe("listen-throughs, before and after they were written down", () => {
  it(`are written as they were in every sequence of up to ${DEPTH} events`, () => {
    let steps = 0;
    let writes = 0;
    const problems: string[] = [];

    const walk = (path: string[], w: World): void => {
      if (path.length === DEPTH || problems.length > 0) return;
      for (const event of EVENTS) {
        steps++;
        const route = [...path, event.name];
        let next = event.world ? event.world(w) : w;
        if (event.old && event.now) {
          // Each side names a new listen-through the same way, so the same one is the same.
          let n = 0;
          const oldRead = event.old(lastOf(w.reads), w, () => `urn:uuid:${steps}-${n++}`);
          n = 0;
          const newRead = event.now(lastOf(w.reads), w, () => `urn:uuid:${steps}-${n++}`);
          if (JSON.stringify(oldRead) !== JSON.stringify(newRead)) {
            problems.push(`${route.join(" → ")}: the routes wrote ${JSON.stringify(oldRead)}, the function ${JSON.stringify(newRead)}`);
            continue;
          }
          if (newRead) {
            writes++;
            next = { ...next, reads: written(next.reads, newRead) };
          }
        }
        walk(route, next);
      }
    };

    walk([], { reads: [], now: Date.parse("2026-11-10T12:00:00Z"), firstHeard: null });
    expect(problems.slice(0, 5)).toEqual([]);
    expect(steps).toBeGreaterThan(300_000);
    expect(writes).toBeGreaterThan(100_000);
  }, 600_000);
});
