/**
 * Moving the Ribbon folder to another place on this computer, such as a
 * second disk, as a state machine (docs/STATE-MACHINES.md). A folder is
 * picked and checked; the move is asked about, with where it goes and how
 * much it holds; then everything that writes there stops, the folder is
 * copied, and Ribbon starts again in its new place.
 *
 * ```
 *   none     ── a folder picked and checked ──▶ asking, with the plan
 *            ── it can't go there ──▶ refused, and why
 *   asking   ── move, when it fits ──▶ moving, 0 of its size
 *            ── cancel ──▶ none
 *   refused  ── cancel ──▶ none
 *   asking, refused ── another folder picked ──▶ asking or refused again
 *   moving   ── progress ──▶ moving, further
 *            ── moved ──▶ restarting
 *            ── it failed ──▶ failed, and why
 *   failed, restarting: until Ribbon starts again
 * ```
 *
 * Nothing has stopped while asking, so asking and refused close as if
 * nothing happened. Once moving, playing and transcribing have stopped,
 * so a move ends only in Ribbon starting again, in the new place or, when
 * it failed, where it was.
 */

/** What moving to a picked folder would do (home_move.rs, `MovePlan`). */
export interface HomeMovePlan {
  /** The folder picked, which the move is asked for again with. */
  picked: string;
  /** Where the Ribbon folder is now. */
  from: string;
  /** Where it would go: a folder named Ribbon in the one picked. */
  to: string;
  bytes: number;
  files: number;
  /** Free on the disk it would go to. */
  freeBytes: number;
}

export type HomeMove =
  | { status: "none" }
  /** Asking whether to move it there. */
  | { status: "asking"; plan: HomeMovePlan }
  /** It can't go to the folder picked, and why, in plain words. */
  | { status: "refused"; why: string }
  /** Being copied: `done` of `total` bytes. */
  | { status: "moving"; plan: HomeMovePlan; done: number; total: number }
  /** The copy failed and was taken back: nothing moved. */
  | { status: "failed"; why: string }
  /** Moved: Ribbon starts again in `to`. */
  | { status: "restarting"; to: string };

export type HomeMoveEvent =
  | { type: "planned"; plan: HomeMovePlan }
  | { type: "refused"; why: string }
  | { type: "cancel" }
  | { type: "move" }
  | { type: "progress"; done: number; total: number }
  | { type: "moved" }
  | { type: "failed"; why: string };

export const NO_MOVE: HomeMove = { status: "none" };

/** Room kept free beyond what's copied: the log grows while it copies, and a disk filled to the last byte is no use. */
export const MOVE_HEADROOM_BYTES = 256 * 1024 * 1024;

/** Whether the disk picked has room for the folder. */
export function fits(plan: HomeMovePlan): boolean {
  return plan.freeBytes >= plan.bytes + MOVE_HEADROOM_BYTES;
}

/** The move after an event: the one place it changes. Returns the same object when nothing does. */
export function homeMoveAfter(now: HomeMove, event: HomeMoveEvent): HomeMove {
  switch (now.status) {
    case "none":
    case "asking":
    case "refused":
      switch (event.type) {
        case "planned":
          return { status: "asking", plan: event.plan };
        case "refused":
          return { status: "refused", why: event.why };
        case "cancel":
          return now.status === "none" ? now : NO_MOVE;
        case "move":
          return now.status === "asking" && fits(now.plan) ? { status: "moving", plan: now.plan, done: 0, total: now.plan.bytes } : now;
        default:
          return now;
      }
    case "moving":
      switch (event.type) {
        case "progress":
          return { ...now, done: event.done, total: Math.max(event.total, event.done) };
        case "moved":
          return { status: "restarting", to: now.plan.to };
        case "failed":
          return { status: "failed", why: event.why };
        // Half a copy can't be stopped: it finishes, or fails and is taken back.
        default:
          return now;
      }
    case "failed":
    case "restarting":
      return now;
  }
}
