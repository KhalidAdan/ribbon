import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Jobs } from "../src/jobs.ts";
import { Jobs as OldJobs } from "./before/jobs.ts";

/**
 * A job's state moves in one place now, and only as its picture says
 * (src/jobs.ts). This proves the new queue does what the old one did, event
 * for event, in every sequence of up to DEPTH events from a world of jobs
 * that finish, fail, report after they end, or wait, and of restarts:
 * after every event, every job's row says the same in each.
 *
 * One difference is meant, and no other is allowed: **a finished job never
 * moves again.** The old queue wrote whatever it was told: a report after a
 * job ended changed its progress, and a job a restart had failed came back
 * as running, then done. (A restart here is a second queue on the same
 * database while the first's jobs still run, as a server's would not: it
 * shows what each does with a job it no longer owns.)
 *
 * The other change, a lane that goes on when the database won't note a job
 * starting, is shown in jobs.test.ts: the old queue's lane stopped for good
 * there, with an error nobody caught.
 *
 * `before/jobs.ts` is the old queue, as it was.
 */

const DEPTH = 5;

/** The job table as the server makes it (db.ts). */
const TABLE = "CREATE TABLE job (id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, progress TEXT NOT NULL, error TEXT, created_by TEXT, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER)";

/** What both queues answer to. */
interface Queue {
  start<P>(kind: string, first: P, work: (report: (progress: P) => void) => Promise<P>, createdBy: string | null): unknown;
}

/** One of the two queues, with its own database, its clock, and the jobs' loose ends: reports kept for later, and jobs waiting to be let go. */
class Side {
  readonly db = new DatabaseSync(":memory:");
  clock = 0;
  queue: Queue;
  readonly late: ((progress: number) => void)[] = [];
  readonly waiting: (() => void)[] = [];

  constructor(private readonly make: (db: DatabaseSync, now: () => number) => Queue) {
    this.db.exec(TABLE);
    this.queue = make(this.db, () => this.clock);
  }

  restart(): void {
    this.queue = this.make(this.db, () => this.clock);
  }

  rows(): Row[] {
    return this.db.prepare("SELECT kind, state, progress, error, started_at, finished_at FROM job ORDER BY rowid").all() as unknown as Row[];
  }
}

interface Row {
  kind: string;
  state: string;
  progress: string;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
}

const EVENTS: { name: string; act: (s: Side) => void }[] = [
  { name: "queue one that finishes", act: (s) => s.queue.start("finishes", 0, async (report) => (report(1), 2), null) },
  { name: "queue one that fails", act: (s) => s.queue.start("fails", 0, async () => Promise.reject(new Error("it broke")), null) },
  { name: "queue one that reports after it ends", act: (s) => s.queue.start("late", 0, async (report) => (s.late.push(report), 2), null) },
  { name: "queue one that waits", act: (s) => s.queue.start("waits", 0, () => new Promise<number>((resolve) => s.waiting.push(() => resolve(2))), null) },
  { name: "the waiting ones finish", act: (s) => s.waiting.splice(0).forEach((go) => go()) },
  { name: "late reports", act: (s) => s.late.forEach((report) => report(99)) },
  { name: "restart", act: (s) => s.restart() },
];

/** Every job its queue has started runs as far as it can. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Both queues taken through the same events, a second apart: each one's rows before the last event, and after it. */
async function through(events: readonly (typeof EVENTS)[number][]): Promise<{ before: [Row[], Row[]]; after: [Row[], Row[]] }> {
  const sides = [new Side((db, now) => new OldJobs(db, now)), new Side((db, now) => new Jobs(db, now))] as const;
  let before: [Row[], Row[]] = [[], []];
  for (const [i, event] of events.entries()) {
    if (i === events.length - 1) before = [sides[0].rows(), sides[1].rows()];
    for (const side of sides) {
      side.clock = 1000 * (i + 1);
      event.act(side);
      await settle();
    }
  }
  return { before, after: [sides[0].rows(), sides[1].rows()] };
}

/** The meant difference: every job that differs had finished in the old queue, which moved it, and stayed as it was in the new one. */
function meant(before: [Row[], Row[]], after: [Row[], Row[]]): boolean {
  return after[0].every((old, i) => {
    const now = after[1][i]!;
    if (JSON.stringify(old) === JSON.stringify(now)) return true;
    const was = before[0][i];
    return !!was && (was.state === "done" || was.state === "failed") && JSON.stringify(now) === JSON.stringify(before[1][i]);
  });
}

describe("the job queue, before and after its states were written down", () => {
  it(`does what it did in every sequence of up to ${DEPTH} events, but move a finished job`, async () => {
    let steps = 0;
    let meantDifferences = 0;
    const problems: string[] = [];

    const walk = async (path: (typeof EVENTS)[number][]): Promise<void> => {
      if (path.length === DEPTH || problems.length > 0) return;
      for (const event of EVENTS) {
        steps++;
        const route = [...path, event];
        const { before, after } = await through(route);
        if (JSON.stringify(after[0]) !== JSON.stringify(after[1])) {
          if (meant(before, after)) {
            meantDifferences++;
            continue;
          }
          problems.push(`${route.map((e) => e.name).join(" → ")}: the old queue has ${JSON.stringify(after[0])}, the new ${JSON.stringify(after[1])}`);
        }
        await walk(route);
      }
    };

    await walk([]);
    expect(problems.slice(0, 5)).toEqual([]);
    // The walk reached where they differ, so it would have seen any other difference.
    expect(meantDifferences).toBeGreaterThan(0);
    expect(steps).toBeGreaterThan(17_000);
  }, 600_000);
});
