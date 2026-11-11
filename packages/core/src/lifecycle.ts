/**
 * The library's lifecycle, as a state machine (docs/STATE-MACHINES.md):
 * each folder on its way to the shelf, and the phase the app is in, which
 * is worked out from the folders and never set, so it can't disagree with
 * them.
 *
 * ```
 *   a folder:  opening ── its books on the shelf ──▶ open
 *              opening ── it couldn't be opened ──▶ failed, and why
 *              failed  ── picked again ──▶ opening
 *              any     ── removed ──▶ gone from the list
 *
 *   the app:   boot, until the list of folders is read; then
 *              ready    while any folder is open,
 *              loading  while one is opening and none is open,
 *              pick     when none is either: no folders, or none that would open.
 * ```
 *
 * "No library" is one test, nothing open and nothing opening, wherever
 * it's asked: removing the one folder that opened goes back to the first
 * screen though another that failed is still listed.
 */
export type FolderState =
  /** Being opened: nothing on the shelf from it yet. */
  | { status: "opening" }
  /** Its books are on the shelf. */
  | { status: "open" }
  /** It couldn't be opened, and why, in plain words. */
  | { status: "failed"; why: string };

export type Phase = "boot" | "pick" | "loading" | "ready";

/** The app's phase from its folders: `booted` once the list of folders has been read. */
export function phaseOf(booted: boolean, folders: Iterable<FolderState>): Phase {
  if (!booted) return "boot";
  let opening = false;
  for (const f of folders) {
    if (f.status === "open") return "ready";
    if (f.status === "opening") opening = true;
  }
  return opening ? "loading" : "pick";
}

export const OPENING: FolderState = { status: "opening" };
export const OPEN: FolderState = { status: "open" };
