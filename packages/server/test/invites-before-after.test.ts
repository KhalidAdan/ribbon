import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Invites } from "../src/invites.ts";
import { Invites as OldInvites } from "./before/invites.ts";

/**
 * Invites got one status, read from their row in one place and moved by
 * one table (src/invites.ts). This proves the new invites do what the old
 * ones did, event for event, in every sequence of up to DEPTH events from a
 * world of holds, gives-back, spends, waits and restarts: after every
 * event, a sign-up gets the same answer from each, the code is as usable in
 * each, and the same person spent it.
 *
 * Three differences are meant, and no other is allowed:
 *
 * - **Time doesn't let a hold go.** The old invites let another sign-up
 *   take a code held five minutes, while the first could still spend it:
 *   one invite, two accounts. A hold now lasts until its sign-up ends.
 * - **A restart does.** A hold left by a server that stopped mid sign-up
 *   is let go when it starts, rather than five minutes after it was taken.
 * - **Only a held code is spent.** The old invites spent any code, fresh,
 *   expired or spent already (the last spender's name written over the
 *   first's).
 *
 * `before/invites.ts` is the old invites, as they were.
 */

const DEPTH = 6;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The invite table as the server makes it (db.ts). */
const TABLE = "CREATE TABLE invite (code TEXT PRIMARY KEY, role TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_by TEXT, reserved_at INTEGER, used_at INTEGER, used_by TEXT)";

/** What both kinds of invites answer to. */
interface Answers {
  reserve(code: string): string | null;
  release(code: string): void;
  spend(code: string, userId: string): void;
  usable(code: string): boolean;
}

/** One of the two, with its own database, one code made in it, and the clock both share. */
interface Side {
  db: DatabaseSync;
  code: string;
  invites: Answers;
  start(): Answers;
}

interface Row {
  reserved_at: number | null;
  used_at: number | null;
  used_by: string | null;
}

type Event = { name: string; act?: (s: Side) => unknown; wait?: number };

const EVENTS: Event[] = [
  { name: "hold", act: (s) => s.invites.reserve(s.code) },
  { name: "give back", act: (s) => s.invites.release(s.code) },
  { name: "spent by ann", act: (s) => s.invites.spend(s.code, "ann") },
  { name: "spent by bea", act: (s) => s.invites.spend(s.code, "bea") },
  { name: "wait a minute", wait: MINUTE },
  { name: "wait six minutes", wait: 6 * MINUTE },
  { name: "wait a week", wait: 7 * DAY },
  { name: "restart", act: (s) => void (s.invites = s.start()) },
];

const rowOf = (s: Side): Row => s.db.prepare("SELECT reserved_at, used_at, used_by FROM invite WHERE code = ?").get(s.code) as unknown as Row;
const putBack = (s: Side, row: Row) => void s.db.prepare("UPDATE invite SET reserved_at = ?, used_at = ?, used_by = ? WHERE code = ?").run(row.reserved_at, row.used_at, row.used_by, s.code);

/**
 * Which of the meant differences this is, from the event, the old invite as
 * it stood before it, and the time it happened; null when it's none of them.
 * The old invites took a hold five minutes old for none.
 */
function meant(event: Event, old: Row, at: number): string | null {
  const held = old.reserved_at !== null && old.used_at === null;
  if (event.wait && held) return "time doesn't let a hold go";
  if (event.name === "restart" && held) return "a restart does";
  if (event.name.startsWith("spent") && !(held && old.reserved_at! >= at - 5 * MINUTE)) return "only a held code is spent";
  return null;
}

describe("invites, before and after their status was written down", () => {
  it(`do what they did in every sequence of up to ${DEPTH} events, but for the three differences meant`, () => {
    const world = { now: Date.parse("2026-11-10T12:00:00Z") };
    const clock = () => world.now;
    const side = (make: (db: DatabaseSync) => Answers & { create(role: "user", by: null): { code: string } }): Side => {
      const db = new DatabaseSync(":memory:");
      db.exec(TABLE);
      const invites = make(db);
      return { db, code: invites.create("user", null).code, invites, start: () => make(db) };
    };
    const old = side((db) => new OldInvites(db, clock));
    const now = side((db) => new Invites(db, clock));
    const seen = (s: Side) => ({ usable: s.invites.usable(s.code), usedBy: rowOf(s).used_by });

    let steps = 0;
    const meantDifferences = new Map<string, number>();
    const problems: string[] = [];

    const walk = (path: string[]): void => {
      if (path.length === DEPTH || problems.length > 0) return;
      // Where this sequence has brought each side, put back before each next event.
      const at = world.now;
      const rows = [rowOf(old), rowOf(now)] as const;
      const invites = [old.invites, now.invites] as const;
      for (const event of EVENTS) {
        steps++;
        world.now = at;
        putBack(old, rows[0]);
        putBack(now, rows[1]);
        old.invites = invites[0];
        now.invites = invites[1];
        world.now += event.wait ?? 0;
        const answers = [event.act?.(old), event.act?.(now)];
        const route = [...path, event.name];
        const before = { answer: answers[0] ?? null, ...seen(old) };
        const after = { answer: answers[1] ?? null, ...seen(now) };
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          const why = meant(event, rows[0], world.now);
          if (why) {
            meantDifferences.set(why, (meantDifferences.get(why) ?? 0) + 1);
            continue;
          }
          problems.push(`${route.join(" → ")}: the old invite said ${JSON.stringify(before)}, the new ${JSON.stringify(after)}`);
        }
        walk(route);
      }
    };

    walk([]);
    expect(problems.slice(0, 5)).toEqual([]);
    // The walk reached each place they differ, so it would have seen any other.
    expect([...meantDifferences.keys()].sort()).toEqual(["a restart does", "only a held code is spent", "time doesn't let a hold go"]);
    expect(steps).toBeGreaterThan(80_000);
  }, 600_000);
});
