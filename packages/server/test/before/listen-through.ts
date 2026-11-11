// The rules readalong-routes.ts wrote a book's listen-throughs by, in its /listened, /finished and /unfinished routes,
// before they were written down in core/listen-through.ts (docs/STATE-MACHINES.md): each route's lines as they were,
// with only what it was given made arguments. Kept for listen-through-before-after.test.ts.
import type { ReadRecord } from "@ribbon/core/poslog";

type Last = Pick<ReadRecord, "id" | "started" | "finished"> | undefined;

/** POST /api/books/:id/listened: the listen-through it opens, if any. */
export function listened(last: Last, again: boolean, began: string, newId: () => string): Record<string, unknown> | null {
  if (!last || again === true) return { k: "read", id: newId(), started: began };
  return null;
}

/** POST /api/books/:id/finished: the listen-through it writes; null when it was finished already, and stays. */
export function finished(last: Last, firstHeard: string | null, now: string, newId: () => string): Record<string, unknown> | null {
  if (last?.finished) return null;
  return { k: "read" as const, id: last?.id ?? newId(), started: last?.started ?? firstHeard ?? now, finished: now };
}

/** POST /api/books/:id/unfinished: the listen-through it writes. */
export function unfinished(last: Last, now: string, newId: () => string): Record<string, unknown> {
  return { k: "read" as const, id: last?.id ?? newId(), started: last?.started ?? now };
}
