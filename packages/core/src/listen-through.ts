import type { ReadRecord } from "./poslog.ts";

/**
 * A listen-through, written: what goes in the log when someone plays a
 * book, starts it again, or says they've finished it or not. Reading the
 * log back is stats.ts (`openRead`, `endOf`).
 *
 * Where a book stands is its latest listen-through in the log: none yet,
 * one going (no finish), or one finished.
 *
 *     none ──playing──▶ going ──finished──▶ finished
 *                         ▲                    │
 *                         └────unfinished──────┘
 *
 *     any ──again──▶ a new one, going (the old one stays in the history)
 *     none ──finished──▶ one finished now, begun when the book was first heard
 *     none ──unfinished──▶ a new one, going
 *
 * Playing a book that's going or finished writes nothing: a finished book
 * opens a new listen-through only when it's started again.
 */
export type ReadStatus = "none" | "going" | "finished";

/** What happened to a book. */
export type ReadEvent =
  /** Playing started. */
  | { k: "playing" }
  /** Started again from the beginning, finished or not. */
  | { k: "again" }
  /** Said to be finished; `firstHeard` is when it was first heard since the last finish, for a book with no listen-through yet. */
  | { k: "finished"; firstHeard: string | null }
  /** Said not to be finished after all. */
  | { k: "unfinished" };

/** A listen-through as the log writes it. */
export type Read = Pick<ReadRecord, "k" | "id" | "started" | "finished">;

/** Where a book stands, from its latest listen-through. */
export function readStatus(last: Read | undefined): ReadStatus {
  if (!last) return "none";
  return last.finished ? "finished" : "going";
}

/**
 * The listen-through to write when `event` happens, at `at` (ISO 8601), to
 * a book whose latest listen-through is `last`; null when nothing is
 * written. A new one is named by `newId`. Every status has an answer for
 * every event, here and nowhere else.
 */
export function readAfter(last: Read | undefined, event: ReadEvent, at: string, newId: () => string): Read | null {
  const status = readStatus(last);
  switch (event.k) {
    case "playing":
      return status === "none" ? { k: "read", id: newId(), started: at } : null;
    case "again":
      return { k: "read", id: newId(), started: at };
    case "finished":
      if (status === "finished") return null;
      return { k: "read", id: last?.id ?? newId(), started: last?.started ?? event.firstHeard ?? at, finished: at };
    case "unfinished":
      return { k: "read", id: last?.id ?? newId(), started: last?.started ?? at };
  }
}
